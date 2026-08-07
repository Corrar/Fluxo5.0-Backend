import { withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { StockService } from '../services/stock.service';
import { emitStockChanged } from '../config/socket';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';
import { liberarReserva3D, abaterQtyReservada } from '../services/requests3d';

// Varredura de expiração — extraída do setInterval para ser testável (smoke chama direto).
// ESPELHO do handler de rejeição manual (updateRequestStatus, status='rejeitado'):
//   - NÃO-3D: libera quantity_delivered ?? quantity_requested (pedido ajustado libera o que
//     REALMENTE segura);
//   - 3D: libera `request_items.qty_reserved` pela FÓRMULA ÚNICA (services/requests3d). O guard
//     `!is_3d` que existia aqui CAIU no lote I-a. O comentário antigo dizia que o 3D "é acertado
//     pelo fluxo de produção" — não era: nada acertava. A reserva parcial nascida na criação
//     ficava presa para sempre quando o cron expirava a solicitação, exatamente como no reject
//     manual (10 unidades presas medidas na validação pelo recon (d));
//   - MESMA op_key do reject manual (request:<id>:item:<itemId>:release): se um reject manual
//     correr em paralelo, o razão deduplica (no-op) em vez de liberar duas vezes;
//   - release pelo MOTOR: warehouse + op_id IS NULL no grão certo, razão gravado, sem GREATEST(0,...)
//     mascarando furo. O UPDATE cru antigo varria TODAS as linhas do produto (sem warehouse/op_id),
//     liberava itens 3D nunca reservados por inteiro e não deixava rastro no razão.
//
// ⚠ O QUE ESTE LOTE NÃO FAZ (lote I-b): expirar a solicitação continua NÃO cancelando a demanda
// 3D viva no Kanban. Concluí-la depois volta a creditar peça e a mexer no status da solicitação.
// Fora de escopo aqui de propósito — está mapeado e tem lote próprio.
export const runExpireRequestsSweep = async (): Promise<number> => {
  // Produtos cujo saldo o cron liberou. Preenchido dentro da transação; emitido DEPOIS que ela
  // fecha — ver o emit no fim desta função.
  const produtosTocados: string[] = [];
  const total = await withTransaction(async (client) => {
    const { rows: expiredRequests } = await client.query(`
      SELECT id FROM requests
      WHERE status IN ('aberto', 'aprovado')
      AND created_at < NOW() - INTERVAL '15 days'
      FOR UPDATE SKIP LOCKED
    `);
    if (expiredRequests.length === 0) return 0;

    const warehouseId = await resolveWarehouseId(client, null);
    for (const req of expiredRequests) {
      const itemsRes = await client.query(
        `SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, ri.qty_reserved, p.is_3d
         FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id
         WHERE ri.request_id = $1`,
        [req.id],
      );
      for (const item of itemsRes.rows) {
        if (!item.product_id) continue;
        if (item.is_3d) {
          // PORTA 8 — fórmula única. `liberou` é 0 quando o item não segurava nada (3D 100%
          // produzido sob demanda, ou já liberado por outra porta): sem movimento, sem emit.
          const liberou = await liberarReserva3D(client, item, {
            requestId: req.id, userId: null, warehouseId,
            reason: 'Expiração automática (timeout 15 dias) — peça 3D',
          });
          if (liberou > 0) produtosTocados.push(item.product_id);
        } else {
          const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
          if (finalQty > 0) {
            produtosTocados.push(item.product_id);
            await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
              refType: 'request', refId: req.id, userId: null,
              opKey: `request:${req.id}:item:${item.id}:release`,
              reason: 'Expiração automática (timeout 15 dias)',
            });
            await abaterQtyReservada(client, item.id, finalQty);
          }
        }
      }
      await client.query(`UPDATE requests SET status = 'rejeitado', rejection_reason = 'Expirado pelo sistema (Timeout 15 dias)' WHERE id = $1`, [req.id]);
      // Nota: usamos '127.0.0.1' porque é o próprio servidor a fazer a ação
      await createLog(null, 'TIMEOUT_REQUEST', { requestId: req.id, reason: 'Expiração automática' }, '127.0.0.1', client);
    }
    return expiredRequests.length;
  });

  // O cron não tem `req`, então nunca teve como usar o `req.io` que os controllers usam — era o
  // único caminho de estoque estruturalmente impedido de avisar a tela. `emitStockChanged` cai no
  // `io` do módulo (o mesmo do emitStockState), e é no-op se o socket não subiu (smoke/teste).
  // FORA da transação de propósito: liberar reserva e avisar não podem estar no mesmo destino —
  // um erro de socket não pode desfazer um release já comitado.
  emitStockChanged(produtosTocados);
  return total;
};

export const startExpireRequestsJob = () => {
  setInterval(async () => {
    try {
      const n = await runExpireRequestsSweep();
      if (n > 0) console.log(`🧹 Cron: ${n} solicitações expiradas — reservas liberadas pelo motor.`);
    } catch (error) {
      console.error('Erro no Cron de Expiração:', error);
    }
  }, 1000 * 60 * 60 * 24); // Executa a cada 24 horas

  console.log('⏳ Cron Job de expiração de reservas inicializado.');
};
