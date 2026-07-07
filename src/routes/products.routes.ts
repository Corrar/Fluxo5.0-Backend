import { Router } from 'express';
// 1. Atualizámos as importações para trazer o nosso novo 'Cão de Guarda' (requirePermission)
import { authenticate, authorizeRole, requirePermission } from '../middlewares/auth'; 
import { 
    getProducts, 
    getLowStockProducts, 
    createProduct, 
    updateProduct, 
    deleteProduct, 
    updatePurchaseInfo,
    reactivateProduct,
    getInactiveProducts,
    updateProductPrices 
} from '../controllers/products.controller';

const router = Router();

// ============================================================================
// 🛡️ ROTAS DE LEITURA (Requerem a permissão de visualização básica)
// ============================================================================

// Listar produtos ativos no catálogo
router.get('/', authenticate, requirePermission('produtos:view'), getProducts);

// Listar produtos com stock baixo (Alinhado com a permissão de relatórios/críticos)
router.get('/low-stock', authenticate, requirePermission('estoque_critico:view'), getLowStockProducts);

// 🗑️ Rota para procurar produtos inativos (fantasmas) - DEVE vir antes das rotas com /:id
router.get('/inactive', authenticate, requirePermission('produtos:view'), getInactiveProducts);

// ============================================================================
// 🛡️ ROTAS DE CRIAÇÃO (Requerem permissão de adição)
// ============================================================================

// Criar um novo produto no sistema
router.post('/', authenticate, requirePermission('produtos:add'), createProduct);

// ============================================================================
// 🛡️ ROTAS DE EDIÇÃO (Requerem permissão de edição)
// ============================================================================

// ♻️ Rota para reativar produtos inativos (fantasmas)
router.put('/reactivate/:sku', authenticate, requirePermission('produtos:edit'), reactivateProduct);

// Atualizar dados gerais de um produto específico
router.put('/:id', authenticate, requirePermission('produtos:edit'), updateProduct);

// ============================================================================
// 🛡️ ROTAS FINANCEIRAS E DE COMPRAS (Permissões específicas)
// ============================================================================

// 💰 Rota exclusiva para atualizar preços (Requer a ação granular 'valores:edit')
router.patch(
    '/:id/prices', 
    authenticate, 
    requirePermission('valores:edit'), 
    updateProductPrices
);

// Rota para atualizar informações de compra (Carrinho de compras)
// Como o modo de compra no Frontend ainda usa a regra global de cargo (role), mantemos o authorizeRole aqui para não quebrar o fluxo.
router.put(
    '/:id/purchase-info', 
    authenticate, 
    authorizeRole(['admin', 'compras']), 
    updatePurchaseInfo
);

// ============================================================================
// 🛡️ ROTAS DE EXCLUSÃO (Requerem permissão crítica)
// ============================================================================

// Eliminar um produto permanentemente ou arquivá-lo
router.delete('/:id', authenticate, requirePermission('produtos:delete'), deleteProduct);

export default router;
