// src/controllers/users.controller.ts

import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import bcrypt from 'bcryptjs';

export const getUsers = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.is_active, COALESCE(p.name, u.email) as name, 
             COALESCE(p.role, 'setor') as role, COALESCE(p.sector, '-') as sector, 
             u.created_at, u.total_minutes, u.last_active
      FROM users u LEFT JOIN profiles p ON u.id = p.id ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (error: any) { 
    res.status(500).json({ error: 'Erro ao buscar usuários' }); 
  }
};

export const updateRole = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, sector } = req.body; 
  const userId = (req as any).user.id;
  
  try {
    // Atualizamos o perfil com Cargo e Setor
    if (sector) {
      await pool.query('UPDATE profiles SET role = $1, sector = $2 WHERE id = $3', [role, sector, id]);
      
      // 🟢 CORREÇÃO APLICADA: Voltámos a usar a string 'UPDATE_ROLE' para não quebrar a validação (ENUM) da Base de Dados.
      // O novo setor continua a ser guardado, mas dentro do objeto JSON que a base de dados aceita bem!
      await createLog(userId, 'UPDATE_ROLE', { target_user_id: id, new_role: role, new_sector: sector }, getClientIp(req));
    } else {
      await pool.query('UPDATE profiles SET role = $1 WHERE id = $2', [role, id]);
      await createLog(userId, 'UPDATE_ROLE', { target_user_id: id, new_role: role }, getClientIp(req));
    }
    
    res.json({ success: true });
  } catch (error: any) { 
    console.error("Erro ao atualizar função:", error);
    // 🟢 Melhoria de Debug: Agora devolvemos o erro detalhado da base de dados caso volte a falhar.
    res.status(500).json({ error: 'Erro ao atualizar função e setor', details: error.message }); 
  }
};

export const updateStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_active } = req.body;
  const requesterId = (req as any).user.id;
  const client = await pool.connect();
  try {
    const adminCheck = await client.query("SELECT role FROM profiles WHERE id = $1", [requesterId]);
    if (adminCheck.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem alterar o estado da conta.' });
    if (id === requesterId) return res.status(400).json({ error: 'Não pode suspender a própria conta.' });

    await client.query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active, id]);
    const actionName = is_active ? 'REACTIVATE_USER' : 'SUSPEND_USER';
    await createLog(requesterId, actionName, { target_user_id: id }, getClientIp(req), client);
    
    if ((req as any).io) { (req as any).io.emit('user_status_changed', { userId: id, is_active }); }
    res.json({ success: true, is_active });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao alterar estado do utilizador' });
  } finally { 
    client.release(); 
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    await createLog(userId, 'DELETE_USER', { target_user_id: id }, getClientIp(req));
    res.json({ success: true });
  } catch (error: any) { 
    res.status(500).json({ error: 'Erro ao excluir usuário' }); 
  }
};

export const heartbeat = async (req: Request, res: Response) => {
  const { id } = req.params;
  try { 
    await pool.query(`UPDATE users SET total_minutes = COALESCE(total_minutes, 0) + 1, last_active = NOW() WHERE id = $1`, [id]);
    res.json({ success: true }); 
  } catch (error) { 
    res.json({ success: false }); 
  }
};

// --- FUNÇÃO: REDEFINIR SENHA ---
export const resetPassword = async (req: Request, res: Response) => {
  const { id } = req.params; 
  const { newPassword } = req.body;
  const requesterId = (req as any).user.id; 
  
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  }

  const client = await pool.connect();
  try {
    const adminCheck = await client.query("SELECT role FROM profiles WHERE id = $1", [requesterId]);
    if (adminCheck.rows[0]?.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem redefinir senhas.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await client.query('UPDATE users SET encrypted_password = $1 WHERE id = $2', [hashedPassword, id]);

    await createLog(requesterId, 'REDEFINIR_SENHA', { target_user_id: id }, getClientIp(req), client);

    res.json({ success: true, message: 'Senha redefinida com sucesso!' });
  } catch (error: any) {
    console.error("Erro ao redefinir senha:", error);
    res.status(500).json({ error: 'Erro interno ao redefinir senha.' });
  } finally { 
    client.release(); 
  }
};
