// src/services/opCost.ts — Fluxo Royale 5.0 · Lote CO1
//
// FONTE ÚNICA DA REGRA DE CUSTO DA OP.
//
// ─── O MODELO (decisão do Bruno, 20/08/2026) ──────────────────────────────────────────────────
// O custo de uma OP soma TUDO que saiu do almoxarifado com aquela OP informada, por QUALQUER
// caminho, menos o que voltou. É ACUMULADO HISTÓRICO — não tem janela, não tem "reabrir zera".
//
// ⚠ O APONTAMENTO NÃO ENTRA. São TRÊS contas, e elas são conjuntos de tabelas DISJUNTOS:
//     custo da OP ....... separations · separation_items · requests · request_items · op_returns
//     saldo do armazém .. stock · stock_ledger
//     árvore da máquina . op_material_events.machine_id · assembly_machines
//   O único ponto de contato é `client_service_id`, que é CHAVE, não valor. Um lote futuro que
//   debite o armazém do setor no apontamento escreve em `stock`/`stock_ledger` — nenhuma das duas
//   é lida aqui, então ele não mexe neste número. Está medido no bloco 7 da recon de 20/08.
//
// ─── POR QUE UM MÓDULO, E NÃO A QUERY DIRETO NO CONTROLLER ────────────────────────────────────
// Porque a regra já tinha DOIS donos antes deste lote, e eles discordavam:
//   1. `clients.controller.getClients.total_cost` — separação 'concluida' − op_returns;
//   2. `system.controller.saidas_ops_all_time` (GET /reports/general?includeAllTimeOps=true) —
//      separação ('entregue','finalizada','concluida') + solicitação ('aprovado','entregue'),
//      SEM subtrair devolução. Rota SEM NENHUM consumidor no front (medido: `grep` devolve zero);
//   3. `smokes/_smoke.ts:totalCostOf` — uma TERCEIRA cópia literal da fórmula (1), com o
//      comentário "a MESMA fórmula do clients.controller" ao lado. Cópia comentada continua cópia.
// Três definições, três verdades, e a (2) contava 'aprovado' — que NÃO saiu do almoxarifado.
// Este arquivo é o único dono. Os três passam a projetar DAQUI. Ver DIVIDAS.md.
//
// ─── A REGRA, LITERAL (medida na recon de 20/08 contra produção) ──────────────────────────────
//
// ENTRA (as três pernas de saída):
//   · SOLICITAÇÃO   requests.status IN ('entregue','devolvido')
//                   qty = COALESCE(quantity_delivered, quantity_requested)
//     ⚠ 'devolvido' CONTA. O material SAIU; o que voltou é abatido pela perna de devolução, que
//       é outro caminho. Tirá-lo daqui abateria duas vezes.
//     ⚠ `quantity_delivered` é NULL em 3 de 2.103 itens — o fallback para `quantity_requested`
//       é raro e é o certo: item nunca ajustado saiu pelo que foi pedido.
//     ⚠ NÃO usar `quantity_requested` sozinho: o conferido é 860,5 un MAIOR que o pedido no
//       histórico (dado anterior ao teto da conferência), e é o conferido que saiu pela porta.
//
//   · SEPARAÇÃO     separations.status IN ('entregue','concluida')
//                   qty = separation_items.quantity
//     ⚠ Os DOIS status são necessários e significam coisas diferentes:
//         'entregue'  = separação REAL entregue (authorizeSeparation grava isto);
//         'concluida' = SAÍDA MANUAL (manualWithdrawal nasce assim, já consumida).
//       O filtro antigo (`= 'concluida'`) selecionava saída manual e excluía justamente a
//       separação real: 12 documentos, R$ 421.765,52 fora da conta.
//     ⚠ NUNCA `qty_requested`: a saída manual não o preenche (zeraria 11.551 un — o INSERT de
//       stock.controller não lista a coluna) e na separação real ele é o PEDIDO, 331 un acima
//       do que efetivamente saiu.
//
// SUBTRAI:
//   · DEVOLUÇÃO     op_returns (FK client_service_id NOT NULL), qty = quantity.
//     Medido: os 73 un de `op_returns` batem EXATAMENTE com `request_items.quantity_returned`
//     das solicitações com OP. Os dois livros concordam; este é o que tem a chave da OP.
//
// FICA DE FORA, e é decisão, não esquecimento:
//   · solicitação 'rejeitado' e 'aberto' — nunca saiu (74 docs, 5.296 un);
//   · separação 'em_separacao' (reservada, ainda na prateleira) e 'cancelada';
//   · reposição, viagem e produção 3D — NÃO TÊM coluna de OP (medido em information_schema);
//   · `separation_returns` — a 4ª porta de devolução NÃO escreve `op_returns` e por isso não
//     abate. Zero linhas em produção hoje; furo de código herdado, registrado no DIVIDAS.
//
// ⚠ DUPLA CONTAGEM NÃO EXISTE, e não é fé — é estrutura medida: não há coluna ligando separação
//   a solicitação (`separations` tem 12 colunas, nenhuma é request_id); `manualWithdrawal` cria
//   separação e nada mais; a entrega de solicitação NÃO cria separação. Os conjuntos são
//   disjuntos por construção. A prova PC2 do lote refaz a conta pelas partes e compara com o
//   total — se um dia alguém ligar os dois, é ali que quebra.
//
// ─── O PREÇO ──────────────────────────────────────────────────────────────────────────────────
// `products.unit_price`, LIDO NA HORA DA CONSULTA. É dívida conhecida e é LOTE PRÓPRIO: houve
// 600 `ATUALIZAR_PRECOS` desde abril, e cada um reescreveu em silêncio o custo histórico de toda
// OP fechada que contém aquele produto. As colunas de congelamento EXISTEM e estão MORTAS
// (`separation_items.unit_price` 42/1.777, `request_items.unit_price` 670/4.031 — lixo do 2.0,
// nenhum INSERT do 5.0 as lista). Congelar é mudar os INSERT + decidir o backfill de um preço
// que ninguém guardou. Não é este lote. Ver DIVIDAS.md.
//
// O COALESCE/NULLIF é o mesmo idioma defensivo do resto da casa (reportsBi, system.controller):
// a coluna já foi texto em parte do histórico do schema e '' quebraria a multiplicação. Em
// produção hoje são ZERO nulos — o que existe é o ZERO EXPLÍCITO, em 282 SKUs que carregam
// 13.031 un (8,9% do volume com OP) valendo R$ 0,00. Isso é CADASTRO, não query, e sai em lista
// separada. Nenhuma linha aqui esconde esse volume: ela só não sabe precificá-lo.

/**
 * Preço unitário defensivo. Espelha `reportsBi.controller:39` e os seis pontos do
 * `system.controller` — uma régua só para o mesmo número.
 * O alias da tabela de produtos é parâmetro porque cada perna junta `products` com um alias
 * diferente; é identificador CONTROLADO POR CÓDIGO, nunca entrada de requisição.
 */
export const precoSql = (aliasProduto = 'p'): string =>
  `COALESCE(CAST(NULLIF(CAST(${aliasProduto}.unit_price AS TEXT), '') AS NUMERIC), 0)`;

/** Status de SOLICITAÇÃO que representam material que SAIU do almoxarifado. */
export const REQUEST_STATUS_SAIU = ['entregue', 'devolvido'] as const;

/** Status de SEPARAÇÃO que representam material que SAIU do almoxarifado. */
export const SEPARATION_STATUS_SAIU = ['entregue', 'concluida'] as const;

/** Lista pronta para embutir num `IN (...)` — literais fixos, definidos ACIMA, nunca do request. */
const emLista = (vs: readonly string[]): string => vs.map((v) => `'${v}'`).join(', ');

export const REQUEST_STATUS_SAIU_SQL = emLista(REQUEST_STATUS_SAIU);
export const SEPARATION_STATUS_SAIU_SQL = emLista(SEPARATION_STATUS_SAIU);

/** Quantidade que efetivamente saiu num item de solicitação. Ver a nota da regra, acima. */
export const qtdSolicitacaoSql = (aliasItem = 'ri'): string =>
  `COALESCE(${aliasItem}.quantity_delivered, ${aliasItem}.quantity_requested)`;

/**
 * O `total_cost` de UMA OP, como escalar.
 *
 * `refOp` é a EXPRESSÃO SQL que identifica a OP no contexto do chamador — `s.id` numa
 * subconsulta correlacionada, `$1` numa query parametrizada. É INTERPOLADA, e por isso a régra
 * é dura: **só código controla este argumento**. Nenhum valor de requisição entra aqui; quem
 * precisar filtrar por dado do usuário passa `$n` e manda o valor parametrizado, como sempre.
 * Mesmo idioma do `lockRow` de `services/reservations.ts:236` — cláusula não pode ser `$n`.
 *
 * LEFT JOIN em `products` nas duas pernas de saída (não INNER): `request_items.product_id` é
 * NULL em item custom, e um INNER faria a LINHA sumir. Hoje isso não muda um centavo (zero itens
 * custom entre as entregues com OP) e não muda o valor nunca — sem produto o preço já é 0 pelo
 * COALESCE. O LEFT é o que garante que continue assim quando o primeiro item custom aparecer.
 */
export const totalCostSql = (refOp: string): string => `(
  COALESCE((
    SELECT SUM(si.quantity * ${precoSql('p')})
      FROM separations sep
      JOIN separation_items si ON si.separation_id = sep.id
      LEFT JOIN products p     ON p.id = si.product_id
     WHERE sep.client_service_id = ${refOp}
       AND sep.status IN (${SEPARATION_STATUS_SAIU_SQL})
  ), 0)
  +
  COALESCE((
    SELECT SUM(${qtdSolicitacaoSql('ri')} * ${precoSql('p')})
      FROM requests req
      JOIN request_items ri ON ri.request_id = req.id
      LEFT JOIN products p  ON p.id = ri.product_id
     WHERE req.client_service_id = ${refOp}
       AND req.status IN (${REQUEST_STATUS_SAIU_SQL})
  ), 0)
  -
  COALESCE((
    SELECT SUM(ret.quantity * ${precoSql('p')})
      FROM op_returns ret
      LEFT JOIN products p ON p.id = ret.product_id
     WHERE ret.client_service_id = ${refOp}
  ), 0)
)`;
