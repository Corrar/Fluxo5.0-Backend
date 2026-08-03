import { Router } from 'express';
import { authenticate, requirePermission, requireAdmin } from '../middlewares/auth';
import { getReportsBi } from '../controllers/reportsBi.controller';
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
// Painel BI (Fase 3a): os CINCO blocos agregados num período só — capital entrado/saído,
// reposições e solicitações por status, e capital por setor. Mesma chave 'relatorios' das
// irmãs: é o mesmo dado gerencial, com a mesma sensibilidade. Agregação toda em SQL — o
// cliente não baixa linha para somar.
router.get('/reports/bi', requirePermission('relatorios'), getReportsBi);

// Logs — page_key 'logs' (hoje só admin) em vez do check inline: comportamento idêntico,
// mas DB-driven — a tela de Permissões pode conceder auditoria a outro papel sem mexer em código.
router.get('/admin/logs', requirePermission('logs'), getAdminLogs);

// Configurações do Sistema (Aviso de Login, etc.)
// Leitura segue para qualquer logado (a tela de Config e avisos precisam ler);
// ESCRITA é config global → gate de admin em tempo real.
router.get('/admin/settings', getSettings);
router.put('/admin/settings', requireAdmin, updateSetting);

export default router;
