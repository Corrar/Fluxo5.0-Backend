// smoke_returns_total_cost.ts — a devolução CONFERIDA abate o total_cost da OP; a pendente NÃO.
// Rodar: npx ts-node src/smokes/smoke_returns_total_cost.ts   (DATABASE_URL -> branch Neon)
//
// História: OP com 10 saídas × unit_price. Registrar o pendente não mexe no custo (op_returns só
// ganha linha na conferência). Conferir 4 escreve a linha em op_returns e o custo cai 4×unit_price.
// Extra (por causa do achado): confirma que o grão do estoque continua fechado após a conferência.

import { registerPendingReturns, conferReturn } from '../services/returns.service';
import { runSmoke, pickPooledProduct, seedReturnable, anyUserId, totalCostOf, opReturnsCount, assert, approx, num } from './_smoke';

runSmoke('total_cost abatido pela devolução conferida (e só por ela)', async (client) => {
  const prod = await pickPooledProduct(client, { pricedOnly: true });
  const userId = await anyUserId(client);
  // withdrawn 10 (base do total_cost) + recebido 10 (saldo WIP, pra a devolução ser permitida).
  const { opId } = await seedReturnable(client, prod.productId, { withdrawn: 10, recebido: 10 }, 'totalcost', userId);
  const P = prod.unitPrice;

  // 1. Custo inicial = 10 × unit_price (0 devoluções conferidas).
  const custo0 = await totalCostOf(client, opId);
  assert(approx(custo0, 10 * P), `custo inicial deveria ser ${10 * P} (10×${P}), veio ${custo0}`);
  console.log(`  custo inicial: ${custo0}  (10 × ${P})`);

  // 2. Registrar o pendente de 4 NÃO abate o custo (op_returns intacto).
  const antesLinhas = await opReturnsCount(client, opId);
  const [pend] = await registerPendingReturns(client, { clientServiceId: opId, items: [{ product_id: prod.productId, quantity: 4 }], userId });
  const custoPend = await totalCostOf(client, opId);
  assert(approx(custoPend, 10 * P), `pendente NÃO deveria abater; custo era ${10 * P}, veio ${custoPend}`);
  assert((await opReturnsCount(client, opId)) === antesLinhas, 'pendente NÃO deveria escrever em op_returns');
  console.log(`  após registrar pendente de 4: custo segue ${custoPend}  (pendente não abate; op_returns intacto)`);

  // 3. Conferir 4 -> op_returns ganha 1 linha -> custo cai 4×unit_price.
  await conferReturn(client, { requestId: pend.id, conferredQty: 4, userId });
  const depoisLinhas = await opReturnsCount(client, opId);
  assert(depoisLinhas === antesLinhas + 1, `op_returns deveria ganhar 1 linha; antes ${antesLinhas}, depois ${depoisLinhas}`);

  const custo1 = await totalCostOf(client, opId);
  assert(approx(custo1, 6 * P), `após conferir 4, custo deveria ser ${6 * P} ((10−4)×${P}), veio ${custo1}`);
  assert(approx(custo0 - custo1, 4 * P), `abatimento deveria ser ${4 * P} (4×${P}), veio ${custo0 - custo1}`);
  console.log(`  após conferir 4: custo=${custo1}, abatimento=${custo0 - custo1}  (= 4 × ${P}) ✔`);

  // 4. Extra (achado): grão do estoque continua fechado — 0 linha op_id != NULL do produto.
  const grao = await client.query(
    `SELECT COUNT(*) FILTER (WHERE op_id IS NULL)     AS pooled,
            COUNT(*) FILTER (WHERE op_id IS NOT NULL) AS por_op
       FROM stock WHERE product_id = $1`,
    [prod.productId],
  );
  assert(num(grao.rows[0].por_op) === 0, `grão aberto! surgiram ${grao.rows[0].por_op} linha(s) op_id != NULL`);
  console.log(`  grão fechado: linhas op_id NULL=${grao.rows[0].pooled}, op_id != NULL=${grao.rows[0].por_op} ✔`);
});
