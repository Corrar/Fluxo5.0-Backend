import { Request, Response } from 'express';
import { pool } from '../db'; // ✨ CORREÇÃO: Adicionadas as chaves { pool }

// --- 📖 BUSCAR TODAS AS TAREFAS ---
export const getTasks = async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM dev_tasks ORDER BY start_time ASC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar tarefas de TI:', error);
    res.status(500).json({ error: 'Erro interno ao buscar as tarefas.' });
  }
};

// --- 📝 CRIAR UMA NOVA TAREFA ---
export const createTask = async (req: Request, res: Response) => {
  const { title, description, start_time, end_time, priority, status } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO dev_tasks (title, description, start_time, end_time, priority, status) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [title, description, start_time, end_time, priority || 'media', status || 'pendente']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar tarefa de TI:', error);
    res.status(500).json({ error: 'Erro interno ao criar a tarefa.' });
  }
};
