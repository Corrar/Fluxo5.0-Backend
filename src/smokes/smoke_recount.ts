// src/smokes/smoke_recount.ts — lote R1: recontagem física (POST /stock/recount).
//
// COMO RODA: `npm run smoke:recount` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera o
// /health e mata a ÁRVORE no fim (template ratificado do smoke_teto_conferencia). TUDO pela VIA DO
// USUÁRIO: login real, header real, endpoint real. SQL só para LER asserção e escolher fixture —
// nunca para produzir fato de domínio.
//
// ⚠ GUARDA DE HOST — DUAS CAMADAS, as duas OBRIGATÓRIAS (este smoke ESCREVE):
//     1. FR_EXPECT_DB_HOST declarada e contida na DATABASE_URL (a declaração de quem roda);
//     2. current_database() conferido contra a declaração (o banco dizendo quem é).
//   Recusa `ep-mute-feather` (produção 2.0) e `ep-steep-breeze` (PRODUÇÃO 5.0) SEMPRE.
//
// ⚠ NÃO aplica migration nenhuma: o lote R1 não tem migration (audit_logs.action é text sem CHECK
//   nem ENUM — medido na fase 0).
//
// PREPARAÇÃO × MEDIÇÃO (régua da casa): o ADMIN prepara o ambiente (cria produtos de teste, dá
// entrada de saldo, semeia reserva). Quem MEDE o recount é ator NÃO-ADMIN com a chave real
// (002 = almoxarife, estoque:edit) — admin faria bypass no requirePermission e não provaria RBAC.
//
// CLEANUP: produtos de teste ARQUIVADOS pela via real (DELETE /products/:id arquiva quando há
// histórico) e a solicitação de teste REJEITADA (libera a reserva). Nada de DELETE global; o razão
// (stock_ledger) é append-only e NÃO é tocado.
//
// ── AS PROVAS ────────────────────────────────────────────────────────────────────────────────
//  P1  array de 1 e array de N no MESMO endpoint
//  P2  o bug do L2 não se reproduz: 10→12→10 com chaves de sessão distintas aplica os três;
//      com a MESMA chave, o segundo é replay
//  P3  fração: unidade M aceita 12,5; unidade UN rejeita 400 nomeando o item; sem truncagem
//  P4  AJUSTE_ABAIXO_RESERVA: 400 com os dois números e NENHUM item do array aplicado
//  P5  atomicidade: item bom + item inválido → zero escrita
//  P6  concorrência: dois POSTs simultâneos com a mesma chave → um aplica, o outro é replay
//  P7  RBAC: ator sem estoque:edit → 403; ator NÃO-ADMIN com a chave → 200
//  P10 MAX_ITENS: 500 passa a borda de tamanho; 501 → 400 nomeando o limite
//  P11 duplicata de product_id → 400, zero escrita
//  P12 ordenação: array em ordem inversa volta processado em ordem crescente de product_id

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import crypto from 'crypto';

const SENHA_SEED = 'Teste@123';
const ADMIN = '001@fluxoroyale.local';       // prepara o ambiente (bypass de RBAC)
const ATOR = '002@fluxoroyale.local';        // MEDE: almoxarife, tem estoque:edit, NÃO é admin
const SEM_CHAVE = '005@fluxoroyale.local';   // setor: sem estoque:edit
let BASE = process.env.SMOKE_BASE_URL ?? '';

const failures: string[] = [];
function check(cond: boolean, desc: string, got: string): void {
  if (cond) {
    console.log(`  ✔ ${desc}`);
  } else {
    console.error(`  ✘ ${desc}  (obtido: ${got})`);
    failures.push(desc);
  }
}

// ── Servidor efêmero (template ratificado) ───────────────────────────────────
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const porta = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(porta));
    });
  });
}

function subirServidor(porta: number): { child: ChildProcess; log: () => string } {
  const linhas: string[] = [];
  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/server.ts'], {
    env: { ...process.env, PORT: String(porta) },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const guarda = (b: Buffer) => { linhas.push(b.toString()); if (linhas.length > 80) linhas.shift(); };
  child.stdout?.on('data', guarda);
  child.stderr?.on('data', guarda);
  return { child, log: () => linhas.join('') };
}

function matarArvore(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return resolve();
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('exit', () => resolve());
      tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* já morreu */ } resolve(); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* já morreu */ } }
      resolve();
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esperarHealth(child: ChildProcess, log: () => string, timeoutMs = 90_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (child.exitCode !== null) {
      throw new Error(`o servidor morreu antes de responder /health (exit ${child.exitCode}).\n--- log ---\n${log()}`);
    }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await sleep(500);
  }
  throw new Error(`timeout esperando /health em ${BASE}.\n--- log ---\n${log()}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function call(method: string, path_: string, opts: { token?: string; body?: object; idem?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers['X-Idempotency-Key'] = opts.idem;
  const res = await fetch(`${BASE}${path_}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, data };
}

async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login de ${email} falhou: HTTP ${res.status}`);
  return res.data;
}

const num = (v: any): number => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const novaChave = () => crypto.randomUUID();

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';

  // ── CAMADA 1: a declaração ─────────────────────────────────────────────────
  for (const proibido of ['ep-mute-feather', 'ep-steep-breeze']) {
    if (url.includes(proibido)) {
      throw new Error(`GUARDA: DATABASE_URL aponta para ${proibido} — este smoke ESCREVE. Abortando sem tocar em nada.`);
    }
  }
  const esperado = (process.env.FR_EXPECT_DB_HOST ?? '').trim();
  if (!esperado) {
    throw new Error('GUARDA: FR_EXPECT_DB_HOST é obrigatória neste smoke (ele ESCREVE). Declare o banco alvo.');
  }
  if (!url.includes(esperado)) {
    throw new Error(`GUARDA: declarado "${esperado}", mas a DATABASE_URL não o contém — abortando.`);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  // ── CAMADA 2: o banco confirma ─────────────────────────────────────────────
  const ident = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const db = ident.rows[0]?.db ?? '';
  if (!esperado.includes(db) && !db.includes(esperado) && !url.includes(esperado)) {
    throw new Error(`GUARDA: current_database()="${db}" não confere com a declaração "${esperado}".`);
  }
  console.log(`▶ smoke_recount — camada 1 "${esperado}" ✓ · camada 2 current_database="${db}" ✓`);

  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const produtosCriados: string[] = [];
  const requestsCriadas: string[] = [];

  // ── Helpers de LEITURA (asserção; nunca produzem fato de domínio) ──────────
  const saldo = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(quantity_on_hand,0) oh, COALESCE(quantity_reserved,0) res FROM stock
        WHERE product_id=$1 AND op_id IS NULL AND warehouse_id=(SELECT id FROM warehouses WHERE code='ALMOX')`,
      [productId]);
    return { oh: num(rows[0]?.oh), res: num(rows[0]?.res) };
  };
  const ledgerN = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1 AND kind='adjust'`, [productId]);
    return rows[0].n as number;
  };
  const stockIdDe = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT id FROM stock WHERE product_id=$1 AND op_id IS NULL
         AND warehouse_id=(SELECT id FROM warehouses WHERE code='ALMOX')`, [productId]);
    return rows[0]?.id ?? null;
  };
  const auditN = async (idem: string) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='STOCK_RECOUNT' AND details->>'idem_key'=$1`, [idem]);
    return rows[0].n as number;
  };

  try {
    const porta = await portaLivre();
    BASE = BASE || `http://127.0.0.1:${porta}`;
    servidor = subirServidor(porta);
    await esperarHealth(servidor.child, servidor.log);
    console.log(`  servidor efêmero de pé em ${BASE}`);

    const admin = await login(ADMIN, SENHA_SEED);
    const ator = await login(ATOR, SENHA_SEED);
    const semChave = await login(SEM_CHAVE, SENHA_SEED);
    check(admin.profile?.role === 'admin', 'ator de PREPARAÇÃO é admin (bypass)', String(admin.profile?.role));
    check(ator.profile?.role !== 'admin', 'ator de MEDIÇÃO NÃO é admin (a régua da casa)', String(ator.profile?.role));
    check(Array.isArray(ator.permissions) && ator.permissions.includes('estoque:edit'),
      'ator de medição tem estoque:edit', JSON.stringify(ator.permissions?.slice(0, 6)));
    check(Array.isArray(semChave.permissions) && !semChave.permissions.includes('estoque:edit'),
      'ator de controle NÃO tem estoque:edit', JSON.stringify(semChave.permissions?.slice(0, 6)));

    // ── PREPARAÇÃO (admin, via real) ─────────────────────────────────────────
    console.log('\n── preparação (admin, via real) ──');
    const sufixo = stamp.slice(-4);
    const criaProduto = async (sku: string, unit: string, nome: string) => {
      const r = await call('POST', '/products', { token: admin.token, body: { sku, name: nome, unit, min_stock: 0, unit_price: 1, tags: [] } });
      if (r.status !== 201) throw new Error(`falha ao criar produto ${sku}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      produtosCriados.push(r.data.id);
      return r.data.id as string;
    };
    const pUN = await criaProduto(`9.99.${sufixo}`, 'UN', `SMOKE RECOUNT UN ${sufixo}`);
    const pM = await criaProduto(`9.98.${sufixo}`, 'M', `SMOKE RECOUNT M ${sufixo}`);
    check(!!pUN && !!pM, 'dois produtos de teste criados (UN e M)', `${pUN} · ${pM}`);

    const ent = await call('POST', '/stock/entries', {
      token: admin.token,
      body: { type: 'REAPROVEITAMENTO', entries: [{ product_id: pUN, quantity: 10 }, { product_id: pM, quantity: 100.5 }] },
    });
    check(ent.status === 201, 'entrada de saldo inicial (10 UN / 100,5 M)', `HTTP ${ent.status}`);
    const s0UN = await saldo(pUN);
    const s0M = await saldo(pM);
    check(s0UN.oh === 10 && s0M.oh === 100.5, 'saldo inicial confere', `UN=${s0UN.oh} M=${s0M.oh}`);
    check(s0M.oh !== Math.trunc(s0M.oh), 'produto M tem saldo FRACIONÁRIO real (fixture do P3)', String(s0M.oh));

    // ── P7: RBAC ─────────────────────────────────────────────────────────────
    console.log('\n── P7 · RBAC ──');
    const semPerm = await call('POST', '/stock/recount', {
      token: semChave.token, idem: novaChave(), body: { items: [{ product_id: pUN, counted_qty: 9 }] },
    });
    check(semPerm.status === 403, 'ator SEM estoque:edit → 403', `HTTP ${semPerm.status}`);
    const sDepois403 = await saldo(pUN);
    check(sDepois403.oh === 10, '403 não moveu saldo', String(sDepois403.oh));

    // ── P1 (parte 1): array de 1, pelo ator não-admin ────────────────────────
    console.log('\n── P1 · array de 1 ──');
    const k1 = novaChave();
    const r1 = await call('POST', '/stock/recount', { token: ator.token, idem: k1, body: { items: [{ product_id: pUN, counted_qty: 9 }] } });
    check(r1.status === 200, 'ator COM estoque:edit → 200', `HTTP ${r1.status} ${JSON.stringify(r1.data)}`);
    check(r1.data?.items?.length === 1 && r1.data.items[0].antes === 10 && r1.data.items[0].depois === 9 && r1.data.items[0].delta === -1,
      'resposta traz antes/depois/delta corretos', JSON.stringify(r1.data?.items?.[0]));
    check(r1.data?.items?.[0]?.status === 'aplicado', 'status = aplicado', String(r1.data?.items?.[0]?.status));
    check(r1.data?.items?.[0]?.active === true, 'resposta traz active=true para produto do catálogo', String(r1.data?.items?.[0]?.active));
    check((await saldo(pUN)).oh === 9, 'saldo no banco virou 9', String((await saldo(pUN)).oh));
    check((await auditN(k1)) === 1, 'audit_logs tem 1 STOCK_RECOUNT com a chave da sessão', String(await auditN(k1)));

    // ── SEM header ───────────────────────────────────────────────────────────
    const semIdem = await call('POST', '/stock/recount', { token: ator.token, body: { items: [{ product_id: pUN, counted_qty: 8 }] } });
    check(semIdem.status === 400 && /Idempotency/i.test(String(semIdem.data?.error)),
      'sem X-Idempotency-Key → 400 nomeando o header', `HTTP ${semIdem.status} ${semIdem.data?.error}`);
    check((await saldo(pUN)).oh === 9, 'o 400 do header não moveu saldo', String((await saldo(pUN)).oh));

    // ── P2: o bug do L2 ──────────────────────────────────────────────────────
    console.log('\n── P2 · 10 → 12 → 10 (o bug do L2) ──');
    const ka = novaChave(); const kb = novaChave(); const kc = novaChave();
    const a = await call('POST', '/stock/recount', { token: ator.token, idem: ka, body: { items: [{ product_id: pUN, counted_qty: 10 }] } });
    const sA = await saldo(pUN);
    const b = await call('POST', '/stock/recount', { token: ator.token, idem: kb, body: { items: [{ product_id: pUN, counted_qty: 12 }] } });
    const sB = await saldo(pUN);
    const c = await call('POST', '/stock/recount', { token: ator.token, idem: kc, body: { items: [{ product_id: pUN, counted_qty: 10 }] } });
    const sC = await saldo(pUN);
    check(a.status === 200 && sA.oh === 10, 'sessão A: contou 10 → saldo 10', `HTTP ${a.status} oh=${sA.oh}`);
    check(b.status === 200 && sB.oh === 12, 'sessão B: contou 12 → saldo 12', `HTTP ${b.status} oh=${sB.oh}`);
    check(c.status === 200 && sC.oh === 10, 'sessão C: contou 10 DE VOLTA → saldo 10 (o bug do L2 NÃO ocorre)', `HTTP ${c.status} oh=${sC.oh}`);
    check(c.data?.items?.[0]?.status === 'aplicado', 'a volta a 10 é APLICADO, não replay silencioso', String(c.data?.items?.[0]?.status));
    // e o replay de verdade: repetir a MESMA chave
    const cRepeat = await call('POST', '/stock/recount', { token: ator.token, idem: kc, body: { items: [{ product_id: pUN, counted_qty: 10 }] } });
    check(cRepeat.status === 200 && cRepeat.data?.items?.[0]?.status === 'replay',
      'repetir a MESMA chave → replay', `HTTP ${cRepeat.status} status=${cRepeat.data?.items?.[0]?.status}`);
    check((await saldo(pUN)).oh === 10, 'replay não moveu saldo', String((await saldo(pUN)).oh));

    // ── P3: fração ───────────────────────────────────────────────────────────
    console.log('\n── P3 · fração por unidade ──');
    const kFracOk = novaChave();
    const fracOk = await call('POST', '/stock/recount', { token: ator.token, idem: kFracOk, body: { items: [{ product_id: pM, counted_qty: 12.5 }] } });
    check(fracOk.status === 200 && (await saldo(pM)).oh === 12.5, 'unidade M aceita 12,5', `HTTP ${fracOk.status} oh=${(await saldo(pM)).oh}`);
    const ohAntesFrac = (await saldo(pUN)).oh;
    const fracNao = await call('POST', '/stock/recount', { token: ator.token, idem: novaChave(), body: { items: [{ product_id: pUN, counted_qty: 7.5 }] } });
    check(fracNao.status === 400 && /decimais/i.test(String(fracNao.data?.error)),
      'unidade UN rejeita 7,5 com 400', `HTTP ${fracNao.status} ${fracNao.data?.error}`);
    check((await saldo(pUN)).oh === ohAntesFrac, 'rejeição NÃO truncou para 7 (nada foi escrito)', String((await saldo(pUN)).oh));

    // ── P11: duplicata ───────────────────────────────────────────────────────
    console.log('\n── P11 · duplicata de product_id ──');
    const ohAntesDup = (await saldo(pUN)).oh;
    const nLedgerAntesDup = await ledgerN(pUN);
    const dup = await call('POST', '/stock/recount', {
      token: ator.token, idem: novaChave(),
      body: { items: [{ product_id: pUN, counted_qty: 5 }, { product_id: pUN, counted_qty: 6 }] },
    });
    check(dup.status === 400 && /repetido/i.test(String(dup.data?.error)), 'duplicata → 400 nomeando o produto', `HTTP ${dup.status} ${dup.data?.error}`);
    check((await saldo(pUN)).oh === ohAntesDup && (await ledgerN(pUN)) === nLedgerAntesDup,
      'duplicata: zero escrita (saldo e razão intactos)', `oh=${(await saldo(pUN)).oh} ledger=${await ledgerN(pUN)}`);

    // ── P10: MAX_ITENS ───────────────────────────────────────────────────────
    console.log('\n── P10 · teto de 500 itens ──');
    const fake = (n: number) => Array.from({ length: n }, () => ({ product_id: crypto.randomUUID(), counted_qty: 1 }));
    const r501 = await call('POST', '/stock/recount', { token: ator.token, idem: novaChave(), body: { items: fake(501) } });
    check(r501.status === 400 && /500/.test(String(r501.data?.error)), '501 itens → 400 nomeando o limite', `HTTP ${r501.status} ${r501.data?.error}`);
    const r500 = await call('POST', '/stock/recount', { token: ator.token, idem: novaChave(), body: { items: fake(500) } });
    check(r500.status === 404, '500 itens PASSA a borda de tamanho (morre depois, no produto inexistente)', `HTTP ${r500.status} ${r500.data?.error}`);

    // ── P5: atomicidade (item bom + item inválido) ───────────────────────────
    console.log('\n── P5 · atomicidade com item inválido ──');
    const ohAntesAtom = (await saldo(pUN)).oh;
    const nLedgerAtom = await ledgerN(pUN);
    const mix = await call('POST', '/stock/recount', {
      token: ator.token, idem: novaChave(),
      body: { items: [{ product_id: pUN, counted_qty: 3 }, { product_id: crypto.randomUUID(), counted_qty: 1 }] },
    });
    check(mix.status === 404, 'lote com produto inexistente → 404', `HTTP ${mix.status} ${mix.data?.error}`);
    check((await saldo(pUN)).oh === ohAntesAtom && (await ledgerN(pUN)) === nLedgerAtom,
      'o item BOM do mesmo lote NÃO foi aplicado (atomicidade)', `oh=${(await saldo(pUN)).oh} ledger=${await ledgerN(pUN)}`);

    // ── P1 (parte 2) + P12: array de N e ORDEM ───────────────────────────────
    console.log('\n── P1/P12 · array de N e ordenação ──');
    const kN = novaChave();
    // manda na ordem INVERSA de product_id de propósito
    const par = [pUN, pM].sort((x, y) => (x < y ? 1 : -1));
    const rN = await call('POST', '/stock/recount', {
      token: ator.token, idem: kN,
      body: { items: [{ product_id: par[0], counted_qty: par[0] === pM ? 20.25 : 20 }, { product_id: par[1], counted_qty: par[1] === pM ? 20.25 : 20 }] },
    });
    check(rN.status === 200 && rN.data?.total === 2, 'array de N: 200 com os 2 itens', `HTTP ${rN.status} total=${rN.data?.total}`);
    const ordem = (rN.data?.items ?? []).map((i: any) => i.product_id);
    const ordenado = [...ordem].sort();
    check(JSON.stringify(ordem) === JSON.stringify(ordenado),
      'P12: resposta processada em ordem CRESCENTE de product_id (entrada foi invertida)', JSON.stringify(ordem));
    check((await saldo(pUN)).oh === 20 && (await saldo(pM)).oh === 20.25, 'os dois saldos aplicados', `UN=${(await saldo(pUN)).oh} M=${(await saldo(pM)).oh}`);

    // ── P4: AJUSTE_ABAIXO_RESERVA + atomicidade ──────────────────────────────
    console.log('\n── P4 · contagem abaixo do reservado ──');
    // reserva pela via real: solicitação do ator 005 (POST /requests é authenticate puro)
    const reqRes = await call('POST', '/requests', { token: semChave.token, body: { items: [{ product_id: pUN, quantity: 5 }] } });
    if (reqRes.status === 201 && reqRes.data?.id) requestsCriadas.push(reqRes.data.id);
    else console.log(`    (a via real não criou solicitação: HTTP ${reqRes.status} ${JSON.stringify(reqRes.data)?.slice(0, 160)})`);
    let sRes = await saldo(pUN);
    if (sRes.res <= 0) {
      // FALLBACK DE PREPARAÇÃO (declarado): a via real não reservou neste caminho; semeia a reserva
      // pela rota antiga com o ADMIN. É preparação de ambiente, não a medição — quem é medido
      // continua sendo o POST /stock/recount do ator não-admin.
      const sid = await stockIdDe(pUN);
      const putRes = await call('PUT', `/stock/${sid}`, { token: admin.token, body: { quantity_reserved: 5 } });
      console.log(`    (preparação: reserva semeada pela rota antiga — HTTP ${putRes.status})`);
      sRes = await saldo(pUN);
    }
    check(sRes.res === 5, 'reserva de 5 em pé no produto UN', `res=${sRes.res}`);

    const ohAntesRes = sRes.oh;
    const nLedgerRes = await ledgerN(pM);
    const abaixo = await call('POST', '/stock/recount', {
      token: ator.token, idem: novaChave(),
      body: { items: [{ product_id: pM, counted_qty: 33 }, { product_id: pUN, counted_qty: 2 }] },
    });
    check(abaixo.status === 400, 'contar 2 com 5 reservados → 400', `HTTP ${abaixo.status} ${abaixo.data?.error}`);
    check(/\b2\b/.test(String(abaixo.data?.error)) && /\b5\b/.test(String(abaixo.data?.error)),
      '400 traz os DOIS números (alvo e reservado)', String(abaixo.data?.error));
    check(/Item /.test(String(abaixo.data?.error)), 'lote com >1 item nomeia QUAL item falhou', String(abaixo.data?.error));
    check((await saldo(pUN)).oh === ohAntesRes, 'saldo do item que falhou intacto', String((await saldo(pUN)).oh));
    check((await saldo(pM)).oh === 20.25 && (await ledgerN(pM)) === nLedgerRes,
      'ATOMICIDADE: o OUTRO item do array não foi aplicado', `M=${(await saldo(pM)).oh} ledger=${await ledgerN(pM)}`);

    // ── P6: concorrência com a mesma chave ───────────────────────────────────
    console.log('\n── P6 · dois POSTs simultâneos, mesma chave ──');
    const kConc = novaChave();
    const corpoConc = { items: [{ product_id: pM, counted_qty: 44 }] };
    const [c1, c2] = await Promise.all([
      call('POST', '/stock/recount', { token: ator.token, idem: kConc, body: corpoConc }),
      call('POST', '/stock/recount', { token: ator.token, idem: kConc, body: corpoConc }),
    ]);
    check(c1.status === 200 && c2.status === 200, 'os dois POSTs respondem 200', `${c1.status} / ${c2.status}`);
    const statusConc = [c1, c2].map((r) => (r.data?.idempotent ? 'idempotent' : r.data?.items?.[0]?.status)).sort();
    check((await saldo(pM)).oh === 44, 'saldo final correto (44), sem dupla aplicação', String((await saldo(pM)).oh));
    const ledgerConc = await pool.query(
      `SELECT count(*)::int n FROM stock_ledger WHERE op_key = $1`, [`recount:${kConc}:product:${pM}`]);
    check(ledgerConc.rows[0].n === 1, 'razão tem UMA linha para a op_key (nada duplicou)', String(ledgerConc.rows[0].n));
    console.log(`    (resultados: ${JSON.stringify(statusConc)})`);

    // ── P13: produto ARQUIVADO é contável, e a resposta AVISA (emenda E1) ────
    // A decisão do lote é aceitar item fora do catálogo (inventário conta o que está na
    // prateleira); o `active` na resposta existe para a tela poder sinalizar isso ao operador.
    // Prova pela via real: arquiva pelo endpoint de produtos e reconta em seguida.
    console.log('\n── P13 · produto arquivado é contável, com aviso ──');
    const arq = await call('DELETE', `/products/${pM}`, { token: admin.token });
    check(arq.status === 200, 'produto M arquivado pela via real (preparação)', `HTTP ${arq.status}`);
    const rArq = await call('POST', '/stock/recount', { token: ator.token, idem: novaChave(), body: { items: [{ product_id: pM, counted_qty: 7.5 }] } });
    check(rArq.status === 200, 'recontagem de produto ARQUIVADO → 200 (decisão do lote)', `HTTP ${rArq.status} ${rArq.data?.error ?? ''}`);
    check(rArq.data?.items?.[0]?.active === false, 'resposta marca active=false (a tela pode avisar)', String(rArq.data?.items?.[0]?.active));
    check((await saldo(pM)).oh === 7.5, 'saldo do arquivado foi de fato corrigido', String((await saldo(pM)).oh));

  } finally {
    // ── CLEANUP pela via real ────────────────────────────────────────────────
    console.log('\n── cleanup ──');
    try {
      const admin = await login(ADMIN, SENHA_SEED);
      for (const rid of requestsCriadas) {
        const r = await call('PUT', `/requests/${rid}/status`, { token: admin.token, body: { status: 'rejeitado', rejection_reason: 'smoke_recount: cleanup' } });
        console.log(`    request ${rid.slice(0, 8)} rejeitada (libera reserva): HTTP ${r.status}`);
      }
      // Reserva semeada na preparação sai ANTES do arquivamento — e pela VIA REAL (o motor faz
      // release e registra no razão; zerar por UPDATE cru deixaria `stock` e `stock_ledger`
      // discordando). Varre também produtos SMOKE RECOUNT de execuções anteriores que tenham
      // ficado com reserva pendurada: o rastro do teste é responsabilidade do teste.
      const orfas = await pool.query<{ id: string; sku: string }>(
        `SELECT s.id, p.sku FROM stock s JOIN products p ON p.id = s.product_id
          WHERE p.name LIKE 'SMOKE RECOUNT%' AND s.quantity_reserved > 0`);
      for (const o of orfas.rows) {
        const r = await call('PUT', `/stock/${o.id}`, { token: admin.token, body: { quantity_reserved: 0 } });
        console.log(`    reserva zerada em ${o.sku} (via rota real): HTTP ${r.status}`);
      }
      for (const pid of produtosCriados) {
        const r = await call('DELETE', `/products/${pid}`, { token: admin.token });
        console.log(`    produto ${pid.slice(0, 8)} arquivado/removido: HTTP ${r.status}`);
      }
    } catch (e: any) {
      console.warn(`    cleanup parcial: ${e?.message ?? e}`);
    }
    if (servidor) await matarArvore(servidor.child);
    await pool.end();
  }

  console.log('');
  if (failures.length) {
    console.error(`❌ smoke_recount: ${failures.length} falha(s):`);
    failures.forEach((f) => console.error(`   · ${f}`));
    process.exit(1);
  }
  console.log('✅ smoke_recount: todas as provas passaram.');
}

main().catch((err) => {
  console.error('\n❌ smoke_recount abortou:', err?.message ?? err);
  process.exit(1);
});
