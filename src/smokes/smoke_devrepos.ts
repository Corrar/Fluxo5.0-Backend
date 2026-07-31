// src/smokes/smoke_devrepos.ts — smoke do dev-repos v1 (migration 018 + /dev-repos).
//
// COMO RODA: `npm run smoke:devrepos` e pronto — sobe O PRÓPRIO SERVIDOR numa PORTA LIVRE
// (pedida ao SO) e mata a ÁRVORE no fim. Sobe `src/server.ts` via ts-node (fonte, não dist/).
//   Override: com SMOKE_BASE_URL definido NÃO sobe nada e mira o alvo dado (regressão contra o
//   Render). O SQL continua indo pro DATABASE_URL do .env.
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO: repos e commits criados aqui morrem por ID exato no finally (commits
//   antes dos repos — ordem da FK). A page_key concedida ao 005 é INSERT/DELETE do par exato.
//   audit_logs NÃO é limpo (o livro é o livro).
//
// ⚠ SEGREDO: este smoke NUNCA imprime o valor de GITHUB_TOKEN. O caso (d) injeta um token
//   FALSO ('fake_x') só no processo do servidor efêmero, e as asserções olham status/mensagem —
//   nunca o header. Se um dia alguém logar o token num erro, o check (d2) quebra.
//
// ── POR QUE ESTE SMOKE NÃO CHAMA O GITHUB DE VERDADE ─────────────────────────────────────────
// A regra da casa é "teste que não passa pela via do usuário não prova nada". Aqui há uma
// EXCEÇÃO LEGÍTIMA e vale explicar a distinção, porque ela não é preguiça:
//   • `repo_commits` NÃO é domínio: é ESPELHO/cache de um sistema de terceiros. O dado não
//     nasce de uma decisão nossa, ele é COPIADO. Semear o espelho por SQL é encher um cache,
//     não forjar um fato de negócio.
//   • O que a via real provaria é o TRANSPORTE (autenticação, paginação do Link header) — e
//     isso depende de rede externa, token vivo e rate limit: flaky por construção, e um smoke
//     que falha sozinho vira smoke que ninguém roda.
//   • O que importa testar aqui — gate, bordas, 409, período, paginação, idempotência do
//     UPSERT e RESILIÊNCIA — é 100% nosso e é exercitado pela via real (HTTP).
// O transporte é provado UMA vez, à mão, contra o Render, na verificação pós-deploy.
//
// COBERTURA:
//   [GATE]     005 → 403 em tudo; concessão via user_permissions → 200 em tempo real; revogada → 403.
//   [CRUD]     bordas 400 (owner inválido, name > 100), duplicata → 409, DELETE com commits → 409,
//              DELETE sem commits → 204.
//   [SYNC-503] sem GITHUB_TOKEN no env do servidor → 503 limpo (nunca 500 misterioso).
//   [SYNC-502] token FALSO → 502, last_sync_status='erro', last_sync_error preenchido e o
//              ESPELHO INTACTO (a prova da resiliência) + last_synced_at NÃO avança.
//   [REPORT]   2 repos com datas espalhadas: períodos cortando certo (from/to inclusivos),
//              por_repo batendo, paginação (limit=2, offset além → vazio com total intacto),
//              repo_id filtrando, from > to → 400, ordenação estável, ultima_sync presente.
//   [ESPELHO]  re-UPSERT do mesmo (repo_id, sha) → zero duplicatas.
//   [AUDIT]    CRIAR_REPO, EDITAR_REPO, EXCLUIR_REPO no livro.
//
// Atores: 001 (admin — bypass do requirePermission), 005 (não-admin, sem a chave).

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';

const SENHA_SEED = 'Teste@123';
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

// ── Servidor efêmero ─────────────────────────────────────────────────────────
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

// envExtra permite subir o MESMO servidor com/sem GITHUB_TOKEN — é o que separa o 503 do 502.
function subirServidor(porta: number, envExtra: Record<string, string | undefined> = {}): { child: ChildProcess; log: () => string } {
  const linhas: string[] = [];
  const env: Record<string, any> = { ...process.env, PORT: String(porta), ...envExtra };
  // `undefined` no envExtra REMOVE a chave (não dá pra "desdefinir" por spread).
  for (const [k, v] of Object.entries(envExtra)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/server.ts'], {
    env,
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
  try { data = await res.json(); } catch { /* 204 e afins */ }
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
  const reposCriados: string[] = [];
  let permConcedida = false;
  let id005 = '';

  // O par (repo, sha) semeado — usado no cleanup e na prova de idempotência.
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const SHA_C = 'c'.repeat(40);

  try {
    if (BASE) {
      console.log('▶ smoke_devrepos — host de validação OK (ep-summer-wave); SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('▶ smoke_devrepos — host de validação OK (ep-summer-wave). Subindo servidor efêmero em', BASE);
      // Este servidor sobe SEM GITHUB_TOKEN de propósito: é ele que prova o 503.
      servidor = subirServidor(porta, { GITHUB_TOKEN: undefined });
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto (sem GITHUB_TOKEN — para o caso [SYNC-503])');
    }

    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const t001: string = admin.token;
    const t005: string = setor.token;
    id005 = setor.user.id;

    // ── [GATE] ────────────────────────────────────────────────────────────────
    console.log('\n[GATE] page_key dev_repos');
    const g1 = await call('GET', '/dev-repos', { token: t005 });
    check(g1.status === 403, '005 sem a chave: GET /dev-repos → 403', `HTTP ${g1.status}`);
    const g2 = await call('GET', '/dev-repos/report', { token: t005 });
    check(g2.status === 403, '005 sem a chave: GET /report → 403', `HTTP ${g2.status}`);
    const g3 = await call('POST', '/dev-repos/sync-all', { token: t005 });
    check(g3.status === 403, '005 sem a chave: POST /sync-all → 403', `HTTP ${g3.status}`);

    await pool.query(
      "INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'dev_repos') ON CONFLICT DO NOTHING", [id005]);
    permConcedida = true;
    const g4 = await call('GET', '/dev-repos', { token: t005 });
    check(g4.status === 200, 'chave concedida via user_permissions → 200 em tempo real (sem novo login)', `HTTP ${g4.status}`);

    await pool.query("DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'dev_repos'", [id005]);
    permConcedida = false;
    const g5 = await call('GET', '/dev-repos', { token: t005 });
    check(g5.status === 403, 'chave revogada → 403 de volta', `HTTP ${g5.status}`);

    // ── [SEED] a migration 018 semeou os 7 ────────────────────────────────────
    console.log('\n[SEED] os 7 repos da migration');
    const lista = await call('GET', '/dev-repos', { token: t001 });
    const nomes = (lista.data?.repos ?? []).map((r: any) => `${r.owner}/${r.name}`);
    check(lista.status === 200 && nomes.includes('Corrar/Fluxo5.0-Front') && nomes.includes('Corrar/Homolog-FluxoBack'),
      'os 7 repos do seed aparecem na lista', `total=${lista.data?.total}`);
    check((lista.data?.repos ?? []).every((r: any) => ['nunca', 'ok', 'erro'].includes(r.last_sync_status)),
      'todos com last_sync_status válido', `ex.: ${lista.data?.repos?.[0]?.last_sync_status}`);

    // ── [CRUD] bordas ─────────────────────────────────────────────────────────
    console.log('\n[CRUD] bordas e conflitos');
    const b1 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'Cor rar/x', name: 'ok' } });
    check(b1.status === 400, 'owner com caractere inválido → 400', `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'Corrar', name: 'x'.repeat(101) } });
    check(b2.status === 400, 'name com 101 caracteres → 400', `HTTP ${b2.status}: ${b2.data?.error}`);
    const b3 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'Corrar' } });
    check(b3.status === 400, 'name ausente → 400', `HTTP ${b3.status}: ${b3.data?.error}`);

    const c1 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'SmokeOrg', name: 'repo-alpha' } });
    check(c1.status === 201 && !!c1.data?.id, 'cadastro válido → 201', `HTTP ${c1.status}`);
    const repoA: string = c1.data.id;
    reposCriados.push(repoA);
    check(c1.data?.last_sync_status === 'nunca' && c1.data?.last_synced_at === null,
      'repo novo nasce com status "nunca" e sem last_synced_at', `status=${c1.data?.last_sync_status}`);

    const dup = await call('POST', '/dev-repos', { token: t001, body: { owner: 'SmokeOrg', name: 'repo-alpha' } });
    check(dup.status === 409, 'duplicata (mesmo owner/name) → 409', `HTTP ${dup.status}: ${dup.data?.error}`);

    const c2 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'SmokeOrg', name: 'repo-beta' } });
    const repoB: string = c2.data.id;
    reposCriados.push(repoB);
    check(c2.status === 201, 'segundo repo cadastrado', `HTTP ${c2.status}`);

    const e1 = await call('PUT', `/dev-repos/${repoA}`, { token: t001, body: { active: false } });
    check(e1.status === 200 && e1.data?.active === false, 'PUT parcial (active) → 200', `active=${e1.data?.active}`);
    const e2 = await call('PUT', `/dev-repos/${repoA}`, { token: t001, body: { active: true } });
    check(e2.status === 200 && e2.data?.active === true, 'PUT reativando → 200', `active=${e2.data?.active}`);
    const e3 = await call('PUT', `/dev-repos/${repoA}`, { token: t001, body: { owner: 'in valido' } });
    check(e3.status === 400, 'PUT com owner inválido → 400', `HTTP ${e3.status}`);
    const e4 = await call('PUT', `/dev-repos/${repoA}`, { token: t001, body: {} });
    check(e4.status === 400, 'PUT sem nenhum campo → 400', `HTTP ${e4.status}: ${e4.data?.error}`);

    // ── [SYNC-503] servidor sem GITHUB_TOKEN ──────────────────────────────────
    // Só roda no servidor efêmero: contra o Render o token EXISTE, e o 503 não teria como sair.
    if (!process.env.SMOKE_BASE_URL) {
      console.log('\n[SYNC-503] integração não configurada');
      const s503 = await call('POST', `/dev-repos/${repoA}/sync`, { token: t001 });
      check(s503.status === 503, 'sync sem GITHUB_TOKEN no env → 503 (não 500)', `HTTP ${s503.status}`);
      check(typeof s503.data?.error === 'string' && /não configurada/i.test(s503.data.error),
        '503 com mensagem acionável', `"${s503.data?.error}"`);
      check(!JSON.stringify(s503.data).toLowerCase().includes('token='),
        'a resposta do 503 não vaza valor de token', 'sem valor no corpo');
    } else {
      console.log('\n[SYNC-503] PULADO — alvo remoto tem GITHUB_TOKEN configurado (o 503 só sai sem a chave)');
    }

    // ── [ESPELHO] semeadura + idempotência ────────────────────────────────────
    // EXCEÇÃO LEGÍTIMA (ver cabeçalho): repo_commits é espelho, não domínio.
    console.log('\n[ESPELHO] semeadura por UPSERT e idempotência');
    const semear = (repo: string, sha: string, msg: string, data: string) => pool.query(
      `INSERT INTO repo_commits (repo_id, sha, message, author_name, author_date)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (repo_id, sha) DO NOTHING`,
      [repo, sha, msg, 'Bruno Corral', data]);

    await semear(repoA, SHA_A, 'feat: primeiro commit do smoke', '2026-07-10T12:00:00Z');
    await semear(repoA, SHA_B, 'fix: segundo commit do smoke', '2026-07-20T12:00:00Z');
    await semear(repoB, SHA_C, 'chore: commit do repo beta', '2026-07-25T12:00:00Z');
    const { rows: n1 } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = ANY($1::uuid[])', [[repoA, repoB]]);
    check(n1[0].n === 3, 'espelho semeado com 3 commits', `n=${n1[0].n}`);

    // O MESMO (repo_id, sha) de novo, com mensagem diferente: DO NOTHING não duplica nem
    // sobrescreve — o espelho é append-only por natureza.
    await semear(repoA, SHA_A, 'MENSAGEM DIFERENTE', '2026-07-10T12:00:00Z');
    const { rows: n2 } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = ANY($1::uuid[])', [[repoA, repoB]]);
    check(n2[0].n === 3, 're-UPSERT do mesmo (repo_id, sha) → ZERO duplicatas', `n=${n2[0].n}`);
    const { rows: msgOrig } = await pool.query(
      'SELECT message FROM repo_commits WHERE repo_id = $1 AND sha = $2', [repoA, SHA_A]);
    check(msgOrig[0].message === 'feat: primeiro commit do smoke',
      'DO NOTHING preserva a linha original (não sobrescreve)', `"${msgOrig[0].message}"`);

    // ── [CRUD] DELETE com e sem commits ───────────────────────────────────────
    console.log('\n[CRUD] DELETE protegido por histórico');
    const dA = await call('DELETE', `/dev-repos/${repoA}`, { token: t001 });
    check(dA.status === 409, 'DELETE de repo COM commits → 409', `HTTP ${dA.status}`);
    check(typeof dA.data?.error === 'string' && /desative/i.test(dA.data.error),
      '409 orienta a DESATIVAR (a saída, não só a recusa)', `"${dA.data?.error}"`);

    const c3 = await call('POST', '/dev-repos', { token: t001, body: { owner: 'SmokeOrg', name: 'repo-vazio' } });
    const repoVazio: string = c3.data.id;
    reposCriados.push(repoVazio);
    const dV = await call('DELETE', `/dev-repos/${repoVazio}`, { token: t001 });
    check(dV.status === 204, 'DELETE de repo SEM commits → 204', `HTTP ${dV.status}`);
    if (dV.status === 204) reposCriados.splice(reposCriados.indexOf(repoVazio), 1);

    // ── [REPORT] ──────────────────────────────────────────────────────────────
    console.log('\n[REPORT] período, resumo e paginação');
    const rTudo = await call('GET', `/dev-repos/report?from=2026-07-01&to=2026-07-31&repo_id=${repoA}`, { token: t001 });
    check(rTudo.status === 200 && rTudo.data?.total === 2, 'período cheio do repo A → 2 commits', `total=${rTudo.data?.total}`);
    check(rTudo.data?.commits?.[0]?.sha_curto?.length === 7, 'sha_curto tem 7 caracteres', `"${rTudo.data?.commits?.[0]?.sha_curto}"`);
    check(rTudo.data?.commits?.[0]?.message === 'fix: segundo commit do smoke',
      'ordenação author_date DESC (mais recente primeiro)', `"${rTudo.data?.commits?.[0]?.message}"`);
    check(rTudo.data?.ultima_sync !== undefined && rTudo.data?.repos_ativos > 0,
      'envelope traz ultima_sync e repos_ativos (o carimbo do espelho)', `ativos=${rTudo.data?.repos_ativos}`);

    // from/to INCLUSIVOS: o dia exato do commit entra dos dois lados.
    const rDia = await call('GET', `/dev-repos/report?from=2026-07-20&to=2026-07-20&repo_id=${repoA}`, { token: t001 });
    check(rDia.status === 200 && rDia.data?.total === 1, 'from=to no dia do commit → inclusivo dos dois lados', `total=${rDia.data?.total}`);

    const rCorte = await call('GET', `/dev-repos/report?from=2026-07-15&to=2026-07-31&repo_id=${repoA}`, { token: t001 });
    check(rCorte.data?.total === 1, 'período que corta fora o commit antigo → 1', `total=${rCorte.data?.total}`);

    const rGeral = await call('GET', '/dev-repos/report?from=2026-07-01&to=2026-07-31', { token: t001 });
    const porRepo: any[] = rGeral.data?.por_repo ?? [];
    const pA = porRepo.find((x) => x.repo_id === repoA);
    const pB = porRepo.find((x) => x.repo_id === repoB);
    check(pA?.count === 2 && pB?.count === 1, 'por_repo bate com o período (A=2, B=1)', `A=${pA?.count} B=${pB?.count}`);
    check(porRepo.reduce((s, x) => s + x.count, 0) <= rGeral.data?.total,
      'soma do por_repo é consistente com o total do período', `soma=${porRepo.reduce((s, x) => s + x.count, 0)} total=${rGeral.data?.total}`);

    const rFiltro = await call('GET', `/dev-repos/report?from=2026-07-01&to=2026-07-31&repo_id=${repoB}`, { token: t001 });
    check(rFiltro.data?.total === 1 && rFiltro.data?.commits?.every((c: any) => c.repo_id === repoB),
      'repo_id filtra de verdade', `total=${rFiltro.data?.total}`);

    const rPag = await call('GET', '/dev-repos/report?from=2026-07-01&to=2026-07-31&limit=2&offset=0', { token: t001 });
    check(rPag.data?.commits?.length === 2 && rPag.data?.total >= 3,
      'limit=2 corta a página mas NÃO o total (COUNT em query própria)', `pagina=${rPag.data?.commits?.length} total=${rPag.data?.total}`);
    const rAlem = await call('GET', '/dev-repos/report?from=2026-07-01&to=2026-07-31&limit=2&offset=9999', { token: t001 });
    check(rAlem.data?.commits?.length === 0 && rAlem.data?.total === rPag.data?.total,
      'offset além do fim → página vazia com total intacto', `total=${rAlem.data?.total}`);

    const v1 = await call('GET', '/dev-repos/report?from=2026-13-01&to=2026-07-31', { token: t001 });
    check(v1.status === 400, 'from com mês 13 → 400 (sanidade de calendário)', `HTTP ${v1.status}`);
    const v2 = await call('GET', '/dev-repos/report?from=2026-07-31&to=2026-07-01', { token: t001 });
    check(v2.status === 400, 'from > to → 400', `HTTP ${v2.status}: ${v2.data?.error}`);
    const v3 = await call('GET', '/dev-repos/report?limit=101', { token: t001 });
    check(v3.status === 400, 'limit acima do teto (101) → 400, não clamp', `HTTP ${v3.status}`);
    const v4 = await call('GET', '/dev-repos/report?repo_id=nao-e-uuid', { token: t001 });
    check(v4.status === 400, 'repo_id malformado → 400', `HTTP ${v4.status}`);

    // ── [SYNC-502] token FALSO: a prova da resiliência ────────────────────────
    if (!process.env.SMOKE_BASE_URL) {
      console.log('\n[SYNC-502] token inválido — espelho INTACTO');
      await matarArvore(servidor!.child);
      const porta2 = await portaLivre();
      BASE = `http://127.0.0.1:${porta2}`;
      // Token propositalmente inválido, só no processo do servidor. Nunca impresso.
      servidor = subirServidor(porta2, { GITHUB_TOKEN: 'fake_x' });
      await esperarHealth(servidor.child, servidor.log);
      const t001b = (await login('001@fluxoroyale.local', SENHA_SEED)).token;

      const antes = await pool.query('SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = $1', [repoA]);
      const s502 = await call('POST', `/dev-repos/${repoA}/sync`, { token: t001b });
      check(s502.status === 502, 'sync com token inválido → 502 (falha lá fora, não nossa)', `HTTP ${s502.status}`);

      const { rows: dep } = await pool.query(
        'SELECT last_sync_status, last_sync_error, last_synced_at FROM dev_repos WHERE id = $1', [repoA]);
      check(dep[0].last_sync_status === 'erro', 'last_sync_status vira "erro" (falha PERSISTIDA)', `status=${dep[0].last_sync_status}`);
      check(typeof dep[0].last_sync_error === 'string' && dep[0].last_sync_error.length > 0
        && dep[0].last_sync_error.length <= 500,
        'last_sync_error preenchido e truncado em 500', `${dep[0].last_sync_error?.length} chars: "${String(dep[0].last_sync_error).slice(0, 60)}…"`);
      check(dep[0].last_synced_at === null,
        'last_synced_at NÃO avança na falha (a janela não é pulada)', `${dep[0].last_synced_at}`);
      check(!String(dep[0].last_sync_error).includes('fake_x'),
        'o valor do token NÃO vaza na mensagem de erro persistida', 'sem o valor na mensagem');

      const depois = await pool.query('SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = $1', [repoA]);
      check(antes.rows[0].n === depois.rows[0].n,
        'ESPELHO INTACTO após a falha (nada apagado, nada meio-gravado)', `antes=${antes.rows[0].n} depois=${depois.rows[0].n}`);

      const rPos = await call('GET', `/dev-repos/report?from=2026-07-01&to=2026-07-31&repo_id=${repoA}`, { token: t001b });
      check(rPos.status === 200 && rPos.data?.total === 2,
        'relatório continua servindo o último estado bom mesmo com a sync falhada', `total=${rPos.data?.total}`);

      // sync-all: a falha de um não aborta os demais, e a resposta é o relatório por repo.
      const sAll = await call('POST', '/dev-repos/sync-all', { token: t001b });
      check(sAll.status === 200 && Array.isArray(sAll.data?.resultados) && sAll.data.resultados.length > 1,
        'sync-all responde 200 com resultado POR REPO mesmo com falhas', `repos=${sAll.data?.resultados?.length} com_erro=${sAll.data?.com_erro}`);
      check(sAll.data?.resultados?.every((r: any) => typeof r.repo === 'string' && ['ok', 'erro'].includes(r.status)),
        'cada resultado traz repo e status legíveis', `ex.: ${JSON.stringify(sAll.data?.resultados?.[0])}`);
    } else {
      console.log('\n[SYNC-502] PULADO — alvo remoto tem token válido (a prova do erro roda no servidor efêmero)');
    }

    // ── [AUDIT] ───────────────────────────────────────────────────────────────
    console.log('\n[AUDIT] actions do ciclo');
    for (const [action, esperado] of [['CRIAR_REPO', 3], ['EDITAR_REPO', 2], ['EXCLUIR_REPO', 1]] as const) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs
          WHERE action = $1 AND details->>'repo' LIKE 'SmokeOrg/%'`, [action]);
      check(rows[0].n >= esperado, `${action} no livro (>= ${esperado})`, `n=${rows[0].n}`);
    }
    const { rows: det } = await pool.query(
      `SELECT details FROM audit_logs WHERE action = 'EDITAR_REPO' AND details->>'repo' LIKE 'SmokeOrg/%'
        ORDER BY created_at DESC LIMIT 1`);
    check(Array.isArray(det[0]?.details?.alterados) && det[0].details.alterados.length > 0,
      'EDITAR_REPO registra {alterados}', JSON.stringify(det[0]?.details?.alterados));

  } finally {
    // ── Cleanup cirúrgico: commits antes dos repos (ordem da FK), por id exato ──
    try {
      if (reposCriados.length > 0) {
        const c = await pool.query('DELETE FROM repo_commits WHERE repo_id = ANY($1::uuid[])', [reposCriados]);
        const r = await pool.query('DELETE FROM dev_repos WHERE id = ANY($1::uuid[])', [reposCriados]);
        console.log(`\n  cleanup cirúrgico: ${c.rowCount} commit(s) e ${r.rowCount} repo(s) de teste removidos.`);
      }
      if (permConcedida && id005) {
        await pool.query("DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'dev_repos'", [id005]);
        console.log('  page_key do 005 revogada.');
      }
    } catch (e: any) {
      console.error('  ⚠ cleanup falhou:', e.message);
    }
    await pool.end().catch(() => { /* ignora */ });
    if (servidor) await matarArvore(servidor.child);
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_devrepos FALHOU — ${failures.length} verificação(ões):`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_devrepos PASSOU — gate, CRUD com bordas, 409 do histórico, 503/502 da integração, espelho intacto na falha, relatório por período com paginação, idempotência do UPSERT e auditoria conferidos; cleanup cirúrgico aplicado.');
}

main().catch((e) => { console.error('\n❌ smoke_devrepos ERRO:', e.message); process.exit(1); });
