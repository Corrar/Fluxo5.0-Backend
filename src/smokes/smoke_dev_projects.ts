// src/smokes/smoke_dev_projects.ts — smoke do dev-projetos v1 (migration 013 + /dev-projects).
//
// COMO RODA: igual aos smokes HTTP — server local no MESMO .env:
//   PORT=3999 node dist/server.js   e depois   npm run smoke:devprojects
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO: projetos criados aqui são deletados por id no finally; a exceção
//   'projetos' concedida ao 005 é INSERT/DELETE do par exato (nada de replace-all).
//
// COBERTURA:
//   [GATE]      005 sem 'projetos' → 403 no GET e no POST (router inteiro gateado).
//   [BORDA]     name vazio 400; priority inválida 400; checklists malformado 400; válido 201.
//   [OP]        op_code real vincula (JOIN devolve); inexistente 404; sem op_code cria
//               livre; PUT op_code:null desvincula.
//   [CICLO]     checklists aninhados persistem; arquivar some do GET default e aparece em
//               ?status=arquivado; reativar volta; ?status=xpto 400.
//   [DELETE]    hard delete → 404 no GET /:id.
//   [AUDITORIA] counts exatos das 5 actions do ciclo (CRIAR×2, EDITAR×2, ARQUIVAR,
//               REATIVAR, EXCLUIR) conferidos no banco por details->>'id'.
//   [PAGE_KEY]  'projetos' concedida ao 005 via user_permissions → 200 em tempo real →
//               revogada → 403 (o requirePermission consulta o banco a cada request).
//
// Atores: 001 (admin — bypass do requirePermission), 005 (não-admin, sem 'projetos').

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
  console.log('▶ smoke_dev_projects — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const projetosCriados: string[] = [];
  let permConcedida = false;
  let id005 = '';

  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    id005 = setor.user.id;

    // ── [GATE] router inteiro atrás de 'projetos' ────────────────────────────
    console.log('\n[GATE] 005 sem a page_key');
    const g1 = await call('GET', '/dev-projects', { token: setorToken });
    check(g1.status === 403, '005 GET /dev-projects → 403', `HTTP ${g1.status}`);
    const g2 = await call('POST', '/dev-projects', { token: setorToken, body: { name: 'x' } });
    check(g2.status === 403, '005 POST /dev-projects → 403', `HTTP ${g2.status}`);

    // ── [BORDA] criação ──────────────────────────────────────────────────────
    console.log('\n[BORDA] criação');
    const b1 = await call('POST', '/dev-projects', { token: adminToken, body: { name: '   ', description: 'x' } });
    check(b1.status === 400, 'name vazio → 400', `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/dev-projects', { token: adminToken, body: { name: 'X', priority: 'urgente' } });
    check(b2.status === 400, 'priority inválida → 400', `HTTP ${b2.status}: ${b2.data?.error}`);
    const b3 = await call('POST', '/dev-projects', { token: adminToken, body: { name: 'X', checklists: [{ titulo: 'ok', itens: 'não-é-lista' }] } });
    check(b3.status === 400, 'checklists malformado → 400', `HTTP ${b3.status}: ${b3.data?.error}`);
    const b4 = await call('POST', '/dev-projects', { token: adminToken, body: { name: 'X', color: 'rosa-choque' } });
    check(b4.status === 400, 'color fora da allowlist → 400', `HTTP ${b4.status}: ${b4.data?.error}`);

    const CHECKLISTS = [
      { titulo: 'Telas', itens: [{ t: 'Login', done: true }, { t: 'Lista', done: false }] },
      { titulo: 'API', itens: [{ t: 'Endpoint auth', done: true }] },
    ];
    const c1 = await call('POST', '/dev-projects', {
      token: adminToken,
      body: { name: 'SMOKE: App Mobile do Estoque', description: 'Versão Android', priority: 'alta', color: 'purple', checklists: CHECKLISTS },
    });
    check(c1.status === 201 && !!c1.data?.id, 'válido (checklists aninhados) → 201', `HTTP ${c1.status}`);
    const p1: string = c1.data.id;
    projetosCriados.push(p1);

    // ── [OP] vínculo opcional ────────────────────────────────────────────────
    console.log('\n[OP] vínculo opcional com client_services');
    const opReal = (await pool.query('SELECT op_code FROM client_services ORDER BY created_at LIMIT 1')).rows[0]?.op_code;
    if (!opReal) throw new Error('validação sem client_services — seed inesperado.');
    const c2 = await call('POST', '/dev-projects', { token: adminToken, body: { name: 'SMOKE: vinculado', op_code: opReal } });
    check(c2.status === 201, `cria vinculado à OP real (${opReal}) → 201`, `HTTP ${c2.status}`);
    const p2: string = c2.data.id;
    projetosCriados.push(p2);
    const d2 = await call('GET', `/dev-projects/${p2}`, { token: adminToken });
    check(d2.status === 200 && d2.data?.op_code === opReal, 'GET /:id devolve o op_code via JOIN', `op_code=${d2.data?.op_code}`);
    const cFantasma = await call('POST', '/dev-projects', { token: adminToken, body: { name: 'X', op_code: 'OP-FANTASMA-999' } });
    check(cFantasma.status === 404, 'op_code inexistente → 404', `HTTP ${cFantasma.status}: ${cFantasma.data?.error}`);
    const d1 = await call('GET', `/dev-projects/${p1}`, { token: adminToken });
    check(d1.status === 200 && d1.data?.client_service_id === null, 'sem op_code cria LIVRE (client_service_id null)', `csid=${d1.data?.client_service_id}`);
    const desv = await call('PUT', `/dev-projects/${p2}`, { token: adminToken, body: { op_code: null } });
    check(desv.status === 200, 'PUT op_code:null → 200 (desvincula)', `HTTP ${desv.status}`);
    const d2b = await call('GET', `/dev-projects/${p2}`, { token: adminToken });
    check(d2b.data?.client_service_id === null && d2b.data?.op_code === null, 'desvinculado no banco (JOIN devolve null)', `csid=${d2b.data?.client_service_id}`);

    // ── [CICLO] checklists + arquivar/reativar + filtros ─────────────────────
    console.log('\n[CICLO] edição, arquivamento e filtros');
    const NOVOS = [
      { titulo: 'Telas', itens: [{ t: 'Login', done: true }, { t: 'Lista', done: true }, { t: 'Scanner', done: false }] },
      { titulo: 'API', itens: [{ t: 'Endpoint auth', done: true }] },
      { titulo: 'Deploy', itens: [{ t: 'Pipeline', done: false }] },
    ];
    const e1 = await call('PUT', `/dev-projects/${p1}`, { token: adminToken, body: { checklists: NOVOS } });
    check(e1.status === 200, 'edita checklists → 200', `HTTP ${e1.status}`);
    const d1b = await call('GET', `/dev-projects/${p1}`, { token: adminToken });
    // Comparação CANÔNICA: o jsonb do Postgres não preserva ordem de CHAVES nos objetos
    // ({titulo, itens} volta {itens, titulo}); a ordem dos ARRAYS é preservada — e é ela
    // que importa. Reconstruímos com ordem de chave fixa antes do stringify.
    const canon = (cls: any[]) => (cls ?? []).map((c: any) => ({
      titulo: c.titulo, itens: (c.itens ?? []).map((i: any) => ({ t: i.t, done: i.done })),
    }));
    check(JSON.stringify(canon(d1b.data?.checklists)) === JSON.stringify(canon(NOVOS as any)),
      'estrutura aninhada persiste EXATA (3 checklists, dones preservados)', `${d1b.data?.checklists?.length} checklist(s)`);

    const arq = await call('PUT', `/dev-projects/${p1}`, { token: adminToken, body: { status: 'arquivado' } });
    check(arq.status === 200, 'arquiva → 200', `HTTP ${arq.status}`);
    const lAtivo = await call('GET', '/dev-projects', { token: adminToken });
    check(lAtivo.status === 200 && !lAtivo.data?.projects?.some((p: any) => p.id === p1),
      'arquivado SOME do GET default (ativo)', `total=${lAtivo.data?.total}`);
    const lArq = await call('GET', '/dev-projects?status=arquivado', { token: adminToken });
    check(lArq.status === 200 && lArq.data?.projects?.some((p: any) => p.id === p1),
      'aparece em ?status=arquivado', `total=${lArq.data?.total}`);
    const lXpto = await call('GET', '/dev-projects?status=xpto', { token: adminToken });
    check(lXpto.status === 400, '?status=xpto → 400', `HTTP ${lXpto.status}`);
    const rea = await call('PUT', `/dev-projects/${p1}`, { token: adminToken, body: { status: 'ativo' } });
    check(rea.status === 200, 'reativa → 200', `HTTP ${rea.status}`);
    const lAtivo2 = await call('GET', '/dev-projects', { token: adminToken });
    check(lAtivo2.data?.projects?.some((p: any) => p.id === p1), 'reativado volta ao GET default', `total=${lAtivo2.data?.total}`);

    // ── [DELETE] hard delete ─────────────────────────────────────────────────
    console.log('\n[DELETE] hard delete');
    const del = await call('DELETE', `/dev-projects/${p2}`, { token: adminToken });
    check(del.status === 200, 'DELETE → 200', `HTTP ${del.status}`);
    const d2c = await call('GET', `/dev-projects/${p2}`, { token: adminToken });
    check(d2c.status === 404, 'GET /:id do excluído → 404', `HTTP ${d2c.status}`);

    // ── [AUDITORIA] counts exatos por action ─────────────────────────────────
    console.log('\n[AUDITORIA] actions do ciclo no banco');
    const aud = await pool.query(
      `SELECT action FROM audit_logs WHERE details->>'id' = ANY($1)`, [[p1, p2]],
    );
    const conta = (a: string) => aud.rows.filter((r: any) => r.action === a).length;
    check(conta('CRIAR_PROJETO') === 2, '2× CRIAR_PROJETO (livre + vinculado)', `${conta('CRIAR_PROJETO')}`);
    check(conta('EDITAR_PROJETO') === 2, '2× EDITAR_PROJETO (checklists + desvincular)', `${conta('EDITAR_PROJETO')}`);
    check(conta('ARQUIVAR_PROJETO') === 1, '1× ARQUIVAR_PROJETO', `${conta('ARQUIVAR_PROJETO')}`);
    check(conta('REATIVAR_PROJETO') === 1, '1× REATIVAR_PROJETO', `${conta('REATIVAR_PROJETO')}`);
    check(conta('EXCLUIR_PROJETO') === 1, '1× EXCLUIR_PROJETO', `${conta('EXCLUIR_PROJETO')}`);

    // ── [PAGE_KEY] concessão em tempo real ───────────────────────────────────
    console.log('\n[PAGE_KEY] projetos concedida/revogada em tempo real');
    const jaTinha = await pool.query(`SELECT 1 FROM user_permissions WHERE user_id=$1 AND page_key='projetos'`, [id005]);
    if (jaTinha.rows.length > 0) throw new Error("005 já tem 'projetos' — estado inesperado do seed, abortando.");
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'projetos')`, [id005]);
    permConcedida = true;
    const gOk = await call('GET', '/dev-projects', { token: setorToken });
    check(gOk.status === 200, "005 COM 'projetos' via user_permissions → 200 (sem novo login)", `HTTP ${gOk.status}`);
    await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND page_key='projetos'`, [id005]);
    permConcedida = false;
    const gNeg = await call('GET', '/dev-projects', { token: setorToken });
    check(gNeg.status === 403, 'revogada → 403 de volta', `HTTP ${gNeg.status}`);
  } finally {
    // CLEANUP CIRÚRGICO por id exato (p2 já foi pelo próprio ciclo; DELETE é idempotente).
    try {
      if (permConcedida && id005) {
        await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND page_key='projetos'`, [id005]);
        console.log('  cleanup: exceção projetos do 005 removida (rede de segurança).');
      }
      if (projetosCriados.length > 0) {
        const dt = await pool.query('DELETE FROM dev_projects WHERE id = ANY($1)', [projetosCriados]);
        console.log(`  cleanup cirúrgico: ${dt.rowCount} projeto(s) de teste removido(s).`);
      }
      const n = await pool.query('SELECT COUNT(*)::int AS n FROM dev_projects');
      console.log(`  dev_projects restantes: ${n.rows[0].n}`);
    } catch (e: any) {
      console.error('  ‼ FALHA no cleanup — conferir dev_projects/user_permissions manualmente!', e?.message);
    }
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_dev_projects FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_dev_projects PASSOU — gate, borda, OP opcional, ciclo, delete, auditoria e page_key em tempo real conferidos; cleanup cirúrgico aplicado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_dev_projects ABORTOU:', err?.message ?? err);
  process.exit(1);
});
