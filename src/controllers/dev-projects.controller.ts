// src/controllers/dev-projects.controller.ts — dev-projetos v1 (projetos internos do dev).
//
// MODELO (decisões travadas do Bruno, 29/07/2026 — migration 013):
//   - Tabela PRÓPRIA dev_projects; `tasks` fica intocada (é do Quadro de Tarefas futuro).
//   - Router INTEIRO atrás de requirePermission('projetos') — ferramenta interna do Dev,
//     sem superfície pública; a page_key nasceu no universo pela própria migration.
//   - GRADE, não kanban: status ativo|arquivado com transição LIVRE pelo PUT (sem máquina
//     de estados de propósito — arquivar/reativar não tem efeito colateral). Arquivar é a
//     ação primária da tela; excluir é hard delete com confirm.
//   - OP OPCIONAL: op_code resolve em client_services validando SÓ EXISTÊNCIA (sem guard
//     de status de OP — o guard do tasks compara strings fantasmas; dívida registrada).
//     PUT com op_code: null DESVINCULA explicitamente.
//   - SEM SOCKET de propósito: ferramenta de uma pessoa hoje — emitir evento seria ruído;
//     quando houver segundo consumidor, entra escopado (padrão ticket_updated).
//   - Auditoria SEM req.body cru (lição do tasks): EDITAR_PROJETO loga os NOMES dos campos
//     alterados; transição de status vira action própria (ARQUIVAR/REATIVAR_PROJETO).

import { Request, Response } from 'express';
import { pool, query as dbQuery } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const PRIORIDADES = ['baixa', 'media', 'alta'];
const STATUSES = ['ativo', 'arquivado'];
// Allowlist sã de cores do CARTÃO (apresentação — o front pinta com uiTone).
const CORES = ['blue', 'green', 'amber', 'red', 'purple', 'gray'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valida e NORMALIZA os checklists do mock: [{titulo, itens: [{t, done}]}].
// Devolve { ok: estrutura limpa } ou { erro: mensagem pra 400 } — nada passa cru pro banco.
function validarChecklists(input: unknown): { ok?: object[]; erro?: string } {
  if (!Array.isArray(input)) return { erro: 'checklists deve ser uma lista.' };
  if (input.length > 20) return { erro: 'Máximo de 20 checklists por projeto.' };
  const limpos: object[] = [];
  for (const cl of input) {
    if (cl === null || typeof cl !== 'object' || Array.isArray(cl)) {
      return { erro: 'Cada checklist deve ser um objeto {titulo, itens}.' };
    }
    const titulo = typeof (cl as any).titulo === 'string' ? (cl as any).titulo.trim() : '';
    if (!titulo) return { erro: 'Todo checklist precisa de um título.' };
    if (titulo.length > 200) return { erro: 'Título de checklist deve ter no máximo 200 caracteres.' };
    const itens = (cl as any).itens;
    if (!Array.isArray(itens)) return { erro: `Checklist "${titulo}": itens deve ser uma lista.` };
    if (itens.length > 100) return { erro: `Checklist "${titulo}": máximo de 100 itens.` };
    const itensLimpos: object[] = [];
    for (const it of itens) {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) {
        return { erro: `Checklist "${titulo}": cada item deve ser um objeto {t, done}.` };
      }
      const t = typeof (it as any).t === 'string' ? (it as any).t.trim() : '';
      if (!t) return { erro: `Checklist "${titulo}": item sem texto.` };
      if (t.length > 500) return { erro: `Checklist "${titulo}": item deve ter no máximo 500 caracteres.` };
      itensLimpos.push({ t, done: (it as any).done === true });
    }
    limpos.push({ titulo, itens: itensLimpos });
  }
  return { ok: limpos };
}

// op_code → client_services.id. SÓ existência (sem guard de status de OP — ver cabeçalho).
async function resolverOp(opCode: string): Promise<string | null> {
  const r = await dbQuery('SELECT id FROM client_services WHERE op_code = $1', [opCode]);
  return r.rows.length > 0 ? r.rows[0].id : null;
}

const SELECT_PROJETO = `
  SELECT p.id, p.name, p.description, p.priority, p.status, p.color, p.checklists,
         p.client_service_id, p.created_by, p.created_at, p.updated_at,
         cs.op_code
  FROM dev_projects p
  LEFT JOIN client_services cs ON p.client_service_id = cs.id`;

// ── GET /dev-projects — a grade (?status= ativo|arquivado|todos; default ativo) ──
export const getProjects = async (req: Request, res: Response) => {
  const status = req.query.status === undefined ? 'ativo' : String(req.query.status);
  if (!['ativo', 'arquivado', 'todos'].includes(status)) {
    return res.status(400).json({ error: "Status inválido. Use: ativo, arquivado ou todos." });
  }
  try {
    const params: string[] = [];
    let where = '';
    if (status !== 'todos') { params.push(status); where = 'WHERE p.status = $1'; }
    const { rows } = await dbQuery(`${SELECT_PROJETO} ${where} ORDER BY p.updated_at DESC`, params);
    res.json({ projects: rows, total: rows.length });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar projetos.' });
  }
};

// ── GET /dev-projects/:id — detalhe (sustenta o modal recarregável e o smoke) ──
export const getProject = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Projeto não encontrado.' });
  try {
    const { rows } = await dbQuery(`${SELECT_PROJETO} WHERE p.id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Projeto não encontrado.' });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar o projeto.' });
  }
};

// ── POST /dev-projects — criar (borda completa; created_by SEMPRE do token) ──
export const createProject = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { name, description, priority, color, checklists, op_code } = req.body ?? {};

  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (cleanName.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });
  const cleanPriority = priority === undefined || priority === null || priority === '' ? 'media' : priority;
  if (!PRIORIDADES.includes(cleanPriority)) {
    return res.status(400).json({ error: `Prioridade inválida. Use: ${PRIORIDADES.join(', ')}.` });
  }
  const cleanColor = color === undefined || color === null || color === '' ? 'blue' : color;
  if (!CORES.includes(cleanColor)) {
    return res.status(400).json({ error: `Cor inválida. Use: ${CORES.join(', ')}.` });
  }
  let cleanChecklists: object[] = [];
  if (checklists !== undefined) {
    const v = validarChecklists(checklists);
    if (v.erro) return res.status(400).json({ error: v.erro });
    cleanChecklists = v.ok as object[];
  }
  let clientServiceId: string | null = null;
  if (op_code !== undefined && op_code !== null && op_code !== '') {
    clientServiceId = await resolverOp(String(op_code));
    if (!clientServiceId) return res.status(404).json({ error: 'OP não encontrada no sistema. Verifique o número digitado.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO dev_projects (name, description, priority, color, checklists, client_service_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [cleanName, typeof description === 'string' ? description.trim() : '', cleanPriority, cleanColor,
        JSON.stringify(cleanChecklists), clientServiceId, userId],
    );
    await createLog(userId, 'CRIAR_PROJETO', { id: rows[0].id, name: cleanName }, getClientIp(req));
    res.status(201).json({ id: rows[0].id });
  } catch (error: any) {
    console.error('Erro ao criar projeto:', error);
    res.status(500).json({ error: 'Erro ao criar projeto.' });
  }
};

// ── PUT /dev-projects/:id — edição parcial + arquivar/reativar ──
// Transação com FOR UPDATE pra auditar a mudança REAL (valor anterior lido na mesma tx).
export const updateProject = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const { name, description, priority, status, color, checklists, op_code } = req.body ?? {};
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Projeto não encontrado.' });

  // Bordas ANTES da transação (400 barato, sem tocar o banco).
  const fields: string[] = [];
  const values: any[] = [];
  const alterados: string[] = [];
  let idx = 1;
  if (name !== undefined) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (cleanName.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });
    fields.push(`name = $${idx++}`); values.push(cleanName); alterados.push('name');
  }
  if (description !== undefined) {
    fields.push(`description = $${idx++}`); values.push(typeof description === 'string' ? description.trim() : ''); alterados.push('description');
  }
  if (priority !== undefined) {
    if (!PRIORIDADES.includes(priority)) return res.status(400).json({ error: `Prioridade inválida. Use: ${PRIORIDADES.join(', ')}.` });
    fields.push(`priority = $${idx++}`); values.push(priority); alterados.push('priority');
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido. Use: ativo ou arquivado.' });
    fields.push(`status = $${idx++}`); values.push(status); alterados.push('status');
  }
  if (color !== undefined) {
    if (!CORES.includes(color)) return res.status(400).json({ error: `Cor inválida. Use: ${CORES.join(', ')}.` });
    fields.push(`color = $${idx++}`); values.push(color); alterados.push('color');
  }
  if (checklists !== undefined) {
    const v = validarChecklists(checklists);
    if (v.erro) return res.status(400).json({ error: v.erro });
    fields.push(`checklists = $${idx++}`); values.push(JSON.stringify(v.ok)); alterados.push('checklists');
  }
  if (op_code !== undefined) {
    if (op_code === null || op_code === '') {
      // null EXPLÍCITO desvincula (decisão travada).
      fields.push(`client_service_id = $${idx++}`); values.push(null); alterados.push('op_code');
    } else {
      const clientServiceId = await resolverOp(String(op_code));
      if (!clientServiceId) return res.status(404).json({ error: 'OP não encontrada no sistema. Verifique o número digitado.' });
      fields.push(`client_service_id = $${idx++}`); values.push(clientServiceId); alterados.push('op_code');
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const atual = await client.query('SELECT name, status FROM dev_projects WHERE id = $1 FOR UPDATE', [id]);
    if (atual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    values.push(id);
    await client.query(
      `UPDATE dev_projects SET ${fields.join(', ')}, updated_at = now() WHERE id = $${idx}`,
      values,
    );

    // Action pela mudança REAL de status (não pelo que veio no body): arquivar/reativar
    // são as ações nomeadas da tela; edição comum loga os NOMES dos campos (nunca valores).
    const statusMudou = status !== undefined && status !== atual.rows[0].status;
    const action = statusMudou
      ? (status === 'arquivado' ? 'ARQUIVAR_PROJETO' : 'REATIVAR_PROJETO')
      : 'EDITAR_PROJETO';
    await createLog(userId, action, { id, name: atual.rows[0].name, alterados }, getClientIp(req), client);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (e) { /* já rolou */ }
    console.error('Erro ao atualizar projeto:', error);
    res.status(500).json({ error: 'Erro ao atualizar projeto.' });
  } finally {
    client.release();
  }
};

// ── DELETE /dev-projects/:id — hard delete (ferramenta interna; confirm é da tela) ──
export const deleteProject = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Projeto não encontrado.' });
  try {
    const { rows } = await pool.query('DELETE FROM dev_projects WHERE id = $1 RETURNING name', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Projeto não encontrado.' });
    await createLog(userId, 'EXCLUIR_PROJETO', { id, name: rows[0].name }, getClientIp(req));
    res.json({ success: true });
  } catch (error: any) {
    console.error('Erro ao excluir projeto:', error);
    res.status(500).json({ error: 'Erro ao excluir projeto.' });
  }
};
