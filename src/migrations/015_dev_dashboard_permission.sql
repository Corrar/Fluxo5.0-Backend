-- 015_dev_dashboard_permission.sql — Fluxo Royale 5.0
-- DEV-PAINEL v1: nasce a page_key 'dev_dashboard' no universo da tela Permissões.
--
-- SEM DDL DE PROPÓSITO: o painel é 100% LEITURA AGREGADA de tickets (migration 012) e
-- dev_projects (013). Nenhuma tabela, coluna ou índice novo — se um KPI precisasse de
-- coluna nova, ele não teria fonte hoje e não entraria (régua do Bruno: nenhum número no
-- painel sem SQL demonstrável). Os índices que sustentam os agregados já existem:
-- idx_tickets_status_created (fila, série de 7 dias, média de resolução) e
-- idx_dev_projects_status_updated (contagem + os 5 recentes).
--
-- POR QUE CHAVE PRÓPRIA E NÃO REUSO DE 'chamados' (decisão travada do Bruno, 30/07/2026):
-- o painel agrega DOIS domínios (chamados + projetos). Gatear por 'chamados' entregaria
-- contagem e nomes de PROJETOS a quem só atende a fila; exigir as duas chaves esconderia o
-- painel de quem tem só uma. A casa já tem o precedente de painel por módulo com chave
-- própria — 'office_dashboard' — daí o nome 'dev_dashboard' (e não 'painel_dev').
--
-- O INSERT existe pra CHAVE VIVER NO UNIVERSO da tela Permissões (que é a UNIÃO dos
-- conjuntos dos papéis). O admin não precisa da linha (bypass por JWT no requirePermission)
-- — sem ela, porém, a chave não aparece em tela nenhuma e ninguém consegue concedê-la.
-- Mesmo movimento das migrations 013 ('projetos') e 012 (helpdesk).
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING — re-execução é no-op. Guarda de pré-requisito
-- abaixo confere que as fontes de leitura existem: sem tickets/dev_projects o painel não
-- teria de onde tirar número nenhum, e a chave nasceria prometendo o que não há.
-- Rodar na validação (branch Neon) antes de promover.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — a matriz RBAC não foi encontrada.';
  END IF;
  IF to_regclass('public.tickets') IS NULL THEN
    RAISE EXCEPTION 'tickets ausente (migration 012) — o painel não teria fonte de fila.';
  END IF;
  IF to_regclass('public.dev_projects') IS NULL THEN
    RAISE EXCEPTION 'dev_projects ausente (migration 013) — o painel não teria fonte de projetos.';
  END IF;
END $$;

INSERT INTO role_permissions (role, page_key) VALUES ('admin', 'dev_dashboard')
ON CONFLICT DO NOTHING;

COMMIT;
