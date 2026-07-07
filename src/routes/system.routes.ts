import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
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
router.get('/dashboard/stats', getDashboardStats);
router.get('/reports/managerial', getManagerialReports);
router.get('/reports/general', getGeneralReports);
router.get('/reports/available-dates', getAvailableDates);
router.get('/transactions/recent', getRecentTransactions);

// Logs
router.get('/admin/logs', getAdminLogs);

// Configurações do Sistema (Aviso de Login, etc.)
router.get('/admin/settings', getSettings);    // <-- NOVA ROTA: Ler as definições
router.put('/admin/settings', updateSetting);  // <-- NOVA ROTA: Guardar as definições

export default router;
