import { Router } from 'express';
// 1. Importamos o nosso "Cão de Guarda" (requirePermission) junto com a autenticação
import { authenticate, requirePermission } from '../middlewares/auth';
import { 
    getSeparations, 
    createSeparation, 
    authorizeSeparation, 
    deleteSeparation,
    updateSeparation,      
    createReturn,          
    updateReturnStatus     
} from '../controllers/separations.controller';

const router = Router();

// ==========================================
// 🛡️ ROTAS DE SOLICITAÇÕES / SEPARAÇÕES
// ==========================================

// 📋 Visualizar separações (Requer permissão básica de leitura)
router.get('/', authenticate, requirePermission('separacoes:view'), getSeparations);

// ➕ Criar uma nova separação (Requer permissão de adição)
router.post('/', authenticate, requirePermission('separacoes:add'), createSeparation);

// ==========================================
// ♻️ ROTAS DE DEVOLUÇÕES
// ==========================================
// ATENÇÃO: Tem de ficar antes das rotas com /:id para o Express não confundir 'returns' com um ID

// Atualizar o status de uma devolução (Requer permissão de edição)
router.put('/returns/:returnId', authenticate, requirePermission('separacoes:edit'), updateReturnStatus);

// Criar um registro de devolução (Requer permissão de edição)
router.post('/:id/return', authenticate, requirePermission('separacoes:edit'), createReturn);

// ==========================================
// 📦 ROTAS DE GESTÃO DO PEDIDO (com parâmetro :id)
// ==========================================

// Modificar o status / Autorizar ou Entregar (Requer permissão de edição)
router.put('/:id/authorize', authenticate, requirePermission('separacoes:edit'), authorizeSeparation);

// Atualizar os itens ou dados base do pedido (Requer permissão de edição)
router.put('/:id', authenticate, requirePermission('separacoes:edit'), updateSeparation); 

// 🗑️ Excluir um pedido (Requer permissão crítica de exclusão)
router.delete('/:id', authenticate, requirePermission('separacoes:delete'), deleteSeparation);

export default router;
