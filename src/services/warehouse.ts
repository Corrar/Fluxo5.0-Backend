// src/services/warehouse.ts — Fluxo Royale 5.0 (transição)
// Resolve o armazém de ORIGEM. Regra DESTA FASE: todos operam no ALMOX central com op_id = NULL
// (pooled) — comportamento idêntico ao 2.0 para o frontend atual.
// O de-para por setor (profiles.warehouse_id, já criado na 005) será ativado numa fase posterior.

import type { QueryResult } from 'pg';

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
