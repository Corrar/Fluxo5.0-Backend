import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
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
 * @desc Cria uma nova viagem (travel order) e reserva os itens no estoque.
 */
router.post('/', createTravelOrder);

/**
 * @route POST /:id/reconcile
 * @desc Realiza o acerto/confronto da viagem, dando baixa no estoque físico 
 * e lidando com devoluções e itens extras.
 */
router.post('/:id/reconcile', reconcileTravelOrder);

/**
 * @route PUT /:id
 * @desc Atualiza os dados de uma viagem em aberto (técnicos, cidade ou itens).
 */
router.put('/:id', updateTravelOrder);

/**
 * @route DELETE /:id
 * @desc Apaga uma viagem. Se estiver em aberto, devolve as reservas. 
 * Se estiver concluída, reverte as movimentações de estoque físico.
 */
router.delete('/:id', deleteTravelOrder);

export default router;
