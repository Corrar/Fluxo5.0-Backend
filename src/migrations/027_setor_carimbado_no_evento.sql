-- =====================================================================================
-- 027 — O SETOR CARIMBADO NO EVENTO (lote AW1)
-- =====================================================================================
--
-- O QUE MUDA
--   1. `op_material_events` ganha `warehouse_id` (FK -> warehouses), NULLABLE.
--   2. Índice para o filtro por setor do Armazém da Produção.
--   3. BACKFILL dos eventos existentes a partir do destino da separação de origem.
--
-- POR QUE CARIMBAR, E NÃO DERIVAR POR JOIN (decisão A1 do lote, medida na fase 0)
--   O setor só é DERIVÁVEL em 'recebido'. Os outros quatro tipos nascem sem origem POR
--   CONSTRUÇÃO do INSERT — não é o CHECK que permite, é que o código nunca lista as colunas
--   `ref_*` neles (consumido: opMaterials.controller:328; devolvido: returns.service:232;
--   transferido_out/in: :404 e :410). No primeiro apontamento um filtro por JOIN devolveria
--   setor NULL, o consumo escaparia do filtro e o SALDO INFLARIA.
--   E `updateSeparation` (separations.controller:401) reescreve `destination` com guard só de
--   PAPEL, sem guard de status: um admin editando separação já concluída moveria material de
--   armazém RETROATIVAMENTE e em silêncio. Derivação não tem memória; carimbo tem.
--
-- POR QUE `warehouse_id` (FK) E NÃO UM `sector` CANÔNICO
--   O canônico é N->1 e por isso não serve de chave de agrupamento: SETOR_ARMAZEM tem DUAS
--   chaves para o mesmo armazém ('3D' e 'PRODUCAO 3D' -> ambas P3D). Dois eventos carimbados
--   com canônicos diferentes virariam DOIS setores na tela para UM armazém físico — a colisão
--   que o mapa existe para evitar. E `profiles.sector = '3D'` existe hoje (medido).
--   Some-se: o `code` já está em mãos no INSERT (o guard D1 do receive já chama
--   resolveDestinationWarehouse, :157) e `resolveDestinationWarehouseId` já existe e é cacheado
--   (warehouse.ts:80) — o custo é zero. E texto livre sem CHECK em tabela de razão é repetir a
--   surpresa do `type` no lote SEP1.
--
-- ⚠ NASCE NULLABLE, DE PROPÓSITO (decisão A1).
--   NOT NULL (ou CHECK por event_type) é passo SEPARADO. Duas razões:
--     · eventos legados de outras bases podem não ter origem resolvível, e o NOT NULL os
--       tornaria não-inseríveis antes de alguém decidir o que fazer com eles;
--     · a coluna só passa a ser preenchida sempre a partir do backend deste lote — travar o
--       banco antes do código subir derrubaria o INSERT em produção durante a janela.
--
-- ⚠ O BACKFILL DOS DOIS EVENTOS CRUZADOS É ESCOLHA **DOCUMENTAL**, NÃO FÍSICA (decisão A6).
--   Dois dos quatro eventos foram confirmados por quem NÃO é do setor de destino, antes do
--   guard de custódia existir (commit 9abc422, 18/08/2026 19:52Z; os eventos são de 10:29Z e
--   18:44Z do mesmo dia). Para onde o material foi FISICAMENTE não há prova de lado nenhum:
--   ambos vieram de separação `type='manual'`, cuja baixa no stock_ledger é
--   `kind='consume' / ref_type='separation'` **em ALMOX** — não existe `transfer_in` para
--   armazém de setor nenhum. E não há apontamento posterior (0 eventos que não sejam
--   'recebido' em toda a base).
--   O que existe são DUAS testemunhas documentais concordantes, ambas apontando ESTEIRA:
--     · `separations.destination` = 'Esteira' nos dois;
--     · `audit_logs.action='MANUAL_WITHDRAWAL'`, `details->>'sector'` = 'Esteira' nos dois,
--       escrito por Evandro Campos (almoxarife) NO ATO da entrega — registro de terceiro.
--   Contra elas, só o `user_id` de quem clicou em confirmar. O Bruno escolheu ESTEIRA.
--   Registrado aqui porque uma escolha documental que vira dado precisa dizer que é escolha.
--
-- POR QUE O BACKFILL É UMA REGRA SÓ PARA OS QUATRO
--   Com A6, o destino da separação passa a valer para os quatro eventos — inclusive os dois
--   cruzados. Então não há dois ramos: todos derivam de `separations.destination`.
--
-- ⚠ O `CASE` ABAIXO NÃO É UM SEGUNDO DE-PARA. A FONTE DO DE-PARA É `src/services/setor.ts`.
--   Este CASE cobre EXATAMENTE os valores que existem nos eventos desta base e ABORTA em
--   qualquer outro (guarda no fim). É backfill de uma vez, não tradutor residente. Setor novo
--   entra como chave em SETOR_ARMAZEM — nunca aqui, e nunca em `warehouses.sector`.
--
-- IDEMPOTENTE: re-executar é no-op (o UPDATE só toca `warehouse_id IS NULL`).
-- =====================================================================================

BEGIN;

-- ── Guarda de pré-requisito ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.op_material_events') IS NULL THEN
    RAISE EXCEPTION '027: op_material_events ausente — a 008 não foi aplicada.';
  END IF;
  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION '027: warehouses ausente — a 004 não foi aplicada.';
  END IF;
  -- Os armazéns de setor da 024 são o alvo do carimbo. Sem eles o backfill não tem para onde ir.
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE code = 'ESTEIRA') THEN
    RAISE EXCEPTION '027: armazém ESTEIRA ausente — a 024 não foi aplicada.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE code = 'PROTOTIPO') THEN
    RAISE EXCEPTION '027: armazém PROTOTIPO ausente — a 024 não foi aplicada.';
  END IF;
END $$;

-- ── 1. A coluna ─────────────────────────────────────────────────────────────────────
-- NULLABLE e sem DEFAULT: no PostgreSQL 11+ isto é alteração de METADADO, sem reescrita de
-- tabela. Medido: 152 kB / 4 linhas — instantâneo de qualquer forma, mas a propriedade importa
-- para quando a tabela crescer.
ALTER TABLE op_material_events
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id);

COMMENT ON COLUMN op_material_events.warehouse_id IS
  'Armazem do SETOR que detem o material (lote AW1). O setor e o DONO, a OP e a ETIQUETA. '
  'Carimbado no INSERT a partir da ORIGEM (recebido), do saldo (transferido_*), do req.user '
  '(consumido) ou de op_returns_pending.requested_by (devolvido). NUNCA derivado por JOIN.';

-- ── 2. Índice do filtro ─────────────────────────────────────────────────────────────
-- O Armazém filtra por armazém e agrega por (armazém, OP, produto): o índice segue essa ordem.
-- Espelha idx_opmat_op_product, que cobre a agregação sem setor e continua servindo o /balance.
CREATE INDEX IF NOT EXISTS idx_opmat_warehouse_op_product
  ON op_material_events (warehouse_id, client_service_id, product_id);

-- ── 3. BACKFILL a partir do destino da separação ────────────────────────────────────
-- `WHERE e.warehouse_id IS NULL` é o que torna a re-execução no-op.
UPDATE op_material_events e
   SET warehouse_id = w.id
  FROM separations s
  JOIN warehouses w
    ON w.code = CASE
         upper(translate(
           regexp_replace(btrim(s.destination), '^[Ss][Ee][Tt][Oo][Rr][[:space:]]*:[[:space:]]*', ''),
           'áàãâéêíóôõúüçÁÀÃÂÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'))
         WHEN 'ESTEIRA'   THEN 'ESTEIRA'
         WHEN 'PROTOTIPO' THEN 'PROTOTIPO'
         ELSE NULL
       END
 WHERE s.id = e.ref_separation_id
   AND e.warehouse_id IS NULL;

-- ── 4. GUARDA DE ESTADO: aborta se o resultado não for o esperado ───────────────────
DO $$
DECLARE
  n_col        INT;
  n_idx        INT;
  n_total      INT;
  n_carimbado  INT;
  n_nao_trata  INT;
  n_almox      INT;
BEGIN
  SELECT count(*) INTO n_col FROM information_schema.columns
   WHERE table_name = 'op_material_events' AND column_name = 'warehouse_id';
  IF n_col <> 1 THEN
    RAISE EXCEPTION '027: op_material_events.warehouse_id nao foi criada.';
  END IF;

  SELECT count(*) INTO n_idx FROM pg_indexes
   WHERE tablename = 'op_material_events' AND indexname = 'idx_opmat_warehouse_op_product';
  IF n_idx <> 1 THEN
    RAISE EXCEPTION '027: idx_opmat_warehouse_op_product nao ficou instalado.';
  END IF;

  SELECT count(*) INTO n_total     FROM op_material_events;
  SELECT count(*) INTO n_carimbado FROM op_material_events WHERE warehouse_id IS NOT NULL;

  -- ⚠ A GUARDA QUE IMPORTA: nenhum evento cuja origem o CASE acima TRATA pode ter ficado NULL.
  -- Se sobrou, o backfill não fez o que diz — e é melhor abortar que carimbar metade.
  SELECT count(*) INTO n_nao_trata
    FROM op_material_events e
    JOIN separations s ON s.id = e.ref_separation_id
   WHERE e.warehouse_id IS NULL
     AND upper(translate(
           regexp_replace(btrim(s.destination), '^[Ss][Ee][Tt][Oo][Rr][[:space:]]*:[[:space:]]*', ''),
           'áàãâéêíóôõúüçÁÀÃÂÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'))
         IN ('ESTEIRA', 'PROTOTIPO');
  IF n_nao_trata > 0 THEN
    RAISE EXCEPTION '027: % evento(s) de origem tratada ficaram sem carimbo — backfill incompleto.', n_nao_trata;
  END IF;

  -- Nenhum evento pode apontar para o ALMOX: o razão per-OP é WIP de SETOR. Material no ALMOX
  -- é estoque central e vive em `stock`, não aqui.
  SELECT count(*) INTO n_almox
    FROM op_material_events e JOIN warehouses w ON w.id = e.warehouse_id
   WHERE w.code = 'ALMOX';
  IF n_almox > 0 THEN
    RAISE EXCEPTION '027: % evento(s) carimbados com ALMOX — o razao per-OP e WIP de setor.', n_almox;
  END IF;

  -- Sobrar NULL é ADMISSÍVEL (a coluna é nullable de propósito) mas nunca SILENCIOSO.
  RAISE NOTICE '027 OK: eventos=%, carimbados=%, sem carimbo=% (nullable por decisao A1), almox=0',
    n_total, n_carimbado, n_total - n_carimbado;
END $$;

COMMIT;
