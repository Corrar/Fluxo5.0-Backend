-- 010_demand_rejection_reason.sql — Fluxo Royale 5.0
-- MOTIVO DA RECUSA DA DEMANDA 3D EM COLUNA PRÓPRIA.
--
-- POR QUE UMA COLUNA NOVA E NÃO `notes`:
-- demands_3d.notes JÁ NASCE OCUPADA. Na criação da demanda, requests.controller (createRequest)
-- grava nela o resumo do pedido + a observação de quem solicitou:
--     ⚠️ RESUMO DO PEDIDO: A Produzir / Já em Estoque / Total Solicitado + 📝 OBSERVAÇÕES
-- Esse texto é justamente o contexto que o operador da fábrica lê pra decidir se aceita ou recusa.
-- Gravar o motivo da recusa por cima DESTRUIRIA essa informação — e o campo de anotação livre da
-- tela (PUT /demands/:id/notes) passaria a poder apagar o motivo da recusa sem querer, porque
-- seriam o mesmo campo. São dois dados com donos e ciclos de vida diferentes:
--   notes            -> resumo do pedido (escrito na criação) + anotação livre do operador
--   rejection_reason -> por que a fábrica recusou (escrito só na transição p/ 'Rejeitada')
--
-- PRECEDENTE DA CASA: requests já resolve isso exatamente assim — tem `rejection_reason` própria
-- (ver cancelRequest/rejectRequest em requests.controller). Esta migration só estende o mesmo
-- padrão pro Kanban 3D, mantendo os dois módulos com o mesmo vocabulário.
--
-- NOTA SOBRE O CARD: antes desta coluna, a tela exibia `notes` sob o rótulo "Motivo da recusa"
-- quando status='rejeitada' — ou seja, mostrava o resumo do pedido mal rotulado. A coluna corrige
-- a origem do dado; o front passa a ler rejection_reason nesse rótulo.
--
-- ADITIVA E IDEMPOTENTE: só ADD COLUMN IF NOT EXISTS, nullable, sem default e sem backfill.
-- Demandas recusadas antes desta migration ficam com rejection_reason NULL — o histórico não é
-- derivável (o motivo nunca foi capturado) e inventá-lo seria pior que a ausência. O front trata
-- NULL como "motivo não registrado".

BEGIN;

-- Guarda de pré-requisito: a tabela do Kanban 3D precisa existir (vive no schema base, fora deste
-- versionamento — mesma situação de demands_3d/productions_3d citada nas migrations anteriores).
DO $$
BEGIN
  IF to_regclass('public.demands_3d') IS NULL THEN
    RAISE EXCEPTION 'demands_3d ausente — schema base do módulo 3D não encontrado.';
  END IF;
END $$;

-- O motivo estruturado da recusa. NULL = nunca recusada, ou recusada antes desta migration.
ALTER TABLE demands_3d
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

COMMENT ON COLUMN demands_3d.rejection_reason IS
  'Motivo da recusa (status=Rejeitada). NÃO usar notes p/ isto: notes carrega o resumo do pedido '
  'escrito na criação pela requests.controller + a anotação livre do operador.';

COMMIT;
