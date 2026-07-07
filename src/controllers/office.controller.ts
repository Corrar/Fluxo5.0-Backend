import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

export const getOfficeExits = async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 'req_' || ri.id as id, 'Solicitação' as type, r.created_at as date, COALESCE(pf.name, 'Sistema') as requester, COALESCE(pf.sector, r.sector) as sector, p.name as product_name, p.sku as product_sku, p.unit as product_unit, p.tags as product_tags, ri.quantity_requested as quantity, ri.observation as observation, COALESCE(ri.epi_recorded, false) as epi_recorded
      FROM request_items ri JOIN requests r ON ri.request_id = r.id LEFT JOIN products p ON ri.product_id = p.id LEFT JOIN profiles pf ON r.requester_id = pf.id WHERE r.status IN ('aprovado', 'entregue')
      UNION ALL
      SELECT 'sep_' || si.id as id, 'Saída Manual' as type, s.created_at as date, 'Almoxarifado' as requester, s.destination as sector, p.name as product_name, p.sku as product_sku, p.unit as product_unit, p.tags as product_tags, si.quantity as quantity, si.observation as observation, COALESCE(si.epi_recorded, false) as epi_recorded
      FROM separation_items si JOIN separations s ON si.separation_id = s.id JOIN products p ON si.product_id = p.id WHERE s.status = 'concluida'
      ORDER BY date DESC LIMIT 1000;
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar saídas para o escritório' }); }
};

export const checkEpi = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { epi_recorded } = req.body;
  const userId = (req as any).user.id;
  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'escritorio') return res.status(403).json({ error: 'Acesso negado.' });

    const isRequest = id.startsWith('req_');
    const isSeparation = id.startsWith('sep_');
    const actualId = id.replace('req_', '').replace('sep_', '');

    if (isRequest) await pool.query('UPDATE request_items SET epi_recorded = $1 WHERE id = $2', [epi_recorded, actualId]);
    else if (isSeparation) await pool.query('UPDATE separation_items SET epi_recorded = $1 WHERE id = $2', [epi_recorded, actualId]);
    else return res.status(400).json({ error: 'Formato de ID inválido.' });

    await createLog(userId, 'TOGGLE_EPI_CHECK', { item_id: id, epi_recorded }, getClientIp(req));
    res.json({ success: true });
  } catch (error: any) { res.status(500).json({ error: 'Erro ao atualizar EPI check.' }); }
};

// Como extra, vou colocar aqui o endpoint de notificações push que nos esquecemos!
export const subscribeNotification = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Subscription inválida' });
  try {
    const subStr = JSON.stringify(subscription);
    await pool.query('DELETE FROM push_subscriptions WHERE subscription::text = $1', [subStr]);
    await pool.query(`INSERT INTO push_subscriptions (user_id, subscription) VALUES ($1, $2)`, [userId, subStr]);
    res.status(201).json({ success: true });
  } catch (error) { res.status(200).json({ success: true }); }
};
