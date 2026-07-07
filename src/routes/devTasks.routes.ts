import { Router } from 'express';
import { getTasks, createTask } from '../controllers/devTasks.controller';
import { authenticate } from '../middlewares/auth'; // ✨ CORREÇÃO: Nome da função atualizado

const router = Router();

// Rota GET para listar as tarefas
router.get('/', authenticate, getTasks); // ✨ CORREÇÃO: Usando 'authenticate'

// Rota POST para criar uma tarefa
router.post('/', authenticate, createTask); // ✨ CORREÇÃO: Usando 'authenticate'

export default router;
