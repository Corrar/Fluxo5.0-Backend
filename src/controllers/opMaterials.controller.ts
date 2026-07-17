// src/controllers/opMaterials.controller.ts — SUB-RAZÃO DE MATERIAL POR OP (peça 1 do módulo Produção).
//
// ⚠ NADA DE StockService AQUI, DE PROPÓSITO. O físico central já foi debitado lá atrás: a entrega da
// separação roda StockService.consume (separations.controller: action='entregar'), que tira o material
// do on_hand do ALMOX. A partir dali o material não é mais inventário — é WIP do setor, amarrado à OP.
// Este módulo é o razão desse estágio seguinte, não uma segunda contabilidade do mesmo saldo.
// Chamar o StockService daqui debitaria o físico DUAS vezes.
//
// Espelha a filosofia do stock_ledger: append-only, imutável, idempotente por op_key (UNIQUE).
// Saldo per-OP = PROJEÇÃO, nunca materializada:
//   Σ recebido + Σ transferido_in − Σ consumido − Σ devolvido − Σ transferido_out
import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import type { PoolClient } from 'pg';

// Erro de regra de negócio -> 400 (espelha o StockError do motor: mensagem pronta pro operador).
class OpMatError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'OpMatError'; }
}

// X-Idempotency-Key: string não-vazia -> âncora estável. array (header repetido) / ausente / vazio -> null.
function idemFrom(req: Request): string | null {
  const raw = req.headers['x-idempotency-key'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function num(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

// Status de separação em que o material JÁ SAIU do físico central (os dois rodaram
// StockService.consume) e portanto alimentam o armazém da OP (D2):
//   'entregue'  -> Quadro Gestão (authorizeSeparation action='entregar')
//   'concluida' -> saída manual (manualWithdrawal) — com OP real, ENTRA na fila
// Usado nos DOIS lados: no teto do receive e no filtro do pending-receipts. Se divergirem, a
// fila lista o que o submit recusa.
const STATUS_ENTREGUES = ['entregue', 'concluida'];

// Fórmula da projeção em UM lugar só. Todo saldo per-OP passa por aqui — se um event_type novo
// entrar no CHECK da 008, é ESTE trecho que decide o sinal dele (e só ele).
const SALDO_SQL = `
  COALESCE(SUM(qty) FILTER (WHERE event_type IN ('recebido','transferido_in')), 0)
  - COALESCE(SUM(qty) FILTER (WHERE event_type IN ('consumido','devolvido','transferido_out')), 0)
`;

// Saldo de UM produto numa OP. Só chame com a OP já travada (ver consumeOpMaterial).
async function saldoDe(client: PoolClient, clientServiceId: string, productId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT ${SALDO_SQL} AS saldo FROM op_material_events WHERE client_service_id = $1 AND product_id = $2`,
    [clientServiceId, productId],
  );
  return num(rows[0]?.saldo);
}

// ==========================================================================
// a) POST /op-materials/receive — o setor confirma o que recebeu da separação entregue.
// ==========================================================================
export const receiveOpMaterial = async (req: Request, res: Response) => {
  const { separationId, items } = req.body ?? {};
  const userId = (req as any).user?.id ?? null;
  const idemKey = idemFrom(req);

  try {
    if (!separationId) throw new OpMatError('SEPARACAO_OBRIGATORIA', 'Informe a separação de origem.');
    if (!Array.isArray(items) || items.length === 0) throw new OpMatError('ITENS_OBRIGATORIOS', 'Informe ao menos um item recebido.');
    if (!idemKey) throw new OpMatError('IDEMPOTENCY_KEY_OBRIGATORIA', 'Header X-Idempotency-Key é obrigatório neste endpoint.');

    const result = await withTransaction(async (client) => {
      // 1. Trava a separação: serializa recebimentos concorrentes DA MESMA separação, que é onde
      //    o teto por item pode ser furado por corrida.
      const sep = await client.query(
        `SELECT id, status, client_service_id FROM separations WHERE id = $1 FOR UPDATE`,
        [separationId],
      );
      if (sep.rows.length === 0) throw new OpMatError('SEPARACAO_NAO_ENCONTRADA', 'Separação não encontrada.');
      // Mesma lista do pending-receipts (D2): 'entregue' (Quadro Gestão) e 'concluida' (saída
      // manual). Aceitar aqui só 'entregue' listaria saída manual na fila e recusaria no submit.
      if (!STATUS_ENTREGUES.includes(sep.rows[0].status)) {
        throw new OpMatError('SEPARACAO_NAO_ENTREGUE', `Só dá pra receber separação já entregue (esta está "${sep.rows[0].status}").`);
      }
      // 2. A OP vem da SEPARAÇÃO, nunca do body — o body não escolhe pra qual OP o material vai.
      const clientServiceId = sep.rows[0].client_service_id;
      if (!clientServiceId) throw new OpMatError('SEPARACAO_SEM_OP', 'Separação não tem OP vinculada — não alimenta o armazém da OP.');

      const criados: any[] = [];
      const replays: string[] = [];

      for (const it of items) {
        const qty = num(it?.qty);
        if (!(qty > 0)) throw new OpMatError('QTD_INVALIDA', 'Quantidade recebida precisa ser maior que zero.');

        // 3. Resolve a linha entregue: por itemId (preciso) ou por productId (conveniência da tela).
        const li = it?.itemId
          ? await client.query(`SELECT id, product_id, quantity FROM separation_items WHERE id = $1 AND separation_id = $2`, [it.itemId, separationId])
          : await client.query(`SELECT id, product_id, quantity FROM separation_items WHERE separation_id = $1 AND product_id = $2`, [separationId, it?.productId]);
        if (li.rows.length === 0) throw new OpMatError('ITEM_NAO_ENCONTRADO', 'Item não pertence a esta separação.');
        if (li.rows.length > 1) throw new OpMatError('ITEM_AMBIGUO', 'Produto repetido nesta separação — mande itemId em vez de productId.');
        const itemId = li.rows[0].id;
        const productId = li.rows[0].product_id;
        const entregue = num(li.rows[0].quantity);

        const opKey = `opmat:recv:${idemKey}:sep:${separationId}:item:${itemId}`;

        // 4. PRÉ-CHECK no razão próprio, ANTES do teto: se esta op_key já existe, é replay do mesmo
        //    POST. Tem que sair fora sem contar contra o teto — senão o retry se auto-rejeita
        //    ("já recebeu 5 de 5") e o cliente que só perdeu a resposta toma 400 pra sempre.
        const ja = await client.query(`SELECT id FROM op_material_events WHERE op_key = $1`, [opKey]);
        if (ja.rows.length > 0) { replays.push(itemId); continue; }

        // 5. TETO: recebimento PARCIAL é ok; ultrapassar o entregue não.
        const rec = await client.query(
          `SELECT COALESCE(SUM(qty), 0) AS total FROM op_material_events
            WHERE ref_separation_item_id = $1 AND event_type = 'recebido'`,
          [itemId],
        );
        const jaRecebido = num(rec.rows[0].total);
        const teto = entregue - jaRecebido;
        if (qty > teto) {
          throw new OpMatError('RECEBIMENTO_ACIMA_DO_ENTREGUE',
            `Recebimento acima do entregue: a separação entregou ${entregue} e já recebeu ${jaRecebido} (resta ${teto}).`);
        }

        const ins = await client.query(
          `INSERT INTO op_material_events
             (event_type, client_service_id, product_id, qty, ref_separation_id, ref_separation_item_id, user_id, op_key)
           VALUES ('recebido', $1, $2, $3, $4, $5, $6, $7)
           RETURNING id, event_type, client_service_id, product_id, qty, created_at`,
          [clientServiceId, productId, qty, separationId, itemId, userId, opKey],
        );
        criados.push(ins.rows[0]);
      }

      return { clientServiceId, criados, replays, idempotent: criados.length === 0 && replays.length > 0 };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    return mapError(error, res, 'receive');
  }
};

// ==========================================================================
// b) POST /op-materials/consume — o apontamento do montador (peça a peça).
// ==========================================================================
export const consumeOpMaterial = async (req: Request, res: Response) => {
  const { clientServiceId, productId, qty } = req.body ?? {};
  const userId = (req as any).user?.id ?? null;
  const idemKey = idemFrom(req);
  const quantidade = num(qty);

  try {
    if (!clientServiceId) throw new OpMatError('OP_OBRIGATORIA', 'Informe a OP.');
    if (!productId) throw new OpMatError('PRODUTO_OBRIGATORIO', 'Informe o produto.');
    if (!(quantidade > 0)) throw new OpMatError('QTD_INVALIDA', 'Quantidade precisa ser maior que zero.');
    if (!idemKey) throw new OpMatError('IDEMPOTENCY_KEY_OBRIGATORIA', 'Header X-Idempotency-Key é obrigatório neste endpoint.');

    const opKey = `opmat:cons:${idemKey}`;

    const result = await withTransaction(async (client) => {
      // 1. PRÉ-CHECK antes de tudo (mesma razão do receive: replay não pode brigar com o guard de saldo).
      const ja = await client.query(
        `SELECT id, event_type, client_service_id, product_id, qty, created_at FROM op_material_events WHERE op_key = $1`,
        [opKey],
      );
      if (ja.rows.length > 0) return { evento: ja.rows[0], idempotent: true };

      // 2. Existência da OP (o FK só barraria no INSERT, com erro feio).
      const op = await client.query(`SELECT id FROM client_services WHERE id = $1`, [clientServiceId]);
      if (op.rows.length === 0) throw new OpMatError('OP_NAO_ENCONTRADA', 'OP não encontrada.');

      // 3. ADVISORY LOCK por (OP, produto) — o ponto crítico do desenho (D4).
      //    O saldo per-OP é PROJEÇÃO e NÃO existe linha pra travar com FOR UPDATE (é justamente
      //    o papel que a tabela `stock` cumpre pro stock_ledger: alvo da trava + CHECKs). Sem
      //    trava, dois consumos concorrentes leem a MESMA projeção, os dois passam no guard e o
      //    saldo fica NEGATIVO — e num razão append-only não há CHECK que segure depois do fato.
      //    O advisory é xact: o Postgres solta sozinho no COMMIT/ROLLBACK, não há o que vazar.
      //    Granularidade (OP, produto): dois montadores apontando materiais DIFERENTES da mesma
      //    OP não esperam um pelo outro — só serializa quem disputa o mesmo saldo.
      //    ⚠ INVARIANTE: devolver e transferir_out (peça 4) TÊM que pegar ESTE MESMO lock, com a
      //    mesma string, senão a exclusão mútua não existe. receive NÃO precisa — só soma, e o
      //    teto dele já é serializado pelo FOR UPDATE da separation.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opmat:${clientServiceId}:${productId}`]);

      // 4. Guard de saldo: projeção calculada NA MESMA TX, DEPOIS do lock. A ordem é o contrato —
      //    ler antes do lock não vale nada.
      const saldo = await saldoDe(client, clientServiceId, productId);
      if (quantidade > saldo) {
        throw new OpMatError('SALDO_INSUFICIENTE_NA_OP',
          `Saldo insuficiente na OP: tem ${saldo} deste material no armazém da OP e tentou apontar ${quantidade}.`);
      }

      const ins = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key)
         VALUES ('consumido', $1, $2, $3, $4, $5)
         RETURNING id, event_type, client_service_id, product_id, qty, created_at`,
        [clientServiceId, productId, quantidade, userId, opKey],
      );
      return { evento: ins.rows[0], saldoRestante: saldo - quantidade, idempotent: false };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    return mapError(error, res, 'consume');
  }
};

// ==========================================================================
// c) GET /op-materials/balance/:clientServiceId — a projeção. É o que a tela Armazém renderiza.
// ==========================================================================
export const getOpBalance = async (req: Request, res: Response) => {
  const { clientServiceId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT e.product_id,
              p.sku, p.name, p.unit,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'recebido'), 0)        AS recebido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'consumido'), 0)       AS consumido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'devolvido'), 0)       AS devolvido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'transferido_in'), 0)  AS transferido_in,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'transferido_out'), 0) AS transferido_out,
              ${SALDO_SQL} AS saldo
         FROM op_material_events e
         JOIN products p ON p.id = e.product_id
        WHERE e.client_service_id = $1
        GROUP BY e.product_id, p.sku, p.name, p.unit
        ORDER BY p.name ASC`,
      [clientServiceId],
    );
    // Devolve linha com saldo 0 também: "recebi 10 e consumi 10" é informação, não ausência.
    return res.json(rows.map((r) => ({
      product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
      recebido: num(r.recebido), consumido: num(r.consumido), devolvido: num(r.devolvido),
      transferido_in: num(r.transferido_in), transferido_out: num(r.transferido_out),
      saldo: num(r.saldo),
    })));
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_balance_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao calcular saldo da OP' });
  }
};

// ==========================================================================
// d) GET /op-materials/pending-receipts — a fila da tela Recebimento.
//    POOLED FICA FORA (D2): não existe linha sentinela de OP "pooled" em client_services —
//    pooled é literalmente client_service_id IS NULL (o mesmo sentido do POOLED_OP_ID = null
//    do motor). Então o filtro "!= POOLED" se resolve inteiro no IS NOT NULL. Separação sem
//    OP não tem armazém de OP pra alimentar.
//    ?sector= filtra por separations.destination (opcional: o backend não sabe o setor do caller;
//    profiles.sector existe mas o de-para setor->destination não é confiável — destination é texto
//    livre sem allowlist. A tela manda o filtro; sem ele, devolve tudo).
// ==========================================================================
export const getPendingReceipts = async (req: Request, res: Response) => {
  const sector = typeof req.query.sector === 'string' && req.query.sector.trim() ? req.query.sector.trim() : null;
  try {
    const { rows } = await pool.query(
      `SELECT s.id                AS separation_id,
              s.destination       AS sector,
              s.status,
              -- saída manual não preenche sent_at (só o authorize 'entregar' preenche) -> cai no created_at
              COALESCE(s.sent_at, s.created_at) AS sent_at,
              cs.id               AS client_service_id,
              cs.op_code,
              si.id               AS item_id,
              si.product_id,
              p.sku, p.name, p.unit,
              si.quantity                          AS entregue,
              COALESCE(r.total, 0)                 AS recebido,
              si.quantity - COALESCE(r.total, 0)   AS pendente
         FROM separations s
         JOIN separation_items si ON si.separation_id = s.id
         JOIN products p          ON p.id = si.product_id
         JOIN client_services cs  ON cs.id = s.client_service_id
         LEFT JOIN LATERAL (
              SELECT SUM(e.qty) AS total FROM op_material_events e
               WHERE e.ref_separation_item_id = si.id AND e.event_type = 'recebido'
         ) r ON TRUE
        WHERE s.status = ANY($2)
          -- OP real obrigatória: NULL = pooled = sem armazém de OP pra alimentar.
          AND s.client_service_id IS NOT NULL
          AND ($1::text IS NULL OR s.destination = $1)
          -- só o que ainda falta receber. Item autorizado com quantity=0 (35 dos 318 entregues hoje)
          -- nunca saiu do almox -> teto 0 -> não entra na fila.
          AND si.quantity > COALESCE(r.total, 0)
        ORDER BY COALESCE(s.sent_at, s.created_at) DESC NULLS LAST, p.name ASC`,
      [sector, STATUS_ENTREGUES],
    );
    return res.json(rows.map((r) => ({
      separation_id: r.separation_id, sector: r.sector, status: r.status, sent_at: r.sent_at,
      client_service_id: r.client_service_id, op_code: r.op_code,
      item_id: r.item_id, product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
      entregue: num(r.entregue), recebido: num(r.recebido), pendente: num(r.pendente),
    })));
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_pending_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao buscar recebimentos pendentes' });
  }
};

// ==========================================================================
// Mapa de erro único: regra de negócio -> 400 com msg pronta; corrida na op_key -> idempotente;
// resto -> 500 com log estruturado (nunca vaza error.message cru pro cliente).
// ==========================================================================
function mapError(error: any, res: Response, where: string) {
  if (error instanceof OpMatError) {
    const status = error.code.endsWith('_NAO_ENCONTRADA') || error.code.endsWith('_NAO_ENCONTRADO') ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
  // Corrida: dois POSTs idênticos com a MESMA chave, o perdedor bate na op_key UNIQUE. O
  // withTransaction fez ROLLBACK -> nada duplicou. Responde idempotente (espelha o 06fc48d).
  if (error?.code === '23505' && String(error?.constraint ?? '').includes('op_key')) {
    console.warn(JSON.stringify({ event: 'opmat_idempotent_conflict', where, detail: error?.detail ?? null }));
    return res.status(201).json({ success: true, idempotent: true });
  }
  console.error(JSON.stringify({ event: 'opmat_error', where, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
  return res.status(500).json({ error: 'Erro no armazém da OP' });
}
