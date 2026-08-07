-- 021_op_status_vocab.sql — Fluxo Royale 5.0
-- FECHA O VOCABULÁRIO DE STATUS DA OP. Decisão do Bruno (07/08/2026, opção 1 do recon):
-- `pendente` SAI. O vocabulário de `client_services.status` passa a ser, no banco e não só na
-- convenção, exatamente DOIS valores: 'em_andamento' | 'concluido'.
--
-- ── O QUE O RECON DE 07/08 MEDIU (e por que isto não é cosmética) ────────────────────────────
-- A coluna era `character varying`, NULLABLE, DEFAULT 'pendente', SEM CHECK e SEM enum. Ou seja:
-- o vocabulário real tinha QUATRO estados possíveis, não três — o quarto sendo NULL. E os dois
-- únicos caminhos de escrita produziam justamente os dois estados que ninguém queria:
--
--   createService  -> o INSERT não mencionava a coluna, então TODA OP criada pela tela nascia
--                     'pendente'. "pendente tem zero linhas" era foto de um banco semeado por
--                     SQL (as 7 OPs da validação são todas do seed de 21/07), não propriedade
--                     do sistema: a próxima OP cadastrada na tela entraria como 'pendente'.
--   updateServiceStatus -> UPDATE de string livre, sem whitelist. `{"status":"banana"}` gravava
--                     banana; corpo vazio gravava NULL (o node-postgres converte undefined em
--                     null e a coluna aceitava).
--
-- Nenhum dos dois aparecia na tela: o front normaliza qualquer valor desconhecido para
-- "Em andamento" (opStatusOf) e trata NULL como ativo (adaptClient). O dado divergia em silêncio.
--
-- ── POR QUE A GUARDA DE PREMISSA EXISTE SE A VALIDAÇÃO ESTÁ LIMPA ───────────────────────────
-- Medido hoje na validação: em_andamento 5, concluido 2, pendente 0, NULL 0. O backfill abaixo
-- não move uma linha AQUI. Ele não é para hoje: é para a CARGA do 2.0, onde `pendente` é o
-- estado ATIVO (18 OPs em ep-mute-feather) e a mesma palavra significa o oposto do que
-- significaria aqui. A guarda garante que a migration só fecha o vocabulário quando souber
-- traduzir TUDO o que encontrou — e aborta alto, sem gravar nada, diante de qualquer palavra
-- que ela não conheça. Preferimos o deploy travado a um CHECK que descarta linha.
--
-- ORDEM OBRIGATÓRIA (e é por isso que tudo mora numa transação só):
--   1. guarda   — existe status fora de (em_andamento, concluido, pendente, NULL)? aborta.
--   2. backfill — pendente -> em_andamento; NULL -> em_andamento.
--   3. trava    — SET DEFAULT 'em_andamento', SET NOT NULL, CHECK da lista fechada.
-- Invertida, a trava barraria as próprias linhas que o backfill existe para consertar.
--
-- A TRADUÇÃO É IRREVERSÍVEL E DELIBERADA: depois daqui não há como distinguir uma OP que era
-- 'pendente' de uma que já era 'em_andamento'. Isso é o que a decisão pediu — 'pendente' não
-- significava nada distinto em lugar nenhum do sistema (nenhuma query, nenhuma tela, nenhum
-- guard olhava para ele). Se um dia "OP planejada" virar conceito real, ela nasce como estado
-- NOVO e explícito, com transição própria, não ressuscitando esta palavra.
--
-- ADITIVA E IDEMPOTENTE: o backfill só escreve onde o valor difere e o CHECK só é criado se não
-- existir. Re-execução é no-op. NÃO derruba coluna, NÃO apaga linha.
--
-- Rodar na validação (branch Neon ep-summer-wave) ANTES ou JUNTO do deploy do backend novo.
-- A ordem entre os dois é indiferente aqui, e isso é de propósito: o código novo grava
-- 'em_andamento' explícito (que o schema velho aceita) e a whitelist da borda recusa tudo o que
-- o CHECK recusaria (que o schema velho também aceita). Nenhuma das duas metades depende da
-- outra para não quebrar — só juntas é que fecham o furo dos dois lados.

BEGIN;

-- Guarda de pré-requisito: falhar aqui, alto e claro, é melhor que meia estrutura.
DO $$
BEGIN
  IF to_regclass('public.client_services') IS NULL THEN
    RAISE EXCEPTION 'client_services ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- 1. GUARDA DE PREMISSA — só traduz o que conhece
-- =====================================================================
-- Padrão ratificado no DROP da 014 e no backfill da 020: a premissa é declarada, conferida, e a
-- migration ABORTA em vez de seguir com ela falsa. Aqui a premissa é "todo status existente é
-- em_andamento, concluido, pendente ou NULL". Qualquer outra palavra é dado que ninguém previu
-- (typo gravado pelo UPDATE sem whitelist, valor de um import, estado de um fluxo que não
-- conhecemos) e a decisão de como traduzi-la é do Bruno, não desta migration.
--
-- A mensagem lista as palavras encontradas: sem isso, quem toma o erro no dia da carga precisa
-- ir ao banco descobrir o que aconteceu.
DO $$
DECLARE
  fora   BIGINT;
  quais  TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT quote_literal(status), ', ' ORDER BY quote_literal(status))
    INTO fora, quais
    FROM client_services
   WHERE status IS NOT NULL
     AND status NOT IN ('em_andamento', 'concluido', 'pendente');

  IF fora > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % linha(s) de client_services com status fora do vocabulário conhecido (%). '
      'A tradução de cada uma é decisão de produto — nada foi alterado.', fora, quais;
  END IF;

  RAISE NOTICE 'guarda de premissa OK — nenhum status desconhecido em client_services.';
END $$;

-- =====================================================================
-- 2. BACKFILL — pendente -> em_andamento, NULL -> em_andamento
-- =====================================================================
-- `pendente` no 2.0 é o estado ATIVO (não "planejada"): a tradução correta é em_andamento, e é
-- a mesma para o NULL, que só existe como acidente do PATCH de corpo vazio (nunca significou
-- "planejada" — o front sempre o exibiu como "Em andamento").
-- `IS DISTINCT FROM` no WHERE de cima já é garantido pelo próprio filtro; o NOTICE conta o que
-- moveu para que a linha do log da carga diga quantas OPs foram traduzidas.
DO $$
DECLARE
  n_pend BIGINT;
  n_null BIGINT;
BEGIN
  UPDATE client_services SET status = 'em_andamento' WHERE status = 'pendente';
  GET DIAGNOSTICS n_pend = ROW_COUNT;

  UPDATE client_services SET status = 'em_andamento' WHERE status IS NULL;
  GET DIAGNOSTICS n_null = ROW_COUNT;

  RAISE NOTICE 'backfill: % linha(s) pendente -> em_andamento, % linha(s) NULL -> em_andamento.',
    n_pend, n_null;
END $$;

-- =====================================================================
-- 3. A TRAVA — DEFAULT, NOT NULL e a lista fechada
-- =====================================================================
-- DEFAULT muda de 'pendente' para 'em_andamento'. Isto é a rede, não o mecanismo: o
-- createService passa a gravar o valor EXPLICITAMENTE no mesmo commit. Depender do DEFAULT foi
-- exatamente o que deixou a dívida nascer, então os dois lados são consertados — se um dia
-- alguém escrever um INSERT novo e esquecer a coluna, cai em cima do valor certo.
ALTER TABLE client_services ALTER COLUMN status SET DEFAULT 'em_andamento';

-- NOT NULL fecha o quarto estado. Sem isto o CHECK não basta: em Postgres, CHECK com NULL
-- avalia UNKNOWN e a linha PASSA — o `{}` no PATCH continuaria gravando NULL e continuaria
-- sendo exibido como "Em andamento". As duas travas são necessárias, nenhuma sozinha resolve.
ALTER TABLE client_services ALTER COLUMN status SET NOT NULL;

-- O CHECK é o BACKSTOP, não a validação primária: quem recusa palavra inválida com mensagem
-- decente é a whitelist do updateServiceStatus (que espelha esta lista exatamente). Este CHECK
-- existe para o caminho que não passa pela borda — script de carga, psql, correção manual.
-- Idempotente pelo lookup em pg_constraint (mesmo padrão do qty_reserved_nonneg da 020).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_services_status_chk') THEN
    ALTER TABLE client_services
      ADD CONSTRAINT client_services_status_chk
      CHECK (status IN ('em_andamento', 'concluido'));
  END IF;
END $$;

COMMENT ON COLUMN client_services.status IS
  'Vocabulário FECHADO (021): em_andamento | concluido. NOT NULL + CHECK. '
  '''pendente'' saiu do vocabulário em 07/08/2026 — era o DEFAULT antigo e o estado ATIVO do '
  '2.0; a carga traduz pendente -> em_andamento. Escrita só por POST /clients/:id/services '
  '(grava em_andamento explícito) e PATCH /clients/services/:id/status (whitelist na borda).';

COMMIT;
