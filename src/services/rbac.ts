// src/services/rbac.ts — allowlist de papéis do RBAC.

import { Pool, PoolClient } from 'pg';
import { pool } from '../db';

/**
 * Um papel só é atribuível se EXISTE na matriz role_permissions (nasce na tela de
 * Permissões). A tela de Usuários atribui papéis existentes — não cria papel novo.
 * Bloqueia typo ('admim') e papel-fantasma sem nenhuma permissão associada.
 */
export async function roleExistsInRbac(role: unknown, db: Pool | PoolClient = pool): Promise<boolean> {
  if (typeof role !== 'string' || role.trim() === '') return false;
  const { rows } = await db.query('SELECT 1 FROM role_permissions WHERE role = $1 LIMIT 1', [role]);
  return rows.length > 0;
}
