// src/routes/producao3d.routes.ts
import { Router } from 'express';
import { 
  get3DParts, 
  update3DPartDetails, 
  getDemands, 
  updateDemandStatus, 
  getProductions,
  createProduction, // <-- ADICIONADO: Importação da função de criar
  deleteProduction  // <-- ADICIONADO: Importação da função de apagar
} from '../controllers/producao3d.controller';
import { authenticate } from '../middlewares/auth';

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
router.put('/demands/:id/status', updateDemandStatus);

// ==========================================
// 📊 HISTÓRICO E MÉTRICAS (Dashboard)
// ==========================================

// Busca os dados de produções finalizadas para gerar os gráficos
router.get('/productions', getProductions);

// 🚀 REGISTRA uma nova produção e dá entrada automática no estoque
router.post('/productions', createProduction);

// 🗑️ REMOVE um registro de produção e reverte a quantidade no estoque
router.delete('/productions/:id', deleteProduction);

export default router;
