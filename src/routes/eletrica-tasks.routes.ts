import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { getEletricaTasks, createEletricaTask, updateEletricaTask, deleteEletricaTask } from '../controllers/tasks.controller';

const router = Router();
router.use(authenticate);

router.get('/', getEletricaTasks);
router.post('/', createEletricaTask);
router.put('/:id', updateEletricaTask);
router.delete('/:id', deleteEletricaTask);

export default router;
