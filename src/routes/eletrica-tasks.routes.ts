import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { getEletricaTasks, createEletricaTask, updateEletricaTask, deleteEletricaTask } from '../controllers/tasks.controller';

const router = Router();
router.use(authenticate);
// RBAC unificado: page_key 'tarefas_eletrica' via requirePermission (role_permissions
// UNION user_permissions + bypass admin). Substitui o checkEletricaPermission paralelo,
// que ignorava user_permissions e tinha atalho por setor 'Elétrica' (sem efeito no seed;
// se produção tiver usuário desse setor, conceder a permissão pela tela de Permissões).
router.use(requirePermission('tarefas_eletrica'));

router.get('/', getEletricaTasks);
router.post('/', createEletricaTask);
router.put('/:id', updateEletricaTask);
router.delete('/:id', deleteEletricaTask);

export default router;
