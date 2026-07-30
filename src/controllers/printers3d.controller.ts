// src/controllers/printers3d.controller.ts — Registro de Valores 3D: impressoras + manutenções.
//
// GATE: router inteiro atrás de requirePermission('producao_3d') — a chave que já existia no
// universo da tela Permissões e NÃO gateava nada até a migration 017.
//
// STATUS É CADASTRO, NÃO MÁQUINA DE ESTADOS: ativa|manutencao|inativa com transições LIVRES entre
// si. Uma impressora volta de manutenção pra ativa (e vice-versa) sem cerimônia — travar isso
// numa máquina só criaria atrito num campo que descreve o mundo, não um fluxo.
//
// MANUTENÇÃO É SÓ REGISTRO NA v1: o `cost` é gravado pra que o rateio da v2 tenha história, mas
// NENHUM cálculo desta versão o usa. Registrar sem ratear é honesto; ratear sem base de horas
// seria inventar número.

import { Request, Response } from 'express';
import { query as dbQuery, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const STATUSES = ['ativa', 'manutencao', 'inativa'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// AAAA-MM-DD. A coluna é DATE: manutenção é evento do dia, não do instante (sem fuso no meio).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SELECT_PRINTER = `
  SELECT pr.id, pr.display_no, pr.name, pr.model, pr.power_watts, pr.status, pr.notes,
         pr.created_by, pr.created_at, pr.updated_at
  FROM printers_3d pr`;

// ── GET /printers-3d ─────────────────────────────────────────────────────────
export const getPrinters = async (req: Request, res: Response) => {
  const status = req.query.status === undefined ? '' : String(req.query.status);
  if (status && !STATUSES.includes(status) && status !== 'todos') {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUSES.join(', ')} ou todos.` });
  }
  try {
    const params: string[] = [];
    let where = '';
    if (status && status !== 'todos') { params.push(status); where = 'WHERE pr.status = $1'; }
    // Agregado leve: quantas manutenções e quanto já custou (a tela lista sem abrir o extrato).
    const { rows } = await dbQuery(
      `SELECT pr.id, pr.display_no, pr.name, pr.model, pr.power_watts, pr.status, pr.notes,
              pr.created_by, pr.created_at, pr.updated_at,
              ag.manutencoes, ag.custo_manutencoes
         FROM printers_3d pr
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS manutencoes, COALESCE(SUM(m.cost), 0)::float8 AS custo_manutencoes
             FROM printer_maintenances m WHERE m.printer_id = pr.id
         ) ag ON TRUE
       ${where}
       ORDER BY pr.display_no ASC`,
      params,
    );
    return res.json({ printers: rows, total: rows.length });
  } catch (error: any) {
    console.error('getPrinters:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao buscar as impressoras.' });
  }
};

// ── GET /printers-3d/:id — detalhe + extrato de manutenções ──────────────────
export const getPrinter = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Impressora não encontrada.' });
  try {
    const { rows } = await dbQuery(`${SELECT_PRINTER} WHERE pr.id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Impressora não encontrada.' });
    const manut = await dbQuery(
      `SELECT id, date, description, cost::float8 AS cost, created_by, created_at
         FROM printer_maintenances WHERE printer_id = $1 ORDER BY date DESC, created_at DESC`,
      [id],
    );
    return res.json({ ...rows[0], manutencoes: manut.rows });
  } catch (error: any) {
    console.error('getPrinter:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao buscar a impressora.' });
  }
};

// ── POST /printers-3d ────────────────────────────────────────────────────────
export const createPrinter = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { name, model, power_watts, notes } = req.body ?? {};

  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Nome da impressora é obrigatório.' });
  if (cleanName.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });

  const cleanModel = typeof model === 'string' ? model.trim() : '';
  if (cleanModel.length > 100) return res.status(400).json({ error: 'Modelo deve ter no máximo 100 caracteres.' });

  const watts = Number(power_watts);
  if (!Number.isInteger(watts) || watts <= 0) {
    return res.status(400).json({ error: 'Potência (watts) deve ser um número inteiro maior que zero.' });
  }
  const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 1000) : '';

  try {
    const { rows } = await dbQuery(
      `INSERT INTO printers_3d (name, model, power_watts, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, display_no`,
      [cleanName, cleanModel, watts, cleanNotes, userId],
    );
    await createLog(userId, 'CRIAR_IMPRESSORA',
      { id: rows[0].id, display_no: rows[0].display_no, name: cleanName, power_watts: watts }, getClientIp(req));
    return res.status(201).json({ id: rows[0].id, display_no: rows[0].display_no });
  } catch (error: any) {
    console.error('createPrinter:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao cadastrar a impressora.' });
  }
};

// ── PUT /printers-3d/:id — edição parcial ────────────────────────────────────
export const updatePrinter = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Impressora não encontrada.' });

  const { name, model, power_watts, notes } = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  const alterados: string[] = [];

  if (name !== undefined) {
    const v = typeof name === 'string' ? name.trim() : '';
    if (!v) return res.status(400).json({ error: 'Nome da impressora é obrigatório.' });
    if (v.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });
    vals.push(v); sets.push(`name = $${vals.length}`); alterados.push('name');
  }
  if (model !== undefined) {
    const v = typeof model === 'string' ? model.trim() : '';
    if (v.length > 100) return res.status(400).json({ error: 'Modelo deve ter no máximo 100 caracteres.' });
    vals.push(v); sets.push(`model = $${vals.length}`); alterados.push('model');
  }
  if (power_watts !== undefined) {
    const w = Number(power_watts);
    if (!Number.isInteger(w) || w <= 0) return res.status(400).json({ error: 'Potência (watts) deve ser um número inteiro maior que zero.' });
    vals.push(w); sets.push(`power_watts = $${vals.length}`); alterados.push('power_watts');
  }
  if (notes !== undefined) {
    const v = typeof notes === 'string' ? notes.trim().slice(0, 1000) : '';
    vals.push(v); sets.push(`notes = $${vals.length}`); alterados.push('notes');
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

  try {
    vals.push(id);
    const { rows } = await dbQuery(
      `UPDATE printers_3d SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}
       RETURNING id, display_no`,
      vals,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Impressora não encontrada.' });
    // Auditoria com os NOMES dos campos, nunca os valores (lição do tasks).
    await createLog(userId, 'EDITAR_IMPRESSORA', { id, display_no: rows[0].display_no, alterados }, getClientIp(req));
    return res.json({ id, display_no: rows[0].display_no, alterados });
  } catch (error: any) {
    console.error('updatePrinter:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao atualizar a impressora.' });
  }
};

// ── PUT /printers-3d/:id/status — transições LIVRES (é cadastro) ─────────────
export const updatePrinterStatus = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Impressora não encontrada.' });
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUSES.join(', ')}.` });
  }
  try {
    const { rows } = await dbQuery(
      `UPDATE printers_3d SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, display_no, status`,
      [status, id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Impressora não encontrada.' });
    await createLog(userId, 'EDITAR_IMPRESSORA', { id, display_no: rows[0].display_no, alterados: ['status'] }, getClientIp(req));
    return res.json(rows[0]);
  } catch (error: any) {
    console.error('updatePrinterStatus:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao mudar o status da impressora.' });
  }
};

// ── DELETE /printers-3d/:id ──────────────────────────────────────────────────
// 409 com manutenções: apagar a impressora apagaria o histórico de gastos junto (e a v2 vai
// precisar dele pro rateio). O caminho certo pra tirar de circulação é status='inativa' — e a
// mensagem diz isso, em vez de mandar o usuário adivinhar.
export const deletePrinter = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Impressora não encontrada.' });
  try {
    const out = await withTransaction(async (client) => {
      const cur = await client.query('SELECT id, display_no, name FROM printers_3d WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) return { notFound: true } as any;
      const n = await client.query('SELECT count(*)::int AS n FROM printer_maintenances WHERE printer_id = $1', [id]);
      if (n.rows[0].n > 0) return { conflito: n.rows[0].n, display_no: cur.rows[0].display_no } as any;
      await client.query('DELETE FROM printers_3d WHERE id = $1', [id]);
      return { ok: true, display_no: cur.rows[0].display_no, name: cur.rows[0].name } as any;
    });

    if (out?.notFound) return res.status(404).json({ error: 'Impressora não encontrada.' });
    if (out?.conflito) {
      return res.status(409).json({
        error: `Esta impressora tem ${out.conflito} manutenção(ões) registrada(s) e não pode ser excluída — o histórico de gastos morreria junto. Marque como "inativa" para tirá-la de circulação.`,
      });
    }
    await createLog(userId, 'EXCLUIR_IMPRESSORA', { id, display_no: out.display_no, name: out.name }, getClientIp(req));
    return res.json({ success: true });
  } catch (error: any) {
    console.error('deletePrinter:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao excluir a impressora.' });
  }
};

// ── POST /printers-3d/:id/maintenances ───────────────────────────────────────
export const createMaintenance = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Impressora não encontrada.' });

  const { date, description, cost } = req.body ?? {};
  const cleanDate = typeof date === 'string' ? date.trim() : '';
  if (!DATE_RE.test(cleanDate) || Number.isNaN(Date.parse(`${cleanDate}T00:00:00Z`))) {
    return res.status(400).json({ error: 'Data inválida. Use o formato AAAA-MM-DD.' });
  }
  const cleanDesc = typeof description === 'string' ? description.trim() : '';
  if (!cleanDesc) return res.status(400).json({ error: 'Descrição da manutenção é obrigatória.' });
  if (cleanDesc.length > 500) return res.status(400).json({ error: 'Descrição deve ter no máximo 500 caracteres.' });
  const custo = cost === undefined || cost === null || cost === '' ? 0 : Number(cost);
  if (!Number.isFinite(custo) || custo < 0) return res.status(400).json({ error: 'Custo deve ser um número maior ou igual a zero.' });

  try {
    const printer = await dbQuery('SELECT display_no FROM printers_3d WHERE id = $1', [id]);
    if (printer.rows.length === 0) return res.status(404).json({ error: 'Impressora não encontrada.' });

    const { rows } = await dbQuery(
      `INSERT INTO printer_maintenances (printer_id, date, description, cost, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, date, description, cost::float8 AS cost, created_at`,
      [id, cleanDate, cleanDesc, custo, userId],
    );
    await createLog(userId, 'REGISTRAR_MANUTENCAO',
      { id: rows[0].id, printer_id: id, display_no: printer.rows[0].display_no, date: cleanDate, cost: custo }, getClientIp(req));
    return res.status(201).json(rows[0]);
  } catch (error: any) {
    console.error('createMaintenance:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao registrar a manutenção.' });
  }
};

// ── DELETE /printers-3d/:printerId/maintenances/:id ──────────────────────────
export const deleteMaintenance = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { printerId, id } = req.params;
  if (!UUID_RE.test(printerId) || !UUID_RE.test(id)) return res.status(404).json({ error: 'Manutenção não encontrada.' });
  try {
    const { rows } = await dbQuery(
      'DELETE FROM printer_maintenances WHERE id = $1 AND printer_id = $2 RETURNING id, date, cost::float8 AS cost',
      [id, printerId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Manutenção não encontrada.' });
    await createLog(userId, 'EXCLUIR_MANUTENCAO', { id, printer_id: printerId, date: rows[0].date, cost: rows[0].cost }, getClientIp(req));
    return res.json({ success: true });
  } catch (error: any) {
    console.error('deleteMaintenance:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao excluir a manutenção.' });
  }
};
