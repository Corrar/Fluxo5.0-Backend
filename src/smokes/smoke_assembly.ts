// src/smokes/smoke_assembly.ts — smoke da Montagem de Máquinas v1 (migration 016).
//
// COMO RODA: `npm run smoke:assembly` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera
// o /health e mata a ÁRVORE no fim (template ratificado no smoke:devdashboard). Roda
// src/server.ts via ts-node pra nunca testar dist velho. Com SMOKE_BASE_URL definido não sobe
// nada e mira o alvo dado (é assim que a regressão roda contra o Render).
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO na ordem das FKs: eventos do razão (por id) -> máquinas (por id). A
//   page_key concedida ao 005 é INSERT/DELETE do par exato. Nada global.
//
// SEMEADURA DE WIP: o consume só passa se a OP tiver saldo, e saldo nasce de um evento
// 'recebido'. Não há endpoint utilizável aqui (o POST /receive exige separação entregue depois
// do cutoff, com teto por item), então o smoke faz um INSERT CIRÚRGICO de 'recebido' com op_key
// própria — o mesmo caminho que o _smoke.ts dos returns já usa pra semear WIP. O CHECK da 008
// exige ref_separation_id + ref_separation_item_id, então o evento ANCORA num separation_item
// real (escolhido por SELECT, nunca inventado) e some no cleanup.
//
// COBERTURA:
//   [GATE]      005 sem 'montagem' → 403 em todas as rotas; chave concedida → 200; revogada → 403.
//   [BORDA]     name vazio 400; op_code fantasma 404; checklists malformado 400; válido 201 com display_no.
//   [ETIQUETA]  consume com machineId grava machine_id; a ÁRVORE do GET /:id devolve SKU/qty
//               certos; consume SEM machineId segue válido (machine_id NULL, fora da árvore).
//   [GUARD]     máquina da OP-A + consumo na OP-B → 400 citando as duas OPs, e NADA gravado.
//   [IDEM]      replay do mesmo X-Idempotency-Key com machineId → mesma resposta, 1 evento só.
//   [RÉGUA]     a etiqueta é INVISÍVEL pro saldo: a projeção da OP cai exatamente qty(etiquetado)
//               + qty(sem etiqueta), e stock/stock_ledger não ganham NENHUMA linha.
//   [PARADA]    sem motivo 400; com motivo+setor seta stopped_*; retomar limpa; 'concluida' → 400 (v2).
//   [AUDITORIA] 4 actions da máquina no livro; e o consume SEGUE SEM createLog (ausência asserida).
//
// Atores: 001 (admin — bypass do requirePermission), 005 (não-admin, sem a chave).

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';

const SENHA_SEED = 'Teste@123';
const OP_A = '73001';
const OP_B = '88210';
let BASE = process.env.SMOKE_BASE_URL ?? '';

const failures: string[] = [];
function check(cond: boolean, desc: string, got: string): void {
  if (cond) {
    console.log(`  ✔ ${desc}  (${got})`);
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
async function call(method: string, path: string, opts: { token?: string; body?: object; idem?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers['X-Idempotency-Key'] = opts.idem;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const eventosCriados: string[] = [];   // ids de op_material_events (seed + consumos)
  const maquinasCriadas: string[] = [];  // ids de assembly_machines
  let permConcedida = false;
  let id005 = '';

  try {
    if (BASE) {
      console.log('▶ smoke_assembly — host de validação OK (ep-summer-wave); SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('▶ smoke_assembly — host de validação OK (ep-summer-wave); subindo servidor efêmero em', BASE);
      servidor = subirServidor(porta);
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto (/health respondeu).');
    }

    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    id005 = setor.user.id;

    // Resolve as duas OPs e um separation_item real pra ancorar o 'recebido' de seed.
    const opsRes = await pool.query(`SELECT id, op_code FROM client_services WHERE op_code = ANY($1)`, [[OP_A, OP_B]]);
    const opA = opsRes.rows.find((r: any) => r.op_code === OP_A)?.id;
    const opB = opsRes.rows.find((r: any) => r.op_code === OP_B)?.id;
    if (!opA || !opB) throw new Error(`OPs de teste ausentes no seed (${OP_A}/${OP_B}) — abortando.`);
    const ancora = await pool.query(
      `SELECT si.id AS item_id, si.separation_id, si.product_id, p.sku, p.name
         FROM separation_items si JOIN products p ON p.id = si.product_id
        ORDER BY si.id LIMIT 1`,
    );
    if (ancora.rows.length === 0) throw new Error('nenhum separation_item no seed pra ancorar o recebido — abortando.');
    const { item_id: itemId, separation_id: sepId, product_id: produtoId, sku } = ancora.rows[0];

    // ── [GATE] router inteiro atrás de 'montagem' ────────────────────────────
    console.log('\n[GATE] chave própria montagem');
    const g1 = await call('GET', '/assembly-machines', { token: setorToken });
    check(g1.status === 403, '005 sem a chave: GET → 403', `HTTP ${g1.status}`);
    const g2 = await call('POST', '/assembly-machines', { token: setorToken, body: { name: 'x', op_code: OP_A } });
    check(g2.status === 403, '005 sem a chave: POST → 403', `HTTP ${g2.status}`);

    const jaTinha = await pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1 AND page_key = 'montagem'`, [id005]);
    if (jaTinha.rows.length > 0) throw new Error("005 já tem 'montagem' — estado inesperado do seed, abortando.");
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'montagem')`, [id005]);
    permConcedida = true;
    const g3 = await call('GET', '/assembly-machines', { token: setorToken });
    check(g3.status === 200, '005 COM a chave → 200 (sem novo login)', `HTTP ${g3.status}`);
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'montagem'`, [id005]);
    permConcedida = false;
    const g4 = await call('GET', '/assembly-machines', { token: setorToken });
    check(g4.status === 403, 'chave revogada → 403 de volta', `HTTP ${g4.status}`);

    // ── [BORDA] cadastro ─────────────────────────────────────────────────────
    console.log('\n[BORDA] cadastro da máquina');
    const b1 = await call('POST', '/assembly-machines', { token: adminToken, body: { name: '   ', op_code: OP_A } });
    check(b1.status === 400, 'name vazio → 400', `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/assembly-machines', { token: adminToken, body: { name: 'Máquina fantasma', op_code: 'OP-INEXISTENTE' } });
    check(b2.status === 404, 'op_code fantasma → 404', `HTTP ${b2.status}: ${b2.data?.error}`);
    const b3 = await call('POST', '/assembly-machines', { token: adminToken, body: { name: 'Checklist ruim', op_code: OP_A, checklists: [{ nome: 'Chassi', peso: 150, itens: [] }] } });
    check(b3.status === 400, 'peso fora de 0-100 → 400', `HTTP ${b3.status}: ${b3.data?.error}`);
    const b4 = await call('POST', '/assembly-machines', { token: adminToken, body: { name: 'Sem itens', op_code: OP_A, checklists: [{ nome: 'Chassi', peso: 30, itens: 'nao-e-lista' }] } });
    check(b4.status === 400, 'itens não-lista → 400', `HTTP ${b4.status}: ${b4.data?.error}`);

    const criada = await call('POST', '/assembly-machines', {
      token: adminToken,
      body: {
        name: 'SMOKE Classificadora CL-12', op_code: OP_A, sector: 'Montagem', responsible: 'Smoke',
        checklists: [{ nome: 'Chassi', peso: 30, itens: [{ t: 'Corte de perfis', done: true, dia: '30/07' }, { t: 'Dobra', done: false }] }],
      },
    });
    check(criada.status === 201 && !!criada.data?.id, 'válido → 201', `HTTP ${criada.status}`);
    check(Number.isInteger(criada.data?.display_no), 'display_no veio do banco (IDENTITY)', `MAQ-${criada.data?.display_no}`);
    const maquinaA = criada.data.id;
    maquinasCriadas.push(maquinaA);

    const criadaB = await call('POST', '/assembly-machines', { token: adminToken, body: { name: 'SMOKE Máquina da OP-B', op_code: OP_B } });
    if (criadaB.status !== 201) throw new Error(`falha ao criar máquina da OP-B: HTTP ${criadaB.status}`);
    const maquinaB = criadaB.data.id;
    maquinasCriadas.push(maquinaB);
    check(criadaB.data.display_no === criada.data.display_no + 1, 'display_no é sequencial', `${criada.data.display_no} → ${criadaB.data.display_no}`);

    // ── SEMEADURA DO WIP (INSERT cirúrgico de 'recebido', ancorado em separação real) ──
    console.log('\n[SEED] WIP na OP-A (evento recebido, cirúrgico, removido no cleanup)');
    const seedKey = `smk:assembly:recv:${Date.now()}`;
    const seed = await pool.query(
      `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, ref_separation_id, ref_separation_item_id, op_key)
       VALUES ('recebido', $1, $2, 100, $3, $4, $5) RETURNING id`,
      [opA, produtoId, sepId, itemId, seedKey],
    );
    eventosCriados.push(seed.rows[0].id);
    console.log(`  semeado: 100 un de ${sku} na OP ${OP_A}.`);

    // Fotografia do físico ANTES — a régua diz que o razão de WIP não pode tocar nisso.
    const fisicoAntes = await pool.query(`SELECT (SELECT count(*)::int FROM stock) s, (SELECT count(*)::int FROM stock_ledger) sl`);

    // ── [GUARD] o guard de integridade central ───────────────────────────────
    console.log('\n[GUARD] a árvore nunca mistura OP');
    const antesGuard = await pool.query(`SELECT count(*)::int n FROM op_material_events`);
    const gx = await call('POST', '/op-materials/consume', {
      token: adminToken, idem: `smk-assembly-guard-${Date.now()}`,
      body: { clientServiceId: opB, productId: produtoId, qty: 1, machineId: maquinaA },
    });
    check(gx.status === 400, 'máquina da OP-A + consumo na OP-B → 400', `HTTP ${gx.status}`);
    check(typeof gx.data?.error === 'string' && gx.data.error.includes(opA) && gx.data.error.includes(opB),
      'mensagem cita as DUAS OPs', String(gx.data?.error).slice(0, 90) + '…');
    const depoisGuard = await pool.query(`SELECT count(*)::int n FROM op_material_events`);
    check(antesGuard.rows[0].n === depoisGuard.rows[0].n, 'NADA gravado no razão (conferido por SQL)', `${antesGuard.rows[0].n} → ${depoisGuard.rows[0].n}`);

    // ── [ETIQUETA] consumo etiquetado + árvore derivada ──────────────────────
    console.log('\n[ETIQUETA] consumo com machineId e a árvore da máquina');
    const idemTag = `smk-assembly-tag-${Date.now()}`;
    const c1 = await call('POST', '/op-materials/consume', {
      token: adminToken, idem: idemTag,
      body: { clientServiceId: opA, productId: produtoId, qty: 7, machineId: maquinaA },
    });
    check(c1.status === 201, 'consume com machineId → 201', `HTTP ${c1.status}`);
    check(String(c1.data?.evento?.machine_id) === String(maquinaA), 'evento gravado COM machine_id', String(c1.data?.evento?.machine_id).slice(0, 8) + '…');
    if (c1.data?.evento?.id) eventosCriados.push(c1.data.evento.id);

    const det = await call('GET', `/assembly-machines/${maquinaA}`, { token: adminToken });
    check(det.status === 200, 'GET /:id → 200', `HTTP ${det.status}`);
    check(Array.isArray(det.data?.arvore) && det.data.arvore.length === 1, 'árvore com 1 material', `${det.data?.arvore?.length} linha(s)`);
    check(det.data?.arvore?.[0]?.sku === sku && num(det.data.arvore[0].qty) === 7, 'árvore traz SKU e qty certos', `${det.data?.arvore?.[0]?.sku} = ${det.data?.arvore?.[0]?.qty}`);
    check(det.data?.op_code === OP_A, 'detalhe traz o op_code da dona', String(det.data?.op_code));

    // Consumo SEM etiqueta: continua válido e NÃO entra na árvore.
    const idemSem = `smk-assembly-sem-${Date.now()}`;
    const c2 = await call('POST', '/op-materials/consume', {
      token: adminToken, idem: idemSem,
      body: { clientServiceId: opA, productId: produtoId, qty: 3 },
    });
    check(c2.status === 201, 'consume SEM machineId → 201 (retrocompatível)', `HTTP ${c2.status}`);
    check(c2.data?.evento?.machine_id === null, 'evento sem etiqueta tem machine_id NULL', String(c2.data?.evento?.machine_id));
    if (c2.data?.evento?.id) eventosCriados.push(c2.data.evento.id);

    const det2 = await call('GET', `/assembly-machines/${maquinaA}`, { token: adminToken });
    check(num(det2.data?.arvore?.[0]?.qty) === 7, 'árvore SEGUE 7 (consumo sem etiqueta fica fora)', `${det2.data?.arvore?.[0]?.qty}`);

    // ── [IDEM] replay não duplica ────────────────────────────────────────────
    console.log('\n[IDEM] replay do mesmo X-Idempotency-Key');
    const c1r = await call('POST', '/op-materials/consume', {
      token: adminToken, idem: idemTag,
      body: { clientServiceId: opA, productId: produtoId, qty: 7, machineId: maquinaA },
    });
    check(c1r.status === 201 && c1r.data?.idempotent === true, 'replay → idempotent:true', `HTTP ${c1r.status}, idempotent=${c1r.data?.idempotent}`);
    check(String(c1r.data?.evento?.id) === String(c1.data?.evento?.id), 'replay devolve o MESMO evento', String(c1r.data?.evento?.id).slice(0, 8) + '…');
    const nEventos = await pool.query(`SELECT count(*)::int n FROM op_material_events WHERE op_key = $1`, [`opmat:cons:${idemTag}`]);
    check(nEventos.rows[0].n === 1, 'razão tem 1 evento só pra essa chave', `${nEventos.rows[0].n}`);

    // ── [RÉGUA] a etiqueta é invisível pro saldo ─────────────────────────────
    console.log('\n[RÉGUA] machine_id não participa do saldo');
    const bal = await call('GET', `/op-materials/balance/${opA}`, { token: adminToken });
    const linha = (bal.data || []).find((r: any) => String(r.product_id ?? r.id) === String(produtoId) || r.sku === sku);
    check(bal.status === 200 && !!linha, 'GET /balance da OP responde', `HTTP ${bal.status}`);
    check(num(linha?.recebido) === 100 && num(linha?.consumido) === 10 && num(linha?.saldo) === 90,
      'projeção: 100 recebido − 10 consumido (7 etiquetado + 3 sem) = 90',
      `recebido=${linha?.recebido} consumido=${linha?.consumido} saldo=${linha?.saldo}`);
    const fisicoDepois = await pool.query(`SELECT (SELECT count(*)::int FROM stock) s, (SELECT count(*)::int FROM stock_ledger) sl`);
    check(fisicoAntes.rows[0].s === fisicoDepois.rows[0].s && fisicoAntes.rows[0].sl === fisicoDepois.rows[0].sl,
      'stock e stock_ledger SEM nenhuma linha nova (razão de WIP não toca o físico)',
      `stock ${fisicoAntes.rows[0].s}→${fisicoDepois.rows[0].s}, ledger ${fisicoAntes.rows[0].sl}→${fisicoDepois.rows[0].sl}`);
    const semOpId = await pool.query(`SELECT count(*)::int n FROM stock WHERE op_id IS NOT NULL`);
    check(semOpId.rows[0].n === 0, 'stock segue 100% pooled (op_id NULL) — invariante intacto', `${semOpId.rows[0].n} linha(s) com op_id`);

    // ── [PARADA] estado, não bloqueio ────────────────────────────────────────
    console.log('\n[PARADA] parar, retomar e o 400 da v2');
    const p1 = await call('PUT', `/assembly-machines/${maquinaA}/status`, { token: adminToken, body: { status: 'parada' } });
    check(p1.status === 400, 'parada sem motivo → 400', `HTTP ${p1.status}: ${p1.data?.error}`);
    const p2 = await call('PUT', `/assembly-machines/${maquinaA}/status`, { token: adminToken, body: { status: 'parada', reason: 'Falta motoredutor', sector: 'Almoxarifado' } });
    check(p2.status === 400, 'setor fora da allowlist → 400', `HTTP ${p2.status}: ${p2.data?.error}`);
    const p3 = await call('PUT', `/assembly-machines/${maquinaA}/status`, { token: adminToken, body: { status: 'parada', reason: 'Falta motoredutor 1cv', sector: 'Compras' } });
    check(p3.status === 200, 'parada com motivo + setor → 200', `HTTP ${p3.status}`);
    const dbPar = await pool.query(`SELECT status, stopped_reason, stopped_sector, stopped_at FROM assembly_machines WHERE id = $1`, [maquinaA]);
    check(dbPar.rows[0].status === 'parada' && dbPar.rows[0].stopped_reason === 'Falta motoredutor 1cv' && dbPar.rows[0].stopped_sector === 'Compras' && dbPar.rows[0].stopped_at !== null,
      'stopped_* setados no banco', `${dbPar.rows[0].status} · ${dbPar.rows[0].stopped_sector}`);

    // A régua da v1: parada é sinalização, NÃO trava material.
    const idemParada = `smk-assembly-parada-${Date.now()}`;
    const cP = await call('POST', '/op-materials/consume', {
      token: adminToken, idem: idemParada,
      body: { clientServiceId: opA, productId: produtoId, qty: 1, machineId: maquinaA },
    });
    check(cP.status === 201, 'máquina PARADA ainda aceita consumo (v1: sinalização, não bloqueio)', `HTTP ${cP.status}`);
    if (cP.data?.evento?.id) eventosCriados.push(cP.data.evento.id);

    const p4 = await call('PUT', `/assembly-machines/${maquinaA}/status`, { token: adminToken, body: { status: 'andamento' } });
    check(p4.status === 200, 'retomar → 200', `HTTP ${p4.status}`);
    const dbRet = await pool.query(`SELECT status, stopped_reason, stopped_sector, stopped_at FROM assembly_machines WHERE id = $1`, [maquinaA]);
    check(dbRet.rows[0].status === 'andamento' && dbRet.rows[0].stopped_reason === null && dbRet.rows[0].stopped_sector === null && dbRet.rows[0].stopped_at === null,
      'retomar LIMPA stopped_*', `${dbRet.rows[0].status}, reason=${dbRet.rows[0].stopped_reason}`);
    const p5 = await call('PUT', `/assembly-machines/${maquinaA}/status`, { token: adminToken, body: { status: 'concluida' } });
    check(p5.status === 400 && String(p5.data?.error).includes('v2'), "→ 'concluida' → 400 com a mensagem da v2", `HTTP ${p5.status}: ${p5.data?.error}`);

    // ── [EDIÇÃO] parcial + auditoria por NOMES ───────────────────────────────
    console.log('\n[EDIÇÃO] PUT parcial');
    const e1 = await call('PUT', `/assembly-machines/${maquinaA}`, { token: adminToken, body: { responsible: 'Novo Responsável' } });
    check(e1.status === 200 && Array.isArray(e1.data?.alterados) && e1.data.alterados.join() === 'responsible',
      'PUT parcial → 200 com os NOMES dos campos alterados', JSON.stringify(e1.data?.alterados));
    const e2 = await call('PUT', `/assembly-machines/${maquinaA}`, { token: adminToken, body: {} });
    check(e2.status === 400, 'PUT vazio → 400', `HTTP ${e2.status}`);

    // ── [GRADE] filtros e agregado ───────────────────────────────────────────
    console.log('\n[GRADE] GET com filtro e agregado');
    const l1 = await call('GET', '/assembly-machines', { token: adminToken });
    check(l1.status === 200 && Array.isArray(l1.data?.machines), 'GET / → 200 com envelope {machines,total}', `total=${l1.data?.total}`);
    const minha = (l1.data.machines || []).find((m: any) => m.id === maquinaA);
    check(!!minha && minha.eventos_consumo === 2, 'agregado eventos_consumo por máquina (2 etiquetados)', `${minha?.eventos_consumo}`);
    const l2 = await call('GET', '/assembly-machines?status=xpto', { token: adminToken });
    check(l2.status === 400, '?status inválido → 400', `HTTP ${l2.status}`);

    // ── [AUDITORIA] as 4 actions e a AUSÊNCIA no consume ─────────────────────
    console.log('\n[AUDITORIA] actions da máquina no livro (e o razão sem log)');
    const acts = await pool.query(
      `SELECT action, count(*)::int n FROM audit_logs WHERE details->>'id' = $1 GROUP BY action ORDER BY action`,
      [maquinaA],
    );
    const mapa = new Map(acts.rows.map((r: any) => [r.action, r.n]));
    check(mapa.get('CRIAR_MAQUINA') === 1, '1× CRIAR_MAQUINA', String(mapa.get('CRIAR_MAQUINA')));
    check(mapa.get('PARAR_MAQUINA') === 1, '1× PARAR_MAQUINA', String(mapa.get('PARAR_MAQUINA')));
    check(mapa.get('RETOMAR_MAQUINA') === 1, '1× RETOMAR_MAQUINA', String(mapa.get('RETOMAR_MAQUINA')));
    check(mapa.get('EDITAR_MAQUINA') === 1, '1× EDITAR_MAQUINA', String(mapa.get('EDITAR_MAQUINA')));
    const semLogConsumo = await pool.query(
      `SELECT count(*)::int n FROM audit_logs WHERE action ILIKE '%CONSUM%' AND created_at >= now() - interval '10 minutes'`,
    );
    check(semLogConsumo.rows[0].n === 0, 'consume SEGUE sem createLog (o razão é o próprio livro)', `${semLogConsumo.rows[0].n} log(s) de consumo`);
  } finally {
    // Cleanup cirúrgico na ordem das FKs: eventos (apontam pra máquina) -> máquinas.
    try {
      if (eventosCriados.length > 0) {
        await pool.query('DELETE FROM op_material_events WHERE id = ANY($1::uuid[])', [eventosCriados]);
      }
      if (maquinasCriadas.length > 0) {
        await pool.query('DELETE FROM assembly_machines WHERE id = ANY($1::uuid[])', [maquinasCriadas]);
      }
      if (permConcedida && id005) {
        await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'montagem'`, [id005]);
        console.log('  cleanup: chave montagem do 005 removida (rede de segurança).');
      }
      const sobra = await pool.query(`SELECT (SELECT count(*)::int FROM op_material_events) e, (SELECT count(*)::int FROM assembly_machines) m`);
      console.log(`  cleanup cirúrgico: ${eventosCriados.length} evento(s) e ${maquinasCriadas.length} máquina(s) removidos. Restam op_material_events=${sobra.rows[0].e}, assembly_machines=${sobra.rows[0].m}.`);
    } finally {
      await pool.end();
      if (servidor) {
        await matarArvore(servidor.child);
        console.log('  servidor efêmero derrubado (árvore).');
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_assembly FALHOU em ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_assembly PASSOU — gate da chave, bordas, etiqueta com árvore derivada, guard de OP cruzada, idempotência intacta, saldo e físico inalterados pela etiqueta, parada como estado e auditoria conferidos; cleanup cirúrgico aplicado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_assembly EXPLODIU:', err?.message ?? err);
  process.exit(1);
});
