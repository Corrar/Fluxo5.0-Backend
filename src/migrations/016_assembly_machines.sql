-- 016_assembly_machines.sql — Fluxo Royale 5.0
-- MONTAGEM DE MÁQUINAS v1 (peça 5 do módulo Produção) — a máquina como ENTIDADE, o consumo
-- como DIMENSÃO.
--
-- CAMINHO B (decisão travada do Bruno, 30/07/2026), e por que os outros dois caíram:
--   (A) máquina = a própria OP — o dado real recusa: das 7 OPs vivas, 5 são SERVIÇO
--       ("Manutenção usinagem", "Troca de flanges", "Reparo elétrico painel") e não máquina;
--       e uma OP pode carregar mais de uma máquina. O próprio mock trata a OP como ATRIBUTO
--       da máquina, não como identidade dela.
--   (C) máquina substitui a OP como eixo — reescreveria a peça 1 inteira: client_service_id é
--       NOT NULL em op_material_events e é a âncora da projeção de saldo, do advisory lock, do
--       receive (que nasce de separation_item -> OP), do op_returns e do Armazém.
--   (B) ESTE: assembly_machines com client_service_id NOT NULL (N máquinas : 1 OP) e
--       op_material_events.machine_id NULL como ETIQUETA do evento.
--
-- ⚠ A RÉGUA QUE ESTA MIGRATION EXISTE PRA PROTEGER — machine_id é DIMENSÃO, NUNCA EIXO:
--   • a projeção de saldo per-OP continua Σ por (client_service_id, product_id) — machine_id
--     NÃO entra no GROUP BY, NÃO entra no WHERE do guard;
--   • o advisory lock continua `opmat:<OP>:<produto>` — machine_id NÃO entra na string;
--   • "saldo por máquina" é a MESMA CLASSE DE ERRO do op_id no stock: racharia o saldo da OP
--     em N caixinhas e o guard deixaria de proteger o todo. Proibido.
--   Consequência boa: como o razão de WIP NÃO escreve saldo físico (o StockService debitou o
--   ALMOX lá atrás, na entrega da separação), etiquetar o evento com a máquina não encosta em
--   nenhum invariante de estoque. Nada aqui chama StockService, nada aqui cria linha de stock.
--
-- ÁRVORE DO PRODUTO (BOM) = PROJEÇÃO, JAMAIS TABELA: a árvore da máquina é
--   SUM(qty) dos eventos 'consumido' com machine_id = X, agrupado por produto.
-- Não existe lista planejada de materiais no sistema (products não tem estrutura pai/filho) e
-- a v1 não inventa uma: a árvore é o que foi REALMENTE consumido, lido do razão.
--
-- CHECKLISTS = jsonb NA LINHA (precedente literal do dev_projects/013): [{nome, peso, itens:
--   [{t, done, dia}]}]. Progresso é DERIVADO (ponderado pelo peso), jamais coluna. A soma dos
--   pesos NÃO é travada pelo banco — peso é apresentação do progresso, não invariante contábil.
--
-- CORTE DA v1 (decisão travada): máquina + checklists + machine_id no consumo + árvore
--   derivada. FORA: congelamento da ficha técnica (bom_frozen_at NEM NASCE aqui — coluna que
--   não tem rota vira dívida silenciosa), notificação de parada (notifications segue órfã por
--   decisão; parada é ESTADO) e a transição 'concluida' (o valor entra no CHECK por futuro,
--   mas a rota devolve 400 na v1 — ver assembly.controller).
--
-- ADITIVA E IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- ON CONFLICT DO NOTHING. Re-execução é no-op. op_material_events tem 0 linhas hoje — a coluna
-- nova nasce sem backfill e sem risco. Rodar na validação (branch Neon) antes de promover.

BEGIN;

-- Guardas de pré-requisito: tudo que esta peça referencia precisa existir.
DO $$
BEGIN
  IF to_regclass('public.client_services') IS NULL THEN
    RAISE EXCEPTION 'client_services ausente — a OP é o dono da máquina (FK NOT NULL).';
  END IF;
  IF to_regclass('public.op_material_events') IS NULL THEN
    RAISE EXCEPTION 'op_material_events ausente (migration 008) — sem o razão de WIP não há o que etiquetar.';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — a matriz RBAC não foi encontrada.';
  END IF;
END $$;

-- =====================================================================
-- 1. A MÁQUINA EM MONTAGEM
-- =====================================================================
CREATE TABLE IF NOT EXISTS assembly_machines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Número humano estável (o front mostra "MAQ-42"). Padrão do display_no de tickets:
  -- IDENTITY é do banco, sequencial e imune a corrida — nada de MAX()+1 na aplicação.
  display_no        INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
  name              TEXT NOT NULL,
  -- A OP é DONA da máquina (N:1). NOT NULL: máquina sem OP não tem onde consumir material —
  -- o razão de WIP é per-OP e o guard de integridade do consumo compara ESTA coluna.
  client_service_id UUID NOT NULL REFERENCES client_services(id),
  sector            TEXT NOT NULL DEFAULT '',
  responsible       TEXT NOT NULL DEFAULT '',
  -- 'concluida' entra no CHECK por FUTURO (v2 congela a ficha técnica). A v1 NÃO tem rota que
  -- produza esse valor: PUT /:id/status devolve 400 pra qualquer transição que o envolva.
  status            TEXT NOT NULL DEFAULT 'andamento'
                      CHECK (status IN ('andamento','parada','concluida')),
  -- Parada é ESTADO, não tabela (v1): motivo + setor responsável + quando. Sem notificação
  -- persistente — notifications é órfã por decisão, dívida registrada.
  stopped_reason    TEXT,
  stopped_sector    TEXT,
  stopped_at        TIMESTAMPTZ,
  -- [{nome, peso, itens: [{t, done, dia}]}] — o shape do mock. Validado/normalizado na BORDA
  -- do controller (limites, tipos); o banco garante só NOT NULL + default.
  checklists        JSONB NOT NULL DEFAULT '[]',
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- As máquinas de uma OP (o detalhe da OP e o seletor do apontamento).
CREATE INDEX IF NOT EXISTS idx_assembly_machines_op ON assembly_machines (client_service_id);
-- A grade (GET /assembly-machines?status=): por status, mexidas mais recentemente primeiro.
CREATE INDEX IF NOT EXISTS idx_assembly_machines_status_updated ON assembly_machines (status, updated_at DESC);

COMMENT ON TABLE assembly_machines IS
  'Máquina em montagem (Produção › Montagem). PERTENCE a uma OP (client_service_id NOT NULL, N:1) — a OP segue sendo o eixo do razão de material; a máquina é o objeto que está sendo construído dentro dela.';
COMMENT ON COLUMN assembly_machines.display_no IS
  'Número humano (front mostra MAQ-<display_no>). IDENTITY do banco — padrão do display_no de tickets.';
COMMENT ON COLUMN assembly_machines.status IS
  'andamento|parada|concluida. v1 só produz andamento<->parada; concluida está no CHECK por futuro (congelamento da ficha é v2) e a rota recusa com 400.';
COMMENT ON COLUMN assembly_machines.checklists IS
  'Grupos de processo do mock: [{nome, peso, itens:[{t, done, dia}]}]. Progresso é DERIVADO (média ponderada pelo peso), nunca coluna. Soma dos pesos NÃO é travada — peso é apresentação.';

-- =====================================================================
-- 2. A ETIQUETA NO RAZÃO — a única mudança na peça 1
-- =====================================================================
ALTER TABLE op_material_events
  ADD COLUMN IF NOT EXISTS machine_id UUID NULL REFERENCES assembly_machines(id);

-- Índice PARCIAL: hoje a esmagadora maioria dos eventos não tem máquina (e consumo sem
-- etiqueta segue válido por decisão — retrocompatível). Indexar só o que existe.
CREATE INDEX IF NOT EXISTS idx_opmat_machine ON op_material_events (machine_id)
  WHERE machine_id IS NOT NULL;

COMMENT ON COLUMN op_material_events.machine_id IS
  'DIMENSÃO de rastreio, nunca eixo: não participa da projeção de saldo nem do advisory lock (ambos por OP,produto). Saldo por máquina = mesma classe de erro do op_id no stock — proibido.';

-- =====================================================================
-- 3. A CHAVE NO UNIVERSO DA TELA PERMISSÕES (padrão 013/015)
-- =====================================================================
-- O admin não precisa da linha (bypass por JWT no requirePermission) — ela existe pra chave
-- ser VISÍVEL e concedível ao chefe de setor pela tela de Permissões.
INSERT INTO role_permissions (role, page_key) VALUES ('admin', 'montagem')
ON CONFLICT DO NOTHING;

COMMIT;
