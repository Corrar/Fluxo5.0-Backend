-- 004_stock_integrity.sql — Fluxo Royale 5.0 (FUNDAÇÃO MULTI-ARMAZÉM)
-- Integridade de estoque + concorrência + multi-armazém (um armazém por setor).
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.

BEGIN;

-- =====================================================================
-- 1. ARMAZÉNS (um por setor + central). protheus_code mapeia 1:1 com o Protheus.
-- =====================================================================
CREATE TABLE IF NOT EXISTS warehouses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(20) NOT NULL UNIQUE,
  name          varchar(255) NOT NULL,
  sector        text,                 -- casa com requests.sector / profiles.sector
  protheus_code varchar(10),          -- 02 = ALMOX, 12 = USINAGEM, demais pendentes
  is_central    boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Semente (CONFIRMAR códigos/setor com a engenharia Royale; P3D/ELET/MONT/EXP sem código Protheus ainda).
INSERT INTO warehouses (code, name, sector, protheus_code, is_central) VALUES
  ('ALMOX',    'Almoxarifado Central', NULL,          '02', true),
  ('USINAGEM', 'Usinagem',             'usinagem',    '12', false),
  ('P3D',      'Produção 3D',          'producao_3d', NULL, false),
  ('ELET',     'Elétrica',             'eletrica',    NULL, false),
  ('MONT',     'Montagem',             'montagem',    NULL, false),
  ('EXP',      'Expedição',            'expedicao',   NULL, false)
ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- 2. ESTOQUE POR (produto, armazém, op_id)
--    ALMOX = op_id NULL (pooled, reservável). Setores = saldo amarrado à OP.
-- =====================================================================
ALTER TABLE stock ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id);
ALTER TABLE stock ADD COLUMN IF NOT EXISTS op_id        uuid REFERENCES client_services(id);

-- Backfill: o saldo global atual passa a pertencer ao ALMOX central, POOLED (op_id NULL).
UPDATE stock
   SET warehouse_id = (SELECT id FROM warehouses WHERE code = 'ALMOX')
 WHERE warehouse_id IS NULL;

-- Unicidade no grão (produto, armazém, op_id) via DOIS índices parciais:
--  - pooled  (op_id NULL):     no máx. 1 linha por (produto, armazém)        -> ALMOX
--  - por OP   (op_id NOT NULL): no máx. 1 linha por (produto, armazém, op_id) -> setores
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_product_id_key;
DROP INDEX IF EXISTS stock_product_id_key;
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_product_warehouse_key;
ALTER TABLE stock ALTER COLUMN warehouse_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_pooled ON stock (product_id, warehouse_id) WHERE op_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_op     ON stock (product_id, warehouse_id, op_id) WHERE op_id IS NOT NULL;

-- Invariantes por linha (produto×armazém). Saneamento antes das constraints.
ALTER TABLE stock ALTER COLUMN quantity_on_hand  SET DEFAULT 0;
ALTER TABLE stock ALTER COLUMN quantity_reserved SET DEFAULT 0;
UPDATE stock SET quantity_on_hand  = 0 WHERE quantity_on_hand  IS NULL OR quantity_on_hand  < 0;
UPDATE stock SET quantity_reserved = 0 WHERE quantity_reserved IS NULL OR quantity_reserved < 0;
UPDATE stock SET quantity_reserved = quantity_on_hand WHERE quantity_reserved > quantity_on_hand;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_on_hand_nonneg')      THEN ALTER TABLE stock ADD CONSTRAINT stock_on_hand_nonneg      CHECK (quantity_on_hand  >= 0); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reserved_nonneg')     THEN ALTER TABLE stock ADD CONSTRAINT stock_reserved_nonneg     CHECK (quantity_reserved >= 0); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reserved_le_onhand')  THEN ALTER TABLE stock ADD CONSTRAINT stock_reserved_le_onhand  CHECK (quantity_reserved <= quantity_on_hand); END IF;
END $$;

-- Criação de saldo é LAZY (feita pelo motor em receive/adjust/transfer_in).
-- Removido o trigger eager do 2.0 (não criar N×M linhas vazias).
DROP TRIGGER IF EXISTS trg_ensure_stock_row ON products;
DROP FUNCTION IF EXISTS ensure_stock_row();

-- =====================================================================
-- 3. RAZÃO IMUTÁVEL POR (produto, armazém) — fonte da verdade do estoque
-- =====================================================================
CREATE TABLE IF NOT EXISTS stock_ledger (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES products(id),
  warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
  op_id           UUID REFERENCES client_services(id),   -- NULL = pooled (ALMOX); setores amarram à OP
  kind            TEXT NOT NULL CHECK (kind IN ('opening','reserve','release','consume','receive','adjust','transfer_out','transfer_in')),
  delta_on_hand   NUMERIC NOT NULL DEFAULT 0,
  delta_reserved  NUMERIC NOT NULL DEFAULT 0,
  on_hand_after   NUMERIC NOT NULL,
  reserved_after  NUMERIC NOT NULL,
  op_key          TEXT,        -- idempotência (transfer usa <opKey>:out / <opKey>:in)
  ref_type        TEXT,
  ref_id          TEXT,
  user_id         UUID,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS idx_stock_ledger_pw;
CREATE INDEX IF NOT EXISTS idx_stock_ledger_pwo ON stock_ledger (product_id, warehouse_id, op_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_ledger_opkey ON stock_ledger (op_key) WHERE op_key IS NOT NULL;

-- 3.5 SALDO INICIAL NO RAZÃO — toda projeção (saldo) nasce do razão.
-- Idempotente: op_key estável por (produto, armazém); re-rodar não duplica.
INSERT INTO stock_ledger
  (product_id, warehouse_id, op_id, kind, delta_on_hand, delta_reserved, on_hand_after, reserved_after, op_key, ref_type, reason)
SELECT s.product_id, s.warehouse_id, s.op_id, 'opening',
       s.quantity_on_hand, s.quantity_reserved, s.quantity_on_hand, s.quantity_reserved,
       'opening:' || s.product_id || ':' || s.warehouse_id || ':' || COALESCE(s.op_id::text, 'NULL'),
       'opening', 'Saldo inicial — migração 5.0'
FROM stock s
WHERE NOT EXISTS (
  SELECT 1 FROM stock_ledger l
   WHERE l.op_key = 'opening:' || s.product_id || ':' || s.warehouse_id || ':' || COALESCE(s.op_id::text, 'NULL')
);

-- =====================================================================
-- 4. CONCORRÊNCIA OTIMISTA + CLAIM POR LINHA
-- =====================================================================
ALTER TABLE separations ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE separation_items ADD COLUMN IF NOT EXISTS picked_by     UUID;
ALTER TABLE separation_items ADD COLUMN IF NOT EXISTS picked_at     TIMESTAMPTZ;
ALTER TABLE separation_items ADD COLUMN IF NOT EXISTS picked_status TEXT NOT NULL DEFAULT 'pendente';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'separation_items_picked_status_chk') THEN
    ALTER TABLE separation_items ADD CONSTRAINT separation_items_picked_status_chk CHECK (picked_status IN ('pendente','separando','ok','falta'));
  END IF;
END $$;

-- =====================================================================
-- 5. ARMAZÉM DE ORIGEM/OPERAÇÃO NOS FLUXOS (5.0)
-- =====================================================================
ALTER TABLE requests    ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id);  -- armazém do setor solicitante
ALTER TABLE separations ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id);  -- armazém de onde se separa

-- (Opcional, recomendado p/ transferências explícitas) cabeçalho de transferência:
CREATE TABLE IF NOT EXISTS stock_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_warehouse  uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse    uuid NOT NULL REFERENCES warehouses(id),
  status          text NOT NULL DEFAULT 'concluida',  -- 'pendente'|'concluida'|'cancelada'
  ref_type        text,                                -- 'separation' quando automática
  ref_id          uuid,
  requested_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMIT;