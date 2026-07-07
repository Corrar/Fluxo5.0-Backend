import { Router } from 'express';
import { trackPackage } from '../controllers/tracking.controller';
import { authenticate } from '../middlewares/auth'; // <-- Corrigido para 'authenticate'

const router = Router();

// Rota protegida. O frontend vai chamar GET /api/tracking/CODIGO_AQUI
router.get('/:code', authenticate, trackPackage); // <-- Corrigido aqui também

export default router;
