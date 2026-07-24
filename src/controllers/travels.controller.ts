import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

export const getTravelOrders = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.*,
        (SELECT json_agg(json_build_object('id', ti.id, 'product_id', ti.product_id, 'quantity_out', ti.quantity_out, 'quantity_returned', ti.quantity_returned, 'status', ti.status, 'products', json_build_object('name', p.name, 'sku', p.sku, 'unit', p.unit))) FROM travel_order_items ti JOIN products p ON ti.product_id = p.id WHERE ti.travel_order_id = t.id) as items
      FROM travel_orders t ORDER BY t.status ASC, t.created_at DESC
    `);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Erro ao buscar viagens' }); }
};

export const createTravelOrder = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { technicians, city, items, status } = req.body;
  const client = await pool.connect();
  try {
    validatePositiveItems(items);
    await client.query('BEGIN');
    const initialStatus = status || 'pending';
    const toRes = await client.query(`INSERT INTO travel_orders (technicians, city, status, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [technicians, city, initialStatus, userId]);
    
    for (const item of items) {
      await client.query(`INSERT INTO travel_order_items (travel_order_id, product_id, quantity_out) VALUES ($1, $2, $3)`, [toRes.rows[0].id, item.product_id, item.quantity]);
      await client.query(`UPDATE stock SET quantity_reserved = COALESCE(quantity_reserved, 0) + $1 WHERE product_id = $2`, [item.quantity, item.product_id]);
    }
    
    // 📝 LOG TRADUZIDO E MELHORADO
    await createLog(userId, 'CRIAR_VIAGEM', { id_viagem: toRes.rows[0].id, tecnicos: technicians, cidade: city }, getClientIp(req), client);
    await client.query('COMMIT');
    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.status(201).json({ id: toRes.rows[0].id, success: true });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
};

export const reconcileTravelOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { returnedItems } = req.body;
  const userId = (req as any).user.id;
  try {
    await withTransaction(async (client) => {
      // GUARD (preservado 1:1): trava a LINHA da viagem ANTES de qualquer escrita -> 2 reconciles
      // paralelos serializam aqui; o sequencial vê 'reconciled' e lança. É proteção pessimista por
      // lock + flag (não por op_key), mas as op_keys abaixo são cinto-e-suspensório numa corrida.
      const toCheck = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
      if (toCheck.rows.length === 0) throw new Error('VIAGEM_NAO_ENCONTRADA');
      if (toCheck.rows[0].status === 'reconciled') throw new Error('VIAGEM_JA_RECONCILIADA');

      const warehouseId = await resolveWarehouseId(client, userId);
      const currentItemsRes = await client.query('SELECT id, product_id, quantity_out FROM travel_order_items WHERE travel_order_id = $1', [id]);
      const returnedMap = new Map((returnedItems as any[]).map((i: any) => [i.product_id, i]));

      for (const oldItem of currentItemsRes.rows) {
        const returnedData: any = returnedMap.get(oldItem.product_id);
        const returnedQty = returnedData ? Number(returnedData.returnedQuantity) : 0;
        if (returnedQty < 0) throw new Error('QTD_DEVOLVIDA_NEGATIVA');

        const qtyOut = Number(oldItem.quantity_out);
        const missing = qtyOut - returnedQty;
        const itemStatus = missing > 0 ? 'missing' : missing < 0 ? 'extra' : 'ok';

        await client.query('UPDATE travel_order_items SET quantity_returned = $1, status = $2 WHERE id = $3', [returnedQty, itemStatus, oldItem.id]);

        // Cálculos da viagem para este item.
        const consumed = Math.max(0, qtyOut - returnedQty);
        const returnedToStock = Math.min(qtyOut, returnedQty);
        const extra = Math.max(0, returnedQty - qtyOut);

        // 1) LIBERA A RESERVA INTEIRA que a viagem segurava. A viagem acabou p/ este item -> solta os
        //    qtyOut reservados no create, seja qual for o split. release nunca deixa reserva negativa.
        if (qtyOut > 0) {
          await StockService.release(client, oldItem.product_id, warehouseId, POOLED_OP_ID, qtyOut, {
            refType: 'travel', refId: id, userId,
            opKey: `travel:${id}:item:${oldItem.id}:reconcile:release:${qtyOut}`,
            reason: 'Fim da viagem: libera a reserva do item (confronto)',
          });
        }

        // 2) CONSUMIDO na obra = baixa SÓ física. reverseReceive (NÃO consume): a reserva já foi
        //    liberada no passo 1; consume mexeria em quantity_reserved do agregado pooled (reservas de
        //    OUTRAS separações) -> furo. Guard on_hand-consumed >= reserved segura (invariante do reserve).
        if (consumed > 0) {
          await StockService.reverseReceive(client, oldItem.product_id, warehouseId, POOLED_OP_ID, consumed, {
            refType: 'travel', refId: id, userId,
            opKey: `travel:${id}:item:${oldItem.id}:reconcile:consume:${consumed}`,
            reason: 'Confronto: material consumido na obra (baixa física)',
          });
          await createLog(userId, 'CONFRONTO_SAIDA', { id_viagem: id, id_produto: oldItem.product_id, quantidade: consumed, tipo_confronto: 'Consumido' }, getClientIp(req), client);
        }

        // 3) DEVOLVIDO ao estoque = SÓ log. O físico NUNCA saiu (create só reservou) e o release do
        //    passo 1 já devolveu a disponibilidade -> nada de estoque a movimentar aqui.
        if (returnedToStock > 0) {
          await createLog(userId, 'CONFRONTO_ENTRADA', { id_viagem: id, id_produto: oldItem.product_id, quantidade: returnedToStock, tipo_confronto: 'Devolvido' }, getClientIp(req), client);
        }

        // 4) EXTRA (voltou MAIS do que levou) = entrada física nova. receive pelo motor (cria linha LAZY).
        if (extra > 0) {
          await StockService.receive(client, oldItem.product_id, warehouseId, POOLED_OP_ID, extra, {
            refType: 'travel', refId: id, userId,
            opKey: `travel:${id}:item:${oldItem.id}:reconcile:extra:${extra}`,
            reason: 'Confronto: material extra (entrada física)',
          });
          await createLog(userId, 'CONFRONTO_ENTRADA_EXTRA', { id_viagem: id, id_produto: oldItem.product_id, quantidade: extra, tipo_confronto: 'Extra' }, getClientIp(req), client);
        }
      }

      // Materiais que NEM estavam na viagem e voltaram (Extra Puro): cria o item (RETURNING id p/
      // ancorar a op_key) e dá entrada física via receive.
      for (const retItem of (returnedItems as any[])) {
        const retQty = Number(retItem.returnedQuantity);
        if (!currentItemsRes.rows.some((old: any) => old.product_id === retItem.product_id) && retQty > 0) {
          const insRes = await client.query(
            `INSERT INTO travel_order_items (travel_order_id, product_id, quantity_out, quantity_returned, status) VALUES ($1, $2, 0, $3, 'extra') RETURNING id`,
            [id, retItem.product_id, retQty],
          );
          const newItemId = insRes.rows[0].id;
          await StockService.receive(client, retItem.product_id, warehouseId, POOLED_OP_ID, retQty, {
            refType: 'travel', refId: id, userId,
            opKey: `travel:${id}:item:${newItemId}:reconcile:extrapuro:${retQty}`,
            reason: 'Confronto: material extra puro (não estava na viagem)',
          });
          await createLog(userId, 'CONFRONTO_ENTRADA_EXTRA', { id_viagem: id, id_produto: retItem.product_id, quantidade: retQty, tipo_confronto: 'Extra Puro' }, getClientIp(req), client);
        }
      }

      await client.query("UPDATE travel_orders SET status = 'reconciled', updated_at = NOW() WHERE id = $1", [id]);
      await createLog(userId, 'FINALIZAR_CONFRONTO_VIAGEM', { id_viagem: id }, getClientIp(req), client);
    });

    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof StockError) return res.status(400).json({ error: err.message });
    if (err.message === 'VIAGEM_NAO_ENCONTRADA') return res.status(404).json({ error: 'Viagem não encontrada.' });
    if (err.message === 'VIAGEM_JA_RECONCILIADA') return res.status(400).json({ error: 'Esta viagem já passou por acerto.' });
    if (err.message === 'QTD_DEVOLVIDA_NEGATIVA') return res.status(400).json({ error: 'Quantidade devolvida não pode ser negativa.' });
    // Rede de segurança de concorrência: MESMA op_key em paralelo bate no índice único do razão ->
    // withTransaction fez ROLLBACK (nada duplicou) -> resposta idempotente. Espelha o 4479760/e7b4606.
    if (err?.code === '23505' && err?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'travel_reconcile_idempotent_conflict', op_key: /\(op_key\)=\(([^)]*)\)/.exec(err?.detail ?? '')?.[1] ?? null }));
      return res.json({ success: true });
    }
    console.error(JSON.stringify({ event: 'travel_reconcile_error', id, err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 300) }));
    res.status(500).json({ error: 'Erro ao realizar o confronto da viagem' });
  }
};

export const updateTravelOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { technicians, city, items, status } = req.body;
  const userId = (req as any).user.id;

  // Validação de payload ANTES da transação -> item inválido vira 400 (o cru respondia 500 aqui dentro).
  try {
    validatePositiveItems(items);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  try {
    await withTransaction(async (client) => {
      // GUARD (preservado): trava a linha + rejeita 'reconciled'. Converge ao alvo (relê oldItems fresco).
      const orderRes = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
      if (orderRes.rows.length === 0) throw new Error('VIAGEM_NAO_ENCONTRADA');
      if (orderRes.rows[0].status === 'reconciled') throw new Error('VIAGEM_JA_RECONCILIADA');

      await client.query('UPDATE travel_orders SET technicians = $1, city = $2, status = COALESCE($3, status) WHERE id = $4', [technicians, city, status, id]);

      const warehouseId = await resolveWarehouseId(client, userId);
      const oldItemsRes = await client.query('SELECT id, product_id, quantity_out FROM travel_order_items WHERE travel_order_id = $1', [id]);
      const newItemsMap = new Map((items as any[]).map((i: any) => [i.product_id, i]));

      for (const oldItem of oldItemsRes.rows) {
        if (!newItemsMap.has(oldItem.product_id)) {
          // Item REMOVIDO da viagem -> alvo 0 -> libera a reserva inteira e apaga o item.
          const qtyOut = Number(oldItem.quantity_out);
          if (qtyOut > 0) {
            await StockService.release(client, oldItem.product_id, warehouseId, POOLED_OP_ID, qtyOut, {
              refType: 'travel', refId: id, userId,
              opKey: `travel:${id}:item:${oldItem.id}:update:setqty:0`,
              reason: 'Edição de viagem: item removido (libera reserva)',
            });
          }
          await client.query('DELETE FROM travel_order_items WHERE id = $1', [oldItem.id]);
        } else {
          const newItem: any = newItemsMap.get(oldItem.product_id);
          const newQty = Number(newItem.quantity);
          const diff = newQty - Number(oldItem.quantity_out);
          if (diff !== 0) {
            // op_key CONTENT-ADDRESSED pelo ALVO (setqty:${newQty}), igual authorizeReplenishment.
            // TRADE-OFF ACEITO: 5->8->5->8 reusa a op_key setqty:8 -> a 2ª subida vira no-op. OK porque
            // é edição interativa sob FOR UPDATE (não é rota de retry).
            const opKey = `travel:${id}:item:${oldItem.id}:update:setqty:${newQty}`;
            if (diff > 0) {
              await StockService.reserve(client, oldItem.product_id, warehouseId, POOLED_OP_ID, diff, { refType: 'travel', refId: id, userId, opKey, reason: 'Edição de viagem: aumenta reserva do item' });
            } else {
              await StockService.release(client, oldItem.product_id, warehouseId, POOLED_OP_ID, -diff, { refType: 'travel', refId: id, userId, opKey, reason: 'Edição de viagem: reduz reserva do item' });
            }
            await client.query('UPDATE travel_order_items SET quantity_out = $1 WHERE id = $2', [newQty, oldItem.id]);
          }
        }
      }

      for (const item of (items as any[])) {
        if (!oldItemsRes.rows.some((old: any) => old.product_id === item.product_id)) {
          // Item NOVO -> RETURNING id p/ ancorar a op_key -> reserva.
          const qty = Number(item.quantity);
          const insRes = await client.query('INSERT INTO travel_order_items (travel_order_id, product_id, quantity_out) VALUES ($1, $2, $3) RETURNING id', [id, item.product_id, qty]);
          const newItemId = insRes.rows[0].id;
          if (qty > 0) {
            await StockService.reserve(client, item.product_id, warehouseId, POOLED_OP_ID, qty, {
              refType: 'travel', refId: id, userId,
              opKey: `travel:${id}:item:${newItemId}:update:setqty:${qty}`,
              reason: 'Edição de viagem: item novo (reserva)',
            });
          }
        }
      }

      await createLog(userId, 'EDITAR_VIAGEM', { id_viagem: id, edicoes: 'Técnicos, cidade ou itens alterados' }, getClientIp(req), client);
    });

    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof StockError) return res.status(400).json({ error: err.message });
    if (err.message === 'VIAGEM_NAO_ENCONTRADA') return res.status(404).json({ error: 'Viagem não encontrada.' });
    if (err.message === 'VIAGEM_JA_RECONCILIADA') return res.status(400).json({ error: 'Não é possível editar uma viagem já concluída.' });
    if (err?.code === '23505' && err?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'travel_update_idempotent_conflict', op_key: /\(op_key\)=\(([^)]*)\)/.exec(err?.detail ?? '')?.[1] ?? null }));
      return res.json({ success: true });
    }
    console.error(JSON.stringify({ event: 'travel_update_error', id, err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 300) }));
    res.status(500).json({ error: 'Erro ao editar a viagem' });
  }
};

export const deleteTravelOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      // FOR UPDATE: 2 deletes paralelos serializam; o 2º acha a viagem já apagada -> 404.
      const orderRes = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
      if (orderRes.rows.length === 0) throw new Error('VIAGEM_NAO_ENCONTRADA');
      const status = orderRes.rows[0].status;

      const warehouseId = await resolveWarehouseId(client, userId);
      const itemsRes = await client.query('SELECT id, product_id, quantity_out, quantity_returned FROM travel_order_items WHERE travel_order_id = $1', [id]);

      if (status === 'reconciled') {
        // Viagem CONCLUÍDA moveu FÍSICO no confronto -> desfaz a matemática exata (o inverso do reconcile).
        for (const item of itemsRes.rows) {
          const qtyOut = Number(item.quantity_out);
          const qtyRet = Number(item.quantity_returned) || 0;
          const consumed = Math.max(0, qtyOut - qtyRet);
          const extra = Math.max(0, qtyRet - qtyOut);

          // reconcile fez on_hand -= consumed -> devolve com receive.
          if (consumed > 0) {
            await StockService.receive(client, item.product_id, warehouseId, POOLED_OP_ID, consumed, {
              refType: 'travel', refId: id, userId,
              opKey: `travel:${id}:item:${item.id}:delete:revert-consume:${consumed}`,
              reason: 'Apagar viagem concluída: devolve o consumido ao físico',
            });
          }
          // reconcile fez on_hand += extra -> tira com reverseReceive (recusa se já foi consumido/reservado,
          // em vez do GREATEST(0,...) cru que pisava em 0 e escondia furo).
          if (extra > 0) {
            await StockService.reverseReceive(client, item.product_id, warehouseId, POOLED_OP_ID, extra, {
              refType: 'travel', refId: id, userId,
              opKey: `travel:${id}:item:${item.id}:delete:revert-extra:${extra}`,
              reason: 'Apagar viagem concluída: retira o extra do físico',
            });
          }
        }
      } else {
        // QUALQUER status NÃO-reconciliado (pending, awaiting_stock, e futuros): a reserva ainda está de pé.
        // DOUTRINA do deleteReplenishment (4479760): libera pelo que os ITENS realmente seguram (qty_out>0),
        // NÃO pelo rótulo do status. Antes o gate `if(pending)/else if(reconciled)` deixava 'awaiting_stock'
        // cair fora dos dois braços -> hard delete sem release -> RESERVA VAZADA. Este else tapa o buraco.
        for (const item of itemsRes.rows) {
          const qtyOut = Number(item.quantity_out);
          if (qtyOut > 0) {
            await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, qtyOut, {
              refType: 'travel', refId: id, userId,
              opKey: `travel:${id}:item:${item.id}:delete:release:${qtyOut}`,
              reason: 'Apagar viagem em aberto: libera a reserva do item',
            });
          }
        }
      }

      // Hard delete (preservado): apaga os itens e a viagem.
      await client.query('DELETE FROM travel_order_items WHERE travel_order_id = $1', [id]);
      await client.query('DELETE FROM travel_orders WHERE id = $1', [id]);
      await createLog(userId, 'APAGAR_VIAGEM', { id_viagem: id, status_anterior: status }, getClientIp(req), client);
    });

    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.json({ success: true, message: 'Confronto apagado e estoque restaurado com sucesso.' });
  } catch (err: any) {
    if (err instanceof StockError) return res.status(400).json({ error: err.message });
    if (err.message === 'VIAGEM_NAO_ENCONTRADA') return res.status(404).json({ error: 'Viagem não encontrada.' });
    if (err?.code === '23505' && err?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'travel_delete_idempotent_conflict', id, detail: err?.detail ?? null }));
      return res.json({ success: true, message: 'Confronto apagado e estoque restaurado com sucesso.' });
    }
    console.error(JSON.stringify({ event: 'travel_delete_error', id, err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 300) }));
    res.status(500).json({ error: 'Erro ao apagar a viagem' });
  }
};
