// src/routes/dev-dashboard.routes.ts — dev-painel v1 (leitura agregada do módulo Dev).

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { getDevDashboard } from '../controllers/dev-dashboard.controller';

const router = Router();

// Router INTEIRO atrás do gate, padrão dev-projects. A chave 'dev_dashboard' é PRÓPRIA (não
// reusa 'chamados'): o painel cruza chamados E projetos — ver o porquê no cabeçalho da
// migration 015, que também faz a chave nascer no universo da tela Permissões.
router.use(authenticate);
router.use(requirePermission('dev_dashboard'));

// 📊 O painel inteiro numa chamada (envelope agregado; nenhuma escrita, nenhum log de leitura).
router.get('/', getDevDashboard);

export default router;
