// src/services/requests3d.ts — Fluxo Royale 5.0 (lote I-a: o 3D vira estoque físico)
//
// A FÓRMULA ÚNICA DE LIBERAÇÃO DO ITEM 3D, num lugar só.
//
// POR QUE ESTE ARQUIVO EXISTE: três portas diferentes liberam a reserva de uma solicitação —
// a rejeição (requests.controller, PUT /:id/status), o cancelamento (DELETE /:id) e o cron de
// expiração (expireRequests.job, outro arquivo). Antes do lote I-a as três PULAVAM o item 3D
// (guard `!is_3d`), e foi exatamente isso que prendeu 10 unidades de reserva em 4 solicitações
// rejeitadas na validação. Agora as três liberam — e "fórmula única" só é verdade se houver um
// único corpo de código. Duplicar oito linhas em três arquivos seria três fórmulas com o mesmo
// nome, que é como a divergência nasce.
//
// A FÓRMULA: libera-se `request_items.qty_reserved` — o que ESTE item segura AGORA — e nunca
// `quantity_requested` ou `quantity_delivered`. Os dois últimos são o que se PEDIU e o que se
// CONFERIU; nenhum dos dois é o que está preso no pooled quando houve reserva parcial na criação
// (3D com estoque insuficiente) ou ajuste na conferência. A coluna é a única que responde isso.
//
// ⚠ ASSIMETRIA TEMPORÁRIA DECLARADA: o caminho NÃO-3D continua com a fórmula antiga
// (`quantity_delivered ?? quantity_requested`) neste lote, por decisão do arquiteto — unificar
// os dois exige reconciliar a coluna com o razão para todas as solicitações vivas e vira lote
// próprio. Até lá convivem duas fórmulas, e é de propósito: esta cobre o 3D, aquela o resto.

import type { PoolClient } from 'pg';
import { StockService } from './stock.service';
import { POOLED_OP_ID } from './warehouse';

/** Shape mínimo que as queries de item das três portas precisam trazer. */
export interface ItemDeSolicitacao {
  id: string;
  product_id: string | null;
  is_3d?: boolean | null;
  qty_reserved?: string | number | null;
}

export interface ContextoLiberacao {
  requestId: string;
  userId: string | null;
  warehouseId: string;
  /** Texto do razão — o que distingue rejeição de cancelamento de expiração no livro. */
  reason: string;
}

/** NUMERIC do pg chega como string; qualquer lixo vira 0 (nunca NaN entrando no motor). */
export const qtyReservadaDoItem = (item: ItemDeSolicitacao): number => {
  const n = parseFloat(String(item.qty_reserved ?? '0'));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Libera a reserva viva de UM item 3D e zera a coluna, atomicamente com o resto da transação.
 *
 * op_key `request:<id>:item:<item_id>:release` — a MESMA das outras duas portas, de propósito:
 * se rejeição e cron correrem em paralelo sobre a mesma solicitação, o razão deduplica e a
 * segunda vira no-op em vez de liberar duas vezes. Como a quantidade agora sai da coluna (e não
 * de uma conta refeita em cada porta), as três chegam ao MESMO valor — que é a condição para a
 * chave compartilhada ser correta, e não só idempotente.
 *
 * Devolve quanto liberou (0 = nada a fazer), para o chamador decidir se emite `stock_updated`.
 */
export async function liberarReserva3D(
  client: PoolClient,
  item: ItemDeSolicitacao,
  ctx: ContextoLiberacao,
): Promise<number> {
  if (!item.product_id) return 0;
  const qty = qtyReservadaDoItem(item);
  if (qty <= 0) return 0;

  await StockService.release(client, item.product_id, ctx.warehouseId, POOLED_OP_ID, qty, {
    refType: 'request', refId: ctx.requestId, userId: ctx.userId,
    opKey: `request:${ctx.requestId}:item:${item.id}:release`,
    reason: ctx.reason,
  });

  // Zera SEMPRE que o release passou — inclusive quando o motor deduplicou pela op_key (outra
  // porta já liberou): nesse caso o saldo já está certo e a coluna é que estava atrasada.
  await client.query('UPDATE request_items SET qty_reserved = 0 WHERE id = $1', [item.id]);
  return qty;
}

/**
 * Abate `qty` da reserva do item (entrega: o que foi consumido deixa de estar reservado).
 * Devolve o que SOBROU na coluna — o excedente que a entrega precisa liberar.
 *
 * GREATEST(...,0): guarda de coerência, não maquiagem. O CHECK `qty_reserved >= 0` (migration
 * 020) derrubaria a transação inteira, e uma entrega correta não pode morrer porque uma conta
 * auxiliar ficou negativa. Os chamadores só passam `qty <= qty_reserved` (a entrega valida isso
 * ANTES, com 400 próprio) — se isto clampar, há bug a montante e o valor final é 0, que é o
 * estado seguro.
 */
export async function abaterQtyReservada(client: PoolClient, itemId: string, qty: number): Promise<number> {
  const { rows } = await client.query<{ qty_reserved: string }>(
    'UPDATE request_items SET qty_reserved = GREATEST(qty_reserved - $2::numeric, 0) WHERE id = $1 RETURNING qty_reserved',
    [itemId, qty],
  );
  return parseFloat(String(rows[0]?.qty_reserved ?? '0')) || 0;
}

/**
 * Conclusão da demanda 3D: credita a peça produzida ao ITEM de solicitação que a esperava.
 *
 * POR QUE PRECISA EXISTIR: a conclusão já dava `receive` + `reserve` no pooled. A reserva ficava
 * no SALDO, mas nenhum item sabia dela — e é `qty_reserved` que a entrega exige e que a rejeição
 * libera. Sem este crédito a entrega recusaria (ENTREGA_3D_SEM_PECA) uma peça que está ali, e a
 * rejeição deixaria no pooled uma reserva sem dono: uma órfã nova, do mesmo formato das 10 que o
 * recon (d) mediu.
 *
 * RESOLUÇÃO DO ITEM ALVO, em três degraus declarados:
 *   1. `request_item_id` (migration 020) — o vínculo direto. É o caminho de toda demanda nascida
 *      a partir deste lote.
 *   2. Demanda LEGADA (request_item_id NULL): deriva por (request_id, product_id) e credita no
 *      PRIMEIRO item ainda não satisfeito (qty_reserved < quantity_requested), em ordem de id.
 *      É o rateio que o desenho pediu para o caso ambíguo — duas linhas do mesmo produto no mesmo
 *      pedido são indistinguíveis por construção, e "a primeira que ainda falta" é a única regra
 *      que não inventa informação.
 *   3. Todos já satisfeitos: credita no primeiro item daquele produto mesmo assim. A peça existe
 *      e está reservada no saldo — deixá-la sem dono seria criar a órfã que este lote veio matar.
 *      Ela vira EXCEDENTE do item e sai pela liberação de excedente da entrega (ou pela rejeição).
 *
 * Devolve o id do item creditado, ou null quando não há item nenhum a que atribuir (demanda sem
 * solicitação, ou solicitação sem linha daquele produto) — aí o chamador registra o aviso.
 */
export async function creditarProducaoNoItem(
  client: PoolClient,
  params: { requestId: string | null; productId: string | null; requestItemId: string | null; qty: number },
): Promise<string | null> {
  const { requestId, productId, requestItemId, qty } = params;
  if (!(qty > 0)) return null;

  let alvo: string | null = requestItemId ?? null;

  if (!alvo && requestId && productId) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM request_items
        WHERE request_id = $1 AND product_id = $2
        ORDER BY (qty_reserved < quantity_requested) DESC, id
        LIMIT 1`,
      [requestId, productId],
    );
    alvo = rows[0]?.id ?? null;
  }

  if (!alvo) return null;

  await client.query(
    'UPDATE request_items SET qty_reserved = qty_reserved + $1::numeric WHERE id = $2',
    [qty, alvo],
  );
  return alvo;
}
