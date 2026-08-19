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
// Montagem v1 (016): o consume valida a ETIQUETA de máquina sem duplicar a regra de quem é dona.
import { machinePorId } from './assembly.controller';
// GUARD-RECEBIMENTO (18/08/2026): o de-para de setor→armazém (lote D1) é a fonte que diz se um
// setor tem custódia. canonSetor normaliza a grafia suja de separations.destination/profiles.sector
// antes de comparar (ver src/services/setor.ts — 25+29 valores medidos, zero desconhecido).
import { canonSetor, resolveDestinationWarehouse } from '../services/setor';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// CUTOFF DE GO-LIVE do armazém per-OP. Sem ele a fila do Recebimento nasce com ~77 separações /
// 276 itens desde 27/02: material que saiu do almox há meses e já foi consumido no chão de fábrica.
// Ninguém vai "receber" aquilo — é fila morta que esconde o trabalho real.
//
// O CAMPO: não existe delivered_at nem updated_at em separations; só created_at e sent_at.
// COALESCE(sent_at, created_at) é o timestamp de ENTREGA de verdade nos dois caminhos:
//   - 'entregue' (Quadro Gestão): sent_at é gravado pelo authorize action='entregar' e cobre 13/13
//     das linhas. Usar created_at aqui seria errado — a entrega acontece até 84 dias depois da
//     criação nos dados reais.
//   - 'concluida' (saída manual): sent_at é NULL em 532/532 (manualWithdrawal não grava), MAS a
//     separação é criada E consumida na MESMA transação -> created_at É o instante da entrega.
// LIMITAÇÃO: uma linha 'entregue' com sent_at NULL cairia no created_at e poderia entrar na fila
// cedo demais. Hoje não existe nenhuma (13/13 têm sent_at); se o authorize algum dia deixar de
// gravar sent_at, este filtro passa a mentir. O certo de vez é um delivered_at próprio.
const CUTOFF_DEFAULT = '2026-07-17';
const CUTOFF_DATE = (process.env.PEROP_CUTOFF_DATE || '').trim() || CUTOFF_DEFAULT;

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
        `SELECT id, status, client_service_id, destination FROM separations WHERE id = $1 FOR UPDATE`,
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

      // 2b. GUARD DE CUSTÓDIA POR SETOR (decisões D1/D2/D3 do lote GUARD-RECEBIMENTO, 18/08/2026).
      //
      // D1 primeiro, e para TODO MUNDO (inclusive isMaster): se o destino da separação não tem
      // armazém no de-para (canonSetor(destination) -> null em SETOR_ARMAZEM), o material foi
      // consumido na entrega, não fica em custódia de setor nenhum — não há "o quê" receber aqui.
      // Nem o master recebe o que não tem custódia; isto não é permissão, é o recurso não existir.
      const destino = resolveDestinationWarehouse(sep.rows[0].destination);
      if (destino.code === null) {
        throw new OpMatError('SETOR_SEM_CUSTODIA', 'Este setor não tem armazém — o material foi consumido na entrega, não há recebimento a confirmar aqui.');
      }
      // D2/D3: admin e almoxarife são chave-mestra (recebem de qualquer setor); operador comum só
      // confirma o que foi destinado ao PRÓPRIO setor — cross-setor é bloqueio (403), não aviso.
      const perfil = await client.query(`SELECT role, sector FROM profiles WHERE id = $1`, [userId]);
      const isMaster = perfil.rows[0]?.role === 'admin' || perfil.rows[0]?.role === 'almoxarife';
      if (!isMaster) {
        const operadorCanon = canonSetor(perfil.rows[0]?.sector ?? null);
        if (canonSetor(sep.rows[0].destination) !== operadorCanon) {
          throw new OpMatError('SETOR_ALHEIO', 'Só o setor de destino pode confirmar este recebimento.');
        }
      }

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
//
// machineId é OPCIONAL (migration 016, Montagem v1): ETIQUETA o evento com a máquina que
// recebeu o material. É DIMENSÃO, não eixo — repare no que NÃO mudou abaixo: o op_key, o
// pré-check de replay, o advisory lock `opmat:<OP>:<produto>` e o guard de projeção continuam
// exatamente como estavam. Saldo por máquina seria a mesma classe de erro do op_id no stock.
// Consumo SEM machineId segue válido (machine_id NULL) — retrocompatível por decisão.
// ==========================================================================
export const consumeOpMaterial = async (req: Request, res: Response) => {
  const { clientServiceId, productId, qty, machineId } = req.body ?? {};
  const userId = (req as any).user?.id ?? null;
  const idemKey = idemFrom(req);
  const quantidade = num(qty);

  try {
    if (!clientServiceId) throw new OpMatError('OP_OBRIGATORIA', 'Informe a OP.');
    if (!productId) throw new OpMatError('PRODUTO_OBRIGATORIO', 'Informe o produto.');
    if (!(quantidade > 0)) throw new OpMatError('QTD_INVALIDA', 'Quantidade precisa ser maior que zero.');
    if (!idemKey) throw new OpMatError('IDEMPOTENCY_KEY_OBRIGATORIA', 'Header X-Idempotency-Key é obrigatório neste endpoint.');

    // Etiqueta opcional. Validada ANTES da transação: é regra de entrada, não de saldo.
    let maquinaId: string | null = null;
    if (machineId !== undefined && machineId !== null && String(machineId).trim() !== '') {
      maquinaId = String(machineId).trim();
      if (!UUID_RE.test(maquinaId)) throw new OpMatError('MAQUINA_INVALIDA', 'machineId inválido.');
      const maq = await machinePorId(maquinaId);
      if (!maq) throw new OpMatError('MAQUINA_NAO_ENCONTRADA', 'Máquina não encontrada.');
      // ⚠ GUARD DE INTEGRIDADE CENTRAL: a árvore da máquina NUNCA mistura OP. Sem ele, um
      // consumo da OP-B etiquetado com máquina da OP-A criaria uma ficha técnica que o razão
      // da OP-A não sustenta — número bonito e mentiroso, que é o que esta peça inteira evita.
      if (String(maq.client_service_id) !== String(clientServiceId)) {
        throw new OpMatError('MAQUINA_DE_OUTRA_OP',
          `Máquina pertence à OP ${maq.client_service_id}, consumo é da OP ${clientServiceId}. A árvore de uma máquina só recebe material da própria OP.`);
      }
      // Futuro-proof: hoje não há caminho pra 'concluida' (v1 recusa a transição), mas quando a
      // v2 congelar a ficha, apontar material numa máquina fechada tem que doer aqui.
      if (maq.status === 'concluida') {
        throw new OpMatError('MAQUINA_CONCLUIDA', 'Máquina concluída não recebe mais material.');
      }
    }

    const opKey = `opmat:cons:${idemKey}`;

    const result = await withTransaction(async (client) => {
      // 1. PRÉ-CHECK antes de tudo (mesma razão do receive: replay não pode brigar com o guard de saldo).
      const ja = await client.query(
        `SELECT id, event_type, client_service_id, product_id, qty, machine_id, created_at FROM op_material_events WHERE op_key = $1`,
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
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key, machine_id)
         VALUES ('consumido', $1, $2, $3, $4, $5, $6)
         RETURNING id, event_type, client_service_id, product_id, qty, machine_id, created_at`,
        [clientServiceId, productId, quantidade, userId, opKey, maquinaId],
      );
      return { evento: ins.rows[0], saldoRestante: saldo - quantidade, idempotent: false };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    return mapError(error, res, 'consume');
  }
};

// ==========================================================================
// b2) POST /op-materials/transfer — transferência de material OP -> OP (peça 4).
//     WIP -> WIP: NÃO toca o físico central (doutrina do módulo — o material já saiu do ALMOX
//     na entrega da separação; aqui ele só muda de OP). Par de eventos no MESMO commit:
//     'transferido_out' na origem e 'transferido_in' no destino, com o IN apontando pro OUT
//     via ref_event_id — a direção prevista na 008.
//     SEM guard de status da OP: simétrico com o consume (decisão 24/07/2026 — o conserto dos
//     guards de OP fechada do sistema é peça própria; nascer assimétrico confundiria mais).
// ==========================================================================
export const transferOpMaterial = async (req: Request, res: Response) => {
  const { fromClientServiceId, toClientServiceId, productId, qty } = req.body ?? {};
  const userId = (req as any).user?.id ?? null;
  const idemKey = idemFrom(req);
  const quantidade = num(qty);

  try {
    if (!fromClientServiceId) throw new OpMatError('OP_ORIGEM_OBRIGATORIA', 'Informe a OP de origem.');
    if (!toClientServiceId) throw new OpMatError('OP_DESTINO_OBRIGATORIA', 'Informe a OP de destino.');
    if (String(fromClientServiceId) === String(toClientServiceId)) throw new OpMatError('OPS_IGUAIS', 'Origem e destino são a mesma OP.');
    if (!productId) throw new OpMatError('PRODUTO_OBRIGATORIO', 'Informe o produto.');
    if (!(quantidade > 0)) throw new OpMatError('QTD_INVALIDA', 'Quantidade precisa ser maior que zero.');
    if (!idemKey) throw new OpMatError('IDEMPOTENCY_KEY_OBRIGATORIA', 'Header X-Idempotency-Key é obrigatório neste endpoint.');

    // 1 chave -> 2 op_keys (o razão é por evento). O par comita atômico no withTransaction:
    // a presença do OUT no razão <=> o IN também está lá.
    const outKey = `opmat:xfer:${idemKey}:out`;
    const inKey = `opmat:xfer:${idemKey}:in`;

    const result = await withTransaction(async (client) => {
      // 1. PRÉ-CHECK do replay ANTES do guard de saldo (mesma razão do receive/consume: o retry
      //    de quem só perdeu a resposta não pode brigar com o saldo que ele próprio já moveu).
      const ja = await client.query(
        `SELECT id, event_type, client_service_id, product_id, qty, ref_event_id, created_at
           FROM op_material_events WHERE op_key = ANY($1)`,
        [[outKey, inKey]],
      );
      if (ja.rows.length > 0) {
        const out = ja.rows.find((r: any) => r.event_type === 'transferido_out') ?? null;
        const inn = ja.rows.find((r: any) => r.event_type === 'transferido_in') ?? null;
        return { out, in: inn, idempotent: true };
      }

      // 2. Existência das DUAS OPs (o FK só barraria no INSERT, com erro feio).
      const ops = await client.query(`SELECT id FROM client_services WHERE id = ANY($1)`, [[fromClientServiceId, toClientServiceId]]);
      const achadas = new Set(ops.rows.map((r: any) => String(r.id)));
      if (!achadas.has(String(fromClientServiceId))) throw new OpMatError('OP_ORIGEM_NAO_ENCONTRADA', 'OP de origem não encontrada.');
      if (!achadas.has(String(toClientServiceId))) throw new OpMatError('OP_DESTINO_NAO_ENCONTRADA', 'OP de destino não encontrada.');

      // 3. ADVISORY LOCK da ORIGEM — a MESMA string do consume (invariante D4: consume, devolver e
      //    transferir_out disputam o MESMO saldo e TÊM que se excluir mutuamente). O destino não
      //    trava: só recebe crédito, não há guard de saldo a proteger lá.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opmat:${fromClientServiceId}:${productId}`]);

      // 4. Guard de saldo na origem, DEPOIS do lock (a ordem é o contrato).
      const saldo = await saldoDe(client, fromClientServiceId, productId);
      if (quantidade > saldo) {
        throw new OpMatError('SALDO_INSUFICIENTE_NA_OP',
          `Saldo insuficiente na OP de origem: tem ${saldo} deste material no armazém da OP e tentou transferir ${quantidade}.`);
      }

      // 5. O par. IN aponta pro OUT via ref_event_id.
      const out = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key)
         VALUES ('transferido_out', $1, $2, $3, $4, $5)
         RETURNING id, event_type, client_service_id, product_id, qty, created_at`,
        [fromClientServiceId, productId, quantidade, userId, outKey],
      );
      const inn = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, ref_event_id, user_id, op_key)
         VALUES ('transferido_in', $1, $2, $3, $4, $5, $6)
         RETURNING id, event_type, client_service_id, product_id, qty, ref_event_id, created_at`,
        [toClientServiceId, productId, quantidade, out.rows[0].id, userId, inKey],
      );
      return { out: out.rows[0], in: inn.rows[0], saldoRestanteOrigem: saldo - quantidade, idempotent: false };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    return mapError(error, res, 'transfer');
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
//
// GUARD DE CUSTÓDIA POR SETOR (18/08/2026, mesmas decisões D1-D4 do POST /receive abaixo).
// O filtro de setor não é mais o ?sector= cru do caller (igualdade de string, e o front nunca
// mandava): o backend resolve pelo TOKEN. isMaster (admin/almoxarife) com ?scope=all vê a fila
// inteira (menos D1); qualquer outro caso — operador comum, OU master sem ?scope=all — vê só o
// próprio setor. O front NÃO decide isso; ele só pede, e é ignorado se não tiver o papel.
//
// FILTRO EM JS, NÃO EM SQL (escolha deliberada — a outra opção era enumerar em SQL todas as
// grafias cruas que canonizam para o setor do operador, tipo ANY(['ELETRICA','Elétrica',...]) —
// funciona, mas fica presa a uma lista que precisa ser re-derivada toda vez que uma grafia nova
// aparecer em produção). canonSetor é TypeScript, não SQL: buscar sem filtro de setor e aplicar
// resolveDestinationWarehouse/canonSetor por linha em JS não depende de enumerar nada, e o custo
// (trazer linhas que o JS descarta) é desprezível — a fila inteira tem ~82 linhas hoje.
// ==========================================================================
export const getPendingReceipts = async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null;
  const scopeAll = typeof req.query.scope === 'string' && req.query.scope.trim().toLowerCase() === 'all';
  try {
    const perfil = await pool.query(`SELECT role, sector FROM profiles WHERE id = $1`, [userId]);
    const isMaster = perfil.rows[0]?.role === 'admin' || perfil.rows[0]?.role === 'almoxarife';
    const operadorCanon = canonSetor(perfil.rows[0]?.sector ?? null);
    const verTudo = isMaster && scopeAll; // scope=all só tem efeito para quem TEM o papel — fail-closed

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
        WHERE s.status = ANY($1)
          -- OP real obrigatória: NULL = pooled = sem armazém de OP pra alimentar.
          AND s.client_service_id IS NOT NULL
          -- Cutoff de go-live: só entrega a partir da virada. Ver CUTOFF_DATE.
          AND COALESCE(s.sent_at, s.created_at) >= $2::timestamp
          -- só o que ainda falta receber. Item autorizado com quantity=0 (35 dos 318 entregues hoje)
          -- nunca saiu do almox -> teto 0 -> não entra na fila.
          AND si.quantity > COALESCE(r.total, 0)
        ORDER BY COALESCE(s.sent_at, s.created_at) DESC NULLS LAST, p.name ASC`,
      [STATUS_ENTREGUES, CUTOFF_DATE],
    );
    const visiveis = rows.filter((r) => {
      // D1 vale para TODO MUNDO, inclusive o "ver tudo" do master: setor sem armazém não é
      // recebível por ninguém — não existe custódia pra confirmar.
      if (resolveDestinationWarehouse(r.sector).code === null) return false;
      if (verTudo) return true;
      return canonSetor(r.sector) === operadorCanon;
    });
    return res.json(visiveis.map((r) => ({
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
// e) GET /op-materials/events/:clientServiceId — extrato do razão da OP (read-only).
//    ?event_type= filtra um tipo (o Apontamentos usa 'consumido' pra listar os apontamentos).
//    LIMIT 50 fixo: é extrato de tela, não relatório. Se virar relatório, paginar aqui.
// ==========================================================================
const EVENT_TYPES = ['recebido', 'consumido', 'devolvido', 'transferido_out', 'transferido_in'];

export const getOpEvents = async (req: Request, res: Response) => {
  const { clientServiceId } = req.params;
  const raw = typeof req.query.event_type === 'string' ? req.query.event_type.trim() : '';
  // Tipo inválido -> 400 em vez de devolver lista vazia (vazio mentiria "a OP não tem nada").
  if (raw && !EVENT_TYPES.includes(raw)) {
    return res.status(400).json({ error: `event_type inválido. Use um de: ${EVENT_TYPES.join(', ')}.` });
  }
  const tipo = raw || null;
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.event_type, e.qty, e.created_at,
              e.product_id, p.sku, p.name, p.unit,
              e.ref_separation_id, e.ref_separation_item_id, e.ref_event_id,
              e.user_id, pr.name AS user_name
         FROM op_material_events e
         JOIN products p       ON p.id = e.product_id
         LEFT JOIN profiles pr ON pr.id = e.user_id
        WHERE e.client_service_id = $1
          AND ($2::text IS NULL OR e.event_type = $2)
        ORDER BY e.created_at DESC
        LIMIT 50`,
      [clientServiceId, tipo],
    );
    return res.json(rows.map((r) => ({
      id: r.id, event_type: r.event_type, qty: num(r.qty), created_at: r.created_at,
      product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
      ref_separation_id: r.ref_separation_id, ref_separation_item_id: r.ref_separation_item_id,
      ref_event_id: r.ref_event_id, user_id: r.user_id, user_name: r.user_name,
    })));
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_events_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao buscar o extrato da OP' });
  }
};

// ==========================================================================
// f) GET /op-materials/summary — os 3 KPIs do sub-razão pro Painel da Produção (read-only).
//    wip_unidades: Σ saldo projetado de TODAS as OPs (a fórmula única SALDO_SQL, sem grão).
//    wip_linhas: pares (OP, produto) com saldo > 0 — material distinto parado em chão de fábrica.
//    apontamentos_7d: eventos 'consumido' nos últimos 7 dias (1 evento = 1 apontamento).
//    recebimentos_pendentes: linhas da MESMA query da fila do Recebimento (condições idênticas
//    ao pending-receipts — se divergirem, o KPI mente sobre a fila).
// ==========================================================================
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ARMAZÉM DA PRODUÇÃO — o saldo de TODAS as OPs abertas numa resposta só (lote PG1).
//
// POR QUE EXISTE: a tela mostrava UMA OP por vez, atrás de um <select>. Para mostrar todas de
// uma vez o front teria de disparar um GET /balance/:csid por OP — 16 requisições no mount, hoje.
// O lote BW acabou de cortar 89% do payload da listagem de produtos; trocar 1 GET por 16 andaria
// na direção contrária. Este endpoint faz o MESMO cálculo do /balance/:csid, agregado por OP
// além de por produto: mesma fonte, mesma fórmula (SALDO_SQL), um agrupamento a mais.
//
// ⚠ O /balance/:csid CONTINUA INTOCADO — a tela de Apontamentos e a de Montagem o usam.
//
// CONTENÇÃO, DECIDIDA AGORA E NÃO DEPOIS (a lição do /separations, o único dos 8 que subiu sem
// janela e teve de ser remendado):
//
//   1. SÓ VÊM OPs QUE TÊM MATERIAL. É um INNER JOIN a partir de op_material_events, não um
//      LEFT JOIN a partir de client_services. OP aberta sem nenhum recebimento não tem o que
//      mostrar nesta tela — e é a maioria: medido em produção em 19/08/2026, 16 OPs abertas,
//      apenas 3 com material. O corte é semântico antes de ser de banda.
//
//   2. TETO DE OPs, com aviso honesto. `limit` clampado em [1, MAX_OPS]; a resposta declara
//      `total_ops` e `truncado` para que a tela possa dizer "mostrando N de M" em vez de mentir
//      por omissão. Truncar em silêncio é o que faz uma tela parecer completa quando não está.
//
//   TAMANHO MEDIDO (não estimado) — resposta real do endpoint, 19/08/2026:
//     hoje ......... 3 OPs · 4 linhas  ->  1,27 KB   (324 B por linha, medido)
//     100 OPs × 10 . 1.000 linhas      ->  ~316 KB   (projeção linear sobre os 324 B)
//     teto 200 × 10  2.000 linhas      ->  ~633 KB   e aí `truncado` acende.
//   Para efeito de comparação: a listagem /products depois do BW são 679 KB — ou seja, no TETO
//   este endpoint chegaria ao tamanho da maior resposta da casa. Se a projeção de 100 OPs virar
//   realidade, o próximo passo é PAGINAR POR OP, não aumentar o teto.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const MAX_OPS_ARMAZEM = 200;

export const getWarehouseByOp = async (req: Request, res: Response) => {
  const bruto = Number(req.query.limit);
  const limite = Number.isFinite(bruto) && bruto > 0 ? Math.min(Math.trunc(bruto), MAX_OPS_ARMAZEM) : MAX_OPS_ARMAZEM;
  try {
    // Quantas OPs abertas TÊM material — a constante contra a qual o truncamento se declara.
    // Consulta separada e barata (só conta), para que `total_ops` não dependa da janela.
    const totalRes = await pool.query(
      `SELECT COUNT(DISTINCT e.client_service_id)::int AS n
         FROM op_material_events e
         JOIN client_services cs ON cs.id = e.client_service_id
        WHERE cs.status <> 'concluido'`,
    );
    const totalOps = totalRes.rows[0]?.n ?? 0;

    // `status <> 'concluido'` e não `= 'em_andamento'`: OP_STATUS_VALIDOS tem os dois valores
    // hoje (clients.controller.ts:106), e se um terceiro estado nascer amanhã, "não concluída"
    // continua sendo a leitura certa de "ainda está com material na mão".
    const { rows } = await pool.query(
      `WITH ops AS (
         SELECT DISTINCT cs.id, cs.op_code
           FROM op_material_events e
           JOIN client_services cs ON cs.id = e.client_service_id
          WHERE cs.status <> 'concluido'
          ORDER BY cs.op_code ASC
          LIMIT $1
       )
       SELECT ops.id AS client_service_id, ops.op_code, cl.name AS client_name,
              e.product_id, p.sku, p.name, p.unit,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'recebido'), 0)        AS recebido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'consumido'), 0)       AS consumido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'devolvido'), 0)       AS devolvido,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'transferido_in'), 0)  AS transferido_in,
              COALESCE(SUM(e.qty) FILTER (WHERE e.event_type = 'transferido_out'), 0) AS transferido_out,
              ${SALDO_SQL} AS saldo
         FROM ops
         JOIN op_material_events e ON e.client_service_id = ops.id
         JOIN products p           ON p.id = e.product_id
         JOIN client_services cs   ON cs.id = ops.id
         LEFT JOIN clients cl      ON cl.id = cs.client_id
        GROUP BY ops.id, ops.op_code, cl.name, e.product_id, p.sku, p.name, p.unit
        ORDER BY ops.op_code ASC, p.name ASC`,
      [limite],
    );

    // Monta o agrupamento em JS e não em json_agg: a ORDEM importa para a grade, e json_agg sem
    // ORDER BY herda a ordem do executor (régua do Lote 0). O ORDER BY do SELECT acima já entrega
    // as linhas na ordem certa; aqui só se preserva.
    const porOp = new Map<string, any>();
    for (const r of rows) {
      const k = String(r.client_service_id);
      if (!porOp.has(k)) {
        porOp.set(k, {
          client_service_id: r.client_service_id,
          op_code: r.op_code,
          client_name: r.client_name || '',
          materiais: [],
        });
      }
      porOp.get(k).materiais.push({
        product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
        recebido: num(r.recebido), consumido: num(r.consumido), devolvido: num(r.devolvido),
        transferido_in: num(r.transferido_in), transferido_out: num(r.transferido_out),
        // Linha com saldo 0 VEM (a tela a marca "Consumido"): "recebi 10 e consumi 10" é
        // informação, não ausência — a mesma decisão do /balance/:csid, palavra por palavra.
        saldo: num(r.saldo),
      });
    }
    const ops = Array.from(porOp.values());

    return res.json({
      ops,
      total_ops: totalOps,
      truncado: totalOps > ops.length,
      limite,
    });
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_warehouse_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao carregar o armazém da produção' });
  }
};

export const getOpSummary = async (_req: Request, res: Response) => {
  try {
    const [wip, apont, pend] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(saldo), 0) AS unidades, COUNT(*) FILTER (WHERE saldo > 0) AS linhas
           FROM (SELECT client_service_id, product_id, ${SALDO_SQL} AS saldo
                   FROM op_material_events GROUP BY client_service_id, product_id) s`,
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM op_material_events
          WHERE event_type = 'consumido' AND created_at >= NOW() - INTERVAL '7 days'`,
      ),
      pool.query(
        `SELECT COUNT(*) AS n
           FROM separations s
           JOIN separation_items si ON si.separation_id = s.id
           LEFT JOIN LATERAL (
                SELECT SUM(e.qty) AS total FROM op_material_events e
                 WHERE e.ref_separation_item_id = si.id AND e.event_type = 'recebido'
           ) r ON TRUE
          WHERE s.status = ANY($1)
            AND s.client_service_id IS NOT NULL
            AND COALESCE(s.sent_at, s.created_at) >= $2::timestamp
            AND si.quantity > COALESCE(r.total, 0)`,
        [STATUS_ENTREGUES, CUTOFF_DATE],
      ),
    ]);
    return res.json({
      wip_unidades: num(wip.rows[0].unidades),
      wip_linhas: num(wip.rows[0].linhas),
      apontamentos_7d: num(apont.rows[0].n),
      recebimentos_pendentes: num(pend.rows[0].n),
    });
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_summary_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao calcular o resumo da produção' });
  }
};

// ==========================================================================
// Mapa de erro único: regra de negócio -> 400 com msg pronta; corrida na op_key -> idempotente;
// resto -> 500 com log estruturado (nunca vaza error.message cru pro cliente).
// ==========================================================================
function mapError(error: any, res: Response, where: string) {
  if (error instanceof OpMatError) {
    // SETOR_ALHEIO é BLOQUEIO de quem sou (D3), não erro de requisição — 403, não 400. Os demais
    // seguem a régua antiga: *_NAO_ENCONTRAD[AO] -> 404, resto -> 400 (inclusive SETOR_SEM_CUSTODIA:
    // é o recurso que não é recebível por ninguém, não uma questão de QUEM está pedindo).
    const status = error.code === 'SETOR_ALHEIO' ? 403
      : (error.code.endsWith('_NAO_ENCONTRADA') || error.code.endsWith('_NAO_ENCONTRADO')) ? 404
      : 400;
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
