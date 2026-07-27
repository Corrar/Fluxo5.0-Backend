// src/smokes/smoke_security_users.ts — smoke dos 4 furos de escalação de privilégio.
//
// COMO RODA: diferente dos smokes de devoluções (que chamam services numa tx com rollback),
// este exercita as ROTAS HTTP de verdade — os furos eram de middleware/gate, e gate só se
// prova passando pela borda. Precisa de um server local apontando pro MESMO .env:
//   PORT=3999 ts-node src/server.ts   e depois   npm run smoke:security:users
//
// ⚠ GUARDA DE HOST: só roda se DATABASE_URL for o branch de VALIDAÇÃO (ep-summer-wave).
// Escreve de verdade (register cria usuário) — o cleanup é CIRÚRGICO, por id do usuário
// de teste, e o próprio DELETE /users/:id (caminho feliz do FURO 2) é o cleanup.
//
// Atores: 001@fluxoroyale.local (o ÚNICO admin do seed) e 005@fluxoroyale.local (setor) —
// um papel NÃO-admin REAL, pra provar o gate sem depender do bypass de admin.

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
  return res;
}

async function main(): Promise<void> {
  // ── Guarda de host: validação (ep-summer-wave) SIM, produção (ep-mute-feather) NUNCA ──
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }
  console.log('▶ smoke_security_users — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  let testUserId: string | null = null;

  try {
    // ── Atores ────────────────────────────────────────────────────────────────
    const adminLogin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setorLogin = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = adminLogin.data.token;
    const setorToken: string = setorLogin.data.token;

    // ── FURO 4: login não vaza a linha crua de users ──────────────────────────
    console.log('\n[FURO 4] resposta do login');
    for (const [nome, body] of [['admin', adminLogin.data], ['setor', setorLogin.data]] as const) {
      check(!('encrypted_password' in body.user), `login ${nome}: user SEM encrypted_password`, JSON.stringify(Object.keys(body.user)));
      check(!('total_minutes' in body.user), `login ${nome}: user SEM total_minutes`, 'ausente');
      check(!('last_active' in body.user), `login ${nome}: user SEM last_active`, 'ausente');
      check(JSON.stringify(Object.keys(body.user).sort()) === JSON.stringify(['email', 'id']), `login ${nome}: user é exatamente {id,email}`, JSON.stringify(Object.keys(body.user)));
      check(!JSON.stringify(body).includes('$2'), `login ${nome}: nenhum hash bcrypt em lugar NENHUM da resposta`, 'sem "$2..."');
    }

    const usersRes = await call('GET', '/users', { token: adminToken });
    const byEmail = (e: string) => usersRes.data.find((u: any) => u.email === e);
    const adminId: string = byEmail('001@fluxoroyale.local').id;
    const setorId: string = byEmail('005@fluxoroyale.local').id;

    // ── FURO 1/2: gate — não-admin real bloqueado ─────────────────────────────
    console.log('\n[FURO 1] gate do PUT /users/:id/role');
    const r1 = await call('PUT', `/users/${setorId}/role`, { token: setorToken, body: { role: 'admin' } });
    check(r1.status === 403, 'não-admin (setor) se promovendo a admin → 403', `HTTP ${r1.status}: ${r1.data?.error}`);

    console.log('\n[FURO 2] gate do DELETE /users/:id');
    const r2 = await call('DELETE', `/users/${adminId}`, { token: setorToken });
    check(r2.status === 403, 'não-admin (setor) deletando usuário → 403', `HTTP ${r2.status}: ${r2.data?.error}`);

    // ── Guard do último admin (001 é o ÚNICO admin do seed) ───────────────────
    console.log('\n[FURO 1/2] guard do último admin');
    const r3 = await call('PUT', `/users/${adminId}/role`, { token: adminToken, body: { role: 'setor' } });
    check(r3.status === 400, 'rebaixar o ÚNICO admin → 400', `HTTP ${r3.status}: ${r3.data?.error}`);
    const r4 = await call('DELETE', `/users/${adminId}`, { token: adminToken });
    check(r4.status === 400, 'deletar o ÚNICO admin → 400', `HTTP ${r4.status}: ${r4.data?.error}`);

    // ── FURO 3: register fechado atrás de auth + admin ────────────────────────
    console.log('\n[FURO 3] POST /auth/register');
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const testEmail = `smk-sec-${stamp}@fluxoroyale.local`;
    const novo = { email: testEmail, password: 'Smoke@123', name: `SMOKE SEC ${stamp}`, role: 'admin', sector: 'Geral' };

    const r5 = await call('POST', '/auth/register', { body: novo });
    check(r5.status === 401, 'register SEM token → 401', `HTTP ${r5.status}: ${r5.data?.error}`);
    const r6 = await call('POST', '/auth/register', { token: setorToken, body: novo });
    check(r6.status === 403, 'register com token não-admin (role:admin no body) → 403', `HTTP ${r6.status}: ${r6.data?.error}`);
    const r7 = await call('POST', '/auth/register', { token: adminToken, body: { ...novo, role: 'admim' } });
    check(r7.status === 400, 'register (admin) com cargo fora da allowlist (admim) → 400', `HTTP ${r7.status}: ${r7.data?.error}`);
    const r8 = await call('POST', '/auth/register', { token: adminToken, body: novo });
    check(r8.status === 201 && !!r8.data?.id, "register (admin) criando com role:'admin' → 201", `HTTP ${r8.status}`);
    testUserId = r8.data?.id ?? null;

    // ── FURO 1: allowlist + caminho feliz (no usuário de teste, nunca no seed) ─
    console.log('\n[FURO 1] allowlist de cargo no PUT /role');
    if (testUserId) {
      const r9 = await call('PUT', `/users/${testUserId}/role`, { token: adminToken, body: { role: 'admim' } });
      check(r9.status === 400, "PUT /role com cargo inexistente ('admim') → 400", `HTTP ${r9.status}: ${r9.data?.error}`);
      // Rebaixa o 2º admin de teste → restaura o invariante "1 admin" do seed.
      const r10 = await call('PUT', `/users/${testUserId}/role`, { token: adminToken, body: { role: 'setor', sector: 'Geral' } });
      check(r10.status === 200, 'PUT /role válido (admin→setor no usuário de teste) → 200', `HTTP ${r10.status}`);

      // ── FURO 2: hard-delete feliz = o PRÓPRIO cleanup cirúrgico ─────────────
      console.log('\n[FURO 2] hard-delete do usuário de teste (cleanup)');
      const r11 = await call('DELETE', `/users/${testUserId}`, { token: adminToken });
      check(r11.status === 200, 'DELETE do usuário de teste (sem histórico) → 200', `HTTP ${r11.status}: ${r11.data?.error ?? 'ok'}`);
      if (r11.status === 200) testUserId = null; // já saiu pelo endpoint
    } else {
      failures.push('register não devolveu id — allowlist/caminho feliz do PUT /role não exercitados');
    }

    // ── Invariantes do seed intactos ──────────────────────────────────────────
    console.log('\n[SEED] invariantes pós-smoke');
    const inv = await pool.query(`
      SELECT (SELECT COUNT(*)::int FROM users) AS total,
             (SELECT COUNT(*)::int FROM profiles WHERE role = 'admin') AS admins,
             (SELECT COUNT(*)::int FROM users WHERE email LIKE 'smk-sec-%') AS sobras
    `);
    const { total, admins, sobras } = inv.rows[0];
    check(total === 15, 'seed com 15 usuários (nenhum a mais/menos)', `total=${total}`);
    check(admins === 1, 'seed com exatamente 1 admin', `admins=${admins}`);
    check(sobras === 0, 'zero usuário de teste sobrando', `sobras=${sobras}`);
  } finally {
    // Fallback CIRÚRGICO (só roda se o DELETE via endpoint não limpou): tudo por id.
    if (testUserId) {
      console.warn(`\n⚠ cleanup fallback por id: ${testUserId}`);
      await pool.query('DELETE FROM audit_logs WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM profiles WHERE id = $1', [testUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    }
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_security_users FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_security_users PASSOU — 4 furos fechados, seed de validação intacto.');
}

main().catch((err) => {
  console.error('\n❌ smoke_security_users ABORTOU:', err?.message ?? err);
  process.exit(1);
});
