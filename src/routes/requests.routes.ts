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

// 🗑️ Cancelar um pedido (NÃO apaga: o controller faz UPDATE para status 'rejeitado')
//
// O que este comentário dizia antes era FALSO nos dois pontos, e a UI foi desenhada em cima disso:
//  - "permite ao utilizador apagar o próprio pedido" — NÃO HÁ CHECAGEM DE OWNERSHIP. O controller
//    exige cargo admin OU almoxarife e mais nada: qualquer um dos dois cancela o pedido de qualquer
//    pessoa. O solicitante comum não cancela nem o próprio (toma 403 no cargo).
//  - "o controller valida se o status ainda é 'pendente'" — o guard é uma BLOCKLIST, não 'pendente':
//    barra 'rejeitado'/'entregue'/'devolvido' e aceita 'aberto', 'aprovado' E 'conferido'.
// Ver a dívida "ownership no cancelamento de solicitação" em DIVIDAS.md.
router.delete('/:id', requirePermission('minhas_solicitacoes:delete'), deleteRequest);

export default router;
