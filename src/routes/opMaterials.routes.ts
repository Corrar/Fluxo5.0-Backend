// src/routes/opMaterials.routes.ts — armazém de material por OP (peça 1 do módulo Produção).
import { Router } from 'express';
import {
  receiveOpMaterial,
  consumeOpMaterial,
  getOpBalance,
  getPendingReceipts,
} from '../controllers/opMaterials.controller';
import { authenticate, requirePermission } from '../middlewares/auth';

const router = Router();

// 🛡️ Todas as rotas exigem autenticação.
router.use(authenticate);

// ==========================================================================
// RBAC (D5) — producao:apontar, semeada pela migration 008.
// Antes dela a matriz (56 chaves) não tinha NENHUMA permissão do módulo Produção — só
// producao_3d:* (a Fábrica 3D, outro módulo). O provisório seria separacoes:edit, que é
// escalada de privilégio: pra o montador apontar peça ele ganharia junto o direito de
// AUTORIZAR e ENTREGAR separação do almoxarifado. producao:apontar corta esse vínculo.
// Papéis contemplados e os deliberadamente de fora: ver a migration 008, seção 2.
// ==========================================================================

// Escreve no razão da OP -> exige a chave de produção.
router.post('/receive', requirePermission('producao:apontar'), receiveOpMaterial);
router.post('/consume', requirePermission('producao:apontar'), consumeOpMaterial);

// Leitura -> só autenticação (mesmo critério dos GETs de /producao-3d).
router.get('/balance/:clientServiceId', getOpBalance);
router.get('/pending-receipts', getPendingReceipts);

export default router;
