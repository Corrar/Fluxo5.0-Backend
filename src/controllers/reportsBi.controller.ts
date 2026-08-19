// src/controllers/reportsBi.controller.ts — Relatórios BI v1 (Fase 3a).
//
// UMA rota para os CINCO blocos do painel. A decisão importa e não é economia de digitação:
// os cinco cards falam do MESMO período, e ter um `from`/`to` só, aplicado por um WHERE
// compartilhado, é o que garante que eles não discordem de janela. Duas rotas com dois
// recortes seriam a chance clássica de a tela mostrar "R$ 581 entrados" ao lado de
// "2 solicitações" medidos em semanas diferentes — e ninguém perceber.
//
// O BACKEND SÓ CONHECE INTERVALO. 'Este mês', 'Trimestre' e 'Ano' são AÇÚCAR DO FRONT sobre
// ?from=&to= — mesmo precedente do relatório de commits do dev-repos (018). Preset é decisão
// de tela; período é dado.
//
// ─── O QUE ESTE ENDPOINT NÃO FAZ, E POR QUÊ ──────────────────────────────────────────────────
// Não devolve sparkline nem delta percentual. Os dois exigem profundidade que o banco ainda não
// tem: série pede pontos ao longo do tempo, delta pede um período anterior comparável. Medido
// em 03/08/2026 na validação: `stock_ledger` tem 104 linhas em CINCO dias distintos. Inventar
// os pontos seria exatamente o número sem query atrás que a régua da casa proíbe. Quando houver
// meses, os dois voltam SOBRE ESTAS MESMAS QUERIES — nada aqui precisa ser refeito.
//
// Também não existem aqui: acurácia de inventário, lead time, giro, taxa de ruptura e tempo de
// recebimento. Não é escolha de escopo, é ausência de instrumentação — não há tabela que grave
// contagem física, nem ciclo fechado de solicitação, nem evento de ruptura. Viram missão própria.

import { Response } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middlewares/auth';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Preço unitário defensivo: o campo é texto em parte do histórico do schema, e '' quebraria a
// multiplicação. Mesmo COALESCE/NULLIF que o /reports/general já usa — consistência de leitura.
const PRECO = `COALESCE(CAST(NULLIF(CAST(p.unit_price AS TEXT), '') AS NUMERIC), 0)`;

export const getReportsBi = async (req: AuthRequest, res: Response) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');

    if (!dataValida(from)) {
      return res.status(400).json({ error: "Parâmetro 'from' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    if (!dataValida(to)) {
      return res.status(400).json({ error: "Parâmetro 'to' inválido: use uma data real no formato AAAA-MM-DD." });
    }
    if (from > to) {
      return res.status(400).json({ error: "Intervalo inválido: 'from' é posterior a 'to'." });
    }

    // `to` INCLUSIVO via "< dia seguinte": as colunas são TIMESTAMPTZ, e concatenar '23:59:59'
    // perderia o último segundo do dia. Mesmo idioma do relatório de commits.
    const P = [from, to];

    // ── 1 e 2. CAPITAL ENTRADO / SAÍDO ────────────────────────────────────────
    // A fonte é o RAZÃO (stock_ledger), não as telas: é ele que registra todo movimento com
    // carimbo. 'receive' é entrada de material; baixa efetiva é o `SAIDA` abaixo.
    // 'opening' fica DE FORA de propósito — é a carga inicial do saldo, não compra; contá-la
    // como capital entrado inflaria o número com estoque que nunca foi adquirido no período.
    //
    // ⚠ POR QUE A BAIXA NÃO É SÓ `kind='consume'` (Lote B, 19/08/2026).
    // A saída manual deixou de usar `StockService.consume` e passou a usar `reverseReceive` —
    // ela não pode soltar reserva alheia (ver a nota em stock.controller.manualWithdrawal e o
    // DIVIDAS.md). `reverseReceive` grava `kind='adjust'`, então a partir daquele lote TODA saída
    // manual sumiria destes dois números, em silêncio. Medido na branch de ensaio antes do push:
    // R$ 251,00 de R$ 25.002,93 (1,0% do KPI) — pequeno na foto, mas é a fatia que cresce, e cair
    // sem aviso é o pior jeito de um KPI errar.
    //
    // O discriminante é `ref_type`, não o `kind` sozinho: `adjust` + `separation` é a saída manual
    // e mais nada (medido: ZERO linhas com esse par antes do lote, então não há ambiguidade
    // histórica). Os outros `adjust` da casa carregam ref_type próprio — `stock_recount`
    // (recontagem), `stock_adjust` (ajuste manual de inventário), `travel`, `production_3d`.
    //
    // ⚠ NÃO trocar por `kind IN ('consume','adjust')`: isso passaria a contar recontagem de
    // inventário e ajuste manual como CAPITAL SAÍDO, inflando o KPI com correção de saldo — que
    // não é material saindo pela porta.
    const SAIDA = `(l.kind = 'consume' OR (l.kind = 'adjust' AND l.ref_type = 'separation'))`;
    const capital = await pool.query(
      `SELECT
         COALESCE(SUM(l.delta_on_hand * ${PRECO}) FILTER (WHERE l.kind = 'receive'), 0)::numeric(14,2)  AS entrado,
         COALESCE(SUM(ABS(l.delta_on_hand) * ${PRECO}) FILTER (WHERE ${SAIDA}), 0)::numeric(14,2)       AS saido,
         COUNT(*) FILTER (WHERE l.kind = 'receive')::int AS n_entradas,
         COUNT(*) FILTER (WHERE ${SAIDA})::int           AS n_saidas
       FROM stock_ledger l
       JOIN products p ON p.id = l.product_id
      WHERE l.created_at >= $1::date
        AND l.created_at <  ($2::date + interval '1 day')`,
      P
    );

    // ── 3. REPOSIÇÕES POR STATUS ──────────────────────────────────────────────
    const reposicoes = await pool.query(
      `SELECT status, COUNT(*)::int AS n
         FROM replenishments
        WHERE created_at >= $1::date
          AND created_at <  ($2::date + interval '1 day')
        GROUP BY status
        ORDER BY status`,
      P
    );

    // ── 4. SOLICITAÇÕES POR STATUS ────────────────────────────────────────────
    const solicitacoes = await pool.query(
      `SELECT status, COUNT(*)::int AS n
         FROM requests
        WHERE created_at >= $1::date
          AND created_at <  ($2::date + interval '1 day')
        GROUP BY status
        ORDER BY status`,
      P
    );

    // ── 5. CAPITAL DESTINADO POR SETOR ────────────────────────────────────────
    // Agregação SERVER-SIDE: o cliente jamais baixa item para somar. O setor mora na
    // solicitação (requests.sector); o valor sai do item × preço do produto.
    //
    // ENTREGUE, não PEDIDO — e a distinção é o coração do card. `quantity_requested` é
    // intenção; `quantity_delivered` é material que de fato saiu do estoque e chegou ao setor.
    // Somar o pedido chamaria de "capital destinado" coisa que ainda está no almoxarifado, e
    // um pedido recusado entraria na conta como se tivesse virado despesa.
    // COALESCE(...,0): item ainda não entregue tem delivered NULL e vale zero aqui — ausência
    // de entrega é zero de capital destinado, não linha faltando.
    const setores = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(r.sector), ''), 'Sem setor') AS setor,
              SUM(COALESCE(ri.quantity_delivered, 0) * ${PRECO})::numeric(14,2) AS valor,
              COUNT(DISTINCT r.id)::int AS n_solicitacoes
         FROM requests r
         JOIN request_items ri ON ri.request_id = r.id
         JOIN products p       ON p.id = ri.product_id
        WHERE r.created_at >= $1::date
          AND r.created_at <  ($2::date + interval '1 day')
        GROUP BY 1
        HAVING SUM(COALESCE(ri.quantity_delivered, 0)) > 0
        ORDER BY valor DESC`,
      P
    );

    // ── Profundidade REAL da série ────────────────────────────────────────────
    // MIN()/MAX() do razão inteiro (sem filtro de período): é o que permite a tela dizer
    // "há dado desde X" sem cravar data nenhuma. Vem NULL com a tabela vazia, e aí a tela
    // simplesmente não exibe a frase.
    const cobertura = await pool.query(
      `SELECT MIN(created_at)::date AS desde,
              MAX(created_at)::date AS ate,
              COUNT(DISTINCT created_at::date)::int AS dias_com_movimento
         FROM stock_ledger`
    );

    return res.json({
      periodo: { from, to },
      capital: capital.rows[0],
      reposicoes_por_status: reposicoes.rows,
      solicitacoes_por_status: solicitacoes.rows,
      capital_por_setor: setores.rows,
      cobertura: cobertura.rows[0],
    });
  } catch (e) {
    console.error('getReportsBi:', e);
    return res.status(500).json({ error: 'Erro ao montar o painel de relatórios.' });
  }
};
