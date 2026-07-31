// src/routes/devRepos.routes.ts — Relatório de trabalho em código (espelho GitHub) v1.

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  listRepos,
  createRepo,
  updateRepo,
  deleteRepo,
  syncRepo,
  syncAll,
  getReport,
} from '../controllers/devRepos.controller';

const router = Router();

// Sessão válida + a page_key 'dev_repos' em TODA rota, inclusive a leitura: o relatório mostra
// o trabalho de código da empresa inteira e não é informação de qualquer logado. DB-driven —
// a tela de Permissões concede a outro papel sem tocar em código.
router.use(authenticate, requirePermission('dev_repos'));

// 📄 Relatório — ANTES de qualquer '/:id' (senão 'report' seria lido como id e daria 400).
router.get('/report', getReport);

// 🔄 Sincronizar TODOS os ativos — também antes do '/:id/...' pela mesma razão ('sync-all').
router.post('/sync-all', syncAll);

// 📋 Cadastro dos repositórios espelhados.
router.get('/', listRepos);
router.post('/', createRepo);
router.put('/:id', updateRepo);
// DELETE só sem commits espelhados — com histórico, 409 orientando a DESATIVAR.
router.delete('/:id', deleteRepo);

// 🔄 Sincronizar UM repo (o botão é o retry: sem retry automático no controller).
router.post('/:id/sync', syncRepo);

export default router;
