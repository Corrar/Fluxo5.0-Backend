-- 011_audit_action_index.sql — Fluxo Royale 5.0
-- ÍNDICE POR AÇÃO NO LIVRO DE AUDITORIA.
--
-- POR QUE: a Auditoria v1 (tela + GET /admin/logs) filtra por `action` server-side
-- (a.action = $n) e o COUNT(*) da paginação usa os MESMOS filtros — ou seja, todo filtro
-- por ação roda duas vezes por request. audit_logs é append-only e só cresce; sem índice
-- o filtro vira seq scan da história inteira a cada página. created_at já tem o dele
-- (idx_audit_created_at) — action era o que faltava.
--
-- ADITIVA E IDEMPOTENTE: só CREATE INDEX IF NOT EXISTS, sem tocar em dado. Rodar de novo
-- é no-op. (CREATE INDEX não-concorrente segura lock de escrita na tabela durante o build;
-- com o volume atual de audit_logs isso é instantâneo — se um dia o livro tiver milhões de
-- linhas, a variante CONCURRENTLY fora de transação é o caminho.)

BEGIN;

-- Guarda de pré-requisito: o livro de auditoria vive no schema base, fora deste versionamento
-- (mesma situação das guardas das migrations anteriores).
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'audit_logs ausente — schema base não encontrado.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);

COMMENT ON INDEX idx_audit_action IS
  'Filtro por ação da tela de Auditoria (GET /admin/logs?action=...). Par do idx_audit_created_at.';

COMMIT;
