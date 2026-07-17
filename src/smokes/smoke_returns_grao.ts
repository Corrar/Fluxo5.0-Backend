// smoke_returns_grao.ts — INVARIANTE DO GRÃO: a conferência credita o físico central POOLED sem
// abrir a dimensão por OP. Após conferir, o produto continua com as MESMAS linhas de estoque (nenhuma
// linha op_id != NULL nova) e a linha POOLED (op_id NULL) do ALMOX ganhou exatamente a qtd conferida.
// Rodar: npx ts-node src/smokes/smoke_returns_grao.ts   (DATABASE_URL -> branch Neon)
//
// É o caso geral do invariante "2098/2098" do ALMOX real: uma linha só por produto, op_id NULL.

import { registerPendingReturns, conferReturn } from '../services/returns.service';
import { runSmoke, pickPooledProduct, seedReturnable, anyUserId, assert, num } from './_smoke';

runSmoke('invariante do grão (POOLED credita sem abrir a dimensão por OP)', async (client) => {
  const prod = await pickPooledProduct(client);
  const userId = await anyUserId(client);
  const { opId } = await seedReturnable(client, prod.productId, { withdrawn: 10, recebido: 10 }, 'grao', userId);

  // Fotografia das linhas de estoque do produto + saldo da linha POOLED do ALMOX.
  const lines = async () => {
    const tot = await client.query(`SELECT COUNT(*)::int AS n FROM stock WHERE product_id = $1`, [prod.productId]);
    const withOp = await client.query(`SELECT COUNT(*)::int AS n FROM stock WHERE product_id = $1 AND op_id IS NOT NULL`, [prod.productId]);
    const pooled = await client.query(
      `SELECT quantity_on_hand, quantity_reserved FROM stock WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NULL`,
      [prod.productId, prod.warehouseId],
    );
    return {
      total: tot.rows[0].n,
      withOp: withOp.rows[0].n,
      onHand: num(pooled.rows[0]?.quantity_on_hand),
      reserved: num(pooled.rows[0]?.quantity_reserved),
    };
  };

  const b = await lines();
  console.log(`  ANTES : linhas do produto=${b.total} (op_id != NULL: ${b.withOp}); POOLED on_hand/reserved = ${b.onHand}/${b.reserved}`);
  assert(b.total >= 1, 'o produto deveria ter ao menos a linha POOLED do ALMOX');
  if (b.withOp !== 0) {
    console.warn(`  ⚠ o branch já tinha ${b.withOp} linha(s) op_id != NULL ANTES do smoke (grão pré-aberto — dívida pré-existente, não desta peça)`);
  }

  // Registra e confere uma devolução de 4 -> StockService.receive POOLED (op_id NULL).
  const [pend] = await registerPendingReturns(client, { clientServiceId: opId, items: [{ product_id: prod.productId, quantity: 4 }], userId });
  await conferReturn(client, { requestId: pend.id, conferredQty: 4, userId });

  const a = await lines();
  console.log(`  DEPOIS: linhas do produto=${a.total} (op_id != NULL: ${a.withOp}); POOLED on_hand/reserved = ${a.onHand}/${a.reserved}`);

  // O invariante: a conferência NÃO criou linha nenhuma (nem pooled nem por-OP); só somou no POOLED.
  assert(a.total === b.total, `abriu o grão: nº de linhas do produto mudou de ${b.total} para ${a.total}`);
  assert(a.withOp === b.withOp, `abriu o grão: linhas op_id != NULL mudou de ${b.withOp} para ${a.withOp} (a peça criou dimensão por OP!)`);
  assert(num(a.onHand) === num(b.onHand + 4), `POOLED on_hand deveria ir de ${b.onHand} para ${b.onHand + 4}, veio ${a.onHand}`);
  assert(num(a.reserved) === num(b.reserved), `reserva do POOLED não deveria mudar (${b.reserved}), veio ${a.reserved}`);
  console.log('  ✔ grão fechado: mesmas linhas, nenhuma op_id != NULL nova, on_hand +4 no POOLED, reserva intacta');
});
