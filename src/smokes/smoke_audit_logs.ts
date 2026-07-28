// src/smokes/smoke_audit_logs.ts — smoke do contrato v1 do GET /admin/logs (Auditoria).
//
// COMO RODA: igual ao smoke_security_rbac — exercita a ROTA HTTP real contra um server
// local no MESMO .env:  PORT=3999 node dist/server.js  e depois  npm run smoke:audit:logs
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// 100% READ-ONLY: nenhuma escrita além dos LOGIN que o próprio teste gera — sem cleanup.
// (Atenção: cada rodada soma 2 logs de LOGIN ao livro; os totais são comparados com SQL
// direto NA MESMA rodada, então isso não desestabiliza as checagens.)
//
// CONTRATO COBERTO (decisões documentadas):
//   - envelope { logs, total, limit, offset }; limit default 50, teto 100;
//   - limit fora de 1..100 → 400 (DECISÃO: sem clamp — borda estrita, igual às datas);
//   - datas YYYY-MM-DD na borda (malformada → 400, nunca 500); endDate INCLUSIVO;
//   - ?q= ILIKE em details::text; ?action= match exato; total SEMPRE com os mesmos filtros;
//   - offset além do fim → logs:[] com total intacto;
//   - p.sector presente nas linhas (pode ser null — LEFT JOIN).
//
// Atores: 001@fluxoroyale.local (admin, tem 'logs') e 005@fluxoroyale.local (setor, não tem).

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

// O envelope tem o shape do contrato v1?
function isEnvelope(d: any): boolean {
  return d != null && Array.isArray(d.logs) && typeof d.total === 'number'
    && typeof d.limit === 'number' && typeof d.offset === 'number';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('ep-summer-wave')) {
    throw new Error('GUARDA DE HOST: DATABASE_URL não aponta pro branch de validação ep-summer-wave — abortando sem tocar no banco.');
  }
  console.log('▶ smoke_audit_logs — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;

    // ── RBAC: quem não tem 'logs' não lê o livro ──────────────────────────────
    console.log('\n[RBAC] 005 sem page_key logs');
    const r1 = await call('GET', '/admin/logs', { token: setorToken });
    check(r1.status === 403, '005 (setor) lendo a auditoria → 403', `HTTP ${r1.status}: ${r1.data?.error}`);

    // ── Envelope + total contra SQL direto ────────────────────────────────────
    console.log('\n[ENVELOPE] shape e total');
    const sqlTotal = (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs`)).rows[0].n;
    const e1 = await call('GET', '/admin/logs', { token: adminToken });
    check(e1.status === 200 && isEnvelope(e1.data), 'admin → 200 com envelope {logs,total,limit,offset}', `HTTP ${e1.status}`);
    check(e1.data?.total === sqlTotal, `total do envelope = COUNT(*) do SQL (${sqlTotal})`, `total=${e1.data?.total}`);
    check(e1.data?.limit === 50 && e1.data?.offset === 0, 'defaults: limit=50, offset=0', `limit=${e1.data?.limit}, offset=${e1.data?.offset}`);
    check(e1.data?.logs.length === Math.min(50, sqlTotal), 'página respeita o limit default', `${e1.data?.logs.length} linha(s)`);
    // Asserção de SHAPE da linha (pedida no OK condicional do commit 1): as 8 chaves do contrato.
    const linha = e1.data?.logs[0] ?? {};
    const SHAPE = ['id', 'action', 'details', 'created_at', 'ip_address', 'user_name', 'user_role', 'sector'];
    const faltando = SHAPE.filter((k) => !(k in linha));
    check(faltando.length === 0,
      'primeira linha com shape completo {id,action,details,created_at,ip_address,user_name,user_role,sector}',
      faltando.length === 0 ? `chaves: ${Object.keys(linha).join(',')}` : `FALTANDO: ${faltando.join(',')}`);

    // ── ?action= é match EXATO, com total nos mesmos filtros ──────────────────
    console.log('\n[FILTRO action]');
    const alvo = (await pool.query(
      `SELECT action, COUNT(*)::int AS n FROM audit_logs WHERE action <> 'LOGIN' GROUP BY action ORDER BY n DESC LIMIT 1`,
    )).rows[0];
    const a1 = await call('GET', `/admin/logs?action=${encodeURIComponent(alvo.action)}`, { token: adminToken });
    check(a1.status === 200 && a1.data?.total === alvo.n, `?action=${alvo.action} → total ${alvo.n}`, `total=${a1.data?.total}`);
    check((a1.data?.logs ?? []).every((l: any) => l.action === alvo.action), 'todas as linhas com a action exata', `${a1.data?.logs?.length} linha(s)`);

    // ── ?q= casa substring de details (ILIKE em details::text) ────────────────
    console.log('\n[FILTRO q]');
    const qTerm = 'realizado'; // dentro de {"message":"Login realizado"} — só valor, não chave
    const sqlQ = (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE details::text ILIKE $1`, [`%${qTerm}%`])).rows[0].n;
    const q1 = await call('GET', `/admin/logs?q=${qTerm}`, { token: adminToken });
    check(q1.status === 200 && q1.data?.total === sqlQ, `?q=${qTerm} → total = SQL (${sqlQ})`, `total=${q1.data?.total}`);
    check((q1.data?.logs ?? []).every((l: any) => JSON.stringify(l.details).toLowerCase().includes(qTerm)),
      'todas as linhas contêm o termo em details', `${q1.data?.logs?.length} linha(s)`);
    // q combinável com action (o recon pedia filtros componíveis) — esperado vem do SQL combinado
    const sqlQA = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE details::text ILIKE $1 AND action = $2`,
      [`%${qTerm}%`, alvo.action],
    )).rows[0].n;
    const q2 = await call('GET', `/admin/logs?q=${qTerm}&action=${encodeURIComponent(alvo.action)}`, { token: adminToken });
    check(q2.status === 200 && q2.data?.total === sqlQA, `q + action combinados → total = SQL (${sqlQA})`, `total=${q2.data?.total}`);

    // ── Range de datas: bordas inclusivas, malformada → 400 ───────────────────
    console.log('\n[DATAS]');
    const sqlRange = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 day')`,
      ['2026-07-21', '2026-07-27'],
    )).rows[0].n;
    const d1 = await call('GET', '/admin/logs?startDate=2026-07-21&endDate=2026-07-27', { token: adminToken });
    check(d1.status === 200 && d1.data?.total === sqlRange, `range 21–27/07 → total = SQL (${sqlRange})`, `total=${d1.data?.total}`);
    check(d1.data?.total === 126, 'range 21–27/07 → 126 (valor esperado do seed de validação)', `total=${d1.data?.total}`);
    const d2 = await call('GET', '/admin/logs?startDate=21/07/2026', { token: adminToken });
    check(d2.status === 400, 'data malformada (21/07/2026) → 400, não 500', `HTTP ${d2.status}: ${d2.data?.error}`);
    const d3 = await call('GET', '/admin/logs?endDate=2026-13-01', { token: adminToken });
    check(d3.status === 400, 'data impossível (2026-13-01) → 400 (sanidade de calendário)', `HTTP ${d3.status}: ${d3.data?.error}`);

    // ── limit/offset na borda ─────────────────────────────────────────────────
    console.log('\n[PAGINAÇÃO]');
    const l1 = await call('GET', '/admin/logs?limit=200', { token: adminToken });
    check(l1.status === 400, 'limit=200 (acima do teto 100) → 400 (DECISÃO: sem clamp)', `HTTP ${l1.status}: ${l1.data?.error}`);
    const l2 = await call('GET', '/admin/logs?limit=abc', { token: adminToken });
    check(l2.status === 400, 'limit não-numérico → 400', `HTTP ${l2.status}`);
    const l3 = await call('GET', '/admin/logs?offset=-5', { token: adminToken });
    check(l3.status === 400, 'offset negativo → 400', `HTTP ${l3.status}`);
    const l4 = await call('GET', '/admin/logs?offset=100000', { token: adminToken });
    check(l4.status === 200 && l4.data?.logs?.length === 0 && l4.data?.total >= sqlTotal,
      'offset além do fim → logs:[] com total intacto', `logs=${l4.data?.logs?.length}, total=${l4.data?.total}`);
    // Duas páginas vizinhas não se sobrepõem (ORDER BY created_at DESC, id DESC estável)
    const p1 = await call('GET', '/admin/logs?limit=5&offset=0', { token: adminToken });
    const p2 = await call('GET', '/admin/logs?limit=5&offset=5', { token: adminToken });
    const ids1 = new Set((p1.data?.logs ?? []).map((l: any) => l.id));
    const overlap = (p2.data?.logs ?? []).filter((l: any) => ids1.has(l.id));
    check(p1.data?.logs?.length === 5 && p2.data?.logs?.length === 5 && overlap.length === 0,
      'páginas vizinhas (5+5) sem sobreposição de ids', `overlap=${overlap.length}`);
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_audit_logs FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_audit_logs PASSOU — contrato v1 do GET /admin/logs de pé, seed de validação intacto.');
}

main().catch((err) => {
  console.error('\n❌ smoke_audit_logs ABORTOU:', err?.message ?? err);
  process.exit(1);
});
