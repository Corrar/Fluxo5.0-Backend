-- 013_dev_projects.sql — Fluxo Royale 5.0
-- DEV-PROJETOS v1: projetos internos do time de desenvolvimento (dev_projects).
--
-- POR QUE TABELA NOVA E NÃO REUSO DE `tasks` (decisão travada do Bruno, 29/07/2026):
-- `tasks` é o Quadro de TAREFAS DE PRODUÇÃO (futuro) — amarrado a OP por design, com o
-- ciclo mover/concluir. dev-projetos é OUTRO domínio: projetos internos do dev, GRADE de
-- cartões com checklists nomeados e progresso DERIVADO — não é kanban. Reusar a mesma
-- tabela faria os dois quadros brigarem pelo mesmo dado e herdaria a bagagem conhecida de
-- `tasks` (status morto sem CHECK, completed/completed_at inexistentes — mover = 500,
-- gate fora do padrão, colunas sem destino). `tasks` fica INTOCADA para o Quadro.
--
-- OP é OPCIONAL (decisão travada): client_service_id uuid NULL — projeto pode nascer
-- livre e ganhar/perder vínculo depois. O controller resolve op_code → client_services.id
-- validando SÓ EXISTÊNCIA (sem guard de status de OP — a validação de OP encerrada do
-- tasks compara strings que nem existem no banco; não repetir o guard fantasma, dívida
-- registrada em DIVIDAS.md).
--
-- CICLO DE VIDA (grade, sem máquina de estados): status ativo|arquivado, transição LIVRE
-- nos dois sentidos pelo PUT (arquivar é a ação primária da tela; excluir é hard delete
-- com confirm — ferramenta interna). O CHECK trava o universo; não há guard de transição
-- de propósito (não é tickets: arquivar/reativar não tem efeito colateral).
--
-- checklists: MÚLTIPLOS e nomeados num jsonb só — [{titulo, itens: [{t, done}]}] — o
-- shape do mock. Validação fica na BORDA do controller (estrutura, limites); o banco
-- garante só NOT NULL + array default.
--
-- PAGE_KEY 'projetos' NA MIGRATION: o INSERT em role_permissions ('admin','projetos')
-- existe pra CHAVE VIVER NO UNIVERSO da tela Permissões (que é a UNIÃO dos conjuntos dos
-- papéis) e ser concedível a outros papéis por lá. O admin em si não precisa da linha
-- (bypass por JWT no requirePermission) — sem ela, porém, a chave não aparece em tela
-- nenhuma e ninguém consegue concedê-la (a dívida do universo-união, registrada no front).
--
-- FORA DA v1 (decisões travadas): capa/anexos (dívida de storage — nunca base64), tags,
-- due_date. Sem socket (ferramenta de uma pessoa hoje; evento seria ruído).
--
-- ADITIVA E IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- Rodar de novo é no-op. Rodar em branch Neon (validação) antes de promover.

BEGIN;

-- Guardas de pré-requisito: as tabelas referenciadas vivem no schema base.
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.client_services') IS NULL THEN
    RAISE EXCEPTION 'client_services ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — a matriz RBAC não foi encontrada.';
  END IF;
END $$;

-- =====================================================================
-- O PROJETO INTERNO DO DEV
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  priority          TEXT NOT NULL DEFAULT 'media'
                      CHECK (priority IN ('baixa','media','alta')),
  -- Grade, não kanban: ativo|arquivado, transição livre (sem máquina — ver cabeçalho).
  status            TEXT NOT NULL DEFAULT 'ativo'
                      CHECK (status IN ('ativo','arquivado')),
  -- Cor do CARTÃO (apresentação). Allowlist sã vive na borda do controller.
  color             TEXT NOT NULL DEFAULT 'blue',
  -- [{titulo, itens: [{t, done}]}] — múltiplos checklists nomeados; progresso é DERIVADO
  -- (itens done/total), nunca coluna. Estrutura e limites validados na borda.
  checklists        JSONB NOT NULL DEFAULT '[]',
  -- Vínculo OPCIONAL com OP (client_services é o eixo per-OP de todo o sistema).
  -- NULL = projeto livre. Resolvido por op_code no controller (só existência).
  client_service_id UUID REFERENCES client_services(id),
  -- FK NO ACTION: usuário com projetos não sai por hard-delete (família audit/tickets).
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A GRADE (GET /dev-projects?status=): por status, mexidos mais recentemente primeiro.
CREATE INDEX IF NOT EXISTS idx_dev_projects_status_updated
  ON dev_projects (status, updated_at DESC);

-- A chave no universo da tela Permissões (ver cabeçalho — admin nem precisa, mas a chave
-- precisa existir em ALGUM papel pra ser visível/concedível).
INSERT INTO role_permissions (role, page_key) VALUES ('admin', 'projetos')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE dev_projects IS
  'Projetos internos do time dev (dev-projetos v1). GRADE com checklists nomeados — não é kanban, não é o Quadro de Tarefas (tasks fica intocada). OP opcional via client_service_id.';
COMMENT ON COLUMN dev_projects.status IS
  'ativo|arquivado — transição LIVRE pelo PUT (sem máquina; arquivar é a ação primária da tela).';
COMMENT ON COLUMN dev_projects.checklists IS
  'Múltiplos checklists nomeados: [{titulo, itens: [{t, done}]}]. Progresso é derivado, validação na borda do controller.';
COMMENT ON COLUMN dev_projects.client_service_id IS
  'Vínculo OPCIONAL com OP (resolvido por op_code; só existência — sem guard de status de OP).';

COMMIT;
