import { withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { StockService } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

// Varredura de expiração — extraída do setInterval para ser testável (smoke chama direto).
// ESPELHO do handler de rejeição manual (updateRequestStatus, status='rejeitado'):
//   - libera quantity_delivered ?? quantity_requested (pedido ajustado libera o que REALMENTE segura);
//   - SÓ itens não-3D (3D reserva parcial na criação e é acertado pelo fluxo de produção — mesma
//     doutrina do reject/cancel manual);
//   - MESMA op_key do reject manual (request:<id>:item:<itemId>:release): se um reject manual
//     correr em paralelo, o razão deduplica (no-op) em vez de liberar duas vezes;
//   - release pelo MOTOR: warehouse + op_id IS NULL no grão certo, razão gravado, sem GREATEST(0,...)
//     mascarando furo. O UPDATE cru antigo varria TODAS as linhas do produto (sem warehouse/op_id),
//     liberava itens 3D nunca reservados por inteiro e não deixava rastro no razão.
export const runExpireRequestsSweep = async (): Promise<number> => {
  return withTransaction(async (client) => {
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
        `SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.is_3d
         FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id
         WHERE ri.request_id = $1`,
        [req.id],
      );
      for (const item of itemsRes.rows) {
        if (item.product_id && !item.is_3d) {
          const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
          if (finalQty > 0) {
            await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
              refType: 'request', refId: req.id, userId: null,
              opKey: `request:${req.id}:item:${item.id}:release`,
              reason: 'Expiração automática (timeout 15 dias)',
            });
          }
        }
      }
      await client.query(`UPDATE requests SET status = 'rejeitado', rejection_reason = 'Expirado pelo sistema (Timeout 15 dias)' WHERE id = $1`, [req.id]);
      // Nota: usamos '127.0.0.1' porque é o próprio servidor a fazer a ação
      await createLog(null, 'TIMEOUT_REQUEST', { requestId: req.id, reason: 'Expiração automática' }, '127.0.0.1', client);
    }
    return expiredRequests.length;
  });
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
