// src/db.ts — Fluxo Royale 5.0
// Pool endurecido (Neon/serverless) + wrapper de query com retry para cold start +
// helper transacional com retry em falhas de serialização/deadlock.
// Mantém o export `pool` para não quebrar os imports existentes do 2.0.

import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ── Timeouts (via env, com defaults) ─────────────────────────────────────────
// connect: sobe p/ 20s dando margem ao WAKE do compute Neon (auto-suspend serverless).
// query/statement: 15s por tentativa — NÃO subimos pra 60s (isso troca "erro rápido"
// por "tela travada 1min"); em vez disso o RETRY abaixo cobre o cold start: a 1ª
// tentativa acorda o compute (e pode estourar), a 2ª já pega ele quente.
const CONNECT_TIMEOUT_MS   = Number(process.env.PG_CONNECT_TIMEOUT   ?? process.env.PG_CONNECT_TIMEOUT_MS   ?? 20_000);
const QUERY_TIMEOUT_MS     = Number(process.env.PG_QUERY_TIMEOUT     ?? process.env.PG_QUERY_TIMEOUT_MS     ?? 15_000);
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT ?? process.env.PG_STATEMENT_TIMEOUT_MS ?? QUERY_TIMEOUT_MS);
// Timeout CLIENT-side ESCALONADO por tentativa: a 1ª é curta (~6s) pra derrubar o cold start
// rápido e cair no retry; os retries usam o timeout cheio (15s). Isso baixa o pior caso
// realista de ~38s (3×15s) para ~22s (6s + backoff + 15s).
const QUERY_TIMEOUT_FIRST_MS = Number(process.env.PG_QUERY_TIMEOUT_FIRST ?? 6_000);

// ── Retry (via env, com defaults) ────────────────────────────────────────────
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.PG_RETRY_ATTEMPTS ?? 3)); // total de tentativas
// delay ANTES de cada retry (índice = retry nº - 1). Com 3 tentativas usa [500, 1500];
// o 4000 entra só se PG_RETRY_ATTEMPTS for elevado. Limita o pior caso de wall-clock.
const BACKOFF_MS = [500, 1500, 4000];

// Neon exige SSL em QUALQUER ambiente. Só desligue (PG_SSL=false) p/ Postgres local sem TLS.
const config: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },

  // Conexões: teto baixo (Neon limita) e morte rápida de zumbis.
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,

  // Timeouts agressivos: nenhuma query segura um lock indefinidamente.
  statement_timeout: STATEMENT_TIMEOUT_MS, // server-side (cancela no Postgres)
  query_timeout: QUERY_TIMEOUT_MS,         // client-side (node-pg) — retry cobre o cold start

  application_name: 'fluxo-royale-5',
};

export const pool = new Pool(config);

// Conexão ociosa derrubada pelo Neon não pode matar o processo.
pool.on('error', (err: Error) => {
  console.error('[pg] erro em cliente ocioso do pool:', err.message);
});

// ─────────────────────────────────────────────────────────────────────────────
// DISTINÇÃO TRANSITÓRIO × PERMANENTE  ← ponto de revisão
// ─────────────────────────────────────────────────────────────────────────────
// Regra de ouro: só retenta o que é falha de CONEXÃO/WAKE. Erro de SQL (sintaxe,
// constraint, tipo, permissão) SEMPRE carrega um SQLSTATE — e SQLSTATE fora do
// allowlist retorna false → NUNCA é retentado (senão o retry mascara bug real).

// SQLSTATEs transitórios de conexão/disponibilidade (classe 08 e 57).
const TRANSIENT_SQLSTATES = new Set<string>([
  '57P03', // cannot_connect_now — servidor ainda subindo (é o wake do compute Neon)
  '57P01', // admin_shutdown — conexão derrubada pelo servidor
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '53300', // too_many_connections — pico no cold start
]);

// Erros de socket (net do Node) — vêm com `code`, mas não são SQLSTATE.
const TRANSIENT_NET_CODES = new Set<string>([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

// Erros de CLIENTE do node-pg (timeout/terminação) NÃO têm code/SQLSTATE — casam por mensagem.
const TRANSIENT_MSG_FRAGMENTS = [
  'query read timeout',                      // node-pg query_timeout estourou  ← o nosso cold start
  'timeout exceeded when trying to connect', // node-pg connectionTimeout estourou
  'connection terminated',                   // 'Connection terminated' / '...unexpectedly'
  'server closed the connection unexpectedly',
];

export function isTransient(err: any): boolean {
  if (!err) return false;
  const code: string | undefined = err.code;
  if (code) {
    // COM code: decide APENAS pelo allowlist. unique_violation(23505), syntax(42601),
    // undefined_column(42703)... ficam de fora → permanentes → sem retry.
    return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NET_CODES.has(code);
  }
  // SEM code: erro de cliente/socket do node-pg (timeout/terminação). Allowlist por mensagem.
  const msg = String(err.message ?? '').toLowerCase();
  return TRANSIENT_MSG_FRAGMENTS.some((f) => msg.includes(f));
}

// Statement idempotente? Só leituras são auto-retentáveis. WITH fica de fora do auto
// (CTE pode ser writable: WITH x AS (INSERT/UPDATE/DELETE ...)). Para retentar uma
// leitura que começa com WITH, passe { retryable: true } explicitamente.
function isReadOnlyStatement(sql: string): boolean {
  const head = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // remove /* ... */
    .replace(/--[^\n]*/g, ' ')          // remove -- ...
    .trim()
    .toLowerCase();
  return /^(select|explain|show|table|values)\b/.test(head);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// jitter centrado no base: [0.5·base, 1.5·base) — evita thundering herd sem descolar do alvo.
const jitter = (base: number) => Math.round(base * (0.5 + Math.random()));

export interface QueryOpts {
  /** Força elegibilidade a retry (caller ASSUME idempotência). Default: auto (só leitura). */
  retryable?: boolean;
  /** Total de tentativas. Default: PG_RETRY_ATTEMPTS (3). */
  retries?: number;
}

// Timeout (client-side) desta tentativa: 1ª curta, retries no cheio.
function attemptTimeoutMs(attempt: number): number {
  return attempt === 1 ? QUERY_TIMEOUT_FIRST_MS : QUERY_TIMEOUT_MS;
}

// Executa UMA tentativa com timeout CLIENT-side próprio (Promise.race). Por que não
// `SET LOCAL statement_timeout`? statement_timeout é SERVER-side e só conta a EXECUÇÃO no
// compute quente — NÃO cobre o WAKE do cold start. O que estourava era o timer client-side
// do node-pg ("Query read timeout"). No timeout DESTRUÍMOS o client (não devolvemos sujo ao
// pool). Abandonar um SELECT em andamento é seguro: só retentamos LEITURAS idempotentes.
async function runAttempt<T extends QueryResultRow>(
  text: string,
  params: any[] | undefined,
  timeoutMs: number,
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const qp = client.query<T>(text, params);
    qp.catch(() => { /* evita unhandledRejection se o timer vencer a corrida */ });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Query read timeout')); // mesma msg → isTransient trata como transitório
      }, timeoutMs);
    });
    return await Promise.race([qp, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // timeout → o client pode estar ocupado com a query pendente → DESTRÓI (não devolve ao pool).
    client.release(timedOut ? new Error('client destruído: timeout de tentativa') : undefined);
  }
}

/**
 * Wrapper de query com retry para COLD START do Neon.
 * - Só retenta erro TRANSITÓRIO (ver isTransient) E statement idempotente (leitura ou retryable:true).
 * - Cada tentativa usa uma conexão nova do pool (conexão terminada não é reutilizável).
 * - Timeout ESCALONADO: 1ª tentativa curta (derruba cold start rápido), retries no cheio.
 * - Loga cada retry de forma estruturada (event: 'db_retry') e o sucesso pós-retry
 *   (event: 'db_retry_recovered') — a prova de que a defesa absorveu um cold start.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[],
  opts: QueryOpts = {},
): Promise<QueryResult<T>> {
  const attempts = Math.max(1, opts.retries ?? RETRY_ATTEMPTS);
  const eligible = opts.retryable ?? isReadOnlyStatement(text);

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await runAttempt<T>(text, params, attemptTimeoutMs(attempt));
      if (attempt > 1) {
        console.warn(JSON.stringify({ event: 'db_retry_recovered', attempt })); // cold start absorvido
      }
      return res;
    } catch (err: any) {
      const transient = isTransient(err);
      const canRetry = eligible && transient && attempt < attempts;
      if (!canRetry) {
        // permanente, não-idempotente, ou acabaram as tentativas → propaga (sem mascarar)
        if (transient && eligible && attempt > 1) {
          console.error(JSON.stringify({
            event: 'db_retry_exhausted', attempts: attempt,
            err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 200),
          }));
        }
        throw err;
      }
      const delay = jitter(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
      console.warn(JSON.stringify({
        event: 'db_retry', attempt, delay_ms: delay,
        err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 200),
      }));
      await sleep(delay);
    }
  }
}

/**
 * Warm-up no boot: acorda o compute Neon antes do 1º usuário chegar.
 * NÃO bloqueia o listen (chamar com `void warmup()`), NÃO derruba o boot se falhar.
 */
export async function warmup(): Promise<void> {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    console.log(JSON.stringify({ event: 'db_warmup_ok', ms: Date.now() - t0 }));
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: 'db_warmup_fail', ms: Date.now() - t0,
      err_code: err?.code ?? null, err_msg: String(err?.message ?? '').slice(0, 200),
    }));
  }
}

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
        const jitterMs = Math.random() * ceiling;
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
