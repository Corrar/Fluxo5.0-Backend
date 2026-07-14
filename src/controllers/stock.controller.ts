// src/controllers/stock.controller.ts

import { Request, Response } from 'express';
import { pool, withTransaction } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { validatePositiveItems } from '../middlewares/validators';
import { StockService, StockError } from '../services/stock.service';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';

export const getStock = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, json_build_object(
        'id', p.id,
        'name', p.name,
        'sku', p.sku,
        'unit', p.unit,
        'min_stock', p.min_stock,
        'unit_price', p.unit_price,
        'sales_price', p.sales_price,
        'tags', p.tags
      ) as products
      FROM stock s
      JOIN products p ON s.product_id = p.id
      WHERE p.active = true
      ORDER BY s.created_at DESC;
    `);
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar estoque' });
  }
};

export const getStockReservations = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const stockCheck = await pool.query('SELECT product_id FROM stock WHERE id = $1', [id]);

    if (stockCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Estoque não encontrado' });
    }

    const productId = stockCheck.rows[0].product_id;
    let reservations: any[] = [];

    const reqRes = await pool.query(`
      SELECT r.id as request_id, COALESCE(pf.sector, r.sector) as sector, ri.quantity_requested as quantity
      FROM request_items ri
      JOIN requests r ON ri.request_id = r.id
      LEFT JOIN profiles pf ON r.requester_id = pf.id
      WHERE ri.product_id = $1 AND r.status IN ('aberto', 'aprovado') AND ri.quantity_requested > 0
    `, [productId]);

    const travelRes = await pool.query(`
      SELECT t.id as request_id, 'Viagem: ' || t.city as sector, ti.quantity_out as quantity
      FROM travel_order_items ti
      JOIN travel_orders t ON ti.travel_order_id = t.id
      WHERE ti.product_id = $1 AND t.status IN ('pending', 'awaiting_stock') AND ti.quantity_out > 0
    `, [productId]);

    const sepRes = await pool.query(`
      SELECT s.id as request_id, 'Separação OP: ' || s.client_name as sector, si.quantity as quantity
      FROM separation_items si
      JOIN separations s ON si.separation_id = s.id
      WHERE si.product_id = $1 AND s.status = 'em_separacao' AND si.quantity > 0
    `, [productId]);

    const repRes = await pool.query(`
      SELECT rep.id as request_id, 'Reposição: ' || rep.client_name as sector, ri.quantity as quantity
      FROM replenishment_items ri
      JOIN replenishments rep ON ri.replenishment_id = rep.id
      WHERE ri.product_id = $1 AND rep.status = 'em_preparo' AND ri.quantity > 0
    `, [productId]);

    reservations.push(...reqRes.rows, ...travelRes.rows, ...sepRes.rows, ...repRes.rows);
    res.json(reservations);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao buscar reservas vinculadas' });
  }
};

export const updateStock = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  const { quantity_on_hand, quantity_reserved } = req.body;

  try {
    const userCheck = await pool.query('SELECT role, sector FROM profiles WHERE id = $1', [userId]);
    const isMaster = userCheck.rows[0]?.role === 'admin' || userCheck.rows[0]?.role === 'almoxarife';

    // Validação de permissões específicas para o setor de Usinagem
    if (!isMaster) {
      const stockItem = await pool.query(`SELECT p.tags FROM stock s JOIN products p ON s.product_id = p.id WHERE s.id = $1`, [id]);
      const hasTag = Array.isArray(stockItem.rows[0]?.tags) && stockItem.rows[0].tags.some((t: string) => t.toLowerCase() === 'usinagem');

      if (userCheck.rows[0]?.sector?.toLowerCase() !== 'usinagem' || !hasTag) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
    }

    // Sem campos => nada a fazer (idêntico ao 2.0: retorna sucesso).
    if (quantity_on_hand === undefined && quantity_reserved === undefined) {
      return res.json({ success: true });
    }

    await withTransaction(async (client) => {
      const row = await client.query(
        'SELECT product_id, warehouse_id, op_id, quantity_on_hand, quantity_reserved FROM stock WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (row.rows.length === 0) return; // id inexistente: no-op silencioso (comportamento do 2.0)

      const { product_id, warehouse_id, op_id } = row.rows[0];
      const curOnHand = parseFloat(row.rows[0].quantity_on_hand);
      const curReserved = parseFloat(row.rows[0].quantity_reserved);

      // Ajuste de inventário: on_hand ABSOLUTO via adjust (delta sob trava, gravado no razão).
      if (quantity_on_hand !== undefined) {
        await StockService.adjust(client, product_id, warehouse_id, op_id, Number(quantity_on_hand), {
          refType: 'stock_adjust', refId: id, userId,
          opKey: `stock:${id}:adjust:${Number(quantity_on_hand)}`,
          reason: 'Ajuste manual de inventário',
        });
      }

      // Ajuste do reservado (valor absoluto) -> delta reserve/release pelo motor.
      if (quantity_reserved !== undefined) {
        const target = Number(quantity_reserved);
        const delta = target - curReserved;
        if (delta > 0) {
          await StockService.reserve(client, product_id, warehouse_id, op_id, delta, {
            refType: 'stock_adjust', refId: id, userId, opKey: `stock:${id}:reserveadj:${target}`, reason: 'Ajuste manual de reserva',
          });
        } else if (delta < 0) {
          await StockService.release(client, product_id, warehouse_id, op_id, -delta, {
            refType: 'stock_adjust', refId: id, userId, opKey: `stock:${id}:releaseadj:${target}`, reason: 'Ajuste manual de reserva',
          });
        }
      }

      await createLog(userId, 'UPDATE_STOCK', { stock_id: id, old_qty: curOnHand, new_qty: quantity_on_hand }, getClientIp(req), client);
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Erro ao ajustar estoque' });
  }
};

export const manualWithdrawal = async (req: Request, res: Response) => {
  const { sector, items, op_code } = req.body;
  const userId = (req as any).user.id;

  // =========================================================================
  // 🛡️ 0. VALIDAÇÃO DE SEGURANÇA DO SETOR
  // =========================================================================
  const VALID_SECTORS = [
    "Elétrica", "Flow", "Esteira", "Lavadora", "Usinagem",
    "Desenvolvimento", "Protótipo", "Engenharia", "Outros",
    "Viagem", "Terceiros", "Acumulador", "Reposição"
  ];

  const normalizedSector = sector ? sector.toUpperCase() : "";
  const isValidSector = VALID_SECTORS.some(s => s.toUpperCase() === normalizedSector);

  if (!isValidSector) {
    return res.status(400).json({ error: "Setor de destino inválido ou não autorizado." });
  }

  try {
    validatePositiveItems(items);

    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      // =========================================================================
      // 🛡️ 1. REGRA DE NEGÓCIO: VERIFICA SE A OP É OBRIGATÓRIA (BASEADO EM TAGS)
      // =========================================================================
      let requiresOp = false;
      const exemptTags = ['camisetas', 'epi', 'ferramentas'];

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
          const tags = Array.isArray(product.tags) ? product.tags.map((t: string) => t.toLowerCase()) : [];
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
      // 🟢 SAÍDA MANUAL: cria a separação (manual/concluída) e consome pelo motor
      // =========================================================================
      const sepRes = await client.query(
        'INSERT INTO separations (destination, status, type, client_service_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [sector, 'concluida', 'manual', client_service_id]
      );
      const separationId = sepRes.rows[0].id;

      for (const item of items) {
        if (!item.product_id || !item.quantity) throw new Error("Item inválido.");

        const itemRes = await client.query(
          'INSERT INTO separation_items (separation_id, product_id, quantity, observation) VALUES ($1, $2, $3, $4) RETURNING id',
          [separationId, item.product_id, item.quantity, item.observation || null]
        );
        const itemId = itemRes.rows[0].id;

        // consume: baixa física + libera reserva correspondente (motor valida FURO_ESTOQUE).
        await StockService.consume(client, item.product_id, warehouseId, POOLED_OP_ID, Number(item.quantity), {
          refType: 'separation', refId: separationId, userId,
          opKey: `separation:${separationId}:item:${itemId}:consume`,
          reason: 'Saída manual de estoque',
        });
      }

      await createLog(userId, 'MANUAL_WITHDRAWAL', { separationId, sector }, getClientIp(req), client);
    });

    res.status(201).json({ success: true });
  } catch (error: any) {
    // Erro de domínio do motor (furo de estoque) -> 400 tratado, não 500 cru.
    if (error instanceof StockError) return res.status(400).json({ error: error.message });

    if (error.message === "OP_OBRIGATORIA_TAGS") return res.status(400).json({ error: "É obrigatório informar o número da OP para estes tipos de produtos." });
    if (error.message === "OP_NAO_ENCONTRADA") return res.status(404).json({ error: "OP não encontrada no sistema. Verifique o número digitado." });
    if (error.message === "OP_FINALIZADA") return res.status(400).json({ error: "Essa OP já foi finalizada, verifique a OP correta" });

    res.status(500).json({ error: error.message });
  }
};

// =========================================================================
// DEVOLUÇÕES DE ORDEM DE PRODUÇÃO (OP) E NOVA ENTRADA EM LOTE (ENTRIES)
// =========================================================================

export const getOpMaterialsForReturn = async (req: Request, res: Response) => {
  const { opCode } = req.params;

  try {
    const query = `
      WITH OPData AS (
          SELECT id FROM client_services WHERE op_code = $1
      ),
      Withdrawn AS (
          SELECT
              si.product_id,
              p.name,
              p.sku,
              SUM(si.quantity) as total_withdrawn
          FROM separations s
          JOIN separation_items si ON s.id = si.separation_id
          JOIN products p ON si.product_id = p.id
          WHERE s.client_service_id = (SELECT id FROM OPData)
          GROUP BY si.product_id, p.name, p.sku
      ),
      Returned AS (
          SELECT
              product_id,
              SUM(quantity) as total_returned
          FROM op_returns
          WHERE client_service_id = (SELECT id FROM OPData)
          GROUP BY product_id
      )
      SELECT
          w.product_id,
          w.name,
          w.sku,
          w.total_withdrawn,
          COALESCE(r.total_returned, 0) as total_returned,
          (w.total_withdrawn - COALESCE(r.total_returned, 0)) as available_to_return
      FROM Withdrawn w
      LEFT JOIN Returned r ON w.product_id = r.product_id
      WHERE (w.total_withdrawn - COALESCE(r.total_returned, 0)) > 0;
    `;

    const result = await pool.query(query, [opCode]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Nenhum material disponível para devolução nesta OP.' });
    }

    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro interno ao processar a busca da OP.' });
  }
};

export const registerReturn = async (req: Request, res: Response) => {
  const { op_code, returns } = req.body;
  const userId = (req as any).user.id;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      const opResult = await client.query('SELECT id FROM client_services WHERE op_code = $1', [op_code]);
      if (opResult.rows.length === 0) throw new Error('OP não encontrada no sistema.');
      const client_service_id = opResult.rows[0].id;

      for (const item of returns) {
        if (!item.product_id || !item.quantity || item.quantity <= 0) {
          throw new Error('Quantidade inválida para devolução.');
        }

        const retRes = await client.query(`
            INSERT INTO op_returns (client_service_id, product_id, quantity, user_id, observation)
            VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [client_service_id, item.product_id, item.quantity, userId, item.observation]);
        const returnId = retRes.rows[0].id;

        // Devolve ao físico pelo motor (entrada no ALMOX).
        await StockService.receive(client, item.product_id, warehouseId, POOLED_OP_ID, Number(item.quantity), {
          refType: 'op_return', refId: returnId, userId,
          opKey: `op_return:${returnId}:receive`,
          reason: 'Devolução de material de OP',
        });
      }

      await createLog(userId, 'OP_RETURN', { op_code, itemsReturned: returns.length }, getClientIp(req), client);
    });

    res.status(201).json({ success: true, message: 'Devolução registada com sucesso!' });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    res.status(400).json({ error: error.message || 'Erro ao processar devolução.' });
  }
};

// =========================================================================
// ENTRADA DE STOCK EM LOTE (NFe / Reaproveitamento)
// =========================================================================

export const registerEntries = async (req: Request, res: Response) => {
  const { nf_number, entries } = req.body;
  // Contrato 5.0: nf_number e type no CABEÇALHO do body. Fallback ao legado (type por item)
  // enquanto o front não migra (Etapa 2).
  const type = req.body.type ?? entries?.[0]?.type;
  const userId = (req as any).user.id;

  // Idempotência do reaproveitamento: âncora estável vinda do cliente (retry/refresh/duplo-clique).
  // Só string; header repetido (array) ou vazio → tratado como AUSENTE (fallback ao logId).
  const rawIdem = req.headers['x-idempotency-key'];
  const idemKey = typeof rawIdem === 'string' && rawIdem.trim() ? rawIdem.trim() : null;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'Nenhuma entrada fornecida.' });
  }

  // Entrada por NF exige número rastreável. Reaproveitamento (type != 'NFe') dispensa por ora.
  const isNFe = type === 'NFe';
  const nf = typeof nf_number === 'string' ? nf_number.trim() : '';
  if (isNFe && !nf) {
    return res.status(400).json({ error: 'Número da NF é obrigatório para entrada por NFe.' });
  }

  // Agrupa por product_id somando a quantidade -> 1 receive por produto. Coerente com o op_key
  // por NF (mesmo produto na mesma NF = uma única chave; sem isto, a 2ª linha do produto seria
  // descartada como duplicata idempotente e a quantidade se perderia).
  const byProduct = new Map<string, number>();
  for (const entry of entries) {
    const product_id = entry?.product_id;
    const qty = Number(entry?.quantity);
    if (!product_id) {
      return res.status(400).json({ error: 'Item inválido, falta Produto.' });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Quantidade inválida: informe um número maior que zero.' });
    }
    byProduct.set(product_id, (byProduct.get(product_id) ?? 0) + qty);
  }

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, userId);

      // Bloqueia reenvio de NF já cadastrada (só NFe com número). O op_key já protege o SALDO;
      // este check protege a UX — avisa o usuário em vez de silenciosamente não fazer nada.
      // Padrão do controller: throw + conversão pra 400 no catch. NÃO usar `return res.status()`
      // aqui: o return dentro do withTransaction NÃO faz rollback (comita) e ainda cairia no
      // res.status(201) lá embaixo -> "headers already sent". O throw faz o ROLLBACK correto.
      if (isNFe && nf) {
        const jaExiste = await client.query(
          'SELECT id FROM xml_logs WHERE nf_number = $1 LIMIT 1',
          [nf]
        );
        if (jaExiste.rows.length > 0) {
          throw new Error('NF_DUPLICADA'); // rollback pelo withTransaction -> nada é gravado
        }
      }

      // 1. Log de cabeçalho na xml_logs (para o Reports.tsx conseguir ler) — agora com nf_number.
      const typeLabel = type === 'REAPROVEITAMENTO' ? '♻️ Reaproveitamento' : '📦 Entrada NFe';

      const logRes = await client.query(
        "INSERT INTO xml_logs (file_name, success, total_items, nf_number) VALUES ($1, $2, $3, $4) RETURNING id",
        [`${typeLabel} - ${new Date().toLocaleString('pt-BR')}`, true, byProduct.size, nf || null]
      );

      const logId = logRes.rows[0].id;

      for (const [product_id, quantity] of byProduct) {
        // Item de detalhe: 1 linha por produto agregado (casa 1:1 com o receive/razão).
        await client.query(
          "INSERT INTO xml_items (xml_log_id, product_id, quantity) VALUES ($1, $2, $3)",
          [logId, product_id, quantity]
        );

        // 2. Entrada física pelo motor (cria a linha LAZY se não existir).
        // op_key idempotente POR NF (não mais por UUID de linha) -> reenvio da MESMA NF não duplica saldo.
        // Sem NF (reaproveitamento): chave estável por log+produto (logId é único -> não colide entre entradas).
        // NF: inalterado (âncora = nf_number). Reuse: âncora = x-idempotency-key se presente;
        // senão, fallback ao logId (comportamento atual — sem dedupe entre requests distintos).
        const opKey = nf
          ? `entry:nf:${nf}:product:${product_id}:receive`
          : `entry:reuse:${idemKey ?? logId}:product:${product_id}:receive`;

        await StockService.receive(client, product_id, warehouseId, POOLED_OP_ID, quantity, {
          refType: 'entry', refId: String(logId), userId,
          opKey,
          nfNumber: nf || null,
          reason: `Entrada de estoque (${type || 'NFe'})`,
        });
      }

      await createLog(userId, 'STOCK_ENTRY', { type, nf_number: nf || null, totalItems: byProduct.size }, getClientIp(req), client);
    });

    // Notificações Push (mesmo evento do 2.0)
    if ((req as any).io) {
      (req as any).io.to('compras').emit('new_request_notification', {
        message: '📦 Nova Entrada/Reaproveitamento de Stock registada!',
        action: 'Ver Estoque',
        type: 'entrada'
      });
    }

    res.status(201).json({ success: true, message: 'Entradas registadas com sucesso.' });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'NF_DUPLICADA') return res.status(400).json({ error: 'Esta NF-e já foi cadastrada.' });
    // Concorrência do reaproveitamento: 2 POSTs paralelos com a MESMA x-idempotency-key.
    // O 1º comitou o saldo; o 2º passou o SELECT-dedupe antes do commit e bateu no índice único do
    // op_key (23505). O withTransaction já fez ROLLBACK -> a 2ª transação NÃO gravou nada em duplicidade,
    // o saldo persistido é o do 1º POST. Trata SOMENTE a nossa constraint como idempotente; qualquer
    // outro 23505 (constraint diferente) RE-LANÇA para não mascarar bug real.
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      const opKeyConflict = /\(op_key\)=\(([^)]*)\)/.exec(error?.detail ?? '')?.[1] ?? null;
      console.warn(JSON.stringify({ event: 'reuse_idempotent_conflict', op_key: opKeyConflict }));
      // Resposta idempotente: mesmo shape/status do sucesso normal do reuse (o crédito do 1º POST vale).
      return res.status(201).json({ success: true, message: 'Entradas registadas com sucesso.' });
    }
    res.status(500).json({ error: error.message || 'Erro interno ao registar as entradas.' });
  }
};
