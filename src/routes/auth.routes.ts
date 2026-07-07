import { Router } from 'express';
import { login, register } from '../controllers/auth.controller';
import { authLimiter } from '../middlewares/rateLimiters';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/register', register); // Em alguns sistemas o register também exige autenticação, se for o caso avisar-me

export default router;