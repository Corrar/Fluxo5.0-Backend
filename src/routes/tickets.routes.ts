// src/routes/tickets.routes.ts — Helpdesk v1 (chamados assíncronos).

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  createTicket,
  getMyTickets,
  getTickets,
  getTicket,
  addComment,
  updateTicketStatus,
  updateTicketPriority,
} from '../controllers/tickets.controller';

const router = Router();

// Toda rota de chamados exige sessão válida.
router.use(authenticate);

// ➕ Abrir chamado — QUALQUER logado (decisão travada; precedente literal do POST /requests).
// requester_id sai do token dentro do controller, nunca do body.
router.post('/', createTicket);

// 👤 Meus chamados — lista do requester por token. ANTES do '/:id' (senão 'my' vira id).
router.get('/my', getMyTickets);

// 📋 A FILA ÚNICA do atendente — exige a page_key 'chamados' (sem roteamento por setor).
router.get('/', requirePermission('chamados'), getTickets);

// 🔎 Detalhe + timeline — dono OU atendente (o controller decide; 404 antes de 403).
router.get('/:id', getTicket);

// 💬 Comentar — dono OU atendente; encerrado (concluido/cancelado) é 409.
router.post('/:id/comments', addComment);

// 🔁 Máquina de estados — gate FINO no controller, NÃO aqui: o alvo 'cancelado' é regra do
// DONO (independe de 'chamados'); os demais alvos exigem 'chamados' (checado inline com o
// MESMO critério do requirePermission).
router.put('/:id/status', updateTicketStatus);

// 🚩 Reclassificar prioridade — só atendente (rota própria, auditada com {de, para}).
router.put('/:id/priority', requirePermission('chamados'), updateTicketPriority);

export default router;
