// src/controllers/devArea.controller.ts — Área Dev v1 (migration 019).
//
// Três entidades pessoais do desenvolvedor: BLOCOS de agenda (evento/tarefa), NOTAS e SNIPPETS.
// Não há workflow, aprovação nem máquina de estados — quem tem a page_key 'dev_area' cria, lê,
// edita e apaga. O que existe de rigor aqui é o de sempre: borda vira 400 (nunca 500), todo
// parâmetro é parametrizado (jamais concatenado), e toda escrita passa pelo livro da Auditoria.
//
// LEITURA POR PERÍODO (blocos): a visão MÊS do front pede o range inteiro numa chamada, então
// o filtro ?from=&to= é a via principal, não um enfeite. `to` é INCLUSIVO — quem pede
// from=2026-08-01&to=2026-08-31 espera o dia 31 dentro. Como `day` é DATE (sem hora), a
// comparação é direta (day <= to), sem o truque do "< dia seguinte" que o relatório de commits
// precisa por ser TIMESTAMPTZ.

import { Response } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middlewares/auth';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const KINDS = ['evento', 'tarefa'];
const CATEGORIES = ['reuniao', 'estudo', 'trabalho', 'foco'];

// Data de calendário REAL: '2026-02-30' casa o regex e não existe. new Date() aceitaria e
// deslizaria pra 02/03 em silêncio — o deslize seria um dado errado gravado sem erro.
function dataValida(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Comparação de horas como string funciona porque o formato é fixo e zero-padded (HH:MM).
// Normalizamos pra HH:MM:SS antes de comparar para que '09:00' e '09:00:00' não divirjam.
function normHora(s: string): string { return s.length === 5 ? `${s}:00` : s; }

function textoValido(v: any, max: number): boolean {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCOS DE AGENDA
// ─────────────────────────────────────────────────────────────────────────────

export const listBlocks = async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    if (from !== undefined && !dataValida(String(from))) {
      return res.status(400).json({ error: "Parâmetro 'from' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    if (to !== undefined && !dataValida(String(to))) {
      return res.status(400).json({ error: "Parâmetro 'to' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    // Intervalo invertido é ERRO do chamador, não lista vazia: devolver [] esconderia o engano
    // atrás de um resultado plausível.
    if (from && to && String(from) > String(to)) {
      return res.status(400).json({ error: "Intervalo inválido: 'from' é posterior a 'to'." });
    }

    const cond: string[] = [];
    const params: any[] = [];
    if (from) { params.push(from); cond.push(`day >= $${params.length}::date`); }
    // `to` INCLUSIVO: day é DATE, então <= basta (sem o truque do dia seguinte).
    if (to) { params.push(to); cond.push(`day <= $${params.length}::date`); }

    const { rows } = await pool.query(
      `SELECT id, kind, day, start_t, end_t, category, title, done, created_by, created_at, updated_at
         FROM dev_area_blocks
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        -- NULLS FIRST: tarefa sem hora é do dia inteiro e encabeça o dia na tela.
        ORDER BY day ASC, start_t ASC NULLS FIRST, created_at ASC`,
      params
    );
    return res.json({ items: rows, total: rows.length });
  } catch (e) {
    console.error('listBlocks:', e);
    return res.status(500).json({ error: 'Erro ao listar os blocos da agenda.' });
  }
};

export const createBlock = async (req: AuthRequest, res: Response) => {
  try {
    const { kind, day, start_t, end_t, category, title, done } = req.body ?? {};

    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: "Campo 'kind' inválido: use 'evento' ou 'tarefa'." });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Campo 'category' inválido: use 'reuniao', 'estudo', 'trabalho' ou 'foco'." });
    }
    if (typeof day !== 'string' || !dataValida(day)) {
      return res.status(400).json({ error: "Campo 'day' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    if (!textoValido(title, 200)) {
      return res.status(400).json({ error: "Campo 'title' obrigatório (até 200 caracteres)." });
    }
    if (start_t !== undefined && start_t !== null && (typeof start_t !== 'string' || !HHMM_RE.test(start_t))) {
      return res.status(400).json({ error: "Campo 'start_t' inválido: use HH:MM." });
    }
    if (end_t !== undefined && end_t !== null && (typeof end_t !== 'string' || !HHMM_RE.test(end_t))) {
      return res.status(400).json({ error: "Campo 'end_t' inválido: use HH:MM." });
    }
    // Mesma regra do CHECK do banco, validada na borda para virar 400 legível em vez de um
    // 23514 traduzido em 500. O CHECK continua lá como última linha — a borda é conveniência,
    // o banco é a garantia.
    if (start_t && end_t && normHora(end_t) <= normHora(start_t)) {
      return res.status(400).json({ error: "Horário inválido: o fim precisa ser posterior ao início." });
    }
    if (done !== undefined && typeof done !== 'boolean') {
      return res.status(400).json({ error: "Campo 'done' inválido: use true ou false." });
    }

    const userId = req.user!.id;
    const { rows } = await pool.query(
      `INSERT INTO dev_area_blocks (kind, day, start_t, end_t, category, title, done, created_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, COALESCE($7, false), $8)
       RETURNING id, kind, day, start_t, end_t, category, title, done, created_by, created_at, updated_at`,
      [kind, day, start_t ?? null, end_t ?? null, category, String(title).trim(), done ?? null, userId]
    );

    await createLog(userId, 'CRIAR_BLOCO_AREA',
      { bloco_id: rows[0].id, kind, day, category, title: String(title).trim() }, getClientIp(req));

    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error('createBlock:', e);
    return res.status(500).json({ error: 'Erro ao criar o bloco da agenda.' });
  }
};

export const updateBlock = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

    const atual = await pool.query('SELECT * FROM dev_area_blocks WHERE id = $1', [id]);
    if (atual.rowCount === 0) return res.status(404).json({ error: 'Bloco não encontrado.' });
    const antes = atual.rows[0];

    const b = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    const alterados: string[] = [];

    if (b.kind !== undefined) {
      if (!KINDS.includes(b.kind)) return res.status(400).json({ error: "Campo 'kind' inválido: use 'evento' ou 'tarefa'." });
      params.push(b.kind); sets.push(`kind = $${params.length}`); alterados.push('kind');
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Campo 'category' inválido: use 'reuniao', 'estudo', 'trabalho' ou 'foco'." });
      params.push(b.category); sets.push(`category = $${params.length}`); alterados.push('category');
    }
    if (b.day !== undefined) {
      if (typeof b.day !== 'string' || !dataValida(b.day)) return res.status(400).json({ error: "Campo 'day' inválido: use uma data real no formato AAAA-MM-DD." });
      params.push(b.day); sets.push(`day = $${params.length}::date`); alterados.push('day');
    }
    if (b.title !== undefined) {
      if (!textoValido(b.title, 200)) return res.status(400).json({ error: "Campo 'title' obrigatório (até 200 caracteres)." });
      params.push(String(b.title).trim()); sets.push(`title = $${params.length}`); alterados.push('title');
    }
    if (b.done !== undefined) {
      if (typeof b.done !== 'boolean') return res.status(400).json({ error: "Campo 'done' inválido: use true ou false." });
      params.push(b.done); sets.push(`done = $${params.length}`); alterados.push('done');
    }
    if (b.start_t !== undefined) {
      if (b.start_t !== null && (typeof b.start_t !== 'string' || !HHMM_RE.test(b.start_t))) return res.status(400).json({ error: "Campo 'start_t' inválido: use HH:MM." });
      params.push(b.start_t); sets.push(`start_t = $${params.length}`); alterados.push('start_t');
    }
    if (b.end_t !== undefined) {
      if (b.end_t !== null && (typeof b.end_t !== 'string' || !HHMM_RE.test(b.end_t))) return res.status(400).json({ error: "Campo 'end_t' inválido: use HH:MM." });
      params.push(b.end_t); sets.push(`end_t = $${params.length}`); alterados.push('end_t');
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

    // Coerência das horas checada contra o RESULTADO da edição parcial, não só contra o que
    // veio no corpo: mandar só `end_t` precisa ser validado contra o `start_t` que já existe.
    const startFinal = b.start_t !== undefined ? b.start_t : antes.start_t;
    const endFinal = b.end_t !== undefined ? b.end_t : antes.end_t;
    if (startFinal && endFinal && normHora(String(endFinal)) <= normHora(String(startFinal))) {
      return res.status(400).json({ error: "Horário inválido: o fim precisa ser posterior ao início." });
    }

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE dev_area_blocks SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, kind, day, start_t, end_t, category, title, done, created_by, created_at, updated_at`,
      params
    );

    await createLog(req.user!.id, 'EDITAR_BLOCO_AREA',
      { bloco_id: id, alterados }, getClientIp(req));

    return res.json(rows[0]);
  } catch (e) {
    console.error('updateBlock:', e);
    return res.status(500).json({ error: 'Erro ao atualizar o bloco da agenda.' });
  }
};

export const deleteBlock = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

    const { rows, rowCount } = await pool.query(
      'DELETE FROM dev_area_blocks WHERE id = $1 RETURNING kind, day, title', [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Bloco não encontrado.' });

    await createLog(req.user!.id, 'EXCLUIR_BLOCO_AREA',
      { bloco_id: id, kind: rows[0].kind, day: rows[0].day, title: rows[0].title }, getClientIp(req));

    return res.status(204).send();
  } catch (e) {
    console.error('deleteBlock:', e);
    return res.status(500).json({ error: 'Erro ao excluir o bloco da agenda.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTAS
// ─────────────────────────────────────────────────────────────────────────────

// Cor é LIVRE mas VALIDADA: aceita hex (#rgb/#rrggbb) ou um rótulo curto do design
// ('amber', 'blue'…). Allowlist fechada obrigaria deploy pra cada cor nova; livre-de-verdade
// deixaria entrar payload arbitrário num campo que a tela injeta em style.
const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]{3,20})$/i;

function tagsValidas(v: any): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length > 20) return false;
  return v.every((t) => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 40);
}

export const listNotes = async (_req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, body, tags, color, pinned, created_by, created_at, updated_at
         FROM dev_notes
        -- Fixadas primeiro; dentro de cada grupo, as mais recentes antes.
        ORDER BY pinned DESC, updated_at DESC`
    );
    return res.json({ items: rows, total: rows.length });
  } catch (e) {
    console.error('listNotes:', e);
    return res.status(500).json({ error: 'Erro ao listar as notas.' });
  }
};

export const createNote = async (req: AuthRequest, res: Response) => {
  try {
    const { body, tags, color, pinned } = req.body ?? {};
    if (!textoValido(body, 10000)) {
      return res.status(400).json({ error: "Campo 'body' obrigatório (até 10000 caracteres)." });
    }
    if (tags !== undefined && !tagsValidas(tags)) {
      return res.status(400).json({ error: "Campo 'tags' inválido: até 20 rótulos de no máximo 40 caracteres." });
    }
    if (color !== undefined && color !== '' && (typeof color !== 'string' || !COLOR_RE.test(color))) {
      return res.status(400).json({ error: "Campo 'color' inválido: use um hex (#rrggbb) ou um nome curto." });
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      return res.status(400).json({ error: "Campo 'pinned' inválido: use true ou false." });
    }

    const userId = req.user!.id;
    const limpas = Array.isArray(tags) ? tags.map((t: string) => t.trim()) : [];
    const { rows } = await pool.query(
      `INSERT INTO dev_notes (body, tags, color, pinned, created_by)
       VALUES ($1, $2::text[], COALESCE($3, ''), COALESCE($4, false), $5)
       RETURNING id, body, tags, color, pinned, created_by, created_at, updated_at`,
      [String(body).trim(), limpas, color ?? null, pinned ?? null, userId]
    );

    await createLog(userId, 'CRIAR_NOTA', { nota_id: rows[0].id, tags: limpas }, getClientIp(req));
    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error('createNote:', e);
    return res.status(500).json({ error: 'Erro ao criar a nota.' });
  }
};

export const updateNote = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

    const b = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    const alterados: string[] = [];

    if (b.body !== undefined) {
      if (!textoValido(b.body, 10000)) return res.status(400).json({ error: "Campo 'body' obrigatório (até 10000 caracteres)." });
      params.push(String(b.body).trim()); sets.push(`body = $${params.length}`); alterados.push('body');
    }
    if (b.tags !== undefined) {
      if (!tagsValidas(b.tags)) return res.status(400).json({ error: "Campo 'tags' inválido: até 20 rótulos de no máximo 40 caracteres." });
      params.push(b.tags.map((t: string) => t.trim())); sets.push(`tags = $${params.length}::text[]`); alterados.push('tags');
    }
    if (b.color !== undefined) {
      if (b.color !== '' && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) return res.status(400).json({ error: "Campo 'color' inválido: use um hex (#rrggbb) ou um nome curto." });
      params.push(b.color); sets.push(`color = $${params.length}`); alterados.push('color');
    }
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') return res.status(400).json({ error: "Campo 'pinned' inválido: use true ou false." });
      params.push(b.pinned); sets.push(`pinned = $${params.length}`); alterados.push('pinned');
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

    params.push(id);
    const { rows, rowCount } = await pool.query(
      `UPDATE dev_notes SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, body, tags, color, pinned, created_by, created_at, updated_at`,
      params
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Nota não encontrada.' });

    await createLog(req.user!.id, 'EDITAR_NOTA', { nota_id: id, alterados }, getClientIp(req));
    return res.json(rows[0]);
  } catch (e) {
    console.error('updateNote:', e);
    return res.status(500).json({ error: 'Erro ao atualizar a nota.' });
  }
};

export const deleteNote = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
    const { rowCount } = await pool.query('DELETE FROM dev_notes WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Nota não encontrada.' });

    await createLog(req.user!.id, 'EXCLUIR_NOTA', { nota_id: id }, getClientIp(req));
    return res.status(204).send();
  } catch (e) {
    console.error('deleteNote:', e);
    return res.status(500).json({ error: 'Erro ao excluir a nota.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SNIPPETS
// ─────────────────────────────────────────────────────────────────────────────

export const listSnippets = async (req: AuthRequest, res: Response) => {
  try {
    const q = req.query.q;
    if (q !== undefined && typeof q !== 'string') {
      return res.status(400).json({ error: "Parâmetro 'q' inválido." });
    }
    // limit/offset: mesma régua da Auditoria e do relatório de commits — fora do teto é 400,
    // não clamp silencioso (clamp devolveria menos linhas do que o cliente pediu, calado).
    let limit = 25;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !DIGITS_RE.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        return res.status(400).json({ error: "Parâmetro 'limit' inválido: use um inteiro entre 1 e 100." });
      }
      limit = Number(rawLimit);
    }
    let offset = 0;
    const rawOffset = req.query.offset;
    if (rawOffset !== undefined) {
      if (typeof rawOffset !== 'string' || !DIGITS_RE.test(rawOffset)) {
        return res.status(400).json({ error: "Parâmetro 'offset' inválido: use um inteiro maior ou igual a 0." });
      }
      offset = Number(rawOffset);
    }

    // ILIKE PARAMETRIZADO em label E code: quem procura "pool.query" quer achar pelo conteúdo.
    // O termo entra como PARÂMETRO — nunca concatenado (a regra que o 3D pagou pra aprender).
    const cond: string[] = [];
    const params: any[] = [];
    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      cond.push(`(label ILIKE $${params.length} OR code ILIKE $${params.length})`);
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

    // COUNT com o MESMO filtro da página: é o que garante que "total" e as linhas falem do
    // mesmo recorte — offset além do fim devolve [] com o total intacto, não total zerado.
    const tot = await pool.query(`SELECT COUNT(*)::int AS n FROM dev_snippets ${where}`, params);

    params.push(limit); const pLimit = params.length;
    params.push(offset); const pOffset = params.length;
    const { rows } = await pool.query(
      `SELECT id, label, code, created_by, created_at
         FROM dev_snippets ${where}
        ORDER BY created_at DESC, id ASC
        LIMIT $${pLimit} OFFSET $${pOffset}`,
      params
    );

    return res.json({ items: rows, total: tot.rows[0].n, limit, offset });
  } catch (e) {
    console.error('listSnippets:', e);
    return res.status(500).json({ error: 'Erro ao listar os snippets.' });
  }
};

export const createSnippet = async (req: AuthRequest, res: Response) => {
  try {
    const { label, code } = req.body ?? {};
    if (!textoValido(label, 200)) {
      return res.status(400).json({ error: "Campo 'label' obrigatório (até 200 caracteres)." });
    }
    if (typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({ error: "Campo 'code' obrigatório." });
    }
    const userId = req.user!.id;
    const { rows } = await pool.query(
      `INSERT INTO dev_snippets (label, code, created_by) VALUES ($1, $2, $3)
       RETURNING id, label, code, created_by, created_at`,
      [String(label).trim(), code, userId]
    );
    // O CÓDIGO NÃO VAI PRO LIVRO: snippet pode conter credencial colada por descuido, e o
    // audit_logs é lido pela tela de Auditoria. Guardamos o rótulo e o id — o suficiente pra
    // rastrear quem criou o quê, sem copiar segredo pra um segundo lugar.
    await createLog(userId, 'CRIAR_SNIPPET', { snippet_id: rows[0].id, label: String(label).trim() }, getClientIp(req));
    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error('createSnippet:', e);
    return res.status(500).json({ error: 'Erro ao criar o snippet.' });
  }
};

export const deleteSnippet = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
    const { rows, rowCount } = await pool.query('DELETE FROM dev_snippets WHERE id = $1 RETURNING label', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Snippet não encontrado.' });

    await createLog(req.user!.id, 'EXCLUIR_SNIPPET', { snippet_id: id, label: rows[0].label }, getClientIp(req));
    return res.status(204).send();
  } catch (e) {
    console.error('deleteSnippet:', e);
    return res.status(500).json({ error: 'Erro ao excluir o snippet.' });
  }
};
