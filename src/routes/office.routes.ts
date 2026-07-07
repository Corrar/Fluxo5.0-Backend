import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { getOfficeExits, checkEpi, subscribeNotification } from '../controllers/office.controller';

const router = Router();
router.use(authenticate);

router.get('/exits', getOfficeExits);
router.patch('/exits/:id/check-epi', checkEpi);

// O frontend chama POST /notifications/subscribe. Vou anexar aqui neste router por facilidade.
router.post('/subscribe-push', subscribeNotification);

export default router;
