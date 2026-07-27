// src/controllers/users.controller.ts

import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { roleExistsInRbac } from '../services/rbac';
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

  // Allowlist RBAC: só papéis que EXISTEM em role_permissions são atribuíveis aqui.
  if (!(await roleExistsInRbac(role))) {
    return res.status(400).json({ error: 'cargo inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query('SELECT role FROM profiles WHERE id = $1 FOR UPDATE', [id]);
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }

    // Guard do último admin: rebaixar o único 'admin' deixaria o sistema sem gestão.
    // FOR UPDATE em todas as linhas admin serializa rebaixamentos concorrentes.
    if (target.rows[0].role === 'admin' && role !== 'admin') {
      const admins = await client.query(`SELECT id FROM profiles WHERE role = 'admin' FOR UPDATE`);
      if (admins.rows.length <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Não é possível rebaixar o único administrador do sistema.' });
      }
    }

    // Atualizamos o perfil com Cargo e Setor
    if (sector) {
      await client.query('UPDATE profiles SET role = $1, sector = $2 WHERE id = $3', [role, sector, id]);

      // 🟢 CORREÇÃO APLICADA: Voltámos a usar a string 'UPDATE_ROLE' para não quebrar a validação (ENUM) da Base de Dados.
      // O novo setor continua a ser guardado, mas dentro do objeto JSON que a base de dados aceita bem!
      await createLog(userId, 'UPDATE_ROLE', { target_user_id: id, new_role: role, new_sector: sector }, getClientIp(req), client);
    } else {
      await client.query('UPDATE profiles SET role = $1 WHERE id = $2', [role, id]);
      await createLog(userId, 'UPDATE_ROLE', { target_user_id: id, new_role: role }, getClientIp(req), client);
    }

    await client.query('COMMIT');

    // O token do alvo ainda carrega o cargo velho — avisa o front pra forçar re-login
    // (mesmo evento/formato do saveUserPermissions, com as permissões do novo cargo).
    // Sala `user:${id}` é a do socket AUTENTICADO (config/socket.ts); a sala com id cru
    // fica junto por compatibilidade com o padrão legado dos outros emits.
    if ((req as any).io) {
      const permRes = await pool.query(`
        SELECT page_key FROM role_permissions WHERE role = $1
        UNION
        SELECT page_key FROM user_permissions WHERE user_id = $2
      `, [role, id]);
      const permissions = permRes.rows.map((r: { page_key: string }) => r.page_key);
      (req as any).io.to(`user:${id}`).to(id).emit('user_permissions_updated', { userId: id, permissions });
    }

    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    console.error("Erro ao atualizar função:", error);
    // 🟢 Melhoria de Debug: Agora devolvemos o erro detalhado da base de dados caso volte a falhar.
    res.status(500).json({ error: 'Erro ao atualizar função e setor', details: error.message });
  } finally {
    client.release();
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

  if (id === userId) {
    return res.status(400).json({ error: 'Não pode excluir a própria conta.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT u.email, p.role FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.id = $1 FOR UPDATE OF u`,
      [id]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }

    // Guard do último admin (mesma serialização por FOR UPDATE do updateRole).
    if (target.rows[0].role === 'admin') {
      const admins = await client.query(`SELECT id FROM profiles WHERE role = 'admin' FOR UPDATE`);
      if (admins.rows.length <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Não é possível excluir o único administrador do sistema.' });
      }
    }

    // Log antes do DELETE, na MESMA tx: se o hard-delete falhar, o log some no rollback.
    await createLog(userId, 'DELETE_USER', { target_user_id: id, target_email: target.rows[0].email }, getClientIp(req), client);
    await client.query('DELETE FROM users WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    // FK NO ACTION (audit_logs, requests, op_returns): usuário com histórico não sai por
    // hard-delete — o caminho honesto é suspender a conta (preserva a auditoria).
    if (error?.code === '23503') {
      return res.status(409).json({
        error: 'Usuário tem histórico vinculado (auditoria/pedidos) e não pode ser excluído. Use a suspensão da conta para bloquear o acesso.'
      });
    }
    console.error("Erro ao excluir usuário:", error);
    res.status(500).json({ error: 'Erro ao excluir usuário' });
  } finally {
    client.release();
  }
};

export const heartbeat = async (req: Request, res: Response) => {
  const { id } = req.params;
  const requester = (req as any).user;

  // Só o próprio usuário (ou admin) registra atividade. Check pelo JWT, sem ida ao
  // banco: heartbeat dispara a cada 5min pra todo logado e o dado é métrica, não acesso.
  if (id !== requester.id && requester.role?.toLowerCase().trim() !== 'admin') {
    return res.status(403).json({ error: 'Só é possível registrar a própria atividade.' });
  }

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
