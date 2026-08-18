-- 025_normaliza_prefixo_setor.sql — Fluxo Royale 5.0
-- Tira o prefixo "Setor: " de `profiles.sector`. Cinco linhas, um valor: "Setor: Usinagem" -> "Usinagem".
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.
--
-- ── POR QUE ESTA MIGRATION EXISTE: um GATE DE AUTORIZAÇÃO QUEBRADO, não estética ─────────────
-- `stock.controller.ts:127` (rota `PUT /stock/:id`, ajuste de saldo) decide assim, para quem não é
-- admin nem almoxarife:
--
--     if (userCheck.rows[0]?.sector?.toLowerCase() !== 'usinagem' || !hasTag) return 403;
--
-- O dado real em produção é **"Setor: Usinagem"**, que em minúsculas vira `'setor: usinagem'` e
-- **nunca** casa com `'usinagem'`. Consequência medida em 18/08/2026 contra a produção
-- (`ep-steep-breeze`, sessão READ ONLY): os **5** usuários da Usinagem — **4× `usinagem_operador` e
-- 1× `usinagem_lider`** — levam **403 HOJE** numa rota de ajuste de estoque. O ramo inteiro está
-- morto: na prática só admin e almoxarife ajustam por ali.
--
-- O prefixo NÃO vem de código. O campo é `<input>` de texto livre (`pages_admin.jsx:1109-1110`,
-- placeholder "Ex.: Usinagem"), gravado cru no cadastro (`auth.controller.ts:158-160`), e **não há
-- tela para editar depois** — o único PUT de usuário manda só `{ role }` (`pages_admin.jsx:850`).
-- Alguém digitou "Setor: Usinagem" uma vez e não havia como desfazer pela UI. Por isso migration.
--
-- ── O QUE ESTA MIGRATION NÃO É ───────────────────────────────────────────────────────────────
-- ⚠ Isto **NÃO é a unificação de vocabulário de setor**. Continuam existindo quatro vocabulários
--   independentes que não conversam: `profiles.sector` (Título), `separations.destination` (texto
--   livre, MAIÚSCULO/misto), `warehouses.sector` (slug minúsculo, ver 024) e o `VALID_SECTORS` do
--   `manualWithdrawal`. A unificação é **tabela de de-para e lote próprio**, e é pré-requisito do
--   transfer. Aqui só cai o prefixo de UM campo de cadastro — nada de de-para, nada de
--   `resolveWarehouseId`, nada de `destination`.
--
-- ⚠ O gate do `:127` **NÃO é tocado neste lote**, de propósito: o conserto tem de provar que foi o
--   DADO que destravou a rota, sem uma segunda mudança no meio. Que ele compare string solta em vez
--   de chave de RBAC é dívida registrada à parte (ver DIVIDAS.md).
--
-- ── ESCOPO: só `profiles`. `requests.sector` fica para lote próprio ──────────────────────────
-- `requests.controller.ts:133-137` deriva `requests.sector` de `profiles.sector` quando o corpo não
-- manda setor (Meus Pedidos nunca manda — é identidade, vem do token). Medido em produção:
-- **210 de 2.630 solicitações (8,0%)** carregam "Setor: Usinagem", de 12/06/2026 a 17/08/2026.
-- DEPOIS desta migration a torneira **estanca sozinha** — a derivação passa a copiar "Usinagem"
-- limpo. O que sobra é histórico, e reescrever histórico é decisão do Bruno, não desta migration.
-- Ver DIVIDAS.md: "requests.sector — 210 linhas com o prefixo".
--
-- ── EFEITO COLATERAL BOM, medido ─────────────────────────────────────────────────────────────
-- A tela de Usuários (`pages_admin.jsx:1021`) já rotula o campo com "SETOR:" e renderiza o valor em
-- `textTransform: uppercase`. Para esses 5 ela mostra hoje **"SETOR: SETOR: USINAGEM"** e passa a
-- mostrar **"SETOR: USINAGEM"**. Mesma coisa no seletor pós-login (`auth.jsx:243`), nas Exceções por
-- usuário (`pages_rest.jsx:2901`) e no drawer da Auditoria (`pages_rest.jsx:3414`): a string só
-- encurta (15 -> 8 chars), então não há risco de layout.
--
-- ── RETRATO DA PRODUÇÃO NO MOMENTO DA ESCRITA (18/08/2026, READ ONLY) ────────────────────────
--   29 perfis, 19 valores distintos de `sector`. UM só tem prefixo:
--     "Setor: Usinagem" (5)  ← os afetados
--   Os outros 18 seguem intocados: Chefia (3), Escritório (3), Almoxarifado (2), Esteira (2),
--   3D, Assistente Técnico, Compras, Desenvolvimento, Elétrica, Engenharia, Ferro, Financeiro,
--   Flow, Geral, Gerência, Lavadora, Outros Setores, Protótipo (1 cada).
--   `Usinagem` limpo NÃO existe hoje (0 linhas) — o UPDATE não funde ninguém com valor pré-existente.
--   `profiles.sector` é `text`, NULL-ável, sem default, **sem índice, sem FK e sem CHECK**
--   (confirmado em `pg_constraint`/`pg_indexes`: só `profiles_pkey`, `profiles_id_fkey` e
--   `profiles_warehouse_id_fkey`, nenhum tocando `sector`).
--
-- ⚠ O NÚMERO 022 FOI PULADO (ver cabeçalho da 023): `022_hr_core.sql` pertence à leva do RH, que
--   está na árvore de trabalho e ainda não foi commitada.

BEGIN;

-- =====================================================================
-- GUARD DE PREMISSA — aborta a transação inteira antes de qualquer escrita.
--
-- O dado pode ter mudado entre a medição (18/08/2026) e a aplicação: um cadastro novo digitado com
-- o mesmo prefixo, ou um perfil removido. Se o número divergir, quem roda precisa MEDIR DE NOVO
-- antes de aplicar — não descobrir depois que mexeu em mais (ou menos) gente do que pensava.
--
-- ZERO NÃO ABORTA, de propósito: é o caso IDEMPOTENTE. Rodar a migration duas vezes tem de ser
-- inofensivo, e na segunda execução não sobra nenhuma linha com prefixo. Abortar aí transformaria
-- "já aplicada" em erro, que é o oposto de idempotência. Qualquer OUTRO número (1..4, 6+) é
-- divergência real e aborta.
-- =====================================================================
DO $$
DECLARE
  v_esperado constant int := 5;
  v_afetados int;
  v_valores  text;
  v_vazios   int;
BEGIN
  SELECT count(*) INTO v_afetados
    FROM profiles
   WHERE sector ~* '^\s*setor\s*:';

  IF v_afetados = 0 THEN
    RAISE NOTICE '025: NO-OP — nenhuma linha com o prefixo "Setor: ". Migration já aplicada (ou banco sem o dado). Nada a fazer.';

  ELSIF v_afetados <> v_esperado THEN
    SELECT string_agg(DISTINCT sector, ' | ' ORDER BY sector) INTO v_valores
      FROM profiles
     WHERE sector ~* '^\s*setor\s*:';
    RAISE EXCEPTION
      'PREMISSA VIOLADA: % perfis com o prefixo "Setor: ", esperado %. Valores encontrados: %. O dado mudou desde a medição de 18/08/2026 — meça de novo (SELECT sector, count(*) FROM profiles WHERE sector ~* ''^\s*setor\s*:'' GROUP BY 1) e ajuste o esperado antes de rodar.',
      v_afetados, v_esperado, coalesce(v_valores, '(nenhum)');
  END IF;

  -- Um strip que resulta em vazio seria PIOR que o prefixo: trocaria "Setor:" por '' e o perfil
  -- ficaria sem setor nenhum, em silêncio. Medido hoje: 0 casos. Se algum dia houver, aborta.
  SELECT count(*) INTO v_vazios
    FROM profiles
   WHERE sector ~* '^\s*setor\s*:'
     AND btrim(regexp_replace(sector, '^\s*[Ss][Ee][Tt][Oo][Rr]\s*:\s*', '')) = '';
  IF v_vazios > 0 THEN
    RAISE EXCEPTION
      'PREMISSA VIOLADA: % perfis ficariam com sector VAZIO após tirar o prefixo (ex.: o valor era só "Setor:"). Trocar o prefixo por string vazia é pior que mantê-lo — corrija esses cadastros à mão antes de rodar.',
      v_vazios;
  END IF;
END $$;

-- =====================================================================
-- O UPDATE. Idempotente POR CONSTRUÇÃO: o WHERE só casa o que AINDA tem prefixo, então a segunda
-- execução casa 0 linhas — não há como dobrar o strip nem tocar linha já limpa.
--
-- As classes [Ss][Ee][Tt][Oo][Rr] existem porque `regexp_replace` é case-SENSITIVE por padrão
-- (diferente do `~*` do WHERE, que já é case-insensitive). Sem elas, um "SETOR: Usinagem" entraria
-- pelo WHERE e sairia sem ser trocado — casado mas não consertado.
-- `\s*` nas três posições cobre as variantes de espaçamento ("Setor :", "setor:Usinagem").
-- =====================================================================
UPDATE profiles
   SET sector = regexp_replace(sector, '^\s*[Ss][Ee][Tt][Oo][Rr]\s*:\s*', '')
 WHERE sector ~* '^\s*setor\s*:';

COMMIT;
