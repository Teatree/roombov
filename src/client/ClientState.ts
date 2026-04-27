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
import type { GamblerStreetState } from '@shared/types/gambler-street.ts';
import { pickRandomUiAnimation, type UiAnimation } from './systems/BombermanAnimations.ts';

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
export const GamblerStreetStore = new Store<GamblerStreetState>();

/**
 * Per-owned-Bomberman UI animation lock. The preview animation (idle/idle3
 * /walk) for an OwnedBomberman stays stable across renders once picked, and
 * only changes after the player takes that Bomberman into a match — call
 * `UiAnimLock.clear(ownedId)` when entering a match to reset.
 *
 * Shop templates and non-equipped roster entries skip this store and just
 * `pickRandomUiAnimation()` fresh on every render — "different every time
 * Player opens the Bomberman shop."
 */
class UiAnimLockStore {
  private map = new Map<string, UiAnimation>();
  get(ownedId: string): UiAnimation {
    let v = this.map.get(ownedId);
    if (!v) {
      v = pickRandomUiAnimation();
      this.map.set(ownedId, v);
    }
    return v;
  }
  clear(ownedId: string): void { this.map.delete(ownedId); }
}
export const UiAnimLock = new UiAnimLockStore();
