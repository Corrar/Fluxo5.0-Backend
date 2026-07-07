import { Request, Response } from 'express';
// Ajuste os caminhos abaixo conforme a sua estrutura de pastas atual
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

// ==========================================
// 1. PERMISSÕES DE CARGOS (ROLES)
// ==========================================

// Retorna as permissões agrupadas por cargo
export const getRolePermissions = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT role, page_key FROM role_permissions');
    const permissionsMap: Record<string, string[]> = {};
    
    // Organiza os dados no formato { admin: ['dashboard', 'produtos'], almoxarife: ['estoque'] }
    rows.forEach((row: any) => {
      if (!permissionsMap[row.role]) {
        permissionsMap[row.role] = [];
      }
      permissionsMap[row.role].push(row.page_key);
    });
    
    res.json(permissionsMap);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar permissões de cargos' });
  }
};

// Salva as permissões de um cargo específico
export const saveRolePermissions = async (req: Request, res: Response) => {
  const { role, permissions } = req.body;
  const requesterId = (req as any).user.id;
  
  // 🛡️ Proteção: Apenas Admins podem alterar permissões
  const adminCheck = await pool.query("SELECT role FROM profiles WHERE id = $1", [requesterId]);
  if (adminCheck.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem alterar acessos.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Limpa as permissões antigas do cargo
    await client.query('DELETE FROM role_permissions WHERE role = $1', [role]);
    
    // Insere as novas permissões enviadas pelo Front-end
    if (permissions && permissions.length > 0) {
      for (const page of permissions) {
        await client.query('INSERT INTO role_permissions (role, page_key) VALUES ($1, $2)', [role, page]);
      }
    }
    
    // 📝 Log de Auditoria
    await createLog(requesterId, 'UPDATE_ROLE_PERMISSIONS', { role_target: role, count: permissions?.length || 0 }, getClientIp(req), client);
    
    await client.query('COMMIT');
    
    // ⚡ Atualiza o Frontend em tempo real para quem tiver esse cargo
    if ((req as any).io) {
        (req as any).io.to(role).emit('role_permissions_updated', { role, permissions });
    }

    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: 'Erro ao salvar permissões de cargo' });
  } finally {
    client.release();
  }
};

// ==========================================
// 2. PERMISSÕES DE USUÁRIOS (EXCEÇÕES)
// ==========================================

// Retorna as permissões extras agrupadas por usuário (ID)
export const getUserPermissions = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT user_id, page_key FROM user_permissions');
    const permissionsMap: Record<string, string[]> = {};
    
    // Organiza os dados no formato { "id-do-usuario": ['precos:editar'] }
    rows.forEach((row: any) => {
      if (!permissionsMap[row.user_id]) {
        permissionsMap[row.user_id] = [];
      }
      permissionsMap[row.user_id].push(row.page_key);
    });
    
    res.json(permissionsMap);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar permissões de usuários' });
  }
};

// Salva as permissões extras de um usuário específico
export const saveUserPermissions = async (req: Request, res: Response) => {
  const { userId, permissions } = req.body;
  const requesterId = (req as any).user.id;
  
  // 🛡️ Proteção: Apenas Admins podem alterar permissões
  const adminCheck = await pool.query("SELECT role FROM profiles WHERE id = $1", [requesterId]);
  if (adminCheck.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem alterar acessos.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Limpa as permissões antigas específicas desse usuário
    await client.query('DELETE FROM user_permissions WHERE user_id = $1', [userId]);
    
    // Insere as novas permissões
    if (permissions && permissions.length > 0) {
      for (const page of permissions) {
        await client.query('INSERT INTO user_permissions (user_id, page_key) VALUES ($1, $2)', [userId, page]);
      }
    }
    
    // 📝 Log de Auditoria
    await createLog(requesterId, 'UPDATE_USER_PERMISSIONS', { user_target: userId, count: permissions?.length || 0 }, getClientIp(req), client);
    
    await client.query('COMMIT');
    
    // ⚡ Atualiza o Frontend em tempo real para este usuário específico
    if ((req as any).io) {
        (req as any).io.to(userId).emit('user_permissions_updated', { userId, permissions });
    }

    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: 'Erro ao salvar permissões de usuário' });
  } finally {
    client.release();
  }
};
