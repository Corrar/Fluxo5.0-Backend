// src/smokes/smoke_dev_dashboard.ts — smoke do dev-painel v1 (GET /dev-dashboard).
//
// COMO RODA: `npm run smoke:devdashboard` e pronto — este smoke SOBE O PRÓPRIO SERVIDOR numa
// PORTA LIVRE (pedida ao SO) e mata a ÁRVORE do processo no fim. Não precisa de server aberto
// noutro terminal e não colide com o :3000 do dia a dia. Sobe `src/server.ts` via ts-node
// (fonte, não dist/) pra nunca testar build velho.
//   Override: com SMOKE_BASE_URL definido ele NÃO sobe nada e mira o alvo dado (é assim que a
//   regressão roda contra o Render) — o SQL continua indo pro DATABASE_URL do .env.
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ CLEANUP CIRÚRGICO: tickets/comentários/projeto criados aqui morrem por ID exato no
//   finally; a page_key concedida ao 005 é INSERT/DELETE do par exato (nada de replace-all).
//   audit_logs NÃO é limpo de propósito (o livro é o livro) — e é exatamente por isso que o
//   painel não lê audit_logs: o histórico dele está cheio de atividade de smoke.
//
// COBERTURA:
//   [GATE]     005 sem 'dev_dashboard' → 403; chave concedida via user_permissions → 200 em
//              tempo real (sem novo login) → revogada → 403 de volta.
//   [VAZIO]    banco zerado → envelope com zeros e NULLs crus (nunca placeholder) e
//              sete_dias com os 7 slots presentes e zerados, terminando no "hoje" do banco.
//   [CENÁRIO]  cenário semeado PELA API (001): 2 chamados na fila (1 alta, 1 puxado pra
//              análise), 1 ciclo completo até concluido, 1 cancelado, 1 projeto ativo com
//              checklist 1/2 → confere fila (concluído e cancelado FORA), sem_atendente,
//              prioridade, a MÉDIA SÓ-CONCLUIDO (a prova do bug do cancelado: 2 chamados
//              fecharam hoje, a média conta 1), a série do dia e o progresso derivado.
//
// Atores: 001 (admin — bypass do requirePermission), 005 (não-admin, sem a chave).

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';

const SENHA_SEED = 'Teste@123';
const TZ_ESPERADO = 'America/Sao_Paulo';
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
// Porta pedida ao SO (listen 0) e devolvida na hora. Há uma janela teórica entre soltar e o
// server subir; num smoke local isso é aceitável e MUITO melhor que porta fixa (que colide
// com o server do dia a dia e faz o smoke medir o processo errado).
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
    // POSIX: detached cria grupo próprio p/ o kill negativo pegar a árvore.
    detached: process.platform !== 'win32',
  });
  const guarda = (b: Buffer) => { linhas.push(b.toString()); if (linhas.length > 80) linhas.shift(); };
  child.stdout?.on('data', guarda);
  child.stderr?.on('data', guarda);
  return { child, log: () => linhas.join('') };
}

// Mata a ÁRVORE: no Windows o `node -r ts-node/register` pode ter filhos, e matar só o pai
// deixaria a porta presa. taskkill /T resolve; no POSIX, kill no grupo (-pid).
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

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  let servidor: { child: ChildProcess; log: () => string } | null = null;
  const ticketsCriados: string[] = [];
  const projetosCriados: string[] = [];
  let permConcedida = false;
  let id005 = '';

  try {
    if (BASE) {
      console.log('▶ smoke_dev_dashboard — host de validação OK (ep-summer-wave); SMOKE_BASE_URL definido, NÃO sobe servidor. Alvo:', BASE);
    } else {
      const porta = await portaLivre();
      BASE = `http://127.0.0.1:${porta}`;
      console.log('▶ smoke_dev_dashboard — host de validação OK (ep-summer-wave); subindo servidor efêmero em', BASE);
      servidor = subirServidor(porta);
      await esperarHealth(servidor.child, servidor.log);
      console.log('  servidor pronto (/health respondeu).');
    }

    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    id005 = setor.user.id;

    // ── [GATE] router inteiro atrás de 'dev_dashboard' ───────────────────────
    console.log('\n[GATE] chave própria dev_dashboard (não reusa "chamados")');
    const g1 = await call('GET', '/dev-dashboard', { token: setorToken });
    check(g1.status === 403, '005 sem a chave → 403', `HTTP ${g1.status}`);

    const jaTinha = await pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1 AND page_key = 'dev_dashboard'`, [id005]);
    if (jaTinha.rows.length > 0) throw new Error("005 já tem 'dev_dashboard' — estado inesperado do seed, abortando.");
    await pool.query(`INSERT INTO user_permissions (user_id, page_key) VALUES ($1, 'dev_dashboard')`, [id005]);
    permConcedida = true;
    const g2 = await call('GET', '/dev-dashboard', { token: setorToken });
    check(g2.status === 200, "005 COM a chave via user_permissions → 200 (sem novo login)", `HTTP ${g2.status}`);
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'dev_dashboard'`, [id005]);
    permConcedida = false;
    const g3 = await call('GET', '/dev-dashboard', { token: setorToken });
    check(g3.status === 403, 'chave revogada → 403 de volta', `HTTP ${g3.status}`);

    // ── [VAZIO] o estado honesto: zeros e nulls crus ─────────────────────────
    console.log('\n[VAZIO] banco zerado → zeros/null, nunca placeholder');
    const pre = await pool.query(`SELECT (SELECT count(*)::int FROM tickets) AS t, (SELECT count(*)::int FROM dev_projects) AS p`);
    if (pre.rows[0].t !== 0 || pre.rows[0].p !== 0) {
      throw new Error(`o painel VAZIO só é conferível com o banco zerado — encontrei tickets=${pre.rows[0].t}, dev_projects=${pre.rows[0].p}. Rode os cleanups antes.`);
    }
    const hojeDb = (await pool.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS hoje`, [TZ_ESPERADO])).rows[0].hoje;

    const v = await call('GET', '/dev-dashboard', { token: adminToken });
    check(v.status === 200, 'admin GET /dev-dashboard → 200 (bypass)', `HTTP ${v.status}`);
    const dv = v.data ?? {};
    check(
      dv.fila?.abertos === 0 && dv.fila?.em_analise === 0 && dv.fila?.em_desenvolvimento === 0 && dv.fila?.fila_total === 0 && dv.fila?.sem_atendente === 0,
      'fila toda zerada', JSON.stringify(dv.fila),
    );
    check(dv.fila?.mais_antigo_dias === null, 'mais_antigo_dias = null com fila vazia (não 0)', String(dv.fila?.mais_antigo_dias));
    check(dv.prioridade_fila?.alta === 0 && dv.prioridade_fila?.media === 0 && dv.prioridade_fila?.baixa === 0, 'prioridade zerada', JSON.stringify(dv.prioridade_fila));
    check(dv.resolucao_30d?.n === 0 && dv.resolucao_30d?.media_horas === null, 'resolucao_30d = {n:0, media_horas:null}', JSON.stringify(dv.resolucao_30d));
    check(Array.isArray(dv.sete_dias) && dv.sete_dias.length === 7, 'sete_dias com 7 slots SEMPRE presentes', `len=${dv.sete_dias?.length}`);
    check(
      Array.isArray(dv.sete_dias) && dv.sete_dias.every((d: any) => d.abertos === 0 && d.concluidos === 0),
      'todos os 7 slots zerados', JSON.stringify(dv.sete_dias?.map((d: any) => `${d.abertos}/${d.concluidos}`)),
    );
    check(dv.sete_dias?.[6]?.dia === hojeDb, 'último slot = hoje pelo relógio do BANCO (fuso SP)', `${dv.sete_dias?.[6]?.dia} vs ${hojeDb}`);
    check(dv.projetos?.ativos === 0 && dv.projetos?.arquivados === 0 && Array.isArray(dv.projetos?.recentes) && dv.projetos.recentes.length === 0, 'projetos zerados e sem recentes', JSON.stringify(dv.projetos));
    check(typeof dv.gerado_em === 'string' && !Number.isNaN(Date.parse(dv.gerado_em)), 'gerado_em é ISO parseável', String(dv.gerado_em));

    // ── [CENÁRIO] semeado PELA API, como o usuário faria ─────────────────────
    console.log('\n[CENÁRIO] semeando pela API (001): 2 na fila (1 alta, 1 em análise), 1 concluído, 1 cancelado, 1 projeto 1/2');
    const abrir = async (title: string, priority: string) => {
      const r = await call('POST', '/tickets', { token: adminToken, body: { title, description: 'semeado pelo smoke do painel', priority } });
      if (r.status !== 201) throw new Error(`falha ao abrir chamado "${title}": HTTP ${r.status} ${JSON.stringify(r.data)}`);
      ticketsCriados.push(r.data.id);
      return r.data.id;
    };
    const mover = async (id: string, status: string) => {
      const r = await call('PUT', `/tickets/${id}/status`, { token: adminToken, body: { status } });
      if (r.status !== 200) throw new Error(`falha ao mover ${id} → ${status}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    };

    const tAlta = await abrir('PAINEL alta na fila', 'alta');          // fica aberto, SEM atendente
    const tAnalise = await abrir('PAINEL puxado pra análise', 'media'); // vira em_analise (ganha atendente)
    await mover(tAnalise, 'em_analise');
    const tConcluido = await abrir('PAINEL ciclo completo', 'baixa');
    await mover(tConcluido, 'em_analise');
    await mover(tConcluido, 'em_desenvolvimento');
    await mover(tConcluido, 'concluido');
    const tCancelado = await abrir('PAINEL cancelado pelo dono', 'baixa');
    await mover(tCancelado, 'cancelado');                               // fecha, mas NÃO é resolução

    const proj = await call('POST', '/dev-projects', {
      token: adminToken,
      body: { name: 'PAINEL projeto com checklist', checklists: [{ titulo: 'Etapas', itens: [{ t: 'feito', done: true }, { t: 'pendente', done: false }] }] },
    });
    if (proj.status !== 201) throw new Error(`falha ao criar projeto: HTTP ${proj.status} ${JSON.stringify(proj.data)}`);
    projetosCriados.push(proj.data.id);

    // A prova de que o cenário tem DOIS fechados hoje (concluído + cancelado) — é isso que
    // torna a asserção da média (n=1) uma prova do bug, e não coincidência.
    const fechados = await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE closed_at IS NOT NULL AND id = ANY($1::uuid[])`, [ticketsCriados]);
    check(fechados.rows[0].n === 2, 'no banco: 2 chamados com closed_at (concluído E cancelado)', `${fechados.rows[0].n}`);

    console.log('\n[CENÁRIO] conferindo os números do painel');
    const c = await call('GET', '/dev-dashboard', { token: adminToken });
    check(c.status === 200, 'GET /dev-dashboard → 200', `HTTP ${c.status}`);
    const d = c.data ?? {};

    check(d.fila?.fila_total === 2, 'fila_total = 2 (concluído e cancelado FORA da fila)', String(d.fila?.fila_total));
    check(d.fila?.abertos === 1, 'abertos = 1', String(d.fila?.abertos));
    check(d.fila?.em_analise === 1, 'em_analise = 1', String(d.fila?.em_analise));
    check(d.fila?.em_desenvolvimento === 0, 'em_desenvolvimento = 0', String(d.fila?.em_desenvolvimento));
    check(d.fila?.sem_atendente === 1, 'sem_atendente = 1 (só o aberto; quem foi pra análise ganhou atendente)', String(d.fila?.sem_atendente));
    check(d.fila?.mais_antigo_dias === 0, 'mais_antigo_dias = 0 (entrou hoje)', String(d.fila?.mais_antigo_dias));

    check(d.prioridade_fila?.alta === 1, 'prioridade alta = 1', String(d.prioridade_fila?.alta));
    check(d.prioridade_fila?.media === 1, 'prioridade media = 1', String(d.prioridade_fila?.media));
    check(d.prioridade_fila?.baixa === 0, 'prioridade baixa = 0 (os dois baixa saíram da fila)', String(d.prioridade_fila?.baixa));

    check(d.resolucao_30d?.n === 1, 'resolucao_30d.n = 1 — o CANCELADO não conta (prova do bug do closed_at)', String(d.resolucao_30d?.n));
    check(typeof d.resolucao_30d?.media_horas === 'number' && d.resolucao_30d.media_horas >= 0, 'media_horas é número real (não placeholder)', String(d.resolucao_30d?.media_horas));

    const hoje = d.sete_dias?.[6];
    check(hoje?.dia === hojeDb, 'série termina no dia de hoje (fuso SP)', `${hoje?.dia}`);
    check(hoje?.abertos === 4, 'hoje: abertos = 4 (os 4 chamados nasceram hoje)', String(hoje?.abertos));
    check(hoje?.concluidos === 1, 'hoje: concluidos = 1 (o cancelado não entra)', String(hoje?.concluidos));
    check(
      Array.isArray(d.sete_dias) && d.sete_dias.slice(0, 6).every((x: any) => x.abertos === 0 && x.concluidos === 0),
      'os 6 dias anteriores seguem zerados', JSON.stringify(d.sete_dias?.slice(0, 6).map((x: any) => `${x.abertos}/${x.concluidos}`)),
    );

    check(d.projetos?.ativos === 1, 'projetos.ativos = 1', String(d.projetos?.ativos));
    check(d.projetos?.arquivados === 0, 'projetos.arquivados = 0', String(d.projetos?.arquivados));
    const r0 = d.projetos?.recentes?.[0];
    check(r0?.id === projetosCriados[0], 'recentes[0] é o projeto semeado (mais recente por updated_at)', String(r0?.name));
    check(r0?.itens_total === 2 && r0?.itens_done === 1, 'progresso DERIVADO do jsonb: 1/2', `${r0?.itens_done}/${r0?.itens_total}`);
  } finally {
    // Cleanup cirúrgico: por ID exato, na ordem das FKs. Nada global.
    try {
      if (ticketsCriados.length > 0) {
        await pool.query('DELETE FROM ticket_comments WHERE ticket_id = ANY($1::uuid[])', [ticketsCriados]);
        await pool.query('DELETE FROM tickets WHERE id = ANY($1::uuid[])', [ticketsCriados]);
      }
      if (projetosCriados.length > 0) {
        await pool.query('DELETE FROM dev_projects WHERE id = ANY($1::uuid[])', [projetosCriados]);
      }
      if (permConcedida && id005) {
        await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND page_key = 'dev_dashboard'`, [id005]);
        console.log('  cleanup: chave dev_dashboard do 005 removida (rede de segurança).');
      }
      const sobra = await pool.query(`SELECT (SELECT count(*)::int FROM tickets) AS t, (SELECT count(*)::int FROM dev_projects) AS p`);
      console.log(`  cleanup cirúrgico: ${ticketsCriados.length} chamado(s) e ${projetosCriados.length} projeto(s) removidos. Restam tickets=${sobra.rows[0].t}, dev_projects=${sobra.rows[0].p}.`);
    } finally {
      await pool.end();
      if (servidor) {
        await matarArvore(servidor.child);
        console.log('  servidor efêmero derrubado (árvore).');
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_dev_dashboard FALHOU em ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ smoke_dev_dashboard PASSOU — gate da chave própria, estado vazio honesto (zeros/null + 7 slots), fila sem os fechados, média SÓ-concluido, série no fuso SP e progresso derivado conferidos; cleanup cirúrgico aplicado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_dev_dashboard EXPLODIU:', err?.message ?? err);
  process.exit(1);
});
