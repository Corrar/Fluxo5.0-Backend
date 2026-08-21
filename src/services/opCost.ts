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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A LISTA — Lote PDF1 (21/08/2026)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `totalCostSql` é a MESMA conta, somada. `itensDaOpSql` é a MESMA conta, ABERTA. As duas moram
// aqui pelo mesmo motivo: a regra teve três donos antes do CO1 e os três discordavam. Um endpoint
// que reescrevesse as pernas para listar itens seria a QUARTA cópia, e ela nasceria já divergindo
// no dia em que alguém mexesse só numa das duas. Elas compartilham LITERALMENTE os mesmos
// símbolos — `precoSql`, `qtdSolicitacaoSql`, `REQUEST_STATUS_SAIU_SQL`, `SEPARATION_STATUS_SAIU_SQL`
// — então não há como mudar o predicado de uma sem mudar o da outra.
//
// PROVA (medida em produção, 21/08, nas 46 OPs): `SUM(subtotal)` desta lista == `totalCostSql` da
// mesma OP, delta 0,00 em 46/46. E no display: `SUM(ROUND(subtotal,2))` == `ROUND(SUM(subtotal),2)`
// em 40/40 das OPs com movimento — o documento não se contradiz quando o leitor soma a coluna.
//
// ─── O GRÃO: AGRUPADO POR PRODUTO (decisão do Bruno, 21/08) ────────────────────────────────────
// Uma linha por PRODUTO, não por linha de documento: 2.613 → 1.841 linhas no total; a maior OP
// (PROT0826) cai de 448 para 238 linhas, e a resposta de 141 KB para 49,6 KB.
//
// ⚠ `MAX(unit_price)` dentro do grupo só é honesto porque o preço é LIDO NA HORA de `products`:
//   medido, 0 de 1.841 pares (OP, produto) têm mais de um preço. No dia em que a dívida (a) do
//   CO1 congelar preço POR ITEM, duas linhas do mesmo produto passam a poder ter preços
//   diferentes e este GROUP BY tem de virar `(product_id, unit_price)` — senão o MAX escolhe um
//   preço e o `quantidade × unit_price` da linha deixa de dar o `subtotal`. Está no DIVIDAS.
//
// ─── A DATA: `movido_em` = O ÚLTIMO MOVIMENTO ──────────────────────────────────────────────────
// A coluna do documento chama "MOVIMENTO EM", e NÃO "SOLICITADO EM" como o protótipo. Medido:
// 504 de 2.613 linhas (19,3%) não têm solicitação nenhuma — 495 vêm de separação (e a SAÍDA
// MANUAL sozinha atinge 25 das 46 OPs) e 9 de devolução. "Solicitado em" seria falso em uma linha
// a cada cinco.
//
// Por perna, a data é a do MATERIAL SAINDO, com fallback na criação do documento:
//   · separação   COALESCE(sent_at, created_at) — `sent_at` só existe nos 19 docs `type='op'`;
//                 os 567 `manual` e os 6 `default` têm NULL (a saída manual nasce consumida).
//   · solicitação COALESCE(delivered_at, created_at) — ⚠ `delivered_at` é NOVA (RS1) e está
//                 preenchida em 14 de 2.537; NÃO houve backfill, então `created_at` responde
//                 pelo histórico inteiro. É por isso que o COALESCE aponta para ela, e não o
//                 contrário: `delivered_at` sozinho apagaria a data de 99,4% das linhas.
//   · devolução   created_at (100% preenchida).
//
// ⚠ Ao AGRUPAR, a linha mostra `MAX(movido_em)` — o movimento MAIS RECENTE, não o primeiro.
//   Isso apaga informação e é decisão consciente: 437 dos 1.841 pares fundem mais de um
//   documento (até 20), e 64 fundem movimentos com mais de 30 dias de distância — span máximo
//   medido, 77 dias. `movimentos` vai junto na resposta justamente para o documento poder dizer
//   quantos foram fundidos naquela linha, em vez de fingir que foi um só.
//
// ─── O QUE ESTA LISTA NÃO É ────────────────────────────────────────────────────────────────────
// NÃO é `GET /op-materials/balance/:id`. Aquele lê `op_material_events`, que o cabeçalho deste
// arquivo declara conjunto DISJUNTO — medido: 41 eventos cobrindo 6 das 46 OPs. Usá-lo daria
// outro número e 40 documentos vazios.

/**
 * A lista de itens de UMA OP, agrupada por produto — as MESMAS três pernas do `totalCostSql`.
 *
 * `refOp` segue a régua do `totalCostSql`: é EXPRESSÃO SQL INTERPOLADA e **só código controla
 * este argumento**. Quem filtra por dado de usuário passa `'$1'` e manda o valor parametrizado.
 *
 * Colunas: product_id, sku, produto, unit, quantidade, unit_price, subtotal, movido_em, movimentos.
 * `quantidade` e `subtotal` são LÍQUIDOS (a devolução entra negativa e abate a linha do próprio
 * produto): medido, isso zera 45 das 1.841 linhas e nunca deixa nenhuma negativa.
 */
export const itensDaOpSql = (refOp: string): string => `
  WITH movimentos AS (
    SELECT si.product_id, p.sku, p.name AS produto, p.unit,
           si.quantity                          AS qtd,
           ${precoSql('p')}                     AS unit_price,
           si.quantity * ${precoSql('p')}       AS subtotal,
           COALESCE(sep.sent_at::timestamptz, sep.created_at::timestamptz) AS movido_em
      FROM separations sep
      JOIN separation_items si ON si.separation_id = sep.id
      LEFT JOIN products p     ON p.id = si.product_id
     WHERE sep.client_service_id = ${refOp}
       AND sep.status IN (${SEPARATION_STATUS_SAIU_SQL})
    UNION ALL
    SELECT ri.product_id, p.sku, COALESCE(p.name, ri.custom_product_name), p.unit,
           ${qtdSolicitacaoSql('ri')},
           ${precoSql('p')},
           ${qtdSolicitacaoSql('ri')} * ${precoSql('p')},
           COALESCE(req.delivered_at, req.created_at::timestamptz)
      FROM requests req
      JOIN request_items ri ON ri.request_id = req.id
      LEFT JOIN products p  ON p.id = ri.product_id
     WHERE req.client_service_id = ${refOp}
       AND req.status IN (${REQUEST_STATUS_SAIU_SQL})
    UNION ALL
    SELECT ret.product_id, p.sku, p.name, p.unit,
           -ret.quantity,
           ${precoSql('p')},
           -(ret.quantity * ${precoSql('p')}),
           ret.created_at::timestamptz
      FROM op_returns ret
      LEFT JOIN products p ON p.id = ret.product_id
     WHERE ret.client_service_id = ${refOp}
  )
  SELECT product_id,
         MAX(sku)                                   AS sku,
         COALESCE(produto, '(produto removido)')    AS produto,
         MAX(unit)                                  AS unit,
         SUM(qtd)                                   AS quantidade,
         MAX(unit_price)                            AS unit_price,
         SUM(subtotal)                              AS subtotal,
         MAX(movido_em)                             AS movido_em,
         COUNT(*)                                   AS movimentos
    FROM movimentos
   GROUP BY product_id, produto
   ORDER BY COALESCE(produto, '(produto removido)') ASC
`;
