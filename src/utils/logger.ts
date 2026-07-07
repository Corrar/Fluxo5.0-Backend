import { pool } from '../db';

let ioInstance: any = null;

export const setLoggerIo = (io: any) => {
    ioInstance = io;
};

export const createLog = async (userId: string | null, action: string, details: object, ip: string, dbClient: any = pool) => {
  try {
    const insertResult = await dbClient.query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, action, JSON.stringify(details), ip]
    );

    const fullLogQuery = `
      SELECT a.id, a.action, a.details, a.created_at, a.ip_address,
        COALESCE(p.name, u.email, 'Usuário Removido') as user_name, 
        COALESCE(p.role::text, 'removido') as user_role
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id LEFT JOIN profiles p ON u.id = p.id
      WHERE a.id = $1
    `;
    const fullLogResult = await dbClient.query(fullLogQuery, [insertResult.rows[0].id]);
    
    if (ioInstance) {
        ioInstance.to('admin').emit('new_audit_log', fullLogResult.rows[0]);
    }
  } catch (err) {
    console.error("Falha ao criar log de auditoria:", err);
  }
};