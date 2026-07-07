// src/routes/stock.routes.ts

import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { 
  getStock, 
  getStockReservations, 
  updateStock, 
  manualWithdrawal,
  getOpMaterialsForReturn, 
  registerReturn,
  registerEntries // A nova função do controller
} from '../controllers/stock.controller';

const router = Router();

/**
 * 🔒 MIDDLEWARE GLOBAL DA ROTA
 * O 'router.use(authenticate)' garante que todas as requisições que 
 * passarem por este arquivo exijam um token válido.
 */
router.use(authenticate);

// =========================================================================
// ROTAS NATIVAS DE ESTOQUE (Prefixo herdado: /stock)
// =========================================================================

/**
 * @route GET /stock/
 * @description Retorna a lista completa com o status atual do estoque.
 */
router.get('/', getStock);

/**
 * @route GET /stock/:id/reservations
 * @description Retorna a lista de reservas ativas para um item específico.
 * @param {string} id - O ID do item de estoque.
 */
router.get('/:id/reservations', getStockReservations);

/**
 * @route PUT /stock/:id
 * @description Atualiza os dados de um item específico no estoque (como ajustes manuais diretos).
 * @param {string} id - O ID do item de estoque.
 */
router.put('/:id', updateStock);

// =========================================================================
// ROTAS DE TRANSAÇÕES MANUAIS E EM LOTE
// =========================================================================

/**
 * @route POST /stock/manual-withdrawal
 * @description Registra a saída/retirada de produtos (subtrai do físico).
 * @body { sector: string, op_code?: string, items: Array<{ product_id: string, quantity: number }> }
 */
router.post('/manual-withdrawal', manualWithdrawal);

/**
 * @route POST /stock/entries
 * @description Registra entradas de lote vindas dos novos painéis (NFe, Reaproveitamentos).
 * @body { entries: Array<{ product_id: string, quantity: number, type: string, observation?: string }> }
 */
router.post('/entries', registerEntries); // O Endpoint novo que fica no lugar da entrada manual

// =========================================================================
// ROTAS DE DEVOLUÇÕES (OP)
// =========================================================================

/**
 * @route GET /stock/returns/op/:opCode
 * @description Busca os materiais que foram retirados para uma OP e podem ser devolvidos.
 * @param {string} opCode - O código da Ordem de Produção.
 */
router.get('/returns/op/:opCode', getOpMaterialsForReturn);

/**
 * @route POST /stock/returns
 * @description Efetiva a devolução de materiais de uma OP ao armazém (atualiza op_returns e stock).
 * @body { op_code: string, returns: Array<{ product_id: string, quantity: number, observation?: string }> }
 */
router.post('/returns', registerReturn);

export default router;
