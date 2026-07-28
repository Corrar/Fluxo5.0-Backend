// src/smokes/smoke_permissions.ts — smoke do endurecimento dos POSTs de permissões (v1).
//
// COMO RODA: igual aos smokes HTTP — exercita as ROTAS reais contra um server local no
// MESMO .env:  PORT=3999 node dist/server.js  e depois  npm run smoke:permissions
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ Pressupõe ambiente de validação SEM operação simultânea — o teste muta role_permissions
//   de 'obras' em trânsito (restaurado ao final).
// ESCRITAS do teste e cleanup CIRÚRGICO:
//   - role_permissions do papel 'obras': snapshot capturado ANTES, modificado no meio
//     (add 1 / remove 1) e RESTAURADO ao final pelo próprio replace-all — conferido no banco;
//   - user_permissions do 005: recebe chave de teste e volta a [] (vazio legítimo);
//   - audit_logs ganha as entradas UPDATE_*_PERMISSIONS do próprio teste (livro append-only,
//     mesmo padrão dos outros smokes que deixam seus LOGINs).
//
// COBERTURA: gate 403 intacto; guard anti-vazio (só /roles); borda de role (lowercase),
// permissions (array, alfabeto, aponta a chave inválida), dedup; diff added/removed EXATO
// no audit_logs; vazio legítimo no /users; restauração conferida.
//
// Atores: 001@fluxoroyale.local (admin real) e 005@fluxoroyale.local (não-admin).

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

const eq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }
  console.log('▶ smoke_permissions — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const rolesDe = async (role: string): Promise<string[]> =>
    (await pool.query('SELECT page_key FROM role_permissions WHERE role = $1 ORDER BY 1', [role])).rows.map((r) => r.page_key);
  const excecoesDe = async (id: string): Promise<string[]> =>
    (await pool.query('SELECT page_key FROM user_permissions WHERE user_id = $1 ORDER BY 1', [id])).rows.map((r) => r.page_key);

  // SNAPSHOT antes de qualquer escrita — é ele que restaura o papel no final.
  const original = await rolesDe('obras');
  if (original.length === 0) throw new Error("papel 'obras' sem linhas na matriz — seed inesperado, abortando antes de escrever.");
  console.log(`  snapshot de 'obras' capturado: [${original.join(', ')}]`);

  let restaurado = false;
  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    const setorId: string = setor.user.id;

    // ── a) Gate intacto: 005 não salva ────────────────────────────────────────
    console.log('\n[GATE] 005 no POST /roles');
    const g1 = await call('POST', '/admin/permissions/roles', { token: setorToken, body: { role: 'obras', permissions: ['produtos:view'] } });
    check(g1.status === 403, '005 (não-admin) salvando matriz → 403', `HTTP ${g1.status}: ${g1.data?.error}`);

    // ── b) Guard anti-vazio (só /roles) ───────────────────────────────────────
    console.log('\n[ANTI-VAZIO] POST /roles');
    const v1 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras', permissions: [] } });
    check(v1.status === 400, 'permissions:[] → 400 (papel sumiria da allowlist)', `HTTP ${v1.status}: ${v1.data?.error}`);
    const v2 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras' } });
    check(v2.status === 400, 'permissions ausente → 400', `HTTP ${v2.status}: ${v2.data?.error}`);

    // ── c) Borda de role e permissions ────────────────────────────────────────
    console.log('\n[BORDA] role e permissions');
    const b1 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'OBRAS', permissions: ['produtos:view'] } });
    check(b1.status === 400, "role 'OBRAS' (maiúscula) → 400 (allowlist é case-sensitive)", `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras', permissions: 'abc' } });
    check(b2.status === 400, "permissions:'abc' (string) → 400 (mataria o for...of char a char)", `HTTP ${b2.status}: ${b2.data?.error}`);
    const b3 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras', permissions: ['ok_chave', 'BAD KEY!'] } });
    check(b3.status === 400 && String(b3.data?.error ?? '').includes('BAD KEY!'),
      'chave inválida → 400 apontando a culpada', `HTTP ${b3.status}: ${b3.data?.error}`);

    // ── d) Replace-all válido + diff EXATO no livro ───────────────────────────
    console.log('\n[DIFF] conjunto modificado (add 1, remove 1)');
    const removida = original[0];
    const adicionada = 'smk_perm_extra';
    const modificado = [...original.slice(1), adicionada];
    const d1 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras', permissions: modificado } });
    check(d1.status === 200 && d1.data?.success === true, 'conjunto válido modificado → 200', `HTTP ${d1.status}`);
    const noBanco = await rolesDe('obras');
    check(eq(noBanco, modificado), 'banco reflete o conjunto final exato', `[${noBanco.join(', ')}]`);
    const log = await pool.query(
      `SELECT details FROM audit_logs WHERE action = 'UPDATE_ROLE_PERMISSIONS' AND details->>'role_target' = 'obras' ORDER BY created_at DESC LIMIT 1`,
    );
    const det = log.rows[0]?.details ?? {};
    check(eq(det.added ?? [], [adicionada]), `details.added exato = ['${adicionada}']`, JSON.stringify(det.added));
    check(eq(det.removed ?? [], [removida]), `details.removed exato = ['${removida}']`, JSON.stringify(det.removed));
    check(det.count === modificado.length, `details.count = ${modificado.length}`, `count=${det.count}`);

    // ── e) Espelho por usuário: vazio é legítimo ──────────────────────────────
    console.log('\n[USERS] vazio legítimo e dedup');
    const e1 = await call('POST', '/admin/permissions/users', { token: adminToken, body: { userId: setorId, permissions: [] } });
    check(e1.status === 200, 'POST /users com permissions:[] → 200 (sem guard anti-vazio no espelho)', `HTTP ${e1.status}`);
    check((await excecoesDe(setorId)).length === 0, 'exceções do 005 zeradas no banco', '0 linha(s)');

    // ── f) Dedup: chave repetida não estoura a PK ─────────────────────────────
    const f1 = await call('POST', '/admin/permissions/users', { token: adminToken, body: { userId: setorId, permissions: ['smk_perm_dup', 'smk_perm_dup'] } });
    const linhasDup = await excecoesDe(setorId);
    check(f1.status === 200 && linhasDup.length === 1 && linhasDup[0] === 'smk_perm_dup',
      "['x','x'] → 200 com 1 linha só (dedup, sem 500 de PK)", `HTTP ${f1.status}, ${linhasDup.length} linha(s)`);
    // borda do userId, já que estamos aqui
    const f2 = await call('POST', '/admin/permissions/users', { token: adminToken, body: { userId: 'nao-e-uuid', permissions: [] } });
    check(f2.status === 400, 'userId fora do formato UUID → 400', `HTTP ${f2.status}`);
    const f3 = await call('POST', '/admin/permissions/users', { token: adminToken, body: { userId: '00000000-0000-4000-8000-000000000000', permissions: [] } });
    check(f3.status === 404, 'userId UUID inexistente → 404', `HTTP ${f3.status}`);
    // cleanup do 005: volta a [] (o caminho legítimo do espelho)
    const f4 = await call('POST', '/admin/permissions/users', { token: adminToken, body: { userId: setorId, permissions: [] } });
    check(f4.status === 200 && (await excecoesDe(setorId)).length === 0, 'cleanup do 005 → exceções de volta a zero', `HTTP ${f4.status}`);

    // ── g) RESTAURAÇÃO do snapshot ────────────────────────────────────────────
    console.log('\n[RESTAURAÇÃO] obras de volta ao snapshot');
    const r1 = await call('POST', '/admin/permissions/roles', { token: adminToken, body: { role: 'obras', permissions: original } });
    const aposRestauro = await rolesDe('obras');
    restaurado = r1.status === 200 && eq(aposRestauro, original);
    check(restaurado, 'conjunto original restaurado e conferido no banco', `[${aposRestauro.join(', ')}]`);
  } finally {
    // Rede de segurança: se o teste morreu no meio, restaura 'obras' direto no banco
    // (mesma técnica replace-all, com o snapshot) — nunca deixar o papel mutilado.
    // Client DEDICADO: BEGIN/COMMIT via pool.query cairiam em conexões diferentes.
    if (!restaurado) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DELETE FROM role_permissions WHERE role = $1', ['obras']);
        for (const k of original) {
          await c.query('INSERT INTO role_permissions (role, page_key) VALUES ($1, $2)', ['obras', k]);
        }
        await c.query('COMMIT');
        console.warn('  ⚠ restauração de emergência de obras aplicada via SQL (o fluxo normal não completou).');
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* ignora */ }
        console.error('  ‼ FALHA na restauração de emergência — conferir role_permissions de obras manualmente!');
      } finally {
        c.release();
      }
    }
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_permissions FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_permissions PASSOU — borda endurecida, diff no livro, snapshot restaurado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_permissions ABORTOU:', err?.message ?? err);
  process.exit(1);
});
