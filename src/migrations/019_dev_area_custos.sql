-- 019_dev_area_custos.sql — Fluxo Royale 5.0
-- ÁREA DEV (agenda, notas, snippets) + CUSTOS & SERVIÇOS: as duas últimas telas do módulo Dev
-- deixam de ser mock cadeado e ganham banco.
--
-- O DESENHO EM UMA FRASE: são ferramentas PESSOAIS do desenvolvedor — não domínio da fábrica.
-- Por isso nada aqui tem workflow, aprovação ou máquina de estados: o dono cria, edita e
-- apaga. A régua da casa que continua valendo é a outra, a que importa: nenhum número na tela
-- sem uma query atrás. Foi ela que matou 70% do desenho no grupo 2f e é ela que decide, aqui,
-- o que NÃO nasceu (ver DÍVIDAS no fim deste cabeçalho).
--
-- DECISÕES TRAVADAS (Bruno, 03/08/2026):
--   • BLOCO ÚNICO para agenda: `dev_area_blocks` guarda EVENTO e TAREFA na mesma tabela, com
--     `kind` separando. Duas tabelas quase idênticas custariam dois CRUDs, dois smokes e uma
--     união em toda leitura de dia — para uma diferença que é de APRESENTAÇÃO (a tarefa tem
--     caixinha de concluída, o evento tem hora). `done` só faz sentido em 'tarefa', e isso é
--     regra de tela, não do schema: um evento com done=false é inofensivo.
--   • HORA OPCIONAL de propósito: tarefa costuma não ter hora ("hoje eu preciso fazer X") e
--     evento costuma ter. NOT NULL em start_t obrigaria a inventar 00:00 para toda tarefa —
--     e 00:00 é uma AFIRMAÇÃO falsa ("é à meia-noite"), não uma ausência.
--   • CHECK de coerência (end_t > start_t) tolera os dois NULLs: sem hora não há intervalo a
--     validar. É o CHECK que impede o bloco impossível de existir no banco, e não só na borda.
--   • CUSTO SEM HISTÓRICO na v1: `dev_costs` é a FOTO do que se paga hoje. Delta mensal e série
--     histórica exigiriam meses de dado que ainda não existem — inventá-los seria a mentira que
--     a régua proíbe. Quando houver meses, nasce a tabela de competência (dívida registrada).
--   • total_mensal NÃO é coluna: é CÁLCULO no GET, uma fonte de verdade só (ver o controller).
--     Materializar o total criaria a chance clássica de ele divergir das linhas que o somam.
--
-- ADITIVA E IDEMPOTENTE: CREATE ... IF NOT EXISTS + ON CONFLICT DO NOTHING. Re-execução é no-op.
-- Rodar na validação (branch Neon ep-summer-wave) antes de promover.
--
-- DÍVIDAS QUE ESTA MIGRATION NÃO PAGA (decisão, não esquecimento):
--   • Sync com Google Agenda — era SIMULADO no design. Integração externa real é missão própria.
--   • Monitoramento vivo de uso (CPU/RAM/tokens) — não temos coletor. Vira `usage_note`, texto
--     livre escrito por gente, que é honesto sobre ser uma anotação e não uma medição.
--   • Histórico mensal / delta do Custos — sem meses de dado, todo gráfico seria ficção.

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
-- 1. AGENDA — eventos e tarefas do dia
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_area_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'evento' tem hora e acontece; 'tarefa' é um item que se conclui. Mesma tabela porque a
  -- diferença é de apresentação — ver o cabeçalho.
  kind        TEXT NOT NULL CHECK (kind IN ('evento','tarefa')),
  day         DATE NOT NULL,
  -- NULL legítimo: tarefa sem hora marcada. Ver decisão travada no cabeçalho.
  start_t     TIME NULL,
  end_t       TIME NULL,
  -- O bloco impossível não existe no banco, não só na borda. Os NULLs passam de propósito:
  -- sem hora não há intervalo a validar.
  CONSTRAINT dev_area_blocks_horario_coerente
    CHECK (end_t IS NULL OR start_t IS NULL OR end_t > start_t),
  category    TEXT NOT NULL CHECK (category IN ('reuniao','estudo','trabalho','foco')),
  title       TEXT NOT NULL,
  -- Só significa alguma coisa em 'tarefa'. Num evento fica false e é inofensivo — a tela é
  -- quem decide mostrar a caixinha.
  done        BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A leitura real é sempre por PERÍODO e em ordem de dia/hora — a visão mês pede o range
-- inteiro numa chamada. O índice é exatamente esse acesso.
CREATE INDEX IF NOT EXISTS idx_dev_area_blocks_day_start
  ON dev_area_blocks (day, start_t);

COMMENT ON TABLE dev_area_blocks IS
  'Agenda pessoal do dev (módulo Dev › Área Dev). Evento e tarefa na mesma tabela — `kind` separa; a diferença é de apresentação.';
COMMENT ON COLUMN dev_area_blocks.start_t IS
  'NULL legítimo: tarefa sem hora. NOT NULL obrigaria a inventar 00:00, que afirma "meia-noite" em vez de "sem hora".';
COMMENT ON COLUMN dev_area_blocks.done IS
  'Só tem sentido em kind=tarefa. Em evento fica false e é inofensivo — regra de tela, não de schema.';
COMMENT ON CONSTRAINT dev_area_blocks_horario_coerente ON dev_area_blocks IS
  'Fim depois do início quando ambos existem. Tolera os NULLs: sem hora não há intervalo.';

-- =====================================================================
-- 2. NOTAS
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  body        TEXT NOT NULL,
  -- text[] e não tabela de junção: tag aqui é RÓTULO LIVRE de uso pessoal, sem entidade, sem
  -- renomear-em-cascata, sem contagem global. A junção pagaria por um problema que não existe.
  tags        TEXT[] NOT NULL DEFAULT '{}',
  -- '' = sem cor escolhida. DEFAULT '' e não NULL para que toda leitura receba string.
  color       TEXT NOT NULL DEFAULT '',
  pinned      BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dev_notes IS
  'Notas do dev (módulo Dev › Área Dev). Fixar, marcar e colorir são atributos da nota — não há workflow.';
COMMENT ON COLUMN dev_notes.tags IS
  'Rótulos livres. text[] de propósito: sem entidade, sem cascata, sem contagem global — a junção pagaria por um problema inexistente.';
COMMENT ON COLUMN dev_notes.color IS
  'Cor escolhida na tela; '''' = nenhuma. DEFAULT '''' para que toda leitura receba string.';

-- =====================================================================
-- 3. SNIPPETS
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_snippets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT NOT NULL,
  code        TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES users(id),
  -- SEM updated_at: snippet não se edita na v1 (cria e apaga). Uma coluna que nunca muda
  -- mentiria sobre a existência de uma edição que a API não oferece.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dev_snippets IS
  'Trechos de código guardados pelo dev (módulo Dev › Área Dev). Busca por rótulo E por conteúdo.';
COMMENT ON COLUMN dev_snippets.code IS
  'O trecho em si. A busca ?q= varre label E code — quem procura "pool.query" quer achar pelo conteúdo.';

-- =====================================================================
-- 4. CUSTOS & SERVIÇOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_costs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('infra','banco','ia','saas','outros')),
  -- numeric(12,2) e NUNCA float: dinheiro somado em ponto flutuante acumula erro, e este
  -- valor é somado em TODA leitura do total. O driver devolve numeric como STRING — é isso
  -- que faz o total chegar exato na tela e no smoke.
  value         NUMERIC(12,2) NOT NULL CHECK (value > 0),
  cycle         TEXT NOT NULL CHECK (cycle IN ('mensal','anual','variavel')),
  -- 'atencao' é sinal do DONO ("olhar isso"), não estado calculado. Nada no sistema promove
  -- um custo a 'atencao' sozinho — se promovesse, seria um número sem query atrás.
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','atencao')),
  next_billing  DATE NULL,
  -- O que sobrou do "monitoramento vivo de uso" do design: texto escrito por gente. Honesto
  -- sobre ser ANOTAÇÃO e não medição — não temos coletor de CPU/RAM/tokens.
  usage_note    TEXT NOT NULL DEFAULT '',
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dev_costs IS
  'Serviços pagos e seus custos (módulo Dev › Custos & Serviços). FOTO do que se paga hoje — sem histórico na v1.';
COMMENT ON COLUMN dev_costs.value IS
  'numeric(12,2), nunca float: é somado em toda leitura do total. O driver entrega como string — o total chega exato.';
COMMENT ON COLUMN dev_costs.cycle IS
  'mensal | anual | variavel. O total mensal normaliza: mensal cheio + anual/12 + variavel cheio (cálculo no GET, uma fonte só).';
COMMENT ON COLUMN dev_costs.status IS
  'ok | atencao. Sinal do DONO, não estado calculado — nada promove um custo a atencao sozinho.';
COMMENT ON COLUMN dev_costs.usage_note IS
  'Anotação de uso escrita por gente. O "monitoramento vivo" do design não nasceu: não há coletor, e número sem fonte não entra.';

-- =====================================================================
-- 5. RBAC — as chaves novas
-- =====================================================================
-- Nascem concedidas SÓ ao admin. A tela de Permissões concede a outro papel depois, sem
-- deploy (mesmo caminho de 'chamados', 'projetos', 'dev_dashboard' e 'dev_repos').
-- Chaves-FOLHA com underscore: o requirePermission casa por igualdade e a expansão por
-- prefixo do front é delimitada por ':' — 'dev_area' não abre nem é aberta por nada.
INSERT INTO role_permissions (role, page_key) VALUES
  ('admin', 'dev_area'),
  ('admin', 'dev_custos')
ON CONFLICT DO NOTHING;

COMMIT;
