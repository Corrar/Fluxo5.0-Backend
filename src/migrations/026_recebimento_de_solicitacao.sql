-- =====================================================================================
-- 026 — RECEBIMENTO DE ORIGEM SOLICITAÇÃO (lote RS1)
-- =====================================================================================
--
-- O QUE MUDA
--   1. `op_material_events` ganha as colunas de origem-SOLICITAÇÃO (ref_request_id,
--      ref_request_item_id), com FK real, e o CHECK de origem passa a aceitar UMA das duas
--      origens — nunca as duas, nunca nenhuma.
--   2. `requests` ganha `delivered_at`: a data em que a entrega aconteceu.
--
-- POR QUE COLUNAS NOVAS, E NÃO REUSAR AS EXISTENTES
--   Reusar `ref_separation_id`/`ref_separation_item_id` com semântica dupla foi MEDIDO e é
--   IMPOSSÍVEL, não apenas feio: as duas têm FOREIGN KEY —
--       op_material_events_ref_separation_id_fkey      -> separations(id)
--       op_material_events_ref_separation_item_id_fkey -> separation_items(id)
--   O banco REJEITARIA um request_id ali. Para reusá-las seria preciso DERRUBAR as duas FKs,
--   isto é, trocar integridade referencial por duas colunas de economia.
--
-- POR QUE `requests.delivered_at`
--   ⚠ ACRÉSCIMO AO ESCOPO ORIGINAL DO LOTE, e ele tem razão de ser. `requests` não tem NENHUM
--   carimbo de entrega: as colunas são id, requester_id, sector, status, rejection_reason,
--   created_at, op_id, client_service_id, version, warehouse_id. Não há `updated_at` nem
--   `delivered_at` (medido em produção, 19/08/2026).
--
--   A fila de recebimento ORDENA por `sent_at` e filtra pelo CUTOFF com ele. Do lado da
--   solicitação não existia equivalente, e sem ele:
--     · a fila não teria por que ordenar;
--     · o CUTOFF de go-live não teria como excluir o histórico;
--     · a JANELA de contenção (D3) não teria eixo.
--   `created_at` NÃO serve: é quando o setor PEDIU, não quando o almoxarifado ENTREGOU — a
--   diferença medida chega a meses.
--
-- ⚠ A PENDÊNCIA NÃO É UMA LINHA. Ela é DERIVADA, exatamente como a das separações
--   (request_items − Σ recebido). Duas razões, as duas duras:
--     · `op_material_events.event_type` tem CHECK com 5 valores e 'pendente' não é um deles;
--     · gravar no razão NA ENTREGA creditaria a OP ANTES da confirmação — o oposto exato da
--       decisão do lote ("o setor confirma, e SÓ ENTÃO o material consta na OP").
--   O que nasce na entrega é o CARIMBO (delivered_at). A pendência aparece porque ele existe.
--
-- IDEMPOTENTE: re-executar é no-op. Guarda de estado no fim aborta se o resultado não bater.
-- =====================================================================================

BEGIN;

-- ── Guarda de pré-requisito ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.op_material_events') IS NULL THEN
    RAISE EXCEPTION '026: op_material_events ausente — a 008 não foi aplicada.';
  END IF;
  IF to_regclass('public.requests') IS NULL THEN
    RAISE EXCEPTION '026: requests ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.request_items') IS NULL THEN
    RAISE EXCEPTION '026: request_items ausente — schema base não encontrado.';
  END IF;
END $$;

-- ── 1. Colunas de origem-solicitação ────────────────────────────────────────────────
ALTER TABLE op_material_events
  ADD COLUMN IF NOT EXISTS ref_request_id      UUID REFERENCES requests(id),
  ADD COLUMN IF NOT EXISTS ref_request_item_id UUID REFERENCES request_items(id);

-- ── 2. O CHECK de origem: EXATAMENTE UMA das duas ───────────────────────────────────
-- Antes: 'recebido' exigia separação. Agora exige separação OU solicitação, de forma
-- EXCLUSIVA: as quatro colunas de origem juntas não passam, e nenhuma delas também não.
-- Um evento com as duas origens seria material que veio de dois lugares ao mesmo tempo.
ALTER TABLE op_material_events DROP CONSTRAINT IF EXISTS ck_opmat_recebido_tem_origem;
ALTER TABLE op_material_events
  ADD CONSTRAINT ck_opmat_recebido_tem_origem CHECK (
    event_type <> 'recebido'
    OR (
      (ref_separation_id IS NOT NULL AND ref_separation_item_id IS NOT NULL
       AND ref_request_id IS NULL AND ref_request_item_id IS NULL)
      OR
      (ref_request_id IS NOT NULL AND ref_request_item_id IS NOT NULL
       AND ref_separation_id IS NULL AND ref_separation_item_id IS NULL)
    )
  );

-- ── 3. Índices, no mesmo padrão dos existentes ──────────────────────────────────────
-- Espelham idx_opmat_ref_separation / idx_opmat_ref_sep_item: o teto do recebimento parcial
-- e a fila fazem lookup por estas colunas a cada linha.
CREATE INDEX IF NOT EXISTS idx_opmat_ref_request      ON op_material_events (ref_request_id);
CREATE INDEX IF NOT EXISTS idx_opmat_ref_request_item ON op_material_events (ref_request_item_id);

-- ── 4. O carimbo de entrega da solicitação ──────────────────────────────────────────
ALTER TABLE requests ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- BACKFILL DELIBERADAMENTE AUSENTE. As 2.496 solicitações já entregues NÃO recebem
-- delivered_at: sem ele, elas não entram na fila — que é exatamente a decisão do lote (não há
-- pendência retroativa; o material já foi transferido meses atrás). Preencher com `created_at`
-- seria INVENTAR uma data de entrega que ninguém registrou, e jogaria 1.916 itens na fila.
--
-- A fila do recebimento também tem o CUTOFF_DATE de go-live como segunda barreira, mas a
-- ausência do carimbo é a primeira e a mais honesta: o que não foi medido fica NULL.

-- Ordena e janela a fila; o índice parcial cobre só o que interessa (entregue com carimbo).
CREATE INDEX IF NOT EXISTS idx_requests_delivered_at
  ON requests (delivered_at DESC) WHERE delivered_at IS NOT NULL;

-- ── 5. GUARDA DE ESTADO: aborta se o resultado não for o esperado ───────────────────
DO $$
DECLARE
  n_cols   INT;
  n_check  INT;
  n_orfas  INT;
BEGIN
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_name = 'op_material_events'
     AND column_name IN ('ref_request_id', 'ref_request_item_id');
  IF n_cols <> 2 THEN
    RAISE EXCEPTION '026: esperava 2 colunas novas em op_material_events, encontrei %', n_cols;
  END IF;

  SELECT count(*) INTO n_check FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'op_material_events' AND con.conname = 'ck_opmat_recebido_tem_origem';
  IF n_check <> 1 THEN
    RAISE EXCEPTION '026: ck_opmat_recebido_tem_origem não ficou instalada (% encontradas)', n_check;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'requests' AND column_name = 'delivered_at') THEN
    RAISE EXCEPTION '026: requests.delivered_at não foi criada.';
  END IF;

  -- As linhas que já existiam são todas de origem-SEPARAÇÃO e têm de continuar válidas.
  -- O ADD CONSTRAINT já as valida (Postgres verifica ao criar); esta contagem é a prova
  -- explícita de que nenhuma ficou órfã de origem.
  SELECT count(*) INTO n_orfas FROM op_material_events
   WHERE event_type = 'recebido'
     AND ref_separation_id IS NULL AND ref_request_id IS NULL;
  IF n_orfas > 0 THEN
    RAISE EXCEPTION '026: % evento(s) "recebido" sem origem — o CHECK não deveria ter passado', n_orfas;
  END IF;

  RAISE NOTICE '026 OK: colunas=%, check=1, delivered_at=sim, recebidos sem origem=%', n_cols, n_orfas;
END $$;

COMMIT;
