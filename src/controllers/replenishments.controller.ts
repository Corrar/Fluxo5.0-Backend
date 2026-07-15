import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

export const getReplenishments = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT rep.*, (SELECT COALESCE(json_agg(json_build_object('id', ri.id, 'product_id', ri.product_id, 'quantity', ri.quantity, 'qty_requested', ri.qty_requested, 'products', json_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'unit_price', p.unit_price, 'stock', json_build_object('quantity_on_hand', COALESCE(st.quantity_on_hand, 0), 'quantity_reserved', COALESCE(st.quantity_reserved, 0)), 'stock_available', GREATEST(0, COALESCE(st.quantity_on_hand, 0) - COALESCE(st.quantity_reserved, 0))))), '[]'::json) FROM replenishment_items ri JOIN products p ON ri.product_id = p.id LEFT JOIN stock st ON p.id = st.product_id WHERE ri.replenishment_id = rep.id) as items
      FROM replenishments rep ORDER BY rep.created_at DESC
    `);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar pedidos de reposição' }); }
};

export const createReplenishment = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { order_number, client_name, city_state, status, total_value, items } = req.body;
  const client = await pool.connect();
  try {
    validatePositiveItems(items);
    await client.query('BEGIN');
    const repRes = await client.query(`INSERT INTO replenishments (order_number, client_name, city_state, status, total_value) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [order_number, client_name, city_state, status || 'pendente', total_value || 0]);
    for (const item of items) {
      await client.query(`INSERT INTO replenishment_items (replenishment_id, product_id, qty_requested, quantity) VALUES ($1, $2, $3, 0)`, [repRes.rows[0].id, item.product_id, item.qty_requested]);
    }
    
    // 📝 LOG TRADUZIDO E MELHORADO
    await createLog(userId, 'CRIAR_REPOSICAO', { id_reposicao: repRes.rows[0].id, nf_pedido: order_number }, getClientIp(req), client);
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: repRes.rows[0].id });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
};

export const updateReplenishment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const { order_number, client_name, city_state, total_value, items } = req.body;
  const client = await pool.connect();
  try {
    validatePositiveItems(items);
    await client.query('BEGIN');
    await client.query(`UPDATE replenishments SET order_number = COALESCE($1, order_number), client_name = COALESCE($2, client_name), city_state = COALESCE($3, city_state), total_value = COALESCE($4, total_value) WHERE id = $5`, [order_number, client_name, city_state, total_value, id]);

    const existingItemsRes = await client.query('SELECT id, product_id FROM replenishment_items WHERE replenishment_id = $1', [id]);
    const newItemsMap = new Map(items.map((i: any) => [i.product_id, i]));

    for (const oldItem of existingItemsRes.rows) {
      if (!newItemsMap.has(oldItem.product_id)) {
        await client.query('DELETE FROM replenishment_items WHERE id = $1', [oldItem.id]);
      } else {
        const newItem: any = newItemsMap.get(oldItem.product_id);
        await client.query('UPDATE replenishment_items SET qty_requested = $1 WHERE id = $2', [newItem.qty_requested, oldItem.id]);
      }
    }
    for (const item of items) {
      if (!existingItemsRes.rows.some((old: any) => old.product_id === item.product_id)) {
        await client.query(`INSERT INTO replenishment_items (replenishment_id, product_id, qty_requested, quantity) VALUES ($1, $2, $3, 0)`, [id, item.product_id, item.qty_requested]);
      }
    }
    
    // 📝 LOG TRADUZIDO E MELHORADO
    await createLog(userId, 'EDITAR_REPOSICAO', { id_reposicao: id, edicoes: 'Dados atualizados' }, getClientIp(req), client);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
};

export const authorizeReplenishment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items, action, shipping_info, tracking_code } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      // Trava a LINHA do replenishment ANTES do guard -> o guard de status fica consistente sob
      // concorrência (2 authorize paralelos serializam neste FOR UPDATE). Padrão do updateStock.
      const repRes = await client.query('SELECT status FROM replenishments WHERE id = $1 FOR UPDATE', [id]);
      if (repRes.rows.length === 0) throw new Error('REP_NAO_ENCONTRADA');
      const status = repRes.rows[0].status;

      // GUARD DE STATUS (defesa em profundidade além do op_key idempotente): rejeita cedo e explícito.
      if (action === 'entregar' && status === 'concluido') throw new Error('REP_JA_CONCLUIDA');
      if ((action === 'reservar' || action === 'reverter') && status === 'cancelada') throw new Error('REP_CANCELADA');

      const warehouseId = await resolveWarehouseId(client, userId);

      for (const item of items) {
        const oldItem = await client.query('SELECT quantity, product_id, qty_requested FROM replenishment_items WHERE id = $1', [item.id]);
        if (oldItem.rows.length === 0) continue;

        const oldQty = parseFloat(oldItem.rows[0].quantity || 0);
        const newQty = item.quantity !== undefined ? parseFloat(item.quantity) : oldQty;
        if (isNaN(newQty) || newQty < 0) throw new Error('Quantidade inválida.');
        const productId = oldItem.rows[0].product_id;
        const diff = newQty - oldQty;

        // op_key CONTENT-ADDRESSED por replenishment + item + AÇÃO + qty (igual updateStock embute o valor):
        // re-run com a MESMA qty = no-op idempotente; mudar a qty = nova operação. A AÇÃO no key evita
        // que reserve e deliver do mesmo item colidam.
        if (action === 'reservar') {
          await client.query('UPDATE replenishment_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);
          // reserve/release pelo motor (valida DISPONÍVEL sob FOR UPDATE + grava no ledger).
          if (diff > 0) {
            await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, diff, {
              refType: 'replenishment', refId: id, userId,
              opKey: `replenishment:${id}:item:${item.id}:reserve:${newQty}`,
              reason: 'Reserva de reposição',
            });
          } else if (diff < 0) {
            await StockService.release(client, productId, warehouseId, POOLED_OP_ID, -diff, {
              refType: 'replenishment', refId: id, userId,
              opKey: `replenishment:${id}:item:${item.id}:reserve:${newQty}`,
              reason: 'Ajuste de reserva de reposição',
            });
          }
        } else if (action === 'entregar') {
          await client.query('UPDATE replenishment_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);
          // BAIXA FÍSICA pelo motor: consume faz on_hand -= newQty, libera min(newQty, reserved) e valida FURO.
          // op_key `deliver:${newQty}` -> re-entregar com a mesma qty é no-op idempotente (fim da dupla baixa).
          await StockService.consume(client, productId, warehouseId, POOLED_OP_ID, newQty, {
            refType: 'replenishment', refId: id, userId,
            opKey: `replenishment:${id}:item:${item.id}:deliver:${newQty}`,
            reason: 'Entrega de reposição',
          });
          // Decisão (b): entregou MENOS que reservou -> zera a reserva remanescente do item (não deixa sobra
          // pendurada). consume já liberou newQty; libera o resto (oldQty - newQty).
          if (oldQty > newQty) {
            await StockService.release(client, productId, warehouseId, POOLED_OP_ID, oldQty - newQty, {
              refType: 'replenishment', refId: id, userId,
              opKey: `replenishment:${id}:item:${item.id}:deliver:${newQty}:relrem`,
              reason: 'Liberação de reserva remanescente (entrega parcial)',
            });
          }
        } else if (action === 'reverter') {
          // Desfaz a entrega: devolve o físico (receive) e re-empenha (reserve). Ancorado em oldQty.
          await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, oldQty, {
            refType: 'replenishment', refId: id, userId,
            opKey: `replenishment:${id}:item:${item.id}:revert:${oldQty}`,
            reason: 'Reversão de entrega de reposição',
          });
          if (oldQty > 0) {
            await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, oldQty, {
              refType: 'replenishment', refId: id, userId,
              opKey: `replenishment:${id}:item:${item.id}:revert:${oldQty}:rereserve`,
              reason: 'Re-empenho na reversão de reposição',
            });
          }
        }
      }

      // STATUS + SHIPPING/RASTREIO — INALTERADO (schema e lifecycle preservados 1:1).
      let newStatus = 'em_preparo';
      let extraUpdate = '';
      let extraParams: any[] = [newStatus, id];
      if (action === 'entregar') {
        newStatus = 'concluido';
        extraParams[0] = newStatus;
        if (shipping_info) { extraParams.push(shipping_info); extraUpdate += `, shipping_info = $${extraParams.length}`; }
        if (tracking_code) { extraParams.push(tracking_code); extraUpdate += `, tracking_code = $${extraParams.length}`; }
      } else if (action === 'reverter') {
        newStatus = 'pendente';
        extraParams[0] = newStatus;
        extraUpdate = ', shipping_info = NULL, tracking_code = NULL';
      }
      await client.query(`UPDATE replenishments SET status = $1 ${extraUpdate} WHERE id = $2`, extraParams);

      await createLog(userId, 'AUTORIZAR_REPOSICAO', { id_reposicao: id, acao: action, codigo_rastreio: tracking_code || 'Não informado' }, getClientIp(req), client);
    });

    if ((req as any).io) { (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (error: any) {
    // Furo de estoque / reserva insuficiente do motor -> 400 tratado com mensagem clara.
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'REP_NAO_ENCONTRADA') return res.status(404).json({ error: 'Reposição não encontrada.' });
    if (error.message === 'REP_JA_CONCLUIDA') return res.status(400).json({ error: 'Reposição já concluída.' });
    if (error.message === 'REP_CANCELADA') return res.status(400).json({ error: 'Reposição cancelada — ação não permitida.' });
    // Rede de segurança de concorrência: 2 escritas paralelas com a MESMA op_key batem no índice único
    // (uq_stock_ledger_opkey). O withTransaction fez ROLLBACK -> nada duplicou; resposta idempotente.
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      const opKeyConflict = /\(op_key\)=\(([^)]*)\)/.exec(error?.detail ?? '')?.[1] ?? null;
      console.warn(JSON.stringify({ event: 'replenishment_idempotent_conflict', op_key: opKeyConflict }));
      return res.json({ success: true });
    }
    res.status(400).json({ error: error.message });
  }
};

export const deleteReplenishment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    await withTransaction(async (client) => {
      const repCheck = await client.query('SELECT status FROM replenishments WHERE id = $1 FOR UPDATE', [id]);
      if (repCheck.rows.length === 0) throw new Error('REP_NAO_ENCONTRADA');
      const status = repCheck.rows[0].status;
      // GUARD (preservado): não cancela concluída nem já cancelada -> evita dupla liberação de reserva.
      if (status === 'concluido' || status === 'cancelada') throw new Error('REP_NAO_CANCELAVEL');

      // Só há reserva a liberar se estava em_preparo (o 'reservar' é quem move p/ reserved).
      if (status === 'em_preparo') {
        const warehouseId = await resolveWarehouseId(client, userId);
        const itemsRes = await client.query('SELECT id, product_id, quantity FROM replenishment_items WHERE replenishment_id = $1', [id]);
        for (const item of itemsRes.rows) {
          const qty = parseFloat(item.quantity || 0);
          if (qty > 0) {
            // release pelo motor (nunca deixa reserva negativa + grava no ledger). op_key content-addressed
            // com a AÇÃO 'cancel' -> não colide com reserve/deliver/revert do authorize do mesmo item.
            await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, qty, {
              refType: 'replenishment', refId: id, userId,
              opKey: `replenishment:${id}:item:${item.id}:cancel:release:${qty}`,
              reason: 'Liberação de reserva ao cancelar reposição',
            });
          }
        }
      }

      await client.query("UPDATE replenishments SET status = 'cancelada' WHERE id = $1", [id]);
      await createLog(userId, 'CANCELAR_REPOSICAO', { id_reposicao: id }, getClientIp(req), client);
    });
    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'REP_NAO_ENCONTRADA') return res.status(404).json({ error: 'Reposição não encontrada.' });
    if (error.message === 'REP_NAO_CANCELAVEL') return res.status(400).json({ error: 'Não é possível inativar reposições concluídas ou já canceladas.' });
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      const opKeyConflict = /\(op_key\)=\(([^)]*)\)/.exec(error?.detail ?? '')?.[1] ?? null;
      console.warn(JSON.stringify({ event: 'replenishment_idempotent_conflict', op_key: opKeyConflict }));
      return res.json({ success: true });
    }
    res.status(500).json({ error: 'Erro ao cancelar reposição' });
  }
};
