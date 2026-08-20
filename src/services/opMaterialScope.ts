// src/services/opMaterialScope.ts — Fluxo Royale 5.0 (lote AW1)
//
// O ESCOPO DO RAZÃO PER-OP: o SETOR é o DONO, a OP é a ETIQUETA.
//
// Este módulo existe por UM motivo, e ele é a parte mais perigosa do lote AW1: a string do
// advisory lock que serializa o saldo WIP tinha de ganhar o setor em QUATRO pontos ao mesmo
// tempo. A 008 é explícita sobre a invariante (opMaterials.controller, comentário do consume):
//
//     "devolver e transferir_out TÊM que pegar ESTE MESMO lock, com a MESMA string"
//
// Enquanto a string era montada à mão em cada chamador, "a mesma string" era uma promessa de
// revisão de código. Se um dos quatro ficasse para trás na hora de acrescentar o armazém, os
// dois grupos passariam a pegar locks DIFERENTES, a exclusão mútua deixaria de existir, e o
// resultado seria uma CORRIDA que só aparece sob concorrência — a classe de defeito que não
// dá erro, só dá saldo errado.
//
// Com `lockKeyOpMat` a promessa vira construção: existe UMA definição da string, e os quatro
// pontos a chamam. Um chamador novo que esqueça o armazém não compila (o parâmetro é
// obrigatório); um chamador que monte a string à mão fica visível no diff.
//
// ⚠ O PAR INSEPARÁVEL: quem muda a CHAVE DO LOCK muda junto o ESCOPO DO GUARD.
//   Um lock por (armazém, OP, produto) protegendo um guard que lê saldo GLOBAL não protege
//   nada: dois setores tomariam locks distintos e leriam a MESMA projeção, os dois passariam.
//   Por isso `saldoDe` (controller) e `availableToReturn` (returns.service) passaram a filtrar
//   por `warehouse_id` no MESMO lote em que o lock ganhou o armazém. Chave e escopo andam
//   juntos ou não andam.

import type { PoolClient } from 'pg';
import { canonSetor, resolveDestinationWarehouse } from './setor';
import { resolveDestinationWarehouseId } from './warehouse';

/**
 * A CHAVE DO ADVISORY LOCK do saldo WIP per-OP. Definição ÚNICA — ver o cabeçalho.
 *
 * Grão `(armazém, OP, produto)`: dois setores apontando o MESMO produto da MESMA OP não se
 * esperam (são saldos separados, é o ponto do lote), mas dois apontamentos do MESMO setor sobre
 * o MESMO par continuam serializados, que é o que o guard de saldo precisa.
 *
 * O prefixo `opmat:` é preservado de propósito: é o namespace da 008 e o que separa este lock
 * dos demais advisory locks do sistema.
 */
export function lockKeyOpMat(
  warehouseId: string,
  clientServiceId: string,
  productId: string,
): string {
  return `opmat:${warehouseId}:${clientServiceId}:${productId}`;
}

/** O que o perfil de um usuário diz sobre custódia. */
export interface EscopoDoPerfil {
  /** `warehouses.id` do armazém do setor do perfil, ou `null` se o setor não tem custódia. */
  warehouseId: string | null;
  /** `profiles.sector` cru, como está no cadastro. */
  sectorCru: string | null;
  /** Forma canônica do setor (`canonSetor`), para comparação. */
  sectorCanon: string | null;
  /** `profiles.role`. */
  role: string | null;
  /** admin ou almoxarife — a chave-mestra do módulo (mesma definição do guard do Recebimento). */
  isMaster: boolean;
}

/**
 * Resolve o escopo de custódia de um perfil: do `profiles.sector` até o `warehouses.id`.
 *
 * ⚠ NÃO usa `profiles.warehouse_id`, e isso é medição, não gosto: em produção (20/08/2026) essa
 * coluna é ALMOX em 28 dos 29 perfis (e NULL no 29º). Ela diz de onde a pessoa OPERA no estoque
 * central, não qual é o armazém do setor dela. Usá-la carimbaria ALMOX em todo mundo — e o
 * razão per-OP é WIP de setor, o ALMOX não entra aqui.
 *
 * A rota é o de-para do `setor.ts`, que é a FONTE (nunca `warehouses.sector`).
 */
export async function escopoDoPerfil(
  client: PoolClient,
  userId: string | null,
): Promise<EscopoDoPerfil> {
  if (!userId) return { warehouseId: null, sectorCru: null, sectorCanon: null, role: null, isMaster: false };
  const { rows } = await client.query<{ role: string; sector: string | null }>(
    `SELECT role, sector FROM profiles WHERE id = $1`,
    [userId],
  );
  const role = rows[0]?.role ?? null;
  const sectorCru = rows[0]?.sector ?? null;
  const isMaster = role === 'admin' || role === 'almoxarife';
  // resolveDestinationWarehouseId já embute o de-para E o cache code->id (warehouse.ts).
  const warehouseId = await resolveDestinationWarehouseId(client, sectorCru);
  return { warehouseId, sectorCru, sectorCanon: canonSetor(sectorCru), role, isMaster };
}

/**
 * Mesma pergunta, mas para um setor CRU vindo de uma origem (separação/solicitação) em vez de
 * um perfil. Devolve o id do armazém, ou `null` quando o setor não tem custódia.
 *
 * Existe para que o `receive` não precise repetir a dupla resolveDestinationWarehouse +
 * resolveDestinationWarehouseId: o guard D1 já usa a primeira para decidir se há custódia, e
 * esta devolve o id que o carimbo precisa.
 */
export async function warehouseDoSetor(
  client: PoolClient,
  setorCru: string | null | undefined,
): Promise<string | null> {
  if (resolveDestinationWarehouse(setorCru).code === null) return null;
  return resolveDestinationWarehouseId(client, setorCru);
}
