// src/controllers/assembly.controller.ts — Montagem de Máquinas v1 (peça 5 do módulo Produção).
//
// CAMINHO B (decisão travada do Bruno, 30/07/2026 — ver o cabeçalho da migration 016):
//   - A máquina é ENTIDADE PRÓPRIA e PERTENCE a uma OP (client_service_id NOT NULL, N:1).
//   - No razão de material ela é ETIQUETA: op_material_events.machine_id. DIMENSÃO, nunca eixo.
//   - A projeção de saldo per-OP e o advisory lock seguem por (OP, produto) — machine_id NÃO
//     entra em nenhum dos dois. "Saldo por máquina" é a mesma classe de erro do op_id no stock.
//   - NADA aqui chama StockService: o físico já foi debitado na entrega da separação. Este
//     módulo lê o razão de WIP e escreve a entidade máquina — nunca saldo.
//
// ÁRVORE DO PRODUTO = PROJEÇÃO (GET /:id): SUM(qty) dos eventos 'consumido' com machine_id = X,
//   agrupado por produto. Não existe BOM planejada no sistema e a v1 não inventa uma.
//   NOTA HONESTA DA v1: a soma considera SÓ 'consumido'. 'devolvido' e 'transferido_*' ainda
//   não carregam machine_id (a etiqueta nasceu no consume), então subtrair devolução aqui daria
//   um número que o razão não sustenta. Quando o evento de devolução for etiquetado, a fórmula
//   ganha o sinal — e é ESTE comentário que precisa mudar junto.
//
// CORTE DA v1 (travado): máquina + checklists + machine_id no consumo + árvore derivada.
//   FORA: congelamento da ficha (a coluna nem nasceu), notificação de parada (notifications é
//   órfã por decisão — parada é ESTADO) e a transição 'concluida' (400 com mensagem de v2).

import { Request, Response } from 'express';
import { pool, query as dbQuery, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const STATUSES = ['andamento', 'parada', 'concluida'];
// Setores que podem ser responsabilizados por uma parada (o mock oferece exatamente estes 4).
const SETORES_PARADA = ['Compras', 'Financeiro', 'Comercial', 'PCP'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valida e NORMALIZA os checklists do mock: [{nome, peso, itens: [{t, done, dia}]}].
// Devolve { ok: estrutura limpa } ou { erro: mensagem pra 400 } — nada passa cru pro banco.
//
// ⚠ NÃO exigimos Σpeso = 100 DE PROPÓSITO: peso é APRESENTAÇÃO (a fatia que o grupo ocupa na
// barra de progresso), não invariante contábil. O front orienta o usuário a fechar 100; o banco
// não trava. Travar aqui quebraria o caso legítimo "criei um grupo novo no meio do trabalho" e
// obrigaria a rebalancear tudo antes de salvar — atrito sem ganho, porque o progresso é média
// PONDERADA (funciona com qualquer soma).
function validarChecklists(input: unknown): { ok?: object[]; erro?: string } {
  if (!Array.isArray(input)) return { erro: 'checklists deve ser uma lista.' };
  if (input.length > 20) return { erro: 'Máximo de 20 checklists por máquina.' };
  const limpos: object[] = [];
  for (const cl of input) {
    if (cl === null || typeof cl !== 'object' || Array.isArray(cl)) {
      return { erro: 'Cada checklist deve ser um objeto {nome, peso, itens}.' };
    }
    const nome = typeof (cl as any).nome === 'string' ? (cl as any).nome.trim() : '';
    if (!nome) return { erro: 'Todo checklist precisa de um nome.' };
    if (nome.length > 200) return { erro: 'Nome de checklist deve ter no máximo 200 caracteres.' };

    const pesoRaw = (cl as any).peso;
    const peso = pesoRaw === undefined || pesoRaw === null || pesoRaw === '' ? 0 : Number(pesoRaw);
    if (!Number.isInteger(peso) || peso < 0 || peso > 100) {
      return { erro: `Checklist "${nome}": peso deve ser um inteiro de 0 a 100.` };
    }

    const itens = (cl as any).itens;
    if (!Array.isArray(itens)) return { erro: `Checklist "${nome}": itens deve ser uma lista.` };
    if (itens.length > 100) return { erro: `Checklist "${nome}": máximo de 100 itens.` };
    const itensLimpos: object[] = [];
    for (const it of itens) {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) {
        return { erro: `Checklist "${nome}": cada item deve ser um objeto {t, done, dia}.` };
      }
      const t = typeof (it as any).t === 'string' ? (it as any).t.trim() : '';
      if (!t) return { erro: `Checklist "${nome}": item sem texto.` };
      if (t.length > 500) return { erro: `Checklist "${nome}": item deve ter no máximo 500 caracteres.` };
      const diaRaw = (it as any).dia;
      if (diaRaw !== undefined && diaRaw !== null && typeof diaRaw !== 'string') {
        return { erro: `Checklist "${nome}": "dia" deve ser texto ou nulo.` };
      }
      const dia = typeof diaRaw === 'string' && diaRaw.trim() ? diaRaw.trim().slice(0, 20) : null;
      itensLimpos.push({ t, done: (it as any).done === true, dia });
    }
    limpos.push({ nome, peso, itens: itensLimpos });
  }
  return { ok: limpos };
}

// op_code -> client_services.id. SÓ existência, SEM guard de status de OP: mesmo racional do
// dev-projects — o guard do tasks compara 'finalizada'/'encerrada', valores que não existem no
// banco (os reais são 'em_andamento'/'concluido'). Não repetir guard fantasma; o conserto dos
// guards de OP fechada do sistema é peça própria.
async function resolverOp(opCode: string): Promise<{ id: string } | null> {
  const r = await dbQuery('SELECT id FROM client_services WHERE op_code = $1', [opCode]);
  return r.rows.length > 0 ? { id: r.rows[0].id } : null;
}

const SELECT_MAQUINA = `
  SELECT m.id, m.display_no, m.name, m.client_service_id, m.sector, m.responsible, m.status,
         m.stopped_reason, m.stopped_sector, m.stopped_at, m.checklists,
         m.created_by, m.created_at, m.updated_at,
         cs.op_code
  FROM assembly_machines m
  JOIN client_services cs ON cs.id = m.client_service_id`;

// ── POST /assembly-machines — cadastrar máquina ──────────────────────────────
export const createMachine = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { name, op_code, sector, responsible, checklists } = req.body ?? {};

  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Nome da máquina é obrigatório.' });
  if (cleanName.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });

  const cleanOp = typeof op_code === 'string' ? op_code.trim() : '';
  if (!cleanOp) return res.status(400).json({ error: 'OP é obrigatória — a máquina pertence a uma OP.' });

  const cleanSector = typeof sector === 'string' ? sector.trim() : '';
  if (cleanSector.length > 100) return res.status(400).json({ error: 'Setor deve ter no máximo 100 caracteres.' });
  const cleanResp = typeof responsible === 'string' ? responsible.trim() : '';
  if (cleanResp.length > 100) return res.status(400).json({ error: 'Responsável deve ter no máximo 100 caracteres.' });

  // checklists é OPCIONAL no create: os 5 grupos padrão (Chassi/Solda/Materiais/Elétrica/
  // Acabamento) são TEMPLATE DO FRONT, não do banco — quem decide o processo é a tela, e
  // congelar esse template aqui obrigaria migration toda vez que a fábrica mudasse de método.
  let cleanChecklists: object[] = [];
  if (checklists !== undefined) {
    const v = validarChecklists(checklists);
    if (v.erro) return res.status(400).json({ error: v.erro });
    cleanChecklists = v.ok!;
  }

  try {
    const op = await resolverOp(cleanOp);
    if (!op) return res.status(404).json({ error: 'OP não encontrada no sistema. Verifique o número digitado.' });

    const { rows } = await dbQuery(
      `INSERT INTO assembly_machines (name, client_service_id, sector, responsible, checklists, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, display_no`,
      [cleanName, op.id, cleanSector, cleanResp, JSON.stringify(cleanChecklists), userId],
    );

    await createLog(userId, 'CRIAR_MAQUINA',
      { id: rows[0].id, display_no: rows[0].display_no, name: cleanName, op_code: cleanOp },
      getClientIp(req));

    return res.status(201).json({ id: rows[0].id, display_no: rows[0].display_no });
  } catch (error: any) {
    console.error('createMachine:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao cadastrar a máquina.' });
  }
};

// ── GET /assembly-machines — a grade ─────────────────────────────────────────
// ?status= andamento|parada|concluida|todos. DEFAULT exclui 'concluida': a tela é o chão de
// fábrica de hoje; máquina concluída é histórico (e na v1 nem existe caminho pra chegar lá).
export const getMachines = async (req: Request, res: Response) => {
  const status = req.query.status === undefined ? '' : String(req.query.status);
  if (status && !['andamento', 'parada', 'concluida', 'todos'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido. Use: andamento, parada, concluida ou todos.' });
  }

  try {
    const params: string[] = [];
    let where = "WHERE m.status <> 'concluida'"; // default
    if (status === 'todos') where = '';
    else if (status) { params.push(status); where = 'WHERE m.status = $1'; }

    // Agregado leve por máquina: quantos eventos de consumo já foram etiquetados nela (a grade
    // mostra "N itens na árvore"). LATERAL pra não inflar a linha com JOIN de N eventos.
    const { rows } = await dbQuery(
      `SELECT m.id, m.display_no, m.name, m.client_service_id, m.sector, m.responsible, m.status,
              m.stopped_reason, m.stopped_sector, m.stopped_at, m.checklists,
              m.created_by, m.created_at, m.updated_at,
              cs.op_code,
              ag.eventos_consumo
         FROM assembly_machines m
         JOIN client_services cs ON cs.id = m.client_service_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS eventos_consumo
             FROM op_material_events e
            WHERE e.machine_id = m.id AND e.event_type = 'consumido'
         ) ag ON TRUE
       ${where}
       ORDER BY m.updated_at DESC`,
      params,
    );
    return res.json({ machines: rows, total: rows.length });
  } catch (error: any) {
    console.error('getMachines:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao buscar as máquinas.' });
  }
};

// ── GET /assembly-machines/:id — detalhe + ÁRVORE DERIVADA ───────────────────
export const getMachine = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Máquina não encontrada.' });

  try {
    const { rows } = await dbQuery(`${SELECT_MAQUINA} WHERE m.id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Máquina não encontrada.' });

    // A ÁRVORE: projeção do razão, nunca tabela. Só 'consumido' (ver nota no cabeçalho).
    const arvore = await dbQuery(
      `SELECT p.id AS product_id, p.sku, p.name, p.unit, SUM(e.qty) AS qty
         FROM op_material_events e
         JOIN products p ON p.id = e.product_id
        WHERE e.machine_id = $1 AND e.event_type = 'consumido'
        GROUP BY p.id, p.sku, p.name, p.unit
        ORDER BY p.name`,
      [id],
    );

    return res.json({ ...rows[0], arvore: arvore.rows });
  } catch (error: any) {
    console.error('getMachine:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao buscar a máquina.' });
  }
};

// ── PUT /assembly-machines/:id — edição parcial ──────────────────────────────
export const updateMachine = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Máquina não encontrada.' });

  const { name, sector, responsible, checklists } = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  const alterados: string[] = [];

  if (name !== undefined) {
    const v = typeof name === 'string' ? name.trim() : '';
    if (!v) return res.status(400).json({ error: 'Nome da máquina é obrigatório.' });
    if (v.length > 200) return res.status(400).json({ error: 'Nome deve ter no máximo 200 caracteres.' });
    vals.push(v); sets.push(`name = $${vals.length}`); alterados.push('name');
  }
  if (sector !== undefined) {
    const v = typeof sector === 'string' ? sector.trim() : '';
    if (v.length > 100) return res.status(400).json({ error: 'Setor deve ter no máximo 100 caracteres.' });
    vals.push(v); sets.push(`sector = $${vals.length}`); alterados.push('sector');
  }
  if (responsible !== undefined) {
    const v = typeof responsible === 'string' ? responsible.trim() : '';
    if (v.length > 100) return res.status(400).json({ error: 'Responsável deve ter no máximo 100 caracteres.' });
    vals.push(v); sets.push(`responsible = $${vals.length}`); alterados.push('responsible');
  }
  if (checklists !== undefined) {
    const v = validarChecklists(checklists);
    if (v.erro) return res.status(400).json({ error: v.erro });
    vals.push(JSON.stringify(v.ok)); sets.push(`checklists = $${vals.length}::jsonb`); alterados.push('checklists');
  }

  // A OP NÃO é editável na v1: mudar a OP de uma máquina que já tem consumo etiquetado deixaria
  // a árvore misturando material de duas OPs — exatamente o que o guard do consume impede.
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

  try {
    vals.push(id);
    const { rows } = await dbQuery(
      `UPDATE assembly_machines SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length}
       RETURNING id, display_no`,
      vals,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Máquina não encontrada.' });

    // Auditoria com os NOMES dos campos alterados, NUNCA os valores (lição do tasks).
    await createLog(userId, 'EDITAR_MAQUINA', { id, display_no: rows[0].display_no, alterados }, getClientIp(req));
    return res.json({ id, display_no: rows[0].display_no, alterados });
  } catch (error: any) {
    console.error('updateMachine:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao atualizar a máquina.' });
  }
};

// ── PUT /assembly-machines/:id/status — parar / retomar ──────────────────────
// Transação com FOR UPDATE (padrão tickets): a action de auditoria sai da transição REAL, lida
// do estado travado — não do que o cliente achou que era.
//
// ⚠ PARADA NÃO TRAVA CONSUMO na v1 (decisão travada): parada é SINALIZAÇÃO DE GESTÃO ("estou
// esperando compra"), não bloqueio de material. Travar o razão por status de máquina misturaria
// duas coisas: o razão responde por saldo, a máquina por andamento. Se o Bruno quiser a trava,
// é decisão de v2 — e aí o lugar dela é o consume, com mensagem própria.
export const updateMachineStatus = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Máquina não encontrada.' });

  const { status, reason, sector } = req.body ?? {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUSES.join(', ')}.` });
  }
  // 'concluida' está no CHECK do banco por futuro, mas a v1 não tem caminho pra ele.
  if (status === 'concluida') {
    return res.status(400).json({ error: 'Concluir máquina chega na v2 (congelamento da ficha técnica).' });
  }

  try {
    const out = await withTransaction(async (client) => {
      const cur = await client.query(
        `SELECT id, display_no, status FROM assembly_machines WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (cur.rows.length === 0) return { notFound: true } as any;
      const atual = cur.rows[0];

      if (atual.status === 'concluida') {
        return { erro: 'Máquina concluída não muda de status na v1.' } as any;
      }
      if (atual.status === status) {
        return { semMudanca: true, display_no: atual.display_no } as any;
      }

      if (status === 'parada') {
        const motivo = typeof reason === 'string' ? reason.trim() : '';
        if (!motivo) return { erro: 'Motivo da parada é obrigatório.' } as any;
        if (motivo.length > 500) return { erro: 'Motivo deve ter no máximo 500 caracteres.' } as any;
        if (!SETORES_PARADA.includes(sector)) {
          return { erro: `Setor responsável inválido. Use: ${SETORES_PARADA.join(', ')}.` } as any;
        }
        await client.query(
          `UPDATE assembly_machines
              SET status = 'parada', stopped_reason = $1, stopped_sector = $2, stopped_at = now(), updated_at = now()
            WHERE id = $3`,
          [motivo, sector, id],
        );
        return { action: 'PARAR_MAQUINA', display_no: atual.display_no, detalhes: { id, display_no: atual.display_no, reason: motivo, sector } } as any;
      }

      // -> andamento (retomar): limpa o registro da parada.
      await client.query(
        `UPDATE assembly_machines
            SET status = 'andamento', stopped_reason = NULL, stopped_sector = NULL, stopped_at = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      return { action: 'RETOMAR_MAQUINA', display_no: atual.display_no, detalhes: { id, display_no: atual.display_no } } as any;
    });

    if (out?.notFound) return res.status(404).json({ error: 'Máquina não encontrada.' });
    if (out?.erro) return res.status(400).json({ error: out.erro });
    if (out?.semMudanca) return res.json({ id, display_no: out.display_no, status, semMudanca: true });

    await createLog(userId, out.action, out.detalhes, getClientIp(req));
    return res.json({ id, display_no: out.display_no, status });
  } catch (error: any) {
    console.error('updateMachineStatus:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao mudar o status da máquina.' });
  }
};

// Exportado pro consume do razão validar a etiqueta sem duplicar regra (ver
// opMaterials.controller: o guard de integridade compara a OP da máquina com a OP do consumo).
export async function machinePorId(id: string): Promise<{ id: string; display_no: number; client_service_id: string; status: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, display_no, client_service_id, status FROM assembly_machines WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? rows[0] : null;
}
