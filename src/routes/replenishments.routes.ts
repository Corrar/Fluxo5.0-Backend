import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { getReplenishments, createReplenishment, updateReplenishment, authorizeReplenishment, deleteReplenishment } from '../controllers/replenishments.controller';

const router = Router();
router.use(authenticate);

router.get('/', getReplenishments);
router.post('/', createReplenishment);
router.put('/:id', updateReplenishment);
// authorize escreve saldo (reserve/consume/receive) -> exige a mesma permissão do fluxo análogo (separations authorize).
router.put('/:id/authorize', requirePermission('separacoes:edit'), authorizeReplenishment);
// cancelar libera reserva (StockService.release) -> mesma família/permissão do authorize.
router.delete('/:id', requirePermission('separacoes:edit'), deleteReplenishment);

export default router;
