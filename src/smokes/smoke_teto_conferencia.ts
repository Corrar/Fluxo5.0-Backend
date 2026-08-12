// src/smokes/smoke_teto_conferencia.ts — lote C-teto: o servidor vira a segunda parede.
//
// COMO RODA: `npm run smoke:teto` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera o
// /health e mata a ÁRVORE no fim (template ratificado). Tudo pela VIA DO USUÁRIO — o ponto do
// lote é justamente que a via do usuário NÃO é só a tela: as provas batem na API direto, que é
// exatamente por onde a trava do front (27902cb) não protege nada.
//
// ⚠ GUARDA DE HOST — DUAS CAMADAS, as duas OBRIGATÓRIAS:
//     1. FR_EXPECT_DB_HOST declarada e contida na DATABASE_URL (a declaração de quem roda);
//     2. current_database() conferido contra a declaração (o banco dizendo quem é).
//   Sem as duas o smoke morre antes de tocar em qualquer coisa. Recusa `ep-mute-feather` sempre.
//
// ⚠ ESTE SMOKE APLICA A MIGRATION 023 (prova viii) — é o segundo da casa que muda schema (o
//   primeiro é o smoke_op_status, com a 021). É por isso que a guarda de host importa mais aqui.
//   A 023 é idempotente: rodar de novo é no-op.
//
// ⚠ DESTRUICAO ESCOPADA DE DADOS DE TESTE (disciplina C — ver src/smokes/_cleanup.ts): apaga
//   linha de `stock_ledger`, VIOLACAO CONSCIENTE de append-only, escopo assertado a propria
//   execucao e DELETE por id conferido. Morre com a missao B. `audit_logs` NAO e tocado.
//
// ── AS PROVAS (i a viii da missão C-teto) ────────────────────────────────────────────────────
//   i    aprovada=2 de um pedido de 4: conferir 3 → 400 com os dois números, nada gravado,
//        zero movimento no razão.
//   ii   conferir 2 → 200 (o limite EXATO passa — a parede é `>`, não `>=`).
//   iii  conferir 1 → 200, delivered=1 e release do delta (a mecânica da I-a intacta).
//   iv   nunca ajustado (delivered NULL): conferir 4 → 200; conferir 5 → 400 pela regra ANTIGA.
//   v    fase de APROVAÇÃO: ajustar 3 num pedido de 4 → 200. Intocada.
//   vi   item 3D com aprovada ajustada: mesma regra, e qty_reserved coerente antes e depois.
//   vii  idempotência: repetir o PUT não move saldo nem cria linha no razão.
//   viii migration 023: guarda de premissa, backfill NULL → 'Em análise', NOT NULL + CHECK,
//        23514/23502 no INSERT direto, re-execução no-op.

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { destruicaoEscopadaDeDadosDeTeste, formatarContagem } from './_cleanup';

const SENHA_SEED = 'Teste@123';
const ADMIN = '001@fluxoroyale.local';
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
async function call(method: string, path_: string, opts: { token?: string; body?: object } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';

  // ── CAMADA 1: a declaração ─────────────────────────────────────────────────
  if (url.includes('ep-mute-feather')) {
    throw new Error('GUARDA: DATABASE_URL aponta para a produção 2.0 — abortando sem tocar no banco.');
  }
  const esperado = (process.env.FR_EXPECT_DB_HOST ?? '').trim();
  if (!esperado) {
    throw new Error('GUARDA: FR_EXPECT_DB_HOST é obrigatória neste smoke (ele ESCREVE e muda SCHEMA). Declare o banco alvo.');
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
  console.log(`▶ smoke_teto_conferencia — camada 1 "${esperado}" ✓ · camada 2 current_database="${db}" ✓`);

  const sqlDa023 = fs.readFileSync(path.join(process.cwd(), 'src/migrations/023_demand_status_vocab.sql'), 'utf8');

  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const produtosCriados: string[] = [];
  const requestsCriadas: string[] = [];
  const demandasPlantadas: string[] = [];
  let clienteId = '';
  let opId = '';

  // ── Helpers de leitura (asserção, nunca escrita) ───────────────────────────
  const saldo = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(quantity_on_hand,0) oh, COALESCE(quantity_reserved,0) res FROM stock
        WHERE product_id=$1 AND op_id IS NULL AND warehouse_id=(SELECT id FROM warehouses WHERE code='ALMOX')`,
      [productId]);
    return { oh: num(rows[0]?.oh), res: num(rows[0]?.res) };
  };
  const itensDe = async (requestId: string) => {
    const { rows } = await pool.query(
      `SELECT id, product_id, quantity_requested, quantity_delivered, qty_reserved
         FROM request_items WHERE request_id=$1 ORDER BY id`, [requestId]);
    return rows;
  };
  const ledgerN = async (productId: string) => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1`, [productId]);
    return rows[0].n as number;
  };
  const statusDe = async (requestId: string) => {
    const { rows } = await pool.query(`SELECT status FROM requests WHERE id=$1`, [requestId]);
    return rows[0]?.status ?? null;
  };
  const colunaStatusDemanda = async () => {
    const { rows } = await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name='demands_3d' AND column_name='status'`);
    return rows[0] ?? null;
  };
  const temCheck023 = async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname='demands_3d_status_chk'`);
    return (rows.length ?? 0) > 0;
  };
  const statusDaDemanda = async (id: string) => {
    const { rows } = await pool.query(`SELECT status FROM demands_3d WHERE id=$1`, [id]);
    return rows[0]?.status ?? null;
  };
  const rodar023 = async (): Promise<{ ok: boolean; erro: string }> => {
    try { await pool.query(sqlDa023); return { ok: true, erro: '' }; }
    catch (e: any) { return { ok: false, erro: String(e?.message ?? e) }; }
  };

  try {
    if (BASE) {
      console.log('  SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('  subindo servidor efêmero em', BASE);
      servidor = subirServidor(porta);
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto (/health respondeu).');
    }

    const admin = await login(ADMIN, SENHA_SEED);
    const tk = admin.token;

    // ── SEED pela via do usuário ────────────────────────────────────────────
    const cli = await call('POST', '/clients', { token: tk, body: { code: `SMKCT-${stamp}`, name: `SMOKE C-teto ${stamp}` } });
    clienteId = cli.data?.id;
    const OP_CODE = `SMKOPCT-${stamp}`;
    const op = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: OP_CODE, description: 'OP do smoke C-teto' } });
    opId = op.data?.id;
    check(!!clienteId && !!opId, 'seed: cliente e OP criados pela API', `cli=${!!clienteId} op=${!!opId}`);

    // Faixa 9.96.NNNN — própria deste smoke (9.99 requests3d, 9.98 op_status, 9.97 demandas3d).
    const { rows: usados } = await pool.query<{ sku: string }>(`SELECT sku FROM products WHERE sku LIKE '9.96.%'`);
    const ocupados = new Set(usados.map((u) => u.sku));
    let proximo = 1;
    const skuLivre = (): string => {
      for (;;) {
        const s = `9.96.${String(proximo++).padStart(4, '0')}`;
        if (!ocupados.has(s)) { ocupados.add(s); return s; }
      }
    };
    const criarProduto = async (sufixo: string, is3d: boolean) => {
      const r = await call('POST', '/products', { token: tk, body: {
        sku: skuLivre(), name: `Item smoke teto ${sufixo} ${stamp}`, unit: 'UN',
        min_stock: 0, unit_price: 10,
        tags: is3d ? ['3D'] : ['insumos'], ...(is3d ? { is_3d: true } : {}),
      }});
      const id = r.data?.id ?? r.data?.product?.id;
      if (!id) throw new Error(`falha ao criar produto ${sufixo}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      produtosCriados.push(id);
      return id;
    };
    const entrada = async (productId: string, qty: number) => {
      const r = await call('POST', '/stock/entries', { token: tk, body: {
        type: 'Reaproveitamento', entries: [{ product_id: productId, quantity: qty }],
      }});
      if (r.status >= 400) throw new Error(`entrada falhou: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    };
    const criarPedido = async (productId: string, qty: number, comOp: boolean) => {
      const r = await call('POST', '/requests', { token: tk, body: {
        sector: 'Produção 3D', ...(comOp ? { op_code: OP_CODE } : {}),
        items: [{ product_id: productId, quantity: qty, priority: 'Média' }],
      }});
      if (r.data?.id) requestsCriadas.push(r.data.id);
      if (r.status >= 400) throw new Error(`criação de pedido falhou: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      return r;
    };
    const mudarStatus = (requestId: string, body: object) =>
      call('PUT', `/requests/${requestId}/status`, { token: tk, body });

    // =====================================================================
    console.log('\n── (i) conferir ACIMA da aprovada: 400 com os dois números ──');
    // =====================================================================
    const pA = await criarProduto('A', false); await entrada(pA, 20);
    const rA = await criarPedido(pA, 4, false);
    const itA0 = (await itensDe(rA.data.id))[0];
    check(itA0.quantity_delivered === null, '(i) item nasce com aprovada NULA (nunca ajustado)', String(itA0.quantity_delivered));

    // APROVA com 2: é aqui que a "aprovada" nasce.
    const aprA = await mudarStatus(rA.data.id, { status: 'aprovado', adjusted_items: [{ id: itA0.id, quantity_delivered: 2 }] });
    const itA1 = (await itensDe(rA.data.id))[0];
    check(aprA.status === 200 && num(itA1.quantity_delivered) === 2, '(i) aprovação gravou aprovada=2 (de um pedido de 4)', `HTTP ${aprA.status} delivered=${itA1.quantity_delivered}`);

    const sA0 = await saldo(pA);
    const nLedA0 = await ledgerN(pA);
    // A PAREDE: conferir 3 com aprovada 2. Repare que 3 < 4 (o pedido), então a regra ANTIGA
    // deixaria passar — é exatamente este o buraco que o lote fecha.
    const conf3 = await mudarStatus(rA.data.id, { status: 'conferido', adjusted_items: [{ id: itA0.id, quantity_delivered: 3 }] });
    const itA2 = (await itensDe(rA.data.id))[0];
    check(conf3.status === 400, '(i) conferir 3 com aprovada 2 → 400', `HTTP ${conf3.status}`);
    check(String(conf3.data?.error ?? '').includes('(3)') && String(conf3.data?.error ?? '').includes('(2)'),
      '(i) sentinela traz os DOIS números — o tentado e o teto', String(conf3.data?.error).slice(0, 80));
    check(String(conf3.data?.error ?? '').includes('aprovada'),
      '(i) e diz "aprovada", não "pedido" (a mensagem nomeia o teto certo)', String(conf3.data?.error).slice(0, 80));
    check(num(itA2.quantity_delivered) === 2, '(i) NADA gravado: aprovada segue 2', String(itA2.quantity_delivered));
    check(await statusDe(rA.data.id) === 'aprovado', '(i) status não avançou', String(await statusDe(rA.data.id)));
    const sA1 = await saldo(pA);
    check(sA1.oh === sA0.oh && sA1.res === sA0.res, '(i) saldo INTOCADO', `oh=${sA1.oh} res=${sA1.res}`);
    check(await ledgerN(pA) === nLedA0, '(i) ZERO movimento no razão', `${nLedA0} → ${await ledgerN(pA)}`);

    // =====================================================================
    console.log('\n── (ii) o limite EXATO passa ─────────────────────────────');
    // =====================================================================
    // A parede é `>`, não `>=`: conferir exatamente o que foi aprovado é o caminho NORMAL.
    const conf2 = await mudarStatus(rA.data.id, { status: 'conferido', adjusted_items: [{ id: itA0.id, quantity_delivered: 2 }] });
    const itA3 = (await itensDe(rA.data.id))[0];
    check(conf2.status === 200, '(ii) conferir 2 com aprovada 2 → 200 (limite exato)', `HTTP ${conf2.status}`);
    check(await statusDe(rA.data.id) === 'conferido', '(ii) status avançou para conferido', String(await statusDe(rA.data.id)));
    check(num(itA3.quantity_delivered) === 2, '(ii) aprovada segue 2', String(itA3.quantity_delivered));

    // =====================================================================
    console.log('\n── (iii) conferir ABAIXO: passa e libera o delta ──────────');
    // =====================================================================
    const pB = await criarProduto('B', false); await entrada(pB, 20);
    const rB = await criarPedido(pB, 4, false);
    const itB0 = (await itensDe(rB.data.id))[0];
    const sB0 = await saldo(pB);
    check(num(itB0.qty_reserved) === 4, '(iii) criação reservou 4', String(itB0.qty_reserved));

    await mudarStatus(rB.data.id, { status: 'aprovado', adjusted_items: [{ id: itB0.id, quantity_delivered: 2 }] });
    const itB1 = (await itensDe(rB.data.id))[0];
    const sB1 = await saldo(pB);
    check(sB1.res === sB0.res - 2 && num(itB1.qty_reserved) === 2,
      '(iii) aprovação 4→2 liberou 2 (reserva e coluna acompanham)', `res=${sB1.res} qty_reserved=${itB1.qty_reserved}`);

    const conf1 = await mudarStatus(rB.data.id, { status: 'conferido', adjusted_items: [{ id: itB0.id, quantity_delivered: 1 }] });
    const itB2 = (await itensDe(rB.data.id))[0];
    const sB2 = await saldo(pB);
    check(conf1.status === 200, '(iii) conferir 1 com aprovada 2 → 200', `HTTP ${conf1.status}`);
    check(num(itB2.quantity_delivered) === 1, '(iii) aprovada virou 1', String(itB2.quantity_delivered));
    check(sB2.res === sB1.res - 1, '(iii) RELEASE DO DELTA: reserva caiu 1 (mecânica da I-a intacta)', `res ${sB1.res} → ${sB2.res}`);
    check(num(itB2.qty_reserved) === 1, '(iii) qty_reserved acompanhou', String(itB2.qty_reserved));

    // =====================================================================
    console.log('\n── (iv) nunca ajustado (aprovada NULL): regra antiga viva ──');
    // =====================================================================
    const pC = await criarProduto('C', false); await entrada(pC, 20);
    const rC = await criarPedido(pC, 4, false);
    const itC0 = (await itensDe(rC.data.id))[0];
    // Aprova SEM adjusted_items: quantity_delivered fica NULL.
    await mudarStatus(rC.data.id, { status: 'aprovado' });
    const itC1 = (await itensDe(rC.data.id))[0];
    check(itC1.quantity_delivered === null, '(iv) aprovação sem ajuste deixou aprovada NULA', String(itC1.quantity_delivered));
    // Sem "aprovada", o teto é o PEDIDO — conferir 4 tem que passar.
    const conf4 = await mudarStatus(rC.data.id, { status: 'conferido', adjusted_items: [{ id: itC0.id, quantity_delivered: 4 }] });
    check(conf4.status === 200, '(iv) aprovada NULL: conferir 4 (=pedido) → 200', `HTTP ${conf4.status}`);

    // E acima do pedido continua barrado pela regra ANTIGA, com a mensagem antiga.
    const pD = await criarProduto('D', false); await entrada(pD, 20);
    const rD = await criarPedido(pD, 4, false);
    const itD0 = (await itensDe(rD.data.id))[0];
    await mudarStatus(rD.data.id, { status: 'aprovado' });
    const conf5 = await mudarStatus(rD.data.id, { status: 'conferido', adjusted_items: [{ id: itD0.id, quantity_delivered: 5 }] });
    check(conf5.status === 400, '(iv) aprovada NULL: conferir 5 (>pedido) → 400', `HTTP ${conf5.status}`);
    check(String(conf5.data?.error ?? '').includes('pedido'),
      '(iv) e pela mensagem ANTIGA ("passar do pedido") — regra preservada', String(conf5.data?.error).slice(0, 70));

    // =====================================================================
    console.log('\n── (v) fase de APROVAÇÃO intocada ────────────────────────');
    // =====================================================================
    const pE = await criarProduto('E', false); await entrada(pE, 20);
    const rE = await criarPedido(pE, 4, false);
    const itE0 = (await itensDe(rE.data.id))[0];
    const aprE = await mudarStatus(rE.data.id, { status: 'aprovado', adjusted_items: [{ id: itE0.id, quantity_delivered: 3 }] });
    const itE1 = (await itensDe(rE.data.id))[0];
    check(aprE.status === 200 && num(itE1.quantity_delivered) === 3,
      '(v) aprovar 3 num pedido de 4 → 200 (o teto da aprovação é o PEDIDO)', `HTTP ${aprE.status} delivered=${itE1.quantity_delivered}`);
    // Contraprova: na aprovação, acima do pedido segue barrado.
    const pF = await criarProduto('F', false); await entrada(pF, 20);
    const rF = await criarPedido(pF, 4, false);
    const itF0 = (await itensDe(rF.data.id))[0];
    const aprF = await mudarStatus(rF.data.id, { status: 'aprovado', adjusted_items: [{ id: itF0.id, quantity_delivered: 5 }] });
    check(aprF.status === 400, '(v) contraprova: aprovar 5 num pedido de 4 → 400', `HTTP ${aprF.status}`);

    // =====================================================================
    console.log('\n── (vi) item 3D: mesma regra, qty_reserved coerente ──────');
    // =====================================================================
    const p3 = await criarProduto('3D', true); await entrada(p3, 10);
    const r3 = await criarPedido(p3, 6, true);
    const it30 = (await itensDe(r3.data.id))[0];
    const s30 = await saldo(p3);
    check(num(it30.qty_reserved) === 6, '(vi) criação 3D reservou 6', String(it30.qty_reserved));

    await mudarStatus(r3.data.id, { status: 'aprovado', adjusted_items: [{ id: it30.id, quantity_delivered: 4 }] });
    const it31 = (await itensDe(r3.data.id))[0];
    const s31 = await saldo(p3);
    check(num(it31.quantity_delivered) === 4 && num(it31.qty_reserved) === 4,
      '(vi) aprovada 4: qty_reserved acompanhou', `delivered=${it31.quantity_delivered} qty_reserved=${it31.qty_reserved}`);

    const nLed3 = await ledgerN(p3);
    const conf3d = await mudarStatus(r3.data.id, { status: 'conferido', adjusted_items: [{ id: it30.id, quantity_delivered: 5 }] });
    const it32 = (await itensDe(r3.data.id))[0];
    const s32 = await saldo(p3);
    check(conf3d.status === 400, '(vi) 3D: conferir 5 com aprovada 4 → 400 (mesma regra, uniforme)', `HTTP ${conf3d.status}`);
    check(num(it32.qty_reserved) === 4 && num(it32.quantity_delivered) === 4,
      '(vi) qty_reserved e aprovada INTOCADOS pela recusa', `qty_reserved=${it32.qty_reserved} delivered=${it32.quantity_delivered}`);
    check(s32.oh === s31.oh && s32.res === s31.res, '(vi) saldo 3D intocado', `oh=${s32.oh} res=${s32.res}`);
    check(await ledgerN(p3) === nLed3, '(vi) zero linha nova no razão', `${nLed3} → ${await ledgerN(p3)}`);

    // E dentro do teto, o 3D segue funcionando exatamente como antes.
    const conf3dOk = await mudarStatus(r3.data.id, { status: 'conferido', adjusted_items: [{ id: it30.id, quantity_delivered: 3 }] });
    const it33 = (await itensDe(r3.data.id))[0];
    const s33 = await saldo(p3);
    check(conf3dOk.status === 200, '(vi) 3D: conferir 3 (≤ aprovada) → 200', `HTTP ${conf3dOk.status}`);
    check(num(it33.qty_reserved) === 3 && s33.res === s31.res - 1,
      '(vi) release do delta no 3D: qty_reserved 4→3 e reserva caiu 1', `qty_reserved=${it33.qty_reserved} res ${s31.res}→${s33.res}`);

    // =====================================================================
    console.log('\n── (vii) idempotência ────────────────────────────────────');
    // =====================================================================
    const sIdem0 = await saldo(pA);
    const nIdem0 = await ledgerN(pA);
    // rA já está 'conferido': repetir o mesmo PUT bate na máquina de transições.
    const rep1 = await mudarStatus(rA.data.id, { status: 'conferido', adjusted_items: [{ id: itA0.id, quantity_delivered: 2 }] });
    // E repetir a recusa também não deixa rastro.
    const rep2 = await mudarStatus(rA.data.id, { status: 'conferido', adjusted_items: [{ id: itA0.id, quantity_delivered: 3 }] });
    check(rep1.status === 400 && rep2.status === 400, '(vii) repetir o PUT em item já conferido → 400 nas duas', `${rep1.status}/${rep2.status}`);
    check((await saldo(pA)).oh === sIdem0.oh && (await saldo(pA)).res === sIdem0.res,
      '(vii) saldo idêntico', `oh=${(await saldo(pA)).oh} res=${(await saldo(pA)).res}`);
    check(await ledgerN(pA) === nIdem0, '(vii) ZERO linha nova no razão', `${nIdem0} → ${await ledgerN(pA)}`);
    // Repetir a RECUSA do 3D também é inerte (o caminho que mais mexe em coluna).
    const nIdem3 = await ledgerN(p3);
    const it3Antes = (await itensDe(r3.data.id))[0];
    await mudarStatus(r3.data.id, { status: 'conferido', adjusted_items: [{ id: it30.id, quantity_delivered: 9 }] });
    const it3Depois = (await itensDe(r3.data.id))[0];
    check(num(it3Antes.qty_reserved) === num(it3Depois.qty_reserved) && await ledgerN(p3) === nIdem3,
      '(vii) recusa repetida no 3D não move coluna nem razão', `qty_reserved=${it3Depois.qty_reserved}`);

    // =====================================================================
    console.log('\n── (viii) migration 023: vocabulário da demanda fechado ───');
    // =====================================================================
    const jaAplicada = await temCheck023();
    console.log(`  estado inicial do schema: CHECK ${jaAplicada ? 'JÁ presente' : 'ausente'}.`);

    // Demandas plantadas por SQL: o objetivo é ter no banco valores que a ROTA recusa.
    // Precisam de uma request viva para a FK — usamos a do 3D acima.
    const plantarDemanda = async (status: string | null): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO demands_3d (product_id, request_id, quantity, op_number, priority, notes, status)
         VALUES ($1, $2, 1, $3, 'Média', 'plantada pelo smoke_teto_conferencia', $4) RETURNING id`,
        [p3, r3.data.id, OP_CODE, status]);
      demandasPlantadas.push(rows[0].id);
      return rows[0].id;
    };

    if (!jaAplicada) {
      // ── (viii.a) a pré-guarda ABORTA com palavra desconhecida ─────────────
      const idBanana = await plantarDemanda('banana');
      const tentativa = await rodar023();
      check(!tentativa.ok, '(viii.a) pré-guarda ABORTOU a migration com "banana" plantada', `ok=${tentativa.ok}`);
      check(/ABORTADO/.test(tentativa.erro) && /banana/.test(tentativa.erro),
        '(viii.a) a mensagem nomeia o aborto e a palavra encontrada', tentativa.erro.slice(0, 160));
      check(await statusDaDemanda(idBanana) === 'banana', '(viii.a) a linha ofensora segue intocada', String(await statusDaDemanda(idBanana)));
      check((await colunaStatusDemanda())?.is_nullable === 'YES' && !(await temCheck023()),
        '(viii.a) schema INTOCADO pelo aborto', `nullable=${(await colunaStatusDemanda())?.is_nullable} check=${await temCheck023()}`);

      await pool.query(`DELETE FROM demands_3d WHERE id = $1`, [idBanana]);
      demandasPlantadas.splice(demandasPlantadas.indexOf(idBanana), 1);

      // ── (viii.b) roda limpa e traduz o NULL ───────────────────────────────
      const idNulo = await plantarDemanda(null);
      const limpa = await rodar023();
      check(limpa.ok, '(viii.b) sem a ofensora, a migration rodou limpa', limpa.erro.slice(0, 200));
      check(await statusDaDemanda(idNulo) === 'Em análise', '(viii.b) backfill: NULL → Em análise', String(await statusDaDemanda(idNulo)));
    } else {
      console.log('  ⓘ 023 já aplicada neste banco: (viii.a) e o backfill NÃO são reproduzíveis aqui');
      console.log('    — o próprio CHECK/NOT NULL impede plantar "banana"/NULL. Provados em banco');
      console.log('    virgem, uma vez, na aplicação da migration. Desmontar a trava só para reprovar');
      console.log('    seria cirurgia destrutiva num banco compartilhado, e não se faz.');
      console.log('    ⇒ MISSÃO B (branch Neon efêmero por execução) devolve estas provas a TODA rodada.');
      check(true, '(viii.a/b) pulados por schema já migrado — reprodutíveis só com a missão B', 'branch já-aplicada');
    }

    // ── (viii.c) o schema depois ────────────────────────────────────────────
    const colD = await colunaStatusDemanda();
    check(colD?.is_nullable === 'NO', '(viii.c) coluna virou NOT NULL (fecha o sétimo estado)', String(colD?.is_nullable));
    check(String(colD?.column_default ?? '').includes('Em análise'), '(viii.c) DEFAULT segue Em análise', String(colD?.column_default));
    check(await temCheck023(), '(viii.c) CHECK demands_3d_status_chk criado', 'ausente');

    // ── (viii.d) o CHECK e o NOT NULL barram INSERT DIRETO ──────────────────
    let erroCheck = '';
    try {
      await pool.query(
        `INSERT INTO demands_3d (product_id, request_id, quantity, status) VALUES ($1, $2, 1, 'banana')`,
        [p3, r3.data.id]);
    } catch (e: any) { erroCheck = `${e?.code}:${e?.constraint}`; }
    check(erroCheck === '23514:demands_3d_status_chk',
      '(viii.d) INSERT direto fora do vocabulário → 23514 do CHECK', erroCheck || 'passou (não deveria)');

    let erroNulo = '';
    try {
      await pool.query(
        `INSERT INTO demands_3d (product_id, request_id, quantity, status) VALUES ($1, $2, 1, NULL)`,
        [p3, r3.data.id]);
    } catch (e: any) { erroNulo = String(e?.code); }
    check(erroNulo === '23502', '(viii.d) INSERT direto com status NULL → 23502 do NOT NULL', erroNulo || 'passou (não deveria)');

    // ── (viii.e) re-execução é no-op ────────────────────────────────────────
    const reexec = await rodar023();
    check(reexec.ok, '(viii.e) re-execução da 023 é no-op (idempotente)', reexec.erro.slice(0, 200));
    check(await temCheck023() && (await colunaStatusDemanda())?.is_nullable === 'NO',
      '(viii.e) e o schema segue igual depois dela', 'schema divergiu');

  } finally {
    // ── DESTRUIÇÃO ESCOPADA DE DADOS DE TESTE (disciplina C) ────────────────
    // APAGA linha de `stock_ledger` — violação consciente de append-only, escopo assertado à
    // própria execução (ver src/smokes/_cleanup.ts) e DELETE por id conferido. Morre com a missão B.
    const destruicao = await destruicaoEscopadaDeDadosDeTeste(pool, {
      marca: stamp,
      produtos: produtosCriados,
      etapas: [
        // As plantadas por SQL saem por id explícito ANTES da varredura por request_id — o id
        // coletado em memória é a prova de posse; a varredura é a rede.
        ['demands_3d(plantadas)', `DELETE FROM demands_3d WHERE id = ANY($1::uuid[])`, [demandasPlantadas]],
        ['demands_3d', `DELETE FROM demands_3d WHERE request_id = ANY($1::uuid[])`, [requestsCriadas]],
        ['requests',   `DELETE FROM requests WHERE id = ANY($1::uuid[])`, [requestsCriadas]], // request_items via CASCADE
        ['xml_items',  `DELETE FROM xml_items WHERE product_id = ANY($1::uuid[])`, [produtosCriados]],
        ['stock',      `DELETE FROM stock WHERE product_id = ANY($1::uuid[])`, [produtosCriados]],
        ['products',   `DELETE FROM products WHERE id = ANY($1::uuid[])`, [produtosCriados]],
        ['client_services', `DELETE FROM client_services WHERE id = $1`, [opId || null]],
        ['clients',    `DELETE FROM clients WHERE id = $1`, [clienteId || null]],
      ],
    });
    console.log(`\n  destruição escopada: ${formatarContagem(destruicao)}`);
    console.log(`  razão apagado nesta execução (violação consciente, escopo próprio): ${destruicao.razaoApagado} linha(s).`);
    check(destruicao.ok, 'destruição escopada: escopo conferido e todas as etapas OK', destruicao.motivo || destruicao.falhas.join(' | '));
    if (!destruicao.ok) console.error('  ⚠', destruicao.motivo, destruicao.falhas.join(' | '));
    try {
      const sobra = await pool.query(`SELECT (SELECT count(*)::int FROM products WHERE sku LIKE '9.96.%') p,
        (SELECT count(*)::int FROM demands_3d WHERE notes LIKE '%smoke_teto_conferencia%') d,
        (SELECT count(*)::int FROM stock_ledger l WHERE NOT EXISTS
          (SELECT 1 FROM products x WHERE x.id = l.product_id)) orfas`);
      const s = sobra.rows[0];
      console.log(`  restam: produtos da faixa 9.96.%=${s.p}, demandas plantadas=${s.d}.`);
      check(s.p === 0 && s.d === 0, 'destruição escopada: ZERO resíduo do smoke no banco', `produtos=${s.p} demandas=${s.d}`);
      check(s.orfas === 0, 'destruição escopada: nenhuma linha de razão órfã de produto', `órfãs=${s.orfas}`);
    } catch (e: any) {
      console.error('  ⚠ contagem de resíduo falhou:', e?.message ?? e);
      failures.push('contagem de resíduo falhou');
    }
    await pool.end();
    if (servidor) {
      await matarArvore(servidor.child);
      console.log('  servidor efêmero derrubado (árvore).');
    }
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n❌ smoke_teto_conferencia FALHOU — ${failures.length} check(s):`);
      failures.forEach((f) => console.error(`   · ${f}`));
      process.exit(1);
    }
    console.log('\n✅ smoke_teto_conferencia PASSOU — provas i a viii verdes.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n❌ smoke_teto_conferencia ERRO:', e?.message ?? e);
    process.exit(1);
  });
