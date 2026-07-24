import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { 
  getTravelOrders, 
  createTravelOrder, 
  reconcileTravelOrder, 
  updateTravelOrder, 
  deleteTravelOrder 
} from '../controllers/travels.controller';

const router = Router();

// ---------------------------------------------------------------------------
// MIDDLEWARE DE AUTENTICAÇÃO
// ---------------------------------------------------------------------------
// O 'router.use' aplica o middleware 'authenticate' a TODAS as rotas abaixo.
// Isso garante que apenas usuários logados (com token válido) possam acessar,
// criar, editar ou apagar viagens.
router.use(authenticate);

// ---------------------------------------------------------------------------
// MAPEAMENTO DE ROTAS (Endpoints)
// ---------------------------------------------------------------------------

/**
 * @route GET /
 * @desc Busca todas as viagens e seus respectivos itens.
 */
router.get('/', getTravelOrders);

/**
 * @route POST /
 * @desc Cria uma nova viagem (travel order) e reserva os itens no estoque (StockService.reserve).
 * Escreve saldo (reserve) -> separacoes:edit. Idempotência cross-request via header X-Idempotency-Key.
 */
router.post('/', requirePermission('separacoes:edit'), createTravelOrder);

/**
 * @route POST /:id/reconcile
 * @desc Realiza o acerto/confronto da viagem, dando baixa no estoque físico
 * e lidando com devoluções e itens extras.
 * Escreve saldo (release/reverseReceive/receive) -> separacoes:edit, igual replenishments/producao3d/separations.
 */
router.post('/:id/reconcile', requirePermission('separacoes:edit'), reconcileTravelOrder);

/**
 * @route PUT /:id
 * @desc Atualiza os dados de uma viagem em aberto (técnicos, cidade ou itens).
 * Escreve saldo (reserve/release) -> separacoes:edit.
 */
router.put('/:id', requirePermission('separacoes:edit'), updateTravelOrder);

/**
 * @route DELETE /:id
 * @desc Apaga uma viagem. Se estiver em aberto, devolve as reservas.
 * Se estiver concluída, reverte as movimentações de estoque físico.
 * Escreve saldo (release/receive/reverseReceive) -> separacoes:edit.
 */
router.delete('/:id', requirePermission('separacoes:edit'), deleteTravelOrder);

export default router;
