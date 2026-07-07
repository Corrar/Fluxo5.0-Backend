import webpush from 'web-push';
import { pool } from '../db';

export const sendPushNotificationToRole = async (
  role: string, 
  title: string, 
  message: string, 
  url: string = '/requests', 
  uniqueId?: string
) => {
  try {
    // ==========================================
    // 🚀 INTEGRAÇÃO COM WHATSAPP (VIA GREEN API)
    // Perfeito para Render/Cloud usando Variáveis de Ambiente
    // ==========================================
    if (role === 'almoxarife') {
      
      // Buscamos os dados de forma segura das configurações do seu servidor (Render)
      const idInstance = process.env.GREEN_API_ID; 
      const apiTokenInstance = process.env.GREEN_API_TOKEN;
      const numeroAlmoxarifado = process.env.ALMOXARIFADO_PHONE;

      // Só executa se todas as variáveis de ambiente existirem
      if (idInstance && apiTokenInstance && numeroAlmoxarifado) {
        
        const greenApiUrl = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;

        // Montamos o texto da mensagem incluindo o link de acesso rápido (com negrito e emoji)
        const textoZap = `*🔔 NOVA SOLICITAÇÃO!*\n\n*${title}*\n${message}\n\n🚀 *Acesse o sistema para conferir:*\nhttps://fluxo-royale.vercel.app/auth`;

        // Requisição para a Green API
        fetch(greenApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chatId: numeroAlmoxarifado, 
            message: textoZap
          })
        })
        .then(res => {
            if (res.ok) console.log(`✅ [WhatsApp] Alerta enviado ao Almoxarifado via Green API!`);
            else console.error(`❌ [WhatsApp] Erro na Green API. Status Code: ${res.status}`);
        })
        .catch(err => console.error(`❌ [WhatsApp] Falha de conexão com a Green API:`, err));
      } else {
        console.warn('⚠️ [WhatsApp] Alerta não enviado: Variáveis de ambiente (GREEN_API_ID, etc) não configuradas.');
      }
    }
    // ==========================================


    // ==========================================
    // 🌐 NOTIFICAÇÕES WEB PUSH (Originais do seu sistema)
    // ==========================================
    let query = `
      SELECT ps.subscription 
      FROM push_subscriptions ps
      JOIN profiles p ON ps.user_id::uuid = p.id
      WHERE p.role = $1
    `;
    let params: any[] = [role];
    
    if (role === 'almoxarife') {
       query = `SELECT ps.subscription FROM push_subscriptions ps JOIN profiles p ON ps.user_id::uuid = p.id WHERE p.role IN ('almoxarife', 'admin')`;
       params = [];
    } else if (role === 'compras') {
       query = `SELECT ps.subscription FROM push_subscriptions ps JOIN profiles p ON ps.user_id::uuid = p.id WHERE p.role IN ('compras', 'admin')`;
       params = [];
    }

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return;

    const notificationTag = uniqueId ? `fluxo-alert-${uniqueId}` : `fluxo-alert-${Date.now()}`;
    const payload = JSON.stringify({
      title, body: message, url, icon: '/favicon.png', tag: notificationTag, renotify: true, priority: 'high'
    });

    const CHUNK_SIZE = 50; 
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const promises = chunk.map(async (row) => {
        try {
          await webpush.sendNotification(row.subscription, payload);
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
             try { await pool.query('DELETE FROM push_subscriptions WHERE subscription::text = $1', [JSON.stringify(row.subscription)]); } catch(e) {}
          }
        }
      });
      await Promise.all(promises);
    }
  } catch (error) {
    console.error("Falha no envio de Push:", error);
  }
};
