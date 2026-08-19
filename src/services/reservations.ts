// src/services/reservations.ts — Fluxo Royale 5.0 · Lote B
//
// FONTE ÚNICA das ORIGENS DE RESERVA de um produto. Três chamadores:
//   1. o guard da saída manual  (stock.controller.ts · manualWithdrawal)  — caminho de ERRO
//   2. GET /stock/reservations/product/:productId (D-B4)                  — consulta do Catálogo
//   3. GET /stock/:id/reservations (legado, reescrito para delegar)       — ver nota no controller
// Duplicar a query nos três lugares foi o que produziu o leitor errado que este lote conserta
// (as 4 divergências estão no DIVIDAS.md). Se precisar de mais um chamador, chame — não copie.
//
// ─── O QUE É "ORIGEM" ─────────────────────────────────────────────────────────────────────────
// `stock.quantity_reserved` é um AGREGADO: um número, sem memória de quem o levantou. As quatro
// tabelas abaixo são os documentos que PROMETEM material, e a soma das parcelas vivas delas é o
// que deveria explicar esse agregado. Os filtros de "ainda vale" NÃO são invenção — foram medidos
// na fase 0 contra produção, onde 11 produtos com disponível=0 reconciliaram 100%:
//
//   Solicitações  request_items.qty_reserved      SEM filtro de status (a coluna é mantida por
//                                                 reserve/release, inclusive o crédito 3D — o
//                                                 status da solicitação não a governa)
//   Separações    separation_items.quantity       separations.status NOT IN ('entregue','cancelada','concluida')
//   Reposições    replenishment_items.quantity    replenishments.status NOT IN ('concluido','cancelada')
//   Viagens       travel_order_items.quantity_out travel_orders.status <> 'reconciled'
//
// NULL em status: `NOT IN (...)` e `<> 'x'` devolvem NULL para status NULL, e a linha fica de FORA.
// É de propósito e não é buraco silencioso — uma origem que não entra na soma aparece como
// DIFERENÇA declarada (ver abaixo), que é exatamente o comportamento honesto que o D-B3 pede.
//
// ─── A DIFERENÇA (D-B3) ───────────────────────────────────────────────────────────────────────
// Quando a soma das origens NÃO fecha com o agregado, a diferença é DECLARADA — nunca escondida,
// nunca atribuída a um culpado. A causa conhecida é o QUINTO caminho, que reserva SEM documento:
// `PUT /stock/:id` (updateStock) mexe em quantity_reserved direto, via reserve/release com
// refType 'stock_adjust'. Quem precisar do rastro tem `audit_logs` (action UPDATE_STOCK) — este
// helper NÃO o consulta, por decisão do Bruno (D-B3). Ver DIVIDAS.md.
//
// ─── ESCOPO: PRODUTO vs. LINHA DE ESTOQUE ─────────────────────────────────────────────────────
// O agregado é de UMA linha (produto, armazém, op). As origens são do PRODUTO — os quatro
// documentos não carregam armazém. Os dois casam porque só o ALMOX pooled reserva
// (stock.service.ts, cabeçalho) e `resolveWarehouseId` devolve ALMOX nesta fase
// (warehouse.ts:44). Se um dia um setor reservar, esta função precisa ganhar a dimensão de
// armazém ANTES de ser usada lá — está registrado no DIVIDAS.md.

// `StockError` vem do motor mas o motor NÃO é alterado por isto — é só o tipo de erro da casa,
// reusado para que a recusa de "produto sem estoque" continue com o MESMO code de antes do lote.
import { StockError } from './stock.service';

export type ReservationOriginKind = 'request' | 'separation' | 'replenishment' | 'travel';

export interface ReservationOrigin {
  kind: ReservationOriginKind;
  /** id do DOCUMENTO (não do item) — é por ele que o front linka. */
  documentId: string;
  quantity: number;
  /** Rótulo pronto, legível, montado pelo servidor: uma verdade só para os três chamadores. */
  label: string;
  /** Campos crus do rótulo, para o front compor de outro jeito sem reparsear o label. */
  meta: Record<string, unknown>;
}

export interface ReservationBreakdown {
  productId: string;
  warehouseId: string;
  opId: string | null;
  onHand: number;
  reserved: number;
  available: number;
  origins: ReservationOrigin[];
  /** Soma das parcelas das origens rastreadas. */
  identified: number;
  /** reserved − identified. > 0 = reserva sem origem rastreável. ≠ 0 dispara `hasDifference`. */
  difference: number;
  hasDifference: boolean;
  /**
   * A LINHA de estoque (produto, armazém, op) existe? Interno — NÃO vai para o payload de rede.
   * Serve para o guard distinguir "produto sem estoque nenhum" de "saldo insuficiente", que o
   * motor não distingue mais desde a troca por `reverseReceive`: o `ensureAndLock` dele CRIA a
   * linha 0/0 antes de recusar, então os dois casos chegariam com a mesma mensagem.
   */
  hasStockRow: boolean;
}

/** Executor estrutural: satisfeito por PoolClient (dentro de TX, com a linha travada) e por Pool (GET). */
export interface ReservationsQueryable {
  query<R extends Record<string, any> = any>(text: string, params?: any[]): Promise<{ rows: R[] }>;
}

export interface BreakdownOptions {
  warehouseId: string;
  opId: string | null;
  /**
   * `FOR UPDATE` na linha de saldo. SÓ o guard usa (dentro de TX): a medida do disponível tem de
   * acontecer sob a MESMA trava que o `consume` vai pegar, senão é TOCTOU — outra transação
   * reserva entre a medição e a baixa e o guard aprova uma saída que já não cabe. Os dois GETs
   * deixam em `false`: leitura não trava linha de estoque.
   */
  lockRow?: boolean;
  /**
   * Separação a IGNORAR como origem concorrente. A saída manual INSERE a separação e os
   * separation_items ANTES de consumir (stock.controller.ts), então no instante do guard os itens
   * da própria saída já estão na tabela que este helper lê. Hoje ela escapa só porque o status
   * gravado é 'concluida', que cai na exclusão de status — isso é COINCIDÊNCIA DE VALOR LITERAL,
   * não desenho. Trocar aquele literal faria toda saída manual enxergar a si mesma como reserva
   * alheia e se recusar. Este parâmetro é o que torna a blindagem intencional. (PB12)
   */
  excludeSeparationId?: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

// Uma query só, UNION ALL das quatro origens. `meta` é jsonb porque as colunas de rótulo têm tipos
// diferentes em cada ramo (texto, timestamptz, numérico) e um UNION de colunas cruas obrigaria a
// castar tudo para texto — perdendo o tipo antes de o front receber.
// Todos os JOINs extras (profiles, client_services) são por id (PK, indexado) e o WHERE de cada
// ramo é por product_id: barato o bastante para caminho de erro síncrono.
const ORIGINS_SQL = `
  SELECT 'request'::text AS kind,
         r.id::text      AS document_id,
         ri.qty_reserved AS quantity,
         jsonb_build_object(
           'sector',     COALESCE(pf.sector, r.sector),
           'requester',  pf.name,
           'created_at', r.created_at
         ) AS meta
    FROM request_items ri
    JOIN requests r ON r.id = ri.request_id
    LEFT JOIN profiles pf ON pf.id = r.requester_id
   WHERE ri.product_id = $1
     AND ri.qty_reserved > 0

  UNION ALL

  SELECT 'separation'::text,
         s.id::text,
         si.quantity,
         jsonb_build_object(
           'client',      s.client_name,
           'op',          COALESCE(cs.op_code, s.production_order),
           'destination', s.destination,
           'created_at',  s.created_at
         )
    FROM separation_items si
    JOIN separations s ON s.id = si.separation_id
    LEFT JOIN client_services cs ON cs.id = s.client_service_id
   WHERE si.product_id = $1
     AND si.quantity > 0
     AND s.status NOT IN ('entregue', 'cancelada', 'concluida')
     AND ($2::uuid IS NULL OR s.id <> $2::uuid)

  UNION ALL

  SELECT 'replenishment'::text,
         rep.id::text,
         rpi.quantity,
         jsonb_build_object(
           'order_number', rep.order_number,
           'client',       rep.client_name,
           'city',         rep.city_state
         )
    FROM replenishment_items rpi
    JOIN replenishments rep ON rep.id = rpi.replenishment_id
   WHERE rpi.product_id = $1
     AND rpi.quantity > 0
     AND rep.status NOT IN ('concluido', 'cancelada')

  UNION ALL

  SELECT 'travel'::text,
         tro.id::text,
         tri.quantity_out,
         jsonb_build_object(
           'technicians', tro.technicians,
           'city',        tro.city
         )
    FROM travel_order_items tri
    JOIN travel_orders tro ON tro.id = tri.travel_order_id
   WHERE tri.product_id = $1
     AND tri.quantity_out > 0
     AND tro.status <> 'reconciled'
`;

const texto = (v: unknown): string => (v == null || v === '' ? '' : String(v));

const dataBR = (v: unknown): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

// Rótulo montado no SERVIDOR: os três chamadores exibem a MESMA frase. Partes ausentes somem em
// vez de virar "undefined" na tela — origem sem rótulo ainda é origem, e o id do documento sempre
// vai junto no payload.
function rotular(kind: ReservationOriginKind, meta: Record<string, unknown>): string {
  const partes: string[] = [];
  if (kind === 'request') {
    partes.push(texto(meta.sector) || 'Setor não informado');
    if (texto(meta.requester)) partes.push(texto(meta.requester));
    if (dataBR(meta.created_at)) partes.push(dataBR(meta.created_at));
    return `Solicitação · ${partes.join(' · ')}`;
  }
  if (kind === 'separation') {
    if (texto(meta.client)) partes.push(texto(meta.client));
    if (texto(meta.op)) partes.push(`OP ${texto(meta.op)}`);
    if (texto(meta.destination)) partes.push(texto(meta.destination));
    return `Separação · ${partes.length ? partes.join(' · ') : 'sem identificação'}`;
  }
  if (kind === 'replenishment') {
    if (texto(meta.order_number)) partes.push(`nº ${texto(meta.order_number)}`);
    if (texto(meta.client)) partes.push(texto(meta.client));
    if (texto(meta.city)) partes.push(texto(meta.city));
    return `Reposição · ${partes.length ? partes.join(' · ') : 'sem identificação'}`;
  }
  if (texto(meta.technicians)) partes.push(texto(meta.technicians));
  if (texto(meta.city)) partes.push(texto(meta.city));
  return `Viagem · ${partes.length ? partes.join(' · ') : 'sem identificação'}`;
}

/**
 * Agregado + origens + diferença de um produto numa linha de estoque.
 *
 * NÃO trava nada e NÃO escreve: quem precisa de leitura consistente (o guard) já entra aqui com a
 * linha travada pela própria transação. Chamar com o `pool` fora de TX é legítimo — é o que os
 * dois GETs fazem.
 */
export async function getReservationBreakdown(
  client: ReservationsQueryable,
  productId: string,
  opts: BreakdownOptions,
): Promise<ReservationBreakdown> {
  const { warehouseId, opId, excludeSeparationId = null, lockRow = false } = opts;

  const saldo = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(
    `SELECT quantity_on_hand, quantity_reserved
       FROM stock
      WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid
      ${lockRow ? 'FOR UPDATE' : ''}`,   // interpolação de LITERAL fixo a partir de boolean interno:
                                          // `FOR UPDATE` é cláusula, não pode ser $n. Nenhum dado de
                                          // requisição entra aqui — os três valores vão parametrizados.
    [productId, warehouseId, opId],
  );

  const hasStockRow = saldo.rows.length > 0;
  const onHand = hasStockRow ? num(saldo.rows[0].quantity_on_hand) : 0;
  const reserved = hasStockRow ? num(saldo.rows[0].quantity_reserved) : 0;

  const { rows } = await client.query<{ kind: ReservationOriginKind; document_id: string; quantity: string; meta: Record<string, unknown> }>(
    ORIGINS_SQL,
    [productId, excludeSeparationId],
  );

  const origins: ReservationOrigin[] = rows.map((r) => {
    const meta = r.meta || {};
    return { kind: r.kind, documentId: r.document_id, quantity: num(r.quantity), label: rotular(r.kind, meta), meta };
  });
  // Maior parcela primeiro: quem lê a recusa quer ver o que mais pesa. Sem ORDER BY explícito a
  // ordem seria a do plano do executor (a régua do Lote 0 sobre `json_agg` vale igual aqui, com
  // UNION ALL de 4 ramos) — ordenar no servidor é decisão, não sorte.
  origins.sort((a, b) => b.quantity - a.quantity);

  const identified = origins.reduce((s, o) => s + o.quantity, 0);
  // Arredonda o resíduo binário do numeric->float antes de comparar com zero: sem isto um
  // 200 − (120 + 80) vira 2.8e-14 e a tela declararia diferença onde ela não existe.
  const difference = Math.round((reserved - identified) * 1e6) / 1e6;

  return {
    productId,
    warehouseId,
    opId,
    onHand,
    reserved,
    available: onHand - reserved,
    origins,
    identified,
    difference,
    hasDifference: difference !== 0,
    hasStockRow,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O GUARD DA SAÍDA MANUAL (D-B1)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠ POR QUE O GUARD É DO CHAMADOR, E NÃO DO MOTOR.
// `StockService.consume` mede on_hand e faz `releaseQty = Math.min(qty, cur.reserved)` — é
// literalmente o que come a reserva alheia. A tentação é consertar ali. NÃO É BUG ALI: 52 dos 56
// `consume` do razão são `ref_type='request'`, a ENTREGA de uma solicitação cumprindo a PRÓPRIA
// reserva, onde baixar o físico e soltar a reserva junto é exatamente o certo. Trocar o motor
// consertaria a saída manual e quebraria a entrega — o mesmo `Math.min` é acerto num chamador e
// erro no outro. Quem sabe se a reserva é PRÓPRIA ou ALHEIA é quem chama. Por isso o guard mora
// aqui e o `stock.service.ts` não foi tocado neste lote.

export class SaidaAcimaDoDisponivelError extends Error {
  public readonly code = 'SAIDA_ACIMA_DO_DISPONIVEL' as const;
  constructor(
    public readonly breakdown: ReservationBreakdown,
    public readonly requested: number,
    public readonly productLabel?: string | null,
  ) {
    super(
      `Saída de ${requested} acima do disponível (${breakdown.available}): ` +
      `há ${breakdown.reserved} reservado(s) de ${breakdown.onHand} em estoque.`,
    );
    this.name = 'SaidaAcimaDoDisponivelError';
  }
}

/**
 * Recusa a saída manual que comeria reserva alheia. Chamado DENTRO da transação, IMEDIATAMENTE
 * antes de cada `StockService.consume`, com `lockRow` — a medida acontece sob a mesma trava que o
 * consume vai pegar, então não há janela para outra transação reservar no meio.
 *
 * QUANDO DISPARA (e quando deliberadamente NÃO dispara):
 *   qty > available && qty <= onHand -> SaidaAcimaDoDisponivelError. O físico BASTA; o que
 *                                       impede é reserva de terceiro. É o caso do Bruno e o
 *                                       único que este lote introduz.
 *   qty > onHand                     -> NÃO dispara. Falta material de verdade, e isso o motor já
 *                                       recusa com FURO_ESTOQUE desde sempre. Deixar passar para
 *                                       o `consume` mantém aquela mensagem e aquele contrato
 *                                       intactos (PB10) em vez de trocá-los por um erro novo.
 *   qty <= available                 -> NÃO dispara. É saída legítima (PB2).
 *
 * IDEMPOTÊNCIA (PB8): se a `opKey` já está no razão, a saída JÁ ACONTECEU e o `consume` vai ser
 * no-op. Medir o disponível de novo recusaria o retry de uma saída que baixou o estoque
 * corretamente — o saldo de agora já reflete a baixa. Por isso a checagem da chave vem PRIMEIRO.
 * A consulta espelha o `alreadyApplied` do StockService de propósito: ele é privado do módulo e o
 * motor não foi tocado neste lote.
 */
export async function assertWithdrawalWithinAvailable(
  client: ReservationsQueryable,
  productId: string,
  qty: number,
  opts: BreakdownOptions & { opKey?: string | null; productLabel?: string | null },
): Promise<void> {
  if (opts.opKey) {
    const { rows } = await client.query('SELECT 1 FROM stock_ledger WHERE op_key = $1', [opts.opKey]);
    if (rows.length > 0) return;
  }

  const breakdown = await getReservationBreakdown(client, productId, { ...opts, lockRow: true });

  // PRODUTO SEM LINHA DE ESTOQUE — recusa AQUI, com o code de sempre.
  // Antes do Lote B quem barrava era o `lockExisting` do `consume`, com PRODUTO_SEM_ESTOQUE.
  // O `reverseReceive` que substituiu o consume usa `ensureAndLock`: ele CRIA a linha 0/0 e só
  // então recusa, com SALDO_INSUFICIENTE_REVERSAO — a mesma mensagem de "saldo insuficiente".
  // Os dois casos são diferentes para quem opera ("este produto não tem estoque" não é "não tem
  // o bastante"), então a distinção volta a existir aqui, no CHAMADOR, e não no motor.
  if (!breakdown.hasStockRow) {
    throw new StockError(
      'PRODUTO_SEM_ESTOQUE',
      'Este produto não tem estoque no almoxarifado — não há saldo para dar saída.',
      productId, opts.warehouseId, opts.opId,
    );
  }

  // Epsilon contra resíduo binário do numeric->float: sem ele um disponível de 3 medido como
  // 2.9999999999999996 recusaria uma saída de 3 que cabe.
  const EPS = 1e-9;
  if (qty - breakdown.available > EPS && qty - breakdown.onHand <= EPS) {
    throw new SaidaAcimaDoDisponivelError(breakdown, qty, opts.productLabel ?? null);
  }
}

/** Payload da recusa: o front NÃO faz 2ª chamada — as origens viajam no corpo do erro (D-B2). */
export function breakdownToPayload(b: ReservationBreakdown) {
  return {
    product_id: b.productId,
    on_hand: b.onHand,
    reserved: b.reserved,
    available: b.available,
    origins: b.origins.map((o) => ({
      kind: o.kind,
      document_id: o.documentId,
      quantity: o.quantity,
      label: o.label,
      meta: o.meta,
    })),
    identified: b.identified,
    difference: b.difference,
    has_difference: b.hasDifference,
  };
}
