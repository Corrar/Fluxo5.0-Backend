// src/controllers/clients.controller.ts

import { Request, Response } from 'express';
import { pool } from '../db';
import { totalCostSql } from '../services/opCost';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

export const getClients = async (req: Request, res: Response) => {
  try {
    const clientsQuery = `
        SELECT c.*, 
               COALESCE(
                 json_agg(
                   json_build_object(
                     'id', s.id, 
                     'op_code', s.op_code, 
                     'description', s.description, 
                     'status', s.status,
                     -- CUSTO DA OP = tudo que saiu do almoxarifado com esta OP, menos o que voltou.
                     -- A regra (as três pernas de saída, a perna de devolução, o preço e o que fica
                     -- DE FORA) mora em services/opCost.ts, que é o ÚNICO dono dela. Antes deste
                     -- lote a fórmula estava escrita AQUI e copiada em mais dois lugares, e as três
                     -- discordavam — a daqui contava só separação 'concluida' (que é a SAÍDA MANUAL)
                     -- e ignorava as 1.435 solicitações entregues e as 12 separações reais.
                     -- 's.id' é o client_services.id correlacionado do json_agg de fora: é
                     -- referência de CÓDIGO, o único tipo que pode ser interpolado ali.
                     -- (sem crase neste bloco de propósito: a string é template literal e uma
                     --  crase dentro de um comentário SQL FECHA a string — quebrou o build uma vez.)
                     'total_cost', ${totalCostSql('s.id')}
                   )
                 ) FILTER (WHERE s.id IS NOT NULL), '[]'::json
               ) as services
        FROM clients c
        LEFT JOIN client_services s ON c.id = s.client_id
        GROUP BY c.id
        ORDER BY c.created_at DESC
    `;
    const result = await pool.query(clientsQuery);
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createClient = async (req: Request, res: Response) => {
  try {
    const { code, name } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Código e Nome são obrigatórios.' });
    const query = `INSERT INTO clients (code, name) VALUES ($1, $2) RETURNING *`;
    const result = await pool.query(query, [code, name]);
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') return res.status(400).json({ error: 'Já existe um cliente com este código.' });
    res.status(500).json({ error: error.message });
  }
};

export const updateClient = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'O novo nome é obrigatório.' });
    const query = `UPDATE clients SET name = $1 WHERE id = $2 RETURNING *`;
    const result = await pool.query(query, [name, id]);
    res.json(result.rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteClient = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Tenta primeiro apagar as OPs filhas que estejam "vazias"
    // Se a OP já foi usada no sistema, o erro 23503 é disparado aqui e o processo é interrompido em segurança.
    await client.query('DELETE FROM client_services WHERE client_id = $1', [req.params.id]);
    
    // Apaga o cliente
    await client.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    // Captura o erro de chave estrangeira de forma amigável
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Ação bloqueada: Não podes excluir este cliente, pois já existem peças movimentadas para uma de suas OPs.' });
    }
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
};

// ── O VOCABULÁRIO DE STATUS DA OP (migration 021) ──────────────────────────────────────────
// FECHADO em dois valores. Esta lista é a MESMA do CHECK `client_services_status_chk`, e as duas
// têm que andar juntas: quem mexer aqui mexe na migration, e vice-versa. A borda existe para dar
// 400 com mensagem legível; o CHECK existe para o caminho que não passa por aqui (script de
// carga, psql). Nenhum dos dois substitui o outro.
const OP_STATUS_VALIDOS = ['em_andamento', 'concluido'] as const;

// Palavras que o front antigo (e só ele) manda. Mantidas de propósito: o consumidor no ar ainda
// as usa em algum caminho e traduzi-las é retrocompatibilidade barata. A normalização roda ANTES
// da whitelist — 'finalizada' entra, vira 'concluido' e passa; 'banana' entra e toma 400.
const OP_STATUS_LEGADO: Record<string, string> = {
  finalizada: 'concluido',
  done: 'concluido',
  progress: 'em_andamento',
};

export const createService = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { op_code, description } = req.body;
    if (!op_code) return res.status(400).json({ error: 'O código da OP é obrigatório.' });
    // `status` EXPLÍCITO, e não herdado do DEFAULT da coluna. O INSERT antigo omitia a coluna, e
    // como o DEFAULT era 'pendente', TODA OP criada pela tela nascia num estado que o resto do
    // sistema não reconhecia (o front a exibia como "Em andamento" pelo fallback). A 021 conserta
    // o DEFAULT, mas depender de DEFAULT foi a causa raiz — dizer o valor aqui é o que impede a
    // dívida de renascer no próximo INSERT que alguém escrever.
    const query = `INSERT INTO client_services (client_id, op_code, description, status) VALUES ($1, $2, $3, 'em_andamento') RETURNING *`;
    const result = await pool.query(query, [id, op_code, description]);
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') return res.status(400).json({ error: 'Esta OP já está registrada.' });
    res.status(500).json({ error: error.message });
  }
};

export const updateServiceStatus = async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const bruto = req.body?.status;

    // 1. AUSÊNCIA é 400, não NULL no banco. Antes, corpo sem `status` chegava como undefined ao
    //    parâmetro do UPDATE, o node-postgres o convertia em null e a coluna (nullable) aceitava:
    //    a OP ficava sem status nenhum e seguia sendo exibida como "Em andamento". Recusar na
    //    borda é o conserto; o NOT NULL da 021 é a rede embaixo.
    if (bruto === undefined || bruto === null || (typeof bruto === 'string' && bruto.trim() === '')) {
      return res.status(400).json({ error: 'O status da OP é obrigatório.' });
    }
    if (typeof bruto !== 'string') {
      return res.status(400).json({ error: 'Status inválido. Use: em_andamento ou concluido.' });
    }

    // 2. Normalização legada (comportamento preservado), depois whitelist.
    const limpo = bruto.trim();
    const status = OP_STATUS_LEGADO[limpo] ?? limpo;

    if (!(OP_STATUS_VALIDOS as readonly string[]).includes(status)) {
      return res.status(400).json({ error: 'Status inválido. Use: em_andamento ou concluido.' });
    }

    const r = await pool.query('UPDATE client_services SET status = $1 WHERE id = $2', [status, serviceId]);

    // 3. rowCount 0 é 404. O `{ success: true }` incondicional de antes respondia "deu certo" para
    //    um serviceId que não existe — a tela recarregava, nada mudava, e ninguém sabia por quê.
    if (r.rowCount === 0) return res.status(404).json({ error: 'OP não encontrada.' });

    res.json({ success: true });
  } catch (error: any) {
    // serviceId que não é UUID: o Postgres devolve 22P02 (invalid_text_representation) antes de
    // comparar com linha nenhuma. Semanticamente é o mesmo caso do rowCount 0 — não existe OP com
    // esse identificador — e merece a mesma resposta, não um 500 que sugere servidor quebrado.
    if (error?.code === '22P02') return res.status(404).json({ error: 'OP não encontrada.' });
    // BACKSTOP do CHECK da 021. Só chega aqui se a whitelist acima e o CHECK divergirem — ou seja,
    // se alguém mexer num dos dois sem o outro. É recusa de regra, e 500 mentiria sobre a causa.
    if (error?.code === '23514' && error?.constraint === 'client_services_status_chk') {
      return res.status(400).json({ error: 'Status inválido. Use: em_andamento ou concluido.' });
    }
    res.status(500).json({ error: 'Erro ao atualizar o status da OP: ' + error.message });
  }
};

export const deleteService = async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM client_services WHERE id = $1', [req.params.serviceId]);
    res.json({ success: true });
  } catch (error: any) {
    // Retorna erro amigável se a OP já tiver itens movimentados no sistema
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Ação bloqueada: Já existem movimentações de estoque associadas a esta OP. Não podes apagá-la.' });
    }
    res.status(500).json({ error: error.message });
  }
};

// =========================================================================
// FUNÇÃO: TRANSFERÊNCIA DE DADOS ENTRE OPs (COMPLETA)
// =========================================================================
export const transferServiceData = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { serviceId } = req.params; // OP de origem (a errada, que vai ficar vazia)
    const { targetServiceId } = req.body; // OP de destino (a correta, que vai receber)

    if (!targetServiceId) return res.status(400).json({ error: "A OP de destino é obrigatória." });
    if (serviceId === targetServiceId) return res.status(400).json({ error: "Não podes transferir para a mesma OP." });

    await client.query('BEGIN');
    
    // 1. Encontrar os Textos (Códigos) das OPs
    const oldOpRes = await client.query('SELECT op_code FROM client_services WHERE id = $1', [serviceId]);
    const targetOpRes = await client.query('SELECT op_code FROM client_services WHERE id = $1', [targetServiceId]);
    
    if (oldOpRes.rows.length === 0 || targetOpRes.rows.length === 0) {
        throw new Error("OP de origem ou destino não encontrada no sistema.");
    }

    const oldOpCode = oldOpRes.rows[0].op_code;
    const targetOpCode = targetOpRes.rows[0].op_code;

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 🛑 GUARD (lote TR1) — OP DE ORIGEM COM RAZÃO DE MATERIAL NÃO SE TRANSFERE
    //
    // Este handler move PONTEIROS DE DOCUMENTO (requests, separations, op_returns). Ele NÃO
    // move `op_material_events`, e não é esquecimento: aquele razão é APPEND-ONLY (doutrina da
    // 008), e a casa já tem a operação certa para mover material entre OPs —
    // `POST /op-materials/transfer`, que emite o PAR transferido_out/transferido_in com advisory
    // lock, guard de saldo e `warehouse_id`. Ela é por (armazém, produto, quantidade) e exige que
    // o setor DETENHA o material; este endpoint não tem nenhuma dessas três coisas.
    //
    // Sem este guard, transferir uma OP com razão deixa o material na OP ANTIGA enquanto o custo
    // vai inteiro para a nova: a tela de Clientes e OPs mostra a origem zerada e o Armazém segue
    // mostrando o WIP nela. Medido em 21/08: a 901001 levaria 221 solicitações e deixaria
    // 11 eventos / 3.308 unidades para trás.
    //
    // ⚠ SÓ A ORIGEM É VERIFICADA, e isso é decisão medida — não economia. O evento órfão nasce de
    // ESVAZIAR uma OP que tem razão. Despejar documentos NUMA OP que já tem razão não órfã nada:
    // os eventos do destino continuam apontando para os documentos do destino, que não se movem.
    // Medido em produção (21/08): dos 39 eventos com origem, ZERO apontam para OP diferente da do
    // seu documento — e é exatamente essa invariante que o guard preserva.
    //
    // 409 e não 400: o corpo da requisição está correto: quem recusa é o ESTADO da OP.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const razaoOrigem = await client.query(
      `SELECT count(*)::int AS eventos, COALESCE(SUM(qty), 0)::float8 AS unidades
         FROM op_material_events WHERE client_service_id = $1`,
      [serviceId]
    );
    const { eventos, unidades } = razaoOrigem.rows[0];
    if (eventos > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'OP_COM_RAZAO',
        error: `Esta OP tem material registrado no razão (${eventos} ${eventos === 1 ? 'evento' : 'eventos'}, ${unidades} ${unidades === 1 ? 'unidade' : 'unidades'}). `
             + `Transferir deixaria esse material na OP antiga. Use a transferência de material por OP (Produção → apontamento) ou zere o razão antes.`,
        eventos,
        unidades,
      });
    }

    // -----------------------------------------------------------
    // 🛡️ TRANSFERÊNCIA DE VÍNCULOS
    // -----------------------------------------------------------

    // 2. Move os Pedidos/Solicitações (Busca por ID)
    const movRequests = await client.query(
      `UPDATE requests SET client_service_id = $1 WHERE client_service_id = $2`,
      [targetServiceId, serviceId]
    );

    // 3. Atualiza os textos avulsos dentro dos itens dos pedidos (Busca por Texto)
    // ⚠ FÓSSIL, mantido de propósito neste lote (que é de guard, não de limpeza): medido em
    // produção, `request_items.client_service` tem 159 textos não vazios, 54 distintos, e ZERO
    // casam com qualquer `op_code` — são nomes de setor e apelido de cliente ("Embaladora",
    // "Uso interno"). Este UPDATE nunca casou uma linha. O log abaixo passa a registrar o
    // rowCount dele, que é a evidência viva do fóssil. Ver DIVIDAS.md.
    const movItensTexto = await client.query(
      `UPDATE request_items SET client_service = $1 WHERE client_service = $2`,
      [targetOpCode, oldOpCode]
    );

    // 4. Move as Saídas Manuais e Separações (Busca por ID E por Texto)
    // Atualiza tanto as Saídas Manuais novas (ID) como as Separações antigas (Texto)
    const movSeparations = await client.query(
      `UPDATE separations
       SET client_service_id = $1, production_order = $2
       WHERE client_service_id = $3 OR production_order = $4`,
      [targetServiceId, targetOpCode, serviceId, oldOpCode]
    );

    // 5. Move também as Devoluções feitas! (NOVO)
    const movReturns = await client.query(
      `UPDATE op_returns SET client_service_id = $1 WHERE client_service_id = $2`,
      [targetServiceId, serviceId]
    );

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 📋 AUDITORIA (lote TR1) — NA MESMA TRANSAÇÃO, com as CONTAGENS REAIS
    //
    // Até aqui esta operação não escrevia NADA em audit_logs, e as tabelas que ela reescreve não
    // têm coluna de última alteração: um transfer era irreversível E não atribuível. Medido:
    // 144 solicitações já foram movidas assim, sem um único registro de quem, quando ou de onde.
    //
    // Os números são os `rowCount` REAIS de cada UPDATE, não estimativa — é o que permite
    // reconstruir o movimento depois. E o log vai com o `client` da transação: se o COMMIT não
    // acontecer, o log não sobrevive. Log de operação que não aconteceu é pior que log nenhum.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const userId = (req as any).user?.id ?? null;
    await createLog(
      userId,
      'TRANSFERIR_MOVIMENTACOES_OP',
      {
        origem:  { id: serviceId,       op_code: oldOpCode },
        destino: { id: targetServiceId, op_code: targetOpCode },
        movidos: {
          requests:            movRequests.rowCount    ?? 0,
          separations:         movSeparations.rowCount ?? 0,
          op_returns:          movReturns.rowCount     ?? 0,
          request_items_texto: movItensTexto.rowCount  ?? 0,
        },
      },
      getClientIp(req),
      client
    );

    // ⚠ SONDA: `createLog` ENGOLE o próprio erro (try/catch interno). Dentro de uma transação
    // isso é armadilha — a transação fica ABORTADA e o COMMIT seguinte vira ROLLBACK silencioso,
    // devolvendo "sucesso" para um transfer que não aconteceu. Este SELECT estoura se a
    // transação estiver abortada, e o catch lá embaixo devolve 500. Uma linha, e o silêncio some.
    await client.query('SELECT 1');

    await client.query('COMMIT');
    res.json({ success: true, message: "Todas as movimentações foram transferidas com sucesso!" });
  } catch (error: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
};
