import { Router } from 'express';
import { login, register } from '../controllers/auth.controller';
import { authLimiter } from '../middlewares/rateLimiters';
import { authenticate, canManageUsers } from '../middlewares/auth';

const router = Router();

router.post('/login', authLimiter, login);
// Criar conta é ação de admin (tela de Usuários) — o produto não tem auto-cadastro.
// ⚠ Bootstrap: o 1º admin de um ambiente novo nasce por seed/SQL (ver comentário no controller).
router.post('/register', authenticate, canManageUsers, register);

export default router;