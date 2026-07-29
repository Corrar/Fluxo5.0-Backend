// src/controllers/tickets.controller.ts — Helpdesk v1 (chamados assíncronos).
//
// MODELO DE ACESSO (decisões travadas):
//   - QUALQUER logado abre e acompanha os PRÓPRIOS chamados (authenticate puro — precedente
//     literal do POST /requests). requester_id sai SEMPRE do token, nunca do body.
//   - Só quem tem a page_key 'chamados' ATENDE (fila única, triagem, status, prioridade).
//   - Cancelamento é EXCEÇÃO: só o REQUESTER, só em 'aberto' — independe de 'chamados', e
//     atendente/admin NÃO cancela chamado dos outros (o cancelamento é do dono).
//   - Máquina de estados LINEAR ESTRITA (sem reabertura): aberto -> em_analise ->
//     em_desenvolvimento -> concluido; aberto -> cancelado. Guard inline em transação com
//     FOR UPDATE (padrão updateRequestStatus), auditoria com action distinta por transição.
//
// NOTIFICAÇÃO v1 = SÓ socket 'ticket_updated' pra sala user:${requester_id} (cortesia, não
// garantia — quem está offline refaz o GET quando abrir a tela). Quando o REQUESTER comenta,
// emite também pra sala 'admin': o atendente de hoje é admin (o módulo Dev não mudou na v1) —
// ASSIMETRIA CONSCIENTE: um futuro atendente não-admin com 'chamados' não está nessa sala;
// quando esse papel nascer, a sala certa nasce junto (mesma limitação anotada no
// user_status_changed da tela Usuários).

import { Request, Response } from 'express';
import { pool, query as dbQuery } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const PRIORIDADES = ['baixa', 'media', 'alta'];
const STATUSES = ['aberto', 'em_analise', 'em_desenvolvimento', 'concluido', 'cancelado'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mesmo critério do requirePermission (admin por JWT + page_key em TEMPO REAL nas duas
// tabelas), em forma de função: o PUT /status precisa decidir DENTRO do handler — a rota não
// pode ter requirePermission('chamados') porque o cancelamento do dono passa por ela sem a
// chave. Leituras via dbQuery (wrapper com retry) — rodam em request de qualquer logado.
async function podeAtender(userId: string, role: string | undefined): Promise<boolean> {
  const safeRole = String(role ?? '').toLowerCase().trim();
  if (safeRole === 'admin') return true;
  const perm = await dbQuery(
    `SELECT 1 FROM role_permissions WHERE LOWER(role) = $1 AND page_key = 'chamados'
     UNION
     SELECT 1 FROM user_permissions WHERE user_id = $2 AND page_key = 'chamados'
     LIMIT 1`,
    [safeRole, userId],
  );
  return perm.rows.length > 0;
}

function emitTicket(req: Request, requesterId: string, payload: object, tambemAdmin = false): void {
  const io = (req as any).io;
  if (!io) return;
  const alvo = io.to(`user:${requesterId}`);
  (tambemAdmin ? alvo.to('admin') : alvo).emit('ticket_updated', { at: Date.now(), ...payload });
}

// ── POST /tickets — qualquer logado abre ────────────────────────────────────
export const createTicket = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { title, description, priority } = req.body ?? {};

  // Validação na borda: nada de INSERT com campo quebrado (400, nunca 500).
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanDesc = typeof description === 'string' ? description.trim() : '';
  if (!cleanTitle) return res.status(400).json({ error: 'Título é obrigatório.' });
  if (cleanTitle.length > 200) return res.status(400).json({ error: 'Título deve ter no máximo 200 caracteres.' });
  if (!cleanDesc) return res.status(400).json({ error: 'Descrição é obrigatória.' });
  const cleanPriority = priority === undefined || priority === null || priority === '' ? 'media' : priority;
  if (!PRIORIDADES.includes(cleanPriority)) {
    return res.status(400).json({ error: `Prioridade inválida. Use: ${PRIORIDADES.join(', ')}.` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO tickets (requester_id, title, description, priority)
       VALUES ($1, $2, $3, $4) RETURNING id, display_no`,
      [userId, cleanTitle, cleanDesc, cleanPriority],
    );
    const ticket = rows[0];
    await createLog(userId, 'CRIAR_CHAMADO',
      { ticket_id: ticket.id, display_no: ticket.display_no, priority: cleanPriority }, getClientIp(req));
    res.status(201).json({ id: ticket.id, display_no: ticket.display_no });
  } catch (error: any) {
    console.error('Erro ao criar chamado:', error);
    res.status(500).json({ error: 'Erro ao criar chamado.' });
  }
};

// ── GET /tickets/my — os chamados do requester (por token) ──────────────────
// SEM paginação na v1 de propósito: volume esperado baixo (chamados de TI de uma equipe de
// 15 pessoas). O envelope {tickets, total} já nasce pronto pra ganhar limit/offset depois
// sem quebrar consumidor (dívida registrada em DIVIDAS.md).
export const getMyTickets = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  try {
    const { rows } = await dbQuery(
      `SELECT t.id, t.display_no, t.title, t.priority, t.status, t.version,
              t.created_at, t.updated_at, t.closed_at,
              COALESCE(pa.name, ua.email) AS assignee_name
       FROM tickets t
       LEFT JOIN users ua ON t.assignee_id = ua.id
       LEFT JOIN profiles pa ON ua.id = pa.id
       WHERE t.requester_id = $1
       ORDER BY t.created_at DESC`,
      [userId],
    );
    res.json({ tickets: rows, total: rows.length });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar seus chamados.' });
  }
};

// ── GET /tickets — a FILA ÚNICA do atendente (rota gateada por 'chamados') ──
export const getTickets = async (req: Request, res: Response) => {
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(String(status))) {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUSES.join(', ')}.` });
  }
  try {
    const params: string[] = [];
    let where = '';
    if (status !== undefined) { params.push(String(status)); where = 'WHERE t.status = $1'; }
    const { rows } = await dbQuery(
      `SELECT t.id, t.display_no, t.title, t.priority, t.status, t.version,
              t.created_at, t.updated_at, t.closed_at, t.requester_id, t.assignee_id,
              COALESCE(pr.name, ur.email, 'Usuário Removido') AS requester_name,
              COALESCE(pr.sector, '-') AS requester_sector,
              COALESCE(pa.name, ua.email) AS assignee_name
       FROM tickets t
       LEFT JOIN users ur ON t.requester_id = ur.id
       LEFT JOIN profiles pr ON ur.id = pr.id
       LEFT JOIN users ua ON t.assignee_id = ua.id
       LEFT JOIN profiles pa ON ua.id = pa.id
       ${where}
       ORDER BY t.created_at DESC`,
      params,
    );
    res.json({ tickets: rows, total: rows.length });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar a fila de chamados.' });
  }
};

// ── GET /tickets/:id — detalhe + timeline (dono OU atendente) ───────────────
export const getTicket = async (req: Request, res: Response) => {
  const { id } = req.params;
  const requester = (req as any).user;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Chamado não encontrado.' });
  try {
    const tRes = await dbQuery(
      `SELECT t.*,
              COALESCE(pr.name, ur.email, 'Usuário Removido') AS requester_name,
              COALESCE(pr.sector, '-') AS requester_sector,
              COALESCE(pa.name, ua.email) AS assignee_name
       FROM tickets t
       LEFT JOIN users ur ON t.requester_id = ur.id
       LEFT JOIN profiles pr ON ur.id = pr.id
       LEFT JOIN users ua ON t.assignee_id = ua.id
       LEFT JOIN profiles pa ON ua.id = pa.id
       WHERE t.id = $1`,
      [id],
    );
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const ticket = tRes.rows[0];

    // 404 antes do 403 de propósito: quem não pode ver um chamado INEXISTENTE recebe o mesmo
    // que qualquer um; o 403 só existe pra chamado real que não é seu nem seu de atender.
    if (ticket.requester_id !== requester.id && !(await podeAtender(requester.id, requester.role))) {
      return res.status(403).json({ error: 'Este chamado não é seu.' });
    }

    const cRes = await dbQuery(
      `SELECT c.id, c.author_id, c.body, c.created_at,
              COALESCE(p.name, u.email, 'Usuário Removido') AS author_name
       FROM ticket_comments c
       LEFT JOIN users u ON c.author_id = u.id
       LEFT JOIN profiles p ON u.id = p.id
       WHERE c.ticket_id = $1
       ORDER BY c.created_at`,
      [id],
    );
    res.json({ ...ticket, comments: cRes.rows });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar o chamado.' });
  }
};

// ── POST /tickets/:id/comments — timeline (dono OU atendente) ───────────────
export const addComment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const requester = (req as any).user;
  const { body } = req.body ?? {};
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Chamado não encontrado.' });
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!cleanBody) return res.status(400).json({ error: 'Comentário não pode ser vazio.' });

  try {
    const tRes = await dbQuery('SELECT id, display_no, requester_id, status FROM tickets WHERE id = $1', [id]);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const ticket = tRes.rows[0];

    const souDono = ticket.requester_id === requester.id;
    if (!souDono && !(await podeAtender(requester.id, requester.role))) {
      return res.status(403).json({ error: 'Este chamado não é seu.' });
    }
    // Fim de linha é fim de conversa: concluído/cancelado não recebe comentário (o requester
    // abre chamado NOVO — sem reabertura na v1, decisão travada).
    if (ticket.status === 'concluido' || ticket.status === 'cancelado') {
      return res.status(409).json({ error: 'Chamado encerrado não recebe comentários. Abra um novo chamado.' });
    }

    const cRes = await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [id, requester.id, cleanBody],
    );
    await createLog(requester.id, 'COMENTAR_CHAMADO',
      { ticket_id: id, display_no: ticket.display_no, comment_id: cRes.rows[0].id }, getClientIp(req));

    // Aviso-cortesia: o requester sempre; quando quem comentou FOI o requester, a sala
    // 'admin' também (ver assimetria documentada no topo).
    emitTicket(req, ticket.requester_id,
      { ticketId: id, display_no: ticket.display_no, event: 'comentario', status: ticket.status }, souDono);

    res.status(201).json({ id: cRes.rows[0].id, created_at: cRes.rows[0].created_at });
  } catch (error: any) {
    console.error('Erro ao comentar chamado:', error);
    res.status(500).json({ error: 'Erro ao comentar o chamado.' });
  }
};

// ── PUT /tickets/:id/status — a máquina de estados ──────────────────────────
// Gate FINO no handler (a rota tem só authenticate): alvo 'cancelado' é regra do DONO;
// qualquer outro alvo exige 'chamados'. Guard inline em transação lendo o estado atual com
// FOR UPDATE — padrão updateRequestStatus (transições concorrentes se serializam na linha).
export const updateTicketStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const requester = (req as any).user;
  const { status: alvo } = req.body ?? {};
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!STATUSES.includes(alvo)) {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUSES.join(', ')}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [id]);
    if (tRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const ticket = tRes.rows[0];
    const atual: string = ticket.status;

    let action: string;
    let setAssignee = false;
    let setClosed = false;

    if (alvo === 'cancelado') {
      // Cancelamento é DO DONO: nem atendente nem admin cancelam chamado dos outros.
      if (ticket.requester_id !== requester.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Só quem abriu o chamado pode cancelá-lo.' });
      }
      if (atual !== 'aberto') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Transição inválida: ${atual} → cancelado. Cancelar só é possível com o chamado ainda aberto.` });
      }
      action = 'CANCELAR_CHAMADO';
      setClosed = true;
    } else {
      if (!(await podeAtender(requester.id, requester.role))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Acesso bloqueado. Não possui o nível de permissão necessário (chamados) para executar esta operação.' });
      }
      if (alvo === 'em_analise' && atual === 'aberto') {
        action = 'INICIAR_ANALISE_CHAMADO';
        setAssignee = true; // o atendente ASSUME o chamado ao iniciar a análise
      } else if (alvo === 'em_desenvolvimento' && atual === 'em_analise') {
        action = 'INICIAR_DEV_CHAMADO';
      } else if (alvo === 'concluido' && atual === 'em_desenvolvimento') {
        action = 'CONCLUIR_CHAMADO';
        setClosed = true;
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Transição inválida: ${atual} → ${alvo}. O fluxo é aberto → em_analise → em_desenvolvimento → concluido (sem pulos e sem volta).` });
      }
    }

    await client.query(
      `UPDATE tickets
       SET status = $1,
           assignee_id = CASE WHEN $2 THEN $3::uuid ELSE assignee_id END,
           closed_at = CASE WHEN $4 THEN now() ELSE closed_at END,
           updated_at = now(),
           version = version + 1
       WHERE id = $5`,
      [alvo, setAssignee, requester.id, setClosed, id],
    );
    await createLog(requester.id, action,
      { ticket_id: id, display_no: ticket.display_no, de: atual, para: alvo }, getClientIp(req), client);
    await client.query('COMMIT');

    emitTicket(req, ticket.requester_id, { ticketId: id, display_no: ticket.display_no, event: 'status', status: alvo });
    res.json({ success: true, status: alvo });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (e) { /* já rolou */ }
    console.error('Erro ao mudar status do chamado:', error);
    res.status(500).json({ error: 'Erro ao mudar o status do chamado.' });
  } finally {
    client.release();
  }
};

// ── PUT /tickets/:id/priority — reclassificação pelo atendente (rota gateada) ──
export const updateTicketPriority = async (req: Request, res: Response) => {
  const { id } = req.params;
  const requester = (req as any).user;
  const { priority } = req.body ?? {};
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!PRIORIDADES.includes(priority)) {
    return res.status(400).json({ error: `Prioridade inválida. Use: ${PRIORIDADES.join(', ')}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query('SELECT display_no, requester_id, priority FROM tickets WHERE id = $1 FOR UPDATE', [id]);
    if (tRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const ticket = tRes.rows[0];
    await client.query(
      'UPDATE tickets SET priority = $1, updated_at = now(), version = version + 1 WHERE id = $2',
      [priority, id],
    );
    // Auditoria com o DIFF {de, para} — decisão travada: reclassificação é rota própria auditada.
    await createLog(requester.id, 'RECLASSIFICAR_CHAMADO',
      { ticket_id: id, display_no: ticket.display_no, de: ticket.priority, para: priority }, getClientIp(req), client);
    await client.query('COMMIT');

    emitTicket(req, ticket.requester_id, { ticketId: id, display_no: ticket.display_no, event: 'prioridade', priority });
    res.json({ success: true, priority });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (e) { /* já rolou */ }
    console.error('Erro ao reclassificar chamado:', error);
    res.status(500).json({ error: 'Erro ao reclassificar o chamado.' });
  } finally {
    client.release();
  }
};
