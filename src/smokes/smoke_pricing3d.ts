// src/smokes/smoke_pricing3d.ts — smoke da expansão 3D (migration 017): Registro de Valores
// (impressoras + manutenções) e Precificação de peça.
//
// COMO RODA: `npm run smoke:pricing3d` — sobe o PRÓPRIO servidor numa porta pedida ao SO, espera
// o /health e mata a ÁRVORE no fim (template ratificado). Roda src/server.ts via ts-node pra
// nunca testar dist velho. Com SMOKE_BASE_URL definido não sobe nada e mira o alvo dado.
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO: impressoras/manutenções por id; a FICHA da peça de teste é fotografada
//   antes e RESTAURADA no finally (a peça é do seed, não pode ficar com os números do smoke); as
//   duas settings voltam ao valor original; a chave concedida ao 005 é o par exato.
//
// ═══ A PROVA CENTRAL: O CASO CANÔNICO, CALCULADO NO PAPEL ═══
//   peça 100 g / 90 min · filamento R$ 89,00/kg · impressora 300 W · tarifa R$ 0,95/kWh
//     custo_material = (100 / 1000) × 89,00                    = 8,90
//     custo_energia  = (90 / 60) × (300 / 1000) × 0,95
//                    = 1,5 h × 0,3 kW × 0,95                   = 0,4275
//     custo_total    = 8,90 + 0,4275                           = 9,3275
//     margem 40%  →  preco_venda = 9,3275 × 1,40               = 13,0585
//     gravado em sales_price (numeric(10,2), ROUND a 2)        = 13,06
//   O smoke assere CADA UM desses números. A conta roda em `numeric` no Postgres (decimal
//   exato), mas a comparação aqui é em float do JS — por isso a tolerância de 1e-9 (documentada):
//   ela cobre a conversão string→Number, não erro de cálculo.
//
// COBERTURA: gate da chave nova (incluindo o PUT /parts/:id, cujo furo a 017 fechou), bordas do
// cadastro de impressora e manutenção, DELETE com manutenção → 409, status livre, pricing sem
// tarifa (null + alerta) → com tarifa, o caso canônico centavo a centavo, aplicar_preco
// recalculando no servidor, peça sem filamento vinculado, a contagem DERIVADA de impressas
// (produção real criada e apagada) e as actions novas na auditoria.

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';

const SENHA_SEED = 'Teste@123';
const SKU_PECA = '3D-0001';      // peça do caso canônico
const SKU_PECA_SEM_FIL = '3D-0002'; // peça que fica SEM filamento vinculado (estado honesto)
const SKU_FILAMENTO = 'BOB-4001';   // PLA R$ 89,00/kg (is_filament ligado pela 017)
const WATTS = 300;
const TARIFA = '0.95';
const GRAMAS = 100;
const MINUTOS = 90;
const MARGEM = 40;
// Esperados do papel (ver cabeçalho).
const ESP_MATERIAL = 8.9, ESP_ENERGIA = 0.4275, ESP_TOTAL = 9.3275, ESP_VENDA = 13.0585, ESP_GRAVADO = 13.06;
const EPS = 1e-9;

let BASE = process.env.SMOKE_BASE_URL ?? '';
const failures: string[] = [];
function check(cond: boolean, desc: string, got: string): void {
  if (cond) console.log(`  ✔ ${desc}  (${got})`);
  else { console.error(`  ✘ ${desc}  (obtido: ${got})`); failures.push(desc); }
}
const perto = (a: any, b: number) => typeof a === 'number' && Math.abs(a - b) < EPS;

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
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const guarda = (b: Buffer) => { linhas.push(b.toString()); if (linhas.length > 80) linhas.shift(); };
  child.stdout?.on('data', guarda); child.stderr?.on('data', guarda);
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
    if (child.exitCode !== null) throw new Error(`o servidor morreu antes do /health (exit ${child.exitCode}).\n--- log ---\n${log()}`);
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* subindo */ }
    await sleep(500);
  }
  throw new Error(`timeout esperando /health em ${BASE}.\n--- log ---\n${log()}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function call(method: string, path: string, opts: { token?: string; body?: object } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let data: any = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, data };
}
async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login de ${email} falhou: HTTP ${res.status}`);
  return res.data;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const impressorasCriadas: string[] = [];
  let permConcedida = false;
  let id005 = '';
  let fichaOriginal: any = null;   // foto da peça do caso canônico
  let pecaId = '';

  try {
    if (BASE) {
      console.log('▶ smoke_pricing3d — host de validação OK (ep-summer-wave); SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('▶ smoke_pricing3d — host de validação OK (ep-summer-wave); subindo servidor efêmero em', BASE);
      servidor = subirServidor(porta);
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto (/health respondeu).');
    }

    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    id005 = setor.user.id;

    // Alvos do seed + FOTO da ficha (restaurada no finally).
    const alvos = await pool.query(
      `SELECT id, sku, filament_grams, production_minutes, margin_percent, filament_product_id, sales_price
         FROM products WHERE sku = ANY($1)`, [[SKU_PECA, SKU_PECA_SEM_FIL, SKU_FILAMENTO]]);
    const peca = alvos.rows.find((r: any) => r.sku === SKU_PECA);
    const pecaSemFil = alvos.rows.find((r: any) => r.sku === SKU_PECA_SEM_FIL);
    const filamento = alvos.rows.find((r: any) => r.sku === SKU_FILAMENTO);
    if (!peca || !pecaSemFil || !filamento) throw new Error(`seed sem os SKUs do smoke (${SKU_PECA}/${SKU_PECA_SEM_FIL}/${SKU_FILAMENTO}) — abortando.`);
    pecaId = peca.id;
    fichaOriginal = { ...peca };
    const fichaOriginalSemFil = { ...pecaSemFil };
    const settingsOriginais = (await pool.query(`SELECT key, value FROM settings WHERE key IN ('energia_kwh_brl','impressora_padrao_3d')`)).rows;

    // ── [GATE] a chave nova, e o furo que ela fecha ──────────────────────────
    console.log('\n[GATE] producao_3d — a chave que existia e não gateava nada');
    const g1 = await call('GET', '/printers-3d', { token: setorToken });
    check(g1.status === 403, '005 sem a chave: GET /printers-3d → 403', `HTTP ${g1.status}`);
    const g2 = await call('GET', '/producao-3d/pricing', { token: setorToken });
    check(g2.status === 403, '005 sem a chave: GET /producao-3d/pricing → 403', `HTTP ${g2.status}`);
    // A PROVA DO FURO FECHADO: antes da 017 esta rota aceitava qualquer logado.
    const g3 = await call('PUT', `/producao-3d/parts/${pecaId}`, { token: setorToken, body: { productionMinutes: 1, filamentGrams: 1 } });
    check(g3.status === 403, '005 editando a FICHA técnica → 403 (furo da 017 fechado)', `HTTP ${g3.status}`);
    const g4 = await call('PUT', `/producao-3d/parts/${pecaId}/pricing`, { token: setorToken, body: { margin_percent: 10 } });
    check(g4.status === 403, '005 no PUT /parts/:id/pricing → 403', `HTTP ${g4.status}`);

    const jaTinha = await pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1 AND page_key = 'producao_3d'`, [id005]);
    if (jaTinha.rows.length > 0) throw new Error("005 já tem 'producao_3d' — estado inesperado do seed, abortando.");
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'producao_3d')`, [id005]);
    permConcedida = true;
    const g5 = await call('GET', '/printers-3d', { token: setorToken });
    check(g5.status === 200, '005 COM a chave → 200 (sem novo login)', `HTTP ${g5.status}`);
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'producao_3d'`, [id005]);
    permConcedida = false;
    const g6 = await call('GET', '/printers-3d', { token: setorToken });
    check(g6.status === 403, 'chave revogada → 403 de volta', `HTTP ${g6.status}`);

    // ── [IMPRESSORA] bordas, CRUD, status livre, manutenção e o 409 ──────────
    console.log('\n[IMPRESSORA] cadastro, status e manutenções');
    const b1 = await call('POST', '/printers-3d', { token: adminToken, body: { name: '  ', power_watts: WATTS } });
    check(b1.status === 400, 'name vazio → 400', `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/printers-3d', { token: adminToken, body: { name: 'X', power_watts: 0 } });
    check(b2.status === 400, 'power_watts 0 → 400 (zeraria a energia em silêncio)', `HTTP ${b2.status}`);
    const b3 = await call('POST', '/printers-3d', { token: adminToken, body: { name: 'X', power_watts: 12.5 } });
    check(b3.status === 400, 'power_watts não-inteiro → 400', `HTTP ${b3.status}`);

    const nova = await call('POST', '/printers-3d', { token: adminToken, body: { name: 'SMOKE Impressora Canônica', model: 'Ender-3', power_watts: WATTS, notes: 'criada pelo smoke' } });
    check(nova.status === 201 && !!nova.data?.id, 'impressora válida → 201', `HTTP ${nova.status}`);
    check(Number.isInteger(nova.data?.display_no), 'display_no do banco (IDENTITY)', `IMP-${nova.data?.display_no}`);
    const impressoraId = nova.data.id;
    impressorasCriadas.push(impressoraId);

    const st1 = await call('PUT', `/printers-3d/${impressoraId}/status`, { token: adminToken, body: { status: 'manutencao' } });
    const st2 = await call('PUT', `/printers-3d/${impressoraId}/status`, { token: adminToken, body: { status: 'ativa' } });
    check(st1.status === 200 && st2.status === 200, 'status vai e volta (cadastro, não máquina de estados)', `${st1.status}/${st2.status}`);
    const st3 = await call('PUT', `/printers-3d/${impressoraId}/status`, { token: adminToken, body: { status: 'quebrada' } });
    check(st3.status === 400, 'status fora do CHECK → 400', `HTTP ${st3.status}`);

    const m1 = await call('POST', `/printers-3d/${impressoraId}/maintenances`, { token: adminToken, body: { date: '31-07-2026', description: 'x' } });
    check(m1.status === 400, 'data fora do formato AAAA-MM-DD → 400', `HTTP ${m1.status}`);
    const m2 = await call('POST', `/printers-3d/${impressoraId}/maintenances`, { token: adminToken, body: { date: '2026-07-31', description: '  ' } });
    check(m2.status === 400, 'descrição vazia → 400', `HTTP ${m2.status}`);
    const m3 = await call('POST', `/printers-3d/${impressoraId}/maintenances`, { token: adminToken, body: { date: '2026-07-31', description: 'Troca de bico', cost: -5 } });
    check(m3.status === 400, 'custo negativo → 400', `HTTP ${m3.status}`);
    const manut = await call('POST', `/printers-3d/${impressoraId}/maintenances`, { token: adminToken, body: { date: '2026-07-31', description: 'Troca de bico 0.4mm', cost: 45.9 } });
    check(manut.status === 201, 'manutenção válida → 201', `HTTP ${manut.status}`);

    const del409 = await call('DELETE', `/printers-3d/${impressoraId}`, { token: adminToken });
    check(del409.status === 409 && String(del409.data?.error).includes('inativa'),
      'DELETE com manutenção → 409 orientando "inativa" (o histórico não morre junto)', `HTTP ${del409.status}`);

    const det = await call('GET', `/printers-3d/${impressoraId}`, { token: adminToken });
    check(det.status === 200 && det.data?.manutencoes?.length === 1, 'detalhe traz o extrato de manutenções', `${det.data?.manutencoes?.length} registro(s)`);
    const lista = await call('GET', '/printers-3d', { token: adminToken });
    const minha = (lista.data?.printers || []).find((p: any) => p.id === impressoraId);
    check(minha?.manutencoes === 1 && perto(Number(minha?.custo_manutencoes), 45.9), 'agregado da grade (1 manutenção, R$ 45,90)', `${minha?.manutencoes} · ${minha?.custo_manutencoes}`);

    // ── [SEM TARIFA] o estado honesto ────────────────────────────────────────
    console.log('\n[SEM TARIFA] null + alerta, nunca "energia de graça"');
    await pool.query(`UPDATE settings SET value = '0' WHERE key = 'energia_kwh_brl'`);
    await pool.query(`UPDATE settings SET value = '' WHERE key = 'impressora_padrao_3d'`);
    const p0 = await call('GET', '/producao-3d/pricing', { token: adminToken });
    check(p0.status === 200 && p0.data?.tarifa_configurada === false, 'tarifa_configurada = false', String(p0.data?.tarifa_configurada));
    check(p0.data?.impressora_configurada === false, 'impressora_configurada = false', String(p0.data?.impressora_configurada));
    const linha0 = (p0.data?.pecas || []).find((x: any) => x.sku === SKU_PECA);
    check(linha0?.custo?.energia === null && linha0?.custo?.total === null, 'custo_energia e custo_total NULL (não zero)', JSON.stringify(linha0?.custo));
    check(Array.isArray(linha0?.alertas) && linha0.alertas.includes('SEM_TARIFA') && linha0.alertas.includes('SEM_IMPRESSORA'),
      'alertas dizem o que falta', JSON.stringify(linha0?.alertas));

    // ── [CASO CANÔNICO] o cálculo, centavo a centavo ─────────────────────────
    console.log('\n[CANÔNICO] 100g · 90min · R$ 89,00/kg · 300W · R$ 0,95/kWh · margem 40%');
    const cfg1 = await call('PUT', '/admin/settings', { token: adminToken, body: { key: 'energia_kwh_brl', value: TARIFA } });
    const cfg2 = await call('PUT', '/admin/settings', { token: adminToken, body: { key: 'impressora_padrao_3d', value: impressoraId } });
    check(cfg1.status === 200 && cfg2.status === 200, 'tarifa e impressora configuradas via PUT /admin/settings', `${cfg1.status}/${cfg2.status}`);

    const ficha = await call('PUT', `/producao-3d/parts/${pecaId}/pricing`, {
      token: adminToken,
      body: { filament_grams: GRAMAS, production_minutes: MINUTOS, filament_product_id: filamento.id, margin_percent: MARGEM },
    });
    check(ficha.status === 200, 'ficha técnica gravada (gramas, minutos, filamento, margem)', `HTTP ${ficha.status}: ${JSON.stringify(ficha.data?.alterados)}`);

    // Vínculo só aceita bobina: apontar pra uma peça comum tem de doer.
    const ruim = await call('PUT', `/producao-3d/parts/${pecaId}/pricing`, { token: adminToken, body: { filament_product_id: pecaSemFil.id } });
    check(ruim.status === 400 && String(ruim.data?.error).includes('filamento'), 'vínculo com produto que não é bobina → 400', `HTTP ${ruim.status}`);

    const pr = await call('GET', '/producao-3d/pricing', { token: adminToken });
    const L = (pr.data?.pecas || []).find((x: any) => x.sku === SKU_PECA);
    check(pr.data?.tarifa_configurada === true && perto(pr.data?.tarifa_kwh, 0.95), 'tarifa no envelope = 0,95', String(pr.data?.tarifa_kwh));
    check(pr.data?.impressora?.power_watts === WATTS, 'impressora de referência no envelope (300 W)', `${pr.data?.impressora?.power_watts} W`);
    check(perto(L?.custo?.material, ESP_MATERIAL), `custo_material = ${ESP_MATERIAL} — (100/1000) × 89,00`, String(L?.custo?.material));
    check(perto(L?.custo?.energia, ESP_ENERGIA), `custo_energia = ${ESP_ENERGIA} — 1,5 h × 0,3 kW × 0,95`, String(L?.custo?.energia));
    check(perto(L?.custo?.total, ESP_TOTAL), `custo_total = ${ESP_TOTAL}`, String(L?.custo?.total));
    check(perto(L?.preco_venda, ESP_VENDA), `preco_venda = ${ESP_VENDA} — total × 1,40`, String(L?.preco_venda));
    check(perto(L?.preco_venda_arredondado, ESP_GRAVADO), `preco_venda_arredondado = ${ESP_GRAVADO} (o que vai pro sales_price)`, String(L?.preco_venda_arredondado));
    check(L?.filament?.sku === SKU_FILAMENTO && perto(L?.filament?.preco_kg, 89), 'filamento vinculado com preço/kg do próprio produto', `${L?.filament?.sku} R$ ${L?.filament?.preco_kg}`);
    // A lista de bobinas viaja no envelope: é a fonte do dropdown de vínculo e da seção
    // Filamentos (o GET /products não devolve a flag is_filament).
    const bobinas = pr.data?.filamentos || [];
    check(bobinas.length >= 2 && bobinas.some((b: any) => b.sku === SKU_FILAMENTO) && perto(bobinas.find((b: any) => b.sku === SKU_FILAMENTO)?.preco_kg, 89),
      'envelope traz a lista de filamentos com preço/kg', `${bobinas.length}: ${bobinas.map((b: any) => b.sku).join(', ')}`);

    // aplicar_preco: RECALCULA no servidor e grava — nunca aceita preço do body.
    const aplicar = await call('PUT', `/producao-3d/parts/${pecaId}/pricing`, { token: adminToken, body: { aplicar_preco: true, preco_venda: 999.99 } });
    check(aplicar.status === 200 && perto(aplicar.data?.preco_aplicado, ESP_GRAVADO), `aplicar_preco grava ${ESP_GRAVADO} (ignorou os 999,99 do body)`, String(aplicar.data?.preco_aplicado));
    const noBanco = await pool.query('SELECT sales_price::float8 AS sp FROM products WHERE id = $1', [pecaId]);
    check(perto(noBanco.rows[0].sp, ESP_GRAVADO), `sales_price no banco = ${ESP_GRAVADO}`, String(noBanco.rows[0].sp));

    // ── [SEM FILAMENTO] a outra metade do estado honesto ─────────────────────
    console.log('\n[SEM FILAMENTO] peça sem vínculo');
    await pool.query('UPDATE products SET filament_product_id = NULL WHERE id = $1', [pecaSemFil.id]);
    const pr2 = await call('GET', '/producao-3d/pricing', { token: adminToken });
    const L2 = (pr2.data?.pecas || []).find((x: any) => x.sku === SKU_PECA_SEM_FIL);
    check(L2?.custo?.material === null && L2?.custo?.total === null, 'custo_material e total NULL sem bobina vinculada', JSON.stringify(L2?.custo));
    check(Array.isArray(L2?.alertas) && L2.alertas.includes('SEM_FILAMENTO'), 'alerta SEM_FILAMENTO', JSON.stringify(L2?.alertas));
    const aplicar2 = await call('PUT', `/producao-3d/parts/${pecaSemFil.id}/pricing`, { token: adminToken, body: { aplicar_preco: true } });
    check(aplicar2.status === 400, 'aplicar_preco com custo incompleto → 400 (não inventa preço)', `HTTP ${aplicar2.status}`);

    // ── [DERIVADA] impressas sai de productions_3d, não de contador ──────────
    console.log('\n[DERIVADA] impressas e média real');
    const saldoAntes = await pool.query(
      `SELECT COALESCE(SUM(quantity_on_hand), 0)::float8 AS q FROM stock WHERE product_id = $1 AND op_id IS NULL`, [pecaId]);
    const prod = await call('POST', '/producao-3d/productions', {
      token: adminToken,
      body: { partId: pecaId, quantity: 2, totalMinutes: 200, filamentGrams: 224, date: new Date().toISOString() },
    });
    check(prod.status === 201, 'produção real registrada (credita estoque pelo StockService)', `HTTP ${prod.status}`);
    const prodId = prod.data?.id;

    const pr3 = await call('GET', '/producao-3d/pricing', { token: adminToken });
    const L3 = (pr3.data?.pecas || []).find((x: any) => x.sku === SKU_PECA);
    check(L3?.impressas === 2, 'impressas = 2 (DERIVADA de productions_3d)', String(L3?.impressas));
    check(L3?.media_real?.producoes === 1 && perto(Number(L3?.media_real?.gramas), 112), 'média real por unidade = 112 g (diagnóstico ao lado da ficha)', JSON.stringify(L3?.media_real));
    check(perto(L3?.custo?.material, ESP_MATERIAL), 'o custo NÃO mudou: a ficha manda, o histórico só informa', String(L3?.custo?.material));

    if (prodId) await call('DELETE', `/producao-3d/productions/${prodId}`, { token: adminToken });
    const pr4 = await call('GET', '/producao-3d/pricing', { token: adminToken });
    const L4 = (pr4.data?.pecas || []).find((x: any) => x.sku === SKU_PECA);
    check(L4?.impressas === 0 && L4?.media_real === null, 'apagou a produção → impressas volta a 0 e média some (derivação viva)', `${L4?.impressas} · ${L4?.media_real}`);
    const saldoDepois = await pool.query(
      `SELECT COALESCE(SUM(quantity_on_hand), 0)::float8 AS q FROM stock WHERE product_id = $1 AND op_id IS NULL`, [pecaId]);
    check(perto(saldoDepois.rows[0].q, saldoAntes.rows[0].q), 'saldo físico da peça voltou ao original (reverseReceive fez o inverso)', `${saldoAntes.rows[0].q} → ${saldoDepois.rows[0].q}`);

    // ── [PAGINAÇÃO] página, total, busca e as bordas ─────────────────────────
    // Roda ANTES do bloco [ÓRFÃ] de propósito: lá a impressora de referência é excluída e a
    // energia vira NULL, o que apagaria o caso canônico que este bloco usa como âncora.
    console.log('\n[PAGINAÇÃO] limit/offset/q com total do universo filtrado');
    const universo = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM products WHERE is_3d = true AND active = true`)).rows[0].n;

    const p1 = await call('GET', '/producao-3d/pricing?limit=2', { token: adminToken });
    check(p1.status === 200 && (p1.data?.pecas || []).length === 2, 'limit=2 devolve 2 peças', String((p1.data?.pecas || []).length));
    check(p1.data?.total === universo, `total = ${universo} (universo, não o tamanho da página)`, String(p1.data?.total));
    check(p1.data?.limit === 2 && p1.data?.offset === 0, 'envelope devolve limit e offset efetivos', `limit=${p1.data?.limit} offset=${p1.data?.offset}`);

    // Página 2 não repete nem pula ninguém: com ORDER BY name, id o corte é estável.
    const p2 = await call('GET', '/producao-3d/pricing?limit=2&offset=2', { token: adminToken });
    const ids1 = (p1.data?.pecas || []).map((x: any) => x.id);
    const ids2 = (p2.data?.pecas || []).map((x: any) => x.id);
    check(ids2.length === 2 && ids1.every((id: string) => !ids2.includes(id)), 'offset=2 traz outras 2 peças (sem repetir a página 1)', `${ids1.length}+${ids2.length} sem interseção`);
    const nomes = [...(p1.data?.pecas || []), ...(p2.data?.pecas || [])].map((x: any) => x.name);
    check(nomes.join('|') === [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR')).join('|'), 'ordenação name ASC atravessa as páginas', nomes.join(' < '));

    // Offset além do fim: lista vazia, mas o total continua dizendo onde voltar.
    const pFim = await call('GET', `/producao-3d/pricing?limit=5&offset=${universo + 50}`, { token: adminToken });
    check(pFim.status === 200 && (pFim.data?.pecas || []).length === 0, 'offset além do fim → pecas: []', String((pFim.data?.pecas || []).length));
    check(pFim.data?.total === universo, 'total INTACTO na página vazia (é ele que traz o front de volta)', String(pFim.data?.total));

    // Busca: por SKU parcial e por pedaço do nome — as duas no mesmo ?q=.
    const alvo = (await pool.query('SELECT sku, name FROM products WHERE id = $1', [pecaId])).rows[0];
    const pedacoSku = String(alvo.sku).slice(-3);          // '001' de '3D-0001'
    const pedacoNome = String(alvo.name).split(' ')[0];     // 'Engrenagem'
    const qSku = await call(`GET`, `/producao-3d/pricing?q=${encodeURIComponent(pedacoSku)}`, { token: adminToken });
    check(qSku.status === 200 && (qSku.data?.pecas || []).some((x: any) => x.sku === alvo.sku), `q por SKU parcial ('${pedacoSku}') acha a peça`, `${qSku.data?.total} resultado(s)`);
    check(qSku.data?.total === (qSku.data?.pecas || []).length && qSku.data.total < universo, 'total da busca obedece ao filtro (menor que o universo)', `${qSku.data?.total} de ${universo}`);
    const qNome = await call('GET', `/producao-3d/pricing?q=${encodeURIComponent(pedacoNome)}`, { token: adminToken });
    check(qNome.status === 200 && (qNome.data?.pecas || []).some((x: any) => x.sku === alvo.sku), `q por pedaço do NOME ('${pedacoNome}') acha a mesma peça`, `${qNome.data?.total} resultado(s)`);
    const qNada = await call('GET', '/producao-3d/pricing?q=zzz-nao-existe-zzz', { token: adminToken });
    check(qNada.status === 200 && (qNada.data?.pecas || []).length === 0 && qNada.data?.total === 0, 'busca sem resultado → lista vazia e total 0 (não é erro)', `total=${qNada.data?.total}`);
    const qVazio = await call('GET', '/producao-3d/pricing?q=%20%20', { token: adminToken });
    check(qVazio.data?.total === universo, 'q só com espaço = SEM busca (não filtra por string vazia)', String(qVazio.data?.total));

    // O caso canônico continua batendo centavo a centavo dentro da página em que a peça estiver.
    const canonPag = (qSku.data?.pecas || []).find((x: any) => x.sku === SKU_PECA);
    check(perto(canonPag?.custo?.material, ESP_MATERIAL) && perto(canonPag?.custo?.energia, ESP_ENERGIA)
      && perto(canonPag?.custo?.total, ESP_TOTAL) && perto(canonPag?.preco_venda_arredondado, ESP_GRAVADO),
      'caso canônico intacto na página filtrada (8,90 + 0,4275 = 9,3275 → 13,06)', JSON.stringify(canonPag?.custo));
    // A derivada também sobrevive ao corte: o LATERAL agrega DEPOIS do LIMIT, e não antes.
    check(canonPag?.impressas === 0 && canonPag?.media_real === null, 'impressas/media_real corretos na página (agregado roda sobre a página)', `${canonPag?.impressas} · ${canonPag?.media_real}`);

    // Bordas: fora da faixa é 400, NÃO clamp silencioso (mesma política da Auditoria).
    const bordas: Array<[string, string]> = [
      ['limit=200', "limit acima do teto 100 → 400 (não devolve 100 calado)"],
      ['limit=0', 'limit=0 → 400'],
      ['limit=abc', 'limit não-numérico → 400'],
      ['offset=-1', 'offset negativo → 400'],
      ['offset=1.5', 'offset fracionário → 400'],
    ];
    for (const [qs, rotulo] of bordas) {
      const r = await call('GET', `/producao-3d/pricing?${qs}`, { token: adminToken });
      check(r.status === 400, rotulo, `HTTP ${r.status}`);
    }
    const semParam = await call('GET', '/producao-3d/pricing', { token: adminToken });
    check(semParam.data?.limit === 25 && semParam.data?.offset === 0, 'sem parâmetros → default limit=25, offset=0', `limit=${semParam.data?.limit}`);

    // ── [AUDITORIA] as actions novas ─────────────────────────────────────────
    console.log('\n[AUDITORIA] actions da expansão');
    const acts = await pool.query(
      `SELECT action, count(*)::int n FROM audit_logs
        WHERE action IN ('CRIAR_IMPRESSORA','EDITAR_IMPRESSORA','REGISTRAR_MANUTENCAO','EDITAR_FICHA_3D')
          AND created_at >= now() - interval '10 minutes' GROUP BY action ORDER BY action`);
    const mapa = new Map(acts.rows.map((r: any) => [r.action, r.n]));
    check((mapa.get('CRIAR_IMPRESSORA') ?? 0) >= 1, 'CRIAR_IMPRESSORA no livro', String(mapa.get('CRIAR_IMPRESSORA')));
    check((mapa.get('EDITAR_IMPRESSORA') ?? 0) >= 2, 'EDITAR_IMPRESSORA (as duas trocas de status)', String(mapa.get('EDITAR_IMPRESSORA')));
    check((mapa.get('REGISTRAR_MANUTENCAO') ?? 0) >= 1, 'REGISTRAR_MANUTENCAO no livro', String(mapa.get('REGISTRAR_MANUTENCAO')));
    check((mapa.get('EDITAR_FICHA_3D') ?? 0) >= 2, 'EDITAR_FICHA_3D (ficha + aplicar preço)', String(mapa.get('EDITAR_FICHA_3D')));

    // Limpa a manutenção pra provar o DELETE e liberar a impressora (cobre EXCLUIR_MANUTENCAO).
    const manutId = manut.data?.id;
    if (manutId) {
      const dm = await call('DELETE', `/printers-3d/${impressoraId}/maintenances/${manutId}`, { token: adminToken });
      check(dm.status === 200, 'DELETE da manutenção → 200', `HTTP ${dm.status}`);

      // ── [ÓRFÃ] excluir a impressora de referência limpa o settings ────────────
      // Pré-condição explícita: ela AINDA é a padrão neste ponto (o caso canônico a definiu).
      console.log('\n[ÓRFÃ] a impressora de referência sai e leva a configuração junto');
      const antes = await pool.query(`SELECT value FROM settings WHERE key = 'impressora_padrao_3d'`);
      check(antes.rows[0]?.value === impressoraId, 'pré-condição: a excluída É a impressora de referência', String(antes.rows[0]?.value).slice(0, 8));

      const dp = await call('DELETE', `/printers-3d/${impressoraId}`, { token: adminToken });
      check(dp.status === 200, 'DELETE da impressora (sem manutenções) → 200', `HTTP ${dp.status}`);
      if (dp.status === 200) impressorasCriadas.length = 0; // já saiu pela rota

      const depois = await pool.query(`SELECT value FROM settings WHERE key = 'impressora_padrao_3d'`);
      check(depois.rows[0]?.value === '', 'settings impressora_padrao_3d ficou vazio (sem UUID morto)', JSON.stringify(depois.rows[0]?.value));

      // E o efeito na ponta: sem impressora, energia volta a NULL com alerta — nunca zero.
      const pOrfa = await call('GET', '/producao-3d/pricing', { token: adminToken });
      check(pOrfa.data?.impressora_configurada === false && pOrfa.data?.impressora === null,
        'pricing volta ao estado honesto: impressora não configurada', String(pOrfa.data?.impressora_configurada));
      const alvo = (pOrfa.data?.pecas || []).find((p: any) => p.id === pecaId);
      check(alvo?.custo?.energia === null && alvo?.custo?.total === null,
        'energia e total voltam a NULL (não viram zero)', JSON.stringify(alvo?.custo));
      check(Array.isArray(alvo?.alertas) && alvo.alertas.includes('SEM_IMPRESSORA'),
        'alerta SEM_IMPRESSORA na peça', JSON.stringify(alvo?.alertas));

      // O log tem que dizer que a configuração mudou — senão a referência some sem dono.
      const logOrfa = await pool.query(
        `SELECT details FROM audit_logs WHERE action = 'EXCLUIR_IMPRESSORA'
          ORDER BY created_at DESC LIMIT 1`);
      check(logOrfa.rows[0]?.details?.era_padrao === true,
        'EXCLUIR_IMPRESSORA registra era_padrao = true', JSON.stringify(logOrfa.rows[0]?.details?.era_padrao));
    }

    // Restaura a peça sem filamento (foto tirada no início).
    await pool.query('UPDATE products SET filament_product_id = $1 WHERE id = $2', [fichaOriginalSemFil.filament_product_id, pecaSemFil.id]);
    // Guarda pro finally o estado original das settings.
    (global as any).__settingsOriginais = settingsOriginais;
  } finally {
    try {
      // Ficha da peça do caso canônico: volta EXATAMENTE como estava (é peça do seed).
      if (fichaOriginal && pecaId) {
        await pool.query(
          `UPDATE products SET filament_grams = $1, production_minutes = $2, margin_percent = $3,
                  filament_product_id = $4, sales_price = $5 WHERE id = $6`,
          [fichaOriginal.filament_grams, fichaOriginal.production_minutes, fichaOriginal.margin_percent,
           fichaOriginal.filament_product_id, fichaOriginal.sales_price, pecaId],
        );
      }
      // Settings de volta ao valor original (o smoke mexeu em config global).
      const orig = (global as any).__settingsOriginais as Array<{ key: string; value: string }> | undefined;
      if (orig) for (const s of orig) await pool.query('UPDATE settings SET value = $1 WHERE key = $2', [s.value, s.key]);
      // Impressoras que sobraram (caminho de falha antes do DELETE pela rota).
      if (impressorasCriadas.length > 0) {
        await pool.query('DELETE FROM printer_maintenances WHERE printer_id = ANY($1::uuid[])', [impressorasCriadas]);
        await pool.query('DELETE FROM printers_3d WHERE id = ANY($1::uuid[])', [impressorasCriadas]);
      }
      if (permConcedida && id005) {
        await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'producao_3d'`, [id005]);
        console.log('  cleanup: chave producao_3d do 005 removida (rede de segurança).');
      }
      const sobra = await pool.query(
        `SELECT (SELECT count(*)::int FROM printers_3d) p, (SELECT count(*)::int FROM printer_maintenances) m,
                (SELECT count(*)::int FROM productions_3d) pr,
                (SELECT value FROM settings WHERE key='energia_kwh_brl') tarifa`);
      const s = sobra.rows[0];
      console.log(`  cleanup cirúrgico: ficha da peça restaurada, settings de volta (tarifa='${s.tarifa}'). Restam printers=${s.p}, manutenções=${s.m}, produções=${s.pr}.`);
    } finally {
      await pool.end();
      if (servidor) { await matarArvore(servidor.child); console.log('  servidor efêmero derrubado (árvore).'); }
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_pricing3d FALHOU em ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_pricing3d PASSOU — gate da chave nova (e o furo da ficha fechado), cadastro de impressora/manutenção com bordas e 409, estado honesto sem tarifa e sem filamento, o CASO CANÔNICO centavo a centavo, aplicar_preco recalculando no servidor, contagem derivada viva e auditoria conferidos; cleanup cirúrgico aplicado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_pricing3d EXPLODIU:', err?.message ?? err);
  process.exit(1);
});
