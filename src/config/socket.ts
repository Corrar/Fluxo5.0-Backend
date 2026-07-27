// src/config/socket.ts — Fluxo Royale 5.0
// Socket.IO com handshake autenticado e FAIL-CLOSED (salas derivadas do JWT, não do que o
// cliente afirma; sem token válido não há conexão), resync sob demanda e emissão AUTORITATIVA
// de estado (pós-commit) com carimbo monotônico — base para "atualizar imediatamente sem conflito".

import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { setLoggerIo } from '../utils/logger';

interface SocketUser {
  id: string;
  email?: string;
  role?: string;
}

interface SocketData {
  user?: SocketUser;
}

// Mapas de eventos deixados livres (any) para conviver com os emits não-tipados do 2.0;
// a tipagem forte fica onde importa: os payloads dos helpers (StockStatePayload etc.).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: Server<any, any, any, SocketData>;

function extractToken(socket: Socket): string | undefined {
  const fromAuth = (socket.handshake.auth as { token?: string } | undefined)?.token;
  if (fromAuth) return fromAuth;
  const header = socket.handshake.headers?.authorization;
  return typeof header === 'string' ? header.split(' ')[1] : undefined;
}

export const initSocket = (httpServer: unknown, corsOptions: unknown): typeof io => {
  // Fail-fast: sem segredo não há como distinguir um socket legítimo de um forjado, e o
  // transporte inteiro cairia em modo aberto. Mesmo contrato de boot do middlewares/auth.ts.
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET ausente no ambiente — abortando boot do socket por segurança');
  }

  io = new Server(httpServer as never, { cors: corsOptions as never });
  setLoggerIo(io);

  // Autenticação do handshake, FAIL-CLOSED: a identidade sai do JWT ou a conexão não acontece.
  // Sem token e token inválido devolvem a MESMA mensagem — o cliente não descobre qual dos dois é.
  io.use((socket, next) => {
    const token = extractToken(socket);
    if (!token) return next(new Error('Autenticação requerida'));
    try {
      socket.data.user = jwt.verify(token, JWT_SECRET) as SocketUser;
      return next();
    } catch {
      return next(new Error('Autenticação requerida'));
    }
  });

  io.on('connection', (socket) => {
    // Garantido pelo io.use acima: só chega aqui socket com JWT válido.
    const user = socket.data.user as SocketUser;

    // Salas derivadas do TOKEN — fonte da verdade no servidor. O cliente não escolhe sala:
    // não existe mais handler de join_room (era o furo nº 11 — qualquer anônimo pedia 'admin').
    // Mantém o nome "cru" do cargo p/ compatibilidade com os emits existentes do 2.0 (io.to('almoxarife')).
    socket.join(`user:${user.id}`);
    if (user.role) socket.join(user.role);

    // Resync sob demanda (reconexão / PWA que ficou offline): cliente confirma e refaz o GET autoritativo.
    socket.on('resync', (_payload: unknown, ack?: (ok: boolean) => void) => {
      if (typeof ack === 'function') ack(true);
    });

    socket.on('disconnect', () => { /* noop */ });
  });

  return io;
};

export const getIo = (): typeof io => {
  if (!io) throw new Error('Socket.io não inicializado!');
  return io;
};

export interface StockStatePayload {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}

/** Emissão autoritativa de saldo (pós-commit): manda o estado novo + carimbo p/ o cliente reconciliar. */
export const emitStockState = (items: StockStatePayload[]): void => {
  if (!io || items.length === 0) return;
  io.emit('stock_state', { at: Date.now(), items });
};

/** Emissão autoritativa de um recurso de fluxo (separação/solicitação) já com a nova version. */
export const emitResourceState = (
  resource: 'separation' | 'request',
  payload: { id: string; version: number; status: string } & Record<string, unknown>,
): void => {
  if (!io) return;
  io.emit(`${resource}_state`, { at: Date.now(), ...payload });
};
