// src/routes/printers3d.routes.ts — Registro de Valores 3D: impressoras + manutenções.

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  getPrinters,
  getPrinter,
  createPrinter,
  updatePrinter,
  updatePrinterStatus,
  deletePrinter,
  createMaintenance,
  deleteMaintenance,
} from '../controllers/printers3d.controller';

const router = Router();

// Router INTEIRO atrás da chave 'producao_3d' (migration 017). Ela já existia no universo da tela
// Permissões desde o 2.0 e NÃO gateava nada — a partir daqui gateia as abas novas e a ficha
// técnica. As rotas antigas do módulo seguem em 'separacoes:edit' de propósito (trocar o gate
// delas mexe em permissão de usuário real: peça própria, dívida da 008 registrada).
router.use(authenticate);
router.use(requirePermission('producao_3d'));

// 🖨️ Impressoras
router.get('/', getPrinters);              // ?status= ativa|manutencao|inativa|todos
router.get('/:id', getPrinter);            // detalhe + extrato de manutenções
router.post('/', createPrinter);
router.put('/:id', updatePrinter);         // parcial (name/model/power_watts/notes)
router.put('/:id/status', updatePrinterStatus); // transições LIVRES — é cadastro, não máquina
router.delete('/:id', deletePrinter);      // 409 se houver manutenção (orienta 'inativa')

// 🔧 Manutenções (v1: SÓ REGISTRO — não entram no custo da peça)
router.post('/:id/maintenances', createMaintenance);
router.delete('/:printerId/maintenances/:id', deleteMaintenance);

export default router;
