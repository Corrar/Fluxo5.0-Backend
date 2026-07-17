// smoke_returns_janela.ts — A JANELA DE TRÂNSITO desconta o pendente do SALDO WIP per-OP, e o guard bite.
// Rodar: npx ts-node src/smokes/smoke_returns_janela.ts   (DATABASE_URL -> branch Neon)
//
// História: a OP tem 10 no armazém de material (recebido). Registrar devolução pendente NÃO mexe no
// saldo WIP nem credita nada, mas TIRA do disponível ("em trânsito"). Passar do disponível é barrado.
// Quando tudo entra em trânsito, o item some da lista de devolvíveis.

import { registerPendingReturns, listReturnableItems, ReturnError } from '../services/returns.service';
import { runSmoke, pickPooledProduct, seedReturnable, anyUserId, assert, num } from './_smoke';

runSmoke('janela de trânsito (pendente desconta o disponível per-OP + guard)', async (client) => {
  const prod = await pickPooledProduct(client);
  const userId = await anyUserId(client);
  const { opId, opCode } = await seedReturnable(client, prod.productId, { withdrawn: 10, recebido: 10 }, 'janela', userId);

  const rowOf = async () => {
    const rows = await listReturnableItems(client, opCode);
    return rows.find((r) => r.product_id === prod.productId);
  };

  // 1. Baseline: saldo WIP 10, nada em trânsito -> disponível 10.
  let r = await rowOf();
  assert(r, 'o produto deveria aparecer como devolvível');
  assert(num(r!.saldo) === 10, `saldo WIP inicial deveria ser 10, veio ${r!.saldo}`);
  assert(num(r!.available_to_return) === 10, `disponível inicial deveria ser 10, veio ${r!.available_to_return}`);
  assert(num(r!.em_devolucao) === 0, `em_devolucao inicial deveria ser 0, veio ${r!.em_devolucao}`);
  console.log(`  baseline: saldo=${r!.saldo}, disponível=${r!.available_to_return}, em_devolucao=${r!.em_devolucao}`);

  // 2. Registra 3 pendentes -> saem do disponível SEM mexer no saldo WIP nem creditar estoque.
  await registerPendingReturns(client, { clientServiceId: opId, items: [{ product_id: prod.productId, quantity: 3 }], userId });
  r = await rowOf();
  assert(r, 'produto deveria seguir devolvível (ainda há 7)');
  assert(num(r!.saldo) === 10, `saldo WIP NÃO deveria mudar com pendente; era 10, veio ${r!.saldo}`);
  assert(num(r!.available_to_return) === 7, `após pendente 3, disponível deveria ser 7, veio ${r!.available_to_return}`);
  assert(num(r!.em_devolucao) === 3, `em_devolucao deveria ser 3, veio ${r!.em_devolucao}`);
  console.log(`  após pendente 3: saldo=${r!.saldo}, disponível=${r!.available_to_return}, em_devolucao=${r!.em_devolucao}`);

  // 3. GUARD: registrar 8 (só há 7) tem de estourar DEVOLUCAO_ACIMA_DO_DISPONIVEL.
  let barrou = false;
  try {
    await registerPendingReturns(client, { clientServiceId: opId, items: [{ product_id: prod.productId, quantity: 8 }], userId });
  } catch (e: any) {
    if (!(e instanceof ReturnError && e.code === 'DEVOLUCAO_ACIMA_DO_DISPONIVEL')) throw e;
    barrou = true;
  }
  assert(barrou, 'o guard deveria ter barrado 8 pendentes com só 7 disponíveis');
  console.log('  guard OK: 8 pendentes recusados (só 7 disponíveis)');

  // 4. O que cabe (7) passa -> disponível 0 -> item SOME da lista (nada mais a devolver).
  await registerPendingReturns(client, { clientServiceId: opId, items: [{ product_id: prod.productId, quantity: 7 }], userId });
  r = await rowOf();
  assert(!r, 'com tudo em trânsito (disponível 0), o produto deveria SUMIR da lista de devolvíveis');
  console.log('  após +7 pendente: disponível 0 -> produto fora da lista (correto)');
});
