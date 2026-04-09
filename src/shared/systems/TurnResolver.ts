/**
 * Pure turn resolver.
 *
 * Given a MatchState + the set of PlayerActions collected during the input
 * phase, produce the next MatchState. No mutation of the input — callers get
 * a fresh object and can diff for broadcast.
 *
 * Resolution order (important — lots of interactions depend on this):
 *   1. Apply movement (bombermen commit chosen target tiles)
 *   2. Interaction pass (coin pickup, collectible pickup, body loot, escape flag)
 *   3. Place thrown bombs
 *   4. Tick fuses on all bombs; collect the ones that trigger this turn
 *   5. Resolve triggered bombs (explosions, fire, scatter) — each Bomberman
 *      takes at most 1 damage this turn regardless of how many bombs touch them
 *   6. Apply fire-tile damage for Bombermen that stepped on existing fire tiles
 *   7. Age fire and light tiles; drop expired ones
 *   8. Age bleeding counters; drop blood splatter on tiles bleeding Bombermen walked on
 *   9. Handle deaths (drop bodies, flag !alive)
 *  10. Handle escapes (flag escaped, remove from board)
 *  11. Check match-end conditions
 */

import { BALANCE } from '../config/balance.ts';
import { BOMB_CATALOG } from '../config/bombs.ts';
import type {
  CoinBag, CollectibleBomb, DroppedBody, MatchState, PlayerAction,
} from '../types/match.ts';
import type { BombermanState, BombInventory, BombSlot } from '../types/bomberman.ts';
import type { BombInstance, FireTile, LightTile, BombType } from '../types/bombs.ts';
import type { MapData } from '../types/map.ts';
import { TileType } from '../types/map.ts';
import { resolveBombTrigger, type Tile } from './BombResolver.ts';

let bombIdCounter = 0;
let bodyIdCounter = 0;
function nextBombId(): string { return `b${++bombIdCounter}`; }
function nextBodyId(): string { return `body${++bodyIdCounter}`; }

/**
 * Clone only the bits of state we'll mutate. The map itself is treated as
 * read-only and is passed separately so we can validate target tiles.
 */
function cloneState(s: MatchState): MatchState {
  return {
    ...s,
    bombermen: s.bombermen.map(b => ({ ...b, inventory: cloneInventory(b.inventory) })),
    coinBags: s.coinBags.map(c => ({ ...c })),
    collectibleBombs: s.collectibleBombs.map(c => ({ ...c })),
    bodies: s.bodies.map(b => ({ ...b, bombs: b.bombs.map(bb => ({ ...bb })) })),
    bombs: s.bombs.map(b => ({ ...b })),
    fireTiles: s.fireTiles.map(f => ({ ...f })),
    lightTiles: s.lightTiles.map(l => ({ ...l })),
    bloodTiles: s.bloodTiles.map(t => ({ ...t })),
    escapeTiles: s.escapeTiles.map(t => ({ ...t })),
    escapedPlayerIds: s.escapedPlayerIds ? [...s.escapedPlayerIds] : undefined,
  };
}

function cloneInventory(inv: BombInventory): BombInventory {
  return { slots: inv.slots.map(s => (s ? { ...s } : null)) };
}

/** Read-only walkability lookup. Floors only. */
function isWalkable(map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const row = map.grid[y];
  if (!row) return false;
  return row[x] === TileType.FLOOR;
}

/** Chebyshev distance — diagonal moves cost 1. */
function chebyshevDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export interface TurnResolveResult {
  state: MatchState;
  /** Per-player summary of what happened this turn, for client animation. */
  events: TurnEvent[];
}

export type TurnEvent =
  | { kind: 'moved'; playerId: string; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'idle'; playerId: string; x: number; y: number }
  | { kind: 'throw'; playerId: string; bombId: string; type: BombType; fromX: number; fromY: number; x: number; y: number }
  | { kind: 'bomb_triggered'; bombId: string; type: BombType; x: number; y: number; tiles: Tile[] }
  | { kind: 'damaged'; playerId: string; hpRemaining: number }
  | { kind: 'died'; playerId: string; x: number; y: number }
  | { kind: 'escaped'; playerId: string }
  | { kind: 'coin_collected'; playerId: string; amount: number }
  | { kind: 'body_looted'; playerId: string; bodyId: string; coins: number };

export function resolveTurn(
  prev: MatchState,
  actions: Map<string, PlayerAction>,
  map: MapData,
): TurnResolveResult {
  const state = cloneState(prev);
  const events: TurnEvent[] = [];

  // Only alive, non-escaped Bombermen can act
  const actors = state.bombermen.filter(b => b.alive && !b.escaped);

  // --- 1. Movement ---
  for (const bomberman of actors) {
    const action = actions.get(bomberman.playerId) ?? { kind: 'idle' };
    if (action.kind !== 'move') continue;

    const dist = chebyshevDistance(bomberman.x, bomberman.y, action.x, action.y);
    if (dist === 1 && isWalkable(map, action.x, action.y)) {
      const fromX = bomberman.x;
      const fromY = bomberman.y;
      bomberman.x = action.x;
      bomberman.y = action.y;
      events.push({ kind: 'moved', playerId: bomberman.playerId, fromX, fromY, toX: action.x, toY: action.y });
      if (bomberman.bleedingTurns > 0) {
        state.bloodTiles.push({ x: action.x, y: action.y });
      }
    } else {
      // Invalid move — treated as idle
      events.push({ kind: 'idle', playerId: bomberman.playerId, x: bomberman.x, y: bomberman.y });
    }
  }

  // Emit idle events for actors that didn't move and didn't throw
  for (const bomberman of actors) {
    const action = actions.get(bomberman.playerId);
    if (!action || action.kind === 'idle') {
      events.push({ kind: 'idle', playerId: bomberman.playerId, x: bomberman.x, y: bomberman.y });
    }
  }

  // --- 2. Interaction pass (auto-collect coins + escape; bomb looting is manual) ---
  for (const bomberman of actors) {
    if (!bomberman.alive) continue;

    // Coin bags — auto-collect on walk-over
    const coinIdx = state.coinBags.findIndex(c => c.x === bomberman.x && c.y === bomberman.y);
    if (coinIdx >= 0) {
      const bag = state.coinBags[coinIdx];
      bomberman.coins += bag.amount;
      events.push({ kind: 'coin_collected', playerId: bomberman.playerId, amount: bag.amount });
      state.coinBags.splice(coinIdx, 1);
    }

    // Body coins — auto-transfer on walk-over (bombs are looted manually via loot panel)
    const bodyIdx = state.bodies.findIndex(b => b.x === bomberman.x && b.y === bomberman.y);
    if (bodyIdx >= 0) {
      const body = state.bodies[bodyIdx];
      if (body.coins > 0) {
        bomberman.coins += body.coins;
        events.push({ kind: 'body_looted', playerId: bomberman.playerId, bodyId: body.id, coins: body.coins });
        body.coins = 0;
      }
    }

    // Escape tile
    const onEscape = state.escapeTiles.some(t => t.x === bomberman.x && t.y === bomberman.y);
    if (onEscape) {
      bomberman.escaped = true;
    }
  }

  // --- 3. Place thrown bombs ---
  // We filter damage output later so a bomb thrown this turn doesn't double-damage its owner on trigger
  for (const bomberman of actors) {
    const action = actions.get(bomberman.playerId);
    if (!action || action.kind !== 'throw') continue;
    if (!bomberman.alive) continue; // died this turn from something? shouldn't happen pre-explosion

    // Slot layout (UI + network):
    //   0         → Rock (infinite, free)
    //   1,2,3,4   → inventory.slots[0..3] (custom bombs)
    let bombType: BombType | null = null;

    if (action.slotIndex === 0) {
      bombType = 'rock';
    } else {
      const invIdx = action.slotIndex - 1;
      const slot = bomberman.inventory.slots[invIdx];
      if (slot && slot.count > 0) {
        bombType = slot.type;
        slot.count -= 1;
        if (slot.count <= 0) bomberman.inventory.slots[invIdx] = null;
      }
    }

    if (bombType == null) continue;
    // Must target a walkable tile
    if (!isWalkable(map, action.x, action.y)) continue;

    const def = BOMB_CATALOG[bombType];
    const bomb: BombInstance = {
      id: nextBombId(),
      type: bombType,
      ownerId: bomberman.playerId,
      x: action.x,
      y: action.y,
      fuseRemaining: def.fuseTurns,
    };
    state.bombs.push(bomb);
    events.push({
      kind: 'throw',
      playerId: bomberman.playerId,
      bombId: bomb.id,
      type: bombType,
      fromX: bomberman.x,
      fromY: bomberman.y,
      x: action.x,
      y: action.y,
    });
  }

  // --- 4 + 5. Tick fuses and resolve triggered bombs ---
  // Map of playerId → boolean for "took damage this turn" (caps at 1)
  const damagedThisTurn = new Set<string>();
  const triggeredBombIds = new Set<string>();

  // A worklist so scatter spawns can trigger in the same tick (rare — banana
  // children fuse 1 so they resolve next turn, but Rock scatter would fire now)
  const toResolve: BombInstance[] = [];
  for (const bomb of state.bombs) {
    if (bomb.fuseRemaining <= 0) {
      toResolve.push(bomb);
    } else {
      bomb.fuseRemaining -= 1;
    }
  }

  while (toResolve.length > 0) {
    const bomb = toResolve.shift()!;
    if (triggeredBombIds.has(bomb.id)) continue;
    triggeredBombIds.add(bomb.id);

    const trigger = resolveBombTrigger(bomb.type, bomb.x, bomb.y);

    events.push({
      kind: 'bomb_triggered',
      bombId: bomb.id,
      type: bomb.type,
      x: bomb.x,
      y: bomb.y,
      tiles: trigger.damageTiles.length > 0 ? trigger.damageTiles : trigger.fireTiles.length > 0 ? trigger.fireTiles : trigger.lightTiles,
    });

    // Damage Bombermen on damage tiles
    for (const tile of trigger.damageTiles) {
      for (const b of state.bombermen) {
        if (!b.alive || b.escaped) continue;
        if (b.x !== tile.x || b.y !== tile.y) continue;
        if (damagedThisTurn.has(b.playerId)) continue;
        damagedThisTurn.add(b.playerId);
        b.hp -= 1;
        b.bleedingTurns = BALANCE.match.bleedingDurationTurns;
        events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp });
      }
    }

    // Spawn fire tiles
    for (const tile of trigger.fireTiles) {
      state.fireTiles.push({ x: tile.x, y: tile.y, turnsRemaining: trigger.fireDuration, ownerId: bomb.ownerId });
    }

    // Spawn light tiles
    for (const tile of trigger.lightTiles) {
      state.lightTiles.push({ x: tile.x, y: tile.y, turnsRemaining: trigger.lightDuration });
    }

    // Scatter → spawn child bombs immediately; fuseTurns decides if they resolve now or next turn
    for (const spawn of trigger.scatterSpawns) {
      if (!isWalkable(map, spawn.x, spawn.y)) continue;
      const childDef = BOMB_CATALOG[spawn.type];
      const child: BombInstance = {
        id: nextBombId(),
        type: spawn.type,
        ownerId: bomb.ownerId,
        x: spawn.x,
        y: spawn.y,
        fuseRemaining: childDef.fuseTurns,
      };
      state.bombs.push(child);
      if (child.fuseRemaining <= 0) toResolve.push(child);
    }
  }

  // Remove triggered bombs from live list
  state.bombs = state.bombs.filter(b => !triggeredBombIds.has(b.id));

  // --- 6. Fire-tile standing damage (Bombermen on existing fire tiles) ---
  for (const fire of state.fireTiles) {
    for (const b of state.bombermen) {
      if (!b.alive || b.escaped) continue;
      if (b.x !== fire.x || b.y !== fire.y) continue;
      if (damagedThisTurn.has(b.playerId)) continue;
      damagedThisTurn.add(b.playerId);
      b.hp -= 1;
      b.bleedingTurns = BALANCE.match.bleedingDurationTurns;
      events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp });
    }
  }

  // --- 7. Age fire/light tiles ---
  state.fireTiles = state.fireTiles
    .map(f => ({ ...f, turnsRemaining: f.turnsRemaining - 1 }))
    .filter(f => f.turnsRemaining > 0);
  state.lightTiles = state.lightTiles
    .map(l => ({ ...l, turnsRemaining: l.turnsRemaining - 1 }))
    .filter(l => l.turnsRemaining > 0);

  // --- 8. Age bleeding ---
  for (const b of state.bombermen) {
    if (b.bleedingTurns > 0) b.bleedingTurns -= 1;
  }

  // --- 9. Deaths ---
  for (const b of state.bombermen) {
    if (b.alive && b.hp <= 0) {
      b.alive = false;
      events.push({ kind: 'died', playerId: b.playerId, x: b.x, y: b.y });
      // Drop a body with current coins + inventory
      const bombs: { type: BombType; count: number }[] = [];
      for (const slot of b.inventory.slots) {
        if (slot && slot.count > 0) bombs.push({ type: slot.type, count: slot.count });
      }
      state.bodies.push({
        id: nextBodyId(),
        x: b.x,
        y: b.y,
        ownerPlayerId: b.playerId,
        coins: b.coins,
        bombs,
      });
      b.coins = 0;
      b.inventory = { slots: [null, null, null, null] };
    }
  }

  // --- 10. Escapes (remove from future action but keep in list for scoring) ---
  for (const b of state.bombermen) {
    if (b.alive && b.escaped) {
      events.push({ kind: 'escaped', playerId: b.playerId });
    }
  }

  // --- 11. Match-end check ---
  // Match ends when: everyone is dead/escaped, OR the turn limit is reached.
  // A sole surviving Bomberman does NOT end the match — they must escape or
  // wait out the timer. Per the brief: "If Players all Escape from the Level
  // or all die the Match will end as well."
  const aliveAndActive = state.bombermen.filter(b => b.alive && !b.escaped);
  if (aliveAndActive.length === 0) {
    state.phase = 'ended';
    const anyEscaped = state.bombermen.some(b => b.escaped);
    if (anyEscaped) state.endReason = 'all_escaped';
    else state.endReason = 'all_dead';
  } else if (state.turnNumber >= BALANCE.match.turnLimit) {
    // Everyone still alive dies at the turn limit per the brief
    for (const b of aliveAndActive) {
      b.alive = false;
      events.push({ kind: 'died', playerId: b.playerId, x: b.x, y: b.y });
    }
    state.phase = 'ended';
    state.endReason = 'turn_limit';
  }

  if (state.phase === 'ended') {
    state.escapedPlayerIds = state.bombermen.filter(b => b.escaped).map(b => b.playerId);
  }

  // Bump turn counter if still active
  if (state.phase !== 'ended') {
    state.turnNumber += 1;
  }

  return { state, events };
}

/** Utility used by tests / callers to create a fresh empty inventory. */
export function buildInventoryFromSlots(slots: (BombSlot | null)[]): BombInventory {
  return { slots: [...slots] };
}

/**
 * Try to stash up to `count` of `type` into a Bomberman's 4 custom slots.
 * Fills existing matching stacks first, then uses empty slots.
 * Returns the number of bombs actually stashed.
 */
function tryStashBomb(inventory: BombInventory, type: BombType, count: number): number {
  if (count <= 0) return 0;
  const stackLimit = BALANCE.match.bombSlotStackLimit;
  let remaining = count;

  // 1. Top up matching slots
  for (let i = 0; i < 4 && remaining > 0; i++) {
    const slot = inventory.slots[i];
    if (!slot || slot.type !== type) continue;
    const room = stackLimit - slot.count;
    if (room <= 0) continue;
    const take = Math.min(room, remaining);
    slot.count += take;
    remaining -= take;
  }

  // 2. Fill empty slots
  for (let i = 0; i < 4 && remaining > 0; i++) {
    if (inventory.slots[i] != null) continue;
    const take = Math.min(stackLimit, remaining);
    inventory.slots[i] = { type, count: take };
    remaining -= take;
  }

  return count - remaining;
}
