import { Request, Response } from 'express';
import { pool, query, withTransaction } from '../db';
import { StockService, StockError } from '../services/stock.service';
import { emitStockChanged } from '../config/socket';
import { resolveWarehouseId, POOLED_OP_ID } from '../services/warehouse';
import { creditarProducaoNoItem } from '../services/requests3d';

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
    // RETRY: leitura idempotente via query({retryable:true}) — era pool.query cru, sem defesa de cold
    // start do Neon. O grão aqui é subquery (a query começa com SELECT, então o auto-detect até
    // pegaria); {retryable:true} explícito blinda o intento e sobrevive a virar CTE no futuro.
    const { rows } = await query(`
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
    `, [], { retryable: true });

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

// ── WHITELIST DE TRANSIÇÃO DA DEMANDA (lote I-b, item 3) ─────────────────────────────────────
// Irmã do TRANSICOES de requests.controller, e pelo mesmo motivo: sem ela o PUT aceita QUALQUER
// pulo. O pulo que importa é `Rejeitada -> Concluída` — a porta de crédito indevido: a fábrica
// recusa a peça, alguém arrasta o card de volta pra "Concluída" e o sistema credita estoque de
// uma peça que ninguém imprimiu. Não era hipótese: só os guards de re-conclusão existiam
// (Concluída->Concluída e Cancelada->Concluída), e Rejeitada passava reto.
//
// As chaves são o vocabulário EXATO que o front envia (P3_DEM_FRONT2BACK em producao3d.jsx) e o
// mesmo que o DEFAULT da coluna grava ('Em análise'). Acentos incluídos de propósito: comparar
// sem acento seria inventar um segundo vocabulário.
const TRANSICOES_DEMANDA: Record<string, string[]> = {
  'Em análise':         ['Aceita', 'Rejeitada', 'Cancelada'],
  'Aceita':             ['Em desenvolvimento', 'Rejeitada', 'Cancelada'],
  // 'Rejeitada' SAI de 'Em desenvolvimento' por decisão do arquiteto (08/08/2026), e o motivo é
  // de TELA: o botão "Recusar" do Kanban aparece em todo card não-terminal, inclusive na coluna
  // Produzindo (producao3d.jsx:545). Fechar esta saída transformaria um botão que funciona num
  // 400. O escape que restaria — "Excluir demanda", que leva a 'Cancelada' — NÃO coleta motivo,
  // e o motivo é justamente o que a recusa existe para registrar. Peça que falhou na impressão é
  // recusa legítima, não cancelamento administrativo.
  'Em desenvolvimento': ['Concluída', 'Rejeitada', 'Cancelada'],
  // TERMINAIS. Concluída moveu estoque; Rejeitada/Cancelada encerraram a peça. Nenhum destino.
  'Concluída':          [],
  'Rejeitada':          [],
  'Cancelada':          [],
};

// ⚠ `demands_3d.status` é NULLABLE e SEM CHECK — o mesmo furo que a migration 021 fechou em
// client_services.status. Não há migration neste lote (decisão do arquiteto), então a whitelist
// é a única trava e ela é FAIL-CLOSED: status atual fora do vocabulário (inclusive NULL) recusa a
// transição em vez de adivinhar. Adivinhar 'Em análise' para um NULL seria inventar estado, e é
// exatamente assim que 'pendente' sobreviveu anos em client_services. Nenhuma linha NULL pode
// NASCER (o DEFAULT cobre o INSERT e daqui em diante todo UPDATE passa por esta lista); a demanda
// travada continua cancelável pelo DELETE, que não consulta esta tabela. Dívida REPORTADA.

// Status de SOLICITAÇÃO que ainda espera a peça — os únicos em que a conclusão RESERVA.
// Fechado por INCLUSÃO, nunca por exclusão: status novo/desconhecido cai no lado "morta", que
// deixa a peça em estoque livre. Errar para o lado livre é recuperável (a peça está na
// prateleira); errar para o lado reservado cria órfã sem dono, que é o defeito que este lote mata.
const REQUEST_VIVA = new Set(['aberto', 'aprovado', 'conferido']);
// Teto defensivo do texto livre (a coluna é TEXT, sem limite no banco).
const DEMAND_TEXT_MAX = 2000;
// Normaliza texto livre vindo do body: string vazia/whitespace/não-string -> null (não grava '').
const normText = (v: any): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, DEMAND_TEXT_MAX) : null;
};

export const updateDemandStatus = async (req: Request, res: Response) => {
  // Saldo alterado nesta operação (conclusão de demanda = receive + reserve). Emitido só após o commit.
  const produtosTocados: Array<string | null> = [];
  const { id } = req.params;
  const { status, reason } = req.body;
  const userId = (req as any).user.id;
  // Só faz sentido na transição p/ recusa; nos demais status o motivo é ignorado (ver UPDATE abaixo).
  const rejectionReason = normText(reason);

  try {
    await withTransaction(async (client) => {
      // ORDEM DE LOCK: SOLICITAÇÃO ANTES DA DEMANDA — e isto é obrigatório, não estilo.
      // A partir do item 4 deste lote a morte da solicitação CANCELA as demandas vivas dela, ou
      // seja aquele caminho trava request e depois escreve em demands_3d. Se aqui travássemos a
      // demanda primeiro e a solicitação depois, os dois caminhos formariam um ciclo clássico e o
      // Postgres mataria um dos dois com 40P01 sob concorrência real. Travando na MESMA ordem nos
      // dois lados, o ciclo não existe.
      // `request_id` é imutável na vida da demanda (escrito no INSERT do createRequest e nunca
      // atualizado), então lê-lo SEM trava para decidir o que travar é seguro.
      const pre = await client.query('SELECT request_id FROM demands_3d WHERE id = $1', [id]);
      if (pre.rows.length === 0) throw new Error('DEMANDA_NAO_ENCONTRADA');
      const requestIdPre = pre.rows[0].request_id;

      // Status da solicitação NO MOMENTO DA CONCLUSÃO — é ele que decide se a peça nasce
      // reservada ou livre. Travado junto: sem o FOR UPDATE, uma rejeição concorrente poderia
      // comitar entre esta leitura e o reserve, e a peça ficaria reservada para uma solicitação
      // que acabou de morrer — a órfã do cruzamento §5, de novo, só que por corrida.
      let statusSolicitacao: string | null = null;
      if (requestIdPre) {
        const r = await client.query('SELECT status FROM requests WHERE id = $1 FOR UPDATE', [requestIdPre]);
        statusSolicitacao = r.rows[0]?.status ?? null;
      }

      // GUARD DE RE-CONCLUSÃO: trava a LINHA da demanda ANTES de qualquer escrita -> consistente sob
      // concorrência (2 conclusões paralelas serializam aqui). Padrão do replenishments (4479760).
      // request_item_id (migration 020) entra no SELECT para o crédito por ITEM abaixo — é o
      // rateio que diz QUAL linha da solicitação esta peça satisfaz.
      const cur = await client.query('SELECT status, request_id, quantity, product_id, request_item_id FROM demands_3d WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) throw new Error('DEMANDA_NAO_ENCONTRADA');
      const atual = cur.rows[0].status;
      // Os dois guards específicos vêm ANTES da whitelist de propósito: a whitelist também barraria
      // estes dois casos (Concluída e Cancelada são terminais), mas com a mensagem genérica. Quem
      // re-arrasta um card já concluído merece ouvir "já concluída", não "transição inválida".
      if (status === 'Concluída' && atual === 'Concluída') throw new Error('DEMANDA_JA_CONCLUIDA');
      if (status === 'Concluída' && atual === 'Cancelada') throw new Error('DEMANDA_CANCELADA');

      // WHITELIST DE TRANSIÇÃO (item 3). Roda depois do FOR UPDATE (verdade travada) e antes de
      // qualquer escrita — mesmo lugar e mesmo motivo do TRANSICOES de requests.controller.
      if (typeof atual !== 'string' || !(atual in TRANSICOES_DEMANDA)) {
        throw new Error(`DEMANDA_STATUS_DESCONHECIDO:${atual === null ? 'NULL' : String(atual)}`);
      }
      if (!TRANSICOES_DEMANDA[atual].includes(status)) {
        throw new Error(`TRANSICAO_DEMANDA_INVALIDA:${atual}:${status}`);
      }

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
        // AUDIT DA RECUSA — não existia. A recusa gravava `rejection_reason` na própria demanda e
        // mais nada: quem recusou e quando ficava fora do livro. A conclusão auditava, o
        // cancelamento passou a auditar neste lote, e a recusa era o terceiro desfecho, mudo.
        // Ganha peso agora que 'Em desenvolvimento' → 'Rejeitada' abriu: recusar peça JÁ EM
        // PRODUÇÃO descarta trabalho e filamento, e é o tipo de ato que precisa de dono no livro.
        // `status_anterior` é o que distingue "a fábrica não aceitou o pedido" de "a peça falhou
        // na impressora" — dois fatos diferentes que sem isto teriam o mesmo registro.
        await client.query(
          `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
          [userId, 'REJEITAR_DEMANDA_3D', JSON.stringify({
            demand_id: id,
            request_id: requestIdPre ?? null,
            status_anterior: atual,
            motivo: rejectionReason,
          })],
        );
      } else {
        await client.query('UPDATE demands_3d SET status = $1 WHERE id = $2', [status, id]);
      }

      if (status === 'Concluída') {
        const quantity = Number(cur.rows[0].quantity);
        const productId = cur.rows[0].product_id;
        const requestId = cur.rows[0].request_id;

        if (productId) {
          produtosTocados.push(productId);   // p/ o stock_updated pós-commit
          const warehouseId = await resolveWarehouseId(client, userId);

          // A PERGUNTA QUE DECIDE TUDO: a solicitação ainda espera esta peça?
          // Viva  -> a peça nasce PRESA para ela (receive + reserve + crédito no item).
          // Morta -> a peça é real e entra no físico, mas não pertence a ninguém: receive puro,
          //          estoque LIVRE. Reservar para uma solicitação encerrada é exatamente como
          //          nascem as órfãs do cruzamento (§5) — reserva no pooled sem porta de saída,
          //          porque a rejeição/cancelamento/expiração daquela solicitação JÁ passaram.
          //          Com esta regra a órfã fica impossível POR CONSTRUÇÃO, não por limpeza.
          const solicitacaoViva = !!requestId && REQUEST_VIVA.has(String(statusSolicitacao));

          // 1. Peça impressa ENTRA no físico — SEMPRE, viva ou morta a solicitação. A peça existe:
          //    negar a entrada seria perder estoque real. receive PRIMEIRO (aumenta disponível +
          //    cria a linha LAZY se faltar). op_key content-addressed: re-concluir com a mesma qty
          //    = no-op idempotente (fim da dupla entrada).
          await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, quantity, {
            refType: 'demand_3d', refId: id, userId,
            opKey: `demand:${id}:conclude:receive:${quantity}`,
            reason: 'Produção 3D concluída (entrada no estoque)',
          });

          if (solicitacaoViva) {
            // 2. SEGURA a peça produzida p/ a solicitação que a aguarda. reserve DEPOIS (o receive
            //    já garantiu disponível). Sem isto, a peça viraria estoque livre -> furo na entrega.
            await StockService.reserve(client, productId, warehouseId, POOLED_OP_ID, quantity, {
              refType: 'demand_3d', refId: id, userId,
              opKey: `demand:${id}:conclude:reserve:${quantity}`,
              reason: 'Reserva da peça 3D produzida para a solicitação',
            });

            // 3. CRÉDITO NO ITEM (lote I-a). O reserve acima prende a peça no SALDO; este passo diz
            //    a QUEM ela pertence. `qty_reserved` é o que a entrega exige e o que a rejeição
            //    libera — sem o crédito, a peça produzida ficaria reservada e invisível para o item,
            //    e a entrega recusaria uma peça que está na prateleira. A resolução do item (vínculo
            //    direto, fallback por produto, excedente) vive em services/requests3d.
            const itemCreditado = await creditarProducaoNoItem(client, {
              requestId, productId, requestItemId: cur.rows[0].request_item_id ?? null, qty: quantity,
            });
            if (!itemCreditado) {
              // Solicitação viva mas sem linha daquele produto: a peça entra no físico e fica
              // reservada sem dono. Não é silencioso — é o formato de órfã que este lote veio
              // matar, e precisa aparecer no log se algum dia acontecer.
              console.warn(JSON.stringify({
                event: 'demand3d_conclude_sem_item', demand_id: id,
                request_id: requestId ?? null, product_id: productId, quantity,
              }));
            }
          } else {
            // PEÇA EM ESTOQUE LIVRE. `qty_reserved` fica INTOCADO de propósito: a solicitação
            // morta já liberou o que segurava (pelas portas 4/6/8 do lote I-a) e somar aqui
            // ressuscitaria a reserva que aquelas portas acabaram de desfazer.
            // Audit ESTRUTURADO — este é o caminho que antes não existia e que, quando o operador
            // olhar o estoque, explica por que a peça está livre em vez de reservada.
            await client.query(
              `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
              [userId, 'ENTRADA_ESTOQUE_3D_LIVRE', JSON.stringify({
                motivo: 'demanda concluída para solicitação encerrada — peça em estoque livre',
                demand_id: id,
                request_id: requestId ?? null,
                request_status: statusSolicitacao,
                product_id: productId,
                quantity,
              })],
            );
            console.warn(JSON.stringify({
              event: 'demand3d_conclude_solicitacao_encerrada', demand_id: id,
              request_id: requestId ?? null, request_status: statusSolicitacao,
              product_id: productId, quantity,
            }));
          }

          // Auditoria oficial (INALTERADA).
          await client.query(
            `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
            [userId, 'ENTRADA_ESTOQUE_3D', JSON.stringify({ product_id: productId, quantity, reason: 'Produção 3D Concluída' })]
          );
        }

        // A RESSURREIÇÃO MORREU AQUI (item 1). Existia um `UPDATE requests SET status='aprovado'`
        // neste ponto, sem olhar em que estado a solicitação estava. Ele fazia duas coisas erradas:
        //  1. RESSUSCITAVA solicitação REJEITADA/cancelada/expirada — o card voltava a 'aprovado'
        //     depois de morto, e a peça era reservada para um pedido que ninguém mais esperava;
        //  2. PROMOVIA 'aberto' -> 'aprovado' pelas costas do gate humano. Aprovar não é carimbo:
        //     é onde o almoxarife define as QUANTIDADES no painel de conferência. O atalho pulava
        //     essa decisão e a solicitação chegava na entrega com quantidade que ninguém conferiu.
        // A conclusão da demanda NÃO MEXE MAIS em status de solicitação — nenhum, em hipótese
        // nenhuma. Ela move ESTOQUE; quem move o estado do pedido é quem tem autoridade sobre ele.
        //
        // O atrito que isto poderia criar já foi resolvido pelo lote I-a: 'conferido' FICA
        // conferido, e o excedente produzido além do conferido sai na ENTREGA, pela liberação de
        // excedente. Concluir não obriga mais a reconferir.
      }
    });

    // A conclusão da demanda dá receive + reserve no pooled e NÃO avisava ninguém — este
    // controller não tinha emit nenhum. A Vitrine 3D e as telas de saldo dependiam do F5.
    emitStockChanged(produtosTocados, (req as any).io);

    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'DEMANDA_NAO_ENCONTRADA') return res.status(404).json({ error: 'Demanda não encontrada.' });
    if (error.message === 'DEMANDA_JA_CONCLUIDA') return res.status(400).json({ error: 'Demanda já concluída.' });
    if (error.message === 'DEMANDA_CANCELADA') return res.status(400).json({ error: 'Demanda cancelada.' });
    // Sentinelas da whitelist (item 3). Nomeiam DE e PARA — quem está na tela precisa saber qual
    // movimento foi recusado, não só que "deu erro".
    if (typeof error?.message === 'string' && error.message.startsWith('TRANSICAO_DEMANDA_INVALIDA:')) {
      const [, de, para] = error.message.split(':');
      return res.status(400).json({ error: `Transição inválida da demanda: ${de} → ${para}.` });
    }
    if (typeof error?.message === 'string' && error.message.startsWith('DEMANDA_STATUS_DESCONHECIDO:')) {
      const atual = error.message.slice('DEMANDA_STATUS_DESCONHECIDO:'.length);
      return res.status(400).json({ error: `Demanda em status fora do vocabulário ("${atual}") — nenhuma transição é possível. Cancele a demanda ou corrija o dado.` });
    }
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

      // Concluída MOVEU ESTOQUE (receive, e reserve quando a solicitação estava viva — ver
      // updateDemandStatus). Cancelar aqui só trocaria o rótulo e deixaria o saldo creditado sem
      // contrapartida.
      // ⚠ ATUALIZADO NO LOTE I-b: este comentário mandava reverter pelo
      // DELETE /producao-3d/productions/:id. Aquela porta agora RECUSA (400) produção de demanda
      // concluída, justamente porque o crédito passou a ser da conclusão e o histórico dela é
      // imutável. Ou seja: HOJE NÃO EXISTE porta de reversão de demanda concluída, e é melhor
      // dizer isso do que apontar para uma que responde 400. Criar essa porta é decisão de
      // produto (o que fazer com a peça já impressa e já no físico), não detalhe de implementação.
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
    if (error.message === 'DEMANDA_CONCLUIDA') return res.status(400).json({ error: 'Demanda concluída não pode ser cancelada — a peça já entrou no estoque.' });
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

// ── PONTO ÚNICO DE CRÉDITO (lote I-b, item 2) ────────────────────────────────────────────────
// A DUPLA CONTAGEM: registrar produção de uma demanda dava `receive`, e concluir aquela mesma
// demanda dava OUTRO `receive`. O fluxo normal do Kanban é exatamente esse — o operador registra o
// que imprimiu e depois arrasta o card para "Concluída" — então a peça entrava DUAS VEZES no
// físico. Não era corrida nem caso de borda: era o caminho feliz.
//
// A REGRA, agora com um dono só: quem credita é a CONCLUSÃO DA DEMANDA.
//   - produção COM demand_id  -> só histórico, ZERO movimento de estoque;
//   - produção SEM demand_id  -> produção livre, receive normal (não há conclusão que a credite).
// O critério é "existe uma conclusão que vai creditar esta peça?", e é por isso que o vínculo
// (demand_id) é o discriminador certo, e não o tipo da peça ou quem registrou.
export const createProduction = async (req: Request, res: Response) => {
  let produtoTocadoCreate: string | null = null;   // emitido só após o commit
  const { partId, demandId, quantity, totalMinutes, filamentGrams, date } = req.body;
  const operatorId = (req as any).user?.id || null;
  const qty = Number(quantity);
  // Vínculo normalizado UMA vez: o resto da função pergunta a ele, não ao body.
  const demandaVinculada: string | null = demandId || null;

  // X-Idempotency-Key (opcional): string não-vazia → âncora ESTÁVEL (idempotência cross-request).
  // array (header repetido) / ausente / vazio → tratado como ausente.
  const idemRaw = req.headers['x-idempotency-key'];
  const idemKey = typeof idemRaw === 'string' && idemRaw.trim() ? idemRaw.trim() : null;
  // op_key content-addressed. Com header, é conhecido ANTES do INSERT (permite o pré-check no razão).
  //
  // ⚠ SÓ NO CAMINHO LIVRE. A idempotência cross-request desta rota é ancorada no RAZÃO (o
  // stock_ledger é quem lembra que a op_key já passou). Produção vinculada a demanda não escreve
  // no razão a partir deste lote, logo não tem onde ancorar: repetir o POST com o mesmo header
  // grava DUAS linhas de histórico. Consequência aceita e declarada, não esquecida — o que se
  // duplica é registro de histórico, não saldo, e o saldo era o que a duplicidade custava caro.
  // Fechar isso exigiria unique key própria em productions_3d, que é schema — fora deste lote.
  const idemOpKey = idemKey && !demandaVinculada ? `production:idem:${idemKey}:product:${partId}:receive:${qty}` : null;

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
        [partId, demandaVinculada, qty, operatorId, totalMinutes, filamentGrams, date],
      );
      const prod = prodRes.rows[0];

      const reason = demandaVinculada ? 'Produção 3D (Demanda Kanban)' : 'Produção 3D (Estoque Livre)';

      if (demandaVinculada) {
        // VINCULADA A DEMANDA -> ZERO movimento de estoque. Só o registro de histórico acima.
        // O crédito desta peça é da conclusão da demanda (updateDemandStatus), e é lá que ele
        // acontece UMA vez. Registrar aqui de novo era a dupla contagem.
        // `produtoTocadoCreate` fica null de propósito: sem movimento de saldo, não há
        // `stock_updated` a emitir — avisar as telas de um saldo que não mudou é ruído que
        // treina a ignorar o evento.
        await client.query(
          `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
          [operatorId, 'REGISTRO_PRODUCAO_3D', JSON.stringify({
            product_id: partId, quantity: qty, demand_id: demandaVinculada, reason,
            nota: 'apenas histórico — o crédito no estoque é da conclusão da demanda',
          })],
        );
        return prod;
      }

      // PRODUÇÃO LIVRE — daqui para baixo é o caminho de sempre, INALTERADO.
      // Sem header: fallback content-addressed pelo id FRESCO — NÃO dá idempotência cross-request
      // (cada POST = id novo = op_key nova = novo crédito). Documentado; use o header para blindar retry.
      const opKey = idemOpKey ?? `production:${prod.id}:receive:${qty}`;

      // Só receive, SEM reserve (a reserva p/ request vive no updateDemandStatus).
      await StockService.receive(client, partId, warehouseId, POOLED_OP_ID, qty, {
        refType: 'production_3d', refId: prod.id, userId: operatorId, opKey, reason,
      });
      produtoTocadoCreate = partId;   // p/ o stock_updated pós-commit

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

    // Peça impressa ENTRA no físico e a Vitrine 3D nunca era avisada.
    emitStockChanged([produtoTocadoCreate], (req as any).io);

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
  let produtoTocadoDelete: string | null = null;   // emitido só após o commit
  const { id } = req.params;
  const operatorId = (req as any).user?.id || null;

  try {
    await withTransaction(async (client) => {
      const warehouseId = await resolveWarehouseId(client, operatorId);

      // FOR UPDATE: trava a linha da produção -> 2 deletes paralelos serializam (o 2º acha a linha já
      // apagada -> 404). Antes era SELECT sem trava: dois deletes subtraíam 2×.
      const prodRes = await client.query('SELECT product_id, quantity, demand_id FROM productions_3d WHERE id = $1 FOR UPDATE', [id]);
      if (prodRes.rows.length === 0) throw new Error('PRODUCAO_NAO_ENCONTRADA');
      const productId = prodRes.rows[0].product_id;
      const qty = Number(prodRes.rows[0].quantity);
      const demandaVinculada: string | null = prodRes.rows[0].demand_id ?? null;

      // A REVERSÃO SEGUE O CRÉDITO (item 2). Como quem credita passou a ser a conclusão da demanda,
      // apagar uma produção VINCULADA não pode mais reverter estoque — ela nunca creditou nada.
      // Reverter aqui subtrairia uma entrada que esta linha não fez, que é a dupla contagem de
      // volta, só que com o sinal trocado.
      let statusDemanda: string | null = null;
      if (demandaVinculada) {
        // FOR UPDATE: serializa contra uma conclusão em voo — sem a trava, este delete poderia ler
        // "Em desenvolvimento", decidir que é seguro, e comitar enquanto a conclusão credita.
        // Ordem produção -> demanda; a conclusão trava solicitação -> demanda e não toca produções,
        // então não há ciclo entre os dois caminhos.
        const dem = await client.query('SELECT status FROM demands_3d WHERE id = $1 FOR UPDATE', [demandaVinculada]);
        statusDemanda = dem.rows[0]?.status ?? null;
      }

      if (demandaVinculada && statusDemanda === 'Concluída') {
        // O crédito pertence à CONCLUSÃO, e o histórico do que foi impresso é imutável depois dela.
        // Deixar apagar aqui abriria duas mentiras: o estoque creditado ficaria sem o registro que
        // o explica, e quem quisesse desfazer o crédito acharia que desfez — sem ter desfeito.
        // A porta de reversão de uma demanda concluída não é esta; é decisão de produto que não
        // existe hoje, e inventá-la aqui seria pior do que recusar.
        throw new Error('PRODUCAO_DE_DEMANDA_CONCLUIDA');
      }

      if (demandaVinculada) {
        // Demanda NÃO concluída: esta produção nunca creditou (item 2) -> delete livre, sem
        // reverseReceive. Nada a devolver ao físico porque nada entrou por aqui.
      } else if (productId && qty > 0) {
        // PRODUÇÃO LIVRE — caminho INALTERADO.
        // Reverte a ENTRADA pelo MOTOR: reduz só on_hand, guard on_hand-qty >= reserved. Se o saldo já
        // foi consumido/reservado, reverseReceive lança SALDO_INSUFICIENTE_REVERSAO -> tx faz ROLLBACK ->
        // a produção NÃO é apagada (fim do GREATEST(...,0) que pisava em 0 silenciosamente). op_key
        // content-addressed no id estável -> idempotente mesmo numa corrida.
        produtoTocadoDelete = productId;
        await StockService.reverseReceive(client, productId, warehouseId, POOLED_OP_ID, qty, {
          refType: 'production_3d', refId: id, userId: operatorId,
          opKey: `production:${id}:reverse:${qty}`,
          reason: 'Correção: apagou registro de Produção 3D (reverte entrada)',
        });
      }

      await client.query('DELETE FROM productions_3d WHERE id = $1', [id]);
      // A AÇÃO AUDITADA SEGUE O QUE DE FATO ACONTECEU. Só o caminho livre move saldo, então só ele
      // grava 'SAIDA_ESTOQUE_3D'. Gravar saída de estoque no delete de uma produção vinculada
      // (que não reverteu nada) poluiria a auditoria com movimento que não existiu — e a auditoria
      // vale justamente por não ter linha que não corresponde a fato.
      await client.query(
        `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
        demandaVinculada
          ? [operatorId, 'REMOVER_REGISTRO_PRODUCAO_3D', JSON.stringify({
              product_id: productId, quantity: qty, demand_id: demandaVinculada,
              demand_status: statusDemanda,
              reason: 'Correção: apagou registro de produção vinculada (não creditava estoque — sem reversão)',
            })]
          : [operatorId, 'SAIDA_ESTOQUE_3D', JSON.stringify({ product_id: productId, quantity: qty, reason: 'Correção: Apagou registo de Produção 3D' })],
      );
    });

    // Reverter a entrada REDUZ on_hand — movimento de saldo tão real quanto a entrada.
    emitStockChanged([produtoTocadoDelete], (req as any).io);

    return res.json({ success: true });
  } catch (error: any) {
    if (error instanceof StockError) return res.status(400).json({ error: error.message });
    if (error.message === 'PRODUCAO_NAO_ENCONTRADA') return res.status(404).json({ error: 'Produção não encontrada.' });
    if (error.message === 'PRODUCAO_DE_DEMANDA_CONCLUIDA') {
      return res.status(400).json({ error: 'Produção de demanda já concluída não pode ser apagada — a peça foi creditada no estoque pela conclusão da demanda, e este registro é o histórico dela.' });
    }
    if (error?.code === '23505' && error?.constraint === 'uq_stock_ledger_opkey') {
      console.warn(JSON.stringify({ event: 'production3d_delete_idempotent_conflict', id, detail: error?.detail ?? null }));
      return res.json({ success: true });
    }
    console.error(JSON.stringify({ event: 'production3d_delete_error', id, err_code: error?.code ?? null, err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao apagar produção 3D' });
  }
};
