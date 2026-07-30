// src/controllers/dev-dashboard.controller.ts — dev-painel v1 (a última tela do módulo Dev).
//
// RÉGUA DO BRUNO (inegociável, e é o desenho inteiro deste arquivo): NENHUM número no painel
// sem SQL demonstrável. O mock era ~90% teatro — "31 resolvidos", "1,8 d", BarChart Seg–Sex
// chumbado, badge "+15% vs. anterior" e um `prog`% de chamado que NUNCA existiu no banco.
// Tudo isso morreu. Aqui só entra agregado que sai de tickets (012) ou dev_projects (013).
//
// DECISÕES TRAVADAS (Bruno, 30/07/2026):
//   - LEITURA PURA: nenhuma escrita, nenhum DDL novo (migration 015 só faz nascer a page_key).
//   - Chave PRÓPRIA 'dev_dashboard' no router inteiro: o painel cruza DOIS domínios; gatear
//     por 'chamados' entregaria projetos a quem só atende fila (ver cabeçalho da 015).
//   - CHAMADA ÚNICA: o painel não faz 5 GETs. Todos os agregados saem daqui num envelope só,
//     com as queries em Promise.all (paralelas, cada uma no wrapper de retry do db.ts).
//   - SEM AUDITORIA DE LEITURA: logar GET de dashboard encheria o livro de ruído e afogaria as
//     actions que importam (a tela Auditoria é o livro; este é um retrovisor agregado).
//   - SEM SOCKET: mesma razão do dev-projetos — ferramenta de uma pessoa hoje; refetch no
//     mount + botão Atualizar na tela resolvem.
//   - audit_logs NUNCA é fonte de métrica: o livro guarda o histórico dos smokes (os tickets
//     foram apagados pelos cleanups cirúrgicos e as actions ficaram) — contaria TESTE como
//     trabalho. Métrica sai só das tabelas vivas.
//   - N=0 devolve zero/null CRU, jamais placeholder: a tela mostra "—" e a frase honesta.
//
// DUAS ARMADILHAS QUE O SQL DESARMA DE PROPÓSITO:
//   1. `cancelado` TAMBÉM preenche closed_at (a máquina de estados fecha os dois finais). A
//      média de resolução filtra status='concluido' EXPLICITAMENTE — sem isso, cancelamentos
//      (quase instantâneos) puxariam a média pra baixo e o painel mentiria bonito.
//   2. FUSO: o dia da série de 7 dias é fechado em America/Sao_Paulo, não em UTC (é a dívida
//      de UTC da Auditoria reaparecendo na borda do dia — em UTC, tudo que acontece depois
//      das 21h locais cairia no dia seguinte). O "hoje" de referência vem do RELÓGIO DO
//      POSTGRES (não do Node): assim os 7 slots do controller e o GROUP BY do banco não podem
//      discordar se o processo estiver noutro fuso.

import { Request, Response } from 'express';
import { query as dbQuery } from '../db';

// Fuso de fechamento do dia. Constante (não é config): o time é um só, no Brasil.
const TZ = 'America/Sao_Paulo';
// A FILA = o que está vivo. concluido/cancelado ficam FORA (é o bug que o mock cometia ao
// contar "abertos" como status !== 'concluido' — cancelado entrava como aberto).
const VIVOS = ['aberto', 'em_analise', 'em_desenvolvimento'];
// Quantos projetos recentes o painel mostra (o resto é a tela Projetos).
const RECENTES_LIMIT = 5;
const DIAS_SERIE = 7;

const SQL_FILA = `
  SELECT
    count(*) FILTER (WHERE status = 'aberto')::int                       AS abertos,
    count(*) FILTER (WHERE status = 'em_analise')::int                   AS em_analise,
    count(*) FILTER (WHERE status = 'em_desenvolvimento')::int           AS em_desenvolvimento,
    count(*) FILTER (WHERE status = ANY($1::text[]))::int                AS fila_total,
    -- "ninguém pegou": o número mais acionável pra um time de uma pessoa.
    count(*) FILTER (WHERE status = ANY($1::text[]) AND assignee_id IS NULL)::int AS sem_atendente,
    -- idade do mais velho AINDA VIVO (dias inteiros; 0 = entrou hoje). NULL com fila vazia.
    EXTRACT(DAY FROM (now() - min(created_at) FILTER (WHERE status = ANY($1::text[]))))::int AS mais_antigo_dias
  FROM tickets`;

const SQL_PRIORIDADE = `
  SELECT
    count(*) FILTER (WHERE priority = 'alta')::int  AS alta,
    count(*) FILTER (WHERE priority = 'media')::int AS media,
    count(*) FILTER (WHERE priority = 'baixa')::int AS baixa
  FROM tickets
  WHERE status = ANY($1::text[])`;

// Janela de 30 dias (e não "mês corrente": no dia 1º o número zeraria sem nada ter mudado).
// SÓ concluido — ver armadilha 1 no cabeçalho.
const SQL_RESOLUCAO = `
  SELECT count(*)::int AS n,
         ROUND((AVG(EXTRACT(EPOCH FROM (closed_at - created_at))) / 3600)::numeric, 1)::float8 AS media_horas
  FROM tickets
  WHERE status = 'concluido'
    AND closed_at IS NOT NULL
    AND closed_at >= now() - interval '30 days'`;

// Série de 7 dias: predicado de RANGE em created_at/closed_at (usa idx_tickets_status_created
// e não escapa pra função sobre a coluna), agrupando pelo dia JÁ convertido pro fuso local.
// O dia sai como TEXTO YYYY-MM-DD pra casar exato com os slots montados no controller.
const SQL_ABERTOS_DIA = `
  SELECT to_char((created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n
  FROM tickets
  WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) - ($2::int - 1) * interval '1 day') AT TIME ZONE $1
  GROUP BY 1`;

const SQL_CONCLUIDOS_DIA = `
  SELECT to_char((closed_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n
  FROM tickets
  WHERE status = 'concluido'
    AND closed_at >= (date_trunc('day', now() AT TIME ZONE $1) - ($2::int - 1) * interval '1 day') AT TIME ZONE $1
  GROUP BY 1`;

const SQL_PROJETOS = `
  SELECT count(*) FILTER (WHERE status = 'ativo')::int     AS ativos,
         count(*) FILTER (WHERE status = 'arquivado')::int  AS arquivados
  FROM dev_projects`;

// Progresso DERIVADO do jsonb (done/total), nunca coluna — mesma regra da grade de Projetos.
// LATERAL desdobra checklists → itens; projeto sem checklist devolve 0/0 (a tela diz
// "sem checklist" em vez de desenhar uma barra vazia que pareceria 0% de trabalho feito).
const SQL_PROJETOS_RECENTES = `
  SELECT p.id, p.name, p.color, p.priority, p.updated_at,
         COALESCE(x.itens_total, 0)::int AS itens_total,
         COALESCE(x.itens_done, 0)::int  AS itens_done
  FROM dev_projects p
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS itens_total,
           count(*) FILTER (WHERE i->'done' = 'true'::jsonb)::int AS itens_done
    FROM jsonb_array_elements(p.checklists) c,
         jsonb_array_elements(c->'itens') i
  ) x ON TRUE
  WHERE p.status = 'ativo'
  ORDER BY p.updated_at DESC
  LIMIT $1`;

// "Hoje" pelo relógio do BANCO (ver armadilha 2): a régua dos slots é a mesma do GROUP BY.
const SQL_HOJE = `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS hoje`;

// Monta os DIAS_SERIE slots terminando em `hoje` (YYYY-MM-DD), sempre presentes — dia sem
// movimento aparece com zero. Aritmética em UTC puro sobre a data-texto: sem Date local, sem
// horário de verão no meio (a conversão de fuso já foi feita no banco).
interface SlotDia { dia: string; abertos: number; concluidos: number }

function montarSlots(hoje: string, mapaAbertos: Map<string, number>, mapaConcluidos: Map<string, number>): SlotDia[] {
  const base = Date.parse(`${hoje}T00:00:00Z`);
  const slots: SlotDia[] = [];
  for (let i = DIAS_SERIE - 1; i >= 0; i--) {
    const dia = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    slots.push({ dia, abertos: mapaAbertos.get(dia) ?? 0, concluidos: mapaConcluidos.get(dia) ?? 0 });
  }
  return slots;
}

const paraMapa = (rows: any[]): Map<string, number> =>
  new Map(rows.map((r) => [String(r.dia), Number(r.n)]));

// ── GET /dev-dashboard — o painel inteiro numa chamada ──
export const getDevDashboard = async (_req: Request, res: Response) => {
  try {
    const [fila, prioridade, resolucao, abertosDia, concluidosDia, projetos, recentes, hojeRow] =
      await Promise.all([
        dbQuery(SQL_FILA, [VIVOS]),
        dbQuery(SQL_PRIORIDADE, [VIVOS]),
        dbQuery(SQL_RESOLUCAO),
        dbQuery(SQL_ABERTOS_DIA, [TZ, DIAS_SERIE]),
        dbQuery(SQL_CONCLUIDOS_DIA, [TZ, DIAS_SERIE]),
        dbQuery(SQL_PROJETOS),
        dbQuery(SQL_PROJETOS_RECENTES, [RECENTES_LIMIT]),
        dbQuery(SQL_HOJE, [TZ]),
      ]);

    const f = fila.rows[0];
    const r = resolucao.rows[0];

    res.json({
      fila: {
        abertos: f.abertos,
        em_analise: f.em_analise,
        em_desenvolvimento: f.em_desenvolvimento,
        fila_total: f.fila_total,
        sem_atendente: f.sem_atendente,
        // null com fila vazia — a tela mostra "—", nunca 0 (que sugeriria "entrou hoje").
        mais_antigo_dias: f.mais_antigo_dias === null ? null : Number(f.mais_antigo_dias),
      },
      prioridade_fila: {
        alta: prioridade.rows[0].alta,
        media: prioridade.rows[0].media,
        baixa: prioridade.rows[0].baixa,
      },
      resolucao_30d: {
        n: r.n,
        media_horas: r.media_horas === null ? null : Number(r.media_horas),
      },
      sete_dias: montarSlots(hojeRow.rows[0].hoje, paraMapa(abertosDia.rows), paraMapa(concluidosDia.rows)),
      projetos: {
        ativos: projetos.rows[0].ativos,
        arquivados: projetos.rows[0].arquivados,
        recentes: recentes.rows,
      },
      gerado_em: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('getDevDashboard:', error?.message ?? error);
    res.status(500).json({ error: 'Erro ao montar o painel.' });
  }
};
