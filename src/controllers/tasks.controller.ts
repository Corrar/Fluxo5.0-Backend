// src/controllers/tasks.controller.ts

import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

// --- TAREFAS GERAIS (KANBAN) ---
export const getTasks = async (req: Request, res: Response) => {
  try {
    // 🟢 Adicionado JOIN para buscar o código da OP vinculada
    const { rows } = await pool.query(`
      SELECT t.*, cs.op_code 
      FROM tasks t 
      LEFT JOIN client_services cs ON t.client_service_id = cs.id 
      ORDER BY t.created_at DESC
    `);
    
    res.json(rows.map((task: any) => ({ 
      ...task, 
      checklist: task.checklist || [], 
      tags: task.tags || [], 
      imageUrl: task.image_url, 
      dueDate: task.due_date, 
      createdAt: task.created_at, 
      completedAt: task.completed_at,
      opCode: task.op_code // 🟢 Retorna o número da OP para o Frontend
    })));
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar tarefas' }); }
};

export const createTask = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
  if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'gerente') return res.status(403).json({ error: 'Sem permissão.' });

  // 🟢 Recebe o op_code do frontend
  const { title, description, category, priority, checklist, tags, imageUrl, dueDate, op_code } = req.body;
  
  try {
    // 🛡️ VALIDAÇÃO DA OP
    if (!op_code) return res.status(400).json({ error: 'É obrigatório vincular a tarefa a uma OP.' });
    
    const opCheck = await pool.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
    if (opCheck.rows.length === 0) return res.status(404).json({ error: 'OP não encontrada no sistema. Verifique o número digitado.' });
    if (opCheck.rows[0].status === 'finalizada' || opCheck.rows[0].status === 'encerrada') return res.status(400).json({ error: 'Essa OP ja foi finalizada, verifique a OP correta' });
    
    const client_service_id = opCheck.rows[0].id;
    // ----------------------------------------

    // 🟢 Adicionado client_service_id no INSERT
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, description, category, priority, checklist, tags, image_url, due_date, client_service_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, description, category || 'blue', priority, JSON.stringify(checklist || []), JSON.stringify(tags || []), imageUrl || null, dueDate || null, client_service_id]
    );
    
    const newTask = { ...rows[0], checklist: rows[0].checklist || [], tags: rows[0].tags || [], imageUrl: rows[0].image_url, dueDate: rows[0].due_date, createdAt: rows[0].created_at, completedAt: rows[0].completed_at, opCode: op_code };
    
    await createLog(userId, 'CRIAR_TAREFA', { id_tarefa: newTask.id, titulo: title }, getClientIp(req));
    
    if ((req as any).io) { (req as any).io.emit('tasks_updated'); }
    res.status(201).json(newTask);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao criar tarefa' }); }
};

export const updateTask = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
  if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'gerente') return res.status(403).json({ error: 'Sem permissão.' });

  // 🟢 Recebe op_code em caso de edição
  const { title, description, category, priority, checklist, completed, tags, imageUrl, dueDate, op_code } = req.body;
  try {
    const fields: string[] = []; const values: any[] = []; let idx = 1;
    
    // 🛡️ VALIDAÇÃO DA OP SE FOR ENVIADA NA EDIÇÃO
    if (op_code !== undefined) {
      const opCheck = await pool.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
      if (opCheck.rows.length === 0) return res.status(404).json({ error: 'OP não encontrada no sistema.' });
      if (opCheck.rows[0].status === 'finalizada' || opCheck.rows[0].status === 'encerrada') return res.status(400).json({ error: 'Essa OP ja foi finalizada, verifique a OP correta' });
      
      fields.push(`client_service_id = $${idx++}`);
      values.push(opCheck.rows[0].id);
    }

    if (title !== undefined) { fields.push(`title = $${idx++}`); values.push(title); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (category !== undefined) { fields.push(`category = $${idx++}`); values.push(category); }
    if (priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(priority); }
    if (checklist !== undefined) { fields.push(`checklist = $${idx++}`); values.push(JSON.stringify(checklist)); }
    if (tags !== undefined) { fields.push(`tags = $${idx++}`); values.push(JSON.stringify(tags)); }
    if (imageUrl !== undefined) { fields.push(`image_url = $${idx++}`); values.push(imageUrl); }
    if (dueDate !== undefined) { fields.push(`due_date = $${idx++}`); values.push(dueDate); }
    if (completed !== undefined) { fields.push(`completed = $${idx++}`); values.push(completed); if (completed) fields.push(`completed_at = NOW()`); else fields.push(`completed_at = NULL`); }
    values.push(id);
    
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const { rows } = await pool.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const isMove = completed !== undefined && fields.length <= 3;
    
    await createLog(userId, isMove ? 'MOVER_TAREFA' : 'EDITAR_TAREFA', { id_tarefa: id, alteracoes: req.body }, getClientIp(req));
    
    if ((req as any).io) { (req as any).io.emit('tasks_updated'); }
    res.json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao atualizar tarefa' }); }
};

export const deleteTask = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
  if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'gerente') return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    
    await createLog(userId, 'EXCLUIR_TAREFA', { id_tarefa: id }, getClientIp(req));
    
    if ((req as any).io) { (req as any).io.emit('tasks_updated'); }
    res.json({ success: true });
  } catch (error: any) { res.status(500).json({ error: 'Erro ao excluir tarefa' }); }
};

// --- TAREFAS DA ELÉTRICA ---
const checkEletricaPermission = async (userId: string) => {
  const { rows } = await pool.query('SELECT role, sector FROM profiles WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.sector?.toLowerCase() === 'elétrica' || user.sector?.toLowerCase() === 'eletrica') return true;
  const permCheck = await pool.query('SELECT 1 FROM role_permissions WHERE role = $1 AND page_key = $2', [user.role, 'tarefas_eletrica']);
  return permCheck.rows.length > 0;
};

export const getEletricaTasks = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  if (!(await checkEletricaPermission(userId))) return res.status(403).json({ error: 'Acesso negado.' });
  try {
    // 🟢 JOIN também nas tarefas da elétrica
    const { rows } = await pool.query(`
      SELECT t.*, cs.op_code 
      FROM eletrica_tasks t 
      LEFT JOIN client_services cs ON t.client_service_id = cs.id 
      ORDER BY t.created_at DESC
    `);
    res.json(rows.map((task: any) => ({ 
      ...task, 
      checklist: task.checklist || [], 
      tags: task.tags || [], 
      imageUrl: task.image_url, 
      dueDate: task.due_date, 
      createdAt: task.created_at, 
      completedAt: task.completed_at,
      opCode: task.op_code 
    })));
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar tarefas da elétrica' }); }
};

export const createEletricaTask = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  if (!(await checkEletricaPermission(userId))) return res.status(403).json({ error: 'Sem permissão.' });
  
  // 🟢 Recebe op_code
  const { title, description, category, priority, checklist, tags, imageUrl, dueDate, op_code } = req.body;
  try {
    // 🛡️ VALIDAÇÃO DA OP
    if (!op_code) return res.status(400).json({ error: 'É obrigatório vincular a tarefa a uma OP.' });
    
    const opCheck = await pool.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
    if (opCheck.rows.length === 0) return res.status(404).json({ error: 'OP não encontrada no sistema. Verifique o número digitado.' });
    if (opCheck.rows[0].status === 'finalizada' || opCheck.rows[0].status === 'encerrada') return res.status(400).json({ error: 'Essa OP ja foi finalizada, verifique a OP correta' });
    
    const client_service_id = opCheck.rows[0].id;

    const { rows } = await pool.query(
      `INSERT INTO eletrica_tasks (title, description, category, priority, checklist, tags, image_url, due_date, client_service_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, description, category || 'blue', priority, JSON.stringify(checklist || []), JSON.stringify(tags || []), imageUrl || null, dueDate || null, client_service_id]
    );
    const newTask = { ...rows[0], checklist: rows[0].checklist || [], tags: rows[0].tags || [], imageUrl: rows[0].image_url, dueDate: rows[0].due_date, createdAt: rows[0].created_at, completedAt: rows[0].completed_at, opCode: op_code };
    
    await createLog(userId, 'CRIAR_TAREFA_ELETRICA', { setor: 'Elétrica', id_tarefa: newTask.id, titulo: title }, getClientIp(req));
    
    if ((req as any).io) (req as any).io.emit('eletrica_tasks_updated'); 
    res.status(201).json(newTask);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao criar tarefa' }); }
};

export const updateEletricaTask = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  if (!(await checkEletricaPermission(userId))) return res.status(403).json({ error: 'Sem permissão.' });
  
  const { title, description, category, priority, checklist, completed, tags, imageUrl, dueDate, op_code } = req.body;
  try {
    const fields: string[] = []; const values: any[] = []; let idx = 1;
    
    // 🛡️ VALIDAÇÃO DA OP SE FOR ENVIADA NA EDIÇÃO
    if (op_code !== undefined) {
      const opCheck = await pool.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
      if (opCheck.rows.length === 0) return res.status(404).json({ error: 'OP não encontrada no sistema.' });
      if (opCheck.rows[0].status === 'finalizada' || opCheck.rows[0].status === 'encerrada') return res.status(400).json({ error: 'Essa OP ja foi finalizada, verifique a OP correta' });
      
      fields.push(`client_service_id = $${idx++}`);
      values.push(opCheck.rows[0].id);
    }

    if (title !== undefined) { fields.push(`title = $${idx++}`); values.push(title); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (category !== undefined) { fields.push(`category = $${idx++}`); values.push(category); }
    if (priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(priority); }
    if (checklist !== undefined) { fields.push(`checklist = $${idx++}`); values.push(JSON.stringify(checklist)); }
    if (tags !== undefined) { fields.push(`tags = $${idx++}`); values.push(JSON.stringify(tags)); }
    if (imageUrl !== undefined) { fields.push(`image_url = $${idx++}`); values.push(imageUrl); }
    if (dueDate !== undefined) { fields.push(`due_date = $${idx++}`); values.push(dueDate); }
    if (completed !== undefined) { fields.push(`completed = $${idx++}`); values.push(completed); if (completed) fields.push(`completed_at = NOW()`); else fields.push(`completed_at = NULL`); }
    values.push(id);
    
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const { rows } = await pool.query(`UPDATE eletrica_tasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const isMove = completed !== undefined && fields.length <= 3;
    
    await createLog(userId, isMove ? 'MOVER_TAREFA_ELETRICA' : 'EDITAR_TAREFA_ELETRICA', { setor: 'Elétrica', id_tarefa: id, alteracoes: req.body }, getClientIp(req));
    
    if ((req as any).io) (req as any).io.emit('eletrica_tasks_updated');
    res.json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao atualizar tarefa' }); }
};

export const deleteEletricaTask = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  if (!(await checkEletricaPermission(userId))) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM eletrica_tasks WHERE id = $1', [id]);
    
    await createLog(userId, 'EXCLUIR_TAREFA_ELETRICA', { setor: 'Elétrica', id_tarefa: id }, getClientIp(req));
    
    if ((req as any).io) (req as any).io.emit('eletrica_tasks_updated');
    res.json({ success: true });
  } catch (error: any) { res.status(500).json({ error: 'Erro ao excluir tarefa' }); }
};
