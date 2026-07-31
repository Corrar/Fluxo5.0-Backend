-- 018_dev_repos.sql — Fluxo Royale 5.0
-- RELATÓRIO DE TRABALHO EM CÓDIGO: espelho local dos commits do GitHub, por período.
--
-- O DESENHO EM UMA FRASE: o GitHub é a FONTE, este banco é o ESPELHO. A tela nunca fala com o
-- GitHub — lê daqui. Isso é o que faz a feature sobreviver a token expirado, rate limit e API
-- fora do ar: a falha externa vira um CARIMBO ("sincronizado em X", "última sync falhou"), não
-- uma tela quebrada. É a mesma disciplina do resto da casa: dado autoritativo no nosso banco,
-- integração externa como alimentação, jamais como dependência de render.
--
-- DECISÕES TRAVADAS (Bruno, 31/07/2026):
--   • REPOS EM TABELA, não em env/constante: o Bruno cadastra e desativa sem deploy. Seed com os
--     7 de hoje só pra tela não nascer vazia — a tabela é a fonte, o seed é conveniência.
--   • v1 = COMMITS + MENSAGEM por período. SEM diff/stats/arquivos (v2): cada um desses é uma
--     chamada extra POR COMMIT na API do GitHub, e o custo/rate-limit disso não se justifica
--     antes de alguém pedir o número.
--   • Vínculo com chamado/máquina por menção (TI-n, MAQ-n) é V2 — hoje ninguém escreve o
--     identificador na mensagem, então o vínculo nasceria vazio e pareceria quebrado.
--   • Sync MANUAL (botão) na v1; cron é v2. Branch default só.
--   • Presets 7/30/60 dias são AÇÚCAR DO FRONT sobre ?from=&to= — o backend só conhece intervalo.
--
-- ADITIVA E IDEMPOTENTE: CREATE ... IF NOT EXISTS + ON CONFLICT DO NOTHING. Re-execução é no-op.
-- Rodar na validação (branch Neon ep-summer-wave) antes de promover.

BEGIN;

-- Guardas de pré-requisito: falhar aqui, alto e claro, é melhor que criar meia estrutura.
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — a matriz RBAC não foi encontrada.';
  END IF;
END $$;

-- =====================================================================
-- 1. OS REPOSITÓRIOS (cadastro dinâmico + memória da última sync)
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_repos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  -- Identidade real do repo no GitHub. UNIQUE aqui é o que faz o cadastro duplicado virar 409
  -- na borda em vez de dois espelhos concorrentes do mesmo repositório.
  CONSTRAINT dev_repos_owner_name_key UNIQUE (owner, name),
  -- Desativar > excluir: repo inativo some do sync-all e do relatório, mas o espelho fica.
  -- É a saída oferecida pelo 409 do DELETE (mesmo padrão de impressora/usuário).
  active            BOOLEAN NOT NULL DEFAULT true,
  last_synced_at    TIMESTAMPTZ NULL,
  -- 'nunca' é estado LEGÍTIMO e diferente de 'erro': repo recém-cadastrado não falhou, só não
  -- rodou ainda. A tela diz "sincronize primeiro" num caso e mostra o erro no outro.
  last_sync_status  TEXT NOT NULL DEFAULT 'nunca'
                      CHECK (last_sync_status IN ('nunca','ok','erro')),
  last_sync_error   TEXT NULL,
  -- NULL de propósito nos 7 do seed: eles nasceram de MIGRATION, não de gente. Preencher com o
  -- admin fingiria uma autoria que não houve — e o dia em que alguém auditar "quem cadastrou
  -- este repo?", NULL responde a verdade ("o sistema, na 018").
  created_by        UUID NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dev_repos IS
  'Repositórios GitHub espelhados (módulo Dev › Repositórios). Cadastro dinâmico: o Bruno adiciona/desativa sem deploy.';
COMMENT ON COLUMN dev_repos.last_sync_status IS
  'nunca | ok | erro. "nunca" é estado legítimo (cadastrado, ainda não sincronizado) e NÃO é falha — a tela distingue os dois.';
COMMENT ON COLUMN dev_repos.last_sync_error IS
  'Mensagem da última falha, truncada em 500 no controller. Preservada mesmo com o espelho intacto — o erro é do TRANSPORTE, não do dado.';
COMMENT ON COLUMN dev_repos.created_by IS
  'NULL = semeado pela migration 018 (não houve gente). Preenchido com o id de quem cadastrou pela tela.';

-- =====================================================================
-- 2. O ESPELHO (commits)
-- =====================================================================
-- PK COMPOSTA (repo_id, sha) e NÃO um id próprio: o sha já identifica o commit, mas só DENTRO
-- do repo — dois repositórios podem legitimamente conter o mesmo sha (fork, cherry-pick, um
-- histórico copiado). PK composta deixa isso explícito no schema E é exatamente o alvo do
-- ON CONFLICT DO NOTHING que torna a re-sincronização idempotente: sincronizar duas vezes o
-- mesmo período não duplica uma linha sequer.
CREATE TABLE IF NOT EXISTS repo_commits (
  repo_id      UUID NOT NULL REFERENCES dev_repos(id),
  sha          TEXT NOT NULL,
  message      TEXT NOT NULL,
  -- DEFAULT '' e não NULL: commit sem autor identificado no payload é raro mas acontece
  -- (autor sem conta vinculada). '' exibe vazio; NULL exigiria coalesce em toda leitura.
  author_name  TEXT NOT NULL DEFAULT '',
  -- A data do COMMIT (author_date do GitHub), não a da sincronização — é ela que define em
  -- qual período o trabalho caiu. Confundir as duas faria todo commit velho aparecer como
  -- "trabalho de hoje" na primeira sync.
  author_date  TIMESTAMPTZ NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, sha)
);

-- O relatório lê exatamente assim: por repo, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_repo_commits_repo_date
  ON repo_commits (repo_id, author_date DESC);

COMMENT ON TABLE repo_commits IS
  'ESPELHO local dos commits do GitHub. Não é domínio: é cache alimentado pela sync. PK (repo_id, sha) — sha só é único por repo.';
COMMENT ON COLUMN repo_commits.author_date IS
  'Data do COMMIT (author_date da API), não da sincronização — é ela que decide o período no relatório.';
COMMENT ON COLUMN repo_commits.synced_at IS
  'Quando esta linha entrou no espelho. Diagnóstico da integração, nunca critério de período.';

-- =====================================================================
-- 3. SEED DOS 7 REPOS DE HOJE
-- =====================================================================
-- ON CONFLICT DO NOTHING: re-execução não escreve nada, e repo que o Bruno já tiver cadastrado
-- pela tela (mesmo owner/name) é preservado como está — a migration não sobrescreve gente.
INSERT INTO dev_repos (owner, name) VALUES
  ('Corrar', 'Fluxo5.0-Front'),
  ('Corrar', 'Fluxo5.0-Backend'),
  ('Corrar', 'Emissao-de-notas-API'),
  ('Corrar', 'Fluxo-Royale-Frontend'),
  ('Corrar', 'Fluxo-Royale-Backend'),
  ('Corrar', 'Homolog-FluxoFront'),
  ('Corrar', 'Homolog-FluxoBack')
ON CONFLICT (owner, name) DO NOTHING;

-- =====================================================================
-- 4. RBAC — a chave nova
-- =====================================================================
-- 'dev_repos' nasce concedida SÓ ao admin. A tela de Permissões pode conceder a outro papel
-- depois sem tocar em código (mesmo caminho de 'chamados', 'projetos' e 'dev_dashboard').
INSERT INTO role_permissions (role, page_key) VALUES ('admin', 'dev_repos')
ON CONFLICT DO NOTHING;

COMMIT;
