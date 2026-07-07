import { Request, Response } from 'express';
import { pool } from '../db';

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
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query('UPDATE demands_3d SET status = $1 WHERE id = $2', [status, id]);

    if (status === 'Concluída') {
        const demandRes = await client.query('SELECT request_id, quantity, product_id FROM demands_3d WHERE id = $1', [id]);
        const demand = demandRes.rows[0];

        if (demand.product_id) {
            // 1. Entrada no estoque físico
            await client.query(
                `UPDATE stock 
                 SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $1,
                     quantity_reserved = COALESCE(quantity_reserved, 0) + $1
                 WHERE product_id = $2`,
                [demand.quantity, demand.product_id]
            );

            // 2. Regista no histórico de auditoria oficial do sistema
            await client.query(
                `INSERT INTO audit_logs (user_id, action, details) 
                 VALUES ($1, $2, $3)`,
                [(req as any).user.id, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: demand.product_id, quantity: demand.quantity, reason: 'Produção 3D Concluída' })]
            );
        }

        if (demand.request_id) {
            await client.query(`UPDATE requests SET status = 'aprovado' WHERE id = $1`, [demand.request_id]);
        }
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao mover demanda no Kanban' });
  } finally {
    client.release();
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
