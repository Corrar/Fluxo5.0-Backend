import { Router } from 'express';
// 1. Importamos o nosso middleware de proteção granular (requirePermission)
import { authenticate, requirePermission } from '../middlewares/auth';
import { 
    getClients, 
    createClient, 
    updateClient, 
    deleteClient, 
    createService, 
    updateServiceStatus, 
    deleteService,
    transferServiceData 
} from '../controllers/clients.controller';

const router = Router();

// ==========================================
// 🛡️ ROTAS DE CLIENTES
// ==========================================

// Buscar todos os clientes (Requer permissão de visualização básica)
router.get('/', authenticate, requirePermission('clientes:view'), getClients);

// Criar novo cliente (Requer permissão de adição)
router.post('/', authenticate, requirePermission('clientes:add'), createClient);

// Atualizar (renomear) cliente (Requer permissão de edição)
router.put('/:id', authenticate, requirePermission('clientes:edit'), updateClient);

// Excluir cliente (Requer permissão crítica de exclusão)
router.delete('/:id', authenticate, requirePermission('clientes:delete'), deleteClient);


// ==========================================
// 🛡️ ROTAS DE SERVIÇOS (ORDENS DE PRODUÇÃO)
// ==========================================

// Criar nova OP para um cliente específico (Requer permissão de adição)
router.post('/:id/services', authenticate, requirePermission('clientes:add'), createService);

// Atualizar o status de uma OP (Requer permissão de edição)
router.patch('/services/:serviceId/status', authenticate, requirePermission('clientes:edit'), updateServiceStatus);

// Transferir movimentações de uma OP para outra / Merge (Requer permissão de edição)
router.post('/services/:serviceId/transfer', authenticate, requirePermission('clientes:edit'), transferServiceData); 

// Excluir uma OP (Requer permissão crítica de exclusão)
router.delete('/services/:serviceId', authenticate, requirePermission('clientes:delete'), deleteService);

export default router;
