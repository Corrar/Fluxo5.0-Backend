// src/controllers/requests.controller.ts

import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { sendPushNotificationToRole } from '../utils/notifications';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

// Unidades que aceitam quantidade fracionada (metro, litro, quilo). Qualquer outra → inteiro
// (default seguro para unidades novas/desconhecidas). Espelha DECIMAL_UNITS do front (conferencia.jsx).
const DECIMAL_UNITS = new Set(['M', 'MT', 'L', 'KG']);
const isDecimalUnit = (un: unknown): boolean => DECIMAL_UNITS.has(String(un ?? '').trim().toUpperCase());

export const getRequests = async (req: Request, res: Response) => {
  try {
    const query = `
      WITH FilteredRequests AS (
          SELECT * FROM requests
          WHERE status IN ('aberto', 'aprovado') OR created_at >= NOW() - INTERVAL '30 days'
          ORDER BY created_at DESC LIMIT 200
      )
      SELECT r.*,
          cs.op_code,
          cl.name AS client_name,
          json_build_object('name', p.name, 'sector', p.sector) as requester,
          COALESCE(ri_agg.items, '[]'::json) as request_items
      FROM FilteredRequests r
      LEFT JOIN profiles p ON r.requester_id = p.id
      LEFT JOIN client_services cs ON r.client_service_id = cs.id
      LEFT JOIN clients cl ON cl.id = cs.client_id
      LEFT JOIN (
          SELECT ri.request_id, json_agg(
              json_build_object(
                'id', ri.id,
                'quantity_requested', ri.quantity_requested,
                'quantity_delivered', ri.quantity_delivered,
                'conference_note', ri.conference_note,
                'quantity_returned', ri.quantity_returned,
                'custom_product_name', ri.custom_product_name,
                'observation', ri.observation,
                'client_service', ri.client_service,
                'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags, 'unit_price', pr.unit_price) ELSE NULL END
              )
          ) as items
          FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id
          WHERE ri.request_id IN (SELECT id FROM FilteredRequests) GROUP BY ri.request_id
      ) ri_agg ON ri_agg.request_id = r.id ORDER BY r.created_at DESC;
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar solicitações' }); }
};

export const getMyRequests = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  try {
    const query = `
      WITH FilteredRequests AS (
          SELECT * FROM requests
          WHERE requester_id = $1 AND (status IN ('aberto', 'aprovado') OR created_at >= NOW() - INTERVAL '30 days')
          ORDER BY created_at DESC LIMIT 200
      )
      SELECT r.*,
          cs.op_code,
          COALESCE(ri_agg.items, '[]'::json) as request_items
      FROM FilteredRequests r
      LEFT JOIN client_services cs ON r.client_service_id = cs.id
      LEFT JOIN (
          SELECT ri.request_id, json_agg(
              json_build_object(
                'id', ri.id,
                'quantity_requested', ri.quantity_requested,
                'quantity_delivered', ri.quantity_delivered,
                'conference_note', ri.conference_note,
                'quantity_returned', ri.quantity_returned,
                'custom_product_name', ri.custom_product_name,
                'observation', ri.observation,
                'client_service', ri.client_service,
                'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags, 'unit_price', pr.unit_price) ELSE NULL END
              )
          ) as items
          FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id
          WHERE ri.request_id IN (SELECT id FROM FilteredRequests) GROUP BY ri.request_id
      ) ri_agg ON ri_agg.request_id = r.id ORDER BY r.created_at DESC;
    `;
    const { rows } = await pool.query(query, [userId]);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar minhas solicitações' }); }
};

export const createRequest = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { sector, items, op_code } = req.body;

  try {
    validatePositiveItems(items);

    // ---- Transação blindada: motor de estoque + auditoria no MESMO client ----
    const { requestId, changedProducts } = await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      // =========================================================================
      // 🛡️ 1. REGRA DE NEGÓCIO: VERIFICA SE A OP É OBRIGATÓRIA (BASEADO EM TAGS)
      // =========================================================================
      let requiresOp = false;
      const exemptTags = ['camisetas', 'camiseta', 'epi', 'ferramentas', 'insumos', 'insumo'];

      const productIds = items
        .map((i: any) => i.product_id)
        .filter((id: any) => id && id !== 'custom');

      if (items.length > productIds.length) {
        requiresOp = true;
      } else if (productIds.length > 0) {
        const productsQuery = await client.query(
          'SELECT id, tags FROM products WHERE id = ANY($1::uuid[])',
          [productIds]
        );

        for (const product of productsQuery.rows) {
          let tags: string[] = [];

          if (Array.isArray(product.tags)) {
            tags.push(...product.tags.map((t: string) => String(t).trim().toLowerCase()));
          } else if (typeof product.tags === 'string' && product.tags.trim() !== '') {
            try {
              const parsed = JSON.parse(product.tags);
              if (Array.isArray(parsed)) tags.push(...parsed.map((t: string) => String(t).trim().toLowerCase()));
              else tags.push(product.tags.trim().toLowerCase());
            } catch (e) {
              tags.push(product.tags.trim().toLowerCase());
            }
          }

          const isExempt = tags.some((tag: string) => exemptTags.includes(tag));

          if (!isExempt) {
            requiresOp = true;
            break;
          }
        }
      }

      // =========================================================================
      // 🛡️ 2. VALIDAÇÃO E VÍNCULO DA OP
      // =========================================================================
      let client_service_id = null;

      if (op_code) {
        const opCheck = await client.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
        if (opCheck.rows.length === 0) throw new Error("OP_NAO_ENCONTRADA");

        const opStatus = opCheck.rows[0].status;
        if (opStatus === 'finalizada' || opStatus === 'encerrada') throw new Error("OP_FINALIZADA");

        client_service_id = opCheck.rows[0].id;
      } else if (requiresOp) {
        throw new Error("OP_OBRIGATORIA_TAGS");
      }

      // =========================================================================
      // 🟢 3. INSERÇÃO DO PEDIDO BASE
      // =========================================================================
      const reqRes = await client.query(
        'INSERT INTO requests (requester_id, sector, status, client_service_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, sector, 'aberto', client_service_id]
      );
      const requestId = reqRes.rows[0].id;

      const sortedItems = [...items].sort((a, b) => {
        if (!a.product_id) return 1; if (!b.product_id) return -1;
        return String(a.product_id).localeCompare(String(b.product_id));
      });

      // =========================================================================
      // 🌉 4. A PONTE MÁGICA: RESERVA (motor) OU ENVIO PARA O KANBAN 3D
      // =========================================================================
      for (const item of sortedItems) {
        const isCustom = item.product_id === 'custom' || !item.product_id;
        const productId = isCustom ? null : item.product_id;
        const customName = isCustom ? item.custom_name : null;
        const priority = item.priority || 'Média'; // Lê a prioridade do frontend

        // Regista o item ANTES da reserva para termos o id (op_key idempotente por item).
        const itemRes = await client.query(
          'INSERT INTO request_items (request_id, product_id, custom_product_name, quantity_requested, observation, client_service) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [requestId, productId, customName, item.quantity, item.observation || null, item.client_service || null]
        );
        const itemId = itemRes.rows[0].id;

        if (productId) {
          // is_3d + disponível na linha pooled do ALMOX
          const productCheck = await client.query(
            `SELECT p.is_3d, (COALESCE(s.quantity_on_hand, 0) - COALESCE(s.quantity_reserved, 0)) as available
             FROM products p LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = $2 AND s.op_id IS NULL
             WHERE p.id = $1`,
            [productId, warehouseId]
          );

          const available = parseFloat(productCheck.rows[0]?.available || 0);
          const is3D = productCheck.rows[0]?.is_3d || false;

          // LÓGICA INTELIGENTE: ESTOQUE + FÁBRICA 3D
          if (is3D) {
            let missingQty = item.quantity;
            let reservedQty = 0;

            // 1. Se tem pelo menos 1 no estoque, reserva logo essa quantidade (pelo motor)
            if (available > 0) {
              reservedQty = Math.min(item.quantity, available);
              missingQty = item.quantity - reservedQty;

              if (reservedQty > 0) {
                await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, reservedQty, {
                  refType: 'request', refId: requestId, userId,
                  opKey: `request:${requestId}:item:${itemId}:reserve`,
                  reason: 'Reserva na criação (3D — parte já em estoque)',
                });
              }
            }

            // 2. Se FALTAR peças, vai para a fábrica produzir
            if (missingQty > 0) {
              const kanbanOpNumber = op_code ? op_code : 'Interno';

              const notesInfo = `⚠️ RESUMO DO PEDIDO:\n- A Produzir: ${missingQty} un.\n- Já em Estoque: ${reservedQty} un.\n- Total Solicitado: ${item.quantity} un.\n\n📝 OBSERVAÇÕES:\n${item.observation || 'Nenhuma'}`;

              await client.query(
                `INSERT INTO demands_3d (product_id, request_id, quantity, op_number, priority, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [productId, requestId, missingQty, kanbanOpNumber, priority, notesInfo]
              );
            }
          }
          // LÓGICA NORMAL PARA PRODUTOS NÃO 3D
          else {
            if (item.quantity > 0) {
              await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, item.quantity, {
                refType: 'request', refId: requestId, userId,
                opKey: `request:${requestId}:item:${itemId}:reserve`,
                reason: 'Reserva na criação da solicitação',
              });
            }
          }
        }
      }

      await createLog(userId, 'CRIAR_SOLICITACAO', { id_solicitacao: requestId, setor: sector, total_itens: items.length }, getClientIp(req), client);

      const changedProducts = sortedItems.map((it: any) => it.product_id).filter((id: any) => id && id !== 'custom');
      return { requestId, changedProducts };
    });

    // ---- Pós-commit: resposta + eventos socket + push (contrato idêntico ao 2.0) ----
    const fullReqQuery = `
      SELECT r.*,
             cs.op_code,
             json_build_object('name', p.name, 'sector', p.sector) as requester,
             (SELECT COALESCE(json_agg(json_build_object('id', ri.id, 'quantity_requested', ri.quantity_requested, 'quantity_delivered', ri.quantity_delivered, 'quantity_returned', ri.quantity_returned, 'custom_product_name', ri.custom_product_name, 'observation', ri.observation, 'client_service', ri.client_service, 'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags) ELSE NULL END)), '[]'::json) FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id WHERE ri.request_id = r.id) as request_items
      FROM requests r
      LEFT JOIN profiles p ON r.requester_id = p.id
      LEFT JOIN client_services cs ON r.client_service_id = cs.id
      WHERE r.id = $1`;
    const { rows: fullReqRows } = await pool.query(fullReqQuery, [requestId]);

    if ((req as any).io) {
      const notificationData = { id: `req-${requestId}-${Date.now()}`, message: `📢 Nova solicitação do setor: ${sector}`, action: 'Ver Pedidos', type: 'solicitacao' };
      (req as any).io.to(['almoxarife', 'admin', 'escritorio']).emit('new_request_notification', notificationData);

      // 🟢 O front-end já captura 'new_request' e adiciona no topo da lista.
      (req as any).io.to(['almoxarife', 'admin', 'escritorio']).emit('new_request', fullReqRows[0]);

      // 🟢 Em vez de 'refresh_stock', enviamos os produtos específicos alterados.
      if (changedProducts.length > 0) {
        (req as any).io.emit('stock_updated', { changedProducts });
      }
    }

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const horaFormatada = dataAtual.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

    let listaMateriais = '';
    const itemsDetail = fullReqRows[0]?.request_items || [];

    itemsDetail.forEach((reqItem: any) => {
      const qtd = reqItem.quantity_requested;
      const nomeProduto = reqItem.products ? reqItem.products.name : (reqItem.custom_product_name || 'Produto Genérico');
      const skuProduto = reqItem.products?.sku ? `SKU: ${reqItem.products.sku}` : 'SKU: N/A';
      listaMateriais += `\n- ${qtd} un. ${nomeProduto} | ${skuProduto}`;
    });

    const nomeSolicitante = fullReqRows[0]?.requester?.name || 'Usuário';

    const avisoOp = op_code ? `\nOP: ${op_code}` : `\nOP: Isento (EPI/Ferramenta/Insumo)`;
    const mensagemPersonalizada = `Setor: ${sector}${avisoOp}\nData/Hora: ${dataFormatada} - ${horaFormatada}\nMateriais:${listaMateriais}`;

    sendPushNotificationToRole('almoxarife', `Novo Pedido de ${nomeSolicitante}`, mensagemPersonalizada, '/requests');

    res.status(201).json({ success: true, id: requestId });
  } catch (error: any) {
    // Erros de domínio do motor (reserva insuficiente, furo, etc.) -> 400 TRATADO (não 500 cru).
    if (error instanceof StockError) {
      return res.status(400).json({ error: `Erro Técnico: ${error.message}` });
    }
    if (error.message === "OP_OBRIGATORIA_TAGS") return res.status(400).json({ error: "É obrigatório informar o número da OP para estes tipos de produtos." });
    if (error.message === "OP_NAO_ENCONTRADA") return res.status(404).json({ error: "OP não encontrada no sistema. Verifique o número digitado." });
    if (error.message === "OP_FINALIZADA") return res.status(400).json({ error: "Essa OP ja foi finalizada, verifique a OP correta" });

    res.status(error.message.includes('Estoque disponível insuficiente') ? 400 : 500).json({ error: `Erro Técnico: ${error.message}` });
  }
};

export const updateRequestStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const { status, rejection_reason, adjusted_items, conference_notes } = req.body;

  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    // Whitelist de status de DESTINO ('aberto' é o estado inicial do createRequest, nunca um destino aqui).
    const STATUS_VALIDOS = ['aprovado', 'conferido', 'entregue', 'rejeitado', 'devolvido'];
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

    // Motivo da recusa é OBRIGATÓRIO na rejeição — valida ANTES da transação/estoque.
    if (status === 'rejeitado') {
      if (!rejection_reason || typeof rejection_reason !== 'string' || rejection_reason.trim() === '') {
        return res.status(400).json({ error: 'Motivo da recusa é obrigatório.' });
      }
    }

    const { changedProducts } = await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      const currentRes = await client.query('SELECT status FROM requests WHERE id = $1 FOR UPDATE', [id]);
      if (!currentRes.rows[0]?.status) throw new Error("Solicitação não encontrada");
      const currentStatus = currentRes.rows[0].status;

      // Validação de TRANSIÇÃO: bloqueia pulos de estado (ex.: aberto→entregue). Roda APÓS o FOR UPDATE
      // (verdade travada) e ANTES de qualquer toque em estoque (adjusted_items/consume/release/receive).
      // Lança sentinela → o catch converte em HTTP 400. NÃO usar `res` aqui: dentro da transação isso
      // comitaria e depois colidiria com o res.json de sucesso ("headers already sent").
      const TRANSICOES: Record<string, string[]> = {
        aberto:    ['aprovado', 'rejeitado'],
        aprovado:  ['conferido', 'rejeitado'],
        conferido: ['entregue', 'rejeitado'],
        entregue:  ['devolvido'],
        rejeitado: [],
        devolvido: [],
      };
      if (!TRANSICOES[currentStatus] || !TRANSICOES[currentStatus].includes(status)) {
        throw new Error(`TRANSICAO_INVALIDA:${currentStatus}:${status}`);
      }

      // Se houve ajuste manual das quantidades pelo almoxarife antes da entrega
      if (adjusted_items && Array.isArray(adjusted_items)) {
        for (const adj of adjusted_items) {
          const itemCheck = await client.query('SELECT ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.unit FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.id = $1', [adj.id]);

          if (itemCheck.rows.length > 0) {
            const item = itemCheck.rows[0];

            // DEFESA DE INTEGRIDADE: quantity_delivered AJUSTA RESERVA de estoque. O front limita na UX,
            // mas o backend é a fonte da verdade. Inválido → sentinela VALIDACAO_QTD → HTTP 400 (não grava
            // nem toca em estoque). Regras: número >= 0, <= pedido, inteiro se unidade não-decimal, <= 2 casas.
            const requested = parseFloat(item.quantity_requested);
            const rawQd = String(adj.quantity_delivered ?? '').trim().replace(',', '.');
            const newReserved = parseFloat(rawQd);
            const decimalCount = rawQd.includes('.') ? rawQd.split('.')[1].length : 0;
            if (!Number.isFinite(newReserved) || newReserved < 0) {
              throw new Error(`VALIDACAO_QTD:Quantidade conferida inválida no item ${adj.id}.`);
            }
            if (newReserved > requested) {
              throw new Error(`VALIDACAO_QTD:Quantidade conferida (${newReserved}) não pode passar do pedido (${requested}).`);
            }
            if (!isDecimalUnit(item.unit) && !Number.isInteger(newReserved)) {
              throw new Error(`VALIDACAO_QTD:A unidade "${String(item.unit ?? '').trim()}" não aceita casas decimais.`);
            }
            if (decimalCount > 2) {
              throw new Error(`VALIDACAO_QTD:Máximo de 2 casas decimais no item ${adj.id}.`);
            }

            const oldReserved = parseFloat(item.quantity_delivered ?? item.quantity_requested);

            await client.query('UPDATE request_items SET quantity_delivered = $1 WHERE id = $2', [newReserved, adj.id]);

            if (item.product_id && oldReserved !== newReserved && (currentStatus === 'aberto' || currentStatus === 'aprovado' || currentStatus === 'conferido')) {
              // Só ajusta se já existia reserva (preserva o comportamento do 2.0).
              const snap = await StockService.read(client, item.product_id, warehouseId, POOLED_OP_ID);
              if (snap && snap.reserved > 0) {
                const delta = newReserved - oldReserved;
                // Namespace de op_key por FASE: o ajuste na conferência ('conf:') não pode colidir com o
                // op_key do ajuste no aceite (aberto/aprovado). Sem isso, reusar o mesmo valor-alvo (ex.: 0)
                // faria o dedup do stock_ledger engolir a liberação da conferência (NO-OP silencioso).
                const phase = currentStatus === 'conferido' ? 'conf:' : '';
                if (delta > 0) {
                  await StockService.reserve(client, item.product_id, warehouseId, POOLED_OP_ID, delta, {
                    refType: 'request', refId: id, userId,
                    opKey: `request:${id}:item:${adj.id}:${phase}adjreserve:${newReserved}`,
                    reason: 'Ajuste de quantidade (aumenta reserva)',
                  });
                } else if (delta < 0) {
                  await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, -delta, {
                    refType: 'request', refId: id, userId,
                    opKey: `request:${id}:item:${adj.id}:${phase}adjrelease:${newReserved}`,
                    reason: 'Ajuste de quantidade (reduz reserva)',
                  });
                }
              }
            }
          }
        }
      }

      const itemsRes = await client.query('SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.request_id = $1 ORDER BY ri.product_id', [id]);

      // Status: Entregue -> consume (baixa físico + libera a reserva correspondente).
      // Entrega vem SÓ depois de 'conferido' (a transição já bloqueia aberto/aprovado→entregue); mantemos
      // 'aprovado' no guard por defesa/coerência, mas na prática só 'conferido' chega aqui.
      if (status === 'entregue' && (currentStatus === 'aprovado' || currentStatus === 'conferido')) {
        for (const item of itemsRes.rows) {
          if (item.product_id && !item.is_3d) { // Só baixa físico se NÃO FOR 3D
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            if (finalQty > 0) {
              await StockService.consume(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
                refType: 'request', refId: id, userId,
                opKey: `request:${id}:item:${item.id}:consume`,
                reason: 'Entrega da solicitação',
              });
            }
          }
        }
      }
      // Status: Rejeitado -> release (devolve a reserva). Pode vir de aberto/aprovado/conferido.
      else if (status === 'rejeitado' && (currentStatus === 'aberto' || currentStatus === 'aprovado' || currentStatus === 'conferido')) {
        for (const item of itemsRes.rows) {
          if (item.product_id && !item.is_3d) { // Só devolve reserva se NÃO FOR 3D
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            if (finalQty > 0) {
              await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
                refType: 'request', refId: id, userId,
                opKey: `request:${id}:item:${item.id}:release`,
                reason: 'Rejeição da solicitação',
              });
            }
          }
        }
      }
      // Status: Devolvido (voltou para a prateleira) -> receive
      else if (status === 'devolvido' && currentStatus === 'entregue') {
        for (const item of itemsRes.rows) {
          if (item.product_id && !item.is_3d) { // Só volta para prateleira se NÃO FOR 3D
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            if (finalQty > 0) {
              await StockService.receive(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
                refType: 'request', refId: id, userId,
                opKey: `request:${id}:item:${item.id}:receive`,
                reason: 'Devolução total da solicitação',
              });
            }
          }
        }
      }
      // Status: Conferido -> NO-OP de estoque INTENCIONAL (passagem aprovado→entregue).
      // A baixa física fica no 'entregue' (consume); conferir não reserva/libera/baixa nada.
      else if (status === 'conferido') {
        // sem operação de estoque — apenas o UPDATE de status abaixo.
      }

      // Justificativa de CONFERÊNCIA por item — SÓ no 'conferido'. Campo próprio (conference_note),
      // separado de observation: nunca sobrescreve a nota do solicitante. O request_id no WHERE
      // impede gravar em item de outra solicitação. Grava sempre o .trim(); notas vazias são ignoradas.
      if (status === 'conferido' && Array.isArray(conference_notes)) {
        for (const cn of conference_notes) {
          if (!cn || cn.id == null) continue;
          const note = typeof cn.note === 'string' ? cn.note.trim() : '';
          if (note === '') continue;
          await client.query('UPDATE request_items SET conference_note = $1 WHERE id = $2 AND request_id = $3', [note, cn.id, id]);
        }
      }

      await client.query('UPDATE requests SET status = $1, rejection_reason = $2 WHERE id = $3', [status, status === 'rejeitado' ? rejection_reason.trim() : (rejection_reason || null), id]);

      const logAction = status === 'entregue' ? 'ENTREGAR_SOLICITACAO' : status === 'rejeitado' ? 'REJEITAR_SOLICITACAO' : status === 'devolvido' ? 'DEVOLVER_SOLICITACAO' : 'ATUALIZAR_STATUS_SOLICITACAO';
      await createLog(userId, logAction, { id_solicitacao: id, novo_status: status, motivo: status === 'rejeitado' ? rejection_reason.trim() : (rejection_reason || 'N/A') }, getClientIp(req), client);

      const changedProducts = itemsRes.rows.map((item: any) => item.product_id).filter((pid: any) => pid);
      return { changedProducts };
    });

    // 🟢 Enviamos APENAS os dados atualizados (mesmo payload do 2.0)
    if ((req as any).io) {
      (req as any).io.emit('request_updated', { id, status, rejection_reason });

      if (changedProducts.length > 0) {
        (req as any).io.emit('stock_updated', { changedProducts });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (typeof error?.message === 'string' && error.message.startsWith('VALIDACAO_QTD:')) {
      return res.status(400).json({ error: error.message.slice('VALIDACAO_QTD:'.length) });
    }
    if (typeof error?.message === 'string' && error.message.startsWith('TRANSICAO_INVALIDA:')) {
      const [, de, para] = error.message.split(':');
      return res.status(400).json({ error: `Transição inválida: ${de} → ${para}.` });
    }
    res.status(500).json({ error: error.message || 'Erro ao atualizar status' });
  }
};

export const deleteRequest = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    const { changedProducts } = await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      const reqRes = await client.query('SELECT status FROM requests WHERE id = $1 FOR UPDATE', [id]);
      if (reqRes.rows.length === 0) throw new Error('__NOT_FOUND__');
      const { status } = reqRes.rows[0];

      if (status === 'rejeitado' || status === 'entregue' || status === 'devolvido') throw new Error('Não é possível cancelar no estado atual.');

      let changedProducts: any[] = [];
      if (status === 'aberto' || status === 'aprovado') {
        // Puxa o is_3d para não tentar liberar reserva de algo que nunca foi reservado.
        const itemsRes = await client.query('SELECT ri.id, ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.request_id = $1', [id]);
        for (const item of itemsRes.rows) {
          if (item.product_id && !item.is_3d) {
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            if (finalQty > 0) {
              await StockService.release(client, item.product_id, warehouseId, POOLED_OP_ID, finalQty, {
                refType: 'request', refId: id, userId,
                opKey: `request:${id}:item:${item.id}:release`,
                reason: 'Cancelamento da solicitação',
              });
            }
          }
        }
        changedProducts = itemsRes.rows.map((item: any) => item.product_id).filter((pid: any) => pid);
      }

      await client.query("UPDATE requests SET status = 'rejeitado', rejection_reason = 'Cancelado pelo usuário/sistema' WHERE id = $1", [id]);

      // Se havia cópia no Kanban 3D pendente, cancela também.
      await client.query("UPDATE demands_3d SET status = 'Cancelada' WHERE request_id = $1 AND status != 'Concluída'", [id]);

      await createLog(userId, 'CANCELAR_SOLICITACAO', { id_solicitacao: id, status_anterior: status }, getClientIp(req), client);
      return { changedProducts };
    });

    if ((req as any).io) {
      (req as any).io.emit('request_updated', { id, status: 'rejeitado', rejection_reason: 'Cancelado pelo usuário/sistema' });

      if (changedProducts.length > 0) {
        (req as any).io.emit('stock_updated', { changedProducts });
      }
    }

    res.json({ success: true, message: 'Pedido cancelado.' });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === '__NOT_FOUND__') return res.status(404).json({ error: 'Não encontrada.' });
    res.status(500).json({ error: error.message });
  }
};

// =========================================================================
// 🟢 DEVOLUÇÃO PARCIAL DE SOLICITAÇÕES COM INTEGRAÇÃO À OP
// =========================================================================

export const partialReturnRequest = async (req: Request, res: Response) => {
  const { id } = req.params; // ID do Request
  const userId = (req as any).user.id;
  const { returns } = req.body; // Array: [{ request_item_id, quantity_to_return }]

  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      // Verifica o status do pedido e se tem uma OP associada
      const reqRes = await client.query('SELECT status, client_service_id FROM requests WHERE id = $1', [id]);
      if (!reqRes.rows[0] || reqRes.rows[0].status !== 'entregue') {
        throw new Error("Apenas solicitações 'entregues' podem ter itens devolvidos.");
      }
      const client_service_id = reqRes.rows[0].client_service_id;

      for (const ret of returns) {
        if (ret.quantity_to_return <= 0) continue;

        const itemCheck = await client.query(
          'SELECT ri.product_id, ri.quantity_delivered, ri.quantity_requested, ri.quantity_returned, p.is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.id = $1',
          [ret.request_item_id]
        );

        const item = itemCheck.rows[0];
        const delivered = parseFloat(item.quantity_delivered ?? item.quantity_requested);
        const alreadyReturned = parseFloat(item.quantity_returned ?? 0);
        const returnQty = parseFloat(ret.quantity_to_return);

        if (alreadyReturned + returnQty > delivered) {
          throw new Error(`Não podes devolver mais do que foi entregue para o produto.`);
        }

        // 1. Atualiza o item do pedido com a nova quantidade devolvida
        await client.query('UPDATE request_items SET quantity_returned = COALESCE(quantity_returned, 0) + $1 WHERE id = $2', [returnQty, ret.request_item_id]);

        // 2. Devolve ao stock físico pelo motor (se não for 3D)
        if (item.product_id && !item.is_3d && returnQty > 0) {
          await StockService.receive(client, item.product_id, warehouseId, POOLED_OP_ID, returnQty, {
            refType: 'request', refId: id, userId,
            opKey: `request:${id}:item:${ret.request_item_id}:receive:${alreadyReturned + returnQty}`,
            reason: 'Devolução parcial via Solicitação',
          });
        }

        // 3. Se houver OP, regista em op_returns para o consumo da OP ficar correto
        if (client_service_id && item.product_id) {
          await client.query(`
              INSERT INTO op_returns (client_service_id, product_id, quantity, user_id, observation)
              VALUES ($1, $2, $3, $4, $5)
          `, [client_service_id, item.product_id, returnQty, userId, "Devolução parcial via Solicitação"]);
        }
      }

      await createLog(userId, 'DEVOLUCAO_PARCIAL', { id_solicitacao: id }, getClientIp(req), client);
    });

    // Avisa o frontend para atualizar as tabelas afetadas (mesmos eventos do 2.0)
    if ((req as any).io) {
      (req as any).io.emit('refresh_requests');
      (req as any).io.emit('refresh_stock');
    }

    res.json({ success: true, message: "Devolução parcial processada com sucesso!" });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message || 'Erro ao processar devolução parcial' });
  }
};
