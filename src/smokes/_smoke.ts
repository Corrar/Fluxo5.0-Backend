// src/smokes/_smoke.ts — utilitários dos smokes da peça 3 (devoluções de OP).
//
// COMO RODAM: cada smoke abre UMA transação, semeia um cenário isolado, chama as MESMAS funções do
// returns.service que o endpoint chama, faz as asserções lendo pelo MESMO client (enxerga o não
// commitado) e no fim faz ROLLBACK — não sobra nada no banco. Isso exercita o código de produção de
// verdade (não uma cópia da lógica) e ainda deixa o branch intacto.
//
// ⚠ Rodam contra o DATABASE_URL do .env. APONTE PRA UM BRANCH Neon antes de rodar (o rollback
// protege, mas rodar num branch é a disciplina da casa — ver o cabeçalho das migrations).

import type { PoolClient } from 'pg';
import { pool } from '../db';
import { getAlmoxId } from '../services/warehouse';

export function assert(cond: any, msg: string): void {
  if (!cond) throw new Error('ASSERT FALHOU: ' + msg);
}

// Comparação de dinheiro/decimal com tolerância (unit_price fracionário × numeric do Postgres).
export function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

// Roda um smoke dentro de uma tx que SEMPRE faz rollback. Sai com código 1 se qualquer assert falhar.
export async function runSmoke(name: string, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  console.log(`\n▶ ${name}`);
  let client: PoolClient | undefined;
  let ok = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await fn(client);
    ok = true;
  } catch (err: any) {
    console.error(`\n❌ ${name} FALHOU:`, err?.message ?? err);
  } finally {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignora */ }
      client.release();
    }
    await pool.end();
  }
  if (ok) console.log(`\n✅ ${name} PASSOU  (rollback aplicado — branch intacto)`);
  else process.exit(1);
}

// Um produto que já tem linha POOLED no ALMOX (op_id NULL) — a base do "grão fechado".
// pricedOnly: exige unit_price > 0 (pro smoke de total_cost, senão o abatimento seria 0×0).
export async function pickPooledProduct(
  client: PoolClient,
  opts: { pricedOnly?: boolean } = {},
): Promise<{ productId: string; onHand: number; reserved: number; unitPrice: number; warehouseId: string }> {
  const warehouseId = await getAlmoxId(client);
  const { rows } = await client.query(
    `SELECT s.product_id, s.quantity_on_hand, s.quantity_reserved, COALESCE(p.unit_price, 0) AS unit_price
       FROM stock s JOIN products p ON p.id = s.product_id
      WHERE s.warehouse_id = $1 AND s.op_id IS NULL AND p.active = true
        ${opts.pricedOnly ? 'AND p.unit_price > 0' : ''}
      ORDER BY s.quantity_on_hand DESC
      LIMIT 1`,
    [warehouseId],
  );
  assert(rows.length > 0, opts.pricedOnly
    ? 'nenhum produto com linha POOLED no ALMOX E unit_price > 0 pra rodar o smoke'
    : 'nenhum produto com linha POOLED no ALMOX pra rodar o smoke');
  return {
    productId: rows[0].product_id,
    onHand: num(rows[0].quantity_on_hand),
    reserved: num(rows[0].quantity_reserved),
    unitPrice: num(rows[0].unit_price),
    warehouseId,
  };
}

// Semeia um cenário isolado: cliente + OP + uma separação CONCLUÍDA com `withdrawnQty` do produto.
// (concluída pra o total_cost, que só soma 'concluida'. O ITEM é retornado pra ancorar o 'recebido'.)
export async function seedOp(
  client: PoolClient,
  productId: string,
  withdrawnQty: number,
  tag: string,
): Promise<{ clientId: string; opId: string; opCode: string; separationId: string; separationItemId: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cli = await client.query(`INSERT INTO clients (code, name) VALUES ($1, $2) RETURNING id`, [`SMK-${stamp}`, `SMOKE ${stamp}`]);
  const clientId = cli.rows[0].id;
  const opCode = `SMKOP-${stamp}`;
  const op = await client.query(
    `INSERT INTO client_services (client_id, op_code, description) VALUES ($1, $2, $3) RETURNING id`,
    [clientId, opCode, 'OP de smoke'],
  );
  const opId = op.rows[0].id;
  const sep = await client.query(
    `INSERT INTO separations (destination, status, type, client_service_id) VALUES ($1, 'concluida', 'manual', $2) RETURNING id`,
    ['SMOKE', opId],
  );
  const separationId = sep.rows[0].id;
  const item = await client.query(
    `INSERT INTO separation_items (separation_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING id`,
    [separationId, productId, withdrawnQty],
  );
  return { clientId, opId, opCode, separationId, separationItemId: item.rows[0].id };
}

// Cenário devolvível: seedOp + eventos per-OP (recebido/consumido) que formam o SALDO WIP.
//   saldo WIP = recebido − consumido  (é a fonte do disponível a devolver — reversão da decisão (a)).
//   recebido = 0  -> OP "sem rastro per-OP" (legada): saldo 0, nada devolvível.
export async function seedReturnable(
  client: PoolClient,
  productId: string,
  opts: { withdrawn: number; recebido: number; consumido?: number },
  tag: string,
  userId: string | null,
): Promise<{ clientId: string; opId: string; opCode: string; separationId: string; separationItemId: string; saldo: number }> {
  const base = await seedOp(client, productId, opts.withdrawn, tag);
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  if (opts.recebido > 0) {
    // 'recebido' exige ref_separation_id + ref_separation_item_id (CHECK ck_opmat_recebido_tem_origem).
    await client.query(
      `INSERT INTO op_material_events
         (event_type, client_service_id, product_id, qty, ref_separation_id, ref_separation_item_id, user_id, op_key)
       VALUES ('recebido', $1, $2, $3, $4, $5, $6, $7)`,
      [base.opId, productId, opts.recebido, base.separationId, base.separationItemId, userId, `smk:recv:${stamp}`],
    );
  }
  const consumido = opts.consumido ?? 0;
  if (consumido > 0) {
    await client.query(
      `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key)
       VALUES ('consumido', $1, $2, $3, $4, $5)`,
      [base.opId, productId, consumido, userId, `smk:cons:${stamp}`],
    );
  }
  return { ...base, saldo: opts.recebido - consumido };
}

// Um profile qualquer só pra satisfazer FKs de user_id (read-only). null se o branch não tiver.
export async function anyUserId(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query(`SELECT id FROM profiles LIMIT 1`);
  return rows.length ? rows[0].id : null;
}

// total_cost da OP — a MESMA fórmula do clients.controller (Σ saídas concluídas − Σ op_returns).
export async function totalCostOf(client: PoolClient, opId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT
        COALESCE((SELECT SUM(si.quantity * p.unit_price)
                    FROM separations sep
                    JOIN separation_items si ON sep.id = si.separation_id
                    JOIN products p ON si.product_id = p.id
                   WHERE sep.client_service_id = $1 AND sep.status = 'concluida'), 0)
        -
        COALESCE((SELECT SUM(r.quantity * p.unit_price)
                    FROM op_returns r
                    JOIN products p ON r.product_id = p.id
                   WHERE r.client_service_id = $1), 0) AS total_cost`,
    [opId],
  );
  return num(rows[0].total_cost);
}

// Nº de linhas em op_returns (o livro do conferido) da OP.
export async function opReturnsCount(client: PoolClient, opId: string): Promise<number> {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM op_returns WHERE client_service_id = $1`, [opId]);
  return rows[0].n;
}
