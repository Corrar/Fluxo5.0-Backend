import { pool } from '../db';
import { createLog } from '../utils/logger';

export const startExpireRequestsJob = () => {
  setInterval(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: expiredRequests } = await client.query(`
        SELECT id FROM requests 
        WHERE status IN ('aberto', 'aprovado') 
        AND created_at < NOW() - INTERVAL '15 days'
        FOR UPDATE SKIP LOCKED
      `);

      for (const req of expiredRequests) {
         const itemsRes = await client.query('SELECT product_id, quantity_requested FROM request_items WHERE request_id = $1', [req.id]);
         for (const item of itemsRes.rows) {
           if (item.product_id) {
             await client.query(`
               UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2
             `, [item.quantity_requested, item.product_id]);
           }
         }
         await client.query(`UPDATE requests SET status = 'rejeitado', rejection_reason = 'Expirado pelo sistema (Timeout 15 dias)' WHERE id = $1`, [req.id]);
         // Nota: usamos '127.0.0.1' porque é o próprio servidor a fazer a ação
         await createLog(null, 'TIMEOUT_REQUEST', { requestId: req.id, reason: 'Expiração automática' }, '127.0.0.1', client);
      }
      await client.query('COMMIT');
      if (expiredRequests.length > 0) console.log(`🧹 Cron: ${expiredRequests.length} reservas expiradas e libertadas.`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Erro no Cron de Expiração:", error);
    } finally {
      client.release();
    }
  }, 1000 * 60 * 60 * 24); // Executa a cada 24 horas
  
  console.log("⏳ Cron Job de expiração de reservas inicializado.");
};