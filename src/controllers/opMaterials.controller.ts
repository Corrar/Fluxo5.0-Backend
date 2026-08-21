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
// AW1 (20/08/2026): o SETOR é o DONO, a OP é a ETIQUETA. `lockKeyOpMat` é a definição ÚNICA da
// chave do advisory lock — ver o cabeçalho de opMaterialScope.ts para por que ela não é montada
// à mão em cada chamador.
import { lockKeyOpMat, escopoDoPerfil, warehouseDoSetor } from '../services/opMaterialScope';
import { StockService } from '../services/stock.service';
import { POOLED_OP_ID } from '../services/warehouse';

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

// TETO DE LINHAS DA FILA (lote RS1, decisão D3). Medido: a fila tinha 102 linhas e ganha ~568
// itens/mês com a origem-solicitação. O teto não é janela por DATA de propósito — ver o
// comentário dentro da query: pendência aberta entra sempre, sem idade.
const MAX_LINHAS_FILA = 500;

// Fórmula da projeção em UM lugar só. Todo saldo per-OP passa por aqui — se um event_type novo
// entrar no CHECK da 008, é ESTE trecho que decide o sinal dele (e só ele).
const SALDO_SQL = `
  COALESCE(SUM(qty) FILTER (WHERE event_type IN ('recebido','transferido_in')), 0)
  - COALESCE(SUM(qty) FILTER (WHERE event_type IN ('consumido','devolvido','transferido_out')), 0)
`;

// Saldo de UM produto numa OP, DENTRO DE UM ARMAZÉM DE SETOR (lote AW1).
//
// ⚠ O `warehouse_id` no WHERE não é refinamento — é o que faz o lock continuar valendo. A chave
// do advisory lock passou a ser (armazém, OP, produto); um guard que lesse o saldo GLOBAL sob um
// lock por armazém não estaria protegido por lock nenhum: dois setores tomariam chaves distintas
// e leriam a mesma projeção. Chave do lock e escopo do guard são o mesmo par.
//
// E é também o modelo: se a Elétrica e a Usinagem receberam o mesmo produto para a mesma OP,
// cada uma tem o SEU saldo. Medido em produção (20/08/2026): 19 de 701 pares (OP, produto) já
// foram entregues a mais de um setor.
//
// Só chame com o par (armazém, OP, produto) já travado — ver consumeOpMaterial.
async function saldoDe(
  client: PoolClient,
  warehouseId: string,
  clientServiceId: string,
  productId: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT ${SALDO_SQL} AS saldo FROM op_material_events
      WHERE warehouse_id = $1 AND client_service_id = $2 AND product_id = $3`,
    [warehouseId, clientServiceId, productId],
  );
  return num(rows[0]?.saldo);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// O ARMAZÉM DE QUEM OPERA — usado por consume e transfer (decisões A2/A3 do lote AW1).
//
// Por que a pergunta é "qual armazém você detém" e não "de qual armazém você quer tirar": o
// segundo seria parâmetro do corpo, e o corpo não escolhe de quem é o material — a mesma
// disciplina que o receive já aplica à OP ("a OP vem da ORIGEM, nunca do body").
//
// ⚠ CONSEQUÊNCIA DECLARADA: quem não tem armazém de setor NÃO APONTA E NÃO TRANSFERE, e isso
// inclui admin (`sector='Geral'`) e almoxarife (`sector='Almoxarifado'`) — os dois setores estão
// no de-para como "sem custódia". Não é restrição de permissão: é o recurso não existir. Quem
// não detém WIP não tem de onde tirar. Medido: 0 apontamentos e 0 transferências em toda a base
// até 20/08/2026, então nenhum fluxo vivo é interrompido por isto.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function armazemDeQuemOpera(client: PoolClient, userId: string | null): Promise<string> {
  const escopo = await escopoDoPerfil(client, userId);
  if (escopo.warehouseId === null) {
    throw new OpMatError(
      'OPERADOR_SEM_CUSTODIA',
      `Seu setor (${escopo.sectorCru ?? 'não informado'}) não tem armazém — não há material seu em custódia para apontar ou transferir.`,
    );
  }
  return escopo.warehouseId;
}

// ==========================================================================
// a) POST /op-materials/receive — o setor confirma o que recebeu da separação entregue.
// ==========================================================================
// ── AS DUAS ORIGENS DO RECEBIMENTO (lote RS1) ────────────────────────────────────────────────
// O handler nasceu só para separação. Agora aceita `requestId` no lugar de `separationId`, e a
// diferença entre os dois caminhos é ESTREITA de propósito: o que muda é DE ONDE saem a OP, o
// setor e a linha entregue. Teto, idempotência, guard de custódia e o INSERT no razão são os
// MESMOS — duplicá-los faria as duas origens divergirem no dia que uma regra mudasse.
export const receiveOpMaterial = async (req: Request, res: Response) => {
  const { separationId, requestId, items } = req.body ?? {};
  const userId = (req as any).user?.id ?? null;
  const idemKey = idemFrom(req);
  const origemSolicitacao = !separationId && !!requestId;

  try {
    if (separationId && requestId) {
      throw new OpMatError('ORIGEM_AMBIGUA', 'Informe a separação OU a solicitação de origem, nunca as duas.');
    }
    if (!separationId && !requestId) throw new OpMatError('SEPARACAO_OBRIGATORIA', 'Informe a separação ou a solicitação de origem.');
    if (!Array.isArray(items) || items.length === 0) throw new OpMatError('ITENS_OBRIGATORIOS', 'Informe ao menos um item recebido.');
    if (!idemKey) throw new OpMatError('IDEMPOTENCY_KEY_OBRIGATORIA', 'Header X-Idempotency-Key é obrigatório neste endpoint.');

    const result = await withTransaction(async (client) => {
      // 1. Trava a ORIGEM: serializa recebimentos concorrentes da MESMA origem, que é onde o
      //    teto por item pode ser furado por corrida. Mesma disciplina nas duas.
      let origemSetor: string | null;
      let clientServiceId: string | null;
      if (origemSolicitacao) {
        const rq = await client.query(
          `SELECT id, status, client_service_id, sector, delivered_at FROM requests WHERE id = $1 FOR UPDATE`,
          [requestId],
        );
        if (rq.rows.length === 0) throw new OpMatError('SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada.');
        if (rq.rows[0].status !== 'entregue') {
          throw new OpMatError('SOLICITACAO_NAO_ENTREGUE', `Só dá pra receber solicitação já entregue (esta está "${rq.rows[0].status}").`);
        }
        // O CARIMBO é o que faz a pendência existir. Sem ele a linha nem aparece na fila —
        // recusar aqui evita que um POST forjado confirme o que a fila não ofereceu.
        if (!rq.rows[0].delivered_at) {
          throw new OpMatError('SOLICITACAO_SEM_ENTREGA_REGISTRADA', 'Esta solicitação não tem entrega registrada — não há recebimento a confirmar.');
        }
        clientServiceId = rq.rows[0].client_service_id;
        origemSetor = rq.rows[0].sector;
        if (!clientServiceId) throw new OpMatError('SOLICITACAO_SEM_OP', 'Solicitação não tem OP vinculada — não alimenta o armazém da OP.');
      } else {
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
        // 2. A OP vem da ORIGEM, nunca do body — o body não escolhe pra qual OP o material vai.
        clientServiceId = sep.rows[0].client_service_id;
        origemSetor = sep.rows[0].destination;
        if (!clientServiceId) throw new OpMatError('SEPARACAO_SEM_OP', 'Separação não tem OP vinculada — não alimenta o armazém da OP.');
      }

      // 2b. GUARD DE CUSTÓDIA POR SETOR (decisões D1/D2/D3 do lote GUARD-RECEBIMENTO, 18/08/2026).
      //
      // D1 primeiro, e para TODO MUNDO (inclusive isMaster): se o destino da separação não tem
      // armazém no de-para (canonSetor(destination) -> null em SETOR_ARMAZEM), o material foi
      // consumido na entrega, não fica em custódia de setor nenhum — não há "o quê" receber aqui.
      // Nem o master recebe o que não tem custódia; isto não é permissão, é o recurso não existir.
      // GUARD DE CUSTÓDIA: UM só, para as DUAS origens. `origemSetor` é
      // separations.destination ou requests.sector — canonSetor normaliza os dois igual
      // (medido: 26 grafias de destination -> 17 canônicos; 17 de requests.sector -> 16,
      // incluindo as 210 com prefixo "Setor: " que o canon já remove).
      const destino = resolveDestinationWarehouse(origemSetor);
      if (destino.code === null) {
        throw new OpMatError('SETOR_SEM_CUSTODIA', 'Este setor não tem armazém — o material foi consumido na entrega, não há recebimento a confirmar aqui.');
      }
      // ── O CARIMBO DE SETOR (A5) ───────────────────────────────────────────────────────────
      // Vem da ORIGEM, NUNCA do req.user — a mesma disciplina do comentário lá em cima sobre a
      // OP ("a OP vem da ORIGEM, nunca do body"). É o que impede que um master confirmando um
      // recebimento em nome de outro setor carimbe o armazém DELE no material do setor alheio.
      // O guard D1 acima já resolveu o `code`; aqui só se pega o id (cacheado em warehouse.ts).
      const warehouseId = await warehouseDoSetor(client, origemSetor);
      if (warehouseId === null) {
        // Inalcançável pelo guard acima (code != null implica armazém), a não ser que o mapa
        // aponte para um armazém que não existe em `warehouses` — que é bug de configuração e
        // o resolveDestinationWarehouseId já logou. Falhar alto é melhor que carimbar NULL.
        throw new OpMatError('ARMAZEM_DO_SETOR_AUSENTE', `O armazém do setor "${origemSetor}" não existe no cadastro — avise o administrador.`);
      }
      // D2/D3: admin e almoxarife são chave-mestra (recebem de qualquer setor); operador comum só
      // confirma o que foi destinado ao PRÓPRIO setor — cross-setor é bloqueio (403), não aviso.
      const perfil = await client.query(`SELECT role, sector FROM profiles WHERE id = $1`, [userId]);
      const isMaster = perfil.rows[0]?.role === 'admin' || perfil.rows[0]?.role === 'almoxarife';
      if (!isMaster) {
        const operadorCanon = canonSetor(perfil.rows[0]?.sector ?? null);
        if (canonSetor(origemSetor) !== operadorCanon) {
          throw new OpMatError('SETOR_ALHEIO', 'Só o setor de destino pode confirmar este recebimento.');
        }
      }

      const criados: any[] = [];
      const replays: string[] = [];

      for (const it of items) {
        const qty = num(it?.qty);
        if (!(qty > 0)) throw new OpMatError('QTD_INVALIDA', 'Quantidade recebida precisa ser maior que zero.');

        // 3. Resolve a linha entregue: por itemId (preciso) ou por productId (conveniência da
        //    tela). A quantidade "entregue" da solicitação usa COALESCE(quantity_delivered,
        //    quantity_requested) — a MESMA fórmula do ramo 'entregue' de requests.controller e
        //    da fila. Divergir aqui faria o teto não bater com o que saiu do almoxarifado.
        const li = origemSolicitacao
          ? (it?.itemId
              ? await client.query(`SELECT id, product_id, COALESCE(quantity_delivered, quantity_requested) AS quantity FROM request_items WHERE id = $1 AND request_id = $2`, [it.itemId, requestId])
              : await client.query(`SELECT id, product_id, COALESCE(quantity_delivered, quantity_requested) AS quantity FROM request_items WHERE request_id = $1 AND product_id = $2`, [requestId, it?.productId]))
          : (it?.itemId
              ? await client.query(`SELECT id, product_id, quantity FROM separation_items WHERE id = $1 AND separation_id = $2`, [it.itemId, separationId])
              : await client.query(`SELECT id, product_id, quantity FROM separation_items WHERE separation_id = $1 AND product_id = $2`, [separationId, it?.productId]));
        const ondeF = origemSolicitacao ? 'solicitação' : 'separação';
        if (li.rows.length === 0) throw new OpMatError('ITEM_NAO_ENCONTRADO', `Item não pertence a esta ${ondeF}.`);
        if (li.rows.length > 1) throw new OpMatError('ITEM_AMBIGUO', `Produto repetido nesta ${ondeF} — mande itemId em vez de productId.`);
        const itemId = li.rows[0].id;
        const productId = li.rows[0].product_id;
        const entregue = num(li.rows[0].quantity);

        // op_key com o PREFIXO DA ORIGEM: `:sep:` e `:req:` nunca colidem, então a mesma
        // X-Idempotency-Key reusada em origens diferentes não se auto-deduplica.
        const opKey = origemSolicitacao
          ? `opmat:recv:${idemKey}:req:${requestId}:item:${itemId}`
          : `opmat:recv:${idemKey}:sep:${separationId}:item:${itemId}`;

        // 4. PRÉ-CHECK no razão próprio, ANTES do teto: se esta op_key já existe, é replay do mesmo
        //    POST. Tem que sair fora sem contar contra o teto — senão o retry se auto-rejeita
        //    ("já recebeu 5 de 5") e o cliente que só perdeu a resposta toma 400 pra sempre.
        const ja = await client.query(`SELECT id FROM op_material_events WHERE op_key = $1`, [opKey]);
        if (ja.rows.length > 0) { replays.push(itemId); continue; }

        // 5. TETO: recebimento PARCIAL é ok; ultrapassar o entregue não.
        const colunaOrigemItem = origemSolicitacao ? 'ref_request_item_id' : 'ref_separation_item_id';
        const rec = await client.query(
          `SELECT COALESCE(SUM(qty), 0) AS total FROM op_material_events
            WHERE ${colunaOrigemItem} = $1 AND event_type = 'recebido'`,
          [itemId],
        );
        const jaRecebido = num(rec.rows[0].total);
        const teto = entregue - jaRecebido;
        if (qty > teto) {
          throw new OpMatError('RECEBIMENTO_ACIMA_DO_ENTREGUE',
            `Recebimento acima do entregue: a separação entregou ${entregue} e já recebeu ${jaRecebido} (resta ${teto}).`);
        }

        // As QUATRO colunas de origem vão no INSERT, com exatamente um par preenchido — é o
        // que o ck_opmat_recebido_tem_origem da 026 exige. O outro par vai NULL explícito: se
        // um dia este código mandar os dois, o banco recusa em vez de gravar ambiguidade.
        const ins = await client.query(
          `INSERT INTO op_material_events
             (event_type, client_service_id, product_id, qty,
              ref_separation_id, ref_separation_item_id, ref_request_id, ref_request_item_id,
              user_id, op_key, warehouse_id)
           VALUES ('recebido', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, event_type, client_service_id, product_id, qty, warehouse_id, created_at`,
          [clientServiceId, productId, qty,
           origemSolicitacao ? null : separationId, origemSolicitacao ? null : itemId,
           origemSolicitacao ? requestId : null, origemSolicitacao ? itemId : null,
           userId, opKey, warehouseId],
        );
        criados.push(ins.rows[0]);

        // ═══════════════════════════════════════════════════════════════════════════════════
        // O CRÉDITO NO ARMAZÉM DO SETOR — lote FS1 (21/08/2026). A torneira fecha aqui.
        // ═══════════════════════════════════════════════════════════════════════════════════
        //
        // ─── O QUE ESTAVA ABERTO ──────────────────────────────────────────────────────────
        // Este handler fazia o INSERT acima e MAIS NADA: `grep stock` no corpo inteiro devolvia
        // ZERO. Para a origem SOLICITAÇÃO isso está certo — a ENTREGA já chamou
        // `StockService.transfer(ALMOX -> setor, fromReserved:true)` (requests.controller) e o
        // material está na prateleira antes de o setor confirmar. Para a origem SEPARAÇÃO não
        // havia perna nenhuma: `manualWithdrawal` debita o ALMOX (reverseReceive) e ninguém
        // credita o setor. Cada confirmação criava divergência — medido: 2 un em 18/08, 3 em
        // 19/08, 4 em 20/08 e mais 1 em 21/08, DURANTE a própria medição.
        //
        // ─── POR QUE `receive`, E NÃO `transfer` ──────────────────────────────────────────
        // `transfer` DEBITA a origem, e a origem JÁ FOI DEBITADA — usá-lo tiraria do ALMOX uma
        // segunda vez. `consume` também não: ele reduz. O que falta é só a ENTRADA no destino.
        // ⚠ E `receive` é o único que serve por um motivo estrutural, não por gosto: ele usa
        //   `ensureAndLock` e CRIA A LINHA de stock quando ela não existe. Medido: 3 dos 6
        //   destinos NÃO TÊM linha (ESTEIRA/9.99.1150, LAVADORA/2.02.0034, PROTOTIPO/2.07.0028).
        //   `transfer` e `consume` usam `lockExisting` e quebrariam nesses três.
        // `receive` também não toca `quantity_reserved` — que é o certo: este material nunca
        // esteve reservado no armazém do setor.
        //
        // INVARIANTE: Σ delta_on_hand do ALMOX = 0 neste fluxo. Sai de graça, e não por
        // disciplina — a chamada abaixo não referencia o ALMOX em lugar nenhum.
        //
        // POOLED_OP_ID: a OP mora no RAZÃO (client_service_id do evento acima), não na linha de
        // stock. Medido: as 79 linhas de stock em armazém de setor têm `op_id` NULL, e o
        // `transfer` da entrega de solicitação usa POOLED nos dois lados. Divergir aqui criaria
        // uma segunda convenção para a mesma prateleira.
        //
        // ─── ⚠ A POSIÇÃO DESTA CHAMADA É A REGRA, NÃO DETALHE ─────────────────────────────
        // Ela está DEPOIS do `continue` do replay (linha ~264) e DEPOIS do INSERT, no MESMO
        // corpo de iteração. Se ela subisse para antes do `continue`, um replay do mesmo POST
        // PULARIA o razão e CREDITARIA o stock — furo NOVO, e pior que o que este lote fecha,
        // porque criaria estoque sem evento. O smoke tem controle negativo para isso: ele
        // move a chamada para fora do ramo e PROVA que o replay credita.
        //
        // ─── ⚠ SÓ A ORIGEM SEPARAÇÃO ─────────────────────────────────────────────────────
        // A solicitação JÁ tem lastro (medido: 43 de 43 pares com estoque suficiente, zero sem
        // linha). Creditar as duas duplicaria 3.976 un contra 10 legítimas — 398:1. As duas
        // origens são mutuamente exclusivas por CHECK do banco (ck_opmat_recebido_tem_origem,
        // da 026), então `origemSolicitacao` é decisão total, não heurística.
        if (!origemSolicitacao) {
          // op_key DERIVADA da mesma âncora de ITEM do evento (régua S2/AW0: âncora no item,
          // nunca no par), com sufixo próprio para não colidir com a chave do razão — as duas
          // vivem em tabelas diferentes, mas usar a mesma string faria o `alreadyApplied` do
          // motor e o pré-check do razão significarem a mesma coisa por acidente.
          await StockService.receive(client, productId, warehouseId, POOLED_OP_ID, qty, {
            refType: 'separation', refId: separationId, userId,
            opKey: `${opKey}:stock`,
            reason: 'Recebimento de saída manual no armazém do setor',
          });
        }
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
      //    ⚠⚠ AW1: a string ganhou o ARMAZÉM e passou a sair de `lockKeyOpMat` — definição única,
      //    quatro chamadores (aqui, o transfer abaixo, e o register/confer do returns.service).
      //    Ver o cabeçalho de opMaterialScope.ts: enquanto a string era montada à mão, "a mesma
      //    string" era promessa de revisão; agora é construção.
      //
      // 3b. QUAL ARMAZÉM (A2/A3): o de quem opera. O apontador consome o WIP do PRÓPRIO setor —
      //     quem não tem armazém não tem o que apontar (erro tipado, ver armazemDeQuemOpera).
      const warehouseId = await armazemDeQuemOpera(client, userId);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKeyOpMat(warehouseId, clientServiceId, productId)]);

      // 4. Guard de saldo: projeção calculada NA MESMA TX, DEPOIS do lock. A ordem é o contrato —
      //    ler antes do lock não vale nada. E o saldo é o DO ARMAZÉM (mesmo grão do lock).
      const saldo = await saldoDe(client, warehouseId, clientServiceId, productId);
      if (quantidade > saldo) {
        throw new OpMatError('SALDO_INSUFICIENTE_NA_OP',
          `Saldo insuficiente na OP: o armazém do seu setor tem ${saldo} deste material nesta OP e tentou apontar ${quantidade}.`);
      }

      const ins = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key, machine_id, warehouse_id)
         VALUES ('consumido', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, event_type, client_service_id, product_id, qty, machine_id, warehouse_id, created_at`,
        [clientServiceId, productId, quantidade, userId, opKey, maquinaId, warehouseId],
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

      // ── 3. O SETOR DAS DUAS PERNAS (decisão A2 do lote AW1) ───────────────────────────────
      //
      // ⚠ AS DUAS PERNAS CARIMBAM O MESMO ARMAZÉM. Não é simplificação — "cada perna o seu" NÃO
      // É CONSTRUÍVEL: o eixo desta operação é OP -> OP, e o destino é uma OP, não um setor. Não
      // existe, em lugar nenhum do corpo ou do banco, um "setor de destino" a carimbar no IN.
      //
      // E se existisse não deveria ser usado: a transferência é CONTÁBIL (o comentário do topo
      // deste handler crava — "NÃO toca o físico central... aqui ele só muda de OP"), e o
      // stock_ledger confirma que ela não gera lançamento nenhum. Carimbar armazéns diferentes
      // faria o material TELETRANSPORTAR entre setores sem movimento físico, deixando um setor
      // com saldo negativo e outro com saldo positivo do nada.
      //
      // O armazém é o de QUEM DETÉM, e o guard de saldo abaixo é o que torna isso verdade e não
      // declaração: só se transfere o que o armazém do próprio setor tem. Se o seu setor não
      // detém aquele material naquela OP, o saldo é 0 e a operação morre no guard.
      const warehouseId = await armazemDeQuemOpera(client, userId);

      // 3b. ADVISORY LOCK da ORIGEM — a MESMA string do consume, pela MESMA função (invariante
      //     D4: consume, devolver e transferir_out disputam o MESMO saldo e TÊM que se excluir
      //     mutuamente). O destino não trava: só recebe crédito, não há guard de saldo lá.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKeyOpMat(warehouseId, fromClientServiceId, productId)]);

      // 4. Guard de saldo na origem, DEPOIS do lock (a ordem é o contrato) e DENTRO do armazém.
      const saldo = await saldoDe(client, warehouseId, fromClientServiceId, productId);
      if (quantidade > saldo) {
        throw new OpMatError('SALDO_INSUFICIENTE_NA_OP',
          `Saldo insuficiente na OP de origem: o armazém do seu setor tem ${saldo} deste material nesta OP e tentou transferir ${quantidade}.`);
      }

      // 5. O par. IN aponta pro OUT via ref_event_id. MESMO warehouse_id nos dois (A2).
      const out = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, user_id, op_key, warehouse_id)
         VALUES ('transferido_out', $1, $2, $3, $4, $5, $6)
         RETURNING id, event_type, client_service_id, product_id, qty, warehouse_id, created_at`,
        [fromClientServiceId, productId, quantidade, userId, outKey, warehouseId],
      );
      const inn = await client.query(
        `INSERT INTO op_material_events (event_type, client_service_id, product_id, qty, ref_event_id, user_id, op_key, warehouse_id)
         VALUES ('transferido_in', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, event_type, client_service_id, product_id, qty, ref_event_id, warehouse_id, created_at`,
        [toClientServiceId, productId, quantidade, out.rows[0].id, userId, inKey, warehouseId],
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
      `WITH pendencias AS (
         -- ══ ORIGEM 1: SEPARAÇÃO (o caminho de sempre, INTOCADO na sua lógica) ══════════════
         SELECT 'separacao'::text        AS origem,
                s.id                     AS separation_id,
                si.id                    AS item_id,
                NULL::uuid               AS request_id,
                NULL::uuid               AS request_item_id,
                s.destination            AS sector,
                s.status                 AS status,
                COALESCE(s.sent_at, s.created_at) AS sent_at,
                cs.id                    AS client_service_id,
                cs.op_code               AS op_code,
                si.product_id            AS product_id,
                si.quantity              AS entregue,
                COALESCE(r.total, 0)     AS recebido
           FROM separations s
           JOIN separation_items si ON si.separation_id = s.id
           JOIN client_services cs  ON cs.id = s.client_service_id
           LEFT JOIN LATERAL (
                SELECT SUM(e.qty) AS total FROM op_material_events e
                 WHERE e.ref_separation_item_id = si.id AND e.event_type = 'recebido'
           ) r ON TRUE
          WHERE s.status = ANY($1)
            AND s.client_service_id IS NOT NULL
            AND COALESCE(s.sent_at, s.created_at) >= $2::timestamp
            AND si.quantity > COALESCE(r.total, 0)

         UNION ALL

         -- ══ ORIGEM 2: SOLICITAÇÃO (lote RS1) ══════════════════════════════════════════════
         -- Mesma forma, mesma aritmética: entregue − Σ recebido. A pendência é DERIVADA; não
         -- há linha de "pendente" em lugar nenhum (ver 026 e o ramo 'entregue').
         --
         -- 'delivered_at IS NOT NULL' é o GATILHO: sem carimbo, a solicitação não entra. É o que
         -- mantém as 2.496 entregas históricas fora da fila sem precisar de cláusula de idade —
         -- elas simplesmente não têm o carimbo, porque ninguém o registrou na época.
         --
         -- 'quantity_delivered' com fallback em 'quantity_requested': é a MESMA fórmula que a
         -- entrega usa para decidir quanto sai do almoxarifado (requests.controller.ts, ramo
         -- 'entregue'). Divergir aqui faria o teto do recebimento não bater com o que saiu.
         SELECT 'solicitacao'::text      AS origem,
                NULL::uuid               AS separation_id,
                NULL::uuid               AS item_id,
                rq.id                    AS request_id,
                ri.id                    AS request_item_id,
                rq.sector                AS sector,
                rq.status                AS status,
                rq.delivered_at          AS sent_at,
                cs.id                    AS client_service_id,
                cs.op_code               AS op_code,
                ri.product_id            AS product_id,
                COALESCE(ri.quantity_delivered, ri.quantity_requested) AS entregue,
                COALESCE(r2.total, 0)    AS recebido
           FROM requests rq
           JOIN request_items ri    ON ri.request_id = rq.id
           JOIN client_services cs  ON cs.id = rq.client_service_id
           LEFT JOIN LATERAL (
                SELECT SUM(e.qty) AS total FROM op_material_events e
                 WHERE e.ref_request_item_id = ri.id AND e.event_type = 'recebido'
           ) r2 ON TRUE
          WHERE rq.status = 'entregue'
            AND rq.delivered_at IS NOT NULL
            AND rq.client_service_id IS NOT NULL
            AND ri.product_id IS NOT NULL
            -- ⚠ SEM CUTOFF DE DATA AQUI, e de propósito. Do lado da SEPARAÇÃO o cutoff de
            -- go-live existe para manter fora o histórico pré-virada, que nunca foi confirmado.
            -- Do lado da SOLICITAÇÃO esse histórico NÃO EXISTE: a 026 não faz backfill, então
            -- só entra o que foi entregue DEPOIS do lote. A ausência do carimbo já é o filtro,
            -- e é o mais honesto (o que não foi medido fica NULL).
            -- Repetir o cutoff aqui seria um SEGUNDO filtro redundante capaz de produzir
            -- exatamente o que a regra dura do lote proíbe: pendência aberta sumindo por idade.
            -- Medido: com delivered_at de 730 dias, a versão com cutoff devolvia 0 linhas.
            AND COALESCE(ri.quantity_delivered, ri.quantity_requested) > COALESCE(r2.total, 0)
       )
       SELECT pe.*, p.sku, p.name, p.unit,
              pe.entregue - pe.recebido AS pendente
         FROM pendencias pe
         JOIN products p ON p.id = pe.product_id
        -- == CONTENÇÃO (D3) ==================================================================
        -- A fila multiplica por ~6 com a origem-solicitação (~568 itens/mês medidos). O
        -- /separations provou o custo de subir sem janela: 716 KB antes de alguém notar.
        --
        -- ⚠ REGRA DURA: PENDÊNCIA ABERTA ENTRA SEMPRE, SEM IDADE. Toda linha aqui é, por
        -- construção, pendência aberta (as cláusulas 'entregue > recebido' já eliminam o que
        -- foi confirmado). Por isso a contenção NÃO pode ser janela por data — seria excluir
        -- material a confirmar por ter envelhecido, e ninguém pode perder material assim.
        --
        -- A contenção é TETO DE LINHAS com aviso, não janela: ordena pela mais ANTIGA primeiro
        -- (a que espera há mais tempo é a mais urgente) e corta no fim. Quem for cortado é o
        -- material recém-entregue, que ainda vai aparecer amanhã — nunca o antigo.
        ORDER BY pe.sent_at ASC NULLS FIRST, p.name ASC
        LIMIT $3`,
      [STATUS_ENTREGUES, CUTOFF_DATE, MAX_LINHAS_FILA],
    );
    const visiveis = rows.filter((r) => {
      // D1 vale para TODO MUNDO, inclusive o "ver tudo" do master: setor sem armazém não é
      // recebível por ninguém — não existe custódia pra confirmar.
      if (resolveDestinationWarehouse(r.sector).code === null) return false;
      if (verTudo) return true;
      return canonSetor(r.sector) === operadorCanon;
    });
    // CONTRATO: as chaves de antes seguem TODAS presentes, com o mesmo significado. O que entra
    // é ADITIVO — `origem`, `request_id`, `request_item_id`. Uma linha de separação continua
    // trazendo separation_id/item_id preenchidos e os de request nulos, e vice-versa: a tela
    // antiga, que só lê as chaves de separação, não quebraria (embora a nova as use).
    return res.json(visiveis.map((r) => ({
      origem: r.origem,
      separation_id: r.separation_id, sector: r.sector, status: r.status, sent_at: r.sent_at,
      client_service_id: r.client_service_id, op_code: r.op_code,
      item_id: r.item_id, product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
      request_id: r.request_id, request_item_id: r.request_item_id,
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

// ⚠ O ESCOPO DE SETOR ENTROU AQUI TAMBÉM (lote AW1), e não por simetria: sem ele a tela MENTE, e
// a mentira já era reproduzível com o dado de hoje. Este extrato é aberto de dentro do card do
// Armazém ("Ver extrato"). Medido em produção (20/08/2026): a OP DESP0826 tem DOIS eventos, um
// da ESTEIRA (chapéu de palha) e um do PROTOTIPO (papel higiênico). Um operador do Protótipo
// veria o card com UM material e, ao abrir o extrato, DOIS — incluindo material da Esteira.
// Card filtrado com extrato completo embaixo é a tela se contradizendo na mesma tela.
// Mesma forma dos demais: escopo pelo TOKEN, `?scope=all` só para master, fail-closed.
export const getOpEvents = async (req: Request, res: Response) => {
  const { clientServiceId } = req.params;
  const userId = (req as any).user?.id ?? null;
  const scopeAll = typeof req.query.scope === 'string' && req.query.scope.trim().toLowerCase() === 'all';
  const raw = typeof req.query.event_type === 'string' ? req.query.event_type.trim() : '';
  // Tipo inválido -> 400 em vez de devolver lista vazia (vazio mentiria "a OP não tem nada").
  if (raw && !EVENT_TYPES.includes(raw)) {
    return res.status(400).json({ error: `event_type inválido. Use um de: ${EVENT_TYPES.join(', ')}.` });
  }
  const tipo = raw || null;
  try {
    const escopo = await escopoDoPerfil(pool as any, userId);
    const verTudo = escopo.isMaster && scopeAll;   // fail-closed, igual aos demais
    // Mesmos TRÊS estados do /warehouse (ver o comentário lá): sem custódia e sem escopo global
    // devolve VAZIO, nunca "filtro nulo" — que na cláusula `($3 IS NULL OR ...)` liberaria tudo.
    const semCustodia = !verTudo && escopo.warehouseId === null;
    const filtroWh = verTudo ? null : escopo.warehouseId;
    if (semCustodia) return res.json([]);
    const { rows } = await pool.query(
      `SELECT e.id, e.event_type, e.qty, e.created_at,
              e.product_id, p.sku, p.name, p.unit,
              e.ref_separation_id, e.ref_separation_item_id, e.ref_event_id,
              e.user_id, pr.name AS user_name,
              e.warehouse_id, w.code AS warehouse_code
         FROM op_material_events e
         JOIN products p        ON p.id = e.product_id
         LEFT JOIN profiles pr  ON pr.id = e.user_id
         LEFT JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.client_service_id = $1
          AND ($2::text IS NULL OR e.event_type = $2)
          AND ($3::uuid IS NULL OR e.warehouse_id = $3)
        ORDER BY e.created_at DESC
        LIMIT 50`,
      [clientServiceId, tipo, filtroWh],
    );
    return res.json(rows.map((r) => ({
      id: r.id, event_type: r.event_type, qty: num(r.qty), created_at: r.created_at,
      product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
      ref_separation_id: r.ref_separation_id, ref_separation_item_id: r.ref_separation_item_id,
      ref_event_id: r.ref_event_id, user_id: r.user_id, user_name: r.user_name,
      // ADITIVO: as chaves de antes seguem todas. Estas contam de quem é a linha.
      warehouse_id: r.warehouse_id, warehouse_code: r.warehouse_code,
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
// ─────────────────────────────────────────────────────────────────────────────────────────────
// O FILTRO DE SETOR (lote AW1) — O SETOR É O DONO, A OP É A ETIQUETA.
//
// A tela mostrava TUDO: o operador da Esteira via Despesas, Protótipo e Floterio juntos. Agora
// ela mostra o material que O SETOR DELE recebeu, com a OP como etiqueta de cada item.
//
// A FORMA É A MESMA DO RECEBIMENTO (getPendingReceipts, mais acima), e de propósito: o backend
// resolve pelo TOKEN, não por parâmetro. `?scope=all` só tem efeito para admin/almoxarife —
// fail-closed do lado de cá, o front não decide. E o filtro roda em JS, não em SQL, pela mesma
// razão de lá: comparar armazém é comparar uuid, e a lista inteira já veio numa resposta só.
//
// ⚠ O QUE **NÃO** SE COPIOU DO RECEBIMENTO, E É DECISÃO: lá existe o D1, que descarta linha cujo
// setor não tem armazém. AQUI ELE NÃO ENTRA. Um evento de setor sem custódia NÃO NASCE — o
// próprio D1 do POST /receive o barra com SETOR_SEM_CUSTODIA, e a 027 acabou de provar que os 4
// eventos da base têm armazém. Um filtro que nunca exclui nada não é proteção: é dano à espera
// de gatilho, porque no dia em que a premissa mudar ele passa a esconder linha sem avisar.
//
// ⚠ EVENTO SEM CARIMBO (warehouse_id NULL) NÃO SOME EM SILÊNCIO. A coluna é nullable por decisão
// (ver a 027), então a resposta declara `sem_setor` — quantas linhas ficaram de fora por não
// terem armazém. Zero hoje; se um dia não for, a tela tem como dizer em vez de omitir.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const MAX_OPS_ARMAZEM = 200;

export const getWarehouseByOp = async (req: Request, res: Response) => {
  const bruto = Number(req.query.limit);
  const limite = Number.isFinite(bruto) && bruto > 0 ? Math.min(Math.trunc(bruto), MAX_OPS_ARMAZEM) : MAX_OPS_ARMAZEM;
  const userId = (req as any).user?.id ?? null;
  const scopeAll = typeof req.query.scope === 'string' && req.query.scope.trim().toLowerCase() === 'all';
  try {
    const escopo = await escopoDoPerfil(pool as any, userId);
    const verTudo = escopo.isMaster && scopeAll;   // fail-closed: scope=all sem o papel é ignorado
    // ⚠ ONDE ESTE FILTRO RODA — E POR QUE **NÃO** É EM JS COMO O DO RECEBIMENTO.
    // Lá o filtro é em JS por um motivo declarado: comparar SETOR é comparar TEXTO SUJO, e
    // enumerar em SQL todas as grafias que canonizam para um setor prenderia a query a uma lista
    // que envelhece. Aqui a comparação é de `warehouse_id` — uuid contra uuid. É exatamente o que
    // a decisão A1 comprou ao carimbar a FK em vez do canônico, e desperdiçá-la teria custo:
    // filtrar depois do LIMIT faria `total_ops` contar OPs que o operador não pode ver, e a
    // tarja "mostrando N de M" mentiria. O `canonSetor` continua no caminho — dentro do
    // escopoDoPerfil, que é quem traduz profiles.sector -> code -> uuid.
    //
    // ⚠ TRÊS ESTADOS, NÃO DOIS — e o terceiro é onde mora o fail-open.
    //   verTudo                         -> sem filtro (o master pediu E tem o papel)
    //   tem armazém                     -> filtra por ele
    //   NÃO tem armazém e não é verTudo -> NÃO VÊ NADA
    //
    // O último caso não pode virar "filtro nulo": a cláusula do SQL é
    // `($2::uuid IS NULL OR e.warehouse_id = $2)`, então passar NULL ali LIBERA TUDO. Um admin de
    // setor 'Geral' (sem armazém) sem `?scope=all` veria a fábrica inteira sem ter pedido — o
    // oposto exato do fail-closed que o resto deste módulo pratica. Quem não tem custódia e não
    // pediu escopo global vê VAZIO, que é o correto: ele não detém material nenhum.
    const semCustodia = !verTudo && escopo.warehouseId === null;
    const filtroWh = verTudo ? null : escopo.warehouseId;

    // Quantas OPs abertas TÊM material NO ESCOPO — a constante contra a qual o truncamento se
    // declara. Consulta separada e barata (só conta), para que `total_ops` não dependa da janela.
    const totalRes = await pool.query(
      `SELECT COUNT(DISTINCT e.client_service_id)::int AS n
         FROM op_material_events e
         JOIN client_services cs ON cs.id = e.client_service_id
        WHERE cs.status <> 'concluido'
          AND ($1::uuid IS NULL OR e.warehouse_id = $1)`,
      [filtroWh],
    );
    const totalOps = semCustodia ? 0 : (totalRes.rows[0]?.n ?? 0);

    // Linhas que ficariam de fora por NÃO TEREM CARIMBO. A coluna é nullable por decisão (027),
    // então a ausência é possível — e tem de ser DITA, nunca omitida. Vale para os dois escopos:
    // nem o master com scope=all vê o que não tem armazém, porque o filtro dele é "sem filtro"
    // mas a linha continua sem setor a que pertencer.
    const semSetorRes = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM op_material_events e
         JOIN client_services cs ON cs.id = e.client_service_id
        WHERE cs.status <> 'concluido' AND e.warehouse_id IS NULL`,
    );
    const semSetor = semSetorRes.rows[0]?.n ?? 0;

    // `status <> 'concluido'` e não `= 'em_andamento'`: OP_STATUS_VALIDOS tem os dois valores
    // hoje (clients.controller.ts:106), e se um terceiro estado nascer amanhã, "não concluída"
    // continua sendo a leitura certa de "ainda está com material na mão".
    // Sem custódia e sem escopo global: nem se consulta. Devolver a lista vazia AQUI é o que
    // impede o `$2 IS NULL` de virar "tudo" lá embaixo.
    const { rows } = semCustodia ? { rows: [] as any[] } : await pool.query(
      `WITH ops AS (
         SELECT DISTINCT cs.id, cs.op_code
           FROM op_material_events e
           JOIN client_services cs ON cs.id = e.client_service_id
          WHERE cs.status <> 'concluido'
            AND ($2::uuid IS NULL OR e.warehouse_id = $2)
          ORDER BY cs.op_code ASC
          LIMIT $1
       )
       SELECT e.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              ops.id AS client_service_id, ops.op_code, cl.name AS client_name,
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
         JOIN warehouses w         ON w.id = e.warehouse_id
         LEFT JOIN clients cl      ON cl.id = cs.client_id
        WHERE ($2::uuid IS NULL OR e.warehouse_id = $2)
        -- ⚠ O GRÃO MUDOU: era (OP, produto), agora é (ARMAZÉM, OP, produto). Sem o armazém no
        -- GROUP BY, a mesma OP com o mesmo produto recebido por DOIS setores viraria um card só,
        -- somando material de gente diferente. Medido em produção (20/08/2026): 19 de 701 pares
        -- (OP, produto) já foram entregues a mais de um setor, e 13 das 29 OPs têm separação para
        -- mais de um setor. A colisão é real, não hipótese.
        -- O JOIN warehouses (INNER, nao LEFT) e o que deixa a linha sem carimbo fora — e ela e
        -- contada e declarada em sem_setor, nunca omitida em silencio.
        GROUP BY e.warehouse_id, w.code, w.name, ops.id, ops.op_code, cl.name,
                 e.product_id, p.sku, p.name, p.unit
        ORDER BY w.name ASC, ops.op_code ASC, p.name ASC`,
      [limite, filtroWh],
    );

    // Monta o agrupamento em JS e não em json_agg: a ORDEM importa para a grade, e json_agg sem
    // ORDER BY herda a ordem do executor (régua do Lote 0). O ORDER BY do SELECT acima já entrega
    // as linhas na ordem certa; aqui só se preserva.
    //
    // ⚠ A CHAVE DO GRUPO GANHOU O ARMAZÉM. Era `client_service_id`; se continuasse assim, as duas
    // metades de uma OP multi-setor cairiam no mesmo grupo e a segunda sobrescreveria o setor da
    // primeira — o bug silencioso desta mudança.
    const porGrupo = new Map<string, any>();
    for (const r of rows) {
      const k = `${r.warehouse_id}|${r.client_service_id}`;
      if (!porGrupo.has(k)) {
        porGrupo.set(k, {
          warehouse_id: r.warehouse_id,
          warehouse_code: r.warehouse_code,
          warehouse_name: r.warehouse_name,
          client_service_id: r.client_service_id,
          op_code: r.op_code,
          client_name: r.client_name || '',
          materiais: [],
        });
      }
      porGrupo.get(k).materiais.push({
        product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
        recebido: num(r.recebido), consumido: num(r.consumido), devolvido: num(r.devolvido),
        transferido_in: num(r.transferido_in), transferido_out: num(r.transferido_out),
        // Linha com saldo 0 VEM (a tela a marca "Consumido"): "recebi 10 e consumi 10" é
        // informação, não ausência — a mesma decisão do /balance/:csid, palavra por palavra.
        saldo: num(r.saldo),
      });
    }
    const ops = Array.from(porGrupo.values());
    // `total_ops` conta OPs distintas (é o eixo do teto e da tarja); `ops` agora são GRUPOS
    // (armazém, OP) e podem ser mais numerosos. Comparar os dois diretamente faria `truncado`
    // acender sozinho numa OP multi-setor — daí a contagem de OPs distintas aqui.
    const opsDistintas = new Set(ops.map((g) => String(g.client_service_id))).size;

    return res.json({
      ops,
      total_ops: totalOps,
      truncado: totalOps > opsDistintas,
      limite,
      // CONTRATO ADITIVO (ver PW7): as chaves de antes seguem todas, com o mesmo significado.
      escopo: verTudo ? 'todos' : 'setor',
      // O armazém do próprio operador, para a tela poder dizer de quem é o que está mostrando.
      warehouse_id: escopo.warehouseId,
      warehouse_code: escopo.warehouseId ? (ops.find((g) => g.warehouse_id === escopo.warehouseId)?.warehouse_code ?? null) : null,
      pode_ver_tudo: escopo.isMaster,
      sem_setor: semSetor,
    });
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'opmat_warehouse_error', err_msg: String(error?.message ?? '').slice(0, 300) }));
    return res.status(500).json({ error: 'Erro ao carregar o armazém da produção' });
  }
};

// ⚠ ESTE ENDPOINT SEGUE GLOBAL — DECISÃO DO LOTE AW1, NÃO ESQUECIMENTO.
//
// Ele alimenta os KPIs do PAINEL DA PRODUÇÃO, que é outra tela e outra pergunta: "quanto WIP a
// fábrica tem", não "quanto material eu tenho". Filtrá-lo por setor tornaria o Painel incapaz de
// responder o que ele existe para responder, e um gerente veria o WIP do próprio setor achando
// que vê o da fábrica — trocaria uma divergência visível por uma invisível, que é pior.
//
// A divergência é REAL e foi medida (20/08/2026): `wip_unidades` global = 5; o Armazém filtrado
// mostra 2 para a Esteira e 3 para o Protótipo. O conserto do lote é do lado da TELA — o KPI do
// Armazém passa a dizer de quem é o número ("Meu setor" / "Todos os setores"), que é mudança de
// RÓTULO e não de dado. Ver PGArmazem no front.
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
