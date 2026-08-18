-- 024_warehouses_setores.sql — Fluxo Royale 5.0
-- CRIA os 7 armazéns de setor que faltavam: Esteira, Lavadora, Flow, Classificadora, Embaladora,
-- Protótipo e Desenvolvimento.
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.
--
-- ⚠ CONFIRMAR códigos/setor com a engenharia Royale (mesma ressalva da 004): os sete nascem com
--   protheus_code NULL, como P3D/ELET/MONT/EXP — só ALMOX ('02') e USINAGEM ('12') têm código
--   mapeado hoje. Se a fábrica tiver código Protheus para estes setores, é UPDATE depois; inventar
--   código aqui seria plantar de-para errado no lugar onde ele é lido como verdade.
--
-- ⚠ O NÚMERO 022 FOI PULADO (ver cabeçalho da 023): `022_hr_core.sql` pertence à leva do RH, que
--   está na árvore de trabalho e ainda não foi commitada.
--
-- ── POR QUE ESTA MIGRATION EXISTE (regra de domínio; decisão do Bruno, 17/08/2026) ───────────
-- Setor COM armazém RECEBE material por transferência e APONTA CONSUMO depois: o material fica
-- sob custódia do setor entre a transferência e o apontamento, e é isso que um armazém representa
-- no modelo (linha em `stock` com aquele warehouse_id).
-- Setor SEM armazém — escritório, chefia, financeiro, compras — CONSOME NA ENTREGA: não guarda
-- material, então não tem custódia e não deve ter armazém. Criar armazém para eles seria criar
-- custódia que ninguém exerce, e saldo que ninguém aponta.
-- Estes sete são setores PRODUTIVOS que guardam material — daí existirem aqui, e só eles.
--
-- ── A LISTA CRESCEU DE 5 PARA 7 (decisão do Bruno, 18/08/2026, após confirmação da engenharia) ─
-- A ressalva "CONFIRMAR códigos/setor com a engenharia Royale" acima é da 004 e foi replicada
-- aqui de propósito. Ela foi ATENDIDA: a engenharia confirmou que **Protótipo e Desenvolvimento
-- também guardam material sob custódia** — recebem por transferência e apontam consumo depois,
-- exatamente como os outros cinco. Entram nesta mesma migration, e não numa 026, porque a 024
-- **nunca foi aplicada em banco nenhum** (medido em 18/08/2026 contra a produção, sessão READ
-- ONLY: `warehouses` tem 6 linhas, as da 004). Emendar um arquivo que ainda não produziu efeito
-- não reescreve passado — reescrever seria criar uma 026 para consertar uma 024 que nunca rodou.
--
-- ⚠ MONTAGEM e EXPEDIÇÃO ficam INDEFINIDOS de propósito. Os armazéns `MONT` e `EXP` existem
--   desde a semente da 004, estão VAZIOS (0 linhas de `stock`, medido) e não têm tráfego em
--   `separations.destination`. Não sabemos ainda se guardam custódia ou se consomem na entrega,
--   e chutar aqui plantaria de-para errado onde o transfer vai ler como verdade. Ficam fora do
--   de-para até decisão — as linhas continuam existindo, intocadas por esta migration.
--
-- ── POR QUE É INÓCUO HOJE ───────────────────────────────────────────────────────────────────
-- Os armazéns nascem VAZIOS (nenhuma linha de `stock` é criada) e os três leitores de saldo já
-- filtram ALMOX explicitamente desde o Lote 0 (commits 70ad7fe / f8337bd / 17b1155): a tela
-- Separações, o Controle de Estoque e os Inativos não mudam de resultado por existirem 13
-- armazéns em vez de 6. Nenhum front lê esta tabela (não há rota GET /warehouses) — os dropdowns
-- de armazém são arrays literais no código do front, com 6 nomes chumbados; os sete novos NÃO
-- aparecerão em tela até existir a rota. Ver DIVIDAS.md.
--
-- ⚠ `warehouses.sector` é um QUARTO vocabulário de setor (slug minúsculo) e NÃO casa com
--   profiles.sector (Título; ver a 025, que tira o prefixo "Setor: " de lá), separations.destination
--   (MAIÚSCULO/misto/minúsculo — "ELETRICA", "Elétrica" e "eletrica" convivem hoje) nem
--   VALID_SECTORS do manualWithdrawal. A unificação é lote próprio e é PRÉ-REQUISITO do transfer.
--   Esta migration segue o slug da 004 de propósito: divergir aqui criaria um QUINTO vocabulário.
--
-- ── DE-PARA FECHADO (decisão do Bruno, 18/08/2026) — é isto que o transfer vai consumir ──────
-- COM ARMAZÉM (guardam custódia):
--   Usinagem        -> USINAGEM   (004)      Elétrica        -> ELET       (004)
--   3D              -> P3D        (004)      Esteira         -> ESTEIRA    (024)
--   Lavadora        -> LAVADORA   (024)      Flow            -> FLOW       (024)
--   Classificadora  -> CLASSIF    (024)      Embaladora      -> EMBALAD    (024)
--   Protótipo       -> PROTOTIPO  (024)      Desenvolvimento -> DESENV     (024)
--
-- SEM ARMAZÉM (consomem na entrega, sem custódia — armazém aqui seria saldo que ninguém aponta):
--   Escritório, Chefia, Financeiro, Compras, Gerência, Assistente Técnico, Engenharia, Ferro,
--   Geral, Outros Setores, Almoxarifado, Viagem, Terceiros, Reposição, Acumulador,
--   Granja NaturOvos.
--
-- INDEFINIDOS (fora do de-para até decisão): Montagem, Expedição.
--
--   Os nomes acima vêm de DUAS fontes, e isso é parte da dívida: Escritório/Chefia/Financeiro/
--   Compras/Gerência/Assistente Técnico/Engenharia/Ferro/Geral/Outros Setores/Almoxarifado e os
--   dez com armazém saem de `profiles.sector`; Viagem/Terceiros/Reposição/Acumulador/
--   Granja NaturOvos só existem em `separations.destination`. Ver DIVIDAS.md para o que foi
--   medido em produção e para os buracos conhecidos deste de-para.

BEGIN;

-- =====================================================================
-- GUARD DE PREMISSA — aborta a transação inteira antes de qualquer escrita.
-- Não há UNIQUE em `sector` (só em `code`, warehouses_code_key), então a colisão de setor é
-- checagem EXPLÍCITA: sem ela, um armazém pré-existente com o mesmo sector sob outro code
-- passaria batido e o de-para setor→armazém ficaria ambíguo — exatamente o que o transfer vai ler.
-- =====================================================================
DO $$
DECLARE
  v_almox   uuid;
  v_conflito text;
BEGIN
  SELECT id INTO v_almox FROM warehouses WHERE code = 'ALMOX' LIMIT 1;
  IF v_almox IS NULL THEN
    RAISE EXCEPTION
      'PREMISSA VIOLADA: armazém ALMOX não existe. A migration 004 precisa estar aplicada antes desta — os armazéns de setor pressupõem o central de onde o material sai.';
  END IF;

  SELECT string_agg(code || ' (sector=' || sector || ')', ', ' ORDER BY code)
    INTO v_conflito
    FROM warehouses
   WHERE sector IN ('esteira', 'lavadora', 'flow', 'classificadora', 'embaladora',
                    'prototipo', 'desenvolvimento')
     AND code NOT IN ('ESTEIRA', 'LAVADORA', 'FLOW', 'CLASSIF', 'EMBALAD',
                      'PROTOTIPO', 'DESENV');
  IF v_conflito IS NOT NULL THEN
    RAISE EXCEPTION
      'PREMISSA VIOLADA: já existe armazém com um dos setores desta migration sob OUTRO code: %. Sem UNIQUE em sector, inserir aqui deixaria dois armazéns disputando o mesmo setor — resolva o de-para antes de rodar.', v_conflito;
  END IF;
END $$;

-- =====================================================================
-- OS 7 ARMAZÉNS DE SETOR. Mesmas colunas da semente da 004 (:22-29): id vem do
-- gen_random_uuid() default, active do default true, created_at do now().
-- ON CONFLICT (code) DO NOTHING = idempotência: rodar duas vezes não falha nem duplica.
-- =====================================================================
INSERT INTO warehouses (code, name, sector, protheus_code, is_central) VALUES
  ('ESTEIRA',  'Esteira',        'esteira',        NULL, false),
  ('LAVADORA', 'Lavadora',       'lavadora',       NULL, false),
  ('FLOW',     'Flow',           'flow',           NULL, false),
  ('CLASSIF',  'Classificadora', 'classificadora', NULL, false),
  ('EMBALAD',  'Embaladora',     'embaladora',     NULL, false),
  ('PROTOTIPO','Protótipo',      'prototipo',      NULL, false),
  ('DESENV',   'Desenvolvimento','desenvolvimento',NULL, false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
