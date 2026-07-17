// src/services/returns.service.ts — Fluxo Royale 5.0
// DEVOLUÇÃO DE MATERIAL DE OP EM DUAS ETAPAS. Núcleo transacional das 3 operações do fluxo:
//   registerPendingReturns -> cria o pedido 'pendente' (entra em TRÂNSITO; NÃO credita nada).
//   conferReturn           -> a TX TRIPLA: per-OP 'devolvido' + físico central POOLED + op_returns.
//   rejectReturn           -> fecha o pedido como 'rejeitado' (NÃO credita nada).
//
// POR QUE UM SERVICE (e não tudo no controller, como o registerReturn antigo): o ponto sensível é a
// TX TRIPLA do conferReturn — os 3 livros têm de commitar juntos ou nenhum. Aqui ela é UMA função
// que recebe um PoolClient já dentro de uma transação (o withTransaction do controller OU o da
// smoke), então a smoke exercita EXATAMENTE o mesmo código que o endpoint roda — não uma cópia. É a
// mesma filosofia do StockService: motor único, testável, sem HTTP no meio.
//
// OS 3 LIVROS e quem lê cada um:
//   (a) op_material_events  ('devolvido')  -> o razão per-OP (WIP do chão de fábrica) da 008.
//   (b) stock (via StockService.receive, op_id = POOLED = NULL) -> o físico central do ALMOX. É
//       POOLED de propósito (decisão: crédito central igual ao resto do sistema) — assim o grão
//       do estoque continua FECHADO (uma linha por produto, op_id NULL), sem abrir dimensão por OP.
//   (c) op_returns          -> o livro do CONFERIDO, que o total_cost (clients.controller) subtrai
//       do custo da OP. A linha SÓ nasce aqui, na conferência — nunca no registro.

import type { PoolClient } from 'pg';
import { StockService } from './stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from './warehouse';

// Erro de regra de negócio -> 400/404 no controller (espelha OpMatError/StockError: msg pronta pro operador).
export class ReturnError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ReturnError'; }
}

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

// ==========================================================================
// O DISPONÍVEL A DEVOLVER por (OP, produto) — a FONTE É O SALDO WIP PER-OP, não as saídas centrais.
//   disponível = SALDO_WIP − em_devolucao
//   SALDO_WIP  = (recebido + transferido_in) − (consumido + devolvido + transferido_out)   [008]
//   em_devolucao = Σ pendente (op_returns_pending)                                          [a janela de trânsito]
//
// POR QUE O SALDO WIP e não as saídas de separação: só se devolve o que ainda está no armazém da OP.
// Material já apontado como consumido saiu do saldo WIP -> não é devolvível. Basear no withdrawn
// central deixaria devolver material já consumido -> saldo per-OP a NEGATIVO -> projeção quebrada.
//
// ⚠ A parte do SALDO usa a MESMA fórmula do SALDO_SQL do opMaterials.controller (a projeção da 008).
// São duas cópias da mesma verdade: se o sinal de algum event_type mudar lá, muda AQUI.
//
// Fonte ÚNICA pro guard (availableToReturn) e pra lista (listReturnableItems) — não podem divergir.
// ==========================================================================
async function availableToReturn(
  client: PoolClient,
  clientServiceId: string,
  productId: string,
): Promise<{ saldo: number; emDevolucao: number; available: number }> {
  const { rows } = await client.query(
    `SELECT
        COALESCE((SELECT COALESCE(SUM(qty) FILTER (WHERE event_type IN ('recebido','transferido_in')), 0)
                       - COALESCE(SUM(qty) FILTER (WHERE event_type IN ('consumido','devolvido','transferido_out')), 0)
                    FROM op_material_events
                   WHERE client_service_id = $1 AND product_id = $2), 0) AS saldo,
        COALESCE((SELECT SUM(q.quantity)
                    FROM op_returns_pending q
                   WHERE q.client_service_id = $1 AND q.product_id = $2
                     AND q.status = 'pendente'), 0)                       AS em_devolucao`,
    [clientServiceId, productId],
  );
  const saldo = num(rows[0]?.saldo);
  const emDevolucao = num(rows[0]?.em_devolucao);
  return { saldo, emDevolucao, available: saldo - emDevolucao };
}

// ==========================================================================
// LISTA da tela de devolução (GET /stock/returns/op/:opCode).
// São os itens do SALDO WIP per-OP (a 008) com disponível a devolver > 0 — disponível = saldo −
// em_devolucao. OP legada (sem eventos per-OP) tem saldo 0 -> lista VAZIA -> a tela mostra a
// orientação de usar a Entrada de Reaproveitamento (limitação aceita e documentada na 009).
// ==========================================================================
export async function listReturnableItems(client: PoolClient, opCode: string): Promise<any[]> {
  const { rows } = await client.query(
    `WITH OPData AS (
        SELECT id FROM client_services WHERE op_code = $1
     ),
     Bal AS (
        -- saldo WIP por produto (a MESMA projeção do SALDO_SQL / getOpBalance)
        SELECT e.product_id,
               COALESCE(SUM(e.qty) FILTER (WHERE e.event_type IN ('recebido','transferido_in')), 0)
             - COALESCE(SUM(e.qty) FILTER (WHERE e.event_type IN ('consumido','devolvido','transferido_out')), 0) AS saldo
          FROM op_material_events e
         WHERE e.client_service_id = (SELECT id FROM OPData)
         GROUP BY e.product_id
     ),
     Pend AS (
        SELECT product_id, SUM(quantity) AS em_devolucao
          FROM op_returns_pending
         WHERE client_service_id = (SELECT id FROM OPData) AND status = 'pendente'
         GROUP BY product_id
     )
     SELECT b.product_id, p.sku, p.name, p.unit,
            b.saldo,
            COALESCE(pd.em_devolucao, 0)             AS em_devolucao,
            (b.saldo - COALESCE(pd.em_devolucao, 0)) AS available_to_return
       FROM Bal b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN Pend pd ON pd.product_id = b.product_id
      WHERE (b.saldo - COALESCE(pd.em_devolucao, 0)) > 0
      ORDER BY p.name ASC`,
    [opCode],
  );
  return rows.map((r) => ({
    product_id: r.product_id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    saldo: num(r.saldo),
    em_devolucao: num(r.em_devolucao),
    available_to_return: num(r.available_to_return),
  }));
}

// ==========================================================================
// 1) REGISTRO — o chão de fábrica declara a devolução. Vira pedido 'pendente' (em trânsito).
//    NÃO toca estoque, op_returns nem o razão per-OP: só reserva a janela de trânsito.
// ==========================================================================
export async function registerPendingReturns(
  client: PoolClient,
  params: { clientServiceId: string; items: Array<{ product_id: string; quantity: any; observation?: string | null }>; userId: string | null },
): Promise<any[]> {
  const { clientServiceId, items, userId } = params;
  if (!clientServiceId) throw new ReturnError('OP_OBRIGATORIA', 'Informe a OP.');
  if (!Array.isArray(items) || items.length === 0) throw new ReturnError('ITENS_OBRIGATORIOS', 'Informe ao menos um item para devolução.');

  // DEFESA (a UX já decide pelo has_perop_history do GET; isto é o backstop do backend): OP legada, sem
  // NENHUM evento per-OP, não tem saldo WIP -> devolução por aqui não faz sentido. Erro TIPADO
  // (SEM_RASTRO_PER_OP) pra não virar um genérico "acima do disponível 0".
  const rastro = await client.query('SELECT 1 FROM op_material_events WHERE client_service_id = $1 LIMIT 1', [clientServiceId]);
  if (rastro.rows.length === 0) {
    throw new ReturnError('SEM_RASTRO_PER_OP', 'OPs anteriores ao controle por OP: use a Entrada de Reaproveitamento.');
  }

  // AGREGA por produto ANTES de qualquer coisa: dois itens do mesmo produto no mesmo pedido viram
  // UMA linha pendente (o grão da janela é (OP, produto)); e a ordenação por product_id abaixo
  // deixa a aquisição de locks DETERMINÍSTICA (deadlock-safe entre pedidos concorrentes).
  const byProduct = new Map<string, { quantity: number; observation: string | null }>();
  for (const it of items) {
    const pid = it?.product_id;
    const qty = num(it?.quantity);
    if (!pid) throw new ReturnError('PRODUTO_OBRIGATORIO', 'Item inválido: falta o produto.');
    if (!(qty > 0)) throw new ReturnError('QTD_INVALIDA', 'Quantidade inválida para devolução.');
    const prev = byProduct.get(pid);
    byProduct.set(pid, { quantity: (prev?.quantity ?? 0) + qty, observation: prev?.observation ?? (it?.observation ?? null) });
  }

  const criados: any[] = [];
  for (const productId of [...byProduct.keys()].sort()) {
    const { quantity, observation } = byProduct.get(productId)!;

    // ADVISORY LOCK por (OP, produto) — o MESMO do consume e do 'devolvido' ('opmat:${op}:${produto}').
    // O disponível é o saldo WIP per-OP (PROJEÇÃO, sem linha pra FOR UPDATE): registro, apontamento e
    // conferência TÊM de se serializar sobre ESSE saldo, senão dois passam no guard e a projeção
    // per-OP vai a negativo. Por isso o lock é o 'opmat:' (o mesmo namespace da 008), não um próprio.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opmat:${clientServiceId}:${productId}`]);

    // Guard DEPOIS do lock (a ordem é o contrato — ler antes do lock não vale).
    const { saldo, available } = await availableToReturn(client, clientServiceId, productId);
    if (quantity > available) {
      throw new ReturnError('DEVOLUCAO_ACIMA_DO_DISPONIVEL',
        `Devolução acima do disponível na OP: o armazém da OP tem ${saldo} deste material` +
        ` (disponível ${available}, já descontado o que está em conferência) e tentou ${quantity}.` +
        (saldo <= 0 ? ' Se a OP é anterior ao controle por OP, use a Entrada de Reaproveitamento.' : ''));
    }

    const ins = await client.query(
      `INSERT INTO op_returns_pending (client_service_id, product_id, quantity, observation, requested_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, client_service_id, product_id, quantity, status, observation, created_at`,
      [clientServiceId, productId, quantity, observation, userId],
    );
    criados.push(ins.rows[0]);
  }
  return criados;
}

// ==========================================================================
// 2) CONFERÊNCIA — a TX TRIPLA. O almox conta `conferredQty` (<= pedido) e credita os 3 livros.
//    ⚠ ESTE É O PONTO DE REVISÃO: (a), (b) e (c) commitam JUNTOS com o fechamento do pedido, ou
//    a transação inteira faz rollback (o withTransaction do controller/smoke garante o atomic).
// ==========================================================================
export async function conferReturn(
  client: PoolClient,
  params: { requestId: string; conferredQty?: any; userId: string | null },
): Promise<{ request: any; conferredQty: number; central: any; opEvent: any; opReturnId: string }> {
  const { requestId, userId } = params;
  if (!requestId) throw new ReturnError('PEDIDO_OBRIGATORIO', 'Informe o pedido de devolução.');

  // 1. TRAVA o pedido. É a linha materializada do fluxo -> serializa duas conferências da MESMA
  //    devolução e é o guard de idempotência de negócio (status muda 1x só, sob trava).
  const reqRes = await client.query(
    `SELECT id, client_service_id, product_id, quantity, status FROM op_returns_pending WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  if (reqRes.rows.length === 0) throw new ReturnError('DEVOLUCAO_NAO_ENCONTRADA', 'Pedido de devolução não encontrado.');
  const pedido = reqRes.rows[0];
  // Já resolvido? Segunda conferência (ou conferir um rejeitado) é no-op de negócio -> 409-ish tratado
  // como erro claro. NÃO credita de novo (o físico ficaria dobrado).
  if (pedido.status !== 'pendente') {
    throw new ReturnError('DEVOLUCAO_JA_RESOLVIDA', `Esta devolução já está "${pedido.status}" — não dá pra conferir de novo.`);
  }

  const pedida = num(pedido.quantity);
  // conferredQty ausente -> confere o pedido inteiro. Presente -> tem de ser (0, pedida].
  const conferredQty = params.conferredQty === undefined || params.conferredQty === null ? pedida : num(params.conferredQty);
  if (!(conferredQty > 0)) throw new ReturnError('QTD_INVALIDA', 'A quantidade conferida precisa ser maior que zero (para recusar tudo, use a rejeição).');
  if (conferredQty > pedida) throw new ReturnError('CONFERIDO_ACIMA_DO_PEDIDO', `Conferido (${conferredQty}) acima do que foi enviado (${pedida}).`);

  const clientServiceId = pedido.client_service_id;
  const productId = pedido.product_id;

  // 2. ADVISORY LOCK per-OP do razão WIP — a 008 é explícita: 'devolvido' TEM de pegar o MESMO lock
  //    do consume ('opmat:${op}:${produto}'), senão a exclusão mútua com o apontamento não existe.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opmat:${clientServiceId}:${productId}`]);

  const warehouseId = await resolveWarehouseId(client, userId);
  const baseKey = `opret:confer:${requestId}`;

  // ── (a) LIVRO PER-OP: evento 'devolvido' (qty conferida) ────────────────────────────────────
  // NÃO gated por saldo per-OP DE PROPÓSITO. O histórico per-OP (op_material_events) é 100% NULL
  // pra material anterior ao cutoff de go-live (não há 'recebido' derivável) -> um guard "conferido
  // <= saldo WIP" recusaria devolução de QUALQUER OP legada. O portão de quantidade que vale é a
  // JANELA DE TRÂNSITO no registro (já barrou lá atrás; e conferredQty <= pedida). Aqui só
  // REGISTRAMOS a saída de WIP; o lock acima serializa contra o consume concorrente.
  const opEvent = await client.query(
    `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key)
     VALUES ('devolvido', $1, $2, $3, $4, $5)
     RETURNING id, event_type, client_service_id, product_id, qty, created_at`,
    [clientServiceId, productId, conferredQty, userId, `${baseKey}:devolvido`],
  );

  // ── (b) FÍSICO CENTRAL: receive POOLED (op_id = NULL) ───────────────────────────────────────
  // POOLED mantém o grão do estoque FECHADO: credita a única linha (produto, ALMOX, op_id NULL),
  // sem criar linha op_id != NULL. É o invariante que a smoke do grão verifica.
  const central = await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, conferredQty, {
    refType: 'op_return', refId: requestId, userId,
    opKey: `${baseKey}:receive`,
    reason: 'Devolução de material de OP (conferida)',
  });

  // ── (c) LIVRO DO CONFERIDO: op_returns (o que o total_cost subtrai) ──────────────────────────
  // Mesma forma do INSERT do registerReturn antigo — só que agora com conferredQty e SÓ na
  // conferência. É esta linha, e só ela, que abate o custo da OP no clients.controller.
  const retRes = await client.query(
    `INSERT INTO op_returns (client_service_id, product_id, quantity, user_id, observation)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [clientServiceId, productId, conferredQty, userId, 'Devolução conferida'],
  );
  const opReturnId = retRes.rows[0].id;

  // 3. FECHA o pedido: pendente -> conferido. Fora da janela de trânsito a partir daqui.
  const upd = await client.query(
    `UPDATE op_returns_pending
        SET status = 'conferido', conferred_qty = $2, conferred_by = $3, resolved_at = now()
      WHERE id = $1
      RETURNING id, client_service_id, product_id, quantity, conferred_qty, status, resolved_at`,
    [requestId, conferredQty, userId],
  );

  return { request: upd.rows[0], conferredQty, central, opEvent: opEvent.rows[0], opReturnId };
}

// ==========================================================================
// 3) REJEIÇÃO — o almox recusa. Fecha o pedido 'rejeitado'. NÃO credita nenhum livro; só devolve a
//    quantidade à janela de trânsito (ela para de ser descontada por não ser mais 'pendente').
// ==========================================================================
export async function rejectReturn(
  client: PoolClient,
  params: { requestId: string; reason?: string | null; userId: string | null },
): Promise<any> {
  const { requestId, reason, userId } = params;
  if (!requestId) throw new ReturnError('PEDIDO_OBRIGATORIO', 'Informe o pedido de devolução.');

  const reqRes = await client.query(
    `SELECT id, status FROM op_returns_pending WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  if (reqRes.rows.length === 0) throw new ReturnError('DEVOLUCAO_NAO_ENCONTRADA', 'Pedido de devolução não encontrado.');
  if (reqRes.rows[0].status !== 'pendente') {
    throw new ReturnError('DEVOLUCAO_JA_RESOLVIDA', `Esta devolução já está "${reqRes.rows[0].status}" — não dá pra rejeitar.`);
  }

  const upd = await client.query(
    `UPDATE op_returns_pending
        SET status = 'rejeitado', reject_reason = $2, conferred_by = $3, resolved_at = now()
      WHERE id = $1
      RETURNING id, client_service_id, product_id, quantity, status, reject_reason, resolved_at`,
    [requestId, reason ?? null, userId],
  );
  return upd.rows[0];
}
