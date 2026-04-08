import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@shared/types/messages.ts';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;

export const NetworkManager = {
  /** Connect to the server. Call once at app startup. */
  connect(): TypedSocket {
    if (socket?.connected) return socket;

    // In production, connect to same origin. In dev, Vite proxies or we connect to :3000.
    const url = window.location.origin;
    socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
    }) as TypedSocket;

    socket.on('connect', () => {
      console.log(`[Net] Connected: ${socket!.id}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Net] Disconnected: ${reason}`);
    });

    return socket;
  },

  /** Get the socket (must call connect() first) */
  getSocket(): TypedSocket {
    if (!socket) throw new Error('NetworkManager.connect() not called');
    return socket;
  },

  /** Get this client's socket ID */
  getSocketId(): string {
    return socket?.id ?? '';
  },

  /** Check if connected */
  isConnected(): boolean {
    return socket?.connected ?? false;
  },

  /** Disconnect and cleanup */
  disconnect(): void {
    socket?.disconnect();
    socket = null;
  },
};
