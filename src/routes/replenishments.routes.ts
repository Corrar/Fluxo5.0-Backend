import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { getReplenishments, createReplenishment, updateReplenishment, authorizeReplenishment, deleteReplenishment } from '../controllers/replenishments.controller';

const router = Router();
router.use(authenticate);

router.get('/', getReplenishments);
router.post('/', createReplenishment);
router.put('/:id', updateReplenishment);
router.put('/:id/authorize', authorizeReplenishment);
router.delete('/:id', deleteReplenishment);

export default router;
