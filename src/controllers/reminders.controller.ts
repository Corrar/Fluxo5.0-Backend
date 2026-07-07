import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

export const getReminders = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`SELECT r.*, COALESCE(p.name, 'Sistema') as user_name FROM reminders r LEFT JOIN profiles p ON r.user_id = p.id ORDER BY r.created_at DESC`);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar lembretes' }); }
};

export const createReminder = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { text, type, category } = req.body;
  try {
    const { rows } = await pool.query(`INSERT INTO reminders (user_id, text, type, category, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING *`, [userId, text, type || 'note', category || 'general']);
    await createLog(userId, 'CREATE_REMINDER', { reminder_id: rows[0].id, text }, getClientIp(req));
    if ((req as any).io) { (req as any).io.emit('reminders_updated'); }
    res.status(201).json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao criar lembrete' }); }
};

export const updateReminder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const { text, type, category, status } = req.body;
  try {
    const { rows } = await pool.query(`UPDATE reminders SET text = COALESCE($1, text), type = COALESCE($2, type), category = COALESCE($3, category), status = COALESCE($4, status), updated_at = NOW() WHERE id = $5 RETURNING *`, [text, type, category, status, id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lembrete não encontrado' });
    const actionName = status !== undefined && text === undefined ? 'MOVE_REMINDER' : 'UPDATE_REMINDER';
    await createLog(userId, actionName, { reminder_id: id, changes: req.body }, getClientIp(req));
    if ((req as any).io) { (req as any).io.emit('reminders_updated'); }
    res.json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao atualizar lembrete' }); }
};

export const deleteReminder = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    await pool.query('DELETE FROM reminders WHERE id = $1', [id]);
    await createLog(userId, 'DELETE_REMINDER', { reminder_id: id }, getClientIp(req));
    if ((req as any).io) { (req as any).io.emit('reminders_updated'); }
    res.json({ success: true });
  } catch (error: any) { res.status(500).json({ error: 'Erro ao excluir lembrete' }); }
};
