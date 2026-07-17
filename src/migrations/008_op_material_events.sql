-- 008_op_material_events.sql — Fluxo Royale 5.0
-- SUB-RAZÃO DE MATERIAL POR OP — o "armazém da produção" (WIP do chão de fábrica).
--
-- POR QUE UM RAZÃO SEPARADO DO stock_ledger (e não stock_ledger.op_id):
-- a entrega da separação (separations.controller -> StockService.consume) JÁ debita o físico
-- central do ALMOX. O material entregue SAI do estoque e vira WIP do setor: deixa de ser
-- inventário e passa a ser material da OP. Este razão começa exatamente onde o stock_ledger
-- termina — não é uma segunda contabilidade do mesmo saldo, é o estágio seguinte da mesma peça.
-- Por isso NENHUM endpoint deste módulo chama o StockService (ver opMaterials.controller.ts).
--
-- Espelha a filosofia do stock_ledger: append-only, imutável, idempotente por op_key.
-- O saldo per-OP é PROJEÇÃO (nunca materializado):
--   Σ recebido + Σ transferido_in − Σ consumido − Σ devolvido − Σ transferido_out
--
-- ⚠ CONSEQUÊNCIA DE NÃO MATERIALIZAR: não existe linha de saldo pra travar com FOR UPDATE
-- (é o que a tabela `stock` é pro stock_ledger — o alvo da trava + os CHECKs de invariante).
-- Sem alvo, dois consumos concorrentes na mesma (OP, produto) leem a mesma projeção, os dois
-- passam no guard e o saldo vira negativo. O controller resolve com ADVISORY LOCK por
-- (OP, produto) no consume — ver o comentário do consumeOpMaterial.
--
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.

BEGIN;

-- Guarda de pré-requisito: as tabelas que este razão referencia precisam existir.
DO $$
BEGIN
  IF to_regclass('public.client_services') IS NULL THEN
    RAISE EXCEPTION 'client_services ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.separations') IS NULL THEN
    RAISE EXCEPTION 'separations ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.separation_items') IS NULL THEN
    RAISE EXCEPTION 'separation_items ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'products ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — schema base não encontrado.';
  END IF;
END $$;

-- =====================================================================
-- 1. RAZÃO IMUTÁVEL DE MATERIAL POR OP
-- =====================================================================
CREATE TABLE IF NOT EXISTS op_material_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type             TEXT NOT NULL CHECK (event_type IN ('recebido','consumido','devolvido','transferido_out','transferido_in')),
  client_service_id      UUID NOT NULL REFERENCES client_services(id),
  product_id             UUID NOT NULL REFERENCES products(id),
  qty                    NUMERIC NOT NULL CHECK (qty > 0),   -- sempre positivo; o sinal é do event_type (ver projeção)
  -- Origem do 'recebido'. O ITEM (não só a separação) porque o teto é por linha entregue (D1):
  -- qty recebida <= separation_items.quantity - Σ já recebido DAQUELE item. O par
  -- (separation_id, product_id) é único nos dados de hoje (1667/1667) mas NÃO tem constraint
  -- que garanta — createSeparation insere o que o body mandar. Ancorar no item é exato.
  ref_separation_id      UUID REFERENCES separations(id),
  ref_separation_item_id UUID REFERENCES separation_items(id),
  -- Par da transferência OP->OP (peça 4): o 'transferido_in' aponta pro 'transferido_out'.
  -- Sem CHECK de obrigatoriedade: a peça 4 ainda não foi desenhada e um CHECK aqui
  -- congelaria a direção do vínculo antes da hora.
  ref_event_id           UUID REFERENCES op_material_events(id),
  user_id                UUID REFERENCES profiles(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotência: o padrão da casa (uq_stock_ledger_opkey). Aqui é NOT NULL — todo evento
  -- deste razão nasce de um POST com âncora; não há 'opening' sem chave como no stock_ledger.
  op_key                 TEXT NOT NULL UNIQUE,
  -- 'recebido' sem separação de origem é material que apareceu do nada na OP.
  CONSTRAINT ck_opmat_recebido_tem_origem
    CHECK (event_type <> 'recebido' OR (ref_separation_id IS NOT NULL AND ref_separation_item_id IS NOT NULL))
);

-- Projeção do saldo por (OP, produto) — a query que a tela Armazém renderiza.
CREATE INDEX IF NOT EXISTS idx_opmat_op_product ON op_material_events (client_service_id, product_id);
-- Teto do recebimento parcial e a fila de pending-receipts.
CREATE INDEX IF NOT EXISTS idx_opmat_ref_separation ON op_material_events (ref_separation_id);
CREATE INDEX IF NOT EXISTS idx_opmat_ref_sep_item ON op_material_events (ref_separation_item_id);
CREATE INDEX IF NOT EXISTS idx_opmat_event_type ON op_material_events (event_type);

-- =====================================================================
-- 2. PERMISSÃO producao:apontar (D5)
-- =====================================================================
-- Antes desta migration a matriz (56 chaves) não tinha NENHUMA permissão do módulo Produção —
-- só producao_3d:* (que é a Fábrica 3D, outro módulo). O provisório era separacoes:edit, que
-- é escalada de privilégio: pra um montador apontar peça ele ganharia junto o direito de
-- AUTORIZAR e ENTREGAR separação do almoxarifado. producao:apontar corta esse vínculo.
--
-- Cobre receive (setor confirma o que a separação entregou) e consume (montador aponta peça).
-- Os GETs (balance/pending-receipts) só exigem authenticate — leitura não precisa de chave.
--
-- role_permissions é (role TEXT, page_key TEXT) com PK composta -> uma linha por permissão,
-- ON CONFLICT DO NOTHING deixa re-executável.
--
-- PAPÉIS ESCOLHIDOS — chão de fábrica, i.e. quem recebe material contra OP e monta:
--   admin            (explícito por clareza; o middleware já dá bypass em role='admin')
--   chefe            chefe de setor — é quem a tela de Montagem chama de responsável
--   setor            operador de setor (o maior grupo: 6 pessoas)
--   usinagem_lider   \
--   usinagem_operador ) setores que existem em VALID_SECTORS e retiram material por OP
--   prototipo        |
--   engenharia       |
--   desenvolvimento  /
-- DELIBERADAMENTE FORA: almoxarife (é quem ENTREGA — o recebimento é do lado do setor),
-- compras, financeiro, escritorio, gerente, assistente_tecnico, obras.
-- Se o Bruno quiser outro recorte, é editar esta lista e re-rodar (idempotente).
INSERT INTO role_permissions (role, page_key)
SELECT r, 'producao:apontar'
  FROM unnest(ARRAY[
    'admin',
    'chefe',
    'setor',
    'usinagem_lider',
    'usinagem_operador',
    'prototipo',
    'engenharia',
    'desenvolvimento'
  ]) AS r
ON CONFLICT (role, page_key) DO NOTHING;

COMMIT;
