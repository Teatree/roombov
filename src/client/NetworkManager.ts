import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@shared/types/messages.ts';
import { BombermanShopStore, ProfileStore } from './ClientState.ts';
import { NetworkActivity } from './NetworkActivity.ts';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;
let wiredStoreBridge = false;

/**
 * Settle handlers keyed by event name, used by NetworkActivity to drop the
 * hourglass as soon as the matching response arrives. Client code calls
 * `NetworkManager.track(label, expected)` which increments pending and
 * registers the settle fn so the next matching response resolves it.
 */
const pendingByEvent = new Map<string, Array<() => void>>();

function consumePending(eventName: string): void {
  const q = pendingByEvent.get(eventName);
  if (!q || q.length === 0) return;
  const settle = q.shift()!;
  settle();
}

export const NetworkManager = {
  /** Connect to the server. Idempotent — safe to call from every scene. */
  connect(): TypedSocket {
    if (socket?.connected) return socket;

    const url = window.location.origin;
    socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
    }) as TypedSocket;

    socket.on('connect', () => {
      console.log(`[Net] Connected: ${socket!.id}`);
      // Re-auth on every (re)connect so the server has our playerId
      const storedId = localStorage.getItem('bomberman.playerId') ?? '';
      socket!.emit('auth', { playerId: storedId });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Net] Disconnected: ${reason}`);
    });

    if (!wiredStoreBridge) {
      wiredStoreBridge = true;
      socket.on('profile', (msg) => {
        localStorage.setItem('bomberman.playerId', msg.profile.id);
        ProfileStore.set(msg.profile);
        consumePending('profile');
      });
      socket.on('bomberman_shop_cycle', (msg) => {
        BombermanShopStore.set(msg);
        consumePending('bomberman_shop_cycle');
      });
      socket.on('bombs_catalog', () => consumePending('bombs_catalog'));
      socket.on('shop_result', () => consumePending('shop_result'));
      socket.on('match_listings', () => consumePending('match_listings'));
    }

    return socket;
  },

  /**
   * Track a pending request. Pass the event name the server is expected to
   * respond with so the hourglass drops as soon as the response arrives.
   * For fire-and-forget messages, use an empty string and the activity will
   * auto-clear on timeout.
   */
  track(label: string, expectedEvent: string): void {
    const settle = NetworkActivity.begin(label);
    if (expectedEvent) {
      if (!pendingByEvent.has(expectedEvent)) pendingByEvent.set(expectedEvent, []);
      pendingByEvent.get(expectedEvent)!.push(settle);
    } else {
      // Settle after a short grace so the indicator flashes briefly
      setTimeout(settle, 300);
    }
  },

  getSocket(): TypedSocket {
    if (!socket) throw new Error('NetworkManager.connect() not called');
    return socket;
  },

  getSocketId(): string {
    return socket?.id ?? '';
  },

  isConnected(): boolean {
    return socket?.connected ?? false;
  },

  disconnect(): void {
    socket?.disconnect();
    socket = null;
    wiredStoreBridge = false;
  },
};
