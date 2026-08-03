// src/controllers/devCosts.controller.ts — Custos & Serviços v1 (migration 019).
//
// O que se paga hoje pra manter o sistema de pé: infra, banco, IA, SaaS.
//
// ── O TOTAL MENSAL É CALCULADO AQUI, E SÓ AQUI ───────────────────────────────────────────────
// `total_mensal` NÃO é coluna e NÃO é somado no front. É uma expressão SQL no GET, e essa é a
// decisão mais importante deste arquivo:
//   • se fosse coluna, ela divergiria das linhas no dia em que alguém editasse um valor por
//     fora do endpoint que atualiza o total;
//   • se fosse somado no front, cada tela que mostrasse o número teria a sua própria versão da
//     regra de normalização — e a primeira divergência apareceria como "o painel diz 295 e a
//     lista diz 559" (que é exatamente 189+84+264, o erro de somar anual cheio).
// UMA fonte de verdade: a normalização mora na expressão `NORMALIZADO` abaixo e é reusada
// pelo total e pelo por_categoria, então os dois NUNCA discordam.
//
// A REGRA DE NORMALIZAÇÃO (travada com o Bruno):
//   mensal   → valor cheio        (já é a despesa do mês)
//   anual    → valor / 12         (a fatia que cabe no mês)
//   variavel → valor cheio        (é a estimativa mensal que o dono anotou; não se divide)
//
// ARREDONDAMENTO — documentado porque é escolha, não acaso:
//   ROUND(..., 2) é aplicado UMA VEZ, DEPOIS da soma (SUM primeiro, arredonda no fim). Isso
//   evita o erro clássico de arredondar cada parcela e acumular a diferença. Como `value` é
//   numeric(12,2) e o Postgres faz a divisão em numeric exato (não em ponto flutuante), um
//   anual de 264,00 vira exatamente 22,00 — e 189 + 84 + 22 fecha 295,00 EXATO, sem epsilon.
//   O driver entrega numeric como STRING: o número chega à tela e ao smoke sem passar por
//   float em momento algum.

import { Response } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middlewares/auth';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const CATEGORIES = ['infra', 'banco', 'ia', 'saas', 'outros'];
const CYCLES = ['mensal', 'anual', 'variavel'];
const STATUSES = ['ok', 'atencao'];

// A ÚNICA definição da normalização. Total e por_categoria leem daqui — é isto que impede os
// dois de divergirem.
const NORMALIZADO = `
  CASE cycle
    WHEN 'mensal'   THEN value
    WHEN 'anual'    THEN value / 12
    WHEN 'variavel' THEN value
  END`;

function dataValida(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Dinheiro entra como string OU número, mas é validado como decimal de até 2 casas e segue
// para o banco como STRING — nunca convertido a float aqui. parseFloat('0.1'+'0.2') é o bug
// que este cuidado evita antes de existir.
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
function valorValido(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 && MONEY_RE.test(String(v));
  if (typeof v === 'string') return MONEY_RE.test(v.trim()) && Number(v.trim()) > 0;
  return false;
}

function textoValido(v: any, max: number): boolean {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

export const listCosts = async (_req: AuthRequest, res: Response) => {
  try {
    const itens = await pool.query(
      `SELECT id, name, category, value, cycle, status, next_billing, usage_note,
              created_by, created_at, updated_at,
              -- O equivalente mensal DESTA linha, pela mesma regra do total. Vai junto porque a
              -- tela mostra "R$ 22,00/mês" num serviço anual sem refazer a conta do lado dela.
              ROUND(${NORMALIZADO}, 2) AS mensal_equivalente
         FROM dev_costs
        ORDER BY category ASC, name ASC`
    );

    // SUM primeiro, ROUND uma vez no fim — ver o cabeçalho. COALESCE cobre a tabela vazia:
    // sem custo nenhum o total é '0.00', não null (null viraria "R$ —" numa tela que deveria
    // dizer "R$ 0,00").
    const total = await pool.query(
      `SELECT COALESCE(ROUND(SUM(${NORMALIZADO}), 2), 0)::numeric(12,2) AS total_mensal FROM dev_costs`
    );

    const porCat = await pool.query(
      `SELECT category,
              COUNT(*)::int AS n,
              ROUND(SUM(${NORMALIZADO}), 2) AS total_mensal
         FROM dev_costs
        GROUP BY category
        ORDER BY category ASC`
    );

    return res.json({
      items: itens.rows,
      total_mensal: total.rows[0].total_mensal,
      por_categoria: porCat.rows,
    });
  } catch (e) {
    console.error('listCosts:', e);
    return res.status(500).json({ error: 'Erro ao listar os custos.' });
  }
};

export const createCost = async (req: AuthRequest, res: Response) => {
  try {
    const { name, category, value, cycle, status, next_billing, usage_note } = req.body ?? {};

    if (!textoValido(name, 200)) {
      return res.status(400).json({ error: "Campo 'name' obrigatório (até 200 caracteres)." });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Campo 'category' inválido: use 'infra', 'banco', 'ia', 'saas' ou 'outros'." });
    }
    if (!CYCLES.includes(cycle)) {
      return res.status(400).json({ error: "Campo 'cycle' inválido: use 'mensal', 'anual' ou 'variavel'." });
    }
    if (!valorValido(value)) {
      return res.status(400).json({ error: "Campo 'value' inválido: use um valor maior que zero com até 2 casas decimais." });
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: "Campo 'status' inválido: use 'ok' ou 'atencao'." });
    }
    if (next_billing !== undefined && next_billing !== null && (typeof next_billing !== 'string' || !dataValida(next_billing))) {
      return res.status(400).json({ error: "Campo 'next_billing' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    if (usage_note !== undefined && (typeof usage_note !== 'string' || usage_note.length > 2000)) {
      return res.status(400).json({ error: "Campo 'usage_note' inválido: até 2000 caracteres." });
    }

    const userId = req.user!.id;
    const { rows } = await pool.query(
      `INSERT INTO dev_costs (name, category, value, cycle, status, next_billing, usage_note, created_by)
       VALUES ($1, $2, $3::numeric, $4, COALESCE($5,'ok'), $6::date, COALESCE($7,''), $8)
       RETURNING id, name, category, value, cycle, status, next_billing, usage_note,
                 created_by, created_at, updated_at`,
      [String(name).trim(), category, String(value), cycle, status ?? null, next_billing ?? null, usage_note ?? null, userId]
    );

    await createLog(userId, 'CRIAR_CUSTO',
      { custo_id: rows[0].id, name: String(name).trim(), category, cycle, value: String(value) }, getClientIp(req));

    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error('createCost:', e);
    return res.status(500).json({ error: 'Erro ao criar o custo.' });
  }
};

export const updateCost = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

    const b = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    const alterados: string[] = [];

    if (b.name !== undefined) {
      if (!textoValido(b.name, 200)) return res.status(400).json({ error: "Campo 'name' obrigatório (até 200 caracteres)." });
      params.push(String(b.name).trim()); sets.push(`name = $${params.length}`); alterados.push('name');
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Campo 'category' inválido: use 'infra', 'banco', 'ia', 'saas' ou 'outros'." });
      params.push(b.category); sets.push(`category = $${params.length}`); alterados.push('category');
    }
    if (b.cycle !== undefined) {
      if (!CYCLES.includes(b.cycle)) return res.status(400).json({ error: "Campo 'cycle' inválido: use 'mensal', 'anual' ou 'variavel'." });
      params.push(b.cycle); sets.push(`cycle = $${params.length}`); alterados.push('cycle');
    }
    if (b.value !== undefined) {
      if (!valorValido(b.value)) return res.status(400).json({ error: "Campo 'value' inválido: use um valor maior que zero com até 2 casas decimais." });
      params.push(String(b.value)); sets.push(`value = $${params.length}::numeric`); alterados.push('value');
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "Campo 'status' inválido: use 'ok' ou 'atencao'." });
      params.push(b.status); sets.push(`status = $${params.length}`); alterados.push('status');
    }
    if (b.next_billing !== undefined) {
      if (b.next_billing !== null && (typeof b.next_billing !== 'string' || !dataValida(b.next_billing))) {
        return res.status(400).json({ error: "Campo 'next_billing' inválido: use uma data real no formato AAAA-MM-DD." });
      }
      params.push(b.next_billing); sets.push(`next_billing = $${params.length}::date`); alterados.push('next_billing');
    }
    if (b.usage_note !== undefined) {
      if (typeof b.usage_note !== 'string' || b.usage_note.length > 2000) {
        return res.status(400).json({ error: "Campo 'usage_note' inválido: até 2000 caracteres." });
      }
      params.push(b.usage_note); sets.push(`usage_note = $${params.length}`); alterados.push('usage_note');
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

    params.push(id);
    const { rows, rowCount } = await pool.query(
      `UPDATE dev_costs SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, name, category, value, cycle, status, next_billing, usage_note,
                  created_by, created_at, updated_at`,
      params
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Custo não encontrado.' });

    // `alterados` = NOMES dos campos, nunca os valores: o livro registra QUE o preço mudou,
    // sem virar um segundo lugar onde o dado sensível passa a morar.
    await createLog(req.user!.id, 'EDITAR_CUSTO', { custo_id: id, alterados }, getClientIp(req));
    return res.json(rows[0]);
  } catch (e) {
    console.error('updateCost:', e);
    return res.status(500).json({ error: 'Erro ao atualizar o custo.' });
  }
};

export const deleteCost = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
    const { rows, rowCount } = await pool.query(
      'DELETE FROM dev_costs WHERE id = $1 RETURNING name, category', [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Custo não encontrado.' });

    await createLog(req.user!.id, 'EXCLUIR_CUSTO',
      { custo_id: id, name: rows[0].name, category: rows[0].category }, getClientIp(req));
    return res.status(204).send();
  } catch (e) {
    console.error('deleteCost:', e);
    return res.status(500).json({ error: 'Erro ao excluir o custo.' });
  }
};
