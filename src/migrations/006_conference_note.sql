-- 006_conference_note.sql — Fluxo Royale 5.0
-- Justificativa da CONFERÊNCIA por item (ex.: item faltante conferido com ressalva no
-- passo aprovado→conferido). Campo PRÓPRIO, separado de request_items.observation (que é
-- a nota do SOLICITANTE) — nunca sobrescreve a observação original.
-- Nullable de propósito (a maioria dos itens não terá justificativa).
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.

BEGIN;

-- Guarda de pré-requisito: a tabela de itens precisa existir.
DO $$
BEGIN
  IF to_regclass('public.request_items') IS NULL THEN
    RAISE EXCEPTION 'request_items ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- 1. NOTA DE CONFERÊNCIA POR ITEM (texto livre, gravada em status='conferido').
-- =====================================================================
ALTER TABLE request_items ADD COLUMN IF NOT EXISTS conference_note text;

COMMIT;
