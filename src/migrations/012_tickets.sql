-- 012_tickets.sql — Fluxo Royale 5.0
-- HELPDESK v1: CHAMADOS ASSÍNCRONOS (tickets) + TIMELINE DE COMENTÁRIOS (ticket_comments).
--
-- POR QUE DUAS TABELAS NOVAS E NÃO REUSO:
-- `tasks` é kanban sem dono (sem requester/assignee, status livre sem guard) e `dev_tasks` é
-- agenda (start/end_time NOT NULL) com rota nunca montada — nenhuma carrega a semântica de
-- chamado (quem abriu × quem atende × transições vigiadas). O modelo aqui espelha `requests`,
-- o análogo real de ticket do sistema: status TEXT com CHECK + guards de transição INLINE no
-- controller (dentro de transação, lendo o estado atual com FOR UPDATE) + `version` para
-- concorrência otimista + auditoria com action distinta por transição.
--
-- CICLO DE VIDA (linear ESTRITO, decisão travada — sem reabertura; concluído/cancelado é fim
-- de linha, o requester abre chamado NOVO):
--   aberto             -> em_analise (atendente assume: seta assignee_id)
--   em_analise         -> em_desenvolvimento
--   em_desenvolvimento -> concluido (seta closed_at)
--   aberto             -> cancelado (SÓ o requester, SÓ em aberto; seta closed_at)
-- Qualquer outra combinação é 400 no controller — o CHECK daqui só trava o UNIVERSO de
-- valores; a MÁQUINA de estados vive no guard do PUT /tickets/:id/status (padrão
-- updateRequestStatus, onde o efeito colateral de cada transição mora ao lado da validação).
--
-- QUEM ESCREVE/LÊ (v1): qualquer logado ABRE e acompanha os próprios (precedente do
-- POST /requests); só quem tem a page_key 'chamados' ATENDE (fila única, sem roteamento por
-- setor). A description fica NO ticket (não duplica como 1º comentário — uma fonte só).
--
-- display_no: número curto de exibição ("TI-42") — IDENTITY, nunca reciclado. O uuid segue
-- sendo a chave real das rotas; o display_no existe pro olho humano (mesma razão do shortId
-- da Auditoria: uuid inteiro não cabe na linha).
--
-- FORA DA v1 (decisões travadas, registradas em DIVIDAS.md): categorias, anexos (amarrado ao
-- storage de arquivos), prog%, unread/inbox, notificação persistente (a tabela órfã
-- `notifications` segue órfã) — o aviso v1 é SÓ socket ticket_updated pra user:${requester}.
--
-- ADITIVA E IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS, sem tocar em dado existente.
-- Rodar de novo é no-op. Rodar em branch Neon (validação) antes de promover.

BEGIN;

-- Guarda de pré-requisito: users vive no schema base, fora deste versionamento.
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- O CHAMADO
-- =====================================================================
CREATE TABLE IF NOT EXISTS tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Número humano ("TI-42"). IDENTITY: sequencial, único, nunca reciclado — id de exibição,
  -- NUNCA chave de rota (a rota usa o uuid).
  display_no   INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- Quem abriu. NOT NULL: chamado sem dono não existe. FK NO ACTION de propósito: usuário
  -- com chamados não sai por hard-delete (mesma família de audit_logs/requests — o caminho
  -- honesto é suspender a conta).
  requester_id UUID NOT NULL REFERENCES users(id),
  -- Quem atende. NULL = na fila; preenchido quando o atendente assume (aberto -> em_analise).
  assignee_id  UUID REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  -- Escolhida pelo SOLICITANTE na abertura; reclassificável pelo atendente (rota própria,
  -- auditada com {de, para}).
  priority     TEXT NOT NULL DEFAULT 'media'
                 CHECK (priority IN ('baixa','media','alta')),
  status       TEXT NOT NULL DEFAULT 'aberto'
                 CHECK (status IN ('aberto','em_analise','em_desenvolvimento','concluido','cancelado')),
  -- Concorrência otimista (padrão requests): toda transição incrementa.
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Carimbo do fim de linha (concluido OU cancelado). Sustenta o KPI "tempo até resolver".
  closed_at    TIMESTAMPTZ
);

-- A FILA DO ATENDENTE (GET /tickets, filtro ?status=): por status, mais novos primeiro.
CREATE INDEX IF NOT EXISTS idx_tickets_status_created
  ON tickets (status, created_at DESC);

-- MEUS CHAMADOS (GET /tickets/my): tudo do requester, mais novos primeiro.
CREATE INDEX IF NOT EXISTS idx_tickets_requester_created
  ON tickets (requester_id, created_at DESC);

-- =====================================================================
-- A TIMELINE (comentários assíncronos — o "chat" dos mocks, sem tempo real)
-- =====================================================================
CREATE TABLE IF NOT EXISTS ticket_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK NO ACTION: a timeline segura o chamado (histórico não some por baixo do comentário).
  ticket_id  UUID NOT NULL REFERENCES tickets(id),
  -- Requester OU atendente — o "lado" da conversa deriva de quem é (author = requester do
  -- ticket => lado do solicitante), não de coluna própria.
  author_id  UUID NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A timeline de UM chamado, em ordem cronológica (GET /tickets/:id).
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_created
  ON ticket_comments (ticket_id, created_at);

COMMENT ON TABLE tickets IS
  'Helpdesk v1: chamado assíncrono. Qualquer logado abre; page_key ''chamados'' atende (fila única). Máquina de estados no controller (PUT /tickets/:id/status), CHECK só trava o universo.';
COMMENT ON COLUMN tickets.display_no IS
  'Número humano ("TI-42"). IDENTITY nunca reciclado. Exibição apenas — rotas usam o uuid.';
COMMENT ON COLUMN tickets.assignee_id IS
  'NULL = na fila. Setado quando o atendente assume (aberto -> em_analise).';
COMMENT ON COLUMN tickets.version IS
  'Concorrência otimista, padrão requests: toda transição incrementa.';
COMMENT ON COLUMN tickets.closed_at IS
  'Fim de linha (concluido OU cancelado). Base do KPI "tempo até resolver".';
COMMENT ON TABLE ticket_comments IS
  'Timeline do chamado (v1 assíncrono). O lado da conversa deriva do author_id vs requester_id do ticket. Comentar em concluido/cancelado é 409 no controller.';

COMMIT;
