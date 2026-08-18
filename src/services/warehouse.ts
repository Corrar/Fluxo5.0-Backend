// src/services/warehouse.ts — Fluxo Royale 5.0 (transição)
// Resolve o armazém de ORIGEM. Regra DESTA FASE: todos operam no ALMOX central com op_id = NULL
// (pooled) — comportamento idêntico ao 2.0 para o frontend atual.
//
// O armazém de DESTINO passa a existir aqui ao lado, em `resolveDestinationWarehouseId` — função
// NOVA e separada. `resolveWarehouseId` (origem) segue intocada: 23 chamadas em 9 arquivos
// dependem dela devolver ALMOX, e misturar as duas perguntas na mesma função quebraria todas.
//   origem  -> de ONDE o material sai   -> ALMOX (esta fase)
//   destino -> para ONDE o material vai  -> o armazém do setor, ou null (sem custódia)
// O de-para por `profiles.warehouse_id` (coluna da 005) continua sem uso: o destino sai do setor
// da SOLICITAÇÃO, não do cadastro de quem pede.

import type { QueryResult } from 'pg';
import { resolveDestinationWarehouse } from './setor';

let almoxIdCache: string | null = null;

/**
 * Executor de query — tipo ESTRUTURAL, satisfeito por `PoolClient` (dentro de transação) E por
 * `Pool` (o `pool` do db.ts, em GET fora de transação). Antes o parâmetro era `PoolClient`, o que
 * obrigava quem lê fora de TX a embutir `SELECT id FROM warehouses WHERE code='ALMOX'` na própria
 * query — duplicando a regra e furando o cache de processo abaixo.
 */
export interface WarehouseQueryable {
  query<R extends Record<string, any> = any>(text: string, params?: any[]): Promise<QueryResult<R>>;
}

/** Id do ALMOX central (semeado pela 004). Cacheado no processo. */
export async function getAlmoxId(client: WarehouseQueryable): Promise<string> {
  if (almoxIdCache) return almoxIdCache;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM warehouses WHERE code = 'ALMOX' LIMIT 1`,
  );
  if (rows.length === 0) {
    throw new Error('Armazém ALMOX não encontrado — a migration 004 precisa estar aplicada.');
  }
  almoxIdCache = rows[0].id;
  return almoxIdCache;
}

/**
 * Armazém de origem da operação. Nesta fase: SEMPRE o ALMOX (todos os profiles = ALMOX na 005).
 * O parâmetro userId é aceito para não quebrar as chamadas quando o de-para por setor entrar.
 */
export async function resolveWarehouseId(client: WarehouseQueryable, _userId?: string | null): Promise<string> {
  return getAlmoxId(client);
}

/** Nesta fase toda linha de estoque é pooled no ALMOX. */
export const POOLED_OP_ID: null = null;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ARMAZÉM DE DESTINO (setor -> armazém). Pergunta DIFERENTE da de cima.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cache de processo `code -> id`, no mesmo padrão do `almoxIdCache`: `warehouses` é tabela de
 * cadastro, lida a cada solicitação e escrita só por migration.
 *
 * SÓ resolução POSITIVA entra no cache. Se o code do mapa não existir em `warehouses`, o valor
 * NÃO é memorizado — do contrário, aplicar a migration que cria o armazém não teria efeito até
 * alguém reiniciar o processo, e o `console.error` (que é o sinal do bug de configuração) calaria
 * depois da primeira vez. Erro raro que repete a consulta é barato; erro que silencia, não.
 */
const destinoIdCache = new Map<string, string>();

/**
 * Traduz o SETOR de uma operação no uuid do armazém de destino.
 *
 * Devolve `null` em três situações, todas LEGÍTIMAS e nenhuma delas erro de operação:
 *   • setor ausente/vazio;
 *   • setor mapeado como "sem armazém" (consome na entrega — decisão de produto registrada);
 *   • setor fora do mapa (o `resolveDestinationWarehouse` já avisou no log).
 *
 * E devolve `null` também quando o mapa aponta para um `code` que não existe em `warehouses` —
 * aí sim é BUG DE CONFIGURAÇÃO, e vai como `console.error`. Ainda assim não lança: mapa errado
 * não é motivo para derrubar a solicitação de quem está no chão de fábrica. A régua do de-para é
 * a mesma em todos os ramos — **nunca falhar por setor**.
 */
export async function resolveDestinationWarehouseId(
  client: WarehouseQueryable,
  sector: string | null | undefined,
): Promise<string | null> {
  const { code } = resolveDestinationWarehouse(sector);
  if (code === null) return null;

  const emCache = destinoIdCache.get(code);
  if (emCache !== undefined) return emCache;

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
    [code],
  );
  if (rows.length === 0) {
    console.error(
      `[setor] MAPA APONTA PARA ARMAZÉM INEXISTENTE: code=${JSON.stringify(code)} (setor cru=${JSON.stringify(sector)}). ` +
      'Isto é bug de configuração — SETOR_ARMAZEM (src/services/setor.ts) e a tabela warehouses divergiram. ' +
      'A operação segue SEM armazém de destino.',
    );
    return null;
  }

  destinoIdCache.set(code, rows[0].id);
  return rows[0].id;
}
