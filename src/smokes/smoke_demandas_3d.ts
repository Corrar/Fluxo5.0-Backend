// src/smokes/smoke_demandas_3d.ts — lote I-b: a conclusão de demanda para de mentir.
//
// COMO RODA: `npm run smoke:demandas3d` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera
// o /health e mata a ÁRVORE no fim (template ratificado no smoke:requests3d/op_status). Tudo pela
// VIA DO USUÁRIO: produto, entrada, solicitação, demanda, produção e delete por HTTP autenticado.
//
// ⚠ GUARDA DE HOST — DUAS CAMADAS, as duas OBRIGATÓRIAS:
//     1. FR_EXPECT_DB_HOST declarada e contida na DATABASE_URL (a declaração de quem roda);
//     2. current_database() conferido contra a declaração (o banco dizendo quem é).
//   Sem as duas o smoke morre antes de tocar em qualquer coisa. Recusa `ep-mute-feather` sempre.
//
// ⚠ DESTRUICAO ESCOPADA DE DADOS DE TESTE (disciplina C — ver src/smokes/_cleanup.ts): apaga
//   linha de `stock_ledger`, VIOLACAO CONSCIENTE de append-only, escopo assertado a propria
//   execucao e DELETE por id conferido. Morre com a missao B. `audit_logs` NAO e tocado.
//
// ── AS PROVAS (i a vii da missão I-b) ────────────────────────────────────────────────────────
//   i    RESSURREIÇÃO MORTA: concluir demanda de solicitação REJEITADA dá receive SEM reserve —
//        status da solicitação intocado, reservado do produto NÃO sobe, audit estruturado presente.
//   ii   conferido FICA conferido, e a entrega sai na sequência SEM reconferir: consume + release
//        do excedente. É o cenário vi do smoke_requests_3d sem o atrito.
//   iii  aberto FICA aberto; a aprovação humana depois funciona normal (o gate não foi pulado).
//   iv   WHITELIST: Rejeitada→Concluída 400; Concluída→qualquer 400; caminho feliz 200; e a
//        recusa DURANTE a produção (Em desenvolvimento→Rejeitada) aceita, sem mover estoque e
//        com audit — a saída que o ajuste de 08/08 abriu.
//   v    PONTO ÚNICO DE CRÉDITO: produção COM demand_id não move nada; concluir credita UMA vez
//        (contado no razão); produção livre credita; os três deletes (concluída 400, não-concluída
//        sem reversão, livre com reverseReceive).
//   vi   morte da solicitação cancela as demandas vivas (rejeição manual e cron); Concluída sobrevive.
//   vii  idempotência: repetir cada mutação não move saldo nem cria linha no razão.

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
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
async function call(method: string, path: string, opts: { token?: string; body?: object } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
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
  console.log(`▶ smoke_demandas_3d — camada 1 "${esperado}" ✓ · camada 2 current_database="${db}" ✓`);

  const temColuna = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='request_items' AND column_name='qty_reserved'`);
  if (temColuna.rowCount === 0) throw new Error('migration 020 não aplicada neste banco (request_items.qty_reserved ausente).');

  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const produtosCriados: string[] = [];
  const requestsCriadas: string[] = [];
  let clienteId = '';
  let opId = '';

  // ── Helpers de leitura do banco (asserção, nunca escrita) ──────────────────
  const saldo = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(quantity_on_hand,0) oh, COALESCE(quantity_reserved,0) res FROM stock
        WHERE product_id=$1 AND op_id IS NULL AND warehouse_id=(SELECT id FROM warehouses WHERE code='ALMOX')`,
      [productId]);
    return { oh: num(rows[0]?.oh), res: num(rows[0]?.res) };
  };
  const itensDe = async (requestId: string) => {
    const { rows } = await pool.query(
      `SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, ri.qty_reserved
         FROM request_items ri WHERE ri.request_id=$1 ORDER BY ri.id`, [requestId]);
    return rows;
  };
  const demandaDe = async (requestId: string) => {
    const { rows } = await pool.query(
      `SELECT id, quantity, status, request_item_id FROM demands_3d WHERE request_id=$1 ORDER BY created_at LIMIT 1`,
      [requestId]);
    return rows[0] ?? null;
  };
  const demandasDe = async (requestId: string) => {
    const { rows } = await pool.query(
      `SELECT id, status FROM demands_3d WHERE request_id=$1 ORDER BY created_at`, [requestId]);
    return rows;
  };
  const statusDemanda = async (demandId: string) => {
    const { rows } = await pool.query(`SELECT status FROM demands_3d WHERE id=$1`, [demandId]);
    return rows[0]?.status ?? null;
  };
  const ledgerN = async (productId: string) => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1`, [productId]);
    return rows[0].n as number;
  };
  // Conta APENAS entradas físicas (delta_on_hand > 0) do produto — é o número que a dupla
  // contagem inflava. Contar o razão inteiro não serviria: reserve/release também deixam linha.
  const recebimentosN = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1 AND delta_on_hand > 0`, [productId]);
    return rows[0].n as number;
  };
  const statusDe = async (requestId: string) => {
    const { rows } = await pool.query(`SELECT status FROM requests WHERE id=$1`, [requestId]);
    return rows[0]?.status ?? null;
  };
  const auditN = async (action: string, demandId: string) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM audit_logs WHERE action=$1 AND details->>'demand_id' = $2`,
      [action, demandId]);
    return rows[0].n as number;
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
    const cli = await call('POST', '/clients', { token: tk, body: { code: `SMKIB-${stamp}`, name: `SMOKE I-b ${stamp}` } });
    clienteId = cli.data?.id;
    const OP_CODE = `SMKOPIB-${stamp}`;
    const op = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: OP_CODE, description: 'OP do smoke I-b' } });
    opId = op.data?.id;
    check(!!clienteId && !!opId, 'seed: cliente e OP criados pela API', `cli=${!!clienteId} op=${!!opId}`);

    // Faixa 9.97.NNNN — própria deste smoke, para não colidir com 9.99 (requests3d) nem 9.98 (op_status).
    const { rows: usados } = await pool.query<{ sku: string }>(`SELECT sku FROM products WHERE sku LIKE '9.97.%'`);
    const ocupados = new Set(usados.map((u) => u.sku));
    let proximo = 1;
    const skuLivre = (): string => {
      for (;;) {
        const s = `9.97.${String(proximo++).padStart(4, '0')}`;
        if (!ocupados.has(s)) { ocupados.add(s); return s; }
      }
    };

    const criarPeca3D = async (sufixo: string) => {
      const r = await call('POST', '/products', { token: tk, body: {
        sku: skuLivre(), name: `Peça smoke Ib ${sufixo} ${stamp}`, unit: 'UN',
        min_stock: 0, unit_price: 10, tags: ['3D'], is_3d: true,
      }});
      const id = r.data?.id ?? r.data?.product?.id;
      if (!id) throw new Error(`falha ao criar peça 3D ${sufixo}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      produtosCriados.push(id);
      return id;
    };
    const entrada = async (productId: string, qty: number) => {
      const r = await call('POST', '/stock/entries', { token: tk, body: {
        type: 'Reaproveitamento', entries: [{ product_id: productId, quantity: qty }],
      }});
      if (r.status >= 400) throw new Error(`entrada falhou: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    };
    const criarPedido = async (productId: string, qty: number) => {
      const r = await call('POST', '/requests', { token: tk, body: {
        sector: 'Produção 3D', op_code: OP_CODE,
        items: [{ product_id: productId, quantity: qty, priority: 'Média' }],
      }});
      if (r.data?.id) requestsCriadas.push(r.data.id);
      return r;
    };
    const mudarStatus = (requestId: string, body: object) =>
      call('PUT', `/requests/${requestId}/status`, { token: tk, body });
    const moverDemanda = (demandId: string, status: string, reason?: string) =>
      call('PUT', `/producao-3d/demands/${demandId}/status`, { token: tk, body: reason ? { status, reason } : { status } });
    // O caminho feliz completo, um degrau por vez — o mesmo que o botão do Kanban percorre.
    const concluirDemanda = async (demandId: string) => {
      for (const passo of ['Aceita', 'Em desenvolvimento', 'Concluída']) {
        const r = await moverDemanda(demandId, passo);
        if (r.status !== 200) return r;
      }
      return { status: 200, data: { success: true } };
    };

    // =====================================================================
    console.log('\n── (i) RESSURREIÇÃO MORTA: conclusão para solicitação rejeitada ──');
    // =====================================================================
    // pI com estoque 2 e pedido 5 -> reserva 2, demanda de 3. Depois REJEITA (a rejeição libera as
    // 2 e, pelo item 4, cancelaria a demanda) — por isso a demanda é AVANÇADA antes da rejeição:
    // queremos uma demanda VIVA quando a solicitação já está morta, que é o cenário do §5.
    const pI = await criarPeca3D('I'); await entrada(pI, 2);
    const rI = await criarPedido(pI, 5);
    const demI = await demandaDe(rI.data.id);
    check(!!demI && num(demI.quantity) === 3, '(i) demanda nasceu com o que falta (3)', `qty=${demI?.quantity}`);

    // Avança até 'Em desenvolvimento' ANTES de matar a solicitação.
    await moverDemanda(demI.id, 'Aceita');
    await moverDemanda(demI.id, 'Em desenvolvimento');
    const rejI = await mudarStatus(rI.data.id, { status: 'rejeitado', rejection_reason: 'Recusada no smoke I-b.' });
    check(rejI.status === 200, '(i) rejeição da solicitação aceita', `HTTP ${rejI.status}`);

    // A rejeição CANCELA a demanda (item 4). Para provar a regra de crédito da conclusão sobre
    // solicitação morta, ressuscitamos a demanda para 'Em desenvolvimento' pelo ÚNICO caminho que
    // não é via de usuário — UPDATE cirúrgico POR ID, só do status, só desta linha (mesmo padrão
    // do envelhecimento de created_at no smoke_requests_3d). Sem isto, o cenário do §5 seria
    // inalcançável depois do item 4 — e ele PRECISA continuar coberto: demandas antigas, criadas
    // antes deste lote, existem vivas com solicitação já morta.
    await pool.query(`UPDATE demands_3d SET status = 'Em desenvolvimento' WHERE id = $1`, [demI.id]);

    const sI0 = await saldo(pI);
    const itI0 = (await itensDe(rI.data.id))[0];
    const conclI = await moverDemanda(demI.id, 'Concluída');
    const sI1 = await saldo(pI);
    const itI1 = (await itensDe(rI.data.id))[0];
    check(conclI.status === 200, '(i) conclusão aceita (a peça existe, tem que entrar)', `HTTP ${conclI.status}`);
    check(sI1.oh === sI0.oh + 3, '(i) receive ACONTECEU: on_hand subiu 3', `on_hand ${sI0.oh} → ${sI1.oh}`);
    check(sI1.res === sI0.res, '(i) reserve NÃO aconteceu: reservado do produto INTOCADO', `reserved ${sI0.res} → ${sI1.res}`);
    check(num(itI1.qty_reserved) === num(itI0.qty_reserved) && num(itI1.qty_reserved) === 0,
      '(i) qty_reserved do item INTOCADO (0)', `${itI0.qty_reserved} → ${itI1.qty_reserved}`);
    check(await statusDe(rI.data.id) === 'rejeitado',
      '(i) A RESSURREIÇÃO MORREU: solicitação continua rejeitada', String(await statusDe(rI.data.id)));
    check(await auditN('ENTRADA_ESTOQUE_3D_LIVRE', demI.id) === 1,
      '(i) audit estruturado presente (peça em estoque livre, com ids)', `linhas=${await auditN('ENTRADA_ESTOQUE_3D_LIVRE', demI.id)}`);

    // =====================================================================
    console.log('\n── (ii) conferido FICA conferido; entrega sem reconferir ──');
    // =====================================================================
    const pII = await criarPeca3D('II');   // on_hand 0 -> qty_reserved 0, demanda 5
    const rII = await criarPedido(pII, 5);
    const itII0 = (await itensDe(rII.data.id))[0];
    await mudarStatus(rII.data.id, { status: 'aprovado' });
    // Confere 4 (a mais famosa das divergências: produz 5, confere 4).
    await mudarStatus(rII.data.id, { status: 'conferido', adjusted_items: [{ id: itII0.id, quantity_delivered: 4 }] });
    const demII = await demandaDe(rII.data.id);
    const conclII = await concluirDemanda(demII.id);
    check(conclII.status === 200, '(ii) conclusão aceita', `HTTP ${conclII.status}`);
    check(await statusDe(rII.data.id) === 'conferido',
      '(ii) CONFERIDO CONTINUA CONFERIDO (o atrito morreu)', String(await statusDe(rII.data.id)));
    const sII1 = await saldo(pII);
    check(sII1.oh === 5 && sII1.res === 5, '(ii) 5 produzidas e reservadas', `oh=${sII1.oh} res=${sII1.res}`);

    // A ENTREGA SAI DIRETO — sem o passo de reconferir que o smoke antigo precisava.
    const entII = await mudarStatus(rII.data.id, { status: 'entregue' });
    const sII2 = await saldo(pII);
    const itII1 = (await itensDe(rII.data.id))[0];
    check(entII.status === 200, '(ii) entrega aceita SEM reconferir', `HTTP ${entII.status}`);
    check(sII2.oh === 1, '(ii) consume(4): on_hand 5 → 1', `on_hand=${sII2.oh}`);
    check(sII2.res === 0, '(ii) release do excedente(1): reservado zerado', `reserved=${sII2.res}`);
    check(num(itII1.qty_reserved) === 0, '(ii) qty_reserved zerada', String(itII1.qty_reserved));

    // =====================================================================
    console.log('\n── (iii) aberto FICA aberto; aprovação humana depois funciona ──');
    // =====================================================================
    const pIII = await criarPeca3D('III');
    const rIII = await criarPedido(pIII, 3);
    const demIII = await demandaDe(rIII.data.id);
    check(await statusDe(rIII.data.id) === 'aberto', '(iii) solicitação nasce aberta', String(await statusDe(rIII.data.id)));
    const conclIII = await concluirDemanda(demIII.id);
    check(conclIII.status === 200, '(iii) conclusão aceita', `HTTP ${conclIII.status}`);
    check(await statusDe(rIII.data.id) === 'aberto',
      '(iii) NÃO promoveu aberto→aprovado: o gate humano não foi pulado', String(await statusDe(rIII.data.id)));
    const itIII = (await itensDe(rIII.data.id))[0];
    check(num(itIII.qty_reserved) === 3, '(iii) solicitação VIVA: crédito no item aconteceu (3)', String(itIII.qty_reserved));
    // E a aprovação humana, depois, funciona normal.
    const aprIII = await mudarStatus(rIII.data.id, { status: 'aprovado' });
    check(aprIII.status === 200 && await statusDe(rIII.data.id) === 'aprovado',
      '(iii) aprovação humana posterior funciona normal', `HTTP ${aprIII.status} status=${await statusDe(rIII.data.id)}`);

    // =====================================================================
    console.log('\n── (iv) WHITELIST de transição da demanda ────────────────');
    // =====================================================================
    // Rejeitada → Concluída: A PORTA DE CRÉDITO INDEVIDO.
    const pIV = await criarPeca3D('IV');
    const rIV = await criarPedido(pIV, 2);
    const demIV = await demandaDe(rIV.data.id);
    const rejDem = await moverDemanda(demIV.id, 'Rejeitada', 'Fábrica não vai produzir.');
    check(rejDem.status === 200 && await statusDemanda(demIV.id) === 'Rejeitada',
      '(iv) demanda recusada (Em análise → Rejeitada)', `HTTP ${rejDem.status}`);
    const sIV0 = await saldo(pIV);
    const nLedIV0 = await ledgerN(pIV);
    const ressurge = await moverDemanda(demIV.id, 'Concluída');
    check(ressurge.status === 400, '(iv) Rejeitada → Concluída RECUSADA (400)', `HTTP ${ressurge.status}`);
    check(String(ressurge.data?.error ?? '').includes('Transição inválida'),
      '(iv) sentinela própria da whitelist', String(ressurge.data?.error).slice(0, 60));
    check(await statusDemanda(demIV.id) === 'Rejeitada', '(iv) status da demanda não mudou', String(await statusDemanda(demIV.id)));
    const sIV1 = await saldo(pIV);
    check(sIV1.oh === sIV0.oh && sIV1.res === sIV0.res, '(iv) NENHUM crédito de peça que ninguém imprimiu', `oh=${sIV1.oh} res=${sIV1.res}`);
    check(await ledgerN(pIV) === nLedIV0, '(iv) zero linha nova no razão', `${nLedIV0} → ${await ledgerN(pIV)}`);

    // Concluída → qualquer coisa: terminal.
    const pIVb = await criarPeca3D('IVb');
    const rIVb = await criarPedido(pIVb, 2);
    const demIVb = await demandaDe(rIVb.data.id);
    // Caminho FELIZ, degrau a degrau — a contraprova de que a whitelist não fechou o que é legítimo.
    const passoA = await moverDemanda(demIVb.id, 'Aceita');
    const passoB = await moverDemanda(demIVb.id, 'Em desenvolvimento');
    const passoC = await moverDemanda(demIVb.id, 'Concluída');
    check(passoA.status === 200 && passoB.status === 200 && passoC.status === 200,
      '(iv) caminho feliz Em análise→Aceita→Em desenvolvimento→Concluída = 200',
      `${passoA.status}/${passoB.status}/${passoC.status}`);
    const depoisConcl = await moverDemanda(demIVb.id, 'Em desenvolvimento');
    const depoisConcl2 = await moverDemanda(demIVb.id, 'Rejeitada', 'tentativa');
    check(depoisConcl.status === 400 && depoisConcl2.status === 400,
      '(iv) Concluída → qualquer coisa RECUSADA (terminal)', `${depoisConcl.status}/${depoisConcl2.status}`);
    // E o pulo que a whitelist mata na entrada: Em análise → Concluída direto.
    const pIVc = await criarPeca3D('IVc');
    const rIVc = await criarPedido(pIVc, 2);
    const demIVc = await demandaDe(rIVc.data.id);
    const pulo = await moverDemanda(demIVc.id, 'Concluída');
    check(pulo.status === 400, '(iv) Em análise → Concluída num pulo RECUSADA', `HTTP ${pulo.status}`);

    // ── (iv.e) RECUSA DURANTE A PRODUÇÃO (ajuste do arquiteto, 08/08/2026) ───────────────────
    // 'Em desenvolvimento' → 'Rejeitada' é LEGÍTIMO: é a peça que falhou na impressora. A saída
    // ficou aberta porque o botão "Recusar" do Kanban aparece nessa coluna, e fechá-la
    // transformaria um botão que funciona num 400 — com o agravante de que o único escape
    // ('Excluir demanda' → Cancelada) não coleta motivo.
    const pIVd = await criarPeca3D('IVd');
    const rIVd = await criarPedido(pIVd, 3);
    const demIVd = await demandaDe(rIVd.data.id);
    await moverDemanda(demIVd.id, 'Aceita');
    await moverDemanda(demIVd.id, 'Em desenvolvimento');
    const sIVd0 = await saldo(pIVd);
    const nLedIVd0 = await ledgerN(pIVd);
    const itIVd0 = (await itensDe(rIVd.data.id))[0];

    const recusaEmProd = await moverDemanda(demIVd.id, 'Rejeitada', 'Peça falhou na impressora.');
    const sIVd1 = await saldo(pIVd);
    const itIVd1 = (await itensDe(rIVd.data.id))[0];
    check(recusaEmProd.status === 200, '(iv.e) Em desenvolvimento → Rejeitada ACEITA (200)', `HTTP ${recusaEmProd.status}`);
    check(await statusDemanda(demIVd.id) === 'Rejeitada', '(iv.e) demanda ficou Rejeitada', String(await statusDemanda(demIVd.id)));
    check(sIVd1.oh === sIVd0.oh && sIVd1.res === sIVd0.res,
      '(iv.e) ZERO movimento de estoque na recusa', `oh ${sIVd0.oh}→${sIVd1.oh} res ${sIVd0.res}→${sIVd1.res}`);
    check(await ledgerN(pIVd) === nLedIVd0, '(iv.e) zero linha nova no razão', `${nLedIVd0} → ${await ledgerN(pIVd)}`);
    check(num(itIVd1.qty_reserved) === num(itIVd0.qty_reserved),
      '(iv.e) qty_reserved do item intocado', `${itIVd0.qty_reserved} → ${itIVd1.qty_reserved}`);
    check(await auditN('REJEITAR_DEMANDA_3D', demIVd.id) === 1,
      '(iv.e) audit da recusa PRESENTE', `linhas=${await auditN('REJEITAR_DEMANDA_3D', demIVd.id)}`);
    // O audit tem que dizer DE ONDE veio a recusa — é o que separa "a fábrica não aceitou o
    // pedido" de "a peça falhou na impressora".
    const { rows: detRecusa } = await pool.query(
      `SELECT details->>'status_anterior' anterior, details->>'motivo' motivo
         FROM audit_logs WHERE action='REJEITAR_DEMANDA_3D' AND details->>'demand_id' = $1`,
      [demIVd.id]);
    check(detRecusa[0]?.anterior === 'Em desenvolvimento' && String(detRecusa[0]?.motivo ?? '').includes('impressora'),
      '(iv.e) audit registra status anterior e motivo', `anterior=${detRecusa[0]?.anterior} motivo=${String(detRecusa[0]?.motivo ?? '').slice(0, 30)}`);

    // E Rejeitada continua TERMINAL — o ajuste abriu a entrada, não a saída.
    const voltaA = await moverDemanda(demIVd.id, 'Concluída');
    const voltaB = await moverDemanda(demIVd.id, 'Em desenvolvimento');
    const voltaC = await moverDemanda(demIVd.id, 'Cancelada');
    check(voltaA.status === 400 && voltaB.status === 400 && voltaC.status === 400,
      '(iv.e) Rejeitada → qualquer coisa SEGUE 400 (terminal)', `${voltaA.status}/${voltaB.status}/${voltaC.status}`);

    // =====================================================================
    console.log('\n── (v) PONTO ÚNICO DE CRÉDITO: a dupla contagem morreu ───');
    // =====================================================================
    const pV = await criarPeca3D('V');
    const rV = await criarPedido(pV, 4);
    const demV = await demandaDe(rV.data.id);
    const sV0 = await saldo(pV);
    const recV0 = await recebimentosN(pV);

    // 1. Registrar produção VINCULADA à demanda -> ZERO movimento.
    const prodVinc = await call('POST', '/producao-3d/productions', { token: tk, body: {
      partId: pV, demandId: demV.id, quantity: 4, totalMinutes: 120, filamentGrams: 80, date: new Date().toISOString(),
    }});
    const sV1 = await saldo(pV);
    check(prodVinc.status === 201, '(v) produção vinculada aceita (201)', `HTTP ${prodVinc.status}`);
    check(sV1.oh === sV0.oh && sV1.res === sV0.res, '(v) produção COM demand_id: ZERO movimento de saldo', `oh=${sV1.oh} res=${sV1.res}`);
    check(await recebimentosN(pV) === recV0, '(v) e ZERO entrada no razão', `${recV0} → ${await recebimentosN(pV)}`);

    // 2. Concluir a MESMA demanda -> UMA entrada só (era aqui que entrava a segunda).
    await concluirDemanda(demV.id);
    const sV2 = await saldo(pV);
    check(await recebimentosN(pV) === recV0 + 1,
      '(v) DUPLA CONTAGEM MORTA: concluir gerou UMA entrada no razão, não duas',
      `${recV0} → ${await recebimentosN(pV)}`);
    check(sV2.oh === sV0.oh + 4, '(v) e o físico subiu 4 UMA vez (não 8)', `on_hand ${sV0.oh} → ${sV2.oh}`);

    // 3. Produção LIVRE (sem demand_id) -> receive normal, caminho intocado.
    const pVb = await criarPeca3D('Vb');
    const sVb0 = await saldo(pVb);
    const prodLivre = await call('POST', '/producao-3d/productions', { token: tk, body: {
      partId: pVb, quantity: 7, totalMinutes: 60, filamentGrams: 40, date: new Date().toISOString(),
    }});
    const sVb1 = await saldo(pVb);
    check(prodLivre.status === 201 && sVb1.oh === sVb0.oh + 7,
      '(v) produção LIVRE credita normal (+7)', `HTTP ${prodLivre.status} on_hand ${sVb0.oh} → ${sVb1.oh}`);

    // 4. Os TRÊS deletes.
    const delConcluida = await call('DELETE', `/producao-3d/productions/${prodVinc.data.id}`, { token: tk });
    check(delConcluida.status === 400, '(v) delete de produção de demanda CONCLUÍDA → 400', `HTTP ${delConcluida.status}`);
    check(String(delConcluida.data?.error ?? '').includes('não pode ser apagada'),
      '(v) sentinela PRODUCAO_DE_DEMANDA_CONCLUIDA', String(delConcluida.data?.error).slice(0, 60));
    check(sV2.oh === (await saldo(pV)).oh, '(v) e o saldo não se mexeu na recusa', `on_hand=${(await saldo(pV)).oh}`);

    // Produção vinculada a demanda NÃO concluída: delete livre, sem reversão.
    const pVc = await criarPeca3D('Vc');
    const rVc = await criarPedido(pVc, 3);
    const demVc = await demandaDe(rVc.data.id);
    const prodNaoConcl = await call('POST', '/producao-3d/productions', { token: tk, body: {
      partId: pVc, demandId: demVc.id, quantity: 3, totalMinutes: 30, filamentGrams: 20, date: new Date().toISOString(),
    }});
    const sVc0 = await saldo(pVc);
    const delNaoConcl = await call('DELETE', `/producao-3d/productions/${prodNaoConcl.data.id}`, { token: tk });
    const sVc1 = await saldo(pVc);
    check(delNaoConcl.status === 200, '(v) delete de produção de demanda NÃO concluída → 200', `HTTP ${delNaoConcl.status}`);
    check(sVc1.oh === sVc0.oh && sVc1.res === sVc0.res,
      '(v) e SEM reversão de estoque (nunca creditou)', `oh=${sVc1.oh} res=${sVc1.res}`);

    // Produção livre: reverseReceive de sempre.
    const delLivre = await call('DELETE', `/producao-3d/productions/${prodLivre.data.id}`, { token: tk });
    const sVb2 = await saldo(pVb);
    check(delLivre.status === 200 && sVb2.oh === sVb0.oh,
      '(v) delete de produção LIVRE reverte a entrada (reverseReceive)', `HTTP ${delLivre.status} on_hand=${sVb2.oh}`);

    // =====================================================================
    console.log('\n── (vi) morte da solicitação cancela as demandas vivas ───');
    // =====================================================================
    // (vi.a) REJEIÇÃO MANUAL — o caminho que NÃO cancelava nada antes deste lote.
    const pVI = await criarPeca3D('VI');
    const rVI = await criarPedido(pVI, 6);
    const demVI = await demandaDe(rVI.data.id);
    check(await statusDemanda(demVI.id) === 'Em análise', '(vi.a) demanda viva antes', String(await statusDemanda(demVI.id)));
    await mudarStatus(rVI.data.id, { status: 'rejeitado', rejection_reason: 'Rejeição manual no smoke.' });
    check(await statusDemanda(demVI.id) === 'Cancelada',
      '(vi.a) REJEIÇÃO MANUAL cancelou a demanda viva', String(await statusDemanda(demVI.id)));

    // (vi.b) CRON — a outra porta que não cancelava.
    const pVIb = await criarPeca3D('VIb');
    const rVIb = await criarPedido(pVIb, 6);
    const demVIb = await demandaDe(rVIb.data.id);
    await pool.query(`UPDATE requests SET created_at = NOW() - INTERVAL '20 days' WHERE id = $1`, [rVIb.data.id]);
    const { runExpireRequestsSweep } = await import('../jobs/expireRequests.job');
    await runExpireRequestsSweep();
    check(await statusDe(rVIb.data.id) === 'rejeitado', '(vi.b) cron expirou a solicitação', String(await statusDe(rVIb.data.id)));
    check(await statusDemanda(demVIb.id) === 'Cancelada',
      '(vi.b) CRON cancelou a demanda viva', String(await statusDemanda(demVIb.id)));

    // (vi.c) CONCLUÍDA SOBREVIVE — a peça existe, cancelar seria trocar o rótulo de um fato.
    const pVIc = await criarPeca3D('VIc');
    const rVIc = await criarPedido(pVIc, 5);
    const demVIc = await demandaDe(rVIc.data.id);
    await concluirDemanda(demVIc.id);
    const delVIc = await call('DELETE', `/requests/${rVIc.data.id}`, { token: tk });
    check(delVIc.status === 200, '(vi.c) cancelamento da solicitação aceito', `HTTP ${delVIc.status}`);
    check(await statusDemanda(demVIc.id) === 'Concluída',
      '(vi.c) demanda CONCLUÍDA sobreviveu ao cancelamento', String(await statusDemanda(demVIc.id)));

    // (vi.d) contraprova de cobertura: as três origens aparecem no audit, distinguíveis.
    const { rows: origens } = await pool.query(
      `SELECT DISTINCT details->>'origem' o FROM audit_logs
        WHERE action='CANCELAR_DEMANDA_3D' AND details->>'request_id' = ANY($1::text[])`,
      [[rVI.data.id, rVIb.data.id, rVIc.data.id]]);
    const setOrigens = new Set(origens.map((x: any) => x.o));
    check(setOrigens.has('rejeicao_manual') && setOrigens.has('expiracao_cron'),
      '(vi.d) audit distingue a origem de cada cancelamento', [...setOrigens].join(','));

    // =====================================================================
    console.log('\n── (vii) idempotência: repetir não move saldo nem razão ──');
    // =====================================================================
    const pVII = await criarPeca3D('VII');
    const rVII = await criarPedido(pVII, 4);
    const demVII = await demandaDe(rVII.data.id);
    await concluirDemanda(demVII.id);
    const sVII1 = await saldo(pVII);
    const nVII1 = await ledgerN(pVII);

    const reconcluir = await moverDemanda(demVII.id, 'Concluída');
    const rejeitarConcluida = await moverDemanda(demVII.id, 'Rejeitada', 'x');
    const delDemanda = await call('DELETE', `/producao-3d/demands/${demVII.id}`, { token: tk });
    check(reconcluir.status === 400, '(vii) reconcluir demanda é recusado', `HTTP ${reconcluir.status}`);
    check(rejeitarConcluida.status === 400, '(vii) rejeitar demanda concluída é recusado', `HTTP ${rejeitarConcluida.status}`);
    check(delDemanda.status === 400, '(vii) cancelar demanda concluída é recusado', `HTTP ${delDemanda.status}`);
    check((await saldo(pVII)).oh === sVII1.oh && (await saldo(pVII)).res === sVII1.res,
      '(vii) saldo idêntico após as repetições', `oh=${(await saldo(pVII)).oh} res=${(await saldo(pVII)).res}`);
    check(await ledgerN(pVII) === nVII1, '(vii) ZERO linha nova no razão', `${nVII1} → ${await ledgerN(pVII)}`);

    // Rejeição repetida da solicitação + cron repetido não cancelam de novo (nem duplicam audit).
    const nAuditVI = (await pool.query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='CANCELAR_DEMANDA_3D' AND details->>'request_id' = $1`,
      [rVI.data.id])).rows[0].n;
    await mudarStatus(rVI.data.id, { status: 'rejeitado', rejection_reason: 'repetida' });
    const nAuditVI2 = (await pool.query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='CANCELAR_DEMANDA_3D' AND details->>'request_id' = $1`,
      [rVI.data.id])).rows[0].n;
    check(nAuditVI2 === nAuditVI,
      '(vii) rejeitar solicitação já rejeitada não cancela nem audita de novo', `${nAuditVI} → ${nAuditVI2}`);

  } finally {
    // ── DESTRUIÇÃO ESCOPADA DE DADOS DE TESTE (disciplina C) ────────────────
    // APAGA linha de `stock_ledger` — violação consciente de append-only, escopo assertado à
    // própria execução (ver src/smokes/_cleanup.ts) e DELETE por id conferido. Morre com a missão B.
    const destruicao = await destruicaoEscopadaDeDadosDeTeste(pool, {
      marca: stamp,
      produtos: produtosCriados,
      etapas: [
        // productions_3d ANTES de demands_3d e products: demand_id é ON DELETE SET NULL (não
        // cascateia) e product_id tem FK sem cascade — a linha ficaria travando o produto.
        ['productions_3d', `DELETE FROM productions_3d WHERE product_id = ANY($1::uuid[])`, [produtosCriados]],
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
      const sobra = await pool.query(`SELECT (SELECT count(*)::int FROM products WHERE sku LIKE '9.97.%') p,
        (SELECT count(*)::int FROM stock_ledger l WHERE NOT EXISTS
          (SELECT 1 FROM products x WHERE x.id = l.product_id)) orfas`);
      const s = sobra.rows[0];
      console.log(`  restam: produtos da faixa 9.97.%=${s.p}.`);
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
      console.error(`\n❌ smoke_demandas_3d FALHOU — ${failures.length} check(s):`);
      failures.forEach((f) => console.error(`   · ${f}`));
      process.exit(1);
    }
    console.log('\n✅ smoke_demandas_3d PASSOU — provas i a vii verdes.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n❌ smoke_demandas_3d ERRO:', e?.message ?? e);
    process.exit(1);
  });
