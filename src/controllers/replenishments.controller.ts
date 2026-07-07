import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';

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
  
  // ADICIONADO: O backend agora "lê" o tracking_code que o Frontend envia
  const { items, action, shipping_info, tracking_code } = req.body; 
  
  const userId = (req as any).user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const oldItem = await client.query('SELECT quantity, product_id, qty_requested FROM replenishment_items WHERE id = $1', [item.id]);
      if (oldItem.rows.length > 0) {
        const oldQty = parseFloat(oldItem.rows[0].quantity || 0);
        const newQty = item.quantity !== undefined ? parseFloat(item.quantity) : oldQty;
        if (isNaN(newQty) || newQty < 0) throw new Error("Quantidade inválida.");

        const productId = oldItem.rows[0].product_id;
        const diff = newQty - oldQty;

        if (action === 'reservar') {
          await client.query('UPDATE replenishment_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);
          if (diff > 0) {
            const st = await client.query('SELECT (quantity_on_hand - quantity_reserved) as available FROM stock WHERE product_id = $1 FOR UPDATE', [productId]);
            if (parseFloat(st.rows[0]?.available || 0) < diff) throw new Error(`Estoque insuficiente para o produto ID ${productId}`);
          }
          if (diff !== 0) await client.query(`UPDATE stock SET quantity_reserved = quantity_reserved + $1 WHERE product_id = $2`, [diff, productId]);
        } else if (action === 'entregar') {
          // --- INÍCIO DA ATUALIZAÇÃO ---
          const stCheck = await client.query('SELECT quantity_on_hand, quantity_reserved FROM stock WHERE product_id = $1 FOR UPDATE', [productId]);
          
          if (parseFloat(stCheck.rows[0]?.quantity_on_hand || 0) < newQty) throw new Error(`Furo de Estoque! O saldo físico é menor que a quantidade a entregar no produto ID ${productId}.`);
          
          const diffDelivery = newQty - oldQty;
          if (diffDelivery > 0) {
              const available = parseFloat(stCheck.rows[0]?.quantity_on_hand || 0) - parseFloat(stCheck.rows[0]?.quantity_reserved || 0);
              if (available < diffDelivery) throw new Error(`Estoque disponível insuficiente para adicionar os itens extras na entrega do produto ID ${productId}.`);
          }

          await client.query('UPDATE replenishment_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);
          await client.query(`UPDATE stock SET quantity_on_hand = quantity_on_hand - $1, quantity_reserved = GREATEST(0, quantity_reserved - $2) WHERE product_id = $3`, [newQty, oldQty, productId]);
          // --- FIM DA ATUALIZAÇÃO ---
        } else if (action === 'reverter') {
          await client.query(`UPDATE stock SET quantity_on_hand = quantity_on_hand + $1, quantity_reserved = quantity_reserved + $1 WHERE product_id = $2`, [oldQty, productId]);
        }
      }
    }

    // LÓGICA DE STATUS, SHIPPING E RASTREIO ATUALIZADA
    let newStatus = 'em_preparo'; 
    let extraUpdate = ''; 
    let extraParams: any[] = [newStatus, id];
    
    if (action === 'entregar') { 
        newStatus = 'concluido'; 
        extraParams[0] = newStatus; 
        
        if (shipping_info) { 
            extraParams.push(shipping_info);
            extraUpdate += `, shipping_info = $${extraParams.length}`; 
        } 
        
        // ADICIONADO: Guardar o código de rastreio na Base de Dados
        if (tracking_code) { 
            extraParams.push(tracking_code);
            extraUpdate += `, tracking_code = $${extraParams.length}`; 
        }
    } 
    else if (action === 'reverter') { 
        newStatus = 'pendente'; 
        extraParams[0] = newStatus; 
        // ADICIONADO: Se reverter, apagar os dados de envio e rastreio
        extraUpdate = ', shipping_info = NULL, tracking_code = NULL'; 
    }

    await client.query(`UPDATE replenishments SET status = $1 ${extraUpdate} WHERE id = $2`, extraParams);
    
    // 📝 LOG TRADUZIDO E MELHORADO
    await createLog(userId, 'AUTORIZAR_REPOSICAO', { id_reposicao: id, acao: action, codigo_rastreio: tracking_code || 'Não informado' }, getClientIp(req), client);
    await client.query('COMMIT');
    if ((req as any).io) { (req as any).io.emit('stock_updated'); }
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
};

export const deleteReplenishment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repCheck = await client.query('SELECT status FROM replenishments WHERE id = $1 FOR UPDATE', [id]);
    if (repCheck.rows.length === 0) throw new Error('Reposição não encontrada.');
    if (repCheck.rows[0].status === 'concluido' || repCheck.rows[0].status === 'cancelada') throw new Error('Não é possível inativar reposições concluídas ou já canceladas.');

    if (repCheck.rows[0].status === 'em_preparo') {
       const itemsRes = await client.query('SELECT product_id, quantity FROM replenishment_items WHERE replenishment_id = $1', [id]);
       for (const item of itemsRes.rows) {
         if (item.quantity > 0) await client.query('UPDATE stock SET quantity_reserved = GREATEST(0, quantity_reserved - $1) WHERE product_id = $2', [item.quantity, item.product_id]);
       }
    }

    await client.query("UPDATE replenishments SET status = 'cancelada' WHERE id = $1", [id]);
    
    // 📝 LOG TRADUZIDO E MELHORADO
    await createLog(userId, 'CANCELAR_REPOSICAO', { id_reposicao: id }, getClientIp(req), client);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: 'Erro ao cancelar reposição' });
  } finally { client.release(); }
};
