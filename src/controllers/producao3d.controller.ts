import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

// ==========================================
// 1. CATÁLOGO DE PEÇAS 3D (Lê da tabela Products)
// ==========================================
export const get3DParts = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
        SELECT id, sku, name, image_url as image, production_minutes, filament_grams, description 
        FROM products 
        WHERE is_3d = true 
        ORDER BY name ASC
    `);
    
    const formatted = rows.map(r => ({
       id: r.id, 
       code: r.sku || 'S/N', 
       name: r.name, 
       image: r.image, 
       productionMinutes: r.production_minutes || 0, 
       filamentGrams: r.filament_grams || 0, 
       material: 'Padrão', 
       description: r.description
    }));
    
    res.json(formatted);
  } catch (error) {
    console.error("Erro detalhado no get3DParts:", error);
    res.status(500).json({ error: 'Erro ao buscar catálogo 3D' });
  }
};

export const update3DPartDetails = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { productionMinutes, filamentGrams, image, description } = req.body;
  try {
    await pool.query(
      `UPDATE products 
       SET production_minutes = $1, filament_grams = $2, image_url = $3, description = $4 
       WHERE id = $5`,
      [productionMinutes, filamentGrams, image, description, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar detalhes 3D da peça' });
  }
};

// ==========================================
// 2. DEMANDAS KANBAN (Conectado às Solicitações)
// ==========================================
export const getDemands = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
        SELECT d.id, d.product_id as "partId", d.request_id as "requestId", d.quantity, 
               d.op_number as "opNumber", d.priority, d.status, d.notes, d.created_at as "createdAt",
               p.name as requester
        FROM demands_3d d
        LEFT JOIN requests r ON d.request_id = r.id
        LEFT JOIN profiles p ON r.requester_id = p.id
        ORDER BY d.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar demandas 3D' });
  }
};

export const updateDemandStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      // GUARD DE RE-CONCLUSÃO: trava a LINHA da demanda ANTES de qualquer escrita -> consistente sob
      // concorrência (2 conclusões paralelas serializam aqui). Padrão do replenishments (4479760).
      const cur = await client.query('SELECT status, request_id, quantity, product_id FROM demands_3d WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) throw new Error('DEMANDA_NAO_ENCONTRADA');
      const atual = cur.rows[0].status;
      if (status === 'Concluída' && atual === 'Concluída') throw new Error('DEMANDA_JA_CONCLUIDA');
      if (status === 'Concluída' && atual === 'Cancelada') throw new Error('DEMANDA_CANCELADA');

      // UPDATE do status movido pra DEPOIS do guard (antes rodava antes do check).
      await client.query('UPDATE demands_3d SET status = $1 WHERE id = $2', [status, id]);

      if (status === 'Concluída') {
        const quantity = Number(cur.rows[0].quantity);
        const productId = cur.rows[0].product_id;
        const requestId = cur.rows[0].request_id;

        if (productId) {
          const warehouseId = await resolveWarehouseId(client, userId);
          // 1. Peça impressa ENTRA no físico. receive PRIMEIRO (aumenta disponível + cria a linha LAZY se faltar).
          //    op_key content-addressed: re-concluir com a mesma qty = no-op idempotente (fim da dupla entrada).
          await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, quantity, {
            refType: 'demand_3d', refId: id, userId,
            opKey: `demand:${id}:conclude:receive:${quantity}`,
            reason: 'Produção 3D concluída (entrada no estoque)',
          });
          // 2. SEGURA a peça produzida p/ a request 'aprovado' que a aguarda (decisão A). reserve DEPOIS
          //    (o receive já garantiu disponível). Sem isto, a peça viraria estoque livre -> furo na entrega.
          await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, quantity, {
            refType: 'demand_3d', refId: id, userId,
            opKey: `demand:${id}:conclude:reserve:${quantity}`,
            reason: 'Reserva da peça 3D produzida para a solicitação',
          });

          // Auditoria oficial (INALTERADA).
          await client.query(
            `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
            [userId, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: productId, quantity, reason: 'Produção 3D Concluída' })]
          );
        }

        // INALTERADO: marca a solicitação vinculada como aprovada.
        if (requestId) {
          await client.query(`UPDATE requests SET status = 'aprovado' WHERE id = $1`, [requestId]);
        }
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'DEMANDA_NAO_ENCONTRADA') return res.status(404).json({ error: 'Demanda não encontrada.' });
    if (error.message === 'DEMANDA_JA_CONCLUIDA') return res.status(400).json({ error: 'Demanda já concluída.' });
    if (error.message === 'DEMANDA_CANCELADA') return res.status(400).json({ error: 'Demanda cancelada.' });
    // Rede de segurança de concorrência: 2 conclusões paralelas com a MESMA op_key batem no índice único.
    // O withTransaction fez ROLLBACK -> nada duplicou; resposta idempotente (espelha o 4479760).
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      const opKeyConflict = /\(op_key\)=\(([^)]*)\)/.exec(error?.detail ?? '')?.[1] ?? null;
      console.warn(JSON.stringify({ event: 'demand3d_idempotent_conflict', op_key: opKeyConflict }));
      return res.json({ success: true });
    }
    res.status(500).json({ error: 'Erro ao mover demanda no Kanban' });
  }
};

// ==========================================
// 3. HISTÓRICO E REGISTO DE PRODUÇÃO (COM ESTOQUE AUTOMÁTICO)
// ==========================================

export const getProductions = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT p3d.id, p3d.product_id as "partId", p3d.demand_id as "demandId", p3d.quantity, 
             p3d.total_minutes as "totalMinutes", p3d.filament_grams as "filamentGrams", 
             p3d.date, pr.name as operator 
      FROM productions_3d p3d
      LEFT JOIN profiles pr ON p3d.operator_id = pr.id
      ORDER BY p3d.date ASC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar produções:', error);
    res.status(500).json({ error: 'Erro ao buscar produções' });
  }
};

export const createProduction = async (req: Request, res: Response) => {
  const { partId, demandId, quantity, totalMinutes, filamentGrams, date } = req.body;
  const operatorId = (req as any).user?.id || null; 
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN'); // Inicia a transação

    // 1. REGISTAR A PRODUÇÃO
    const prodRes = await client.query(`
        INSERT INTO productions_3d 
        (product_id, demand_id, quantity, operator_id, total_minutes, filament_grams, date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, product_id as "partId", demand_id as "demandId", quantity, 
                  total_minutes as "totalMinutes", filament_grams as "filamentGrams", 
                  date, operator_id as operator
    `, [partId, demandId || null, quantity, operatorId, totalMinutes, filamentGrams, date]);
    
    // 2. DAR ENTRADA NO ESTOQUE FÍSICO
    await client.query(`
        INSERT INTO stock (product_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, $2, 0)
        ON CONFLICT (product_id) 
        DO UPDATE SET quantity_on_hand = COALESCE(stock.quantity_on_hand, 0) + $2
    `, [partId, quantity]);

    // 3. REGISTAR O HISTÓRICO DE MOVIMENTAÇÃO (Tabela de Auditoria do seu Sistema)
    const reason = demandId ? 'Produção 3D (Demanda Kanban)' : 'Produção 3D (Estoque Livre)';
    await client.query(`
        INSERT INTO audit_logs (user_id, action, details) 
        VALUES ($1, $2, $3)
    `, [operatorId, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: partId, quantity, reason })]);

    await client.query('COMMIT'); // Guarda tudo!
    res.status(201).json(prodRes.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK'); // Em caso de erro, cancela tudo
    console.error('Erro ao criar produção e dar entrada no estoque:', error);
    res.status(500).json({ error: 'Erro ao registar produção 3D' });
  } finally {
    client.release();
  }
};

export const deleteProduction = async (req: Request, res: Response) => {
  const { id } = req.params;
  const operatorId = (req as any).user?.id || null; 
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Descobrir qual era a peça e a quantidade
    const prodRes = await client.query('SELECT product_id, quantity FROM productions_3d WHERE id = $1', [id]);
    if (prodRes.rows.length === 0) throw new Error("Produção não encontrada");
    const { product_id, quantity } = prodRes.rows[0];

    // 2. Apagar a produção
    await client.query('DELETE FROM productions_3d WHERE id = $1', [id]);

    // 3. Subtrair do estoque
    await client.query(`
        UPDATE stock 
        SET quantity_on_hand = GREATEST(COALESCE(quantity_on_hand, 0) - $2, 0)
        WHERE product_id = $1
    `, [product_id, quantity]);

    // 4. Registar no histórico (Auditoria)
    await client.query(`
        INSERT INTO audit_logs (user_id, action, details) 
        VALUES ($1, $2, $3)
    `, [operatorId, 'SAIDA_ESTOQUE_3D', JSON.stringify({ product_id, quantity, reason: 'Correção: Apagou registo de Produção 3D' })]);

    await client.query('COMMIT');
    res.json({ success: true });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao apagar produção e reverter estoque:', error);
    res.status(500).json({ error: 'Erro ao apagar produção 3D' });
  } finally {
    client.release();
  }
};
