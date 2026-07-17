// smoke_returns_perop_source.ts — a FONTE do devolvível é o SALDO WIP PER-OP (reversão da decisão (a)).
// Rodar: npx ts-node src/smokes/smoke_returns_perop_source.ts   (DATABASE_URL -> branch Neon)
//
// Dois casos que provam que NÃO se devolve pelo ledger central (saídas), e sim pelo saldo per-OP:
//   1) OP sem rastro per-OP (recebido 0): lista VAZIA + registrar devolução -> 400 (limitação aceita).
//   2) OP com consumido no meio (recebido 10, consumido 6 -> saldo 4): devolver 5 -> 400; 4 -> ok.

import { registerPendingReturns, listReturnableItems, ReturnError } from '../services/returns.service';
import { runSmoke, pickPooledProduct, seedReturnable, anyUserId, assert, num } from './_smoke';

runSmoke('fonte do devolvível = saldo WIP per-OP (legada vazia + consumido não devolve)', async (client) => {
  const prod = await pickPooledProduct(client);
  const userId = await anyUserId(client);

  // ───────── CASO 1: OP legada, sem eventos per-OP (recebido 0) ─────────
  // Tem saída de separação (withdrawn 10), mas ZERO recebido -> saldo WIP 0 -> nada devolvível.
  const legada = await seedReturnable(client, prod.productId, { withdrawn: 10, recebido: 0 }, 'legada', userId);

  const listaLegada = await listReturnableItems(client, legada.opCode);
  assert(listaLegada.length === 0, `OP sem rastro per-OP deveria dar lista VAZIA, veio ${listaLegada.length} item(ns)`);
  console.log('  caso 1: OP legada (sem recebido) -> lista de devolvíveis VAZIA ✔');

  let barrouLegada = false;
  try {
    await registerPendingReturns(client, { clientServiceId: legada.opId, items: [{ product_id: prod.productId, quantity: 1 }], userId });
  } catch (e: any) {
    if (!(e instanceof ReturnError && e.code === 'SEM_RASTRO_PER_OP')) throw e;
    barrouLegada = true;
  }
  assert(barrouLegada, 'devolver de OP sem rastro per-OP deveria dar 400 SEM_RASTRO_PER_OP');
  console.log('  caso 1: registrar devolução na OP legada -> 400 SEM_RASTRO_PER_OP (use Reaproveitamento) ✔');

  // ───────── CASO 2: consumido no meio ─────────
  // recebido 10, consumido 6 -> saldo WIP 4. Não dá pra devolver 5 (o consumido já saiu do saldo).
  const op = await seedReturnable(client, prod.productId, { withdrawn: 10, recebido: 10, consumido: 6 }, 'consumido', userId);
  assert(op.saldo === 4, `saldo semeado deveria ser 4 (10−6), veio ${op.saldo}`);

  const row = (await listReturnableItems(client, op.opCode)).find((r) => r.product_id === prod.productId);
  assert(row, 'produto com saldo 4 deveria aparecer devolvível');
  assert(num(row!.saldo) === 4, `saldo na lista deveria ser 4, veio ${row!.saldo}`);
  assert(num(row!.available_to_return) === 4, `disponível deveria ser 4, veio ${row!.available_to_return}`);
  console.log(`  caso 2: recebido 10, consumido 6 -> saldo/disponível = ${row!.saldo}/${row!.available_to_return} ✔`);

  let barrou5 = false;
  try {
    await registerPendingReturns(client, { clientServiceId: op.opId, items: [{ product_id: prod.productId, quantity: 5 }], userId });
  } catch (e: any) {
    if (!(e instanceof ReturnError && e.code === 'DEVOLUCAO_ACIMA_DO_DISPONIVEL')) throw e;
    barrou5 = true;
  }
  assert(barrou5, 'devolver 5 com saldo 4 (consumido no meio) deveria dar 400 — não se devolve o consumido');
  console.log('  caso 2: devolver 5 (saldo 4) -> 400 (o consumido não é devolvível) ✔');

  // O que cabe (4) passa.
  const criados = await registerPendingReturns(client, { clientServiceId: op.opId, items: [{ product_id: prod.productId, quantity: 4 }], userId });
  assert(criados.length === 1 && num(criados[0].quantity) === 4, 'devolver 4 (= saldo) deveria passar e criar 1 pendente');
  console.log('  caso 2: devolver 4 (= saldo) -> OK ✔');
});
