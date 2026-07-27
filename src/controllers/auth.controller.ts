import { Request, Response } from 'express';
import { pool } from '../db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { roleExistsInRbac } from '../services/rbac';

// Define a chave secreta do JWT (Use variáveis de ambiente em produção)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { throw new Error('JWT_SECRET ausente no ambiente — abortando boot por segurança'); }

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

    // NUNCA devolver a linha crua de users: ela carrega o hash bcrypt (encrypted_password)
    // e métricas internas (total_minutes, last_active). O front só usa id/email.
    const safeUser = { id: user.id, email: user.email };

    // O RETURN final garante que o Express encerre a requisição entregando os dados
    return res.json({ token, user: safeUser, profile: profiles[0], permissions: userPermissions });
    
  } catch (error: any) {
    console.error("Erro no login:", error);
    return res.status(500).json({ error: 'Erro interno ao tentar fazer login. Tente novamente mais tarde.' });
  }
};


/**
 * Função para gerenciar o Registro de novos usuários.
 * Rota FECHADA atrás de authenticate + canManageUsers (só admin cria conta).
 *
 * ⚠ BOOTSTRAP: como não existe mais auto-cadastro, o PRIMEIRO admin de um ambiente
 * novo tem de ser semeado direto no banco (seed/SQL) — sem ele ninguém passa no gate.
 */
export const register = async (req: Request, res: Response): Promise<Response | void> => {
  const { email, password, name, role, sector } = req.body;

  // Validação na borda: nada de INSERT com campo faltando/quebrado.
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }
  // Mesma allowlist RBAC do PUT /users/:id/role: só papéis que existem na matriz.
  if (!(await roleExistsInRbac(role))) {
    return res.status(400).json({ error: 'cargo inválido' });
  }

  // Inicia um client dedicado para podermos usar transações (BEGIN/COMMIT/ROLLBACK)
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Inicia a transação

    // Verifica se o e-mail já existe no sistema
    const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
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
      [cleanEmail, encryptedPassword]
    );
    const newUserId = userRes.rows[0].id;

    // Insere o perfil na tabela 'profiles' usando UPSERT (ON CONFLICT)
    await client.query(
      `INSERT INTO profiles (id, name, role, sector) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, sector = EXCLUDED.sector`,
      [newUserId, name, role, sector]
    );

    // Auditoria INCONDICIONAL: a rota exige autenticação, então req.user sempre existe.
    await createLog((req as any).user.id, 'CREATE_USER', { target_user_id: newUserId, role, name }, getClientIp(req), client);

    // Confirma as inserções no banco
    await client.query('COMMIT');
    return res.status(201).json({ success: true, id: newUserId, message: 'Usuário registrado com sucesso!' });
    
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
