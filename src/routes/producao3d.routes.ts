// src/routes/producao3d.routes.ts
import { Router } from 'express';
import {
  get3DParts,
  update3DPartDetails,
  getDemands,
  updateDemandStatus,
  updateDemandNotes,
  deleteDemand,
  getProductions,
  createProduction, // <-- ADICIONADO: Importação da função de criar
  deleteProduction  // <-- ADICIONADO: Importação da função de apagar
} from '../controllers/producao3d.controller';
import { authenticate, requirePermission } from '../middlewares/auth';

const router = Router();

/**
 * 🛡️ Todas as rotas do módulo 3D exigem autenticação.
 * O middleware verifica o token JWT antes de permitir o acesso.
 */
router.use(authenticate);

// ==========================================
// 🏗️ CATÁLOGO DE PEÇAS 3D (Lê da tabela Products)
// ==========================================

// Lista todos os produtos marcados com 'is_3d = true'
router.get('/parts', get3DParts);

// Atualiza detalhes técnicos (tempo, filamento, foto) de uma peça específica
router.put('/parts/:id', update3DPartDetails);

// ==========================================
// 📋 DEMANDAS KANBAN (Conectado às Solicitações)
// ==========================================

// Lista as solicitações de peças 3D pendentes e em curso
router.get('/demands', getDemands);

// Altera o status de uma demanda (ex: mover de 'Aceita' para 'Concluída')
// Concluir escreve saldo (receive+reserve) -> mesma permissão do fluxo análogo (separations/replenishments authorize).
router.put('/demands/:id/status', requirePermission('separacoes:edit'), updateDemandStatus);

// Edita a anotação livre da demanda (campo `notes`). Não toca estoque, mas é escrita no Kanban ->
// mesma permissão das demais ações da fábrica, pra não abrir uma porta mais frouxa que o resto.
router.put('/demands/:id/notes', requirePermission('separacoes:edit'), updateDemandNotes);

// "Excluir" demanda = soft-cancel (status='Cancelada'). Recusa cancelar demanda Concluída, cuja
// reversão correta é o DELETE /productions/:id (passa pelo reverseReceive). Ver deleteDemand.
router.delete('/demands/:id', requirePermission('separacoes:edit'), deleteDemand);

// ==========================================
// 📊 HISTÓRICO E MÉTRICAS (Dashboard)
// ==========================================

// Busca os dados de produções finalizadas para gerar os gráficos
router.get('/productions', getProductions);

// 🚀 REGISTRA uma nova produção e dá entrada automática no estoque
// Escreve saldo (receive) -> mesma permissão dos demais fluxos de escrita de estoque.
router.post('/productions', requirePermission('separacoes:edit'), createProduction);

// 🗑️ REMOVE um registro de produção e reverte a quantidade no estoque
// Escreve saldo (reverseReceive) -> mesma permissão.
router.delete('/productions/:id', requirePermission('separacoes:edit'), deleteProduction);

export default router;
