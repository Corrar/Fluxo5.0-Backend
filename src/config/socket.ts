// src/config/socket.ts — Fluxo Royale 5.0
// Socket.IO com handshake autenticado (salas derivadas do JWT, não do que o cliente afirma),
// fallback legado para o 2.0 durante a transição, resync sob demanda e emissão AUTORITATIVA
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

const JWT_SECRET = process.env.JWT_SECRET;

function extractToken(socket: Socket): string | undefined {
  const fromAuth = (socket.handshake.auth as { token?: string } | undefined)?.token;
  if (fromAuth) return fromAuth;
  const header = socket.handshake.headers?.authorization;
  return typeof header === 'string' ? header.split(' ')[1] : undefined;
}

export const initSocket = (httpServer: unknown, corsOptions: unknown): typeof io => {
  io = new Server(httpServer as never, { cors: corsOptions as never });
  setLoggerIo(io);

  // Autenticação do handshake: se vier token válido, derivamos a identidade aqui.
  io.use((socket, next) => {
    const token = extractToken(socket);
    if (token && JWT_SECRET) {
      try {
        socket.data.user = jwt.verify(token, JWT_SECRET) as SocketUser;
      } catch {
        // token inválido: segue anônimo (modo legado), sem salas privilegiadas.
      }
    }
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Salas derivadas do TOKEN — fonte da verdade no servidor.
    // Mantém o nome "cru" do cargo p/ compatibilidade com os emits existentes do 2.0 (io.to('almoxarife')).
    if (user?.role) {
      socket.join(user.role);
      socket.join(`user:${user.id}`);
    }

    // Compatibilidade 2.0: aceita join_room SOMENTE quando não há token (transição).
    socket.on('join_room', (room: string) => {
      if (!user && typeof room === 'string') socket.join(room);
    });

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
