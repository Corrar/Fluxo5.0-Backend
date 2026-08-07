// src/scripts/release-orfas-3d.ts — Fluxo Royale 5.0 (lote I-a)
//
// LIBERA AS 10 UNIDADES ÓRFÃS DE RESERVA 3D medidas na validação pelo recon (d).
//
// ── O QUE SÃO AS ÓRFÃS ───────────────────────────────────────────────────────────────────────
// Quatro solicitações REJEITADAS cujos itens 3D seguram reserva no pooled do ALMOX sem caminho
// nenhum de liberação: a rejeição pulava o item 3D (guard `!is_3d`, agora derrubado), e a
// solicitação é terminal — nenhuma tela vai tocá-la de novo. São 10 unidades em 3 SKUs:
//
//   ed06c220…  3D-0003  7 un   rejeitada 06/08 10:49
//   fc69ac6c…  3D-0001  1 un   rejeitada 06/08 13:32
//   f4cc5811…  3D-0003  1 un   rejeitada 06/08 14:04
//   b80d14c6…  3D-0008  1 un   rejeitada 07/08 10:22   (esta perdeu 4 no ajuste da conferência e
//                                                        ficou com 1 — ver `adjrelease:1` no razão)
//
// O código do lote I-a impede órfãs NOVAS. Ele não conserta as velhas: as quatro solicitações já
// estão em 'rejeitado', e nenhum endpoint aceita transição a partir de terminal. Daí este script.
//
// ── POR QUE HARDCODE, E NÃO UMA VARREDURA ────────────────────────────────────────────────────
// Uma varredura ("libere toda reserva de item 3D em solicitação terminal") é um script que decide
// sozinho o que apagar, e roda contra um banco que ninguém revisou naquele instante. Estas quatro
// linhas foram MEDIDAS, conferidas contra o razão e contra o saldo, e revisadas. O script executa
// a lista que foi revisada — nada além. Se aparecer uma quinta órfã, ela é outra decisão, com
// outra medição, e este arquivo muda no commit que a inclui.
//
// As op_keys `request:<id>:item:<item_id>:release` das quatro estão LIVRES no razão (medido: os
// itens 3D só têm `:reserve` e, no caso b80d14c6, `:adjrelease:1`). Usá-las é o que torna este
// script idempotente E consistente com as três portas do fluxo: se alguém um dia reabrir e
// rejeitar a mesma solicitação, o motor deduplica em vez de liberar duas vezes.
//
// ── COMO RODA ────────────────────────────────────────────────────────────────────────────────
//   DRY-RUN (padrão, ZERO escrita):
//     FR_EXPECT_DB_HOST=fr_efemero DATABASE_URL=... npx ts-node src/scripts/release-orfas-3d.ts
//   EXECUÇÃO (exige confirmação interativa digitando o host):
//     FR_EXPECT_DB_HOST=ep-summer-wave npx ts-node src/scripts/release-orfas-3d.ts --execute
//
// ⚠ A EXECUÇÃO NO STAGING TEM GO SEPARADO DO BRUNO. Este lote roda só o dry-run.

import dotenv from 'dotenv';
dotenv.config();

import readline from 'readline';
import { pool, withTransaction } from '../db';
import { StockService } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

const HOST_PROIBIDO = 'ep-mute-feather';

// A lista REVISADA. sku e qty são a premissa: se o banco discordar de qualquer um dos dois, a
// órfã é PULADA (nunca "ajustada") — divergência aqui significa que o mundo mudou desde a medição.
const ORFAS = [
  { requestId: 'ed06c220-1bb7-4358-91e5-fa6f565663f0', itemId: 'f0b3e36a-6093-4125-90ac-7407dc5daf3a', sku: '3D-0003', qty: 7 },
  { requestId: 'fc69ac6c-95a2-4872-afe9-32b25c96b77b', itemId: 'e658cacb-4457-49b4-ae96-1f93e564cd87', sku: '3D-0001', qty: 1 },
  { requestId: 'f4cc5811-ba15-4238-9225-c09127bd728c', itemId: 'ecb3ab33-3b5a-451d-9b47-b936490aa22e', sku: '3D-0003', qty: 1 },
  { requestId: 'b80d14c6-dac4-42c7-a24e-edcb467de27b', itemId: '1dd1faf6-b0d5-4364-9d56-8fcaf4dba35e', sku: '3D-0008', qty: 1 },
] as const;

const opKeyDe = (o: { requestId: string; itemId: string }) => `request:${o.requestId}:item:${o.itemId}:release`;
const num = (v: any): number => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0; };

// Host SEM credencial (mesma função do db.ts — nunca imprimir a URL crua, ela carrega senha).
const hostDaUrl = (url: string): string =>
  (url.includes('@') ? url.replace(/^.*@/, '').replace(/[/?].*$/, '') : '') || '(host não extraído)';

interface Plano {
  ok: boolean;
  motivo: string;
  productId: string | null;
  reservedNoSaldo: number;
  presoNoRazao: number;
  qtyReservedColuna: number;
}

/** As DUAS CAMADAS de guard, na ordem: a declaração (env) e o banco (o que ele diz de si). */
async function guards(execute: boolean): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';

  // Camada 0 — lista negra (a mesma do db.ts, repetida aqui porque este script escreve saldo).
  if (url.includes(HOST_PROIBIDO)) {
    throw new Error(`RECUSADO — DATABASE_URL aponta para a produção 2.0 (${HOST_PROIBIDO}). host: ${hostDaUrl(url)}`);
  }

  // Camada 1 — DECLARAÇÃO OBRIGATÓRIA. No db.ts a variável é opt-in; aqui não: um script que
  // libera reserva não pode rodar contra "o banco que estivesse no .env". Quem roda declara.
  const esperado = (process.env.FR_EXPECT_DB_HOST ?? '').trim();
  if (!esperado) {
    throw new Error(
      'RECUSADO — FR_EXPECT_DB_HOST é OBRIGATÓRIA neste script.\n' +
      '   Declare o banco alvo antes de agir:  FR_EXPECT_DB_HOST=fr_efemero  (ou ep-summer-wave)',
    );
  }
  if (!url.includes(esperado)) {
    throw new Error(`RECUSADO — declarado "${esperado}", recebido host "${hostDaUrl(url)}".`);
  }

  // Camada 2 — O BANCO CONFIRMA. A env fala da URL; esta pergunta ao servidor quem ele é. As duas
  // juntas cobrem o caso da URL "certa" apontando para um banco restaurado/renomeado.
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const db = rows[0]?.db ?? '';
  console.log(`  camada 1 (FR_EXPECT_DB_HOST): "${esperado}" ✓`);
  console.log(`  camada 2 (current_database): "${db}"`);
  if (!esperado.includes(db) && !db.includes(esperado) && !hostDaUrl(url).includes(esperado)) {
    throw new Error(`RECUSADO — current_database() = "${db}" não confere com a declaração "${esperado}".`);
  }
  if (execute) console.log('  modo: EXECUÇÃO (vai escrever)');
  else console.log('  modo: DRY-RUN (nenhuma escrita)');
}

/** Verifica UMA órfã contra o banco. Não escreve nada. */
async function planejar(o: typeof ORFAS[number]): Promise<Plano> {
  const base: Plano = { ok: false, motivo: '', productId: null, reservedNoSaldo: 0, presoNoRazao: 0, qtyReservedColuna: 0 };

  const { rows } = await pool.query(
    `SELECT ri.product_id, ri.qty_reserved, p.sku, p.is_3d, r.status AS req_status,
            COALESCE((SELECT SUM(l.delta_reserved) FROM stock_ledger l
                       WHERE l.op_key LIKE 'request:' || ri.request_id || ':item:' || ri.id || ':%'), 0) AS preso,
            (SELECT count(*)::int FROM stock_ledger l WHERE l.op_key = $2) AS ja_liberada
       FROM request_items ri
       JOIN requests r ON r.id = ri.request_id
       LEFT JOIN products p ON p.id = ri.product_id
      WHERE ri.id = $1 AND ri.request_id = $3`,
    [o.itemId, opKeyDe(o), o.requestId],
  );

  if (rows.length === 0) return { ...base, motivo: 'item não encontrado (ou não pertence à solicitação)' };
  const r = rows[0];
  const plano: Plano = {
    ...base,
    productId: r.product_id,
    presoNoRazao: num(r.preso),
    qtyReservedColuna: num(r.qty_reserved),
  };

  if (r.sku !== o.sku) return { ...plano, motivo: `SKU divergente: banco diz ${r.sku}, lista diz ${o.sku}` };
  if (r.is_3d !== true) return { ...plano, motivo: 'produto não é is_3d' };
  if (r.req_status !== 'rejeitado') return { ...plano, motivo: `solicitação em "${r.req_status}" (esperado rejeitado)` };
  if (r.ja_liberada > 0) return { ...plano, motivo: 'op_key de release JÁ existe no razão — já foi liberada' };
  if (plano.presoNoRazao !== o.qty) return { ...plano, motivo: `preso no razão é ${plano.presoNoRazao}, lista diz ${o.qty}` };

  const snap = await pool.query(
    `SELECT s.quantity_reserved FROM stock s
      WHERE s.product_id = $1 AND s.op_id IS NULL AND s.warehouse_id = (SELECT id FROM warehouses WHERE code='ALMOX')`,
    [r.product_id],
  );
  plano.reservedNoSaldo = num(snap.rows[0]?.quantity_reserved);
  if (plano.reservedNoSaldo < o.qty) {
    return { ...plano, motivo: `saldo reservado (${plano.reservedNoSaldo}) menor que a liberação (${o.qty})` };
  }

  return { ...plano, ok: true, motivo: 'pronta' };
}

/** Confirmação interativa: digitar o host. Só no --execute. */
function confirmar(esperado: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n  Digite o host de destino para confirmar a ESCRITA ("${esperado}"): `, (resp) => {
      rl.close();
      resolve(resp.trim() === esperado);
    });
  });
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  console.log('\n▶ release-orfas-3d — liberação das reservas 3D órfãs (recon (d))\n');

  await guards(execute);

  console.log('\n── PLANO ─────────────────────────────────────────────────────────────');
  const planos: Array<{ o: typeof ORFAS[number]; p: Plano }> = [];
  for (const o of ORFAS) {
    const p = await planejar(o);
    planos.push({ o, p });
    const marca = p.ok ? '✓' : '✗';
    console.log(
      `  ${marca} ${o.sku}  ${o.qty} un   request ${o.requestId.slice(0, 8)}…  item ${o.itemId.slice(0, 8)}…\n` +
      `      op_key: ${opKeyDe(o)}\n` +
      `      razão: ${p.presoNoRazao} preso · saldo reservado: ${p.reservedNoSaldo} · coluna qty_reserved: ${p.qtyReservedColuna} · ${p.motivo}`,
    );
  }

  const aplicaveis = planos.filter((x) => x.p.ok);
  const total = aplicaveis.reduce((s, x) => s + x.o.qty, 0);
  console.log(`\n  ${aplicaveis.length}/${ORFAS.length} órfã(s) aplicável(is) — ${total} unidade(s) a liberar.`);

  if (!execute) {
    console.log('\n  DRY-RUN: nada foi escrito. Para executar: --execute (exige confirmação digitando o host).\n');
    return;
  }

  if (aplicaveis.length === 0) {
    console.log('\n  Nada a fazer.\n');
    return;
  }

  const ok = await confirmar((process.env.FR_EXPECT_DB_HOST ?? '').trim());
  if (!ok) {
    console.log('\n  ABORTADO — confirmação não conferiu. Nada foi escrito.\n');
    process.exitCode = 1;
    return;
  }

  // UMA transação para as quatro: ou o saldo fica todo certo, ou nada muda.
  await withTransaction(async (client) => {
    const warehouseId = await resolveWarehouseId(client, null);
    for (const { o, p } of aplicaveis) {
      await StockService.release(client, p.productId as string, warehouseId, POOLED_OP_ID, o.qty, {
        refType: 'request', refId: o.requestId, userId: null,
        opKey: opKeyDe(o),
        reason: 'Correção lote I-a: libera reserva 3D órfã de solicitação rejeitada',
      });
      // A coluna já é 0 nestes itens (o backfill da 020 não toca terminais) — o UPDATE existe para
      // o caso de alguém tê-la preenchido à mão entre a migration e este script.
      await client.query('UPDATE request_items SET qty_reserved = 0 WHERE id = $1', [o.itemId]);
      console.log(`  ✔ liberado: ${o.sku} ${o.qty} un (${opKeyDe(o)})`);
    }
  });

  console.log(`\n  ✅ ${aplicaveis.length} liberação(ões) aplicada(s), ${total} unidade(s).\n`);
}

main()
  .catch((err) => {
    console.error(`\n🛑 ${err?.message ?? err}\n`);
    process.exitCode = 78;
  })
  .finally(async () => { await pool.end(); });
