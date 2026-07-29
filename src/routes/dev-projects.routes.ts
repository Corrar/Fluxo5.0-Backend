// src/routes/dev-projects.routes.ts — dev-projetos v1 (projetos internos do dev).

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from '../controllers/dev-projects.controller';

const router = Router();

// Router INTEIRO atrás do gate: ferramenta interna do Dev, sem superfície pública.
// 'projetos' nasceu no universo da tela Permissões pela migration 013 (linha do admin —
// que nem precisa dela, bypass por JWT — existe pra chave ser visível e concedível).
router.use(authenticate);
router.use(requirePermission('projetos'));

// 📋 A grade (?status= ativo|arquivado|todos; default ativo).
router.get('/', getProjects);
// 🔎 Detalhe — sustenta o modal recarregável e a checagem 404 pós-exclusão do smoke.
router.get('/:id', getProject);
// ➕ Criar (created_by SEMPRE do token; op_code opcional resolve em client_services).
router.post('/', createProject);
// ✏️ Edição parcial + arquivar/reativar (transição livre — sem máquina, ver controller).
router.put('/:id', updateProject);
// 🗑️ Hard delete (decisão: ferramenta interna; o confirm vive na tela).
router.delete('/:id', deleteProject);

export default router;
