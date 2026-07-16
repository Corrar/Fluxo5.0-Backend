// src/services/stock.service.ts — Fluxo Royale 5.0 (grão (product_id, warehouse_id, op_id))
// Motor ÚNICO de estoque. Grão: (produto, armazém, op_id).
//   - ALMOX: op_id = NULL (pooled, reservável — só o ALMOX reserva).
//   - Setores: saldo amarrado à OP -> op_id NOT NULL.
// Toda alteração de saldo passa por aqui:
//   1) trava a linha exata do trio (FOR UPDATE), casando NULL via IS NOT DISTINCT FROM
//   2) valida o invariante DENTRO da trava
//   3) grava no razão imutável (stock_ledger) com op_id
//   4) idempotência por op_key
// transfer() move entre linhas (armazém, op): cobre entrega ALMOX->setor (fromReserved),
// rebalanceamento e REASSOCIAÇÃO de OP (mesmo armazém, op X->Y). Trava as duas linhas em
// ordem determinística (deadlock-safe).

import type { PoolClient } from 'pg';

export type StockMovementKind =
  | 'reserve' | 'release' | 'consume' | 'receive' | 'adjust' | 'transfer_out' | 'transfer_in';

export type StockErrorCode =
  | 'PRODUTO_SEM_ESTOQUE'
  | 'RESERVA_INSUFICIENTE'
  | 'FURO_ESTOQUE'
  | 'TRANSFERENCIA_INSUFICIENTE'
  | 'AJUSTE_ABAIXO_RESERVA'
  | 'ARMAZEM_INVALIDO'
  | 'QTD_INVALIDA'
  | 'SALDO_INSUFICIENTE_REVERSAO';

export class StockError extends Error {
  constructor(
    public readonly code: StockErrorCode,
    message: string,
    public readonly productId?: string,
    public readonly warehouseId?: string,
    public readonly opId?: string | null,
  ) {
    super(message);
    this.name = 'StockError';
  }
}

export interface StockRefs {
  refType?: string | null; // 'request' | 'separation' | 'transfer' | 'empenho' | 'entry' | 'sector_request' | ...
  refId?: string | null;
  userId?: string | null;
  reason?: string | null;
  opKey?: string | null;
  nfNumber?: string | null; // número da NF (entrada rastreável) -> gravado em stock_ledger.nf_number
}

export interface StockSnapshot {
  productId: string;
  warehouseId: string;
  opId: string | null;
  onHand: number;
  reserved: number;
  available: number;
}

interface StockRow {
  quantity_on_hand: string;
  quantity_reserved: string;
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

const assertQty = (qty: number, productId: string, warehouseId: string, opId: string | null): void => {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new StockError('QTD_INVALIDA', `Quantidade inválida (${qty}).`, productId, warehouseId, opId);
  }
};

const snapshot = (productId: string, warehouseId: string, opId: string | null, onHand: number, reserved: number): StockSnapshot =>
  ({ productId, warehouseId, opId, onHand, reserved, available: onHand - reserved });

// Trava a linha existente do trio (reserve/release/consume). Lança se não houver saldo.
async function lockExisting(client: PoolClient, productId: string, warehouseId: string, opId: string | null): Promise<{ onHand: number; reserved: number }> {
  const { rows } = await client.query<StockRow>(
    `SELECT quantity_on_hand, quantity_reserved FROM stock
      WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE`,
    [productId, warehouseId, opId],
  );
  if (rows.length === 0) {
    throw new StockError('PRODUTO_SEM_ESTOQUE', `Produto ${productId} sem saldo em (armazém ${warehouseId}, op ${opId ?? 'pooled'}).`, productId, warehouseId, opId);
  }
  return { onHand: num(rows[0].quantity_on_hand), reserved: num(rows[0].quantity_reserved) };
}

// Garante a linha (LAZY) e trava (receive/adjust/transfer-in).
async function ensureAndLock(client: PoolClient, productId: string, warehouseId: string, opId: string | null): Promise<{ onHand: number; reserved: number }> {
  await client.query(
    `INSERT INTO stock (product_id, warehouse_id, op_id, quantity_on_hand, quantity_reserved)
     VALUES ($1, $2, $3::uuid, 0, 0) ON CONFLICT DO NOTHING`,
    [productId, warehouseId, opId],
  );
  const { rows } = await client.query<StockRow>(
    `SELECT quantity_on_hand, quantity_reserved FROM stock
      WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE`,
    [productId, warehouseId, opId],
  );
  return { onHand: num(rows[0].quantity_on_hand), reserved: num(rows[0].quantity_reserved) };
}

async function alreadyApplied(client: PoolClient, opKey: string | null | undefined): Promise<boolean> {
  if (!opKey) return false;
  const { rowCount } = await client.query('SELECT 1 FROM stock_ledger WHERE op_key = $1', [opKey]);
  return (rowCount ?? 0) > 0;
}

async function persist(
  client: PoolClient,
  productId: string,
  warehouseId: string,
  opId: string | null,
  kind: StockMovementKind,
  next: { onHand: number; reserved: number },
  deltas: { dOnHand: number; dReserved: number },
  refs: StockRefs,
): Promise<StockSnapshot> {
  await client.query(
    `UPDATE stock SET quantity_on_hand = $1, quantity_reserved = $2
      WHERE product_id = $3 AND warehouse_id = $4 AND op_id IS NOT DISTINCT FROM $5::uuid`,
    [next.onHand, next.reserved, productId, warehouseId, opId],
  );
  await client.query(
    `INSERT INTO stock_ledger
       (product_id, warehouse_id, op_id, kind, delta_on_hand, delta_reserved, on_hand_after, reserved_after,
        op_key, ref_type, ref_id, user_id, reason, nf_number)
     VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      productId, warehouseId, opId, kind, deltas.dOnHand, deltas.dReserved, next.onHand, next.reserved,
      refs.opKey ?? null, refs.refType ?? null, refs.refId ?? null, refs.userId ?? null, refs.reason ?? null,
      refs.nfNumber ?? null,
    ],
  );
  return snapshot(productId, warehouseId, opId, next.onHand, next.reserved);
}

export const StockService = {
  /** Reserva (abertura/aprovação de solicitação). Só o ALMOX reserva -> opId tipicamente NULL. */
  async reserve(client: PoolClient, productId: string, warehouseId: string, opId: string | null, qty: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    assertQty(qty, productId, warehouseId, opId);
    if (await alreadyApplied(client, refs.opKey)) { const c = await lockExisting(client, productId, warehouseId, opId); return snapshot(productId, warehouseId, opId, c.onHand, c.reserved); }
    const cur = await lockExisting(client, productId, warehouseId, opId);
    const available = cur.onHand - cur.reserved;
    if (available < qty) throw new StockError('RESERVA_INSUFICIENTE', `Disponível insuficiente (${available} < ${qty}).`, productId, warehouseId, opId);
    return persist(client, productId, warehouseId, opId, 'reserve', { onHand: cur.onHand, reserved: cur.reserved + qty }, { dOnHand: 0, dReserved: qty }, refs);
  },

  /** Libera reserva (cancelamento/rejeição/edição). Nunca deixa reserva negativa. */
  async release(client: PoolClient, productId: string, warehouseId: string, opId: string | null, qty: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    assertQty(qty, productId, warehouseId, opId);
    if (await alreadyApplied(client, refs.opKey)) { const c = await lockExisting(client, productId, warehouseId, opId); return snapshot(productId, warehouseId, opId, c.onHand, c.reserved); }
    const cur = await lockExisting(client, productId, warehouseId, opId);
    const applied = Math.min(qty, cur.reserved);
    return persist(client, productId, warehouseId, opId, 'release', { onHand: cur.onHand, reserved: cur.reserved - applied }, { dOnHand: 0, dReserved: -applied }, refs);
  },

  /** Consome saldo físico (empenho a uma OP/máquina; ou saída final). Baixa on_hand e libera reserva correspondente. */
  async consume(client: PoolClient, productId: string, warehouseId: string, opId: string | null, qty: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    assertQty(qty, productId, warehouseId, opId);
    if (await alreadyApplied(client, refs.opKey)) { const c = await lockExisting(client, productId, warehouseId, opId); return snapshot(productId, warehouseId, opId, c.onHand, c.reserved); }
    const cur = await lockExisting(client, productId, warehouseId, opId);
    if (cur.onHand < qty) throw new StockError('FURO_ESTOQUE', `Saldo físico (${cur.onHand}) menor que a baixa (${qty}).`, productId, warehouseId, opId);
    const releaseQty = Math.min(qty, cur.reserved);
    return persist(client, productId, warehouseId, opId, 'consume', { onHand: cur.onHand - qty, reserved: cur.reserved - releaseQty }, { dOnHand: -qty, dReserved: -releaseQty }, refs);
  },

  /** Entrada física (NF-e no ALMOX, devolução, conclusão 3D, estorno de empenho). Cria a linha LAZY. */
  async receive(client: PoolClient, productId: string, warehouseId: string, opId: string | null, qty: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    assertQty(qty, productId, warehouseId, opId);
    if (await alreadyApplied(client, refs.opKey)) { const c = await ensureAndLock(client, productId, warehouseId, opId); return snapshot(productId, warehouseId, opId, c.onHand, c.reserved); }
    const cur = await ensureAndLock(client, productId, warehouseId, opId);
    return persist(client, productId, warehouseId, opId, 'receive', { onHand: cur.onHand + qty, reserved: cur.reserved }, { dOnHand: qty, dReserved: 0 }, refs);
  },

  /** Ajuste para valor ABSOLUTO de saldo físico (inventário). Delta calculado SOB TRAVA. */
  async adjust(client: PoolClient, productId: string, warehouseId: string, opId: string | null, newOnHand: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    if (!Number.isFinite(newOnHand) || newOnHand < 0) throw new StockError('QTD_INVALIDA', `Saldo alvo inválido (${newOnHand}).`, productId, warehouseId, opId);
    const cur = await ensureAndLock(client, productId, warehouseId, opId);
    if (newOnHand < cur.reserved) throw new StockError('AJUSTE_ABAIXO_RESERVA', `Saldo alvo (${newOnHand}) menor que o reservado (${cur.reserved}).`, productId, warehouseId, opId);
    return persist(client, productId, warehouseId, opId, 'adjust', { onHand: newOnHand, reserved: cur.reserved }, { dOnHand: newOnHand - cur.onHand, dReserved: 0 }, refs);
  },

  /**
   * Reverte uma ENTRADA física (o INVERSO de receive) — ex.: apagar um registro de Produção 3D.
   * Reduz SÓ quantity_on_hand; NUNCA toca quantity_reserved. Por isso NÃO é `consume`: consume
   * libera reserva (reserved -= min(qty, reserved)) e, num produto com reservas de OUTRAS
   * separações, "desproduzir" liberaria reserva alheia — furo. Aqui a reserva fica intacta.
   * Guard: on_hand - qty >= reserved (não se reverte o que já está reservado/consumido) -> senão
   * StockError('SALDO_INSUFICIENTE_REVERSAO'). Idempotente por op_key (content-addressed), FOR UPDATE
   * via ensureAndLock, entrada no razão. kind 'adjust' (o CHECK do stock_ledger não tem 'reverse';
   * é uma correção de saldo físico), com delta_on_hand negativo e delta_reserved 0.
   */
  async reverseReceive(client: PoolClient, productId: string, warehouseId: string, opId: string | null, qty: number, refs: StockRefs = {}): Promise<StockSnapshot> {
    assertQty(qty, productId, warehouseId, opId);
    if (await alreadyApplied(client, refs.opKey)) { const c = await ensureAndLock(client, productId, warehouseId, opId); return snapshot(productId, warehouseId, opId, c.onHand, c.reserved); }
    const cur = await ensureAndLock(client, productId, warehouseId, opId);
    if (cur.onHand - qty < cur.reserved) {
      throw new StockError('SALDO_INSUFICIENTE_REVERSAO', `Não é possível reverter ${qty}: disponível para reversão é ${cur.onHand - cur.reserved} (on_hand ${cur.onHand}, reservado ${cur.reserved} intocável).`, productId, warehouseId, opId);
    }
    return persist(client, productId, warehouseId, opId, 'adjust', { onHand: cur.onHand - qty, reserved: cur.reserved }, { dOnHand: -qty, dReserved: 0 }, refs);
  },

  /**
   * Transferência atômica entre LINHAS (armazém, op). Cobre:
   *  - entrega ALMOX(op NULL) -> setor(op X): use { fromReserved: true } (baixa físico do ALMOX e libera a reserva).
   *  - rebalanceamento livre entre armazéns (sem reserva): fromReserved omitido.
   *  - REASSOCIAÇÃO de OP no mesmo armazém (op X -> op Y): mesmo warehouse, ops diferentes; fromReserved omitido.
   * Trava as duas linhas em ordem determinística (deadlock-safe).
   */
  async transfer(
    client: PoolClient,
    productId: string,
    fromWarehouseId: string,
    fromOpId: string | null,
    toWarehouseId: string,
    toOpId: string | null,
    qty: number,
    refs: StockRefs = {},
    opts: { fromReserved?: boolean } = {},
  ): Promise<{ from: StockSnapshot; to: StockSnapshot }> {
    const sameLine = fromWarehouseId === toWarehouseId && (fromOpId ?? null) === (toOpId ?? null);
    if (sameLine) throw new StockError('ARMAZEM_INVALIDO', 'Origem e destino são a mesma linha (armazém+op).', productId, fromWarehouseId, fromOpId);
    assertQty(qty, productId, fromWarehouseId, fromOpId);

    const outKey = refs.opKey ? `${refs.opKey}:out` : null;
    const inKey = refs.opKey ? `${refs.opKey}:in` : null;
    if (await alreadyApplied(client, outKey)) {
      const f = await lockExisting(client, productId, fromWarehouseId, fromOpId);
      const t = await ensureAndLock(client, productId, toWarehouseId, toOpId);
      return { from: snapshot(productId, fromWarehouseId, fromOpId, f.onHand, f.reserved), to: snapshot(productId, toWarehouseId, toOpId, t.onHand, t.reserved) };
    }

    // Garante a linha de destino antes de travar (sem lock ainda).
    await client.query(
      `INSERT INTO stock (product_id, warehouse_id, op_id, quantity_on_hand, quantity_reserved)
       VALUES ($1, $2, $3::uuid, 0, 0) ON CONFLICT DO NOTHING`,
      [productId, toWarehouseId, toOpId],
    );

    // Trava as duas linhas em ordem determinística (por warehouse_id, depois op_id) -> deadlock-safe.
    const keys: Array<{ wh: string; op: string | null; role: 'from' | 'to' }> = [
      { wh: fromWarehouseId, op: fromOpId, role: 'from' },
      { wh: toWarehouseId, op: toOpId, role: 'to' },
    ];
    keys.sort((a, b) => {
      if (a.wh !== b.wh) return a.wh < b.wh ? -1 : 1;
      const ao = a.op ?? '';
      const bo = b.op ?? '';
      return ao < bo ? -1 : ao > bo ? 1 : 0;
    });

    const locked = new Map<'from' | 'to', { onHand: number; reserved: number }>();
    for (const k of keys) {
      const { rows } = await client.query<StockRow>(
        `SELECT quantity_on_hand, quantity_reserved FROM stock
          WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid
          FOR UPDATE`,
        [productId, k.wh, k.op],
      );
      if (rows.length === 0) {
        const msg = k.role === 'from' ? 'sem saldo na origem' : 'falha ao garantir o destino';
        throw new StockError('PRODUTO_SEM_ESTOQUE', `Produto ${productId} ${msg}.`, productId, k.wh, k.op);
      }
      locked.set(k.role, { onHand: num(rows[0].quantity_on_hand), reserved: num(rows[0].quantity_reserved) });
    }

    const from = locked.get('from')!;
    const to = locked.get('to')!;

    let originReservedDelta = 0;
    if (opts.fromReserved) {
      // Entrega: cumpre uma reserva (ALMOX->setor). Físico tem de existir; libera a reserva cumprida.
      if (from.onHand < qty) throw new StockError('FURO_ESTOQUE', `Saldo físico na origem (${from.onHand}) menor que a transferência (${qty}).`, productId, fromWarehouseId, fromOpId);
      originReservedDelta = -Math.min(qty, from.reserved);
    } else {
      // Rebalanceamento / reassociação: move apenas saldo LIVRE da origem.
      const availableOrigin = from.onHand - from.reserved;
      if (availableOrigin < qty) throw new StockError('TRANSFERENCIA_INSUFICIENTE', `Saldo livre na origem insuficiente (${availableOrigin} < ${qty}).`, productId, fromWarehouseId, fromOpId);
    }

    const fromSnap = await persist(client, productId, fromWarehouseId, fromOpId, 'transfer_out', { onHand: from.onHand - qty, reserved: from.reserved + originReservedDelta }, { dOnHand: -qty, dReserved: originReservedDelta }, { ...refs, opKey: outKey, refType: refs.refType ?? 'transfer' });
    const toSnap = await persist(client, productId, toWarehouseId, toOpId, 'transfer_in', { onHand: to.onHand + qty, reserved: to.reserved }, { dOnHand: qty, dReserved: 0 }, { ...refs, opKey: inKey, refType: refs.refType ?? 'transfer' });
    return { from: fromSnap, to: toSnap };
  },

  /** Leitura do saldo de uma linha exata (sem trava). */
  async read(client: PoolClient, productId: string, warehouseId: string, opId: string | null): Promise<StockSnapshot | null> {
    const { rows } = await client.query<StockRow>(
      `SELECT quantity_on_hand, quantity_reserved FROM stock
        WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid`,
      [productId, warehouseId, opId],
    );
    if (rows.length === 0) return null;
    return snapshot(productId, warehouseId, opId, num(rows[0].quantity_on_hand), num(rows[0].quantity_reserved));
  },

  /** Saldo do produto em TODAS as linhas (armazém×op) — visão consolidada. */
  async readAll(client: PoolClient, productId: string): Promise<StockSnapshot[]> {
    const { rows } = await client.query<{ warehouse_id: string; op_id: string | null } & StockRow>(
      `SELECT warehouse_id, op_id, quantity_on_hand, quantity_reserved FROM stock
        WHERE product_id = $1 ORDER BY warehouse_id, op_id NULLS FIRST`,
      [productId],
    );
    return rows.map((r) => snapshot(productId, String(r.warehouse_id), r.op_id ?? null, num(r.quantity_on_hand), num(r.quantity_reserved)));
  },
};
