// src/smokes/smoke_op_status.ts — missão V: vocabulário de OP fechado + furos de escrita.
//
// COMO RODA: `npm run smoke:opstatus` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera
// o /health e mata a ÁRVORE no fim (template ratificado no smoke:requests3d/devdashboard).
// Tudo pela VIA DO USUÁRIO: cliente, OP, produto, entrada, saída manual, solicitação e tarefa
// são criados por HTTP autenticado — nunca chamando controller ou service direto.
//
// ⚠ GUARDA DE HOST — DUAS CAMADAS, as duas OBRIGATÓRIAS:
//     1. FR_EXPECT_DB_HOST declarada e contida na DATABASE_URL (a declaração de quem roda);
//     2. current_database() conferido contra a declaração (o banco dizendo quem é).
//   Sem as duas o smoke morre antes de tocar em qualquer coisa. Recusa `ep-mute-feather` sempre.
//
// ⚠ ESTE SMOKE APLICA A MIGRATION 021 (prova vii). É o único da casa que muda schema, e é por
//   isso que a guarda de host importa mais aqui do que em qualquer outro. A 021 é idempotente:
//   rodar de novo é no-op.
//
// ⚠ DESTRUIÇÃO ESCOPADA DE DADOS DE TESTE (disciplina C — ver src/smokes/_cleanup.ts): apaga
//   linha de `stock_ledger`, o que é VIOLAÇÃO CONSCIENTE de append-only, com escopo assertado à
//   própria execução e DELETE por id conferido. Morre quando a missão B (branch Neon efêmero por
//   execução) chegar. `audit_logs` NÃO é tocado — o livro de auditoria é o livro.
//
// ── AS PROVAS (i a vii da missão V; a viii é a suíte de regressão, fora daqui) ───────────────
//   i    PATCH banana → 400; corpo vazio → 400; serviceId inexistente → 404; nenhum NULL gravável.
//   ii   OP criada pela ROTA nasce 'em_andamento' (não 'pendente') — o furo estrutural fechado.
//   iii  GUARD DE DINHEIRO: saída manual contra OP 'concluido' → 400, zero movimento de estoque,
//        zero linha no razão, zero separation criada.
//   iv   solicitação contra OP 'concluido' → 400; contra 'em_andamento' → 201.
//   v    tasks: os 4 sites (criar/reatribuir, geral e elétrica) contra 'concluido' → 400.
//   vi   legado normalizado na borda: 'finalizada' e 'done' → 'concluido'; 'progress' →
//        'em_andamento'.
//   vii  migration 021: pré-guarda ABORTA com linha 'banana' plantada e não deixa rastro; roda
//        limpa sem ela; backfill traduz 'pendente' e NULL; CHECK barra INSERT direto; re-execução
//        é no-op.

import dotenv from 'dotenv';
dotenv.config();

import { Pool, PoolClient } from 'pg';
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

// Corpo LITERALMENTE vazio (`{}`) — é este o caso que gravava NULL. Não dá pra mandar pelo
// helper acima sem ambiguidade com "sem corpo", então vai explícito.
async function patchCorpoVazio(serviceId: string, token: string) {
  const res = await fetch(`${BASE}/clients/services/${serviceId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
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
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';

  // ── CAMADA 1: a declaração ─────────────────────────────────────────────────
  if (url.includes('ep-mute-feather')) {
    throw new Error('GUARDA: DATABASE_URL aponta para a produção 2.0 — abortando sem tocar no banco.');
  }
  const esperado = (process.env.FR_EXPECT_DB_HOST ?? '').trim();
  if (!esperado) {
    throw new Error('GUARDA: FR_EXPECT_DB_HOST é obrigatória neste smoke (ele ESCREVE e aplica migration). Declare o banco alvo.');
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
  console.log(`▶ smoke_op_status — camada 1 "${esperado}" ✓ · camada 2 current_database="${db}" ✓`);

  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const clientesCriados: string[] = [];
  const opsCriadas: string[] = [];
  const produtosCriados: string[] = [];
  const requestsCriadas: string[] = [];
  const tarefasCriadas: string[] = [];
  // eletrica_tasks.id é INTEGER (tasks.id é UUID) — as duas tabelas gêmeas divergem no tipo da
  // chave. Tratar as duas como uuid foi o que fez o cleanup abortar na primeira execução deste
  // smoke, e por ser um try/catch único ele deixou resíduo em TUDO o que vinha depois.
  const tarefasEletricaCriadas: number[] = [];
  const opsPlantadasSql: string[] = [];   // linhas semeadas por SQL na prova (vii), removidas por id

  // ── Leituras de asserção (nunca escrita) ───────────────────────────────────
  const statusDaOp = async (serviceId: string): Promise<string | null> => {
    const { rows } = await pool.query(`SELECT status FROM client_services WHERE id = $1`, [serviceId]);
    return rows.length ? rows[0].status : null;
  };
  const colunaStatus = async () => {
    const { rows } = await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='client_services' AND column_name='status'`);
    return rows[0] ?? null;
  };
  const temCheck = async (): Promise<boolean> => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'client_services_status_chk'`);
    return rows.length > 0;
  };
  const saldo = async (productId: string) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(quantity_on_hand,0) oh, COALESCE(quantity_reserved,0) res FROM stock
        WHERE product_id=$1 AND op_id IS NULL AND warehouse_id=(SELECT id FROM warehouses WHERE code='ALMOX')`,
      [productId]);
    return { oh: num(rows[0]?.oh), res: num(rows[0]?.res) };
  };
  const ledgerN = async (productId: string): Promise<number> => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1`, [productId]);
    return rows[0].n as number;
  };
  const separationsDaOp = async (serviceId: string): Promise<number> => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM separations WHERE client_service_id=$1`, [serviceId]);
    return rows[0].n as number;
  };

  // Roda o arquivo da migration como UM comando (ela traz o próprio BEGIN/COMMIT: se abortar,
  // o servidor faz o rollback e nada parcial fica). Devolve o erro em vez de lançar.
  const sqlDa021 = fs.readFileSync(path.join(process.cwd(), 'src/migrations/021_op_status_vocab.sql'), 'utf8');
  const rodar021 = async (): Promise<{ ok: boolean; erro: string }> => {
    const c: PoolClient = await pool.connect();
    try {
      await c.query(sqlDa021);
      return { ok: true, erro: '' };
    } catch (e: any) {
      // A migration abre a própria transação; se o erro escapou, ela já foi abortada. Garante
      // que este client não volte sujo pro pool.
      try { await c.query('ROLLBACK'); } catch { /* já estava fora de transação */ }
      return { ok: false, erro: String(e?.message ?? e) };
    } finally {
      c.release();
    }
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

    // =====================================================================
    console.log('\n── (vii) migration 021: guarda de premissa, backfill e CHECK ──');
    // =====================================================================
    const jaAplicada = await temCheck();
    console.log(`  estado inicial do schema: CHECK ${jaAplicada ? 'JÁ presente' : 'ausente'}.`);

    // Cliente dedicado às linhas plantadas por SQL (elas não podem passar pela rota — o objetivo
    // é justamente ter no banco valores que a rota recusa).
    const cliSql = await call('POST', '/clients', { token: tk, body: { code: `SMKV-SQL-${stamp}`, name: `SMOKE V sql ${stamp}` } });
    const clienteSqlId = cliSql.data?.id;
    clientesCriados.push(clienteSqlId);

    const plantar = async (opCode: string, status: string | null): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO client_services (client_id, op_code, description, status)
         VALUES ($1, $2, 'plantada pelo smoke_op_status', $3) RETURNING id`,
        [clienteSqlId, opCode, status]);
      opsPlantadasSql.push(rows[0].id);
      return rows[0].id;
    };

    if (!jaAplicada) {
      // ── (vii.a) a pré-guarda ABORTA com palavra desconhecida ──────────────
      const idBanana = await plantar(`SMKV-BANANA-${stamp}`, 'banana');
      const tentativa = await rodar021();
      check(!tentativa.ok, '(vii.a) pré-guarda ABORTOU a migration com linha "banana" plantada', `ok=${tentativa.ok}`);
      check(/ABORTADO/.test(tentativa.erro) && /banana/.test(tentativa.erro),
        '(vii.a) a mensagem nomeia o aborto e a palavra encontrada', tentativa.erro.slice(0, 160));
      check(await statusDaOp(idBanana) === 'banana', '(vii.a) a linha ofensora segue intocada (nada foi traduzido)', String(await statusDaOp(idBanana)));
      check((await colunaStatus())?.is_nullable === 'YES' && !(await temCheck()),
        '(vii.a) schema INTOCADO pelo aborto — sem NOT NULL, sem CHECK', `nullable=${(await colunaStatus())?.is_nullable} check=${await temCheck()}`);

      // Remove a ofensora POR ID e planta os dois casos que o backfill existe para traduzir.
      await pool.query(`DELETE FROM client_services WHERE id = $1`, [idBanana]);
      opsPlantadasSql.splice(opsPlantadasSql.indexOf(idBanana), 1);

      const idPend = await plantar(`SMKV-PEND-${stamp}`, 'pendente');
      const idNulo = await plantar(`SMKV-NULL-${stamp}`, null);

      // ── (vii.b) roda limpa e traduz ───────────────────────────────────────
      const limpa = await rodar021();
      check(limpa.ok, '(vii.b) sem a ofensora, a migration rodou limpa', limpa.erro.slice(0, 200));
      check(await statusDaOp(idPend) === 'em_andamento', '(vii.b) backfill: pendente → em_andamento', String(await statusDaOp(idPend)));
      check(await statusDaOp(idNulo) === 'em_andamento', '(vii.b) backfill: NULL → em_andamento', String(await statusDaOp(idNulo)));
    } else {
      console.log('  ⓘ 021 já aplicada neste banco: (vii.a) e o backfill NÃO são reproduzíveis aqui');
      console.log('    — o próprio CHECK impede plantar "banana"/"pendente". Provados em banco virgem,');
      console.log('    uma vez, na aplicação da migration. Desmontar o CHECK só para reprovar seria');
      console.log('    cirurgia destrutiva num banco compartilhado, e não se faz.');
      console.log('    ⇒ MISSÃO B (branch Neon efêmero por execução) devolve estas duas provas a TODA');
      console.log('      execução, porque cada rodada nasce num banco pré-021.');
      check(true, '(vii.a/b) pulados por schema já migrado — reprodutíveis só com a missão B', 'branch já-aplicada');
    }

    // ── (vii.c) o schema depois: DEFAULT, NOT NULL, CHECK ───────────────────
    const col = await colunaStatus();
    check(String(col?.column_default ?? '').includes("'em_andamento'"), '(vii.c) DEFAULT agora é em_andamento', String(col?.column_default));
    check(col?.is_nullable === 'NO', '(vii.c) coluna virou NOT NULL (fecha o quarto estado)', String(col?.is_nullable));
    check(await temCheck(), '(vii.c) CHECK client_services_status_chk criado', 'ausente');

    // ── (vii.d) o CHECK barra INSERT DIRETO fora do vocabulário ─────────────
    let erroCheck = '';
    try {
      await pool.query(
        `INSERT INTO client_services (client_id, op_code, description, status) VALUES ($1, $2, $3, 'banana')`,
        [clienteSqlId, `SMKV-DIRETO-${stamp}`, 'insert direto do smoke']);
    } catch (e: any) { erroCheck = `${e?.code}:${e?.constraint}`; }
    check(erroCheck === '23514:client_services_status_chk',
      '(vii.d) INSERT direto com status fora do vocabulário → 23514 do CHECK', erroCheck || 'passou (não deveria)');

    let erroNulo = '';
    try {
      await pool.query(
        `INSERT INTO client_services (client_id, op_code, description, status) VALUES ($1, $2, $3, NULL)`,
        [clienteSqlId, `SMKV-DIRETONULL-${stamp}`, 'insert direto NULL do smoke']);
    } catch (e: any) { erroNulo = String(e?.code); }
    check(erroNulo === '23502', '(vii.d) INSERT direto com status NULL → 23502 do NOT NULL', erroNulo || 'passou (não deveria)');

    // ── (vii.e) idempotência ────────────────────────────────────────────────
    const denovo = await rodar021();
    check(denovo.ok, '(vii.e) re-execução da 021 é no-op (idempotente)', denovo.erro.slice(0, 200));

    // =====================================================================
    console.log('\n── (ii) a OP criada pela ROTA nasce em_andamento ─────────');
    // =====================================================================
    const cli = await call('POST', '/clients', { token: tk, body: { code: `SMKV-${stamp}`, name: `SMOKE V ${stamp}` } });
    const clienteId = cli.data?.id;
    clientesCriados.push(clienteId);

    const OP_ABERTA = `SMKV-ABERTA-${stamp}`;
    const opA = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: OP_ABERTA, description: 'OP aberta do smoke V' } });
    const opAbertaId = opA.data?.id;
    opsCriadas.push(opAbertaId);
    check(opA.status === 201, '(ii) POST /clients/:id/services → 201', `HTTP ${opA.status}`);
    check(opA.data?.status === 'em_andamento', '(ii) a RESPOSTA já traz em_andamento', String(opA.data?.status));
    check(await statusDaOp(opAbertaId) === 'em_andamento',
      '(ii) NO BANCO nasceu em_andamento — nunca mais pendente (furo estrutural fechado)', String(await statusDaOp(opAbertaId)));

    // A OP encerrada das provas iii/iv/v: nasce aberta e é fechada pela via do usuário.
    const OP_FECHADA = `SMKV-FECHADA-${stamp}`;
    const opF = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: OP_FECHADA, description: 'OP encerrada do smoke V' } });
    const opFechadaId = opF.data?.id;
    opsCriadas.push(opFechadaId);
    const fechar = await call('PATCH', `/clients/services/${opFechadaId}/status`, { token: tk, body: { status: 'concluido' } });
    check(fechar.status === 200 && await statusDaOp(opFechadaId) === 'concluido',
      '(ii) PATCH concluido fechou a OP pela via do usuário', `HTTP ${fechar.status} status=${await statusDaOp(opFechadaId)}`);

    // =====================================================================
    console.log('\n── (i) a borda do PATCH: whitelist, ausência e 404 ───────');
    // =====================================================================
    const antesI = await statusDaOp(opAbertaId);

    const banana = await call('PATCH', `/clients/services/${opAbertaId}/status`, { token: tk, body: { status: 'banana' } });
    check(banana.status === 400, '(i) PATCH status="banana" → 400', `HTTP ${banana.status}`);
    check(await statusDaOp(opAbertaId) === antesI, '(i) e não gravou nada', String(await statusDaOp(opAbertaId)));

    const vazio = await patchCorpoVazio(opAbertaId, tk);
    check(vazio.status === 400, '(i) PATCH com corpo {} → 400 (era o caminho do NULL)', `HTTP ${vazio.status}`);
    check(await statusDaOp(opAbertaId) === antesI, '(i) corpo vazio NÃO gravou NULL', String(await statusDaOp(opAbertaId)));

    const nulo = await call('PATCH', `/clients/services/${opAbertaId}/status`, { token: tk, body: { status: null } });
    check(nulo.status === 400, '(i) PATCH status=null → 400', `HTTP ${nulo.status}`);

    const vazia = await call('PATCH', `/clients/services/${opAbertaId}/status`, { token: tk, body: { status: '  ' } });
    check(vazia.status === 400, '(i) PATCH status="  " (só espaço) → 400', `HTTP ${vazia.status}`);

    const naoString = await call('PATCH', `/clients/services/${opAbertaId}/status`, { token: tk, body: { status: 7 } });
    check(naoString.status === 400, '(i) PATCH status=7 (não-string) → 400', `HTTP ${naoString.status}`);

    const inexistente = await call('PATCH', `/clients/services/${UUID_INEXISTENTE}/status`, { token: tk, body: { status: 'concluido' } });
    check(inexistente.status === 404, '(i) serviceId inexistente → 404 (era {success:true} fantasma)', `HTTP ${inexistente.status}`);

    const naoUuid = await call('PATCH', `/clients/services/nao-e-uuid/status`, { token: tk, body: { status: 'concluido' } });
    check(naoUuid.status === 404, '(i) serviceId malformado → 404 (era 500 do 22P02)', `HTTP ${naoUuid.status}`);

    const nulosNoBanco = await pool.query(`SELECT count(*)::int n FROM client_services WHERE status IS NULL`);
    check(nulosNoBanco.rows[0].n === 0, '(i) NENHUM NULL em client_services no banco inteiro', `nulos=${nulosNoBanco.rows[0].n}`);

    // =====================================================================
    console.log('\n── (vi) legado normalizado na borda ──────────────────────');
    // =====================================================================
    const legado = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: `SMKV-LEGADO-${stamp}`, description: 'OP do teste de legado' } });
    const opLegadoId = legado.data?.id;
    opsCriadas.push(opLegadoId);

    const lFin = await call('PATCH', `/clients/services/${opLegadoId}/status`, { token: tk, body: { status: 'finalizada' } });
    check(lFin.status === 200 && await statusDaOp(opLegadoId) === 'concluido',
      "(vi) 'finalizada' aceita e gravada como concluido", `HTTP ${lFin.status} status=${await statusDaOp(opLegadoId)}`);

    const lProg = await call('PATCH', `/clients/services/${opLegadoId}/status`, { token: tk, body: { status: 'progress' } });
    check(lProg.status === 200 && await statusDaOp(opLegadoId) === 'em_andamento',
      "(vi) 'progress' aceita e gravada como em_andamento", `HTTP ${lProg.status} status=${await statusDaOp(opLegadoId)}`);

    const lDone = await call('PATCH', `/clients/services/${opLegadoId}/status`, { token: tk, body: { status: 'done' } });
    check(lDone.status === 200 && await statusDaOp(opLegadoId) === 'concluido',
      "(vi) 'done' aceita e gravada como concluido", `HTTP ${lDone.status} status=${await statusDaOp(opLegadoId)}`);

    const lEncerrada = await call('PATCH', `/clients/services/${opLegadoId}/status`, { token: tk, body: { status: 'encerrada' } });
    check(lEncerrada.status === 400,
      "(vi) 'encerrada' NÃO é legado conhecido → 400 (nunca foi um valor real)", `HTTP ${lEncerrada.status}`);

    // =====================================================================
    console.log('\n── (iii) GUARD DE DINHEIRO: saída manual em OP concluído ──');
    // =====================================================================
    // SKU no formato C.SS.NNNN que o createProduct exige; faixa 9.98.% reservada a este smoke.
    const { rows: usados } = await pool.query<{ sku: string }>(`SELECT sku FROM products WHERE sku LIKE '9.98.%'`);
    const ocupados = new Set(usados.map((u) => u.sku));
    let proximo = 1;
    const skuLivre = (): string => {
      for (;;) {
        const s = `9.98.${String(proximo++).padStart(4, '0')}`;
        if (!ocupados.has(s)) { ocupados.add(s); return s; }
      }
    };

    const prod = await call('POST', '/products', { token: tk, body: {
      sku: skuLivre(), name: `Peça smoke V ${stamp}`, unit: 'UN', min_stock: 0, unit_price: 10, tags: ['usinagem'],
    }});
    const produtoId = prod.data?.id ?? prod.data?.product?.id;
    if (!produtoId) throw new Error(`falha ao criar produto: HTTP ${prod.status} ${JSON.stringify(prod.data)}`);
    produtosCriados.push(produtoId);

    const ent = await call('POST', '/stock/entries', { token: tk, body: {
      type: 'Reaproveitamento', entries: [{ product_id: produtoId, quantity: 20 }],
    }});
    if (ent.status >= 400) throw new Error(`entrada falhou: HTTP ${ent.status} ${JSON.stringify(ent.data)}`);

    const sAntes = await saldo(produtoId);
    const ledgerAntes = await ledgerN(produtoId);
    const sepAntes = await separationsDaOp(opFechadaId);

    const saidaFechada = await call('POST', '/stock/manual-withdrawal', { token: tk, body: {
      sector: 'Usinagem', op_code: OP_FECHADA, items: [{ product_id: produtoId, quantity: 3 }],
    }});
    check(saidaFechada.status === 400, '(iii) saída manual contra OP concluido → 400', `HTTP ${saidaFechada.status}`);
    check(String(saidaFechada.data?.error ?? '').includes('já foi finalizada'),
      '(iii) e com a mensagem OP_FINALIZADA que estava escrita e nunca era alcançada', String(saidaFechada.data?.error));

    const sDepois = await saldo(produtoId);
    check(sDepois.oh === sAntes.oh && sDepois.res === sAntes.res,
      '(iii) ZERO movimento de estoque (on_hand e reserved intactos)', `oh ${sAntes.oh}→${sDepois.oh}, res ${sAntes.res}→${sDepois.res}`);
    check(await ledgerN(produtoId) === ledgerAntes, '(iii) ZERO linha nova no razão', `${ledgerAntes} → ${await ledgerN(produtoId)}`);
    check(await separationsDaOp(opFechadaId) === sepAntes, '(iii) ZERO separation criada na OP fechada', `${sepAntes} → ${await separationsDaOp(opFechadaId)}`);

    // Contraprova: a MESMA saída na OP aberta passa e move o saldo. Sem ela, um 400 vindo de
    // qualquer outro motivo (setor, item, permissão) passaria por prova do guard.
    const saidaAberta = await call('POST', '/stock/manual-withdrawal', { token: tk, body: {
      sector: 'Usinagem', op_code: OP_ABERTA, items: [{ product_id: produtoId, quantity: 3 }],
    }});
    check(saidaAberta.status === 201, '(iii) contraprova: a MESMA saída na OP aberta → 201', `HTTP ${saidaAberta.status} ${JSON.stringify(saidaAberta.data)}`);
    check((await saldo(produtoId)).oh === sAntes.oh - 3, '(iii) contraprova: o físico caiu 3 (o 400 acima era do guard, não de outra coisa)', `on_hand=${(await saldo(produtoId)).oh}`);

    // =====================================================================
    console.log('\n── (iv) solicitação contra OP concluido ──────────────────');
    // =====================================================================
    const pedFechada = await call('POST', '/requests', { token: tk, body: {
      sector: 'Usinagem', op_code: OP_FECHADA, items: [{ product_id: produtoId, quantity: 2, priority: 'Média' }],
    }});
    if (pedFechada.data?.id) requestsCriadas.push(pedFechada.data.id);
    check(pedFechada.status === 400, '(iv) POST /requests contra OP concluido → 400', `HTTP ${pedFechada.status}`);
    check(String(pedFechada.data?.error ?? '').includes('finalizada'), '(iv) com a mensagem OP_FINALIZADA', String(pedFechada.data?.error));

    const resAntesIV = (await saldo(produtoId)).res;
    const pedAberta = await call('POST', '/requests', { token: tk, body: {
      sector: 'Usinagem', op_code: OP_ABERTA, items: [{ product_id: produtoId, quantity: 2, priority: 'Média' }],
    }});
    if (pedAberta.data?.id) requestsCriadas.push(pedAberta.data.id);
    check(pedAberta.status === 201, '(iv) contra OP em_andamento → 201', `HTTP ${pedAberta.status} ${JSON.stringify(pedAberta.data)}`);
    check((await saldo(produtoId)).res === resAntesIV + 2, '(iv) e reservou de verdade (2)', `res=${(await saldo(produtoId)).res}`);

    // =====================================================================
    console.log('\n── (v) tasks: os 4 sites contra OP concluido ─────────────');
    // =====================================================================
    const t1 = await call('POST', '/tasks', { token: tk, body: { title: `Tarefa smoke V ${stamp}`, priority: 'Média', op_code: OP_FECHADA } });
    check(t1.status === 400, '(v.1) createTask contra OP concluido → 400', `HTTP ${t1.status} ${JSON.stringify(t1.data)}`);

    const tOk = await call('POST', '/tasks', { token: tk, body: { title: `Tarefa smoke V ok ${stamp}`, priority: 'Média', op_code: OP_ABERTA } });
    check(tOk.status === 201, '(v.1) contraprova: createTask na OP aberta → 201', `HTTP ${tOk.status} ${JSON.stringify(tOk.data)}`);
    if (tOk.data?.id) tarefasCriadas.push(tOk.data.id);

    const t2 = await call('PUT', `/tasks/${tOk.data?.id}`, { token: tk, body: { op_code: OP_FECHADA } });
    check(t2.status === 400, '(v.2) updateTask reatribuindo para OP concluido → 400', `HTTP ${t2.status} ${JSON.stringify(t2.data)}`);

    const e1 = await call('POST', '/eletrica-tasks', { token: tk, body: { title: `Elétrica smoke V ${stamp}`, priority: 'Média', op_code: OP_FECHADA } });
    check(e1.status === 400, '(v.3) createEletricaTask contra OP concluido → 400', `HTTP ${e1.status} ${JSON.stringify(e1.data)}`);

    const eOk = await call('POST', '/eletrica-tasks', { token: tk, body: { title: `Elétrica smoke V ok ${stamp}`, priority: 'Média', op_code: OP_ABERTA } });
    check(eOk.status === 201, '(v.3) contraprova: createEletricaTask na OP aberta → 201', `HTTP ${eOk.status} ${JSON.stringify(eOk.data)}`);
    if (eOk.data?.id) tarefasEletricaCriadas.push(Number(eOk.data.id));

    const e2 = await call('PUT', `/eletrica-tasks/${eOk.data?.id}`, { token: tk, body: { op_code: OP_FECHADA } });
    check(e2.status === 400, '(v.4) updateEletricaTask reatribuindo para OP concluido → 400', `HTTP ${e2.status} ${JSON.stringify(e2.data)}`);

  } finally {
    // ── DESTRUIÇÃO ESCOPADA DE DADOS DE TESTE (disciplina C) ────────────────
    // O nome é o ato: isto APAGA razão. O escopo é conferido pelo _cleanup.ts antes de qualquer
    // DELETE, e o passo do `stock_ledger` NÃO entra na lista de etapas — ele tem caminho próprio,
    // por id levantado e conferido. A contagem por tabela é logada E assertada.
    const opsTodas = [...opsCriadas, ...opsPlantadasSql].filter(Boolean);
    const clientesTodos = clientesCriados.filter(Boolean);
    const destruicao = await destruicaoEscopadaDeDadosDeTeste(pool, {
      marca: stamp,
      produtos: produtosCriados,
      etapas: [
        ['tasks',             `DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [tarefasCriadas]],
        ['eletrica_tasks',    `DELETE FROM eletrica_tasks WHERE id = ANY($1::int[])`, [tarefasEletricaCriadas]],
        ['demands_3d',        `DELETE FROM demands_3d WHERE request_id = ANY($1::uuid[])`, [requestsCriadas]],
        ['requests',          `DELETE FROM requests WHERE id = ANY($1::uuid[])`, [requestsCriadas]], // request_items via CASCADE
        // A saída manual da prova (iii) criou separation + separation_items amarrados à OP aberta.
        ['separation_items',  `DELETE FROM separation_items WHERE separation_id IN (SELECT id FROM separations WHERE client_service_id = ANY($1::uuid[]))`, [opsTodas]],
        ['separations',       `DELETE FROM separations WHERE client_service_id = ANY($1::uuid[])`, [opsTodas]],
        ['op_material_events',`DELETE FROM op_material_events WHERE client_service_id = ANY($1::uuid[])`, [opsTodas]],
        ['xml_items',         `DELETE FROM xml_items WHERE product_id = ANY($1::uuid[])`, [produtosCriados]],
        ['stock',             `DELETE FROM stock WHERE product_id = ANY($1::uuid[])`, [produtosCriados]],
        ['products',          `DELETE FROM products WHERE id = ANY($1::uuid[])`, [produtosCriados]],
        ['client_services',   `DELETE FROM client_services WHERE id = ANY($1::uuid[])`, [opsTodas]],
        ['clients',           `DELETE FROM clients WHERE id = ANY($1::uuid[])`, [clientesTodos]],
      ],
    });
    console.log(`\n  destruição escopada: ${formatarContagem(destruicao)}`);
    console.log(`  razão apagado nesta execução (violação consciente, escopo próprio): ${destruicao.razaoApagado} linha(s).`);
    check(destruicao.ok, 'destruição escopada: escopo conferido e todas as etapas OK', destruicao.motivo || destruicao.falhas.join(' | '));
    if (!destruicao.ok) console.error('  ⚠', destruicao.motivo, destruicao.falhas.join(' | '));
    try {
      const sobra = await pool.query(
        `SELECT (SELECT count(*)::int FROM client_services) ops,
                (SELECT count(*)::int FROM client_services WHERE op_code LIKE 'SMKV-%') smkv,
                (SELECT count(*)::int FROM clients WHERE code LIKE 'SMKV-%') cli,
                (SELECT count(*)::int FROM products WHERE sku LIKE '9.98.%') prod,
                (SELECT count(*)::int FROM client_services WHERE status NOT IN ('em_andamento','concluido')) fora`);
      const s = sobra.rows[0];
      console.log(`  restam: client_services=${s.ops}, status fora do vocabulário=${s.fora}.`);
      // O resíduo é assertado, não só impresso: uma destruição que falha em silêncio deixa a
      // próxima execução do smoke medindo um banco sujo.
      // A faixa de SKU serve para MEDIR resíduo (leitura); ela nunca é usada para APAGAR.
      check(s.smkv === 0 && s.cli === 0 && s.prod === 0,
        'destruição escopada: ZERO resíduo do smoke no banco (SMKV-% e 9.98.%)', `ops=${s.smkv} clientes=${s.cli} produtos=${s.prod}`);
      // E o razão não pode ficar com linha órfã apontando para produto que saiu.
      const orfas = await pool.query(
        `SELECT count(*)::int n FROM stock_ledger l
          WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = l.product_id)`);
      check(orfas.rows[0].n === 0, 'destruição escopada: nenhuma linha de razão órfã de produto', `órfãs=${orfas.rows[0].n}`);
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

  if (failures.length > 0) {
    console.error(`\n❌ smoke_op_status FALHOU em ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_op_status PASSOU — provas i a vii verdes.');
}

main().catch((err) => {
  console.error('\n💥 smoke_op_status explodiu:', err?.message ?? err);
  process.exit(1);
});
