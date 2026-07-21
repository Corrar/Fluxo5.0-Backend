import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import { 
  getDashboardStats, 
  getManagerialReports, 
  getRecentTransactions, 
  getAvailableDates, 
  getGeneralReports, 
  getAdminLogs,
  getSettings,      // <-- NOVA IMPORTAÇÃO
  updateSetting     // <-- NOVA IMPORTAÇÃO
} from '../controllers/system.controller';

const router = Router();

// Protege todas as rotas abaixo com autenticação
router.use(authenticate);

// Dashboards e Relatórios
// RBAC: estes 5 estavam com `authenticate` PURO — qualquer usuário logado (obras, usinagem_operador,
// setor...) lia o VALOR TOTAL DO INVENTÁRIO e o extrato de movimentação. É dado gerencial sensível e
// destoava do resto da casa (o /products/low-stock, bem menos sensível, já exigia permissão).
// Chave: 'relatorios' (SEM sufixo :view) — é a que o role_permissions tem com cobertura coerente
// (admin, almoxarife, chefe, compras, gerente). 'relatorios:view' existe mas só com almoxarife e
// compras, o que trancaria chefe e gerente fora do relatório gerencial.
router.get('/dashboard/stats', requirePermission('relatorios'), getDashboardStats);
router.get('/reports/managerial', requirePermission('relatorios'), getManagerialReports);
router.get('/reports/general', requirePermission('relatorios'), getGeneralReports);
router.get('/reports/available-dates', requirePermission('relatorios'), getAvailableDates);
router.get('/transactions/recent', requirePermission('relatorios'), getRecentTransactions);

// Logs
router.get('/admin/logs', getAdminLogs);

// Configurações do Sistema (Aviso de Login, etc.)
router.get('/admin/settings', getSettings);    // <-- NOVA ROTA: Ler as definições
router.put('/admin/settings', updateSetting);  // <-- NOVA ROTA: Guardar as definições

export default router;
