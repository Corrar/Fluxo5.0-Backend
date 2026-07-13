-- 007_nf_number.sql — Fluxo Royale 5.0
-- NF RASTREÁVEL na entrada de estoque. Grava o número da nota tanto no razão imutável
-- (stock_ledger — fonte da verdade do estoque) quanto no cabeçalho do log (xml_logs —
-- lido pelo Reports). É o que habilita a idempotência real POR NF no registerEntries
-- (op_key = entry:nf:<nf>:product:<produto>:receive).
-- Ambas as colunas são NULLABLE de propósito: não afeta nenhuma linha existente —
-- entradas antigas (e reaproveitamentos sem nota) ficam com nf_number NULL.
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.

BEGIN;

-- Guarda de pré-requisito: as duas tabelas precisam existir (schema base + migration 004).
DO $$
BEGIN
  IF to_regclass('public.stock_ledger') IS NULL THEN
    RAISE EXCEPTION 'stock_ledger ausente — a migration 004 precisa estar aplicada.';
  END IF;
  IF to_regclass('public.xml_logs') IS NULL THEN
    RAISE EXCEPTION 'xml_logs ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- 1. NÚMERO DA NF no razão imutável (rastreabilidade por movimento de entrada).
-- =====================================================================
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS nf_number text;

-- =====================================================================
-- 2. NÚMERO DA NF no cabeçalho do log de entrada (lido pelo Reports).
-- =====================================================================
ALTER TABLE xml_logs ADD COLUMN IF NOT EXISTS nf_number text;

COMMIT;
