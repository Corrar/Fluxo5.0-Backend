-- 024_warehouses_setores.sql — Fluxo Royale 5.0
-- CRIA os 5 armazéns de setor que faltavam: Esteira, Lavadora, Flow, Classificadora, Embaladora.
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.
--
-- ⚠ CONFIRMAR códigos/setor com a engenharia Royale (mesma ressalva da 004): os cinco nascem com
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
-- Estes cinco são setores PRODUTIVOS que guardam material — daí existirem aqui, e só eles.
--
-- ── POR QUE É INÓCUO HOJE ───────────────────────────────────────────────────────────────────
-- Os armazéns nascem VAZIOS (nenhuma linha de `stock` é criada) e os três leitores de saldo já
-- filtram ALMOX explicitamente desde o Lote 0 (commits 70ad7fe / f8337bd / 17b1155): a tela
-- Separações, o Controle de Estoque e os Inativos não mudam de resultado por existirem 11
-- armazéns em vez de 6. Nenhum front lê esta tabela (não há rota GET /warehouses) — os dropdowns
-- de armazém são arrays literais no código do front, com 6 nomes chumbados; os cinco novos NÃO
-- aparecerão em tela até existir a rota. Ver DIVIDAS.md.
--
-- ⚠ `warehouses.sector` é um QUARTO vocabulário de setor (slug minúsculo) e NÃO casa com
--   profiles.sector ("Setor: Usinagem"), separations.destination (MAIÚSCULO/misto) nem
--   VALID_SECTORS do manualWithdrawal. A unificação é lote próprio e é PRÉ-REQUISITO do transfer.
--   Esta migration segue o slug da 004 de propósito: divergir aqui criaria um QUINTO vocabulário.

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
   WHERE sector IN ('esteira', 'lavadora', 'flow', 'classificadora', 'embaladora')
     AND code NOT IN ('ESTEIRA', 'LAVADORA', 'FLOW', 'CLASSIF', 'EMBALAD');
  IF v_conflito IS NOT NULL THEN
    RAISE EXCEPTION
      'PREMISSA VIOLADA: já existe armazém com um dos setores desta migration sob OUTRO code: %. Sem UNIQUE em sector, inserir aqui deixaria dois armazéns disputando o mesmo setor — resolva o de-para antes de rodar.', v_conflito;
  END IF;
END $$;

-- =====================================================================
-- OS 5 ARMAZÉNS DE SETOR. Mesmas colunas da semente da 004 (:22-29): id vem do
-- gen_random_uuid() default, active do default true, created_at do now().
-- ON CONFLICT (code) DO NOTHING = idempotência: rodar duas vezes não falha nem duplica.
-- =====================================================================
INSERT INTO warehouses (code, name, sector, protheus_code, is_central) VALUES
  ('ESTEIRA',  'Esteira',        'esteira',        NULL, false),
  ('LAVADORA', 'Lavadora',       'lavadora',       NULL, false),
  ('FLOW',     'Flow',           'flow',           NULL, false),
  ('CLASSIF',  'Classificadora', 'classificadora', NULL, false),
  ('EMBALAD',  'Embaladora',     'embaladora',     NULL, false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
