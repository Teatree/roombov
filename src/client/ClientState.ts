/**
 * Tiny singleton holding the locally-authoritative "what we know about the
 * server right now" state. Every scene reads this + listens to mutations.
 *
 * Why not pass props between scenes? Phaser scenes are long-lived and the
 * profile mutates independently of scene transitions; a shared store avoids
 * prop-drilling profile updates into every scene's `init` handler.
 */

import type { PlayerProfile } from '@shared/types/player-profile.ts';
import type { BombermanShopCycleMsg } from '@shared/types/messages.ts';

type Listener = () => void;

class Store<T> {
  private value: T | null = null;
  private listeners = new Set<Listener>();

  get(): T | null { return this.value; }

  set(v: T): void {
    this.value = v;
    for (const l of this.listeners) l();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const ProfileStore = new Store<PlayerProfile>();
export const BombermanShopStore = new Store<BombermanShopCycleMsg>();
