// src/smokes/smoke_users.ts — smoke do endurecimento de /users (v1 da tela de Usuários).
//
// COMO RODA: igual aos smokes HTTP — exercita as ROTAS reais contra um server local no
// MESMO .env:  PORT=3999 node dist/server.js  e depois  npm run smoke:users
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ Pressupõe validação SEM operação simultânea — o teste suspende/reativa o usuário 010
//   e troca a senha dele em trânsito (snapshot ANTES, restauração cirúrgica por id no final).
//
// COBERTURA:
//   [FURO 12]  token vivo de suspenso → 403 'Conta suspensa.' em rota de authenticate puro;
//              socket com token de suspenso → rejeitado no handshake; reativado → volta tudo.
//              (Sonda = GET /admin/settings, leitura liberada a qualquer logado — de propósito:
//              GET /products tem requirePermission e acoplaria o teste ao RBAC do 010.)
//   [BROADCAST] user_status_changed ESCOPADO: socket do admin (sala 'admin') recebe;
//              socket do 005 (sala 'setor') NÃO recebe.
//   [PAYLOAD]  GET /users: 001 → cheio (total_minutes/last_active/is_active/email);
//              005 → magro {id, name, role, sector} com asserção de AUSÊNCIA das chaves;
//              005 + exceção 'usuarios' (user_permissions) → cheio EM TEMPO REAL (sem novo
//              login — é a concessão da tela de Permissões surtindo efeito); revogada → magro.
//   [RESET]    id fantasma → 404; id real → 200 e login com a senha nova funciona;
//              hash ORIGINAL restaurado por SQL cirúrgico e login Teste@123 conferido.
//
// Atores: 001 (admin), 005 (não-admin, sala 'setor'), 010 (cobaia de suspensão/reset).

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3999';
const SENHA_SEED = 'Teste@123';
const SENHA_TESTE = 'Smk@1234567';

const failures: string[] = [];
function check(cond: boolean, desc: string, got: string): void {
  if (cond) {
    console.log(`  ✔ ${desc}  (${got})`);
  } else {
    console.error(`  ✘ ${desc}  (obtido: ${got})`);
    failures.push(desc);
  }
}

async function call(method: string, path: string, opts: { token?: string; body?: object } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* respostas sem corpo */ }
  return { status: res.status, data };
}

async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login de ${email} falhou: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Abre um socket autenticado e resolve com o resultado do handshake (nunca rejeita).
function abrirSocket(token: string): Promise<{ ok: boolean; socket?: ClientSocket; err?: string }> {
  return new Promise((resolve) => {
    const s = ioClient(BASE, { transports: ['websocket'], auth: { token }, reconnection: false, timeout: 8000 });
    const timer = setTimeout(() => { s.close(); resolve({ ok: false, err: 'timeout' }); }, 9000);
    s.on('connect', () => { clearTimeout(timer); resolve({ ok: true, socket: s }); });
    s.on('connect_error', (e: Error) => { clearTimeout(timer); s.close(); resolve({ ok: false, err: e.message }); });
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }
  console.log('▶ smoke_users — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const socketsAbertos: ClientSocket[] = [];

  // SNAPSHOT da cobaia (010) antes de qualquer escrita — restauração cirúrgica por id no finally.
  const cobaia = await pool.query(
    `SELECT id, is_active, encrypted_password FROM users WHERE email = '010@fluxoroyale.local'`,
  );
  if (cobaia.rows.length === 0) throw new Error('010@fluxoroyale.local ausente — seed inesperado, abortando.');
  const id010: string = cobaia.rows[0].id;
  const hashOriginal: string = cobaia.rows[0].encrypted_password;
  if (cobaia.rows[0].is_active === false) throw new Error('010 já está suspenso — estado inesperado, abortando.');
  console.log(`  cobaia: 010 (${id010.slice(0, 8)}…), snapshot de is_active e hash capturado`);

  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const alvo = await login('010@fluxoroyale.local', SENHA_SEED); // token VIVO pra provar o furo
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    const alvoToken: string = alvo.token;

    // ── Sockets do broadcast ANTES da suspensão ───────────────────────────────
    console.log('\n[SOCKETS] admin e 005 conectados');
    const sockAdmin = await abrirSocket(adminToken);
    const sockSetor = await abrirSocket(setorToken);
    check(sockAdmin.ok, 'socket do admin conecta (sala admin via JWT)', sockAdmin.ok ? 'conectado' : String(sockAdmin.err));
    check(sockSetor.ok, 'socket do 005 conecta (sala setor via JWT)', sockSetor.ok ? 'conectado' : String(sockSetor.err));
    if (sockAdmin.socket) socketsAbertos.push(sockAdmin.socket);
    if (sockSetor.socket) socketsAbertos.push(sockSetor.socket);

    const eventosAdmin: any[] = [];
    const eventosSetor: any[] = [];
    sockAdmin.socket?.on('user_status_changed', (d: any) => eventosAdmin.push(d));
    sockSetor.socket?.on('user_status_changed', (d: any) => eventosSetor.push(d));

    // ── FURO 12 + BROADCAST: ciclo suspender → provar → reativar ─────────────
    console.log('\n[FURO 12] token vivo de suspenso');
    const base1 = await call('GET', '/admin/settings', { token: alvoToken });
    check(base1.status === 200, 'linha de base: 010 ativo passa em rota de authenticate puro', `HTTP ${base1.status}`);

    const s1 = await call('PUT', `/users/${id010}/status`, { token: adminToken, body: { is_active: false } });
    check(s1.status === 200, 'admin suspende 010 → 200', `HTTP ${s1.status}`);
    await sleep(1200); // emit + entrega do socket

    const f1 = await call('GET', '/admin/settings', { token: alvoToken });
    check(f1.status === 403 && f1.data?.error === 'Conta suspensa.',
      "token VIVO do suspenso → 403 'Conta suspensa.' (furo 12 fechado)", `HTTP ${f1.status}: ${f1.data?.error}`);

    const sockAlvo = await abrirSocket(alvoToken);
    check(!sockAlvo.ok, 'socket com token do suspenso → rejeitado no handshake', sockAlvo.ok ? 'CONECTOU (!)' : `connect_error: ${sockAlvo.err}`);
    if (sockAlvo.socket) socketsAbertos.push(sockAlvo.socket);

    console.log('\n[BROADCAST] escopo do user_status_changed');
    check(eventosAdmin.some((d) => d?.userId === id010 && d?.is_active === false),
      'admin (sala admin) RECEBEU a suspensão', `${eventosAdmin.length} evento(s)`);
    check(eventosSetor.length === 0, '005 (sala setor) NÃO recebeu nada', `${eventosSetor.length} evento(s)`);

    const s2 = await call('PUT', `/users/${id010}/status`, { token: adminToken, body: { is_active: true } });
    check(s2.status === 200, 'admin reativa 010 → 200', `HTTP ${s2.status}`);
    await sleep(1200);
    const f2 = await call('GET', '/admin/settings', { token: alvoToken });
    check(f2.status === 200, 'reativado: o MESMO token volta a passar', `HTTP ${f2.status}`);
    check(eventosAdmin.some((d) => d?.userId === id010 && d?.is_active === true),
      'admin recebeu também a reativação', `${eventosAdmin.length} evento(s)`);
    check(eventosSetor.length === 0, '005 seguiu sem receber nada no ciclo todo', `${eventosSetor.length} evento(s)`);

    // ── PAYLOAD condicionado do GET /users ────────────────────────────────────
    console.log('\n[PAYLOAD] GET /users cheio × magro');
    const cheio = await call('GET', '/users', { token: adminToken });
    const l1 = cheio.data?.[0] ?? {};
    check(cheio.status === 200 && 'total_minutes' in l1 && 'last_active' in l1 && 'is_active' in l1 && 'email' in l1,
      'admin → payload CHEIO (métricas + is_active + email presentes)', Object.keys(l1).join(','));
    const magro = await call('GET', '/users', { token: setorToken });
    const l2 = magro.data?.[0] ?? {};
    check(magro.status === 200 && !('total_minutes' in l2) && !('last_active' in l2) && !('is_active' in l2) && !('email' in l2),
      '005 → payload MAGRO (ausência das chaves sensíveis)', Object.keys(l2).join(','));
    check('id' in l2 && 'name' in l2 && 'role' in l2 && 'sector' in l2,
      'magro mantém id/name/role/sector (dropdown de Exceções coberto)', Object.keys(l2).join(','));
    check(Array.isArray(magro.data) && magro.data.length === cheio.data.length,
      'magro lista os MESMOS usuários (só esconde colunas)', `${magro.data?.length} linha(s)`);

    // Concessão EM TEMPO REAL: exceção 'usuarios' via user_permissions vira payload cheio
    // na hora, sem novo login (o critério é consultado a cada GET — é a concessão feita na
    // tela de Permissões surtindo efeito aqui). Cirúrgico: INSERT do par exato + DELETE do
    // par exato no finally — nada de replace-all (preservaria zero exceções pré-existentes).
    const id005: string = (await pool.query(
      `SELECT id FROM users WHERE email = '005@fluxoroyale.local'`)).rows[0].id;
    const jaTinha = await pool.query(
      `SELECT 1 FROM user_permissions WHERE user_id = $1 AND page_key = 'usuarios'`, [id005]);
    if (jaTinha.rows.length > 0) {
      throw new Error("005 já tem exceção 'usuarios' — estado inesperado do seed, abortando sem tocar.");
    }
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'usuarios')`, [id005]);
    try {
      const cheio005 = await call('GET', '/users', { token: setorToken });
      const l3 = cheio005.data?.[0] ?? {};
      check(cheio005.status === 200 && 'total_minutes' in l3 && 'last_active' in l3 && 'is_active' in l3 && 'email' in l3,
        "005 COM exceção 'usuarios' → payload CHEIO em tempo real (sem novo login)", Object.keys(l3).join(','));
    } finally {
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'usuarios'`, [id005]);
    }
    const magro2 = await call('GET', '/users', { token: setorToken });
    const l4 = magro2.data?.[0] ?? {};
    check(magro2.status === 200 && !('email' in l4) && !('is_active' in l4) && !('total_minutes' in l4),
      'exceção revogada → volta o payload MAGRO', Object.keys(l4).join(','));

    // ── RESET de senha: 404 honesto + ciclo real ──────────────────────────────
    console.log('\n[RESET] id fantasma e ciclo real');
    const r1 = await call('POST', '/users/00000000-0000-4000-8000-000000000000/reset-password',
      { token: adminToken, body: { newPassword: SENHA_TESTE } });
    check(r1.status === 404, 'id fantasma (UUID válido inexistente) → 404', `HTTP ${r1.status}: ${r1.data?.error}`);
    const r2 = await call('POST', `/users/${id010}/reset-password`, { token: adminToken, body: { newPassword: SENHA_TESTE } });
    check(r2.status === 200, 'reset do 010 → 200', `HTTP ${r2.status}`);
    const loginNovo = await call('POST', '/auth/login', { body: { email: '010@fluxoroyale.local', password: SENHA_TESTE } });
    check(loginNovo.status === 200, 'login do 010 com a senha NOVA funciona', `HTTP ${loginNovo.status}`);
    // gate intacto: não-admin não reseta
    const r3 = await call('POST', `/users/${id010}/reset-password`, { token: setorToken, body: { newPassword: SENHA_TESTE } });
    check(r3.status === 403, '005 tentando resetar → 403 (gate intacto)', `HTTP ${r3.status}`);
  } finally {
    socketsAbertos.forEach((s) => { try { s.close(); } catch { /* ignora */ } });
    // Restauração CIRÚRGICA por id: is_active de volta a true e o HASH ORIGINAL bit a bit
    // (não uma senha re-hasheada) — o branch fica exatamente como estava.
    try {
      await pool.query('UPDATE users SET is_active = true, encrypted_password = $1 WHERE id = $2', [hashOriginal, id010]);
      console.log('  restauração cirúrgica do 010 aplicada (is_active + hash original).');
    } catch (e: any) {
      console.error('  ‼ FALHA na restauração do 010 — conferir users manualmente!', e?.message);
    }
    await pool.end();
  }

  // Confirmação pós-restauração: o seed volta a valer.
  const loginSeed = await call('POST', '/auth/login', { body: { email: '010@fluxoroyale.local', password: SENHA_SEED } });
  check(loginSeed.status === 200, 'pós-restauração: login do 010 com Teste@123 funciona', `HTTP ${loginSeed.status}`);

  if (failures.length > 0) {
    console.error(`\n❌ smoke_users FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_users PASSOU — furo 12 fechado, broadcast escopado, payload condicionado, reset honesto, cobaia restaurada.');
}

main().catch((err) => {
  console.error('\n❌ smoke_users ABORTOU:', err?.message ?? err);
  process.exit(1);
});
