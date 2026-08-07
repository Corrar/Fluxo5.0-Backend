-- 020_3d_estoque_fisico.sql — Fluxo Royale 5.0
-- O 3D VIRA ESTOQUE FÍSICO COMPLETO. Esta migration não muda comportamento sozinha: ela cria as
-- DUAS COLUNAS sem as quais o lote I-a não tem onde se apoiar, e reconstrói o passado que o
-- código novo passa a exigir.
--
-- ── O QUE O RECON (d) MEDIU E POR QUE ISTO EXISTE ───────────────────────────────────────────
-- Item 3D não tinha ONDE registrar quanto de reserva ele segura. A reserva nascia na criação
-- (requests.controller, "Reserva na criação (3D — parte já em estoque)") e morria... nunca: os
-- seis guards `!is_3d` das saídas pulavam entrega, rejeição, devolução, cancelamento, devolução
-- parcial e o cron. Resultado medido na validação: 10 UNIDADES de reserva presa, em 4
-- solicitações rejeitadas, 3 SKUs (3D-0003:7, 3D-0001:1, 3D-0003:1, 3D-0008:1). Sem uma coluna
-- por item, nenhuma saída consegue liberar "o que este item segura" — só chutar por
-- quantity_requested, que é justamente o número errado quando houve ajuste na conferência.
--
--   qty_reserved      -> quanto ESTE item de solicitação segura no pooled AGORA. É a FÓRMULA
--                        ÚNICA de liberação do lote I-a: rejeição, cancelamento e cron liberam
--                        exatamente qty_reserved, e a entrega exige qty_reserved >= efetiva.
--   request_item_id   -> rateio por ITEM na demanda 3D. Hoje demands_3d aponta só para a
--                        REQUEST: duas linhas do MESMO produto na mesma solicitação geram duas
--                        demandas indistinguíveis, e a conclusão não sabe a qual item creditar.
--
-- ── POR QUE O BACKFILL VEM DO RAZÃO E NUNCA DE `stock` (D11 do recon) ───────────────────────
-- `stock` e `stock_ledger` DIVERGEM nesta base: 3D-0003 soma 13 de reserva no razão e tem 8 no
-- saldo. As 5 de diferença são duas reservas de 21/07 cujas requests foram apagadas e cujo saldo
-- foi zerado por escrita DIRETA na tabela `stock`, sem contrapartida no razão (o cleanup global
-- que já destruiu o seed duas vezes). Reconstruir qty_reserved a partir de `stock` herdaria essa
-- mentira e a espalharia por item.
--
-- A derivação aqui é POR ITEM e vem só do razão, somando as op_keys content-addressed daquele
-- item (`request:<request_id>:item:<item_id>:%`). Isso é imune à divergência acima por
-- construção: uma reserva cujo item não existe mais não pertence a item nenhum e não é somada.
-- É SUM(delta_reserved), que já é a fórmula pedida com os sinais que o próprio razão grava:
--   +reserve  −release  +adjreserve  −adjrelease  (−consume, que também libera reserva)
-- Somar a coluna assinada em vez de enumerar os kinds pega de graça os namespaces de fase
-- ('conf:adjrelease') e o consume — enumerar convidaria a esquecer um deles.
--
-- ── ESCOPO DO BACKFILL: SÓ RESERVA VIVA ─────────────────────────────────────────────────────
-- Só solicitações em 'aberto', 'aprovado' e 'conferido' — os três estados que seguram reserva
-- (ver o guard do deleteRequest). Terminais ('rejeitado','entregue','devolvido') ficam em 0, que
-- é o DEFAULT: não são tocadas. Isso é deliberado e vale dizer alto: as 4 solicitações órfãs são
-- 'rejeitado' e portanto NASCEM COM qty_reserved = 0 aqui, mesmo tendo reserva presa no saldo.
-- Elas NÃO são consertadas por esta migration — a limpeza delas é o scripts/release-orfas-3d.ts,
-- que tem GO próprio do Bruno. Se o backfill as incluísse, a coluna passaria a afirmar que uma
-- solicitação morta ainda segura estoque, e o primeiro caminho a ler isso ficaria confuso.
--
-- ADITIVA E IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + backfill que só escreve onde o valor difere.
-- Re-execução é no-op. Rodar na validação (branch Neon ep-summer-wave) ANTES ou JUNTO do deploy
-- do backend novo, NUNCA depois: o código do lote I-a lê e escreve qty_reserved em todo caminho
-- de solicitação, 3D ou não — sem a coluna, criar solicitação quebra.

BEGIN;

-- Guardas de pré-requisito: falhar aqui, alto e claro, é melhor que criar meia estrutura.
DO $$
BEGIN
  IF to_regclass('public.request_items') IS NULL THEN
    RAISE EXCEPTION 'request_items ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.demands_3d') IS NULL THEN
    RAISE EXCEPTION 'demands_3d ausente — schema base do módulo 3D não encontrado.';
  END IF;
  IF to_regclass('public.stock_ledger') IS NULL THEN
    RAISE EXCEPTION 'stock_ledger ausente — a migration 004 precisa estar aplicada (o backfill deriva do razão).';
  END IF;
END $$;

-- =====================================================================
-- 1. request_items.qty_reserved — quanto ESTE item segura no pooled
-- =====================================================================
-- NUMERIC (não INTEGER): request_items.quantity_requested é NUMERIC e unidades decimais (M/L/KG)
-- existem no domínio. O 3D é inteiro por regra de negócio, e essa regra é BORDA (o controller
-- devolve 400 em fracionário de peça 3D), não tipo — travar aqui quebraria os não-3D.
-- DEFAULT 0 + NOT NULL: item sem reserva é 0, nunca NULL. NULL obrigaria todo caminho de leitura
-- a um COALESCE e abriria a dúvida "0 ou desconhecido?" — que não existe: a ausência de reserva
-- é um fato conhecido.
ALTER TABLE request_items
  ADD COLUMN IF NOT EXISTS qty_reserved NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN request_items.qty_reserved IS
  'Quanto ESTE item segura de reserva no pooled do ALMOX agora. Fórmula única de liberação: '
  'rejeição/cancelamento/cron liberam exatamente este valor; a entrega exige qty_reserved >= '
  'quantidade efetiva. Mantido pelo requests.controller e pela conclusão da demanda 3D.';

-- Invariante no BANCO, não só na borda (mesma doutrina de stock_reserved_nonneg da 004): reserva
-- negativa é estado impossível, e é melhor a escrita falhar alto que a coluna guardar absurdo.
-- Seguro de adicionar: o backfill abaixo ABORTA a migration se derivar qualquer negativo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_items_qty_reserved_nonneg') THEN
    ALTER TABLE request_items
      ADD CONSTRAINT request_items_qty_reserved_nonneg CHECK (qty_reserved >= 0);
  END IF;
END $$;

-- =====================================================================
-- 2. demands_3d.request_item_id — o rateio por item
-- =====================================================================
-- NULL é legítimo e permanente: demanda criada antes deste lote não tem como saber de qual item
-- nasceu, e inventar um vínculo seria pior que a ausência. O controller trata NULL com fallback
-- declarado (deriva por (request_id, product_id); se ambíguo, credita o primeiro item não
-- satisfeito) — ver producao3d.controller, updateDemandStatus.
-- SEM BACKFILL: demands_3d está VAZIA na validação (0 linhas, medido no recon (d)). Não há o que
-- derivar, e escrever um backfill para zero linhas seria código não exercido.
-- ON DELETE: NO ACTION (o default), como especificado. Não há DELETE de request_items no código
-- (o cancelamento é soft: UPDATE status). O único caminho é o CASCADE de requests, que apaga
-- request_items E demands_3d na MESMA operação — o Postgres resolve os dois cascades juntos e
-- nenhuma linha sobra apontando para o vazio (verificado no efêmero antes deste commit).
ALTER TABLE demands_3d
  ADD COLUMN IF NOT EXISTS request_item_id UUID NULL REFERENCES request_items(id);

COMMENT ON COLUMN demands_3d.request_item_id IS
  'Item da solicitação que originou esta demanda (rateio por item). NULL = demanda legada, '
  'anterior ao lote I-a: a conclusão cai no fallback por (request_id, product_id).';

-- Lookup do fallback e da conclusão. Parcial: a maioria das demandas legadas fica NULL e não
-- precisa entrar no índice.
CREATE INDEX IF NOT EXISTS idx_demands_3d_request_item
  ON demands_3d (request_item_id) WHERE request_item_id IS NOT NULL;

-- =====================================================================
-- 3. BACKFILL de qty_reserved — derivado do RAZÃO, só para reserva viva
-- =====================================================================
-- GUARDA DE PREMISSA (padrão ratificado no DROP da 014): se a derivação produzir qualquer saldo
-- NEGATIVO, a premissa "o razão fecha por item" está falsa e a migration ABORTA em vez de gravar
-- número impossível. Preferimos o deploy travado a uma coluna que mente.
DO $$
DECLARE negativos INT;
BEGIN
  SELECT count(*) INTO negativos
    FROM (
      SELECT ri.id,
             COALESCE((SELECT SUM(l.delta_reserved) FROM stock_ledger l
                        WHERE l.op_key LIKE 'request:' || ri.request_id || ':item:' || ri.id || ':%'), 0) AS saldo
        FROM request_items ri
        JOIN requests r ON r.id = ri.request_id
       WHERE r.status IN ('aberto', 'aprovado', 'conferido')
    ) d
   WHERE d.saldo < 0;

  IF negativos > 0 THEN
    RAISE EXCEPTION 'BACKFILL ABORTADO: % item(ns) de solicitação viva com reserva derivada NEGATIVA no razão. O razão não fecha por item — investigar antes de aplicar.', negativos;
  END IF;
END $$;

-- A escrita. `IS DISTINCT FROM` evita UPDATE em linha que já está no valor certo (re-execução
-- vira no-op de verdade, sem gerar WAL nem tocar mtime).
UPDATE request_items ri
   SET qty_reserved = d.saldo
  FROM (
    SELECT ri2.id,
           COALESCE((SELECT SUM(l.delta_reserved) FROM stock_ledger l
                      WHERE l.op_key LIKE 'request:' || ri2.request_id || ':item:' || ri2.id || ':%'), 0) AS saldo
      FROM request_items ri2
      JOIN requests r ON r.id = ri2.request_id
     WHERE r.status IN ('aberto', 'aprovado', 'conferido')
  ) d
 WHERE d.id = ri.id
   AND ri.qty_reserved IS DISTINCT FROM d.saldo;

COMMIT;
