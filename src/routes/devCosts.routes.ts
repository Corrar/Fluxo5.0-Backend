// src/routes/devCosts.routes.ts — Custos & Serviços v1.

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { listCosts, createCost, updateCost, deleteCost } from '../controllers/devCosts.controller';

const router = Router();

// page_key própria e separada da 'dev_area': quem cuida da agenda não necessariamente pode ver
// quanto a empresa paga de infraestrutura. Duas chaves = duas concessões independentes na tela
// de Permissões.
router.use(authenticate, requirePermission('dev_custos'));

// GET devolve {items, total_mensal, por_categoria} — o total é CALCULADO no controller, numa
// fonte de verdade só (ver o cabeçalho do devCosts.controller.ts).
router.get('/', listCosts);
router.post('/', createCost);
router.put('/:id', updateCost);
router.delete('/:id', deleteCost);

export default router;
