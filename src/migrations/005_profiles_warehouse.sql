-- 005_profiles_warehouse.sql — Fluxo Royale 5.0
-- Armazém de origem do SOLICITANTE: a reserva do 5.0 nasce no armazém do perfil.
-- Decisão de negócio (transição): por enquanto TODO perfil reserva no ALMOX central;
-- o de-para por setor de chão de fábrica (profiles.sector -> warehouses.sector) vem depois.
-- Idempotente (re-executável). Depende da 004 (tabela warehouses + semente ALMOX).
-- Rodar em branch Neon antes de promover. NÃO rodar ainda (apenas criada).

BEGIN;

-- Guarda de pré-requisito: a 004 precisa ter criado warehouses antes desta migration.
DO $$
BEGIN
  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION 'warehouses ausente — rode a 004 antes da 005.';
  END IF;
END $$;

-- =====================================================================
-- 1. ARMAZÉM DO PERFIL (origem da reserva). Nullable de propósito:
--    perfis novos podem nascer sem armazém até o de-para final.
-- =====================================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS warehouse_id uuid;

-- FK guardada (padrão pg_constraint da 004; idempotente mesmo se a coluna já existia sem FK).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_warehouse_id_fkey') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_warehouse_id_fkey
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
  END IF;
END $$;

-- =====================================================================
-- 2. BACKFILL: todo perfil sem armazém passa a reservar no ALMOX central.
--    (o de-para por setor sobrescreve depois, numa migration futura.)
-- =====================================================================
UPDATE profiles
   SET warehouse_id = (SELECT id FROM warehouses WHERE code = 'ALMOX')
 WHERE warehouse_id IS NULL;

-- (Intencional) SEM NOT NULL nesta fase — ver cabeçalho.

COMMIT;
