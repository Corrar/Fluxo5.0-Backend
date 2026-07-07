// src/utils/concurrency.ts — Fluxo Royale 5.0
// Primitivas de concorrência: transição otimista por version e claim atômico de linha.
// Resolvem a corrida "um separa e marca ok, mas para o outro não atualizou e ele separa de novo".

import type { PoolClient } from 'pg';

export class ConflictError extends Error {
  readonly code = 'CONFLITO_CONCORRENCIA';
  constructor(message = 'Registro alterado por outro usuário. Recarregue e tente novamente.') {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Transição de status com concorrência otimista.
 * Só aplica se a `version` atual bater; incrementa `version`. rowCount 0 => alguém alterou antes
 * (o perdedor recebe ConflictError -> HTTP 409 -> o front recarrega o estado autoritativo).
 *
 * IMPORTANTE: as CHAVES de `set` são controladas por código (nunca entrada do usuário) —
 * são interpoladas no SQL; os VALORES vão parametrizados.
 */
export async function guardedTransition(
  client: PoolClient,
  table: 'separations' | 'requests',
  id: string,
  expectedVersion: number,
  set: Record<string, unknown>,
): Promise<number> {
  const cols = Object.keys(set);
  const vals = Object.values(set);
  const assignments = cols.map((col, i) => `${col} = $${i + 1}`);
  const idParam = `$${cols.length + 1}`;
  const verParam = `$${cols.length + 2}`;

  const sql =
    `UPDATE ${table} SET ${assignments.join(', ')}, version = version + 1 ` +
    `WHERE id = ${idParam} AND version = ${verParam} RETURNING version`;

  const { rows } = await client.query<{ version: number }>(sql, [...vals, id, expectedVersion]);
  if (rows.length === 0) throw new ConflictError();
  return rows[0].version;
}

/**
 * Claim atômico de uma linha de separação: garante que apenas UM operador a separa.
 * Retorna true se este usuário ficou com o item; false se já estava com outro.
 */
export async function claimPickLine(client: PoolClient, itemId: string, userId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE separation_items
        SET picked_by = $1, picked_at = now(), picked_status = 'separando'
      WHERE id = $2 AND picked_by IS NULL`,
    [userId, itemId],
  );
  return (rowCount ?? 0) > 0;
}

/** Conclui a separação de um item — exige que o item esteja reservado para este usuário. */
export async function markPicked(
  client: PoolClient,
  itemId: string,
  userId: string,
  status: 'ok' | 'falta',
): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE separation_items SET picked_status = $1
      WHERE id = $2 AND picked_by = $3 AND picked_status = 'separando'`,
    [status, itemId, userId],
  );
  if ((rowCount ?? 0) === 0) {
    throw new ConflictError('Este item não está reservado para você ou já foi finalizado.');
  }
}

/** Libera o claim de uma linha (ex.: operador desistiu) — devolve para a fila. */
export async function releasePickLine(client: PoolClient, itemId: string, userId: string): Promise<void> {
  await client.query(
    `UPDATE separation_items
        SET picked_by = NULL, picked_at = NULL, picked_status = 'pendente'
      WHERE id = $1 AND picked_by = $2 AND picked_status = 'separando'`,
    [itemId, userId],
  );
}
