import { Router } from 'express';
import { authenticate, canManageUsers } from '../middlewares/auth';
// 1. Importa a função resetPassword (que vamos criar no controlador)
import { getUsers, updateRole, updateStatus, deleteUser, heartbeat, resetPassword } from '../controllers/users.controller';

const router = Router();

// Aplica o middleware de autenticação a TODAS as rotas de utilizadores
router.use(authenticate);

router.get('/', getUsers);
router.put('/:id/heartbeat', heartbeat);
// Mudar cargo e excluir conta são ações de admin (canManageUsers consulta o cargo
// em tempo real na base — não confia no role do JWT).
router.put('/:id/role', canManageUsers, updateRole);
router.put('/:id/status', updateStatus);
router.delete('/:id', canManageUsers, deleteUser);

// 2. Adiciona a nova rota POST para redefinir a senha
router.post('/:id/reset-password', resetPassword);

export default router;
