// src/smokes/smoke_requests_3d.ts — lote I-a: o 3D vira estoque físico (migration 020).
//
// COMO RODA: `npm run smoke:requests3d` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera
// o /health e mata a ÁRVORE no fim (template ratificado no smoke:devdashboard/assembly). Tudo
// pela VIA DO USUÁRIO: cria produto, dá entrada, cria solicitação, aprova, confere, entrega,
// rejeita, cancela e conclui demanda por HTTP autenticado — nunca chamando o service direto.
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
// ── AS PROVAS (i a xii da missão I-a) ────────────────────────────────────────────────────────
//   i    b80d14c6 reproduzida: reserve(5) → ajuste(−4) → rejeição → release(1); a órfã não nasce.
//   ii   criação parcial: reserve(disp), qty_reserved=disp, demanda com o resto E request_item_id.
//   iii  conclusão da demanda: receive+reserve e o CRÉDITO no item (qty_reserved sobe) — e, desde
//        o lote I-b, o status da solicitação fica INTOCADO.
//   iv   entrega com reserva suficiente: consume(efetiva), colunas zeradas.
//   v    entrega com reserva INSUFICIENTE: 400 sentinela e saldo intocado.
//   vi   entrega parcial com excedente: consume(4) + release(1) — SEM o passo de reconferir, que
//        era conserto de efeito colateral e morreu no lote I-b (ver o bloco na prova).
//   vii  cancelamento (porta 6) e cron de expiração (porta 8) liberam qty_reserved.
//   viii devolvido (porta 5) e devolução parcial (porta 7): peça 3D volta ao físico.
//   ix   idempotência: repetir cada mutação não move saldo nem cria linha no razão.
//   x    REGRESSÃO não-3D: a fórmula deles (quantity_delivered ?? quantity_requested) intocada.
//   xi   migration 020: backfill bate com o razão para solicitação viva e dá 0 para terminal.
//   xii  release-orfas-3d em dry-run, ESTADO-AGNOSTICO: com orfas o plano bate com o medido;
//        sem orfas, "0 aplicaveis" e o verde e os releases no razao provam a limpeza. Zero escrita.

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
  console.log(`▶ smoke_requests_3d — camada 1 "${esperado}" ✓ · camada 2 current_database="${db}" ✓`);

  // Sem a 020 aplicada o smoke inteiro é ruído — falha alto e cedo.
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
      `SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, ri.qty_reserved, p.sku
         FROM request_items ri LEFT JOIN products p ON p.id=ri.product_id
        WHERE ri.request_id=$1 ORDER BY ri.id`, [requestId]);
    return rows;
  };
  const demandaDe = async (requestId: string) => {
    const { rows } = await pool.query(
      `SELECT id, quantity, status, request_item_id FROM demands_3d WHERE request_id=$1 ORDER BY created_at LIMIT 1`,
      [requestId]);
    return rows[0] ?? null;
  };
  const ledgerN = async (productId: string) => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM stock_ledger WHERE product_id=$1`, [productId]);
    return rows[0].n as number;
  };
  const statusDe = async (requestId: string) => {
    const { rows } = await pool.query(`SELECT status FROM requests WHERE id=$1`, [requestId]);
    return rows[0]?.status ?? null;
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

    // ── SEED pela via do usuário: cliente + OP + produtos + entradas ─────────
    const cli = await call('POST', '/clients', { token: tk, body: { code: `SMK3D-${stamp}`, name: `SMOKE 3D ${stamp}` } });
    clienteId = cli.data?.id;
    const op = await call('POST', `/clients/${clienteId}/services`, { token: tk, body: { op_code: `SMKOP3D-${stamp}`, description: 'OP do smoke 3D' } });
    opId = op.data?.id;
    const OP_CODE = `SMKOP3D-${stamp}`;
    check(!!clienteId && !!opId, 'seed: cliente e OP criados pela API', `cli=${!!clienteId} op=${!!opId}`);

    // SKU do smoke obedece ao formato C.SS.NNNN validado pelo createProduct (a API é a via real,
    // e ela recusa qualquer outro formato). Reservamos a faixa 9.99.NNNN e pegamos os próximos
    // números LIVRES — assim rodar o smoke duas vezes seguidas não colide.
    const { rows: usados } = await pool.query<{ sku: string }>(`SELECT sku FROM products WHERE sku LIKE '9.99.%'`);
    const ocupados = new Set(usados.map((u) => u.sku));
    let proximo = 1;
    const skuLivre = (): string => {
      for (;;) {
        const s = `9.99.${String(proximo++).padStart(4, '0')}`;
        if (!ocupados.has(s)) { ocupados.add(s); return s; }
      }
    };
    const skusDoSmoke: string[] = [];

    // Peça 3D: tag '3D' (é ela que torna a OP obrigatória — o caminho real do módulo).
    const criarPeca3D = async (sufixo: string) => {
      const sku = skuLivre();
      const r = await call('POST', '/products', { token: tk, body: {
        sku, name: `Peça smoke 3D ${sufixo} ${stamp}`, unit: 'UN',
        min_stock: 0, unit_price: 10, tags: ['3D'], is_3d: true,
      }});
      const id = r.data?.id ?? r.data?.product?.id;
      if (!id) throw new Error(`falha ao criar peça 3D ${sufixo}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      produtosCriados.push(id); skusDoSmoke.push(sku);
      return id;
    };
    const entrada = async (productId: string, qty: number) => {
      const r = await call('POST', '/stock/entries', { token: tk, body: {
        type: 'Reaproveitamento', entries: [{ product_id: productId, quantity: qty }],
      }});
      if (r.status >= 400) throw new Error(`entrada falhou: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    };
    const criarPedido = async (productId: string, qty: number, comOp = true) => {
      const r = await call('POST', '/requests', { token: tk, body: {
        sector: 'Produção 3D', op_code: comOp ? OP_CODE : undefined,
        items: [{ product_id: productId, quantity: qty, priority: 'Média' }],
      }});
      if (r.data?.id) requestsCriadas.push(r.data.id);
      return r;
    };
    const mudarStatus = (requestId: string, body: object) =>
      call('PUT', `/requests/${requestId}/status`, { token: tk, body });

    // ATUALIZADO NO LOTE I-b: concluir demanda deixou de ser um salto.
    // A whitelist de transição (TRANSICOES_DEMANDA em producao3d.controller) fechou o caminho
    // 'Em análise' → 'Concluída' num pulo só. Não é atrito artificial do smoke: é o que o front
    // sempre fez — o botão do Kanban avança UM degrau por vez (P3_DEMSTATUS[...].next em
    // producao3d.jsx), então este helper passa a percorrer o mesmo caminho que o operador percorre.
    // O que a whitelist mata é o pulo que a TELA nunca ofereceu e a API aceitava: Rejeitada →
    // Concluída, a porta de crédito de peça que ninguém imprimiu.
    const concluirDemanda = async (demandId: string) => {
      for (const passo of ['Aceita', 'Em desenvolvimento', 'Concluída']) {
        const r = await call('PUT', `/producao-3d/demands/${demandId}/status`, { token: tk, body: { status: passo } });
        if (r.status !== 200) return r;   // devolve o primeiro erro — quem chama assere em cima dele
      }
      return { status: 200, data: { success: true } };
    };

    const pI = await criarPeca3D('I');    await entrada(pI, 12);
    const pII = await criarPeca3D('II');  await entrada(pII, 3);
    const pV = await criarPeca3D('V');    await entrada(pV, 3);
    const pVI = await criarPeca3D('VI');  // on_hand 0 de propósito
    const pVII = await criarPeca3D('VII'); await entrada(pVII, 10);
    const pVIII = await criarPeca3D('VIII'); await entrada(pVIII, 10);
    const pIX = await criarPeca3D('IX');  await entrada(pIX, 6);

    // Produto NÃO-3D (tag isenta → dispensa OP) para a regressão.
    const pNao3D = await call('POST', '/products', { token: tk, body: {
      sku: skuLivre(), name: `Insumo smoke não-3D ${stamp}`, unit: 'UN',
      min_stock: 0, unit_price: 5, tags: ['insumos'],
    }});
    const pN = pNao3D.data?.id; produtosCriados.push(pN);
    await entrada(pN, 20);

    // =====================================================================
    console.log('\n── (i) b80d14c6 reproduzida: a órfã não nasce ────────────');
    // =====================================================================
    const s0 = await saldo(pI);
    const rI = await criarPedido(pI, 5);
    const itI0 = (await itensDe(rI.data.id))[0];
    const s1 = await saldo(pI);
    check(s1.res - s0.res === 5, '(i) criação reservou 5', `Δreserved=${s1.res - s0.res}`);
    check(num(itI0.qty_reserved) === 5, '(i) qty_reserved do item = 5', String(itI0.qty_reserved));

    await mudarStatus(rI.data.id, { status: 'aprovado' });
    // Conferência ajustando para 1 — o mesmo movimento que a b80d14c6 sofreu (adjrelease de −4).
    await mudarStatus(rI.data.id, { status: 'conferido', adjusted_items: [{ id: itI0.id, quantity_delivered: 1 }] });
    const itI1 = (await itensDe(rI.data.id))[0];
    const s2 = await saldo(pI);
    check(s2.res - s0.res === 1, '(i) ajuste liberou 4 (reserva volta a 1)', `Δreserved=${s2.res - s0.res}`);
    check(num(itI1.qty_reserved) === 1, '(i) qty_reserved acompanhou o ajuste = 1', String(itI1.qty_reserved));

    const rejI = await mudarStatus(rI.data.id, { status: 'rejeitado', rejection_reason: 'Cancelado pelo almoxarifado.' });
    const itI2 = (await itensDe(rI.data.id))[0];
    const s3 = await saldo(pI);
    check(rejI.status === 200, '(i) rejeição aceita', `HTTP ${rejI.status}`);
    check(s3.res === s0.res, '(i) RESERVA VOLTOU AO INICIAL — a órfã não nasceu', `reserved=${s3.res} (inicial ${s0.res})`);
    check(num(itI2.qty_reserved) === 0, '(i) qty_reserved zerada', String(itI2.qty_reserved));
    check(s3.oh === s1.oh, '(i) físico intocado pela rejeição', `on_hand=${s3.oh}`);

    // =====================================================================
    console.log('\n── (ii) criação parcial: reserva o que há, manda o resto pra fábrica ──');
    // =====================================================================
    const rII = await criarPedido(pII, 5);   // disponível 3, pedido 5
    const itII = (await itensDe(rII.data.id))[0];
    const sII1 = await saldo(pII);
    const demII = await demandaDe(rII.data.id);
    check(sII1.res === 3, '(ii) reservou só o disponível (3)', `reserved=${sII1.res}`);
    check(num(itII.qty_reserved) === 3, '(ii) qty_reserved = 3', String(itII.qty_reserved));
    check(!!demII && num(demII.quantity) === 2, '(ii) demanda 3D criada com o que falta (2)', `qty=${demII?.quantity}`);
    check(!!demII && demII.request_item_id === itII.id, '(ii) demanda carrega request_item_id (rateio por item)', `${demII?.request_item_id}`);

    // =====================================================================
    console.log('\n── (iii) conclusão da demanda credita o item ─────────────');
    // =====================================================================
    const statusAntesConcl = await statusDe(rII.data.id);
    const concl = await concluirDemanda(demII.id);
    const itII2 = (await itensDe(rII.data.id))[0];
    const sII2 = await saldo(pII);
    check(concl.status === 200, '(iii) conclusão aceita', `HTTP ${concl.status}`);
    check(sII2.oh === 5, '(iii) receive: on_hand 3 → 5', `on_hand=${sII2.oh}`);
    check(sII2.res === 5, '(iii) reserve: reserved 3 → 5', `reserved=${sII2.res}`);
    check(num(itII2.qty_reserved) === 5, '(iii) CRÉDITO NO ITEM: qty_reserved 3 → 5', String(itII2.qty_reserved));
    // LOTE I-b: a solicitação estava 'aberto' e CONTINUA 'aberto'. A conclusão não promove mais
    // aberto→aprovado pelas costas do gate humano (era o atalho que pulava a definição de
    // quantidades no painel de conferência).
    check(statusAntesConcl === 'aberto' && await statusDe(rII.data.id) === 'aberto',
      '(iii) status da solicitação INTOCADO pela conclusão (aberto → aberto)',
      `${statusAntesConcl} → ${await statusDe(rII.data.id)}`);

    // =====================================================================
    console.log('\n── (iv) entrega com reserva suficiente ───────────────────');
    // =====================================================================
    // ATUALIZADO NO LOTE I-b: a conclusão NÃO devolve mais a solicitação a 'aprovado'. Ela ficou
    // em 'aberto' (prova iii acima), então a aprovação humana acontece aqui, explícita — que é
    // exatamente o ponto: aprovar é onde o almoxarife define as quantidades, e agora ninguém pula.
    await mudarStatus(rII.data.id, { status: 'aprovado' });
    await mudarStatus(rII.data.id, { status: 'conferido' });
    const entII = await mudarStatus(rII.data.id, { status: 'entregue' });
    const itII3 = (await itensDe(rII.data.id))[0];
    const sII3 = await saldo(pII);
    check(entII.status === 200, '(iv) entrega aceita', `HTTP ${entII.status}`);
    check(sII3.oh === 0 && sII3.res === 0, '(iv) consume(5): on_hand e reserved zerados', `oh=${sII3.oh} res=${sII3.res}`);
    check(num(itII3.qty_reserved) === 0, '(iv) qty_reserved zerada pela entrega', String(itII3.qty_reserved));

    // =====================================================================
    console.log('\n── (v) entrega SEM peça produzida: 400 e saldo intocado ──');
    // =====================================================================
    const rV = await criarPedido(pV, 5);     // disponível 3 → qty_reserved 3, demanda 2 NÃO concluída
    await mudarStatus(rV.data.id, { status: 'aprovado' });
    await mudarStatus(rV.data.id, { status: 'conferido' });
    const sV0 = await saldo(pV);
    const nLedV0 = await ledgerN(pV);
    const entV = await mudarStatus(rV.data.id, { status: 'entregue' });
    const sV1 = await saldo(pV);
    const itV = (await itensDe(rV.data.id))[0];
    check(entV.status === 400, '(v) entrega recusada com 400', `HTTP ${entV.status}`);
    check(String(entV.data?.error ?? '').includes('ainda não produzida'), '(v) mensagem é a sentinela ENTREGA_3D_SEM_PECA', String(entV.data?.error).slice(0, 60));
    check(sV1.oh === sV0.oh && sV1.res === sV0.res, '(v) saldo INTOCADO', `oh=${sV1.oh} res=${sV1.res}`);
    check(await ledgerN(pV) === nLedV0, '(v) nenhuma linha nova no razão', `ledger=${await ledgerN(pV)}`);
    check(num(itV.qty_reserved) === 3, '(v) qty_reserved preservada (3)', String(itV.qty_reserved));
    check(await statusDe(rV.data.id) === 'conferido', '(v) status não avançou', String(await statusDe(rV.data.id)));

    // =====================================================================
    console.log('\n── (vi) entrega parcial com excedente: consume(4) + release(1) ──');
    // =====================================================================
    const rVI = await criarPedido(pVI, 5);   // on_hand 0 → qty_reserved 0, demanda 5
    const itVI0 = (await itensDe(rVI.data.id))[0];
    check(num(itVI0.qty_reserved) === 0, '(vi) sem estoque: qty_reserved nasce 0', String(itVI0.qty_reserved));
    await mudarStatus(rVI.data.id, { status: 'aprovado' });
    // Confere 4 ANTES da produção: sem reserva no produto, o ajuste não move saldo nem coluna.
    await mudarStatus(rVI.data.id, { status: 'conferido', adjusted_items: [{ id: itVI0.id, quantity_delivered: 4 }] });
    const demVI = await demandaDe(rVI.data.id);
    await concluirDemanda(demVI.id);
    const itVI1 = (await itensDe(rVI.data.id))[0];
    const sVI1 = await saldo(pVI);
    check(num(itVI1.qty_reserved) === 5, '(vi) produção creditou 5 no item', String(itVI1.qty_reserved));
    check(sVI1.oh === 5 && sVI1.res === 5, '(vi) saldo: 5 produzidas e reservadas', `oh=${sVI1.oh} res=${sVI1.res}`);

    // ── O ATRITO QUE MORREU NO LOTE I-b ──────────────────────────────────────────────────────
    // Aqui existia um `mudarStatus(rVI, {status:'conferido'})` com o comentário "Re-confere
    // (aprovado→conferido) sem ajuste". Ele não era parte do cenário: era CONSERTO de um efeito
    // colateral. A conclusão da demanda jogava a solicitação de volta para 'aprovado', e sem
    // reconferir a entrega não saía. O smoke tinha CODIFICADO o atrito — e um smoke que codifica
    // o defeito passa a defendê-lo: mudar o comportamento para melhor deixaria o smoke vermelho.
    //
    // Agora 'conferido' FICA conferido (item 1), então a entrega sai direto. Se este passo
    // voltasse, ele mesmo seria a falha: 'conferido' → 'conferido' não está no TRANSICOES de
    // requests.controller e tomaria 400.
    check(await statusDe(rVI.data.id) === 'conferido',
      '(vi) conferido CONTINUA conferido depois da conclusão — sem reconferir',
      String(await statusDe(rVI.data.id)));

    const entVI = await mudarStatus(rVI.data.id, { status: 'entregue' });
    const itVI2 = (await itensDe(rVI.data.id))[0];
    const sVI2 = await saldo(pVI);
    check(entVI.status === 200, '(vi) entrega aceita', `HTTP ${entVI.status}`);
    check(sVI2.oh === 1, '(vi) consume(4): on_hand 5 → 1', `on_hand=${sVI2.oh}`);
    check(sVI2.res === 0, '(vi) release do excedente(1): reserved zerado', `reserved=${sVI2.res}`);
    check(num(itVI2.qty_reserved) === 0, '(vi) qty_reserved zerada', String(itVI2.qty_reserved));

    // =====================================================================
    console.log('\n── (vii) cancelamento (porta 6) e cron (porta 8) ─────────');
    // =====================================================================
    const sVII0 = await saldo(pVII);
    const rVIIa = await criarPedido(pVII, 4);
    const itVIIa = (await itensDe(rVIIa.data.id))[0];
    check((await saldo(pVII)).res - sVII0.res === 4, '(vii) cancelamento: reserva criada (4)', `res=${(await saldo(pVII)).res}`);
    const del = await call('DELETE', `/requests/${rVIIa.data.id}`, { token: tk });
    const itVIIa2 = (await itensDe(rVIIa.data.id))[0];
    check(del.status === 200, '(vii) DELETE aceito', `HTTP ${del.status}`);
    check((await saldo(pVII)).res === sVII0.res, '(vii) PORTA 6 liberou a reserva 3D', `res=${(await saldo(pVII)).res}`);
    check(num(itVIIa2.qty_reserved) === 0, '(vii) qty_reserved zerada pelo cancelamento', String(itVIIa2.qty_reserved));

    const rVIIb = await criarPedido(pVII, 3);
    const itVIIb = (await itensDe(rVIIb.data.id))[0];
    // Envelhecer a solicitação é a única coisa sem via de usuário — UPDATE cirúrgico POR ID,
    // só do created_at, só desta linha (mesmo padrão do INSERT cirúrgico do smoke:assembly).
    await pool.query(`UPDATE requests SET created_at = NOW() - INTERVAL '20 days' WHERE id = $1`, [rVIIb.data.id]);
    const { runExpireRequestsSweep } = await import('../jobs/expireRequests.job');
    await runExpireRequestsSweep();
    const itVIIb2 = (await itensDe(rVIIb.data.id))[0];
    check(await statusDe(rVIIb.data.id) === 'rejeitado', '(vii) cron expirou a solicitação', String(await statusDe(rVIIb.data.id)));
    check((await saldo(pVII)).res === sVII0.res, '(vii) PORTA 8 liberou a reserva 3D', `res=${(await saldo(pVII)).res}`);
    check(num(itVIIb2.qty_reserved) === 0, '(vii) qty_reserved zerada pelo cron', String(itVIIb2.qty_reserved));

    // =====================================================================
    console.log('\n── (viii) devolvido (porta 5) e devolução parcial (porta 7) ──');
    // =====================================================================
    const rVIIIa = await criarPedido(pVIII, 4);
    await mudarStatus(rVIIIa.data.id, { status: 'aprovado' });
    await mudarStatus(rVIIIa.data.id, { status: 'conferido' });
    await mudarStatus(rVIIIa.data.id, { status: 'entregue' });
    const sVIIIa = await saldo(pVIII);
    check(sVIIIa.oh === 6, '(viii) entrega baixou 4 (10 → 6)', `on_hand=${sVIIIa.oh}`);
    const dev = await mudarStatus(rVIIIa.data.id, { status: 'devolvido' });
    const sVIIIb = await saldo(pVIII);
    check(dev.status === 200 && sVIIIb.oh === 10, '(viii) PORTA 5: devolução total devolveu a peça 3D ao físico', `HTTP ${dev.status} on_hand=${sVIIIb.oh}`);

    const rVIIIb = await criarPedido(pVIII, 3);
    await mudarStatus(rVIIIb.data.id, { status: 'aprovado' });
    await mudarStatus(rVIIIb.data.id, { status: 'conferido' });
    await mudarStatus(rVIIIb.data.id, { status: 'entregue' });
    const itVIIIb = (await itensDe(rVIIIb.data.id))[0];
    const ohAntesParcial = (await saldo(pVIII)).oh;
    const opRetAntes = (await pool.query(`SELECT count(*)::int n FROM op_returns WHERE client_service_id=$1`, [opId])).rows[0].n;
    const parcial = await call('POST', `/requests/${rVIIIb.data.id}/partial-return`, { token: tk, body: {
      returns: [{ request_item_id: itVIIIb.id, quantity_to_return: 2 }],
    }});
    const opRetDepois = (await pool.query(`SELECT count(*)::int n FROM op_returns WHERE client_service_id=$1`, [opId])).rows[0].n;
    check(parcial.status === 200, '(viii) devolução parcial aceita', `HTTP ${parcial.status}`);
    check((await saldo(pVIII)).oh === ohAntesParcial + 2, '(viii) PORTA 7: peça 3D voltou ao físico (+2)', `on_hand=${(await saldo(pVIII)).oh}`);
    check(opRetDepois === opRetAntes + 1, '(viii) op_returns segue gravando (agora com contrapartida física)', `${opRetAntes} → ${opRetDepois}`);

    // =====================================================================
    console.log('\n── (ix) idempotência: repetir não move saldo nem razão ───');
    // =====================================================================
    const rIX = await criarPedido(pIX, 2);
    const sIX0 = await saldo(pIX);
    const nIX0 = await ledgerN(pIX);
    const rej1 = await mudarStatus(rIX.data.id, { status: 'rejeitado', rejection_reason: 'teste idem' });
    const sIX1 = await saldo(pIX);
    const nIX1 = await ledgerN(pIX);
    const rej2 = await mudarStatus(rIX.data.id, { status: 'rejeitado', rejection_reason: 'teste idem' });
    const del2 = await call('DELETE', `/requests/${rIX.data.id}`, { token: tk });
    const concl2 = await call('PUT', `/producao-3d/demands/${demII.id}/status`, { token: tk, body: { status: 'Concluída' } });
    check(rej1.status === 200 && sIX1.res === sIX0.res - 2, '(ix) 1ª rejeição liberou a reserva', `res ${sIX0.res} → ${sIX1.res}`);
    check(rej2.status === 400, '(ix) 2ª rejeição barrada pela máquina de transições', `HTTP ${rej2.status}`);
    check(del2.status >= 400, '(ix) cancelar solicitação já rejeitada é recusado', `HTTP ${del2.status}`);
    check(concl2.status === 400, '(ix) reconcluir demanda é recusado (DEMANDA_JA_CONCLUIDA)', `HTTP ${concl2.status}`);
    check((await saldo(pIX)).res === sIX1.res && (await saldo(pIX)).oh === sIX1.oh, '(ix) saldo idêntico após as repetições', `oh=${(await saldo(pIX)).oh} res=${(await saldo(pIX)).res}`);
    check(await ledgerN(pIX) === nIX1, '(ix) ZERO linha nova no razão após as repetições', `${nIX1} → ${await ledgerN(pIX)}`);

    // Borda da mudança 1: peça 3D não aceita fracionário.
    const frac = await criarPedido(pIX, 2.5);
    check(frac.status === 400, '(ix/borda) 3D com quantidade fracionária → 400', `HTTP ${frac.status}`);
    check(String(frac.data?.error ?? '').includes('unidades inteiras'), '(ix/borda) sentinela QTD_3D_FRACIONARIA', String(frac.data?.error).slice(0, 50));

    // =====================================================================
    console.log('\n── (x) REGRESSÃO não-3D: fórmula antiga intocada ─────────');
    // =====================================================================
    const sN0 = await saldo(pN);
    // (a) rejeição libera quantity_requested
    const rNa = await criarPedido(pN, 5, false);
    check((await saldo(pN)).res === sN0.res + 5, '(x.a) não-3D reservou 5 na criação', `res=${(await saldo(pN)).res}`);
    await mudarStatus(rNa.data.id, { status: 'rejeitado', rejection_reason: 'regressão' });
    check((await saldo(pN)).res === sN0.res, '(x.a) rejeição não-3D liberou pela fórmula antiga', `res=${(await saldo(pN)).res}`);

    // (b) ajuste + entrega: consome quantity_delivered, libera o resto no ajuste
    const rNb = await criarPedido(pN, 6, false);
    const itNb = (await itensDe(rNb.data.id))[0];
    await mudarStatus(rNb.data.id, { status: 'aprovado' });
    await mudarStatus(rNb.data.id, { status: 'conferido', adjusted_items: [{ id: itNb.id, quantity_delivered: 4 }] });
    check((await saldo(pN)).res === sN0.res + 4, '(x.b) ajuste não-3D reduziu a reserva para 4', `res=${(await saldo(pN)).res}`);
    const ohNb = (await saldo(pN)).oh;
    await mudarStatus(rNb.data.id, { status: 'entregue' });
    check((await saldo(pN)).oh === ohNb - 4, '(x.b) entrega não-3D consumiu 4 (fórmula delivered)', `on_hand=${(await saldo(pN)).oh}`);
    check((await saldo(pN)).res === sN0.res, '(x.b) reserva não-3D zerada pela entrega', `res=${(await saldo(pN)).res}`);

    // (c) cancelamento não-3D
    const rNc = await criarPedido(pN, 3, false);
    await call('DELETE', `/requests/${rNc.data.id}`, { token: tk });
    check((await saldo(pN)).res === sN0.res, '(x.c) cancelamento não-3D liberou a reserva', `res=${(await saldo(pN)).res}`);

    // =====================================================================
    console.log('\n── (xi) migration 020: backfill × razão ──────────────────');
    // =====================================================================
    const divergentes = await pool.query(
      `SELECT count(*)::int n FROM request_items ri JOIN requests r ON r.id=ri.request_id
        WHERE r.status IN ('aberto','aprovado','conferido')
          AND ri.qty_reserved <> COALESCE((SELECT SUM(l.delta_reserved) FROM stock_ledger l
                WHERE l.op_key LIKE 'request:'||ri.request_id||':item:'||ri.id||':%'),0)`);
    check(divergentes.rows[0].n === 0, '(xi) todo item de solicitação VIVA bate com o razão', `divergências=${divergentes.rows[0].n}`);
    const terminaisSujos = await pool.query(
      `SELECT count(*)::int n FROM request_items ri JOIN requests r ON r.id=ri.request_id
        WHERE r.status IN ('rejeitado','entregue','devolvido') AND ri.qty_reserved <> 0`);
    check(terminaisSujos.rows[0].n === 0, '(xi) nenhuma solicitação terminal com qty_reserved <> 0', `sujos=${terminaisSujos.rows[0].n}`);

    // =====================================================================
    console.log('\n── (xii) release-orfas-3d: dry-run (estado-agnóstico) ─────');
    // =====================================================================
    // REESCRITA 07/08/2026. A versão original cravava "4/4 órfã(s) aplicável(is) — 10 unidade(s)"
    // e "a órfã ed06c220 segue presa com 7". Era FIXTURE, não prova: no dia em que o
    // release-orfas-3d rodou pra valer (o GO das órfãs, 07/08 19:06, `reason` "Correção lote I-a"),
    // a asserção virou falsa POR FORA e o smoke ficou vermelho no repo sem nada estar quebrado.
    // Smoke vermelho permanente treina a ignorar vermelho — então a prova passa a derivar o
    // esperado do BANCO e a valer nos dois estados:
    //   órfãs existem  -> o plano do dry-run bate com a contagem/unidades que nós medimos;
    //   zero órfãs     -> "0 aplicáveis" É o verde, e o razão tem que CONTER os releases que
    //                     fizeram a limpeza (senão "zero órfãs" poderia significar "nunca houve
    //                     reserva", que é uma coisa completamente diferente de "foi liberada").
    // Em ambos os estados o dry-run tem que declarar zero escrita e não mover uma unidade.

    // O conjunto de órfãs pela MESMA definição do script: item 3D de solicitação TERMINAL com
    // saldo de reserva > 0 no razão. Derivado, nunca hardcoded.
    const ORFAS_SQL = `
      SELECT ri.id, ri.request_id,
             COALESCE((SELECT SUM(l.delta_reserved) FROM stock_ledger l
                        WHERE l.op_key LIKE 'request:'||ri.request_id||':item:'||ri.id||':%'),0) AS saldo
        FROM request_items ri
        JOIN products p ON p.id = ri.product_id
        JOIN requests r ON r.id = ri.request_id
       WHERE p.is_3d = true AND r.status IN ('rejeitado','entregue','devolvido')`;
    const orfasAntes = await pool.query(`SELECT * FROM (${ORFAS_SQL}) x WHERE x.saldo > 0`);
    const nOrfas = orfasAntes.rowCount ?? 0;
    const unidadesOrfas = orfasAntes.rows.reduce((a: number, r: any) => a + num(r.saldo), 0);
    console.log(`  estado medido no banco: ${nOrfas} órfã(s), ${unidadesOrfas} unidade(s) presas.`);

    const dry = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['-r', 'ts-node/register', 'src/scripts/release-orfas-3d.ts'], {
        env: { ...process.env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      p.stdout?.on('data', (b) => { out += b.toString(); });
      p.stderr?.on('data', (b) => { out += b.toString(); });
      p.on('exit', () => resolve(out));
    });
    const linhaPlano = dry.split('\n').filter((l) => l.includes('aplicável')).join('').trim();

    // Invariantes que valem nos DOIS estados.
    check(dry.includes('DRY-RUN: nada foi escrito'), '(xii) dry-run declarou zero escrita', 'marcador ausente');

    if (nOrfas > 0) {
      // Estado "há sujeira": o plano tem que bater com o que medimos, unidade por unidade.
      check(
        linhaPlano.includes(`${nOrfas} unidade`) || linhaPlano.includes(`— ${unidadesOrfas} unidade`),
        `(xii) o plano do dry-run bate com as ${nOrfas} órfã(s) / ${unidadesOrfas} unidade(s) medidas`,
        linhaPlano || 'linha de plano não encontrada');
      check(new RegExp(`\\b${nOrfas}\\b`).test(linhaPlano),
        `(xii) o plano cita a contagem medida (${nOrfas})`, linhaPlano || 'linha não encontrada');
    } else {
      // Estado "já limpo": zero aplicáveis É o verde...
      check(/\b0\/0\b|\b0 órfã|0 aplicável|— 0 unidade/.test(linhaPlano),
        '(xii) sem órfãs, o plano declara 0 aplicáveis — e isso É o verde', linhaPlano || 'linha não encontrada');
      // ...mas só vale como prova de LIMPEZA se o razão contiver os releases que a fizeram.
      // Para todo item 3D terminal que UM DIA reservou, tem que existir linha de liberação.
      const liberacoes = await pool.query(`
        SELECT count(*)::int reservaram,
               count(*) FILTER (WHERE tem_release)::int com_release
          FROM (
            SELECT ri.id,
                   EXISTS (SELECT 1 FROM stock_ledger l
                            WHERE l.op_key LIKE 'request:'||ri.request_id||':item:'||ri.id||':%'
                              AND l.delta_reserved > 0) AS reservou,
                   EXISTS (SELECT 1 FROM stock_ledger l
                            WHERE l.op_key LIKE 'request:'||ri.request_id||':item:'||ri.id||':%'
                              AND l.delta_reserved < 0) AS tem_release
              FROM request_items ri
              JOIN products p ON p.id = ri.product_id
              JOIN requests r ON r.id = ri.request_id
             WHERE p.is_3d = true AND r.status IN ('rejeitado','entregue','devolvido')
          ) y WHERE y.reservou`);
      const { reservaram, com_release } = liberacoes.rows[0];
      check(reservaram > 0,
        '(xii) existe histórico de reserva 3D em solicitação terminal (senão "zero órfãs" não prova nada)',
        `itens que reservaram=${reservaram}`);
      check(reservaram === com_release,
        `(xii) TODO item 3D terminal que reservou tem release no razão — a limpeza está registrada (${com_release}/${reservaram})`,
        `com release=${com_release} de ${reservaram}`);
    }

    // O dry-run não move nada, em qualquer estado.
    const orfasDepois = await pool.query(`SELECT * FROM (${ORFAS_SQL}) x WHERE x.saldo > 0`);
    const unidadesDepois = orfasDepois.rows.reduce((a: number, r: any) => a + num(r.saldo), 0);
    check((orfasDepois.rowCount ?? 0) === nOrfas && unidadesDepois === unidadesOrfas,
      '(xii) o dry-run não moveu uma unidade (estado idêntico antes e depois)',
      `antes ${nOrfas}/${unidadesOrfas}, depois ${orfasDepois.rowCount}/${unidadesDepois}`);

  } finally {
    // ── DESTRUIÇÃO ESCOPADA DE DADOS DE TESTE (disciplina C) ────────────────
    // Era "cleanup cirúrgico": nome que descrevia o cuidado e escondia o ato. Isto APAGA linha de
    // `stock_ledger` — violação consciente de append-only, com escopo assertado à própria execução
    // (ver src/smokes/_cleanup.ts) e DELETE por id conferido. Antes, o passo do razão era um
    // `DELETE ... WHERE product_id = ANY(...)` solto no meio de um try único, sem contagem
    // logada — foi essa forma que virou incidente em 07/08/2026. Morre com a missão B.
    const destruicao = await destruicaoEscopadaDeDadosDeTeste(pool, {
      marca: stamp,
      produtos: produtosCriados,
      etapas: [
        ['demands_3d', `DELETE FROM demands_3d WHERE request_id = ANY($1::uuid[])`, [requestsCriadas]],
        ['op_returns', `DELETE FROM op_returns WHERE client_service_id = $1`, [opId || null]],
        ['requests',   `DELETE FROM requests WHERE id = ANY($1::uuid[])`, [requestsCriadas]], // request_items via CASCADE
        // xml_items: a entrada de estoque (POST /stock/entries) grava o item da nota. FK sem
        // cascade — precisa sair antes do produto.
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
      const sobra = await pool.query(`SELECT (SELECT count(*)::int FROM requests) r,
        (SELECT count(*)::int FROM products WHERE sku LIKE '9.99.%') p,
        (SELECT count(*)::int FROM stock_ledger l WHERE NOT EXISTS
          (SELECT 1 FROM products x WHERE x.id = l.product_id)) orfas`);
      const s = sobra.rows[0];
      console.log(`  restam: requests=${s.r}, produtos da faixa 9.99.%=${s.p}.`);
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

  if (failures.length > 0) {
    console.error(`\n❌ smoke_requests_3d FALHOU em ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_requests_3d PASSOU — provas i a xii verdes.');
}

main().catch((err) => {
  console.error('\n💥 smoke_requests_3d explodiu:', err?.message ?? err);
  process.exit(1);
});
