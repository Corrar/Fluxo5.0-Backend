-- 014_drop_dev_tasks.sql — Fluxo Royale 5.0
-- ENTERRO DA AGENDA DO DEV: DROP da tabela dev_tasks (opção C, decisão travada do Bruno,
-- 30/07/2026).
--
-- POR QUE MATAR E NÃO RESSUSCITAR (o recon que sustenta a decisão):
-- A tela dev-agenda era mock cadeado (prefixo 'dev-' no front) e o backend nunca a
-- sustentou em NADA. O recon read-only de 30/07 mediu:
--   • dev_tasks: 0 linhas desde a criação (02/07/2026) — nunca recebeu um INSERT;
--   • devTasks.routes.ts NUNCA foi montado no server.ts (nenhum dos 19 imports de rota
--     aponta pra ele; o controller só é referenciado pelo próprio router órfão);
--   • o controller morto era SELECT */INSERT cru: sem RBAC (só authenticate), sem
--     ownership (a tabela não tem created_by), sem validação (título vazio passa, falta de
--     start_time vira 500), sem auditoria, sem PUT/DELETE, com pool.query cru fora do
--     retry wrapper do db.ts, e sem nem escrever o client_service_id que a FK oferecia;
--   • RISCO REGISTRADO — era esse o gatilho: um `app.use('/dev-tasks', devTasksRouter)`
--     distraído no server.ts abriria escrita AUTENTICADA SEM PERMISSÃO NENHUMA. Código
--     morto que ninguém chama continua sendo superfície: some junto com a tabela.
-- Do lado do produto: NÃO existe uma única data futura no universo do Dev (tickets não tem
-- due_date, dev_projects não tem campo temporal, client_services não tem prazo de OP), e
-- agenda de blocos manuais só vive com alimentação diária — competia com o calendário
-- pessoal e nasceria vazia. A faixa temporal HONESTA (últimos 7 dias por created_at/
-- closed_at, em andamento por updated_at) vive no dev-painel, a última missão do módulo.
--
-- CRITÉRIO DE REABERTURA (travado com a decisão): a conversa volta SE `due_date` nascer em
-- tickets E pegar como disciplina de verdade. Prazo primeiro, agenda depois — nunca o
-- contrário; due_date em tickets tem valor sozinho (mostra atraso na fila do helpdesk) e
-- não depende de agenda nenhuma pra se justificar. Se aquele dia chegar, a tela nasce como
-- `dev_agenda` LIMPA (nome honesto, longe de `tasks`/`eletrica_tasks`) e não como remendo
-- desta tabela — que é justamente por isso que ela pode morrer agora sem saudade.
--
-- SEM CASCADE, DE PROPÓSITO: nada referencia dev_tasks (a FK dela APONTA pra
-- client_services, não o contrário). DROP puro falha alto se alguém tiver criado
-- dependência nova; CASCADE arrastaria em silêncio. Falhar é o comportamento desejado.
--
-- IDEMPOTENTE: DROP TABLE IF EXISTS — re-execução é no-op. A guarda abaixo ABORTA a
-- migration se a tabela tiver QUALQUER linha: a decisão C partiu de "vazia desde sempre",
-- então dado dentro invalida a premissa e o assunto volta pro Bruno ANTES do DROP.
-- Rodar na validação (branch Neon) antes de promover. NÃO cria nem revoga page_key: a
-- chave 'agenda' nunca existiu no universo (58 chaves em role_permissions, nenhuma agenda).

BEGIN;

-- Guarda de premissa: tabela vazia. Com linha dentro, aborta sem destruir nada.
DO $$
DECLARE
  n BIGINT;
BEGIN
  IF to_regclass('public.dev_tasks') IS NULL THEN
    RAISE NOTICE 'dev_tasks já não existe — nada a fazer (re-execução no-op).';
  ELSE
    EXECUTE 'SELECT count(*) FROM public.dev_tasks' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'dev_tasks tem % linha(s) — ABORTADO. A decisão C partiu de "0 linhas desde a criação"; com dado dentro a premissa cai e o DROP volta pro Bruno.', n;
    END IF;
    RAISE NOTICE 'dev_tasks encontrada e VAZIA (0 linhas) — premissa confirmada, seguindo pro DROP.';
  END IF;
END $$;

DROP TABLE IF EXISTS dev_tasks;

COMMIT;
