// src/routes/assembly.routes.ts — Montagem de Máquinas v1 (peça 5 do módulo Produção).

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  createMachine,
  getMachines,
  getMachine,
  updateMachine,
  updateMachineStatus,
} from '../controllers/assembly.controller';

const router = Router();

// Router INTEIRO atrás do gate (padrão dev-projects/producao). A page_key 'montagem' nasceu no
// universo pela migration 016 — concedível ao chefe de setor pela tela de Permissões.
// NOTA: apontar CONSUMO com etiqueta de máquina continua exigindo 'producao:apontar' (é o razão
// que está sendo escrito, e o gate dele não muda) — quem monta e quem aponta podem ser papéis
// diferentes, e a v1 não os funde.
router.use(authenticate);
router.use(requirePermission('montagem'));

// ➕ Cadastrar máquina (op_code obrigatório — a máquina pertence a uma OP).
router.post('/', createMachine);
// 📋 A grade (?status= andamento|parada|concluida|todos; default exclui concluida).
router.get('/', getMachines);
// 🔎 Detalhe + ÁRVORE DERIVADA do razão (SUM de 'consumido' por machine_id).
router.get('/:id', getMachine);
// ✏️ Edição parcial (nome/setor/responsável/checklists). A OP não é editável na v1.
router.put('/:id', updateMachine);
// ⏸️ Parar / retomar (transação com FOR UPDATE; 'concluida' é v2 e devolve 400).
router.put('/:id/status', updateMachineStatus);

export default router;
