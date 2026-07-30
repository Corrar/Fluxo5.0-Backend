-- 017_pricing_3d.sql — Fluxo Royale 5.0
-- EXPANSÃO 3D: Registro de Valores (filamento, impressora, manutenção) + Precificação de peça.
--
-- O QUE O RECON ACHOU E POR QUE ISSO MUDA O DESENHO (decisões travadas do Bruno, 31/07/2026):
--   • A PEÇA JÁ EXISTE: o catálogo 3D é `products WHERE is_3d` — e as duas colunas que sustentam
--     metade do cálculo, `filament_grams` e `production_minutes`, JÁ EXISTEM por peça (estavam
--     zeradas nas 8 peças: o buraco era de PREENCHIMENTO, não de tabela). Nenhuma tabela de peça
--     nasce aqui.
--   • O FILAMENTO JÁ EXISTE COMO PRODUTO: BOB-4001 (PLA, R$ 89,00) e BOB-4002 (ABS, R$ 95,00),
--     ambos com unit = 'kg' — ou seja, unit_price JÁ É o preço por quilo. Criar uma tabela
--     `filaments` daria DUAS fontes de preço pra mesma bobina (a de compra e a do 3D), que é a
--     receita conhecida do número divergente. Por isso: flag `is_filament` em products.
--   • A TARIFA não existia em lugar nenhum, mas `settings` (key PK, value, description) existe,
--     está vazia e já tem rota (PUT /admin/settings, requireAdmin + auditoria UPDATE_SETTING).
--   • A CONTAGEM de "já impressas" é DERIVADA de productions_3d (mesmo precedente da árvore da
--     Montagem e do progresso dos checklists): nenhum contador materializado nasce aqui.
--
-- FÓRMULA CANÔNICA (vive no backend; o front exibe, não calcula — uma fonte de verdade):
--   custo_material = (filament_grams / 1000) × preço_kg_do_filamento_vinculado
--   custo_energia  = (production_minutes / 60) × (power_watts / 1000) × tarifa_kwh
--   custo_total    = custo_material + custo_energia
--   preco_venda    = custo_total × (1 + margin_percent / 100)
-- O custo usa a FICHA TÉCNICA (cadastro), nunca a média das produções — a média real aparece AO
-- LADO como diagnóstico ("a ficha diz 100g, a realidade diz 112g"), e é decisão humana corrigir
-- a ficha. Cálculo que se auto-ajusta pelo histórico é número que ninguém consegue explicar.
--
-- FORA DA v1 (travado): rateio de manutenção no custo (v2, precisa de base de horas por período),
-- histórico de preço (o preço vive em products.sales_price; quem precisar do passado tem o livro
-- de auditoria), densidade do filamento e impressora POR PEÇA (v1 usa UMA impressora de
-- referência via settings — ver 'impressora_padrao_3d' abaixo).
--
-- ADITIVA E IDEMPOTENTE: CREATE/ALTER ... IF NOT EXISTS + ON CONFLICT DO NOTHING. Re-execução é
-- no-op. O UPDATE das bobinas é CIRÚRGICO (SKUs exatos, e só liga a flag em quem está desligado).
-- Rodar na validação (branch Neon) antes de promover.

BEGIN;

-- Guardas de pré-requisito.
DO $$
BEGIN
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'products ausente — a peça e o filamento vivem lá.';
  END IF;
  IF to_regclass('public.productions_3d') IS NULL THEN
    RAISE EXCEPTION 'productions_3d ausente — sem ela não há contagem de impressas nem média real.';
  END IF;
  IF to_regclass('public.settings') IS NULL THEN
    RAISE EXCEPTION 'settings ausente — a tarifa de energia e a impressora de referência moram lá.';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions ausente — a matriz RBAC não foi encontrada.';
  END IF;
END $$;

-- =====================================================================
-- 1. A IMPRESSORA (o kW do cálculo de energia)
-- =====================================================================
CREATE TABLE IF NOT EXISTS printers_3d (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Número humano estável (front mostra "IMP-3"). Padrão do display_no de tickets/máquinas.
  display_no   INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  -- A potência é o ÚNICO campo do cálculo aqui. CHECK > 0: impressora de 0 W não existe e
  -- zeraria o custo de energia silenciosamente.
  power_watts  INTEGER NOT NULL CHECK (power_watts > 0),
  -- Status de CADASTRO, não máquina de estados: as três transições são livres entre si
  -- (uma impressora volta de 'manutencao' pra 'ativa' e vice-versa sem cerimônia).
  status       TEXT NOT NULL DEFAULT 'ativa'
                 CHECK (status IN ('ativa','manutencao','inativa')),
  notes        TEXT NOT NULL DEFAULT '',
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE printers_3d IS
  'Impressoras 3D (aba Registro de Valores). power_watts alimenta o custo de energia; status é cadastro (transições livres), não máquina de estados.';
COMMENT ON COLUMN printers_3d.power_watts IS
  'Potência em WATTS. Entra no cálculo como (power_watts / 1000) kW × horas × tarifa. CHECK > 0 pra não zerar energia em silêncio.';

-- =====================================================================
-- 2. MANUTENÇÃO — v1 é SÓ REGISTRO (não entra no custo)
-- =====================================================================
-- O `cost` é gravado desde já pra que o rateio da v2 tenha história pra somar; a v1 NÃO o usa em
-- conta nenhuma. Registrar sem ratear é honesto; ratear sem base de horas seria inventar.
CREATE TABLE IF NOT EXISTS printer_maintenances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  printer_id   UUID NOT NULL REFERENCES printers_3d(id),
  date         DATE NOT NULL,
  description  TEXT NOT NULL,
  cost         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- O extrato da impressora: mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_printer_maint_printer_date
  ON printer_maintenances (printer_id, date DESC);

COMMENT ON TABLE printer_maintenances IS
  'Manutenções da impressora. v1: SÓ REGISTRO — cost NÃO entra no custo da peça (rateio é v2, precisa de base de horas por período).';

-- =====================================================================
-- 3. O QUE FALTAVA EM products: flag do filamento, vínculo e margem
-- =====================================================================
-- Filamento NÃO vira tabela: é produto (comprável, com estoque, com NF). A flag só diz "este
-- produto é bobina" — o preço por kg continua sendo o unit_price de sempre, fonte única.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_filament BOOLEAN NOT NULL DEFAULT false;

-- Vínculo peça → bobina que ela consome. NULL é estado LEGÍTIMO: peça sem filamento vinculado
-- devolve custo_material NULL + flag na resposta. O endpoint NUNCA "chuta" uma bobina.
ALTER TABLE products ADD COLUMN IF NOT EXISTS filament_product_id UUID NULL REFERENCES products(id);

-- Margem por peça (%). 0 = sem margem (preço = custo), não "sem configuração" — quem quer
-- margem digita. CHECK >= 0: margem negativa é desconto, e desconto não se disfarça de margem.
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_percent NUMERIC(6,2) NOT NULL DEFAULT 0
  CHECK (margin_percent >= 0);

COMMENT ON COLUMN products.is_filament IS
  'Produto é bobina de filamento (aba Registro de Valores lista por aqui). O preço por kg é o unit_price — fonte única, a mesma que Compras alimenta.';
COMMENT ON COLUMN products.filament_product_id IS
  'Peça 3D → bobina que ela consome. NULL = sem vínculo: o custo de material vem NULL e a tela mostra o alerta, jamais um número chutado.';
COMMENT ON COLUMN products.margin_percent IS
  'Margem de lucro da peça em %. preco_venda = custo_total × (1 + margin_percent/100).';

-- Bobinas que JÁ EXISTEM no catálogo (SKUs conferidos no recon: BOB-4001 PLA R$ 89,00/kg e
-- BOB-4002 ABS R$ 95,00/kg, ambas unit='kg'). UPDATE cirúrgico por SKU exato, e só em quem está
-- com a flag desligada — re-execução não escreve nada.
UPDATE products SET is_filament = true
 WHERE sku IN ('BOB-4001', 'BOB-4002') AND is_filament = false;

-- =====================================================================
-- 4. CONFIG GLOBAL (settings tem PK em key — o ON CONFLICT abaixo funciona)
-- =====================================================================
-- Tarifa: '0' significa NÃO CONFIGURADA. O endpoint de pricing devolve custo_energia NULL +
-- tarifa_configurada:false nesse caso — tratar 0 como "energia de graça" seria mentira barata.
INSERT INTO settings (key, value, description) VALUES
  ('energia_kwh_brl', '0', 'Tarifa de energia R$/kWh — usada no custo de impressão 3D. 0 = não configurada.')
ON CONFLICT (key) DO NOTHING;

-- Impressora de REFERÊNCIA da v1: uma só, apontada por id. '' = não configurada (custo_energia
-- NULL + flag). Peça × impressora específica é v2 — exigiria escolher a máquina no cálculo, e
-- hoje ninguém sabe em qual delas cada peça vai rodar.
INSERT INTO settings (key, value, description) VALUES
  ('impressora_padrao_3d', '', 'ID da impressora usada como referência no custo de energia (v1: uma só). Vazio = não configurada.')
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 5. RBAC — a chave que existia e não gateava nada
-- =====================================================================
-- 'producao_3d' já vivia no universo da tela Permissões (herança do 2.0) mas NENHUMA rota a
-- usava: o módulo 3D inteiro gateia por 'separacoes:edit', que o comentário da 008 já classifica
-- como escalada de privilégio. A partir daqui a chave PASSA A GATEAR: as duas abas novas e o
-- PUT /producao-3d/parts/:id (que hoje aceita qualquer logado editando a ficha de qualquer peça
-- — furo fechado). As rotas antigas seguem em 'separacoes:edit' de propósito: trocar o gate
-- delas é migração de permissão de usuário real, peça própria (dívida da 008 registrada).
INSERT INTO role_permissions (role, page_key) VALUES ('admin', 'producao_3d')
ON CONFLICT DO NOTHING;

COMMIT;
