import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { getReminders, createReminder, updateReminder, deleteReminder } from '../controllers/reminders.controller';

const router = Router();
router.use(authenticate);

router.get('/', getReminders);
router.post('/', createReminder);
router.put('/:id', updateReminder);
router.delete('/:id', deleteReminder);

export default router;
