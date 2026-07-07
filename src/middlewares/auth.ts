import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db'; // Necessário para a consulta de permissões

const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta';

// 1. CRIAMOS UMA INTERFACE PARA O REQUEST
// Isto ensina ao TypeScript que o nosso 'req' pode conter um 'user' decodificado
export interface AuthRequest extends Request {
  user?: any; 
}

/**
 * Middleware 1: Verifica se o utilizador está logado (Valida o Token JWT)
 * Deve ser o primeiro a ser chamado em qualquer rota protegida.
 */
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void | Response => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Injeta os dados do token (id, email, role) no Request para as próximas funções
    req.user = decoded; 
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado. Faça login novamente.' });
  }
};

/**
 * Middleware 2: Verifica se o utilizador tem um dos cargos (roles) permitidos.
 * Útil para rotas exclusivas de um setor (ex: authorizeRole(['financeiro', 'admin']))
 */
export const authorizeRole = (allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void | Response => {
    // 🛡️ Ignora maiúsculas e remove espaços extras
    const userRole = req.user?.role?.toLowerCase().trim(); 
    const safeAllowedRoles = allowedRoles.map(role => role.toLowerCase().trim());

    // Bloqueia se o cargo não estiver na lista permitida
    if (!userRole || !safeAllowedRoles.includes(userRole)) {
      return res.status(403).json({ 
        error: `Acesso negado. O seu cargo atual (${req.user?.role || 'Nenhum'}) não tem permissão para esta ação.` 
      });
    }
    
    // Se estiver tudo correto, permite a execução
    next();
  };
};

/**
 * Middleware 3: O GUARDIÃO GRANULAR ROBUSTO (Com Raio-X)
 * Verifica se o utilizador possui a ação exata na Matriz de Permissões.
 * Exemplo de uso: requirePermission('produtos:delete')
 */
export const requirePermission = (requiredAction: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void | Response> => {
    try {
      const userId = req.user?.id;
      const userRole = req.user?.role;

      if (!userId || !userRole) {
        return res.status(401).json({ error: 'Utilizador não identificado na requisição.' });
      }

      // 🛡️ Padroniza o cargo para evitar erros de letras maiúsculas/minúsculas ou espaços
      const safeRole = userRole.toLowerCase().trim();

      // 1. A Regra de Ouro: Administradores têm acesso total ao sistema
      if (safeRole === 'admin') {
        return next();
      }

      // 2. Consulta ao banco de dados em tempo real (Garante que permissões revogadas tenham efeito imediato)
      // Usamos LOWER(role) para garantir que comparações na base de dados não falham por maiúsculas
      const permRes = await pool.query(`
        SELECT page_key FROM role_permissions WHERE LOWER(role) = $1
        UNION
        SELECT page_key FROM user_permissions WHERE user_id = $2
      `, [safeRole, userId]);

      // 3. Higienização dos Dados (Evita erros de arrays do PostgreSQL ou espaços extras)
      let userPermissions: string[] = [];

      permRes.rows.forEach(row => {
        if (Array.isArray(row.page_key)) {
          // Se o banco retornar um array JSON
          const cleanArray = row.page_key.map((p: string) => p.trim());
          userPermissions = [...userPermissions, ...cleanArray];
        } else if (typeof row.page_key === 'string') {
          // Se retornar uma string normal
          userPermissions.push(row.page_key.trim());
        }
      });

      // ==========================================
      // 🛠️ RAIO-X: VERIFICAÇÃO NO TERMINAL
      // ==========================================
      console.log(`\n--- TENTATIVA DE ACESSO ---`);
      console.log(`👤 Utilizador ID: ${userId} | Cargo: ${safeRole}`);
      console.log(`🔑 Permissão Exigida: '${requiredAction}'`);
      console.log(`📋 Permissões Encontradas no Banco:`, userPermissions);
      console.log(`---------------------------\n`);

      // 4. Verificação de Segurança (limpa a ação exigida também para garantir correspondência exata)
      if (userPermissions.includes(requiredAction.trim())) {
        return next(); // Tem permissão! Continua para o Controller.
      }

      // 5. Bloqueio Sumário se tentar forçar a ação e não tiver a permissão
      return res.status(403).json({ 
        error: `Acesso bloqueado. Não possui o nível de permissão necessário (${requiredAction}) para executar esta operação.` 
      });

    } catch (error) {
      console.error("Erro no middleware requirePermission:", error);
      return res.status(500).json({ error: 'Erro interno ao validar autorizações de segurança.' });
    }
  };
};
