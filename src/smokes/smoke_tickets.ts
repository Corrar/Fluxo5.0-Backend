// src/smokes/smoke_tickets.ts — smoke do Helpdesk v1 (Commit 1: migration 012 + /tickets).
//
// COMO RODA: igual aos smokes HTTP — exercita as ROTAS reais contra um server local no
// MESMO .env:  PORT=3999 node dist/server.js  e depois  npm run smoke:tickets
//
// ⚠ GUARDA DE HOST: só roda no branch de VALIDAÇÃO (ep-summer-wave).
// ⚠ Pressupõe validação SEM operação simultânea. CLEANUP CIRÚRGICO: todo ticket/comentário
//   criado aqui tem o id coletado e é DELETADO no finally, na ordem da FK (comments → tickets).
//   As linhas de auditoria ficam (livro append-only — mesmo comportamento dos outros smokes).
//
// COBERTURA:
//   [BORDA]     title vazio → 400; priority inválida → 400; válido → 201 {id, display_no int}.
//   [OWNERSHIP] /my só do requester; terceiro sem 'chamados' → 403 no detalhe e no status.
//   [FILA]      gate 'chamados' (001=admin bypassa); ?status= filtra; ?status=xpto → 400.
//   [MÁQUINA]   aberto→em_analise seta assignee; pulo em_analise→concluido → 400;
//               em_analise→em_desenvolvimento→concluido com closed_at; comentar encerrado → 409.
//   [CANCELAR]  atendente/admin cancelando chamado alheio → 403; dono em aberto → 200 +
//               closed_at; dono com chamado já em_analise → 400.
//   [TIMELINE]  dono e atendente comentam (201); socket do requester recebe ticket_updated
//               no comentário do atendente E na transição; socket de terceiro: ZERO eventos.
//   [FILA-VIVA] a criação emite ticket_created pra sala 'admin': o socket do 001 recebe com
//               payload auto-suficiente; o socket do 010 (não-admin, sem 'chamados') NÃO
//               recebe — contra-prova de que a emissão não virou broadcast.
//   [PRIORIDADE] atendente reclassifica media→alta (200, auditoria {de,para}); dono → 403.
//   [AUDITORIA] as 7 actions do ciclo conferidas no banco por ticket_id.
//
// Atores: 005 (requester), 001 (atendente/admin), 010 (terceiro sem 'chamados').

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  console.log('▶ smoke_tickets — host de validação OK (ep-summer-wave), alvo:', BASE);

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const socketsAbertos: ClientSocket[] = [];
  const ticketsCriados: string[] = []; // cleanup cirúrgico por id exato

  try {
    const admin = await login('001@fluxoroyale.local', SENHA_SEED);
    const setor = await login('005@fluxoroyale.local', SENHA_SEED);
    const terceiro = await login('010@fluxoroyale.local', SENHA_SEED);
    const adminToken: string = admin.token;
    const setorToken: string = setor.token;
    const terceiroToken: string = terceiro.token;
    const id001: string = admin.user.id;
    const id005: string = setor.user.id;

    // ── Sockets ANTES de qualquer ação: 005 (requester), 010 (terceiro), 001 (atendente) ──
    // O 001 entra aqui por causa do [FILA-VIVA]: 'ticket_created' é emitido DENTRO do POST
    // /tickets, então o socket dele precisa estar conectado ANTES da criação, senão o teste
    // mediria o próprio atraso de conexão em vez do evento.
    console.log('\n[SOCKETS] requester (005), terceiro (010) e atendente (001) conectados');
    const sock005 = await abrirSocket(setorToken);
    const sock010 = await abrirSocket(terceiroToken);
    const sock001 = await abrirSocket(adminToken);
    check(sock005.ok, 'socket do 005 conecta', sock005.ok ? 'conectado' : String(sock005.err));
    check(sock010.ok, 'socket do 010 conecta', sock010.ok ? 'conectado' : String(sock010.err));
    check(sock001.ok, 'socket do 001 (admin) conecta', sock001.ok ? 'conectado' : String(sock001.err));
    if (sock005.socket) socketsAbertos.push(sock005.socket);
    if (sock010.socket) socketsAbertos.push(sock010.socket);
    if (sock001.socket) socketsAbertos.push(sock001.socket);
    const eventos005: any[] = [];
    const eventos010: any[] = [];
    const criados001: any[] = [];
    const criados010: any[] = [];
    sock005.socket?.on('ticket_updated', (d: any) => eventos005.push(d));
    sock010.socket?.on('ticket_updated', (d: any) => eventos010.push(d));
    sock001.socket?.on('ticket_created', (d: any) => criados001.push(d));
    sock010.socket?.on('ticket_created', (d: any) => criados010.push(d));

    // ── [BORDA] abertura ─────────────────────────────────────────────────────
    console.log('\n[BORDA] abertura de chamado');
    const b1 = await call('POST', '/tickets', { token: setorToken, body: { title: '   ', description: 'x' } });
    check(b1.status === 400, 'title vazio → 400', `HTTP ${b1.status}: ${b1.data?.error}`);
    const b2 = await call('POST', '/tickets', { token: setorToken, body: { title: 'Teste', description: 'x', priority: 'urgentissima' } });
    check(b2.status === 400, 'priority inválida → 400', `HTTP ${b2.status}: ${b2.data?.error}`);
    const c1 = await call('POST', '/tickets', {
      token: setorToken,
      body: { title: 'SMOKE: erro ao exportar PDF', description: 'O botão PDF não gera o arquivo.', priority: 'media' },
    });
    check(c1.status === 201 && typeof c1.data?.display_no === 'number',
      'válido → 201 com display_no numérico', `HTTP ${c1.status}: display_no=${c1.data?.display_no}`);
    const t1: string = c1.data.id;
    ticketsCriados.push(t1);

    // ── [FILA-VIVA] a criação acorda a fila do atendente (31/07/2026) ────────
    // O que se prova aqui: 'ticket_created' chega ao ADMIN sem ninguém pedir, com payload
    // auto-suficiente, e NÃO chega a quem não atende. O 010 é o contra-prova da sala: se ele
    // receber, a emissão vazou de 'admin' pra broadcast.
    console.log('\n[FILA-VIVA] ticket_created na criação');
    await sleep(1200); // entrega do socket
    const ev = criados001.find((d) => d?.ticketId === t1);
    check(!!ev, '001 (admin) recebe ticket_created do chamado novo', ev ? `1 evento (display_no=${ev.display_no})` : `nenhum (${criados001.length} evento(s) de outros ids)`);
    check(!!ev && ev.display_no === c1.data.display_no && typeof ev.title === 'string' && ev.title.length > 0
      && typeof ev.requester_name === 'string' && ev.requester_name.length > 0,
      'payload auto-suficiente {ticketId, display_no, title, requester_name}',
      ev ? `display_no=${ev.display_no} title="${ev.title}" requester_name="${ev.requester_name}"` : 'sem evento');
    check(criados010.length === 0,
      '010 (não-admin, sem chamados) NÃO recebe ticket_created',
      `${criados010.length} evento(s)`);

    // ── [OWNERSHIP] ──────────────────────────────────────────────────────────
    console.log('\n[OWNERSHIP] requester × terceiro sem chamados');
    const my005 = await call('GET', '/tickets/my', { token: setorToken });
    check(my005.status === 200 && my005.data?.tickets?.some((t: any) => t.id === t1),
      '005 GET /my → vê o próprio chamado', `total=${my005.data?.total}`);
    const my010 = await call('GET', '/tickets/my', { token: terceiroToken });
    check(my010.status === 200 && !my010.data?.tickets?.some((t: any) => t.id === t1),
      '010 GET /my → NÃO vê o chamado do 005', `total=${my010.data?.total}`);
    const det010 = await call('GET', `/tickets/${t1}`, { token: terceiroToken });
    check(det010.status === 403, '010 GET /tickets/:id do 005 → 403', `HTTP ${det010.status}`);
    const st010 = await call('PUT', `/tickets/${t1}/status`, { token: terceiroToken, body: { status: 'em_analise' } });
    check(st010.status === 403, '010 PUT status (sem chamados) → 403', `HTTP ${st010.status}`);

    // ── [FILA] ───────────────────────────────────────────────────────────────
    console.log('\n[FILA] GET /tickets do atendente');
    const fila = await call('GET', '/tickets', { token: adminToken });
    check(fila.status === 200 && fila.data?.tickets?.some((t: any) => t.id === t1),
      '001 vê o chamado na fila única', `total=${fila.data?.total}`);
    const filaAberto = await call('GET', '/tickets?status=aberto', { token: adminToken });
    check(filaAberto.status === 200 && filaAberto.data?.tickets?.some((t: any) => t.id === t1),
      '?status=aberto filtra e contém o chamado', `total=${filaAberto.data?.total}`);
    const filaXpto = await call('GET', '/tickets?status=xpto', { token: adminToken });
    check(filaXpto.status === 400, '?status=xpto → 400', `HTTP ${filaXpto.status}`);

    // ── [TIMELINE] comentários com o chamado ABERTO + sockets ────────────────
    console.log('\n[TIMELINE] comentários e socket do requester');
    const cm1 = await call('POST', `/tickets/${t1}/comments`, { token: setorToken, body: { body: 'Complemento: acontece só no Chrome.' } });
    check(cm1.status === 201, '005 (dono) comenta → 201', `HTTP ${cm1.status}`);
    const antes = eventos005.length;
    const cm2 = await call('POST', `/tickets/${t1}/comments`, { token: adminToken, body: { body: 'Reproduzi aqui, analisando.' } });
    check(cm2.status === 201, '001 (atendente) comenta → 201', `HTTP ${cm2.status}`);
    await sleep(1200); // entrega do socket
    check(eventos005.length > antes && eventos005.some((d) => d?.ticketId === t1 && d?.event === 'comentario'),
      '005 RECEBEU ticket_updated no comentário do atendente', `${eventos005.length} evento(s)`);
    const detalhe = await call('GET', `/tickets/${t1}`, { token: setorToken });
    check(detalhe.status === 200 && detalhe.data?.comments?.length === 2,
      'detalhe devolve a timeline ordenada (2 comentários)', `comments=${detalhe.data?.comments?.length}`);

    // ── [MÁQUINA] transições do atendente ────────────────────────────────────
    console.log('\n[MÁQUINA] transições');
    const eventosAntesStatus = eventos005.length;
    const s1 = await call('PUT', `/tickets/${t1}/status`, { token: adminToken, body: { status: 'em_analise' } });
    check(s1.status === 200, 'aberto → em_analise → 200', `HTTP ${s1.status}`);
    const dbA = await pool.query('SELECT assignee_id, status FROM tickets WHERE id = $1', [t1]);
    check(dbA.rows[0]?.assignee_id === id001 && dbA.rows[0]?.status === 'em_analise',
      'assignee_id = atendente no banco (assumiu ao iniciar análise)', `assignee=${String(dbA.rows[0]?.assignee_id).slice(0, 8)}…`);
    const pulo = await call('PUT', `/tickets/${t1}/status`, { token: adminToken, body: { status: 'concluido' } });
    check(pulo.status === 400, 'pulo em_analise → concluido → 400', `HTTP ${pulo.status}: ${pulo.data?.error}`);
    const s2 = await call('PUT', `/tickets/${t1}/status`, { token: adminToken, body: { status: 'em_desenvolvimento' } });
    check(s2.status === 200, 'em_analise → em_desenvolvimento → 200', `HTTP ${s2.status}`);
    const s3 = await call('PUT', `/tickets/${t1}/status`, { token: adminToken, body: { status: 'concluido' } });
    check(s3.status === 200, 'em_desenvolvimento → concluido → 200', `HTTP ${s3.status}`);
    const dbB = await pool.query('SELECT status, closed_at, version FROM tickets WHERE id = $1', [t1]);
    check(dbB.rows[0]?.status === 'concluido' && dbB.rows[0]?.closed_at !== null,
      'concluido com closed_at preenchido no banco', `version=${dbB.rows[0]?.version}`);
    await sleep(1200);
    check(eventos005.filter((d) => d?.ticketId === t1 && d?.event === 'status').length >= 3 &&
      eventos005.length > eventosAntesStatus,
      '005 recebeu ticket_updated nas transições de status', `${eventos005.length} evento(s) no total`);
    const cmFechado = await call('POST', `/tickets/${t1}/comments`, { token: adminToken, body: { body: 'tarde demais' } });
    check(cmFechado.status === 409, 'comentar em concluido → 409', `HTTP ${cmFechado.status}: ${cmFechado.data?.error}`);

    // ── [CANCELAR] a exceção do dono ─────────────────────────────────────────
    console.log('\n[CANCELAR] regra do dono');
    const c2 = await call('POST', '/tickets', { token: setorToken, body: { title: 'SMOKE: pedido que vou cancelar', description: 'desisti' } });
    const t2: string = c2.data.id;
    ticketsCriados.push(t2);
    const cancelAdmin = await call('PUT', `/tickets/${t2}/status`, { token: adminToken, body: { status: 'cancelado' } });
    check(cancelAdmin.status === 403, 'admin/atendente cancelando chamado alheio → 403', `HTTP ${cancelAdmin.status}`);
    const cancelDono = await call('PUT', `/tickets/${t2}/status`, { token: setorToken, body: { status: 'cancelado' } });
    check(cancelDono.status === 200, 'dono cancela em aberto → 200', `HTTP ${cancelDono.status}`);
    const dbC = await pool.query('SELECT status, closed_at FROM tickets WHERE id = $1', [t2]);
    check(dbC.rows[0]?.status === 'cancelado' && dbC.rows[0]?.closed_at !== null,
      'cancelado com closed_at no banco', `status=${dbC.rows[0]?.status}`);

    const c3 = await call('POST', '/tickets', { token: setorToken, body: { title: 'SMOKE: em análise não cancela', description: 'x', priority: 'media' } });
    const t3: string = c3.data.id;
    ticketsCriados.push(t3);
    await call('PUT', `/tickets/${t3}/status`, { token: adminToken, body: { status: 'em_analise' } });
    const cancelTarde = await call('PUT', `/tickets/${t3}/status`, { token: setorToken, body: { status: 'cancelado' } });
    check(cancelTarde.status === 400, 'dono cancelando chamado já em_analise → 400', `HTTP ${cancelTarde.status}: ${cancelTarde.data?.error}`);

    // ── [PRIORIDADE] reclassificação ─────────────────────────────────────────
    console.log('\n[PRIORIDADE] reclassificação pelo atendente');
    const p1 = await call('PUT', `/tickets/${t3}/priority`, { token: adminToken, body: { priority: 'alta' } });
    check(p1.status === 200, '001 reclassifica media → alta → 200', `HTTP ${p1.status}`);
    const p2 = await call('PUT', `/tickets/${t3}/priority`, { token: setorToken, body: { priority: 'baixa' } });
    check(p2.status === 403, '005 (sem chamados) tentando reclassificar → 403', `HTTP ${p2.status}`);

    // ── [SOCKET terceiro] silêncio absoluto ──────────────────────────────────
    await sleep(800);
    check(eventos010.length === 0, '010 (terceiro) NÃO recebeu NENHUM ticket_updated no ciclo todo', `${eventos010.length} evento(s)`);

    // ── [AUDITORIA] as 7 actions no livro ────────────────────────────────────
    console.log('\n[AUDITORIA] actions do ciclo no banco');
    const aud = await pool.query(
      `SELECT action, details FROM audit_logs
       WHERE details->>'ticket_id' = ANY($1) ORDER BY created_at`,
      [[t1, t2, t3]],
    );
    const actions = aud.rows.map((r: any) => r.action);
    const conta = (a: string) => actions.filter((x: string) => x === a).length;
    check(conta('CRIAR_CHAMADO') === 3, '3× CRIAR_CHAMADO', `${conta('CRIAR_CHAMADO')}`);
    check(conta('COMENTAR_CHAMADO') === 2, '2× COMENTAR_CHAMADO', `${conta('COMENTAR_CHAMADO')}`);
    check(conta('INICIAR_ANALISE_CHAMADO') === 2, '2× INICIAR_ANALISE_CHAMADO (t1 e t3)', `${conta('INICIAR_ANALISE_CHAMADO')}`);
    check(conta('INICIAR_DEV_CHAMADO') === 1, '1× INICIAR_DEV_CHAMADO', `${conta('INICIAR_DEV_CHAMADO')}`);
    check(conta('CONCLUIR_CHAMADO') === 1, '1× CONCLUIR_CHAMADO', `${conta('CONCLUIR_CHAMADO')}`);
    check(conta('CANCELAR_CHAMADO') === 1, '1× CANCELAR_CHAMADO', `${conta('CANCELAR_CHAMADO')}`);
    const reclass = aud.rows.find((r: any) => r.action === 'RECLASSIFICAR_CHAMADO');
    check(!!reclass && reclass.details?.de === 'media' && reclass.details?.para === 'alta',
      'RECLASSIFICAR_CHAMADO com diff {de: media, para: alta}', JSON.stringify(reclass?.details ?? null));
  } finally {
    socketsAbertos.forEach((s) => { try { s.close(); } catch { /* ignora */ } });
    // CLEANUP CIRÚRGICO por id exato, na ordem da FK: comments primeiro, tickets depois.
    // Nada de DELETE global — os ids são exatamente os criados por este smoke.
    try {
      if (ticketsCriados.length > 0) {
        const dc = await pool.query('DELETE FROM ticket_comments WHERE ticket_id = ANY($1)', [ticketsCriados]);
        const dt = await pool.query('DELETE FROM tickets WHERE id = ANY($1)', [ticketsCriados]);
        console.log(`  cleanup cirúrgico: ${dc.rowCount} comentário(s) e ${dt.rowCount} ticket(s) de teste removidos.`);
      }
    } catch (e: any) {
      console.error('  ‼ FALHA no cleanup — conferir tickets/ticket_comments manualmente!', e?.message);
    }
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n❌ smoke_tickets FALHOU — ${failures.length} checagem(ns):`);
    failures.forEach((f) => console.error('   -', f));
    process.exit(1);
  }
  console.log('\n✅ smoke_tickets PASSOU — borda, ownership, fila, máquina de estados, cancelamento do dono, timeline, prioridade e auditoria conferidos; cleanup cirúrgico aplicado.');
}

main().catch((err) => {
  console.error('\n❌ smoke_tickets ABORTOU:', err?.message ?? err);
  process.exit(1);
});
