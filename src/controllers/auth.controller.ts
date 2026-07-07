import { Request, Response } from 'express';
import { pool } from '../db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

// Define a chave secreta do JWT (Use variáveis de ambiente em produção)
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta';

/**
 * Função para gerenciar o Login do usuário
 * @param req Objeto de requisição do Express
 * @param res Objeto de resposta do Express
 */
export const login = async (req: Request, res: Response): Promise<Response | void> => {
  const { email, password } = req.body;
  
  try {
    // Busca o usuário pelo e-mail
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];

    // Validação 1: Verifica se o usuário existe
    if (!user) {
        return res.status(400).json({ error: 'Usuário não encontrado' });
    }
    
    // Validação 2: Verifica se a conta está ativa
    if (user.is_active === false) {
        return res.status(403).json({ error: 'Acesso bloqueado. Conta suspensa pelo administrador.' });
    }

    // Validação 3: Verifica se a senha está correta usando o bcrypt
    const validPassword = await bcrypt.compare(password, user.encrypted_password);
    if (!validPassword) {
        return res.status(400).json({ error: 'Senha incorreta' });
    }

    // 1. PRIMEIRO PASSO: Buscar o perfil (onde está o cargo/role) ANTES de criar o Token
    let { rows: profiles } = await pool.query('SELECT * FROM profiles WHERE id = $1', [user.id]);
    
    if (profiles.length === 0) {
      // Cria um perfil padrão caso o usuário recém-criado não tenha um
      const defaultName = user.email.split('@')[0];
      const insertRes = await pool.query(
        `INSERT INTO profiles (id, name, role, sector) VALUES ($1, $2, 'setor', 'Geral') RETURNING *`,
        [user.id, defaultName]
      );
      profiles = insertRes.rows;
    }

    // 2. SEGUNDO PASSO: Criar o Token agora, injetando a 'role' que buscamos
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: profiles[0].role
      }, 
      JWT_SECRET, 
      { expiresIn: '1d' }
    );

    // 3. TERCEIRO PASSO (A CORREÇÃO): Buscar permissões combinadas (Cargo + Exceções do Usuário)
    // O UNION junta as duas listas e remove automaticamente as repetições
    const permRes = await pool.query(`
      SELECT page_key FROM role_permissions WHERE role = $1
      UNION
      SELECT page_key FROM user_permissions WHERE user_id = $2
    `, [profiles[0].role, user.id]);
    
    // Transformamos o resultado do banco num array simples de strings. Ex: ['dashboard', 'produtos:editar']
    const userPermissions = permRes.rows.map((r: { page_key: string }) => r.page_key);
    
    // Registra o login no sistema de auditoria
    await createLog(user.id, 'LOGIN', { message: 'Login realizado' }, getClientIp(req));

    // O RETURN final garante que o Express encerre a requisição entregando os dados
    return res.json({ token, user, profile: profiles[0], permissions: userPermissions });
    
  } catch (error: any) {
    console.error("Erro no login:", error);
    return res.status(500).json({ error: 'Erro interno ao tentar fazer login. Tente novamente mais tarde.' });
  }
};


/**
 * Função para gerenciar o Registro de novos usuários
 * @param req Objeto de requisição do Express
 * @param res Objeto de resposta do Express
 */
export const register = async (req: Request, res: Response): Promise<Response | void> => {
  const { email, password, name, role, sector } = req.body;
  
  // Inicia um client dedicado para podermos usar transações (BEGIN/COMMIT/ROLLBACK)
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN'); // Inicia a transação
    
    // Verifica se o e-mail já existe no sistema
    const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      // Correção: A mensagem foi alterada para ficar mais clara
      return res.status(400).json({ error: 'Este e-mail já está em uso por outro usuário.' });
    }
    
    // Criptografa a senha
    const salt = await bcrypt.genSalt(10);
    const encryptedPassword = await bcrypt.hash(password, salt);
    
    // Insere o usuário na tabela 'users'
    const userRes = await client.query(
      'INSERT INTO users (email, encrypted_password, is_active) VALUES ($1, $2, true) RETURNING id',
      [email, encryptedPassword]
    );
    const newUserId = userRes.rows[0].id;

    // Insere o perfil na tabela 'profiles' usando UPSERT (ON CONFLICT)
    await client.query(
      `INSERT INTO profiles (id, name, role, sector) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, sector = EXCLUDED.sector`,
      [newUserId, name, role, sector]
    );

    // Cria o log caso exista um usuário logado criando este novo registro (ex: um admin)
    const reqUser = (req as any).user;
    if (reqUser) {
        await createLog(reqUser.id, 'CREATE_USER', { target_user_id: newUserId, role, name }, getClientIp(req), client);
    }

    // Confirma as inserções no banco
    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: 'Usuário registrado com sucesso!' });
    
  } catch (error: any) {
    // Em caso de qualquer erro, desfaz tudo (ROLLBACK)
    try { await client.query('ROLLBACK'); } catch(e) { console.error("Erro no rollback:", e); }
    console.error("Erro no registro:", error);
    return res.status(500).json({ error: 'Erro interno ao registrar usuário.' });
  } finally {
    // Libera a conexão para o pool (MUITO IMPORTANTE para não travar o servidor)
    client.release();
  }
};
