import type { MatchBackend } from './MatchBackend.ts';
import { NetworkManager } from '../NetworkManager.ts';
import type { MatchState, PlayerAction } from '@shared/types/match.ts';
import type { TurnEvent } from '@shared/systems/TurnResolver.ts';
import type { LootBombMsg, MatchEndMsg } from '@shared/types/messages.ts';

/**
 * Real-match backend. Thin wrapper around the shared socket.io connection —
 * every call forwards to / from `NetworkManager.getSocket()`.
 *
 * This is a behavior-preserving extraction of the wiring that used to live
 * inline in `MatchScene.create()` / `shutdown()`. Care is taken to register
 * and unregister the same events with the same payload shapes, so live
 * matches behave identically with the backend layer in place.
 */
export class SocketMatchBackend implements MatchBackend {
  private stateCb: ((state: MatchState) => void) | null = null;
  private turnCb: ((events: TurnEvent[]) => void) | null = null;
  private endCb: ((msg: MatchEndMsg) => void) | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const socket = NetworkManager.getSocket();
    socket.on('match_state', (msg) => this.stateCb?.(msg.state));
    socket.on('turn_result', (msg) => this.turnCb?.(msg.events));
    socket.on('match_end', (msg) => this.endCb?.(msg));
  }

  sendAction(action: PlayerAction): void {
    NetworkManager.getSocket().emit('player_action', { action });
  }

  sendLoot(msg: LootBombMsg): void {
    NetworkManager.getSocket().emit('loot_bomb', msg);
  }

  onMatchState(cb: (state: MatchState) => void): void {
    this.stateCb = cb;
  }

  onTurnResult(cb: (events: TurnEvent[]) => void): void {
    this.turnCb = cb;
  }

  onMatchEnd(cb: (msg: MatchEndMsg) => void): void {
    this.endCb = cb;
  }

  destroy(): void {
    if (!this.started) return;
    const socket = NetworkManager.getSocket();
    socket.off('match_state');
    socket.off('turn_result');
    socket.off('match_end');
    this.stateCb = null;
    this.turnCb = null;
    this.endCb = null;
    this.started = false;
  }
}
