-- 009_op_returns_pending.sql — Fluxo Royale 5.0
-- DEVOLUÇÃO DE MATERIAL DE OP EM DUAS ETAPAS (registro no chão de fábrica -> conferência no almox).
--
-- POR QUE UMA TABELA NOVA E NÃO UMA COLUNA `status` EM op_returns:
-- op_returns é o LIVRO DO CONFERIDO — a linha que o total_cost lê pra abater o custo da OP
-- (clients.controller: Σ saídas − Σ op_returns) e que a projeção conta como "já devolvido". Toda
-- linha lá dentro é material que JÁ voltou pro estoque. Se a devolução virasse uma linha em
-- op_returns no ato do registro (antes da conferência), o custo da OP cairia por material que o
-- almox ainda nem contou. Então o registro NÃO toca op_returns: nasce AQUI, como pedido pendente, e
-- só na conferência a MESMA transação escreve a linha em op_returns (ver conferReturn: a tx tripla).
--
-- CICLO DE VIDA (a linha nunca some — é o histórico do pedido):
--   pendente  -> registerReturn: material declarado; "em trânsito" pro almox. Desconta do disponível
--                a devolver (em_devolucao) mas NÃO credita estoque nenhum.
--   conferido -> conferReturn: o almox contou `conferred_qty` (<= quantity). A tx tripla credita os
--                3 livros (per-OP 'devolvido', físico central POOLED, op_returns). Fim de linha.
--   rejeitado -> rejectReturn: o almox recusou. NÃO credita nada; libera a janela de trânsito.
--
-- A FONTE DO DEVOLVÍVEL É O SALDO PER-OP (o armazém de material da OP, razão da 008), NÃO o físico
-- central nem as saídas de separação. Disponível a devolver por (OP, produto) =
--   (recebido + transferido_in − consumido − devolvido − transferido_out)   ← saldo WIP (SALDO_SQL)
--   − em_devolucao (Σ pendente desta tabela)                                ← a janela de trânsito
-- Isso IMPEDE devolver material já apontado como consumido: o consumido já derrubou o saldo WIP, e o
-- guard não deixa a devolução passar dele — senão a projeção per-OP iria a NEGATIVO.
--
-- ⚠ MESMO GRÃO DE CONCORRÊNCIA DA 008: o disponível é PROJEÇÃO, sem linha pra travar. O guard do
-- registro pega o MESMO advisory lock do consume (`opmat:${op}:${produto}`) — assim registro,
-- apontamento e conferência (o 'devolvido') se serializam sobre o mesmo saldo WIP. Ver registerReturn.
--
-- LIMITAÇÃO ACEITA (OP LEGADA, sem rastro per-OP): OPs anteriores ao go-live do armazém per-OP não
-- têm eventos 'recebido' -> saldo WIP 0 -> nada devolvível por aqui. A tela mostra vazio + a
-- orientação "OPs anteriores ao per-OP: use a Entrada de Reaproveitamento". É de propósito.
--
-- Idempotente (re-executável). Rodar em branch Neon antes de promover.

BEGIN;

-- Guarda de pré-requisito: as tabelas que este fluxo referencia precisam existir.
DO $$
BEGIN
  IF to_regclass('public.client_services') IS NULL THEN
    RAISE EXCEPTION 'client_services ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'products ausente — schema base não encontrado.';
  END IF;
  IF to_regclass('public.op_returns') IS NULL THEN
    RAISE EXCEPTION 'op_returns ausente — o livro do conferido (schema base) não foi encontrado.';
  END IF;
  IF to_regclass('public.op_material_events') IS NULL THEN
    RAISE EXCEPTION 'op_material_events ausente — aplique a migration 008 antes desta (é a fonte do saldo WIP).';
  END IF;
END $$;

-- =====================================================================
-- LIVRO DOS PEDIDOS DE DEVOLUÇÃO (a etapa "pendente"/"em trânsito")
-- =====================================================================
CREATE TABLE IF NOT EXISTS op_returns_pending (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_service_id UUID NOT NULL REFERENCES client_services(id),
  product_id        UUID NOT NULL REFERENCES products(id),
  -- Quantidade que o setor declara devolver (o que entra em trânsito / em_devolucao). Sempre > 0.
  quantity          NUMERIC NOT NULL CHECK (quantity > 0),
  status            TEXT NOT NULL DEFAULT 'pendente'
                      CHECK (status IN ('pendente','conferido','rejeitado')),
  -- O que o almox REALMENTE contou na conferência (<= quantity). NULL enquanto pendente.
  -- Conferido exige > 0: conferir zero é, na prática, rejeitar — e rejeitar tem seu próprio status.
  conferred_qty     NUMERIC CHECK (conferred_qty IS NULL OR conferred_qty >= 0),
  observation       TEXT,           -- do solicitante (produção)
  reject_reason     TEXT,           -- preenchido só quando status='rejeitado'
  requested_by      UUID REFERENCES profiles(id),   -- quem registrou (chão de fábrica)
  conferred_by      UUID REFERENCES profiles(id),   -- quem conferiu/rejeitou (almox)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- início do trânsito
  resolved_at       TIMESTAMPTZ,    -- instante da conferência OU da rejeição

  -- Conferido tem de ter quantidade contada e positiva (é dela que nascem os 3 livros).
  CONSTRAINT ck_opret_conferido_tem_qtd
    CHECK (status <> 'conferido' OR (conferred_qty IS NOT NULL AND conferred_qty > 0)),
  -- O almox nunca "confere a mais" do que o setor mandou.
  CONSTRAINT ck_opret_conferido_dentro_do_pedido
    CHECK (conferred_qty IS NULL OR conferred_qty <= quantity),
  -- Resolvido (conferido/rejeitado) tem carimbo de quando; pendente não.
  CONSTRAINT ck_opret_resolvido_tem_data
    CHECK ((status = 'pendente') = (resolved_at IS NULL))
);

-- A JANELA DE TRÂNSITO: Σ pendente por (OP, produto). Índice PARCIAL — só o pendente desconta o
-- disponível; conferido/rejeitado saem do caminho quente.
CREATE INDEX IF NOT EXISTS idx_opret_pendente_op_product
  ON op_returns_pending (client_service_id, product_id)
  WHERE status = 'pendente';

-- A FILA DA CONFERÊNCIA (aba Devoluções): lista os pendentes, mais novos primeiro.
CREATE INDEX IF NOT EXISTS idx_opret_status_created
  ON op_returns_pending (status, created_at DESC);

COMMIT;
