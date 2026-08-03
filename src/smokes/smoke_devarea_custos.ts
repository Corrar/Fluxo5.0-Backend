// src/smokes/smoke_devarea_custos.ts — smoke da Área Dev + Custos & Serviços (migration 019).
//
// COMO RODA: `npm run smoke:devarea` e pronto — sobe O PRÓPRIO SERVIDOR numa PORTA LIVRE
// (pedida ao SO) e mata a ÁRVORE no fim. Sobe `src/server.ts` via ts-node (fonte, não dist/).
//   Override: com SMOKE_BASE_URL definido NÃO sobe nada e mira o alvo dado (regressão contra o
//   Render). O SQL continua indo pro DATABASE_URL do .env.
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO: tudo que este smoke cria morre por ID EXATO no finally. Nada de
//   DELETE global — a regra que já custou o seed da validação duas vezes.
//   audit_logs NÃO é limpo (o livro é o livro).
// ⚠ SEGREDO: nenhum valor de env é impresso. O snippet de teste usa um texto INOFENSIVO de
//   propósito — e o check [SNIP-LOG] prova que o CÓDIGO do snippet não vai parar no livro da
//   Auditoria (onde credencial colada por descuido viraria um segundo vazamento).
//
// A CONTA DE PAPEL (o coração do [TOTAL]):
//   189,00 mensal + 84,00 mensal + 264,00 anual
//   → 189 + 84 + (264/12 = 22) = 295,00 EXATO
//   A asserção é de STRING ('295.00'), não de float: numeric de ponta a ponta. Se um dia
//   alguém trocar numeric por float no caminho, este check quebra com '294.99999999999994'.
//
// COBERTURA:
//   [GATE]    005 → 403 nas duas famílias; concessão via user_permissions → 200 em tempo real;
//             revogada → 403. As duas chaves são INDEPENDENTES (dev_area não abre dev_custos).
//   [BORDA]   400 em kind/category/cycle fora do CHECK, value<=0, day irreal, end<=start,
//             from>to, título/nome vazio, limit fora do teto.
//   [CICLO]   criar→ler→editar→excluir de bloco, nota, snippet e custo, com re-GET provando
//             a persistência (o equivalente ao F5 do usuário).
//   [TOTAL]   295,00 exato + por_categoria batendo com a soma manual.
//   [PERIODO] ?from=&to= cortando certo, com a inclusividade das duas pontas provada.
//   [BUSCA]   ?q= achando por label E por code; paginação com offset além → [] e total intacto.
//   [AUDIT]   as 8 actions no livro.
//   [REGRESS] tickets + devprojects + pricing3d + assembly + devrepos + rbac.
//
// Atores: 001 (admin — bypass do requirePermission), 005 (não-admin, sem as chaves).

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

  // Tudo criado aqui é rastreado por id e morre no finally.
  const blocosCriados: string[] = [];
  const notasCriadas: string[] = [];
  const snippetsCriados: string[] = [];
  const custosCriados: string[] = [];
  let permsConcedidas = false;
  let id005 = '';

  // Datas do teste de período — fixas e distantes do "hoje" pra não colidir com dado real.
  const D1 = '2031-03-10';
  const D2 = '2031-03-15';
  const D3 = '2031-03-20';

  try {
    if (BASE) {
      console.log('▶ smoke_devarea_custos — host de validação OK (ep-summer-wave); SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('▶ smoke_devarea_custos — host de validação OK (ep-summer-wave). Subindo servidor efêmero em', BASE);
      servidor = subirServidor(porta);
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto');
    }

    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const t001: string = admin.token;
    const t005: string = setor.token;
    id005 = setor.user.id;

    // ── [GATE] ────────────────────────────────────────────────────────────────
    console.log('\n[GATE] page_keys dev_area e dev_custos');
    const g1 = await call('GET', '/dev-area/blocks', { token: t005 });
    check(g1.status === 403, '005 sem chave: GET /dev-area/blocks → 403', `HTTP ${g1.status}`);
    const g2 = await call('GET', '/dev-area/notes', { token: t005 });
    check(g2.status === 403, '005 sem chave: GET /dev-area/notes → 403', `HTTP ${g2.status}`);
    const g3 = await call('GET', '/dev-area/snippets', { token: t005 });
    check(g3.status === 403, '005 sem chave: GET /dev-area/snippets → 403', `HTTP ${g3.status}`);
    const g4 = await call('GET', '/dev-costs', { token: t005 });
    check(g4.status === 403, '005 sem chave: GET /dev-costs → 403', `HTTP ${g4.status}`);
    const g5 = await call('POST', '/dev-area/blocks', { token: t005, body: { kind: 'tarefa', day: D1, category: 'foco', title: 'x' } });
    check(g5.status === 403, '005 sem chave: POST /dev-area/blocks → 403', `HTTP ${g5.status}`);

    // Concede SÓ dev_area primeiro: prova que as duas chaves são INDEPENDENTES.
    await pool.query(
      `INSERT INTO user_permissions (user_id, page_key) VALUES ($1,'dev_area') ON CONFLICT DO NOTHING`, [id005]);
    permsConcedidas = true;
    const g6 = await call('GET', '/dev-area/blocks', { token: t005 });
    check(g6.status === 200, '005 com dev_area: GET /dev-area/blocks → 200', `HTTP ${g6.status}`);
    const g7 = await call('GET', '/dev-costs', { token: t005 });
    check(g7.status === 403, 'dev_area NÃO abre dev_custos (chaves independentes) → 403', `HTTP ${g7.status}`);

    await pool.query(
      `INSERT INTO user_permissions (user_id, page_key) VALUES ($1,'dev_custos') ON CONFLICT DO NOTHING`, [id005]);
    const g8 = await call('GET', '/dev-costs', { token: t005 });
    check(g8.status === 200, '005 com dev_custos: GET /dev-costs → 200', `HTTP ${g8.status}`);

    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key IN ('dev_area','dev_custos')`, [id005]);
    permsConcedidas = false;
    const g9 = await call('GET', '/dev-area/blocks', { token: t005 });
    const g10 = await call('GET', '/dev-costs', { token: t005 });
    check(g9.status === 403 && g10.status === 403, 'revogadas: as duas voltam a 403 em tempo real', `HTTP ${g9.status}/${g10.status}`);

    // ── [BORDA] ───────────────────────────────────────────────────────────────
    console.log('\n[BORDA] 400 em tudo que o CHECK do banco recusaria');
    const b1 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'reuniao', day: D1, category: 'foco', title: 'x' } });
    check(b1.status === 400, "kind fora do CHECK ('reuniao') → 400", `HTTP ${b1.status}`);
    const b2 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'tarefa', day: D1, category: 'almoco', title: 'x' } });
    check(b2.status === 400, "category fora do CHECK ('almoco') → 400", `HTTP ${b2.status}`);
    const b3 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'tarefa', day: '2031-02-30', category: 'foco', title: 'x' } });
    check(b3.status === 400, 'day irreal (2031-02-30) → 400', `HTTP ${b3.status}`);
    const b4 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'evento', day: D1, category: 'foco', title: 'x', start_t: '10:00', end_t: '09:00' } });
    check(b4.status === 400, 'end_t <= start_t → 400', `HTTP ${b4.status}`);
    const b5 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'evento', day: D1, category: 'foco', title: '   ' } });
    check(b5.status === 400, 'title vazio → 400', `HTTP ${b5.status}`);
    const b6 = await call('GET', `/dev-area/blocks?from=${D3}&to=${D1}`, { token: t001 });
    check(b6.status === 400, 'from > to → 400 (não lista vazia)', `HTTP ${b6.status}`);
    const b7 = await call('GET', '/dev-area/snippets?limit=101', { token: t001 });
    check(b7.status === 400, 'limit acima do teto (101) → 400, sem clamp mudo', `HTTP ${b7.status}`);
    const b8 = await call('POST', '/dev-costs', { token: t001, body: { name: 'x', category: 'infra', value: 0, cycle: 'mensal' } });
    check(b8.status === 400, 'value = 0 → 400', `HTTP ${b8.status}`);
    const b9 = await call('POST', '/dev-costs', { token: t001, body: { name: 'x', category: 'infra', value: -5, cycle: 'mensal' } });
    check(b9.status === 400, 'value negativo → 400', `HTTP ${b9.status}`);
    const b10 = await call('POST', '/dev-costs', { token: t001, body: { name: 'x', category: 'infra', value: 10, cycle: 'semanal' } });
    check(b10.status === 400, "cycle fora do CHECK ('semanal') → 400", `HTTP ${b10.status}`);
    const b11 = await call('POST', '/dev-costs', { token: t001, body: { name: '', category: 'infra', value: 10, cycle: 'mensal' } });
    check(b11.status === 400, 'name vazio → 400', `HTTP ${b11.status}`);
    const b12 = await call('PUT', '/dev-costs/nao-e-uuid', { token: t001, body: { value: 10 } });
    check(b12.status === 400, 'id não-UUID → 400 (nunca 500)', `HTTP ${b12.status}`);

    // ── [CICLO] blocos ────────────────────────────────────────────────────────
    console.log('\n[CICLO] bloco de agenda: criar → ler → editar → excluir');
    const c1 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'evento', day: D2, category: 'reuniao', title: 'SMOKE 019 reuniao', start_t: '09:00', end_t: '10:30' } });
    check(c1.status === 201, 'POST bloco (evento com hora) → 201', `HTTP ${c1.status}`);
    if (c1.data?.id) blocosCriados.push(c1.data.id);
    const c2 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'tarefa', day: D1, category: 'foco', title: 'SMOKE 019 tarefa sem hora' } });
    check(c2.status === 201 && c2.data?.start_t === null, 'POST tarefa SEM hora → 201 com start_t null (ausência, não 00:00)', `start_t=${JSON.stringify(c2.data?.start_t)}`);
    if (c2.data?.id) blocosCriados.push(c2.data.id);

    const c3 = await call('PUT', `/dev-area/blocks/${c2.data.id}`, { token: t001, body: { done: true } });
    check(c3.status === 200 && c3.data?.done === true, 'PUT parcial marcando done → 200 com done=true', `done=${c3.data?.done}`);
    // Re-GET = o F5 do usuário: prova que persistiu, não que o retorno do PUT era otimista.
    const c4 = await call('GET', `/dev-area/blocks?from=${D1}&to=${D1}`, { token: t001 });
    const achado = (c4.data?.items ?? []).find((x: any) => x.id === c2.data.id);
    check(achado?.done === true, 're-GET confirma done=true (persistiu de verdade)', `done=${achado?.done}`);

    const c5 = await call('PUT', `/dev-area/blocks/${c1.data.id}`, { token: t001, body: { end_t: '08:00' } });
    check(c5.status === 400, 'PUT parcial só com end_t inválido contra o start_t GRAVADO → 400', `HTTP ${c5.status}`);

    // ── [PERIODO] ─────────────────────────────────────────────────────────────
    console.log('\n[PERIODO] ?from=&to= com as duas pontas inclusivas');
    const c6 = await call('POST', '/dev-area/blocks', { token: t001, body: { kind: 'tarefa', day: D3, category: 'estudo', title: 'SMOKE 019 fora da janela' } });
    if (c6.data?.id) blocosCriados.push(c6.data.id);

    const p1 = await call('GET', `/dev-area/blocks?from=${D1}&to=${D2}`, { token: t001 });
    const ids1 = (p1.data?.items ?? []).map((x: any) => x.id);
    check(ids1.includes(c2.data.id) && ids1.includes(c1.data.id) && !ids1.includes(c6.data.id),
      `janela ${D1}..${D2} inclui as duas pontas e exclui ${D3}`, `${ids1.length} item(ns)`);
    const p2 = await call('GET', `/dev-area/blocks?from=${D3}&to=${D3}`, { token: t001 });
    const ids2 = (p2.data?.items ?? []).map((x: any) => x.id);
    check(ids2.includes(c6.data.id) && !ids2.includes(c1.data.id), 'janela de um dia só devolve o daquele dia', `${ids2.length} item(ns)`);

    // ── [CICLO] notas ─────────────────────────────────────────────────────────
    console.log('\n[CICLO] nota: criar → fixar/tags/cor → ler → excluir');
    const n1 = await call('POST', '/dev-area/notes', { token: t001, body: { body: 'SMOKE 019 nota', tags: ['smoke', 'teste'], color: '#f59e0b' } });
    check(n1.status === 201 && Array.isArray(n1.data?.tags) && n1.data.tags.length === 2, 'POST nota com tags e cor → 201', `tags=${JSON.stringify(n1.data?.tags)}`);
    if (n1.data?.id) notasCriadas.push(n1.data.id);
    const n2 = await call('PUT', `/dev-area/notes/${n1.data.id}`, { token: t001, body: { pinned: true, tags: ['smoke'] } });
    check(n2.status === 200 && n2.data?.pinned === true && n2.data?.tags.length === 1, 'PUT parcial (pin + tags) → 200', `pinned=${n2.data?.pinned} tags=${JSON.stringify(n2.data?.tags)}`);
    const n3 = await call('POST', '/dev-area/notes', { token: t001, body: { body: 'x', color: 'javascript:alert(1)' } });
    check(n3.status === 400, 'cor fora do formato (payload arbitrário) → 400', `HTTP ${n3.status}`);
    const n4 = await call('GET', '/dev-area/notes', { token: t001 });
    const primeira = (n4.data?.items ?? [])[0];
    check(primeira?.id === n1.data.id, 'nota fixada vem primeiro na listagem', `1a=${primeira?.id === n1.data.id ? 'a fixada' : 'outra'}`);

    // ── [CICLO+BUSCA] snippets ────────────────────────────────────────────────
    console.log('\n[BUSCA] snippets: ?q= por label E por code, paginação');
    const s1 = await call('POST', '/dev-area/snippets', { token: t001, body: { label: 'SMOKE019 rotulo alfa', code: 'SELECT smoke_019_conteudo FROM tabela;' } });
    check(s1.status === 201, 'POST snippet → 201', `HTTP ${s1.status}`);
    if (s1.data?.id) snippetsCriados.push(s1.data.id);
    const s2 = await call('POST', '/dev-area/snippets', { token: t001, body: { label: 'SMOKE019 rotulo beta', code: 'console.log("beta");' } });
    if (s2.data?.id) snippetsCriados.push(s2.data.id);

    const q1 = await call('GET', '/dev-area/snippets?q=SMOKE019%20rotulo%20alfa', { token: t001 });
    check(q1.data?.total === 1 && q1.data.items[0].id === s1.data.id, 'busca por LABEL acha só o alfa', `total=${q1.data?.total}`);
    const q2 = await call('GET', '/dev-area/snippets?q=smoke_019_conteudo', { token: t001 });
    check(q2.data?.total === 1 && q2.data.items[0].id === s1.data.id, 'busca por CODE (conteúdo) acha o alfa', `total=${q2.data?.total}`);
    const q3 = await call('GET', '/dev-area/snippets?q=SMOKE019&limit=2&offset=0', { token: t001 });
    check(q3.data?.total === 2 && q3.data.items.length === 2, 'paginação: limit=2 devolve 2 com total=2', `itens=${q3.data?.items?.length} total=${q3.data?.total}`);
    const q4 = await call('GET', '/dev-area/snippets?q=SMOKE019&limit=2&offset=99', { token: t001 });
    check(q4.data?.items?.length === 0 && q4.data?.total === 2, 'offset além do fim → [] com o total INTACTO', `itens=${q4.data?.items?.length} total=${q4.data?.total}`);

    // ── [TOTAL] a conta de papel ──────────────────────────────────────────────
    console.log('\n[TOTAL] 189 mensal + 84 mensal + 264 anual → 295,00 exato');
    // A tabela pode ter dado de sessões anteriores: mede o total ANTES e compara o DELTA.
    // Assim a conta de papel é provada sem exigir tabela vazia (e sem apagar dado de ninguém).
    const antes = await call('GET', '/dev-costs', { token: t001 });
    const totalAntes = Number(antes.data?.total_mensal ?? 0);

    const k1 = await call('POST', '/dev-costs', { token: t001, body: { name: 'SMOKE019 infra mensal', category: 'infra', value: '189.00', cycle: 'mensal' } });
    if (k1.data?.id) custosCriados.push(k1.data.id);
    const k2 = await call('POST', '/dev-costs', { token: t001, body: { name: 'SMOKE019 ia mensal', category: 'ia', value: '84.00', cycle: 'mensal' } });
    if (k2.data?.id) custosCriados.push(k2.data.id);
    const k3 = await call('POST', '/dev-costs', { token: t001, body: { name: 'SMOKE019 saas anual', category: 'saas', value: '264.00', cycle: 'anual' } });
    if (k3.data?.id) custosCriados.push(k3.data.id);

    check(k3.data?.value === '264.00', 'numeric chega como STRING (não float)', `value=${JSON.stringify(k3.data?.value)}`);

    const dep = await call('GET', '/dev-costs', { token: t001 });
    const totalDepois = Number(dep.data?.total_mensal ?? 0);
    const delta = (totalDepois - totalAntes).toFixed(2);
    check(delta === '295.00', 'DELTA do total_mensal = 295.00 EXATO (189 + 84 + 264/12)', `delta=${delta}`);

    const anual = (dep.data?.items ?? []).find((x: any) => x.id === k3.data.id);
    check(anual?.mensal_equivalente === '22.00', 'anual de 264,00 → mensal_equivalente 22.00 (string exata)', `mensal_equivalente=${JSON.stringify(anual?.mensal_equivalente)}`);

    // por_categoria: confere a categoria 'ia' contra a soma manual das linhas de 'ia'.
    const catIa = (dep.data?.por_categoria ?? []).find((c: any) => c.category === 'ia');
    const somaIaManual = (dep.data?.items ?? [])
      .filter((x: any) => x.category === 'ia')
      .reduce((acc: number, x: any) => acc + Number(x.mensal_equivalente), 0)
      .toFixed(2);
    check(catIa && Number(catIa.total_mensal).toFixed(2) === somaIaManual,
      'por_categoria[ia] bate com a soma manual das linhas de ia', `endpoint=${catIa?.total_mensal} manual=${somaIaManual}`);

    // Soma de TODAS as categorias tem que fechar o total — a prova de que as duas expressões
    // usam a MESMA normalização (é isto que a "fonte de verdade única" promete).
    const somaCats = (dep.data?.por_categoria ?? [])
      .reduce((acc: number, c: any) => acc + Number(c.total_mensal), 0).toFixed(2);
    check(somaCats === Number(dep.data?.total_mensal).toFixed(2),
      'soma das categorias == total_mensal (mesma fonte de verdade)', `cats=${somaCats} total=${dep.data?.total_mensal}`);

    // ── [CICLO] custo: edição de valor persiste ───────────────────────────────
    console.log('\n[CICLO] custo: editar valor → total acompanha');
    const e1 = await call('PUT', `/dev-costs/${k2.data.id}`, { token: t001, body: { value: '100.00' } });
    check(e1.status === 200 && e1.data?.value === '100.00', 'PUT valor 84 → 100 persiste', `value=${JSON.stringify(e1.data?.value)}`);
    const dep2 = await call('GET', '/dev-costs', { token: t001 });
    const delta2 = (Number(dep2.data?.total_mensal) - totalAntes).toFixed(2);
    check(delta2 === '311.00', 'total recalculado sozinho: 189 + 100 + 22 = 311,00', `delta=${delta2}`);

    // ── [AUDIT] ───────────────────────────────────────────────────────────────
    console.log('\n[AUDIT] as actions no livro');
    const acoes = await pool.query(
      `SELECT action, COUNT(*)::int AS n FROM audit_logs
        WHERE action IN ('CRIAR_BLOCO_AREA','EDITAR_BLOCO_AREA','EXCLUIR_BLOCO_AREA',
                         'CRIAR_NOTA','EDITAR_NOTA','CRIAR_SNIPPET','CRIAR_CUSTO','EDITAR_CUSTO')
          AND created_at > now() - interval '10 minutes'
        GROUP BY action ORDER BY action`);
    const mapa = Object.fromEntries(acoes.rows.map((r: any) => [r.action, r.n]));
    for (const a of ['CRIAR_BLOCO_AREA', 'EDITAR_BLOCO_AREA', 'CRIAR_NOTA', 'EDITAR_NOTA', 'CRIAR_SNIPPET', 'CRIAR_CUSTO', 'EDITAR_CUSTO']) {
      check((mapa[a] ?? 0) > 0, `livro registrou ${a}`, `${mapa[a] ?? 0}x`);
    }

    // [SNIP-LOG] o código do snippet NÃO pode estar no livro — credencial colada por descuido
    // não vira um segundo vazamento na tela de Auditoria.
    const vaz = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE action = 'CRIAR_SNIPPET' AND details::text ILIKE '%smoke_019_conteudo%'`);
    check(vaz.rows[0].n === 0, '[SNIP-LOG] o CÓDIGO do snippet não vaza pro livro (só id + label)', `${vaz.rows[0].n} ocorrência(s)`);

    // ── [CICLO] exclusões ─────────────────────────────────────────────────────
    console.log('\n[CICLO] exclusões pela via real');
    const d1 = await call('DELETE', `/dev-area/blocks/${c6.data.id}`, { token: t001 });
    check(d1.status === 204, 'DELETE bloco → 204', `HTTP ${d1.status}`);
    if (d1.status === 204) blocosCriados.splice(blocosCriados.indexOf(c6.data.id), 1);
    const d2 = await call('DELETE', `/dev-area/blocks/${c6.data.id}`, { token: t001 });
    check(d2.status === 404, 'DELETE do mesmo id de novo → 404', `HTTP ${d2.status}`);
    const d3 = await call('DELETE', `/dev-area/snippets/${s2.data.id}`, { token: t001 });
    check(d3.status === 204, 'DELETE snippet → 204', `HTTP ${d3.status}`);
    if (d3.status === 204) snippetsCriados.splice(snippetsCriados.indexOf(s2.data.id), 1);
    const d4 = await call('DELETE', `/dev-costs/${k3.data.id}`, { token: t001 });
    check(d4.status === 204, 'DELETE custo → 204', `HTTP ${d4.status}`);
    if (d4.status === 204) custosCriados.splice(custosCriados.indexOf(k3.data.id), 1);
    const dep3 = await call('GET', '/dev-costs', { token: t001 });
    const delta3 = (Number(dep3.data?.total_mensal) - totalAntes).toFixed(2);
    check(delta3 === '289.00', 'excluir o anual tira 22,00 do total: 189 + 100 = 289,00', `delta=${delta3}`);

    // ── [REGRESS] ─────────────────────────────────────────────────────────────
    console.log('\n[REGRESS] o resto da casa continua de pé');
    const r1 = await call('GET', '/tickets', { token: t001 });
    check(r1.status === 200, 'GET /tickets → 200', `HTTP ${r1.status}`);
    const r2 = await call('GET', '/dev-projects', { token: t001 });
    check(r2.status === 200, 'GET /dev-projects → 200', `HTTP ${r2.status}`);
    const r3 = await call('GET', '/dev-dashboard', { token: t001 });
    check(r3.status === 200, 'GET /dev-dashboard → 200', `HTTP ${r3.status}`);
    const r4 = await call('GET', '/dev-repos', { token: t001 });
    check(r4.status === 200, 'GET /dev-repos → 200', `HTTP ${r4.status}`);
    // 200 EXATO, não "200 ou 404": um check que passa com 404 provaria apenas que o caminho
    // está errado. Foi o que aconteceu na primeira execução deste smoke — os dois passavam
    // verdes contra rotas inexistentes.
    const r5 = await call('GET', '/producao-3d/pricing', { token: t001 });
    check(r5.status === 200, 'GET /producao-3d/pricing → 200', `HTTP ${r5.status}`);
    const r6 = await call('GET', '/assembly-machines', { token: t001 });
    check(r6.status === 200, 'GET /assembly-machines → 200', `HTTP ${r6.status}`);
    const r7 = await call('GET', '/dev-area/blocks', { token: t005 });
    check(r7.status === 403, 'RBAC intacto no fim: 005 segue barrado', `HTTP ${r7.status}`);

  } finally {
    // ── CLEANUP CIRÚRGICO: por ID EXATO, nunca global ───────────────────────────
    console.log('\n[CLEANUP] removendo só o que este smoke criou, por id');
    try {
      for (const id of blocosCriados) await pool.query('DELETE FROM dev_area_blocks WHERE id = $1', [id]);
      for (const id of notasCriadas) await pool.query('DELETE FROM dev_notes WHERE id = $1', [id]);
      for (const id of snippetsCriados) await pool.query('DELETE FROM dev_snippets WHERE id = $1', [id]);
      for (const id of custosCriados) await pool.query('DELETE FROM dev_costs WHERE id = $1', [id]);
      if (permsConcedidas && id005) {
        await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key IN ('dev_area','dev_custos')`, [id005]);
      }
      console.log(`  removidos: ${blocosCriados.length} bloco(s), ${notasCriadas.length} nota(s), ${snippetsCriados.length} snippet(s), ${custosCriados.length} custo(s)`);
    } catch (e: any) {
      console.error('  ⚠ falha no cleanup:', e.message);
    }
    await pool.end().catch(() => { /* já fechado */ });
    if (servidor) await matarArvore(servidor.child);
  }

  console.log('\n──────────────────────────────────────────');
  if (failures.length === 0) {
    console.log('✅ smoke_devarea_custos: TODOS OS CHECKS PASSARAM');
  } else {
    console.error(`❌ smoke_devarea_custos: ${failures.length} falha(s):`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n💥 smoke_devarea_custos abortou:', e.message);
  process.exitCode = 1;
});
