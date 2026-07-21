import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

// ==========================================
// 1. CATÁLOGO DE PEÇAS 3D (Lê da tabela Products)
// ==========================================
export const get3DParts = async (req: Request, res: Response) => {
  try {
    // AND active = true: o DELETE /products/:id ARQUIVA (active=false), não apaga. Sem este filtro
    // a peça "excluída" pela tela reaparecia no próximo refetch do catálogo — o botão de excluir
    // parecia não funcionar. O catálogo 3D é uma view de products e tem de respeitar o arquivamento.
    //
    // `disponivel` e `pedidos` são ADITIVOS (a Vitrine 3D precisa deles; Catálogo/Dashboard/Demandas
    // ignoram). Ambos agregam ANTES de juntar, pelo mesmo motivo do low-stock: o stock tem 1 linha
    // por (product_id, warehouse_id) e mais as per-OP — juntar cru por product_id duplicaria a peça.
    //   disponivel = saldo POOLED somado entre armazéns (op_id IS NULL; material com op_id já está
    //                comprometido com uma OP e não pode ser separado pra outro pedido).
    //   pedidos    = quanto já foi solicitado da peça (ranking "Mais Solicitadas"). Exclui requests
    //                'rejeitado', que englobam os cancelamentos — pedido cancelado não é popularidade.
    const { rows } = await pool.query(`
        SELECT p.id, p.sku, p.name, p.image_url as image, p.production_minutes, p.filament_grams, p.description,
               (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0)) AS disponivel,
               COALESCE(rq.pedidos, 0) AS pedidos
          FROM products p
          LEFT JOIN (
            SELECT product_id, SUM(quantity_on_hand) AS on_hand, SUM(quantity_reserved) AS reserved
              FROM stock WHERE op_id IS NULL GROUP BY product_id
          ) s ON s.product_id = p.id
          LEFT JOIN (
            SELECT ri.product_id, SUM(ri.quantity_requested) AS pedidos
              FROM request_items ri JOIN requests r ON r.id = ri.request_id
             WHERE ri.product_id IS NOT NULL AND r.status <> 'rejeitado'
             GROUP BY ri.product_id
          ) rq ON rq.product_id = p.id
         WHERE p.is_3d = true AND p.active = true
         ORDER BY p.name ASC
    `);

    const formatted = rows.map(r => ({
       id: r.id,
       code: r.sku || 'S/N',
       name: r.name,
       image: r.image,
       productionMinutes: r.production_minutes || 0,
       filamentGrams: r.filament_grams || 0,
       material: 'Padrão',
       description: r.description,
       disponivel: Number(r.disponivel) || 0,
       pedidos: Number(r.pedidos) || 0
    }));
    
    res.json(formatted);
  } catch (error) {
    console.error("Erro detalhado no get3DParts:", error);
    res.status(500).json({ error: 'Erro ao buscar catálogo 3D' });
  }
};

export const update3DPartDetails = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { productionMinutes, filamentGrams, image, description } = req.body;
  try {
    await pool.query(
      `UPDATE products 
       SET production_minutes = $1, filament_grams = $2, image_url = $3, description = $4 
       WHERE id = $5`,
      [productionMinutes, filamentGrams, image, description, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar detalhes 3D da peça' });
  }
};

// ==========================================
// 2. DEMANDAS KANBAN (Conectado às Solicitações)
// ==========================================
export const getDemands = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
        SELECT d.id, d.product_id as "partId", d.request_id as "requestId", d.quantity,
               d.op_number as "opNumber", d.priority, d.status, d.notes,
               d.rejection_reason as "rejectionReason", d.created_at as "createdAt",
               p.name as requester
        FROM demands_3d d
        LEFT JOIN requests r ON d.request_id = r.id
        LEFT JOIN profiles p ON r.requester_id = p.id
        ORDER BY d.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar demandas 3D' });
  }
};

// Status de recusa do Kanban 3D (o front mapeia 'rejeitada' -> este valor em P3_DEM_FRONT2BACK).
const DEMAND_STATUS_REJEITADA = 'Rejeitada';
// Teto defensivo do texto livre (a coluna é TEXT, sem limite no banco).
const DEMAND_TEXT_MAX = 2000;
// Normaliza texto livre vindo do body: string vazia/whitespace/não-string -> null (não grava '').
const normText = (v: any): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, DEMAND_TEXT_MAX) : null;
};

export const updateDemandStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, reason } = req.body;
  const userId = (req as any).user.id;
  // Só faz sentido na transição p/ recusa; nos demais status o motivo é ignorado (ver UPDATE abaixo).
  const rejectionReason = normText(reason);

  try {
    await withTransaction(async (client) => {
      // GUARD DE RE-CONCLUSÃO: trava a LINHA da demanda ANTES de qualquer escrita -> consistente sob
      // concorrência (2 conclusões paralelas serializam aqui). Padrão do replenishments (4479760).
      const cur = await client.query('SELECT status, request_id, quantity, product_id FROM demands_3d WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) throw new Error('DEMANDA_NAO_ENCONTRADA');
      const atual = cur.rows[0].status;
      if (status === 'Concluída' && atual === 'Concluída') throw new Error('DEMANDA_JA_CONCLUIDA');
      if (status === 'Concluída' && atual === 'Cancelada') throw new Error('DEMANDA_CANCELADA');

      // UPDATE do status movido pra DEPOIS do guard (antes rodava antes do check).
      // rejection_reason só é TOCADA na transição p/ 'Rejeitada' — nos demais status a coluna fica
      // como está (o front só a exibe quando rejeitada, então um valor antigo é invisível; e não
      // apagá-la preserva o motivo se a demanda for reaberta e recusada de novo sem texto novo).
      // NUNCA escreve em `notes`: lá vive o resumo do pedido + a anotação livre. Ver migration 010.
      if (status === DEMAND_STATUS_REJEITADA) {
        await client.query(
          'UPDATE demands_3d SET status = $1, rejection_reason = $2 WHERE id = $3',
          [status, rejectionReason, id],
        );
      } else {
        await client.query('UPDATE demands_3d SET status = $1 WHERE id = $2', [status, id]);
      }

      if (status === 'Concluída') {
        const quantity = Number(cur.rows[0].quantity);
        const productId = cur.rows[0].product_id;
        const requestId = cur.rows[0].request_id;

        if (productId) {
          const warehouseId = await resolveWarehouseId(client, userId);
          // 1. Peça impressa ENTRA no físico. receive PRIMEIRO (aumenta disponível + cria a linha LAZY se faltar).
          //    op_key content-addressed: re-concluir com a mesma qty = no-op idempotente (fim da dupla entrada).
          await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, quantity, {
            refType: 'demand_3d', refId: id, userId,
            opKey: `demand:${id}:conclude:receive:${quantity}`,
            reason: 'Produção 3D concluída (entrada no estoque)',
          });
          // 2. SEGURA a peça produzida p/ a request 'aprovado' que a aguarda (decisão A). reserve DEPOIS
          //    (o receive já garantiu disponível). Sem isto, a peça viraria estoque livre -> furo na entrega.
          await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, quantity, {
            refType: 'demand_3d', refId: id, userId,
            opKey: `demand:${id}:conclude:reserve:${quantity}`,
            reason: 'Reserva da peça 3D produzida para a solicitação',
          });

          // Auditoria oficial (INALTERADA).
          await client.query(
            `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
            [userId, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: productId, quantity, reason: 'Produção 3D Concluída' })]
          );
        }

        // INALTERADO: marca a solicitação vinculada como aprovada.
        if (requestId) {
          await client.query(`UPDATE requests SET status = 'aprovado' WHERE id = $1`, [requestId]);
        }
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'DEMANDA_NAO_ENCONTRADA') return res.status(404).json({ error: 'Demanda não encontrada.' });
    if (error.message === 'DEMANDA_JA_CONCLUIDA') return res.status(400).json({ error: 'Demanda já concluída.' });
    if (error.message === 'DEMANDA_CANCELADA') return res.status(400).json({ error: 'Demanda cancelada.' });
    // Rede de segurança de concorrência: 2 conclusões paralelas com a MESMA op_key batem no índice único.
    // O withTransaction fez ROLLBACK -> nada duplicou; resposta idempotente (espelha o 4479760).
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      const opKeyConflict = /\(op_key\)=\(([^)]*)\)/.exec(error?.detail ?? '')?.[1] ?? null;
      console.warn(JSON.stringify({ event: 'demand3d_idempotent_conflict', op_key: opKeyConflict }));
      return res.json({ success: true });
    }
    res.status(500).json({ error: 'Erro ao mover demanda no Kanban' });
  }
};

// Edita a ANOTAÇÃO LIVRE da demanda. Campo separado do motivo da recusa (rejection_reason, 010):
// `notes` nasce com o resumo do pedido escrito pela requests.controller e o operador complementa.
// Não mexe em status nem em estoque -> sem transação, sem StockService, sem op_key.
export const updateDemandNotes = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { notes } = req.body;
  const userId = (req as any).user.id;
  const value = normText(notes); // '' / whitespace -> null (limpar a anotação é uma ação válida)

  try {
    const upd = await pool.query(
      'UPDATE demands_3d SET notes = $1 WHERE id = $2 RETURNING id, notes',
      [value, id],
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Demanda não encontrada.' });

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
      [userId, 'ANOTACAO_DEMANDA_3D', JSON.stringify({ demand_id: id })],
    );

    return res.json({ success: true, notes: upd.rows[0].notes });
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'demand3d_notes_error', id, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao salvar anotação da demanda' });
  }
};

// "Excluir" demanda = SOFT-CANCEL (status='Cancelada'), espelhando o deleteReplenishment.
//
// POR QUE NÃO HARD DELETE: a FK é demands_3d.request_id -> requests(id) ON DELETE CASCADE, ou seja o
// cascade corre no sentido request->demand. Apagar a DEMANDA não deixa órfão referencial, mas deixa
// um órfão de NEGÓCIO e silencioso: a solicitação continua aberta, possivelmente já com estoque
// reservado no ato da criação (o reserve parcial da requests.controller), e nada mais vai produzir o
// que falta. Pior: productions_3d.demand_id é ON DELETE SET NULL — apagar uma demanda que já teve
// produção desliga o histórico dela sem aviso (o ledger sobrevive, a rastreabilidade não).
// 'Cancelada' já é o status que o sistema escreve quando a solicitação de origem é cancelada.
export const deleteDemand = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      // FOR UPDATE: 2 cancelamentos paralelos serializam aqui (o 2º vê 'Cancelada' e cai no guard).
      const cur = await client.query('SELECT status FROM demands_3d WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) throw new Error('DEMANDA_NAO_ENCONTRADA');
      const atual = cur.rows[0].status;

      // Concluída MOVEU ESTOQUE (receive + reserve no updateDemandStatus). Cancelar aqui só trocaria
      // o rótulo e deixaria o saldo creditado sem contrapartida. A reversão correta é o
      // DELETE /producao-3d/productions/:id, que passa pelo reverseReceive e recusa se já foi consumido.
      if (atual === 'Concluída') throw new Error('DEMANDA_CONCLUIDA');
      if (atual === 'Cancelada') throw new Error('DEMANDA_JA_CANCELADA');

      await client.query("UPDATE demands_3d SET status = 'Cancelada' WHERE id = $1", [id]);
      await client.query(
        `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
        [userId, 'CANCELAR_DEMANDA_3D', JSON.stringify({ demand_id: id, status_anterior: atual })],
      );
    });

    return res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'DEMANDA_NAO_ENCONTRADA') return res.status(404).json({ error: 'Demanda não encontrada.' });
    if (error.message === 'DEMANDA_CONCLUIDA') return res.status(400).json({ error: 'Demanda concluída não pode ser cancelada — a peça já entrou no estoque. Apague o registro de produção para reverter.' });
    if (error.message === 'DEMANDA_JA_CANCELADA') return res.status(400).json({ error: 'Demanda já cancelada.' });
    console.error(JSON.stringify({ event: 'demand3d_cancel_error', id, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao cancelar demanda 3D' });
  }
};

// ==========================================
// 3. HISTÓRICO E REGISTO DE PRODUÇÃO (COM ESTOQUE AUTOMÁTICO)
// ==========================================

export const getProductions = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT p3d.id, p3d.product_id as "partId", p3d.demand_id as "demandId", p3d.quantity, 
             p3d.total_minutes as "totalMinutes", p3d.filament_grams as "filamentGrams", 
             p3d.date, pr.name as operator 
      FROM productions_3d p3d
      LEFT JOIN profiles pr ON p3d.operator_id = pr.id
      ORDER BY p3d.date ASC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar produções:', error);
    res.status(500).json({ error: 'Erro ao buscar produções' });
  }
};

// Colunas de retorno padrão de uma produção (mesmo shape do getProductions/replay idempotente).
const PRODUCTION_SELECT = `id, product_id as "partId", demand_id as "demandId", quantity,
  total_minutes as "totalMinutes", filament_grams as "filamentGrams", date, operator_id as operator`;

export const createProduction = async (req: Request, res: Response) => {
  const { partId, demandId, quantity, totalMinutes, filamentGrams, date } = req.body;
  const operatorId = (req as any).user?.id || null;
  const qty = Number(quantity);

  // X-Idempotency-Key (opcional): string não-vazia → âncora ESTÁVEL (idempotência cross-request).
  // array (header repetido) / ausente / vazio → tratado como ausente.
  const idemRaw = req.headers['x-idempotency-key'];
  const idemKey = typeof idemRaw === 'string' && idemRaw.trim() ? idemRaw.trim() : null;
  // op_key content-addressed. Com header, é conhecido ANTES do INSERT (permite o pré-check no razão).
  const idemOpKey = idemKey ? `production:idem:${idemKey}:product:${partId}:receive:${qty}` : null;

  try {
    const result = await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, operatorId);

      // PRÉ-CHECK (só com header): se o razão já tem esta op_key, o crédito já foi dado num POST anterior.
      // Devolve o registro existente SEM inserir outro em productions_3d (evita produção duplicada no
      // histórico em RETRY SEQUENCIAL). O ledger guarda ref_id = id da produção original.
      if (idemOpKey) {
        const led = await client.query('SELECT ref_id FROM stock_ledger WHERE op_key = $1 LIMIT 1', [idemOpKey]);
        if ((led.rowCount ?? 0) > 0) {
          const prod = await client.query(`SELECT ${PRODUCTION_SELECT} FROM productions_3d WHERE id = $1`, [led.rows[0].ref_id]);
          return prod.rows[0] ?? { success: true, idempotent: true };
        }
      }

      // 1. Registra a produção (id fresco). 2. Entra no físico via MOTOR (receive resolve warehouse +
      //    cria a linha LAZY — mata o 42P10 e o warehouse_id faltante do INSERT cru antigo).
      const prodRes = await client.query(
        `INSERT INTO productions_3d (product_id, demand_id, quantity, operator_id, total_minutes, filament_grams, date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PRODUCTION_SELECT}`,
        [partId, demandId || null, qty, operatorId, totalMinutes, filamentGrams, date],
      );
      const prod = prodRes.rows[0];

      // Sem header: fallback content-addressed pelo id FRESCO — NÃO dá idempotência cross-request
      // (cada POST = id novo = op_key nova = novo crédito). Documentado; use o header para blindar retry.
      const opKey = idemOpKey ?? `production:${prod.id}:receive:${qty}`;
      const reason = demandId ? 'Produção 3D (Demanda Kanban)' : 'Produção 3D (Estoque Livre)';

      // Produção LIVRE: só receive, SEM reserve (a reserva p/ request vive no updateDemandStatus).
      await StockService.receive(client, partId, warehouseId, POOLED_OP_ID, qty, {
        refType: 'production_3d', refId: prod.id, userId: operatorId, opKey, reason,
      });

      // PÓS-CHECK de corrida (só com header): se o razão desta op_key aponta p/ OUTRA produção, um POST
      // concorrente idêntico venceu o crédito enquanto o receive daqui caiu no alreadyApplied (no-op, sem
      // 23505). Este registro é duplicado -> aborta p/ o ROLLBACK levá-lo junto. O catch faz o replay.
      if (idemOpKey) {
        const led = await client.query('SELECT ref_id FROM stock_ledger WHERE op_key = $1 LIMIT 1', [idemOpKey]);
        if (led.rows[0] && String(led.rows[0].ref_id) !== String(prod.id)) throw new Error('IDEMPOTENT_REPLAY');
      }

      // 3. Auditoria oficial (INALTERADA).
      await client.query(
        `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
        [operatorId, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: partId, quantity: qty, reason })],
      );

      return prod;
    });

    return res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    // Corrida (2 POSTs idênticos com header): o perdedor cai aqui por uma de duas vias — bateu na unique
    // do razão (23505) OU o pós-check viu o crédito do vencedor (IDEMPOTENT_REPLAY). Em ambos o
    // withTransaction fez ROLLBACK (levou o productions_3d duplicado junto). Responde o registro vencedor.
    const isReplay = error?.message === 'IDEMPOTENT_REPLAY' || (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey');
    if (isReplay) {
      console.warn(JSON.stringify({ event: 'production3d_idempotent_conflict', op_key: idemOpKey, via: error?.message === 'IDEMPOTENT_REPLAY' ? 'precheck-late' : '23505' }));
      if (idemOpKey) {
        const led = await pool.query('SELECT ref_id FROM stock_ledger WHERE op_key = $1 LIMIT 1', [idemOpKey]);
        if ((led.rowCount ?? 0) > 0) {
          const prod = await pool.query(`SELECT ${PRODUCTION_SELECT} FROM productions_3d WHERE id = $1`, [led.rows[0].ref_id]);
          if ((prod.rowCount ?? 0) > 0) return res.status(201).json(prod.rows[0]);
        }
      }
      return res.status(201).json({ success: true, idempotent: true });
    }
    console.error(JSON.stringify({ event: 'production3d_create_error', err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao registar produção 3D' });
  }
};

export const deleteProduction = async (req: Request, res: Response) => {
  const { id } = req.params;
  const operatorId = (req as any).user?.id || null;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, operatorId);

      // FOR UPDATE: trava a linha da produção -> 2 deletes paralelos serializam (o 2º acha a linha já
      // apagada -> 404). Antes era SELECT sem trava: dois deletes subtraíam 2×.
      const prodRes = await client.query('SELECT product_id, quantity FROM productions_3d WHERE id = $1 FOR UPDATE', [id]);
      if (prodRes.rows.length === 0) throw new Error('PRODUCAO_NAO_ENCONTRADA');
      const productId = prodRes.rows[0].product_id;
      const qty = Number(prodRes.rows[0].quantity);

      // Reverte a ENTRADA pelo MOTOR: reduz só on_hand, guard on_hand-qty >= reserved. Se o saldo já
      // foi consumido/reservado, reverseReceive lança SALDO_INSUFICIENTE_REVERSAO -> tx faz ROLLBACK ->
      // a produção NÃO é apagada (fim do GREATEST(...,0) que pisava em 0 silenciosamente). op_key
      // content-addressed no id estável -> idempotente mesmo numa corrida.
      if (productId && qty > 0) {
        await StockService.reverseReceive(client, productId, warehouseId, POOLED_OP_ID, qty, {
          refType: 'production_3d', refId: id, userId: operatorId,
          opKey: `production:${id}:reverse:${qty}`,
          reason: 'Correção: apagou registro de Produção 3D (reverte entrada)',
        });
      }

      await client.query('DELETE FROM productions_3d WHERE id = $1', [id]);
      await client.query(
        `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
        [operatorId, 'SAIDA_ESTOQUE_3D', JSON.stringify({ product_id: productId, quantity: qty, reason: 'Correção: Apagou registo de Produção 3D' })],
      );
    });

    return res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'PRODUCAO_NAO_ENCONTRADA') return res.status(404).json({ error: 'Produção não encontrada.' });
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'production3d_delete_idempotent_conflict', id, detail: error?.detail ?? null }));
      return res.json({ success: true });
    }
    console.error(JSON.stringify({ event: 'production3d_delete_error', id, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao apagar produção 3D' });
  }
};
