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
  getProductImage,
    updateProductPrices 
} from '../controllers/products.controller';

const router = Router();

// ============================================================================
// 🛡️ ROTAS DE LEITURA (Requerem a permissão de visualização básica)
// ============================================================================

// Listar produtos ativos no catálogo
router.get('/', authenticate, requirePermission('produtos:view'), getProducts);

// Listar produtos com stock baixo (Alinhado com a permissão de relatórios/críticos)
// 'estoque_critico' (SEM sufixo :view) — é a chave que o role_permissions realmente tem, com 10
// papéis semeados. 'estoque_critico:view' NÃO existe no seed (0 linhas): a rota exigia uma chave
// inexistente, então só o admin (que faz bypass em requirePermission) via a tela Críticos — todos
// os outros papéis, inclusive o almoxarife, levavam 403.
router.get('/low-stock', authenticate, requirePermission('estoque_critico'), getLowStockProducts);

// 🗑️ Rota para procurar produtos inativos (fantasmas) - DEVE vir antes das rotas com /:id
router.get('/inactive', authenticate, requirePermission('produtos:view'), getInactiveProducts);

/**
 * @route GET /products/:id/image
 * @description A FOTO do produto, em BYTES (lote BW). A listagem deixou de carregar `image_url`
 *              (eram 89,1% do payload) e passou a mandar só `has_image`; quem precisa da foto vem
 *              aqui. Decodifica o data URI guardado em `products.image_url` e responde com o
 *              Content-Type real (image/jpeg ou image/png — medido: 51 e 26).
 *
 * CACHE: ETag FORTE derivado do conteúdo + `Cache-Control: private, max-age=3600, must-revalidate`.
 *        `If-None-Match` casando devolve 304 sem corpo. É o que impede a troca de "1 payload
 *        grande" por "N requisições grandes" — sem cache, o item 1 seria um empate.
 *        `private` porque a rota é autenticada: proxy compartilhado não pode guardar.
 *
 * RBAC: `produtos:view` — a MESMA chave da listagem. Quem vê o produto vê a foto dele.
 *
 * 404 quando o produto não existe OU não tem imagem (declarado); 415 se o dado não for um data URI
 * base64 (guard: hoje são 77/77 no padrão, mas formato inesperado vira erro explícito e não uma
 * imagem quebrada).
 *
 * ⚠ ESTE É O DEGRAU PARA O CLOUDFLARE R2. Quando as imagens migrarem, muda só o corpo do
 * controller — a rota, o contrato e o front continuam iguais.
 */
router.get('/:id/image', authenticate, requirePermission('produtos:view'), getProductImage);

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
