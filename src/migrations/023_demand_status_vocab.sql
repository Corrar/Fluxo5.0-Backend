-- 023_demand_status_vocab.sql — Fluxo Royale 5.0
-- FECHA O VOCABULÁRIO DE STATUS DA DEMANDA 3D. Irmã direta da 021: mesmo furo, outra tabela.
-- `demands_3d.status` passa a ser, no banco e não só na convenção, exatamente SEIS valores:
--   'Em análise' | 'Aceita' | 'Em desenvolvimento' | 'Concluída' | 'Rejeitada' | 'Cancelada'
--
-- ⚠ O NÚMERO 022 FOI PULADO DE PROPÓSITO. `022_hr_core.sql` pertence à leva do RH, que está na
--   árvore de trabalho e AINDA NÃO FOI COMMITADA. Reusar o 022 aqui criaria duas migrations
--   diferentes com o mesmo número no dia em que aquela leva entrar — e o conflito apareceria no
--   pior lugar possível, que é a ordem de aplicação num banco novo. O pulo é a escolha barata.
--
-- ── POR QUE ESTA MIGRATION EXISTE (achado do lote I-b, 12/08/2026) ──────────────────────────
-- A coluna é `character varying`, NULLABLE, DEFAULT 'Em análise', SEM CHECK. É EXATAMENTE o
-- desenho que a 021 encontrou em client_services.status, com a mesma consequência: o vocabulário
-- real tem SETE estados, não seis — o sétimo sendo NULL.
--
-- O lote I-b fechou a BORDA (whitelist TRANSICOES_DEMANDA em producao3d.controller, fail-closed:
-- status atual fora do vocabulário recusa a transição em vez de adivinhar). Mas borda não é
-- schema: um INSERT de script de carga, um psql, uma correção manual — nenhum passa pela
-- whitelist. E o custo do NULL aqui é maior que em client_services, porque uma demanda de status
-- NULL fica IMÓVEL: a whitelist, sendo fail-closed, recusa toda transição dela. A peça some do
-- fluxo sem sumir do banco.
--
-- A defesa que o I-b já plantou no código e que esta migration torna desnecessária:
-- `cancelarDemandasDaRequest` usa `IS DISTINCT FROM 'Concluída'` em vez de `<>` justamente porque
-- `<>` com NULL avalia UNKNOWN e a demanda escaparia do cancelamento. Depois desta migration o
-- `IS DISTINCT FROM` vira redundante — e FICA, porque redundância de guarda não custa nada e
-- reverter aquilo exigiria confiar que esta migration rodou em todo banco.
--
-- ── MEDIDO ANTES DE ESCREVER ────────────────────────────────────────────────────────────────
-- Validação (ep-summer-wave), 12/08/2026: demands_3d com ZERO linhas — os smokes do I-b limparam
-- tudo pela destruição escopada. O backfill abaixo não move uma linha HOJE. Ele existe pelo mesmo
-- motivo do backfill da 021: pela CARGA do 2.0 e por qualquer banco que já tenha rodado o sistema.
-- Preferimos o deploy travado a um CHECK que descarta linha.
--
-- ORDEM OBRIGATÓRIA (por isso tudo mora numa transação só):
--   1. guarda   — existe status fora do vocabulário conhecido (ou NULL)? aborta nomeando.
--   2. backfill — NULL -> 'Em análise'.
--   3. trava    — SET NOT NULL + CHECK da lista fechada. (DEFAULT já é 'Em análise'.)
-- Invertida, a trava barraria as próprias linhas que o backfill existe para consertar.
--
-- POR QUE NULL -> 'Em análise' É A TRADUÇÃO CERTA: 'Em análise' é o DEFAULT da coluna, ou seja o
-- estado em que toda demanda nasce. Uma linha com status NULL só pode ter chegado ali por escrita
-- que ignorou o DEFAULT — nunca por um fluxo que quisesse dizer outra coisa, porque nenhum código
-- do sistema jamais gravou NULL aqui de propósito. Traduzir para o estado inicial devolve a
-- demanda ao fluxo (ela volta a ser movível pela whitelist) sem inventar progresso que ela não
-- teve. O caminho oposto — deixá-la fora do vocabulário — a manteria imóvel para sempre.
--
-- ADITIVA E IDEMPOTENTE: o backfill só escreve onde o valor é NULL e o CHECK só é criado se não
-- existir. Re-execução é no-op. NÃO derruba coluna, NÃO apaga linha.
--
-- Rodar na validação (branch Neon ep-summer-wave) ANTES ou JUNTO do deploy. A ordem é indiferente:
-- o código do I-b já grava só valores do vocabulário e a whitelist da borda recusa tudo o que este
-- CHECK recusaria. Nenhuma metade depende da outra para não quebrar — juntas é que fecham o furo.

BEGIN;

-- Guarda de pré-requisito: falhar aqui, alto e claro, é melhor que meia estrutura.
DO $$
BEGIN
  IF to_regclass('public.demands_3d') IS NULL THEN
    RAISE EXCEPTION 'demands_3d ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- 1. GUARDA DE PREMISSA — só trava o que conhece
-- =====================================================================
-- Padrão ratificado na 014 (DROP), 020 (backfill) e 021. A premissa é "todo status existente
-- pertence ao vocabulário das TRANSICOES_DEMANDA, ou é NULL". Qualquer outra palavra é dado que
-- ninguém previu, e a decisão de como traduzi-la é do Bruno, não desta migration.
-- A mensagem LISTA as palavras encontradas: sem isso, quem toma o erro precisa ir ao banco
-- descobrir o que aconteceu.
DO $$
DECLARE
  fora   BIGINT;
  quais  TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT quote_literal(status), ', ' ORDER BY quote_literal(status))
    INTO fora, quais
    FROM demands_3d
   WHERE status IS NOT NULL
     AND status NOT IN ('Em análise', 'Aceita', 'Em desenvolvimento', 'Concluída', 'Rejeitada', 'Cancelada');

  IF fora > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % linha(s) de demands_3d com status fora do vocabulário conhecido (%). '
      'A tradução de cada uma é decisão de produto — nada foi alterado.', fora, quais;
  END IF;

  RAISE NOTICE 'guarda de premissa OK — nenhum status desconhecido em demands_3d.';
END $$;

-- =====================================================================
-- 2. BACKFILL — NULL -> 'Em análise'
-- =====================================================================
DO $$
DECLARE
  n_null BIGINT;
BEGIN
  UPDATE demands_3d SET status = 'Em análise' WHERE status IS NULL;
  GET DIAGNOSTICS n_null = ROW_COUNT;
  RAISE NOTICE 'backfill: % linha(s) NULL -> ''Em análise''.', n_null;
END $$;

-- =====================================================================
-- 3. A TRAVA — NOT NULL e a lista fechada
-- =====================================================================
-- NOT NULL fecha o sétimo estado. Sem isto o CHECK não basta: em Postgres, CHECK com NULL avalia
-- UNKNOWN e a linha PASSA. As duas travas são necessárias; nenhuma sozinha resolve. (Foi a lição
-- explícita da 021 e vale idêntica aqui.)
ALTER TABLE demands_3d ALTER COLUMN status SET NOT NULL;

-- O DEFAULT já é 'Em análise' — conferido no catálogo em 12/08/2026, não presumido. Reafirmado
-- aqui para que um banco criado por outro caminho (dump antigo, script de carga) não dependa de
-- ter herdado o DEFAULT certo. ALTER ... SET DEFAULT é idempotente por natureza.
ALTER TABLE demands_3d ALTER COLUMN status SET DEFAULT 'Em análise';

-- O CHECK é o BACKSTOP, não a validação primária: quem recusa transição inválida com mensagem
-- decente é a whitelist TRANSICOES_DEMANDA (que espelha esta lista exatamente). Este CHECK existe
-- para o caminho que NÃO passa pela borda — script de carga, psql, correção manual.
-- Idempotente pelo lookup em pg_constraint (padrão da 020/021).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'demands_3d_status_chk') THEN
    ALTER TABLE demands_3d
      ADD CONSTRAINT demands_3d_status_chk
      CHECK (status IN ('Em análise', 'Aceita', 'Em desenvolvimento', 'Concluída', 'Rejeitada', 'Cancelada'));
  END IF;
END $$;

COMMENT ON COLUMN demands_3d.status IS
  'Vocabulário FECHADO (023): Em análise | Aceita | Em desenvolvimento | Concluída | Rejeitada | '
  'Cancelada. NOT NULL + CHECK. As transições permitidas entre eles vivem na whitelist '
  'TRANSICOES_DEMANDA (producao3d.controller, lote I-b) — este CHECK fecha o VOCABULÁRIO, a '
  'whitelist fecha o CAMINHO. Escrita por PUT /producao-3d/demands/:id/status, DELETE da mesma '
  'rota (soft-cancel) e cancelarDemandasDaRequest (morte da solicitação).';

COMMIT;
