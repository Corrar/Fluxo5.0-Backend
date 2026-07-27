// src/smokes/smoke_security_rbac.ts — smoke dos 6 furos MENORES de RBAC (recon Fase 1).
//
// COMO RODA: igual ao smoke_security_users — exercita as ROTAS HTTP reais contra um server
// local no MESMO .env:  PORT=3999 node dist/server.js  e depois  npm run smoke:security:rbac
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// Escritas do teste e seus cleanups CIRÚRGICOS:
//   - settings: key exclusiva smk_sec_cfg_<stamp> → DELETE por key exata;
//   - user_permissions: par (005, 'tarefas_eletrica') → DELETE pelo par exato;
//   - heartbeat do 005 em si mesmo soma 1 minuto de métrica (mesma coisa que o front faz).
//
// Atores: 001@fluxoroyale.local (admin) e 005@fluxoroyale.local (setor, não-admin real).

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3999';
const SENHA_SEED = 'Teste@123';

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
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }
  console.log('▶ smoke_security_rbac — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cfgKey = `smk_sec_cfg_${stamp}`;
  let setorId: string | null = null;
  let grantedEletrica = false;

  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    const adminId: string = admin.user.id;
    setorId = setor.user.id as string;

    // ── FURO 1: heartbeat só do próprio (ou admin) ────────────────────────────
    console.log('\n[FURO 1] PUT /users/:id/heartbeat');
    const h1 = await call('PUT', `/users/${adminId}/heartbeat`, { token: setorToken, body: {} });
    check(h1.status === 403, 'não-admin marcando atividade de OUTRO id → 403', `HTTP ${h1.status}: ${h1.data?.error}`);
    const h2 = await call('PUT', `/users/${setorId}/heartbeat`, { token: setorToken, body: {} });
    check(h2.status === 200 && h2.data?.success === true, 'usuário marcando a PRÓPRIA atividade → 200', `HTTP ${h2.status}`);

    // ── FURO 2: matriz RBAC só com page_key 'permissoes' ──────────────────────
    console.log('\n[FURO 2] GET /admin/permissions/roles|users');
    const p1 = await call('GET', '/admin/permissions/roles', { token: setorToken });
    check(p1.status === 403, 'não-admin lendo a matriz de cargos → 403', `HTTP ${p1.status}: ${p1.data?.error}`);
    const p2 = await call('GET', '/admin/permissions/users', { token: setorToken });
    check(p2.status === 403, 'não-admin lendo as exceções por usuário → 403', `HTTP ${p2.status}: ${p2.data?.error}`);
    const p3 = await call('GET', '/admin/permissions/roles', { token: adminToken });
    check(p3.status === 200 && !!p3.data?.admin, 'admin lendo a matriz → 200', `HTTP ${p3.status}`);

    // ── FURO 3: PUT /admin/settings com gate de admin + auditoria ─────────────
    console.log('\n[FURO 3] PUT /admin/settings');
    const s1 = await call('PUT', '/admin/settings', { token: setorToken, body: { key: cfgKey, value: 'hacked' } });
    check(s1.status === 403, 'não-admin gravando config global → 403', `HTTP ${s1.status}: ${s1.data?.error}`);
    const s2 = await call('PUT', '/admin/settings', { token: adminToken, body: { key: cfgKey, value: 'ok' } });
    check(s2.status === 200, 'admin gravando config → 200', `HTTP ${s2.status}`);
    const s3 = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'UPDATE_SETTING' AND details->>'key' = $1`, [cfgKey]);
    check(s3.rows.length === 1, 'gravação de config auditada (UPDATE_SETTING no livro)', `${s3.rows.length} log(s)`);
    const s4 = await call('GET', '/admin/settings', { token: setorToken });
    check(s4.status === 200, 'leitura de settings segue liberada pra logado → 200', `HTTP ${s4.status}`);

    // ── FURO 4: /reminders desmontado ─────────────────────────────────────────
    console.log('\n[FURO 4] /reminders (rota desmontada)');
    const r1 = await call('GET', '/reminders', { token: adminToken });
    check(r1.status === 404, 'GET /reminders (mesmo admin) → 404', `HTTP ${r1.status}`);

    // ── FURO 5: /admin/logs via page_key 'logs' ───────────────────────────────
    console.log('\n[FURO 5] GET /admin/logs');
    const l1 = await call('GET', '/admin/logs', { token: setorToken });
    check(l1.status === 403, 'não-admin lendo a auditoria → 403', `HTTP ${l1.status}: ${l1.data?.error}`);
    const l2 = await call('GET', '/admin/logs', { token: adminToken });
    check(l2.status === 200 && Array.isArray(l2.data), 'admin lendo a auditoria → 200', `HTTP ${l2.status}`);

    // ── FURO 6: elétrica unificada no requirePermission ───────────────────────
    console.log('\n[FURO 6] /eletrica-tasks');
    const e1 = await call('GET', '/eletrica-tasks', { token: setorToken });
    check(e1.status === 403, 'setor sem permissão lendo tarefas da elétrica → 403', `HTTP ${e1.status}: ${e1.data?.error}`);
    const e2 = await call('GET', '/eletrica-tasks', { token: adminToken });
    check(e2.status === 200, 'admin lendo tarefas da elétrica → 200', `HTTP ${e2.status}`);
    // A prova do furo: exceção por user_permissions AGORA funciona (o check antigo ignorava).
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'tarefas_eletrica')`, [setorId]);
    grantedEletrica = true;
    const e3 = await call('GET', '/eletrica-tasks', { token: setorToken });
    check(e3.status === 200, 'exceção via user_permissions concede acesso → 200 (furo era ignorá-la)', `HTTP ${e3.status}`);

    // ── Invariantes do seed ───────────────────────────────────────────────────
    console.log('\n[SEED] invariantes pós-smoke');
    const inv = await pool.query(`SELECT (SELECT COUNT(*)::int FROM users) AS total, (SELECT COUNT(*)::int FROM profiles WHERE role = 'admin') AS admins`);
    check(inv.rows[0].total === 15 && inv.rows[0].admins === 1, 'seed intacto (15 usuários, 1 admin)', `total=${inv.rows[0].total}, admins=${inv.rows[0].admins}`);
  } finally {
    // Cleanup cirúrgico: key exata + par exato — nada global.
    await pool.query('DELETE FROM settings WHERE key = $1', [cfgKey]);
    if (grantedEletrica && setorId) {
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'tarefas_eletrica'`, [setorId]);
    }
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_security_rbac FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_security_rbac PASSOU — 6 furos menores fechados, seed de validação intacto.');
}

main().catch((err) => {
  console.error('\n❌ smoke_security_rbac ABORTOU:', err?.message ?? err);
  process.exit(1);
});
