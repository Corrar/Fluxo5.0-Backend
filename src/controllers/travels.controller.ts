import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const toCheck = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
    if (toCheck.rows.length === 0) throw new Error('Viagem não encontrada.');
    if (toCheck.rows[0].status === 'reconciled') throw new Error('Esta viagem já passou por acerto.');

    const currentItemsRes = await client.query('SELECT id, product_id, quantity_out FROM travel_order_items WHERE travel_order_id = $1', [id]);
    const returnedMap = new Map(returnedItems.map((i: any) => [i.product_id, i]));

    for (const oldItem of currentItemsRes.rows) {
      const returnedData: any = returnedMap.get(oldItem.product_id);
      const returnedQty = returnedData ? Number(returnedData.returnedQuantity) : 0;
      if (returnedQty < 0) throw new Error("Quantidade devolvida não pode ser negativa.");

      const qtyOut = Number(oldItem.quantity_out);
      const missing = qtyOut - returnedQty; 
      let itemStatus = missing > 0 ? 'missing' : missing < 0 ? 'extra' : 'ok';

      await client.query(`UPDATE travel_order_items SET quantity_returned = $1, status = $2 WHERE id = $3`, [returnedQty, itemStatus, oldItem.id]);
      
      // Remove da reserva a totalidade que ele tinha levado, afinal a viagem acabou para esse item
      await client.query(`UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2`, [qtyOut, oldItem.product_id]);

      // --- ATUALIZAÇÃO FÍSICA DO ESTOQUE E GERAÇÃO DE LOGS PARA RELATÓRIOS ---
      
      // Cálculos da viagem para este item
      const consumed = Math.max(0, qtyOut - returnedQty); 
      const returnedToStock = Math.min(qtyOut, returnedQty); 
      const extra = Math.max(0, returnedQty - qtyOut);

      // 1. MATERIAL CONSUMIDO NA OBRA (Baixa no Físico e Gera Log de Saída)
      if (consumed > 0) {
          await client.query(`UPDATE stock SET quantity_on_hand = GREATEST(0, COALESCE(quantity_on_hand, 0) - $1) WHERE product_id = $2`, [consumed, oldItem.product_id]);
          
          // 📝 LOG TRADUZIDO
          await createLog(userId, 'CONFRONTO_SAIDA', { 
              id_viagem: id, 
              id_produto: oldItem.product_id, 
              quantidade: consumed,
              tipo_confronto: 'Consumido'
          }, getClientIp(req), client);
      }

      // 2. MATERIAL DEVOLVIDO AO ESTOQUE (Gera Log de Entrada apenas - o físico já lá estava porque era apenas reserva)
      if (returnedToStock > 0) {
          // 📝 LOG TRADUZIDO
          await createLog(userId, 'CONFRONTO_ENTRADA', { 
              id_viagem: id, 
              id_produto: oldItem.product_id, 
              quantidade: returnedToStock,
              tipo_confronto: 'Devolvido'
          }, getClientIp(req), client);
      }

      // 3. MATERIAL EXTRA (Gera Log de Entrada E aumenta o Físico, pois veio a mais)
      if (extra > 0) {
          await client.query(`UPDATE stock SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $1 WHERE product_id = $2`, [extra, oldItem.product_id]);
          
          // 📝 LOG TRADUZIDO
          await createLog(userId, 'CONFRONTO_ENTRADA_EXTRA', { 
              id_viagem: id, 
              id_produto: oldItem.product_id, 
              quantidade: extra,
              tipo_confronto: 'Extra'
          }, getClientIp(req), client);
      }
    }

    // Agora lida com materiais que nem sequer estavam na viagem e foram devolvidos! (Extra Puro)
    for (const retItem of returnedItems) {
        if (!currentItemsRes.rows.some(old => old.product_id === retItem.product_id) && retItem.returnedQuantity > 0) {
            await client.query(`INSERT INTO travel_order_items (travel_order_id, product_id, quantity_out, quantity_returned, status) VALUES ($1, $2, 0, $3, 'extra')`, [id, retItem.product_id, retItem.returnedQuantity]);
            await client.query(`UPDATE stock SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $1 WHERE product_id = $2`, [retItem.returnedQuantity, retItem.product_id]);
            
            // 📝 LOG TRADUZIDO
            await createLog(userId, 'CONFRONTO_ENTRADA_EXTRA', { 
                id_viagem: id, 
                id_produto: retItem.product_id, 
                quantidade: retItem.returnedQuantity,
                tipo_confronto: 'Extra Puro'
            }, getClientIp(req), client);
        }
    }

    await client.query(`UPDATE travel_orders SET status = 'reconciled', updated_at = NOW() WHERE id = $1`, [id]);
    
    // 📝 LOG TRADUZIDO
    await createLog(userId, 'FINALIZAR_CONFRONTO_VIAGEM', { id_viagem: id }, getClientIp(req), client);
    
    await client.query('COMMIT');
    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
};

export const updateTravelOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { technicians, city, items, status } = req.body;
  const userId = (req as any).user.id;
  const client = await pool.connect();
  try {
    validatePositiveItems(items);
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
    if (orderRes.rows.length === 0) throw new Error('Viagem não encontrada.');
    if (orderRes.rows[0].status === 'reconciled') throw new Error('Não é possível editar uma viagem já concluída.');

    await client.query('UPDATE travel_orders SET technicians = $1, city = $2, status = COALESCE($3, status) WHERE id = $4', [technicians, city, status, id]);

    const oldItemsRes = await client.query('SELECT id, product_id, quantity_out FROM travel_order_items WHERE travel_order_id = $1', [id]);
    const newItemsMap = new Map(items.map((i: any) => [i.product_id, i]));

    for (const oldItem of oldItemsRes.rows) {
      if (!newItemsMap.has(oldItem.product_id)) {
        await client.query('UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2', [oldItem.quantity_out, oldItem.product_id]);
        await client.query('DELETE FROM travel_order_items WHERE id = $1', [oldItem.id]);
      } else {
        const newItem: any = newItemsMap.get(oldItem.product_id);
        const diff = Number(newItem.quantity) - Number(oldItem.quantity_out);
        if (diff !== 0) {
           await client.query('UPDATE stock SET quantity_reserved = COALESCE(quantity_reserved, 0) + $1 WHERE product_id = $2', [diff, oldItem.product_id]);
           await client.query('UPDATE travel_order_items SET quantity_out = $1 WHERE id = $2', [newItem.quantity, oldItem.id]);
        }
      }
    }

    for (const item of items) {
      if (!oldItemsRes.rows.some(old => old.product_id === item.product_id)) {
        await client.query('INSERT INTO travel_order_items (travel_order_id, product_id, quantity_out) VALUES ($1, $2, $3)', [id, item.product_id, item.quantity]);
        await client.query('UPDATE stock SET quantity_reserved = COALESCE(quantity_reserved, 0) + $1 WHERE product_id = $2', [item.quantity, item.product_id]);
      }
    }

    // 📝 LOG TRADUZIDO
    await createLog(userId, 'EDITAR_VIAGEM', { id_viagem: id, edicoes: 'Técnicos, cidade ou itens alterados' }, getClientIp(req), client);
    await client.query('COMMIT');
    if ((req as any).io) { (req as any).io.emit('travel_orders_update'); (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
};

export const deleteTravelOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Fazemos o bloqueio da linha (FOR UPDATE) para evitar conflitos de concorrência
    const orderRes = await client.query('SELECT status FROM travel_orders WHERE id = $1 FOR UPDATE', [id]);
    
    if (orderRes.rows.length === 0) throw new Error('Viagem não encontrada.');
    const status = orderRes.rows[0].status;

    // Buscamos todos os itens atrelados a esta viagem
    const itemsRes = await client.query('SELECT product_id, quantity_out, quantity_returned FROM travel_order_items WHERE travel_order_id = $1', [id]);

    if (status === 'pending') {
      // 1. Viagem estava aberta. Apenas limpamos o que estava reservado para ela.
      for (const item of itemsRes.rows) {
        await client.query(`UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2`, [item.quantity_out, item.product_id]);
      }
    } else if (status === 'reconciled') {
      // 2. Viagem estava concluída. Precisamos desfazer a matemática exata do confronto físico!
      for (const item of itemsRes.rows) {
        const qtyOut = Number(item.quantity_out);
        const qtyRet = Number(item.quantity_returned) || 0;
        
        const consumed = Math.max(0, qtyOut - qtyRet);
        const extra = Math.max(0, qtyRet - qtyOut);

        // O material que o sistema achou que foi "consumido" volta a ficar disponível fisicamente
        if (consumed > 0) {
          await client.query(`UPDATE stock SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $1 WHERE product_id = $2`, [consumed, item.product_id]);
        }
        
        // O material que veio "extra" é retirado do físico, pois ele vai sumir do sistema
        if (extra > 0) {
          await client.query(`UPDATE stock SET quantity_on_hand = GREATEST(0, COALESCE(quantity_on_hand, 0) - $1) WHERE product_id = $2`, [extra, item.product_id]);
        }
      }
    }

    // 3. Independentemente do status, nós apagamos os itens e a viagem (Hard Delete)
    await client.query('DELETE FROM travel_order_items WHERE travel_order_id = $1', [id]);
    await client.query('DELETE FROM travel_orders WHERE id = $1', [id]);
    
    // 📝 LOG DA EXCLUSÃO
    await createLog(userId, 'APAGAR_VIAGEM', { id_viagem: id, status_anterior: status }, getClientIp(req), client);
    
    await client.query('COMMIT');
    
    // Atualiza o painel do frontend em tempo real
    if ((req as any).io) { 
        (req as any).io.emit('travel_orders_update'); 
        (req as any).io.emit('stock_updated'); 
    }
    
    res.json({ success: true, message: "Confronto apagado e estoque restaurado com sucesso." });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: err.message });
  } finally { 
    client.release(); 
  }
};
