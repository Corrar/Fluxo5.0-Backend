// src/db.ts — Fluxo Royale 5.0
// Pool endurecido (Neon/serverless) + helper transacional com retry em falhas transitórias.
// Mantém o export `pool` para não quebrar os imports existentes do 2.0.

import { Pool, PoolClient, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Neon exige SSL em QUALQUER ambiente (dev, branch ou produção).
// Só desligue (PG_SSL=false) para um Postgres local sem TLS.
const config: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },

  // Conexões: teto baixo (Neon limita) e morte rápida de zumbis.
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,

  // Timeouts agressivos: nenhuma query pode segurar um lock indefinidamente.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? 15_000),

  application_name: 'fluxo-royale-5',
};

export const pool = new Pool(config);

// Conexão ociosa derrubada pelo Neon não pode matar o processo.
pool.on('error', (err: Error) => {
  console.error('[pg] erro em cliente ocioso do pool:', err.message);
});

type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

// serialization_failure (40001) e deadlock_detected (40P01) são seguros para repetir.
const TRANSIENT_CODES = new Set<string>(['40001', '40P01']);

export interface TxOptions {
  isolation?: IsolationLevel;
  retries?: number;
}

/**
 * Executa `fn` dentro de uma transação. Em falha transitória (serialização/deadlock),
 * refaz com backoff exponencial + full jitter. Garante COMMIT/ROLLBACK e release do client.
 *
 * Toda mutação de estoque/fluxo do 5.0 passa por aqui — assim várias operações
 * (reserva + escrita de negócio + razão) compartilham o mesmo client e commitam atômicas.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const isolation = opts.isolation ?? 'read committed';
  const maxRetries = opts.retries ?? 3;
  let attempt = 0;

  for (;;) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isolation !== 'read committed') {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignora falha de rollback */ }

      const code = (err as { code?: string } | null)?.code;
      if (code && TRANSIENT_CODES.has(code) && attempt < maxRetries) {
        attempt += 1;
        const ceiling = Math.min(2 ** attempt * 25, 500); // ms
        const jitter = Math.random() * ceiling;
        await new Promise((resolve) => setTimeout(resolve, jitter));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}