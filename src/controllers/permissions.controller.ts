import { Request, Response } from 'express';
// Ajuste os caminhos abaixo conforme a sua estrutura de pastas atual
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

// ── Borda da matriz RBAC (v1) ───────────────────────────────────────────────
// Papel SEM maiúscula, obrigatório: roleExistsInRbac (allowlist do UPDATE_ROLE) compara
// EXATO e requirePermission compara LOWER(role) — um papel 'OBRAS' nasceria atribuível
// mas nunca casaria no gate. A borda mata esse risco antes de ele existir no banco.
const ROLE_RE = /^[a-z0-9_-]+$/;
// ':' cobre a convenção namespaced (clientes:view). A convenção mista flat×namespaced
// NÃO se normaliza na v1 — dívida registrada; aqui só se garante o alfabeto.
const PAGE_KEY_RE = /^[a-z0-9_:-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valida e normaliza o payload de permissões dos dois POSTs:
// - TEM que ser array (uma string "abc" passaria no for...of e viraria chaves 'a','b','c');
// - cada item: string não-vazia, trim, no alfabeto de page_key — inválido aponta QUAL;
// - deduplica preservando ordem (payload com chave repetida estouraria a PK composta em 500).
function parsePermissions(raw: unknown): { ok: true; keys: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Payload inválido: 'permissions' deve ser um array de chaves." };
  }
  const keys: string[] = [];
  for (const item of raw) {
    const k = typeof item === 'string' ? item.trim() : '';
    if (k === '' || !PAGE_KEY_RE.test(k)) {
      return { ok: false, error: `Chave de permissão inválida: ${JSON.stringify(item)}. Use minúsculas, dígitos, '_', '-' e ':' (ex.: clientes:view).` };
    }
    if (!keys.includes(k)) keys.push(k);
  }
  return { ok: true, keys };
}

// Diff ordenado (log determinístico) entre o conjunto anterior e o novo.
function diffKeys(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  return {
    added: next.filter((k) => !prev.includes(k)).sort(),
    removed: prev.filter((k) => !next.includes(k)).sort(),
  };
}

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

  // ── Validação na borda (400, nunca 500) ──
  const cleanRole = typeof role === 'string' ? role.trim() : '';
  if (cleanRole === '' || !ROLE_RE.test(cleanRole)) {
    return res.status(400).json({ error: "Papel inválido: use apenas minúsculas, dígitos, '_' e '-' (ex.: usinagem_lider)." });
  }
  const parsed = parsePermissions(permissions);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  // GUARD ANTI-VAZIO: com replace-all, conjunto vazio APAGA o papel da matriz — ele some da
  // allowlist do UPDATE_ROLE (SELECT DISTINCT role) e os usuários dele ficam presos com acesso
  // zero, sem nem poder receber o papel de volta. Remoção de papel NÃO existe na v1.
  // (Só aqui: no espelho por usuário, exceção vazia é legítima = "sem exceções".)
  if (parsed.keys.length === 0) {
    return res.status(400).json({ error: 'Conjunto vazio não é permitido: removeria o papel da allowlist e deixaria os usuários dele sem nenhum acesso. Remoção de papel não existe na v1.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Conjunto ANTERIOR antes do DELETE — é ele que vira o diff added/removed do log.
    const prevRes = await client.query('SELECT page_key FROM role_permissions WHERE role = $1', [cleanRole]);
    const prev: string[] = prevRes.rows.map((r: { page_key: string }) => r.page_key);

    // Limpa as permissões antigas do cargo
    await client.query('DELETE FROM role_permissions WHERE role = $1', [cleanRole]);

    // Insere as novas permissões enviadas pelo Front-end (já validadas e deduplicadas)
    for (const page of parsed.keys) {
      await client.query('INSERT INTO role_permissions (role, page_key) VALUES ($1, $2)', [cleanRole, page]);
    }

    // 📝 Log de Auditoria — com DIFF: o livro responde "o que mudou", não só "quantas ficaram".
    const { added, removed } = diffKeys(prev, parsed.keys);
    await createLog(requesterId, 'UPDATE_ROLE_PERMISSIONS', { role_target: cleanRole, added, removed, count: parsed.keys.length }, getClientIp(req), client);

    await client.query('COMMIT');

    // ⚡ Atualiza o Frontend em tempo real para quem tiver esse cargo
    if ((req as any).io) {
        (req as any).io.to(cleanRole).emit('role_permissions_updated', { role: cleanRole, permissions: parsed.keys });
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

  // ── Validação na borda (400/404, nunca 500) ──
  // userId fora do formato ou inexistente estouraria a FK no INSERT (500 crípto); a borda
  // devolve o status certo antes de abrir transação.
  const cleanUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!UUID_RE.test(cleanUserId)) {
    return res.status(400).json({ error: "Payload inválido: 'userId' deve ser um UUID." });
  }
  const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [cleanUserId]);
  if (userCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Utilizador não encontrado.' });
  }
  const parsed = parsePermissions(permissions);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  // SEM guard anti-vazio aqui, de propósito: exceção individual vazia é legítima
  // (= "sem exceções" — os smokes do furo 11 usam exatamente isso como cleanup).

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Conjunto ANTERIOR antes do DELETE — é ele que vira o diff added/removed do log.
    const prevRes = await client.query('SELECT page_key FROM user_permissions WHERE user_id = $1', [cleanUserId]);
    const prev: string[] = prevRes.rows.map((r: { page_key: string }) => r.page_key);

    // Limpa as permissões antigas específicas desse usuário
    await client.query('DELETE FROM user_permissions WHERE user_id = $1', [cleanUserId]);

    // Insere as novas permissões (já validadas e deduplicadas)
    for (const page of parsed.keys) {
      await client.query('INSERT INTO user_permissions (user_id, page_key) VALUES ($1, $2)', [cleanUserId, page]);
    }

    // 📝 Log de Auditoria — com DIFF, mesmo contrato do espelho por papel.
    const { added, removed } = diffKeys(prev, parsed.keys);
    await createLog(requesterId, 'UPDATE_USER_PERMISSIONS', { user_target: cleanUserId, added, removed, count: parsed.keys.length }, getClientIp(req), client);

    await client.query('COMMIT');

    // ⚡ Atualiza o Frontend em tempo real para este usuário específico.
    // Sala `user:${id}` é a do socket AUTENTICADO (config/socket.ts) e a ÚNICA possível:
    // sem join_room, a sala com o id cru não tem como ser populada por ninguém.
    if ((req as any).io) {
        (req as any).io.to(`user:${cleanUserId}`).emit('user_permissions_updated', { userId: cleanUserId, permissions: parsed.keys });
    }

    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: 'Erro ao salvar permissões de usuário' });
  } finally {
    client.release();
  }
};
