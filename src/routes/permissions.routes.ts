import { Router } from 'express';
// Importa o middleware que garante que o usuário está logado
import { authenticate, requirePermission } from '../middlewares/auth';
// Importa as 4 funções atualizadas do nosso controlador
import { 
  getRolePermissions, 
  saveRolePermissions, 
  getUserPermissions, 
  saveUserPermissions 
} from '../controllers/permissions.controller';

const router = Router();

// 🛡️ Proteção Global: Aplica a autenticação a todas as rotas de permissões abaixo.
// O usuário precisa enviar um token válido para acessar qualquer rota.
router.use(authenticate);

// A matriz RBAC é a planta da segurança: qualquer acesso exige a page_key 'permissoes'
// (hoje concedida só a admin). Os POSTs mantêm o check inline de admin como defesa em
// profundidade: conceder 'permissoes' a um papel dá VER a matriz; salvar segue admin-only.
router.use(requirePermission('permissoes'));

// ==========================================
// ROTAS DE PERMISSÕES POR CARGOS (ROLES)
// ==========================================

// Rota para buscar as permissões dos cargos
router.get('/roles', getRolePermissions);

// Rota para salvar ou atualizar as permissões de um cargo
router.post('/roles', saveRolePermissions);


// ==========================================
// ROTAS DE PERMISSÕES POR USUÁRIOS (USERS)
// ==========================================

// Rota para buscar as permissões extras de usuários específicos
router.get('/users', getUserPermissions);

// Rota para salvar ou atualizar as permissões extras de um usuário
router.post('/users', saveUserPermissions);

export default router;
