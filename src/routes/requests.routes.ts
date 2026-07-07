// src/routes/requests.routes.ts

import { Router } from 'express';
// 1. Importamos o nosso "Cão de Guarda" (requirePermission) junto com a autenticação
import { authenticate, requirePermission } from '../middlewares/auth';
import { 
    getRequests, 
    getMyRequests, 
    createRequest, 
    updateRequestStatus, 
    deleteRequest,
    partialReturnRequest // 🟢 Controlador importado com sucesso
} from '../controllers/requests.controller';

const router = Router();

// ==========================================
// 🛡️ ROTAS DE SOLICITAÇÕES (PEDIDOS)
// ==========================================

// Aplica o middleware de autenticação (verifica o token JWT) a todas as rotas deste ficheiro
router.use(authenticate);

// 📋 Visualizar TODAS as solicitações (Visão da Gestão/Almoxarifado)
// Requer a permissão de visualização geral de solicitações
router.get('/', requirePermission('solicitacoes:view'), getRequests);

// 👤 Visualizar APENAS as solicitações do próprio utilizador
// Substitui a antiga rota solta /my-requests
// Garantimos que tem permissão para aceder ao módulo "Meus Pedidos"
router.get('/my', requirePermission('minhas_solicitacoes:view'), getMyRequests);

// ➕ Criar um novo pedido (Feito pelo utilizador)
// ⚠️ ALTERADO: Removido o bloqueio estrito de 'minhas_solicitacoes:add'
// Assim, tanto quem tem acesso a "Meus Pedidos" quanto quem tem acesso apenas a "Solicitar Peças 3D" consegue gravar o pedido.
// A segurança já é feita no Frontend (ocultando o botão de quem não tem permissão).
router.post('/', createRequest);

// ✏️ Atualizar o status do pedido (Aprovar, Rejeitar, Entregar)
// Ação executada por quem gere as solicitações
router.put('/:id/status', requirePermission('solicitacoes:edit'), updateRequestStatus);

// 🔄 Devolução Parcial / Estorno de Materiais da Solicitação
// 🟢 NOVA ROTA ADICIONADA: Vincula a URL ao controlador de Devolução Parcial com a devida permissão
router.post('/:id/partial-return', requirePermission('solicitacoes:edit'), partialReturnRequest);

// 🗑️ Excluir / Cancelar um pedido
// Permite ao utilizador apagar o próprio pedido (Nota: o controller valida se o status ainda é 'pendente')
router.delete('/:id', requirePermission('minhas_solicitacoes:delete'), deleteRequest);

export default router;
