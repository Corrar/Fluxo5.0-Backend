import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

export const getSeparations = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
        (SELECT json_agg(json_build_object('id', si.id, 'product_id', si.product_id, 'quantity', si.quantity, 'qty_requested', si.qty_requested, 'observation', si.observation, 'products', json_build_object('name', p.name, 'sku', p.sku, 'unit', p.unit, 'unit_price', p.unit_price, 'stock', json_build_object('quantity_on_hand', COALESCE(st.quantity_on_hand, 0), 'quantity_reserved', COALESCE(st.quantity_reserved, 0)))))
         FROM separation_items si JOIN products p ON si.product_id = p.id LEFT JOIN stock st ON p.id = st.product_id WHERE si.separation_id = s.id) as items,
        (SELECT json_agg(json_build_object('id', sr.id, 'product_id', sr.product_id, 'quantity', sr.quantity, 'status', sr.status, 'product_name', p.name)) FROM separation_returns sr JOIN products p ON sr.product_id = p.id WHERE sr.separation_id = s.id) as returns
      FROM separations s ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar separações' }); }
};

export const createSeparation = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  // 🟢 Recebe o client_service_id do frontend
  const { client_name, production_order, destination, items, client_service_id } = req.body;
  try {
    validatePositiveItems(items);

    await withTransaction(async (client) => {
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Sem permissão.');

      // Guardamos o client_service_id oficialmente. Criação NÃO reserva (idêntico ao 2.0):
      // a reserva nasce na ação 'reservar' de authorizeSeparation.
      const sepRes = await client.query(
        `INSERT INTO separations (destination, client_name, production_order, status, type, client_service_id) VALUES ($1, $2, $3, 'pendente', 'op', $4) RETURNING id`,
        [destination, client_name, production_order, client_service_id || null]
      );

      for (const item of items) {
        await client.query(`INSERT INTO separation_items (separation_id, product_id, qty_requested, quantity, observation) VALUES ($1, $2, $3, 0, $4)`, [sepRes.rows[0].id, item.product_id, item.quantity, item.observation || null]);
      }

      await createLog(userId, 'CRIAR_SEPARACAO', { id_separacao: sepRes.rows[0].id, cliente: client_name }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const authorizeSeparation = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items, action } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      for (const item of items) {
        const oldItem = await client.query('SELECT quantity, product_id FROM separation_items WHERE id = $1', [item.id]);
        if (oldItem.rows.length > 0) {
          const oldQty = parseFloat(oldItem.rows[0].quantity || 0);
          const newQty = parseFloat(item.quantity);
          if (isNaN(newQty) || newQty < 0) throw new Error("Quantidade inválida.");

          const productId = oldItem.rows[0].product_id;
          const diff = newQty - oldQty;
          await client.query('UPDATE separation_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);

          if (action === 'reservar') {
            // diff > 0 reserva; diff < 0 devolve reserva. reserve() já valida disponível (trava a linha).
            if (diff > 0) {
              await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, diff, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:reserve:${newQty}`,
                reason: 'Reserva de separação',
              });
            } else if (diff < 0) {
              await StockService.release(client, productId, warehouseId, POOLED_OP_ID, -diff, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:release:${newQty}`,
                reason: 'Ajuste (reduz reserva) de separação',
              });
            }
          } else if (action === 'entregar') {
            // Entrega: baixa físico de newQty (consume) e limpa a reserva que este item segurava (oldQty).
            if (newQty > 0) {
              await StockService.consume(client, productId, warehouseId, POOLED_OP_ID, newQty, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:consume`,
                reason: 'Entrega de separação',
              });
            }
            // Se entregou MENOS do que estava reservado para este item, libera o resíduo da reserva.
            const residual = oldQty - newQty;
            if (residual > 0) {
              await StockService.release(client, productId, warehouseId, POOLED_OP_ID, residual, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:releaseresidual`,
                reason: 'Libera resíduo de reserva na entrega parcial',
              });
            }
          }
        }
      }

      const newStatus = action === 'entregar' ? 'entregue' : 'em_separacao';
      await client.query(`UPDATE separations SET status = $1 ${action === 'entregar' ? ', sent_at = NOW()' : ''} WHERE id = $2`, [newStatus, id]);

      await createLog(userId, 'AUTORIZAR_SEPARACAO', { id_separacao: id, acao: action }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteSeparation = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      const sepRes = await client.query('SELECT status FROM separations WHERE id = $1 FOR UPDATE', [id]);
      if (sepRes.rows.length === 0) throw new Error("Pedido não encontrado");
      if (sepRes.rows[0].status === 'entregue' || sepRes.rows[0].status === 'cancelada') throw new Error("Não é possível inativar pedidos concluídos.");

      const itemsRes = await client.query('SELECT id, product_id, quantity FROM separation_items WHERE separation_id = $1', [id]);
      for (const item of itemsRes.rows) {
        const qty = parseFloat(item.quantity || 0);
        if (item.product_id && qty > 0) {
          await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, qty, {
            refType: 'separation', refId: id, userId,
            opKey: `separation:${id}:item:${item.id}:release:cancel`,
            reason: 'Cancelamento de separação',
          });
        }
      }

      await client.query("UPDATE separations SET status = 'cancelada' WHERE id = $1", [id]);
      await createLog(userId, 'CANCELAR_SEPARACAO', { id_separacao: id }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// 🛠️ Editar Pedido (updateSeparation)
export const updateSeparation = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { client_name, production_order, destination, items, client_service_id } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      await client.query(
        `UPDATE separations SET client_name = $1, production_order = $2, destination = $3, client_service_id = $4 WHERE id = $5`,
        [client_name, production_order, destination, client_service_id || null, id]
      );

      // Compara itens antigos com novos
      const existingItemsRes = await client.query('SELECT id, product_id, quantity FROM separation_items WHERE separation_id = $1', [id]);
      const existingItems = existingItemsRes.rows;
      const newProductIds = items.map((i: any) => i.product_id);

      // Remove itens apagados na edição e liberta o stock reservado (pelo motor)
      for (const old of existingItems) {
        if (!newProductIds.includes(old.product_id)) {
          const qty = parseFloat(old.quantity || 0);
          if (qty > 0 && old.product_id) {
            await StockService.release(client, old.product_id, warehouseId, POOLED_OP_ID, qty, {
              refType: 'separation', refId: id, userId,
              opKey: `separation:${id}:item:${old.id}:release:edit`,
              reason: 'Item removido na edição da separação',
            });
          }
          await client.query('DELETE FROM separation_items WHERE id = $1', [old.id]);
        }
      }

      // Adiciona novos itens ou atualiza a quantidade solicitada dos existentes
      for (const item of items) {
        const exists = existingItems.find((old) => old.product_id === item.product_id);
        if (exists) {
          await client.query('UPDATE separation_items SET qty_requested = $1 WHERE id = $2', [item.quantity, exists.id]);
        } else {
          await client.query(`INSERT INTO separation_items (separation_id, product_id, qty_requested, quantity) VALUES ($1, $2, $3, 0)`, [id, item.product_id, item.quantity]);
        }
      }

      await createLog(userId, 'EDITAR_SEPARACAO', { id_separacao: id, edicoes: 'Dados ou itens do pedido alterados' }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// ♻️ Criar um pedido de Devolução (sem mexer em estoque; só regista pendente)
export const createReturn = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO separation_returns (separation_id, product_id, quantity, status) VALUES ($1, $2, $3, 'pendente')`,
          [id, item.product_id, item.quantity]
        );
      }

      await createLog(userId, 'CRIAR_DEVOLUCAO', { id_separacao_origem: id }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// 🛡️ Aprovar ou Rejeitar a Devolução (Almoxarifado)
export const updateReturnStatus = async (req: Request, res: Response) => {
  const { returnId } = req.params;
  const { status } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      const retRes = await client.query('SELECT * FROM separation_returns WHERE id = $1 FOR UPDATE', [returnId]);
      if (retRes.rows.length === 0) throw new Error('Devolução não encontrada');
      const ret = retRes.rows[0];

      if (ret.status !== 'pendente') throw new Error('Esta devolução já foi processada.');

      await client.query('UPDATE separation_returns SET status = $1 WHERE id = $2', [status, returnId]);

      // Se aprovado, devolve a quantidade ao stock físico pelo motor (receive)
      if (status === 'aprovado' && ret.product_id && parseFloat(ret.quantity) > 0) {
        await StockService.receive(client, ret.product_id, warehouseId, POOLED_OP_ID, parseFloat(ret.quantity), {
          refType: 'separation_return', refId: returnId, userId,
          opKey: `separation_return:${returnId}:receive`,
          reason: 'Devolução de separação aprovada',
        });
      }

      await createLog(userId, 'PROCESSAR_DEVOLUCAO', { id_devolucao: returnId, novo_status: status }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
