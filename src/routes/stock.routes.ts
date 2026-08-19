// src/routes/stock.routes.ts

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  getStock,
  getStockReservations,
  getProductReservations,
  updateStock,
  manualWithdrawal,
  getOpMaterialsForReturn,
  getOpReturnHistory,
  registerReturn,
  getPendingReturns,
  conferReturn,
  rejectReturn,
  registerEntries, // A nova função do controller
  recountStock
} from '../controllers/stock.controller';

const router = Router();

/**
 * 🔒 MIDDLEWARE GLOBAL DA ROTA
 * O 'router.use(authenticate)' garante que todas as requisições que 
 * passarem por este arquivo exijam um token válido.
 */
router.use(authenticate);

// =========================================================================
// ROTAS NATIVAS DE ESTOQUE (Prefixo herdado: /stock)
// =========================================================================

/**
 * @route GET /stock/
 * @description Retorna a lista completa com o status atual do estoque.
 */
router.get('/', getStock);

/**
 * @route GET /stock/reservations/product/:productId
 * @description CONSULTA DE RESERVA (D-B4): agregado + origens + diferença de um produto, para o
 *              Catálogo mostrar quanto está reservado e POR QUEM sem o operador tentar a saída.
 * @param {string} productId - O ID do PRODUTO (não o da linha de stock: o Catálogo não tem esse id).
 *
 * RBAC: `produtos:view` — a mesma chave do `GET /products` (products.routes.ts:23), que é o que
 * abre o Catálogo onde esta consulta vive. Ancorar no `GET /stock/` seria ancorar em nada: aquela
 * rota não exige permissão alguma além do token do `router.use(authenticate)` acima.
 *
 * READ-ONLY, sem efeito colateral. Não existe contrapartida de escrita aqui de propósito (D-B5).
 *
 * ⚠ ORDEM DE REGISTRO: esta rota vem ANTES de `/:id/reservations` de propósito. As duas não
 * colidem hoje (3 segmentos contra 2, e o Express casa por contagem de segmento), mas o custo de
 * registrar a estática primeiro é zero e a regra vale para qualquer rota que venha depois.
 */
router.get('/reservations/product/:productId', requirePermission('produtos:view'), getProductReservations);

/**
 * @route GET /stock/:id/reservations
 * @description Retorna a lista de reservas ativas para um item específico.
 * @param {string} id - O ID do item de estoque.
 *
 * ⚠ LEGADO SEM CONSUMIDOR CONHECIDO — mantida e corrigida no Lote B, não deletada. Passou a
 * delegar ao mesmo helper das outras duas (ver nota no controller); as 4 divergências que ela
 * tinha estão no DIVIDAS.md. Se seguir sem ninguém ligar, é candidata a remoção futura.
 */
router.get('/:id/reservations', getStockReservations);

/**
 * @route PUT /stock/:id
 * @description Atualiza os dados de um item específico no estoque (como ajustes manuais diretos).
 * @param {string} id - O ID do item de estoque.
 */
router.put('/:id', updateStock);

// =========================================================================
// ROTAS DE TRANSAÇÕES MANUAIS E EM LOTE
// =========================================================================

/**
 * @route POST /stock/manual-withdrawal
 * @description Registra a saída/retirada de produtos (subtrai do físico).
 * @body { sector: string, op_code?: string, items: Array<{ product_id: string, quantity: number }> }
 */
router.post('/manual-withdrawal', requirePermission('entradas:add'), manualWithdrawal);

/**
 * @route POST /stock/entries
 * @description Registra entradas de lote vindas dos novos painéis (NFe, Reaproveitamentos).
 * @body { entries: Array<{ product_id: string, quantity: number, type: string, observation?: string }> }
 */
router.post('/entries', requirePermission('entradas:add'), registerEntries); // O Endpoint novo que fica no lugar da entrada manual

/**
 * @route POST /stock/recount
 * @description Recontagem física de inventário: item único (array de 1) ou lote (array de N, teto 500).
 *              Alvo cravado no servidor — (product_id, ALMOX, op_id NULL); o cliente nunca escolhe a linha.
 * @header X-Idempotency-Key OBRIGATÓRIO (âncora da sessão de contagem; 400 sem ele).
 * @body { items: Array<{ product_id: string (uuid), counted_qty: number >= 0 }> }
 *
 * RBAC: `estoque:edit` — a chave que já existe para quem corrige saldo (almoxarife, usinagem_lider).
 * Uma chave dedicada (`estoque:ajustar`) separaria "corrigir saldo" de "editar estoque" na auditoria;
 * ficou de fora por custo de matriz (15 classes). Ver DIVIDAS.md.
 *
 * ⚠ O `PUT /stock/:id` acima NÃO foi tocado: continua com o gate inline por role e a op_key
 *   ancorada no valor final. As duas dívidas dele estão nomeadas no DIVIDAS.md; esta rota não as herda.
 */
router.post('/recount', requirePermission('estoque:edit'), recountStock);

// =========================================================================
// ROTAS DE DEVOLUÇÕES (OP)
// =========================================================================

// Devolução em DUAS ETAPAS (peça 3): registro (produção) -> conferência (almox).
// RBAC (chaves JÁ seedadas — zero seed novo):
//   registro  -> 'producao:apontar' (semeada na 008; é o chão de fábrica declarando devolução).
//   conferir/rejeitar -> 'entradas:add' (a mesma chave da entrada/saída de estoque; conferir CREDITA
//                        o físico, então é a mesma barreira das outras rotas que mexem no estoque).
// Rota que credita físico não pode ficar em "authenticate only". Leitura -> só authenticate.

/**
 * @route GET /stock/returns/op/:opCode
 * @description Materiais da OP que ainda podem ser devolvidos (saldo WIP per-OP − em trânsito).
 * @param {string} opCode - O código da Ordem de Produção.
 */
router.get('/returns/op/:opCode', getOpMaterialsForReturn);

/**
 * @route GET /stock/returns/op/:opCode/history
 * @description Timeline de devoluções da OP (pendente/conferido/rejeitado) — a tela de produção acompanha.
 */
router.get('/returns/op/:opCode/history', getOpReturnHistory);

/**
 * @route GET /stock/returns/pending
 * @description Fila da aba Devoluções na Conferência: pedidos ainda pendentes de conferência.
 */
router.get('/returns/pending', getPendingReturns);

/**
 * @route POST /stock/returns
 * @description ETAPA 1 — registra o pedido de devolução (pendente/em trânsito). NÃO credita estoque.
 * @body { op_code: string, returns: Array<{ product_id: string, quantity: number, observation?: string }> }
 */
router.post('/returns', requirePermission('producao:apontar'), registerReturn);

/**
 * @route PUT /stock/returns/:id/confer
 * @description ETAPA 2 — confere o pedido: credita os 3 livros (per-OP, físico central, op_returns).
 *   PUT porque TRANSICIONA o estado do pedido (pendente -> conferido), no padrão do PUT /requests/:id/status.
 * @param {string} id - O id do pedido em op_returns_pending.
 * @body { conferredQty?: number } - ausente = confere o pedido inteiro.
 */
router.put('/returns/:id/confer', requirePermission('entradas:add'), conferReturn);

/**
 * @route PUT /stock/returns/:id/reject
 * @description ETAPA 2 (recusa) — rejeita o pedido. NÃO credita nada; libera a janela de trânsito.
 * @param {string} id - O id do pedido em op_returns_pending.
 * @body { reason?: string }
 */
router.put('/returns/:id/reject', requirePermission('entradas:add'), rejectReturn);

export default router;
