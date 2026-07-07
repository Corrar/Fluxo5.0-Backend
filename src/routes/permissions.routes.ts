import { Router } from 'express';
// Importa o middleware que garante que o usuário está logado
import { authenticate } from '../middlewares/auth';
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
