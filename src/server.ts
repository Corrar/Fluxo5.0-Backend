import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';

// --- Middlewares & Background Jobs ---
import { globalLimiter } from './middlewares/rateLimiters';
import { initSocket } from './config/socket';
import { startExpireRequestsJob } from './jobs/expireRequests.job';

// --- Rotas (Routers) ---
import authRouter from './routes/auth.routes';
import usersRouter from './routes/users.routes';
import productsRouter from './routes/products.routes';
import requestsRouter from './routes/requests.routes';
import stockRouter from './routes/stock.routes';
import separationsRouter from './routes/separations.routes';
import travelsRouter from './routes/travels.routes';
import replenishmentsRouter from './routes/replenishments.routes';
import systemRouter from './routes/system.routes'; 
import tasksRouter from './routes/tasks.routes';
import eletricaTasksRouter from './routes/eletrica-tasks.routes';
import remindersRouter from './routes/reminders.routes';
import officeRouter from './routes/office.routes';
import permissionsRouter from './routes/permissions.routes';
import trackingRoutes from './routes/tracking.routes';
import clientsRouter from './routes/clients.routes';

// NOVA ROTA: Módulo de Produção 3D
import producao3dRouter from './routes/producao3d.routes';

// ==========================================
// 0. EXTENSÃO DE TIPOS GLOBAIS (TYPESCRIPT)
// ==========================================
// Isto ensina ao TypeScript que todas as requisições do Express terão acesso ao Socket.io
declare global {
  namespace Express {
    interface Request {
      io?: any;
    }
  }
}

// Inicialização do aplicativo Express
const app = express();

// ==========================================
// 1. PROTEÇÕES E CONFIGURAÇÕES GLOBAIS
// ==========================================

// Necessário se o servidor estiver atrás de um proxy (ex: Vercel, Heroku, Nginx)
app.set('trust proxy', 1); 

// Helmet adiciona cabeçalhos HTTP de segurança automaticamente contra ataques XSS e Clickjacking
app.use(helmet()); 

// --- CORREÇÃO DO ERRO 413 CONTENT TOO LARGE ---
// Permite que o Express entenda o corpo das requisições no formato JSON (com limite aumentado para base64)
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Aplica limite de requisições globais para evitar sobrecarga ou ataques DDoS
app.use(globalLimiter); 

// Configuração de CORS: Define quem pode "conversar" com a sua API
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',             // Front dev (Vite) local
  'http://127.0.0.1:8080',             // Front dev local (loopback IPv4)
  'http://[::1]:8080',                 // Front dev local (loopback IPv6)
  'https://fluxo-royale.vercel.app',
  'https://fluxoroyale21.vercel.app',
  'https://fluxo-royale.com.br',       // Domínio oficial
  'https://www.fluxo-royale.com.br'    // Subdomínio oficial
];

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Permite requisições sem origem definida (ex: Postman, Insomnia, scripts do próprio server)
    if (!origin) return callback(null, true);
    
    // Verifica se a origem está na lista de permitidas
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    
    // Permite qualquer conexão que venha de desenvolvimento local (localhost, loopback ou rede interna)
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') || origin.startsWith('http://[::1]') || origin.startsWith('http://192.168.')) {
        return callback(null, true);
    }
    
    // Se não passar em nenhuma regra, bloqueia a conexão
    return callback(new Error('Bloqueio CORS: Origem não permitida'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Importante para cookies ou tokens de sessão
};
app.use(cors(corsOptions));

// ==========================================
// 2. SERVIDOR HTTP E SOCKET.IO (Tempo Real)
// ==========================================
const httpServer = createServer(app);
const io = initSocket(httpServer, corsOptions);

// Middleware personalizado para injetar o 'io' no Express.
// Isso permite usar `req.io.emit(...)` em qualquer controller.
app.use((req: Request, res: Response, next: NextFunction) => {
  req.io = io;
  next();
});

// ==========================================
// 3. CRON JOBS (Tarefas em Segundo Plano)
// ==========================================
// Tarefa agendada para expirar solicitações antigas automaticamente
startExpireRequestsJob();

// ==========================================
// 4. REGISTRO DE ROTAS (API ENDPOINTS)
// ==========================================

// Autenticação e Perfis de Acesso
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/admin/permissions', permissionsRouter);

// Core do ERP (Produtos, Estoque, Pedidos, Clientes)
app.use('/products', productsRouter);
app.use('/requests', requestsRouter);
app.use('/stock', stockRouter);
app.use('/clients', clientsRouter);

// Módulo de Produção 3D (Fábrica)
app.use('/producao-3d', producao3dRouter);

// Movimentações Avançadas e Operacional
app.use('/separations', separationsRouter);
app.use('/travel-orders', travelsRouter);
app.use('/replenishments', replenishmentsRouter);

// Tarefas, Lembretes e Escritório
app.use('/tasks', tasksRouter);
app.use('/eletrica-tasks', eletricaTasksRouter);
app.use('/reminders', remindersRouter);
app.use('/office', officeRouter);
app.use('/tracking', trackingRoutes);

// Sistema (Relatórios, Logs, Dashboards)
app.use('/', systemRouter); 

// ==========================================
// 5. ATALHOS DE RETRO-COMPATIBILIDADE
// ==========================================

// Para apontar uma rota diretamente para um Router inteiro
app.use('/manual-entry', stockRouter);
app.use('/manual-withdrawal', stockRouter);

// Redirecionamentos internos para manter compatibilidade
app.get('/my-requests', (req: Request, res: Response, next: NextFunction) => { 
    req.url = '/my'; 
    requestsRouter(req, res, next); 
});

app.post('/notifications/subscribe', (req: Request, res: Response, next: NextFunction) => { 
    req.url = '/subscribe-push'; 
    officeRouter(req, res, next); 
});

// ==========================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Fluxo Royale 2.1 Enterprise Online na porta ${PORT}`);
    console.log(`🛡️ Arquitetura Modular Ativa | Proteções RBAC e ACID Injetadas`);
});
