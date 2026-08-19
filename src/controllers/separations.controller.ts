import { Request, Response } from 'express';
import { pool, query as dbQuery, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { emitStockChanged } from '../config/socket';
import { resolveWarehouseId, getAlmoxId, POOLED_OP_ID } from '../services/warehouse';

// Guard de status da separação. Erro TIPADO para o catch mapear HTTP sem cair no 500 genérico:
// inexistente → 404; transição terminal sem sentido (entregue/cancelada) → 400.
type SeparationGuardCode = 'SEPARACAO_NAO_ENCONTRADA' | 'SEPARACAO_JA_ENTREGUE' | 'SEPARACAO_CANCELADA';
class SeparationGuardError extends Error {
  constructor(
    public readonly code: SeparationGuardCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'SeparationGuardError';
  }
}

/**
 * Reserva O QUE HOUVER: `min(desejado, disponível)`, e devolve quanto foi reservado.
 *
 * ⚠ POR QUE ISTO EXISTE E POR QUE NÃO É MÉTODO DO MOTOR. `StockService.reserve` é tudo-ou-nada
 * (lança `RESERVA_INSUFICIENTE`), e está certo assim: quem promete material inteiro precisa saber
 * que não coube. A separação é o caso em que reservar o parcial É o comportamento desejado (a
 * decisão do Bruno: adiciona o pedido inteiro, reserva o que houver, marca "Faltam N"). Isso é
 * política do CHAMADOR, não do motor — mesmo raciocínio do guard do Lote B e do script do S2.
 * `stock.service.ts` não foi tocado.
 *
 * ⚠ O `FOR UPDATE` é obrigatório e vem ANTES da conta. Ler o disponível fora da trava é TOCTOU:
 * outra transação reserva entre a leitura e o `reserve`, e aí o `reserve` estoura
 * RESERVA_INSUFICIENTE no meio de uma criação de separação. Sob a trava, o `reserve` logo abaixo
 * relê a MESMA linha já travada por esta transação.
 *
 * Sem linha de estoque para o produto devolve 0 (não há o que reservar) em vez de deixar o motor
 * lançar PRODUTO_SEM_ESTOQUE: aqui a ausência de saldo é "faltam todas", não erro de operação.
 */
async function reservarOQueHouver(
  client: any,
  productId: string,
  warehouseId: string,
  opId: string | null,
  desejado: number,
  refs: { refId: string; userId: string; opKey: string; reason: string },
): Promise<number> {
  if (!(desejado > 0)) return 0;
  const { rows } = await client.query(
    `SELECT quantity_on_hand::float8 AS oh, quantity_reserved::float8 AS rv FROM stock
      WHERE product_id = $1 AND warehouse_id = $2 AND op_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE`,
    [productId, warehouseId, opId],
  );
  if (rows.length === 0) return 0;
  const disponivel = Number(rows[0].oh) - Number(rows[0].rv);
  const reservar = Math.max(0, Math.min(desejado, disponivel));
  if (reservar <= 0) return 0;
  await StockService.reserve(client, productId, warehouseId, opId, reservar, {
    refType: 'separation', refId: refs.refId, userId: refs.userId,
    opKey: refs.opKey, reason: refs.reason,
  });
  return reservar;
}

export const getSeparations = async (req: Request, res: Response) => {
  try {
    // RETRY explícito: era `pool.query` CRU, fora do wrapper do db.ts — origem conhecida do 500
    // intermitente desta fila no cold start do Neon. Leitura idempotente ⇒ retentável.
    // GRÃO: o saldo é o do ALMOX pooled (op_id IS NULL) — é de lá que a separação sai, e material
    // com op_id já está apropriado a outra OP. Sem estes dois filtros, a 2ª linha de stock do mesmo
    // produto (outro armazém ou per-OP) DUPLICA o item dentro de items[] e cada cópia mostra o
    // saldo de uma linha arbitrária. O join é 1-para-1 por item, então filtrar já garante 1 linha.
    // ORDEM CRAVADA (ORDER BY p.sku NULLS LAST, p.name): `json_agg` sem ORDER BY herda a ordem do
    // EXECUTOR — era emergente do plano, não contrato, e o predicado novo do join a mudou. items[]
    // é a sequência de BIPAGEM do separador: SKU é o campo que ele confere contra a etiqueta, e o
    // formato C.SS.NNNN agrupa a mesma família na ordem em que ele percorre a prateleira.
    // NULLS LAST + p.name porque products.sku é nullable (produto custom): sem o desempate, a
    // ordem entre itens sem SKU voltaria a ser emergente do plano.
    const almoxId = await getAlmoxId(pool);
    const { rows } = await dbQuery(`
      SELECT s.*,
        (SELECT json_agg(json_build_object('id', si.id, 'product_id', si.product_id, 'quantity', si.quantity, 'qty_requested', si.qty_requested, 'observation', si.observation, 'products', json_build_object('name', p.name, 'sku', p.sku, 'unit', p.unit, 'unit_price', p.unit_price, 'stock', json_build_object('quantity_on_hand', COALESCE(st.quantity_on_hand, 0), 'quantity_reserved', COALESCE(st.quantity_reserved, 0)))) ORDER BY p.sku NULLS LAST, p.name)
         FROM separation_items si JOIN products p ON si.product_id = p.id
         LEFT JOIN stock st ON p.id = st.product_id AND st.warehouse_id = $1 AND st.op_id IS NULL
         WHERE si.separation_id = s.id) as items,
        (SELECT json_agg(json_build_object('id', sr.id, 'product_id', sr.product_id, 'quantity', sr.quantity, 'status', sr.status, 'product_name', p.name)) FROM separation_returns sr JOIN products p ON sr.product_id = p.id WHERE sr.separation_id = s.id) as returns
      FROM separations s
      -- == JANELA (lote BW, item 4) =========================================================
      -- Era a UNICA das 8 listagens sem WHERE, sem janela e sem LIMIT: 602 linhas / 797 KB, e
      -- crescendo sem teto. O array items[] e 75% do peso, entao cada separacao entregue no
      -- passado custa banda para sempre.
      --
      -- A PRIMEIRA clausula e a que importa: separacao ABERTA entra SEMPRE, sem idade. O Quadro
      -- de Gestao depende de ver todas as abertas, e uma janela so por data as perderia assim que
      -- envelhecessem -- a mais antiga viva ja tem 78 dias (02/06). Com o OR, ela pode ter 5 anos
      -- que continua vindo.
      --
      -- A SEGUNDA clausula e o historico da aba "Entregue": 90 dias por sent_at (a data que
      -- importa para quem foi entregue), com fallback em created_at para linha sem envio.
      -- Medido em producao: 602 -> 72 linhas, 797 KB -> 252 KB (31,6%), com as 7 abertas presentes.
      --
      -- 'cancelada' NAO precisou de clausula propria: o front ja a descarta no adapter
      -- (separacoes.jsx, adaptSeparation devolve null) e, medido, todas as 10 sao mais velhas que
      -- a janela -- sairiam por idade de qualquer jeito.
      WHERE s.status NOT IN ('entregue', 'cancelada', 'concluida', 'finalizada')
         OR COALESCE(s.sent_at, s.created_at) >= now() - interval '90 days'
      ORDER BY s.created_at DESC
    `, [almoxId], { retryable: true });
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar separações' }); }
};

export const createSeparation = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  // 🟢 Recebe o client_service_id do frontend
  const { client_name, production_order, destination, items, client_service_id } = req.body;
  const produtosTocados: string[] = [];
  let reservasDoItem: Array<{ item_id: string; product_id: string; qty_requested: number; reserved: number; missing: number }> = [];
  try {
    validatePositiveItems(items);

    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Sem permissão.');

      const sepRes = await client.query(
        `INSERT INTO separations (destination, client_name, production_order, status, type, client_service_id) VALUES ($1, $2, $3, 'pendente', 'op', $4) RETURNING id`,
        [destination, client_name, production_order, client_service_id || null]
      );
      const sepId = sepRes.rows[0].id;

      // ── ADICIONAR JÁ RESERVA (Lote S1) ───────────────────────────────────────────────────────
      // O comentário que estava aqui dizia "Criação NÃO reserva (idêntico ao 2.0)". A segunda
      // metade era FALSA: o 2.0 reservava ao lançar a lista. Era a primeira que valia, e ela é o
      // defeito — a lista prometia material que ninguém segurava, e quem chegasse depois levava.
      //
      // `qty_requested` = O PEDIDO (o que o cliente quer).
      // `quantity`      = O RESERVADO (o que o estoque conseguiu segurar AGORA).
      // Quando não cabe tudo, o item entra com o pedido INTEIRO e a reserva parcial; a diferença
      // é o "Faltam N" da tela. NÃO se rebaixa `qty_requested` — a intenção do cliente é registro,
      // não consequência do saldo do momento.
      for (const item of items) {
        const pedido = Number(item.quantity);
        const itemRes = await client.query(
          `INSERT INTO separation_items (separation_id, product_id, qty_requested, quantity, observation) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
          [sepId, item.product_id, pedido, item.observation || null]
        );
        const itemId = itemRes.rows[0].id;
        // op_key ancorada no ITEM (id fresco a cada criação) — a régua do S2: na separação, o 2º
        // item viraria no-op idempotente e a reserva dele se perderia.
        const reservado = await reservarOQueHouver(client, item.product_id, warehouseId, POOLED_OP_ID, pedido, {
          refId: sepId, userId,
          opKey: `separation:${sepId}:item:${itemId}:reserve:create`,
          reason: 'Reserva ao adicionar item na separação',
        });
        if (reservado > 0) {
          await client.query('UPDATE separation_items SET quantity = $1 WHERE id = $2', [reservado, itemId]);
          produtosTocados.push(item.product_id);
        }
        reservasDoItem.push({ item_id: itemId, product_id: item.product_id, qty_requested: pedido, reserved: reservado, missing: pedido - reservado });
      }

      await createLog(userId, 'CRIAR_SEPARACAO', { id_separacao: sepId, cliente: client_name }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    // A criação passou a MOVER RESERVA, então precisa do aviso de saldo — 'separations_update'
    // fala da separação e nenhuma tela de estoque o escuta.
    emitStockChanged(produtosTocados, (req as any).io);
    // Resposta ENRIQUECIDA: a tela precisa do id do item (que antes só chegava no reload) e do
    // "reservou N de M" para marcar o incompleto SEM tratar como erro. Chave nova, aditiva.
    res.status(201).json({ success: true, items: reservasDoItem });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const authorizeSeparation = async (req: Request, res: Response) => {
  // Produtos cujo SALDO mudou nesta operação. Preenchido DENTRO da transação, emitido só
  // DEPOIS do commit — a tela não pode ser avisada de saldo que ainda pode ser desfeito.
  const produtosTocados: string[] = [];
  const { id } = req.params;
  const { items, action } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      // 🔒 GUARD DE STATUS — trava a linha da separação (FOR UPDATE) e serializa autorizações
      // concorrentes. Bloqueia só transições sem sentido: estados TERMINAIS (entregue/cancelada)
      // e separação inexistente. 'pendente'/'em_separacao' (e demais não-terminais) seguem o fluxo.
      const sepStatusRes = await client.query('SELECT status FROM separations WHERE id = $1 FOR UPDATE', [id]);
      if (sepStatusRes.rows.length === 0) {
        throw new SeparationGuardError('SEPARACAO_NAO_ENCONTRADA', 'Separação não encontrada.', 404);
      }
      const currentStatus = sepStatusRes.rows[0].status;
      if (currentStatus === 'entregue') {
        throw new SeparationGuardError('SEPARACAO_JA_ENTREGUE', 'Separação já entregue.', 400);
      }
      if (currentStatus === 'cancelada') {
        throw new SeparationGuardError('SEPARACAO_CANCELADA', 'Separação cancelada.', 400);
      }

      for (const item of items) {
        const oldItem = await client.query('SELECT quantity, product_id FROM separation_items WHERE id = $1', [item.id]);
        if (oldItem.rows.length > 0) {
          const oldQty = parseFloat(oldItem.rows[0].quantity || 0);
          const newQty = parseFloat(item.quantity);
          if (isNaN(newQty) || newQty < 0) throw new Error("Quantidade inválida.");

          const productId = oldItem.rows[0].product_id;
          if (productId) produtosTocados.push(productId);   // p/ o stock_updated pós-commit
          const diff = newQty - oldQty;
          await client.query('UPDATE separation_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);

          if (action === 'reservar') {
            // diff > 0 reserva; diff < 0 devolve reserva. reserve() já valida disponível (trava a linha).
            if (diff > 0) {
              await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, diff, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:reserve:${newQty}`,
                reason: 'Reserva de separação',
              });
            } else if (diff < 0) {
              await StockService.release(client, productId, warehouseId, POOLED_OP_ID, -diff, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:release:${newQty}`,
                reason: 'Ajuste (reduz reserva) de separação',
              });
            }
          } else if (action === 'entregar') {
            // Entrega: baixa físico de newQty (consume) e limpa a reserva que este item segurava (oldQty).
            if (newQty > 0) {
              await StockService.consume(client, productId, warehouseId, POOLED_OP_ID, newQty, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:consume`,
                reason: 'Entrega de separação',
              });
            }
            // Se entregou MENOS do que estava reservado para este item, libera o resíduo da reserva.
            const residual = oldQty - newQty;
            if (residual > 0) {
              await StockService.release(client, productId, warehouseId, POOLED_OP_ID, residual, {
                refType: 'separation', refId: id, userId,
                opKey: `separation:${id}:item:${item.id}:releaseresidual`,
                reason: 'Libera resíduo de reserva na entrega parcial',
              });
            }
          }
        }
      }

      const newStatus = action === 'entregar' ? 'entregue' : 'em_separacao';
      await client.query(`UPDATE separations SET status = $1 ${action === 'entregar' ? ', sent_at = NOW()' : ''} WHERE id = $2`, [newStatus, id]);

      await createLog(userId, 'AUTORIZAR_SEPARACAO', { id_separacao: id, acao: action }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    // 'separations_update' fala da SEPARAÇÃO; nenhuma tela de saldo o escuta. O estoque
    // mudou aqui (consume/release/receive) e precisa do seu próprio aviso.
    emitStockChanged(produtosTocados, (req as any).io);
    res.json({ success: true });
  } catch (error: any) {
    // Idempotência sob concorrência: se dois 'entregar' escaparem do alreadyApplied() do razão,
    // o segundo bate na unique parcial (uq_stock_ledger_opkey). O vencedor já aplicou a baixa —
    // estado final correto → responde como SUCESSO (mesmo shape), sem duplicar movimento.
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'separation_idempotent_conflict', id, action, detail: error?.detail ?? null }));
      if ((req as any).io) (req as any).io.emit('separations_update');
      return res.json({ success: true });
    }
    // Guards de status (inexistente / transição terminal sem sentido): erro do cliente, HTTP tipado.
    if (error instanceof SeparationGuardError) {
      return res.status(error.httpStatus).json({ error: error.message });
    }
    // Invariante de estoque (sem saldo, reserva/físico insuficiente, qtd inválida...): erro do cliente.
    if (error instanceof StockError) {
      return res.status(400).json({ error: error.message });
    }
    // Qualquer OUTRO: falha de servidor. Parar de mascarar como 400 (era o bug do blanket catch).
    console.error(JSON.stringify({ event: 'separation_authorize_error', id, action, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro interno ao autorizar separação.' });
  }
};

export const deleteSeparation = async (req: Request, res: Response) => {
  // Produtos cujo SALDO mudou nesta operação. Preenchido DENTRO da transação, emitido só
  // DEPOIS do commit — a tela não pode ser avisada de saldo que ainda pode ser desfeito.
  const produtosTocados: string[] = [];
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      const sepRes = await client.query('SELECT status FROM separations WHERE id = $1 FOR UPDATE', [id]);
      if (sepRes.rows.length === 0) throw new Error("Pedido não encontrado");
      if (sepRes.rows[0].status === 'entregue' || sepRes.rows[0].status === 'cancelada') throw new Error("Não é possível inativar pedidos concluídos.");

      const itemsRes = await client.query('SELECT id, product_id, quantity FROM separation_items WHERE separation_id = $1', [id]);
      for (const item of itemsRes.rows) {
        const qty = parseFloat(item.quantity || 0);
        if (item.product_id && qty > 0) {
          produtosTocados.push(item.product_id);
          await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, qty, {
            refType: 'separation', refId: id, userId,
            opKey: `separation:${id}:item:${item.id}:release:cancel`,
            reason: 'Cancelamento de separação',
          });
        }
      }

      await client.query("UPDATE separations SET status = 'cancelada' WHERE id = $1", [id]);
      await createLog(userId, 'CANCELAR_SEPARACAO', { id_separacao: id }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    // 'separations_update' fala da SEPARAÇÃO; nenhuma tela de saldo o escuta. O estoque
    // mudou aqui (consume/release/receive) e precisa do seu próprio aviso.
    emitStockChanged(produtosTocados, (req as any).io);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// 🛠️ Editar Pedido (updateSeparation)
export const updateSeparation = async (req: Request, res: Response) => {
  // Produtos cujo SALDO mudou nesta operação. Preenchido DENTRO da transação, emitido só
  // DEPOIS do commit — a tela não pode ser avisada de saldo que ainda pode ser desfeito.
  const produtosTocados: string[] = [];
  const { id } = req.params;
  const { client_name, production_order, destination, items, client_service_id } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      await client.query(
        `UPDATE separations SET client_name = $1, production_order = $2, destination = $3, client_service_id = $4 WHERE id = $5`,
        [client_name, production_order, destination, client_service_id || null, id]
      );

      // Compara itens antigos com novos
      const existingItemsRes = await client.query('SELECT id, product_id, quantity, qty_requested FROM separation_items WHERE separation_id = $1', [id]);
      const existingItems = existingItemsRes.rows;
      const newProductIds = items.map((i: any) => i.product_id);

      // Remove itens apagados na edição e liberta o stock reservado (pelo motor)
      for (const old of existingItems) {
        if (!newProductIds.includes(old.product_id)) {
          const qty = parseFloat(old.quantity || 0);
          if (qty > 0 && old.product_id) {
            produtosTocados.push(old.product_id);
            await StockService.release(client, old.product_id, warehouseId, POOLED_OP_ID, qty, {
              refType: 'separation', refId: id, userId,
              opKey: `separation:${id}:item:${old.id}:release:edit`,
              reason: 'Item removido na edição da separação',
            });
          }
          await client.query('DELETE FROM separation_items WHERE id = $1', [old.id]);
        }
      }

      // ── Adiciona novos itens (JÁ RESERVADOS) ou ajusta o pedido dos existentes ───────────────
      for (const item of items) {
        const exists = existingItems.find((old) => old.product_id === item.product_id);
        const pedido = Number(item.quantity);

        if (!exists) {
          // ITEM NOVO NA EDIÇÃO: nasce reservado, igual ao de criação. Antes nascia com
          // quantity = 0 e só ganhava lastro no 'reservar' — a janela em que a lista promete sem
          // segurar nada é exatamente o buraco que este lote fecha.
          const novo = await client.query(
            `INSERT INTO separation_items (separation_id, product_id, qty_requested, quantity) VALUES ($1, $2, $3, 0) RETURNING id`,
            [id, item.product_id, pedido]
          );
          const novoId = novo.rows[0].id;
          const reservado = await reservarOQueHouver(client, item.product_id, warehouseId, POOLED_OP_ID, pedido, {
            refId: id, userId,
            opKey: `separation:${id}:item:${novoId}:reserve:create`,
            reason: 'Reserva ao adicionar item na separação',
          });
          if (reservado > 0) {
            await client.query('UPDATE separation_items SET quantity = $1 WHERE id = $2', [reservado, novoId]);
            produtosTocados.push(item.product_id);
          }
          continue;
        }

        const reservadoHoje = parseFloat(exists.quantity || 0);
        await client.query('UPDATE separation_items SET qty_requested = $1 WHERE id = $2', [pedido, exists.id]);

        if (pedido > reservadoHoje) {
          // PEDIDO SUBIU (ou o item estava incompleto): tenta cobrir a diferença com o que houver.
          // op_key content-addressed no pedido ALVO — repetir a mesma edição é no-op; uma edição
          // diferente gera chave nova. (Se a quantidade entrasse na chave "quanto reservei", uma
          // 2ª tentativa com disponível diferente reservaria em DOBRO — a lição da op_key do S2.)
          const reservado = await reservarOQueHouver(client, exists.product_id, warehouseId, POOLED_OP_ID, pedido - reservadoHoje, {
            refId: id, userId,
            opKey: `separation:${id}:item:${exists.id}:reserve:req:${pedido}`,
            reason: 'Reserva ao aumentar o pedido do item',
          });
          if (reservado > 0) {
            await client.query('UPDATE separation_items SET quantity = quantity + $1 WHERE id = $2', [reservado, exists.id]);
            produtosTocados.push(exists.product_id);
          }
        } else if (pedido < reservadoHoje) {
          // ⚠ PEDIDO CAIU ABAIXO DO RESERVADO: LIBERA O EXCESSO. Sem isto o S1 CRIA a doença que
          // o S2 curou — baixar de 10 para 3 com 10 reservadas deixaria 7 unidades presas sem
          // promessa nenhuma por trás, reserva órfã idêntica às 9 que foram corrigidas em 19/08.
          const excesso = reservadoHoje - pedido;
          await StockService.release(client, exists.product_id, warehouseId, POOLED_OP_ID, excesso, {
            refType: 'separation', refId: id, userId,
            opKey: `separation:${id}:item:${exists.id}:release:req:${pedido}`,
            reason: 'Libera excesso ao reduzir o pedido do item',
          });
          await client.query('UPDATE separation_items SET quantity = $1 WHERE id = $2', [pedido, exists.id]);
          produtosTocados.push(exists.product_id);
        }
      }

      await createLog(userId, 'EDITAR_SEPARACAO', { id_separacao: id, edicoes: 'Dados ou itens do pedido alterados' }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    // 'separations_update' fala da SEPARAÇÃO; nenhuma tela de saldo o escuta. O estoque
    // mudou aqui (consume/release/receive) e precisa do seu próprio aviso.
    emitStockChanged(produtosTocados, (req as any).io);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// ♻️ Criar um pedido de Devolução (sem mexer em estoque; só regista pendente)
export const createReturn = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO separation_returns (separation_id, product_id, quantity, status) VALUES ($1, $2, $3, 'pendente')`,
          [id, item.product_id, item.quantity]
        );
      }

      await createLog(userId, 'CRIAR_DEVOLUCAO', { id_separacao_origem: id }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// 🛡️ Aprovar ou Rejeitar a Devolução (Almoxarifado)
export const updateReturnStatus = async (req: Request, res: Response) => {
  // Produtos cujo SALDO mudou nesta operação. Preenchido DENTRO da transação, emitido só
  // DEPOIS do commit — a tela não pode ser avisada de saldo que ainda pode ser desfeito.
  const produtosTocados: string[] = [];
  const { returnId } = req.params;
  const { status } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);
      const userCheck = await client.query('SELECT role FROM profiles WHERE id = $1', [userId]);
      if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') throw new Error('Acesso negado.');

      const retRes = await client.query('SELECT * FROM separation_returns WHERE id = $1 FOR UPDATE', [returnId]);
      if (retRes.rows.length === 0) throw new Error('Devolução não encontrada');
      const ret = retRes.rows[0];

      if (ret.status !== 'pendente') throw new Error('Esta devolução já foi processada.');

      await client.query('UPDATE separation_returns SET status = $1 WHERE id = $2', [status, returnId]);

      // Se aprovado, devolve a quantidade ao stock físico pelo motor (receive)
      if (status === 'aprovado' && ret.product_id && parseFloat(ret.quantity) > 0) {
        produtosTocados.push(ret.product_id);
        await StockService.receive(client, ret.product_id, warehouseId, POOLED_OP_ID, parseFloat(ret.quantity), {
          refType: 'separation_return', refId: returnId, userId,
          opKey: `separation_return:${returnId}:receive`,
          reason: 'Devolução de separação aprovada',
        });
      }

      await createLog(userId, 'PROCESSAR_DEVOLUCAO', { id_devolucao: returnId, novo_status: status }, getClientIp(req), client);
    });

    if ((req as any).io) (req as any).io.emit('separations_update');
    // 'separations_update' fala da SEPARAÇÃO; nenhuma tela de saldo o escuta. O estoque
    // mudou aqui (consume/release/receive) e precisa do seu próprio aviso.
    emitStockChanged(produtosTocados, (req as any).io);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
