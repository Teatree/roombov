/**
 * Pure turn resolver.
 *
 * Given a MatchState + the set of PlayerActions collected during the input
 * phase, produce the next MatchState. No mutation of the input — callers get
 * a fresh object and can diff for broadcast.
 *
 * Resolution order (important — lots of interactions depend on this):
 *   1. Apply movement (bombermen commit chosen target tiles)
 *   2. Interaction pass (treasure pickup, collectible pickup, body loot, escape flag)
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
import { BOMB_CATALOG, PHOSPHORUS_FIRE_OFFSETS } from '../config/bombs.ts';
import type {
  DroppedBody, MatchState, PlayerAction,
} from '../types/match.ts';
import type { BombermanState, BombInventory, BombSlot } from '../types/bomberman.ts';
import { SCAV_CHARACTER } from '../types/bomberman.ts';
import { rollTint } from '../utils/cosmetic-color.ts';
import type {
  BombInstance, FireTile, LightTile, BombType,
  SmokeCloud, Mine, PhosphorusPending, StatusEffect,
} from '../types/bombs.ts';
import type { MapData } from '../types/map.ts';
import { TileType } from '../types/map.ts';
import { resolveBombTrigger, shapeTiles, type Tile } from './BombResolver.ts';
import { getSeeThroughTileSet, hasLineOfSight } from './LineOfSight.ts';
import { findPath } from './Pathfinding.ts';
import { createSeededRandom } from '../utils/seeded-random.ts';
import {
  type TreasureBundle,
  hasAnyTreasure,
  mergeTreasures,
} from '../config/treasures.ts';

let bombIdCounter = 0;
let bodyIdCounter = 0;
let smokeIdCounter = 0;
let mineIdCounter = 0;
let phosphorusIdCounter = 0;
let shieldIdCounter = 0;
let shardIdCounter = 0;
function nextBombId(): string { return `b${++bombIdCounter}`; }
function nextBodyId(): string { return `body${++bodyIdCounter}`; }
function nextSmokeId(): string { return `smoke${++smokeIdCounter}`; }
function nextMineId(): string { return `mine${++mineIdCounter}`; }
function nextPhosphorusId(): string { return `phos${++phosphorusIdCounter}`; }
function nextShieldId(): string { return `shield${++shieldIdCounter}`; }
function nextShardId(): string { return `shard${++shardIdCounter}`; }

/** True when the bomberman's current tile is inside any active smoke cloud. */
function isInsideSmoke(state: MatchState, x: number, y: number): boolean {
  for (const c of state.smokeClouds ?? []) {
    if (c.tiles.some(t => t.x === x && t.y === y)) return true;
  }
  return false;
}

/** True if the bomberman has an active stunned status. */
function isStunned(b: BombermanState): boolean {
  return (b.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0);
}

/**
 * Pick a random 8-neighbour tile a stunned ("confused") bomberman stumbles
 * into. Returns null if every neighbor is blocked (wall / off-map / active
 * shield wall). Fire, mines, bombs, and other bombermen are VALID
 * destinations — the roguelike intent is that a confused stumble can walk
 * you into a hazard. Seeded by `matchId:turnNumber:playerId:confused` so
 * the same inputs deterministically produce the same stumble.
 */
function pickConfusedMove(
  b: BombermanState,
  state: MatchState,
  map: MapData,
): { x: number; y: number } | null {
  const seed = hashString(`${state.matchId}:${state.turnNumber}:${b.playerId}:confused`);
  const rng = createSeededRandom(seed);
  const deltas: Array<[number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];
  const candidates: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of deltas) {
    const nx = b.x + dx;
    const ny = b.y + dy;
    if (isPassable(state, map, nx, ny)) candidates.push({ x: nx, y: ny });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}

/** Bomb types that do NOT break Out-of-Combat Rush when thrown. */
const NON_RUSH_BREAKING_BOMBS = new Set<BombType>([
  'flare',
  'ender_pearl',
  'motion_detector_flare',
  'fart_escape',
]);

/**
 * Clone only the bits of state we'll mutate. The map itself is treated as
 * read-only and is passed separately so we can validate target tiles.
 */
function cloneState(s: MatchState): MatchState {
  return {
    ...s,
    bombermen: s.bombermen.map(b => ({
      ...b,
      inventory: cloneInventory(b.inventory),
      statusEffects: (b.statusEffects ?? []).map(e => ({ ...e })),
      queuedPath: b.queuedPath ? b.queuedPath.map(t => ({ ...t })) : undefined,
    })),
    chests: s.chests.map(c => ({ ...c, bombs: c.bombs.map(b => ({ ...b })) })),
    doors: (s.doors ?? []).map(d => ({ ...d, tiles: d.tiles.map(t => ({ ...t })) })),
    bodies: s.bodies.map(b => ({ ...b, bombs: b.bombs.map(bb => ({ ...bb })) })),
    bombs: s.bombs.map(b => ({ ...b })),
    fireTiles: s.fireTiles.map(f => ({ ...f })),
    lightTiles: s.lightTiles.map(l => ({ ...l })),
    flares: s.flares.map(f => ({ ...f })),
    bloodTiles: s.bloodTiles.map(t => ({ ...t })),
    escapeTiles: s.escapeTiles.map(t => ({ ...t })),
    brokenHatches: (s.brokenHatches ?? []).map(t => ({ ...t })),
    keys: (s.keys ?? []).map(k => ({ ...k })),
    escapedPlayerIds: s.escapedPlayerIds ? [...s.escapedPlayerIds] : undefined,
    smokeClouds: (s.smokeClouds ?? []).map(c => ({ ...c, tiles: c.tiles.map(t => ({ ...t })) })),
    mines: (s.mines ?? []).map(m => ({ ...m })),
    phosphorusPending: (s.phosphorusPending ?? []).map(p => ({ ...p })),
    shieldWalls: (s.shieldWalls ?? []).map(w => ({ ...w, tiles: w.tiles.map(t => ({ ...t })) })),
    shieldShards: (s.shieldShards ?? []).map(d => ({ ...d })),
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

/** True if any active Shield Wall covers (x, y). */
function isShieldWallAt(state: MatchState, x: number, y: number): boolean {
  for (const w of state.shieldWalls ?? []) {
    for (const t of w.tiles) {
      if (t.x === x && t.y === y) return true;
    }
  }
  return false;
}

/** isWalkable + not blocked by an active Shield Wall. */
function isPassable(state: MatchState, map: MapData, x: number, y: number): boolean {
  return isWalkable(map, x, y) && !isShieldWallAt(state, x, y);
}

/**
 * BFS outward to find the nearest tile satisfying `isOk`. Walks through any
 * tile (walls included) looking for an OK destination. Used for shield-push
 * fallbacks where we MUST find somewhere to put the displaced thing.
 */
function nearestWhere(
  map: MapData,
  sx: number,
  sy: number,
  isOk: (x: number, y: number) => boolean,
): { x: number; y: number } | null {
  if (isOk(sx, sy)) return { x: sx, y: sy };
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
  visited.add(`${sx},${sy}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (isOk(nx, ny)) return { x: nx, y: ny };
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return null;
}

/** BFS outward from (sx, sy) to find the nearest walkable tile. Returns null if none found. */
function nearestWalkable(map: MapData, sx: number, sy: number): { x: number; y: number } | null {
  if (isWalkable(map, sx, sy)) return { x: sx, y: sy };
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
  visited.add(`${sx},${sy}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (isWalkable(map, nx, ny)) return { x: nx, y: ny };
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return null;
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
  | {
      kind: 'damaged';
      playerId: string;
      hpRemaining: number;
      /** Who caused this damage. Set to the bomb/mine/fire `ownerId`. Null
       *  when attribution isn't available (rare — bleed ticks would qualify
       *  if added later). Used by MatchRoom analytics to credit `damage_dealt`. */
      attackerId: string | null;
      /** Hit points removed by this event. Currently always 1 — every damage
       *  path does `hp -= 1`. Kept as a separate field so future bigger-bombs
       *  or status ticks don't need a new event kind. */
      amount: number;
    }
  | { kind: 'died'; playerId: string; x: number; y: number; killerId: string | null }
  | { kind: 'escaped'; playerId: string; treasures: TreasureBundle; hatchX: number; hatchY: number }
  | { kind: 'key_pickup'; playerId: string; x: number; y: number; source: 'floor' | 'body' | 'chest'; newCount: number }
  | { kind: 'treasures_collected'; playerId: string; treasures: TreasureBundle }
  | { kind: 'body_looted'; playerId: string; bodyId: string; treasures: TreasureBundle }
  | { kind: 'coins_picked_up'; playerId: string; amount: number; x: number; y: number; source: 'chest' | 'body' }
  | { kind: 'teleport'; playerId: string; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'door_opened'; doorId: number }
  | { kind: 'rush_changed'; playerId: string; active: boolean }
  | { kind: 'smoke_spawned'; cloudId: string; x: number; y: number; radius: number; tiles: Tile[]; ownerId: string }
  | { kind: 'smoke_expired'; cloudId: string }
  | { kind: 'mine_placed'; mineId: string; x: number; y: number; mineKind: 'motion_detector' | 'cluster'; ownerId: string }
  | { kind: 'mine_triggered'; mineId: string; x: number; y: number; mineKind: 'motion_detector' | 'cluster'; ownerId: string; triggeredBy: string | null; tiles: Tile[] }
  | { kind: 'stunned'; playerId: string; turnsRemaining: number }
  | { kind: 'stun_expired'; playerId: string }
  | { kind: 'melee_trap_changed'; playerId: string; active: boolean }
  /** Heal-class idle action applied +amount HP this turn (drives the green
   *  aura + rising-cross VFX). `hpRemaining` is the post-heal HP. */
  | { kind: 'heal_applied'; playerId: string; amount: number; hpRemaining: number; x: number; y: number }
  /** A Disguise-class bomberman finished disguising into a world object.
   *  `frame` indexes the `disguise_objects` sprite sheet. */
  | { kind: 'disguise_applied'; playerId: string; frame: number; x: number; y: number }
  /** A disguise dropped (the bomberman moved, threw, or was hit). */
  | { kind: 'disguise_removed'; playerId: string; x: number; y: number }
  /**
   * A melee counter-attack fired by a Melee-Trap-Mode bomberman.
   *   attackerId = the trap-mode defender throwing the strike
   *   victimId   = the bomberman who walked into range (or the other
   *                trap-mode bomberman in the mutual case)
   *   killed     = true when the victim's HP hit 0 (drives Die anim)
   *   intermediate — optional tile where the strike visually lands when
   *                  the victim was merely *passing through* on a rush;
   *                  when set, the Attack3 animation is timed to the
   *                  attacker's walk midpoint rather than walk end.
   */
  | { kind: 'melee_attack'; attackerId: string; victimId: string; killed: boolean; intermediate?: { x: number; y: number } }
  /** A Shield Wall has just been spawned. `tiles` are all + tiles (centre included). */
  | { kind: 'shield_wall_spawned'; wallId: string; ownerId: string; centerX: number; centerY: number; tiles: Tile[] }
  /** A Shield Wall has shattered (turnsRemaining hit 0). Decals are spawned at each tile.
   *  `shardIds[i]` is the id of the shard placed at `tiles[i]`. */
  | { kind: 'shield_wall_broken'; wallId: string; tiles: Tile[]; shardIds: string[] }
  /**
   * A Shield Wall pushed a Bomberman or unexploded bomb out of an occupied tile.
   * Subject is a bomberman if `playerId` is set, otherwise a bomb (`bombId`).
   * Drives the yellow-teleport vfx + light-gray decal on the client.
   */
  | { kind: 'shield_pushed'; wallId: string; playerId?: string; bombId?: string; fromX: number; fromY: number; toX: number; toY: number }
  /** UAV overflight fired this turn; flares were scattered across walkable
   *  tiles to reveal the whole map for the standard 3-turn flare lifetime.
   *  `tiles` is the list of flare center positions so the client can play
   *  the same flash burst VFX a player-thrown flare produces on detonation. */
  | { kind: 'uav_fired'; turnNumber: number; tiles: Tile[] }
  /** A Scavenger NPC bomberman just spawned at (x, y). Client may use this
   *  to play a subtle vfx if desired — current spec says no UI surface, so
   *  this is informational/diagnostic only. */
  | { kind: 'scav_spawned'; playerId: string; x: number; y: number };

export function resolveTurn(
  prev: MatchState,
  actions: Map<string, PlayerAction>,
  map: MapData,
): TurnResolveResult {
  const state = cloneState(prev);
  const events: TurnEvent[] = [];
  const seeThroughTiles = getSeeThroughTileSet(map);

  // Per-turn flags reset before any step runs. `teleportedThisTurn` is set in
  // step 5 when an Ender Pearl lands its thrower somewhere new; the step 2
  // escape check honors it so teleporting onto an escape hatch does NOT
  // extract same-turn — the player must stay on the hatch into the next turn.
  for (const b of state.bombermen) {
    b.teleportedThisTurn = false;
  }

  // Defensive backfill for the Idle Action fields. Real persisted/spawned
  // states always carry these, but legacy snapshots and lean test factories
  // may omit them — normalize so the idle-action gates below behave (a missing
  // class reads as the original Attack-on-idle behavior).
  for (const b of state.bombermen) {
    if (b.idleAction !== 'attack' && b.idleAction !== 'heal' && b.idleAction !== 'disguise') {
      b.idleAction = 'attack';
    }
    if (typeof b.idleStillTurns !== 'number') b.idleStillTurns = 0;
    if (typeof b.maxHp !== 'number' || b.maxHp <= 0) b.maxHp = b.hp;
  }

  // Only alive, non-escaped Bombermen can act
  const actors = state.bombermen.filter(b => b.alive && !b.escaped);

  // Stun gating: build the effective action map. Stunned bombermen are
  // "confused" — their submitted action is discarded and replaced with a
  // forced 1-tile move to a seeded-random passable 8-neighbour. They cannot
  // throw while stunned. If every neighbour is blocked they stay put.
  // Status decrement still happens at end of turn so the confusion clears
  // on the following turn.
  const effectiveActions = new Map<string, PlayerAction>();
  for (const b of actors) {
    const raw = actions.get(b.playerId) ?? { kind: 'idle' as const };
    if (isStunned(b)) {
      const stumble = pickConfusedMove(b, state, map);
      if (stumble) {
        effectiveActions.set(b.playerId, { kind: 'move', x: stumble.x, y: stumble.y });
      } else {
        effectiveActions.set(b.playerId, { kind: 'idle' });
      }
    } else {
      effectiveActions.set(b.playerId, raw);
    }
  }

  // Melee Trap exit check: trap-mode bombermen drop out BEFORE their
  // action processes when any of these hold:
  //   - action is move or throw (player actively did something)
  //   - bomberman is Stunned (flash cancels the trap for its duration)
  //   - bomberman is inside an active smoke cloud (can't set a trap from
  //     inside a smoke cloud — parallel to how smoke blinds LOS)
  // Kept in a set so later steps (entry check, mutual melee) can ignore
  // exiters cleanly.
  const exitedTrapThisTurn = new Set<string>();
  for (const b of actors) {
    if (!b.meleeTrapMode) continue;
    const act = effectiveActions.get(b.playerId) ?? { kind: 'idle' as const };
    const actedOut = act.kind === 'move' || act.kind === 'throw';
    const stunned = isStunned(b);
    const smoked = isInsideSmoke(state, b.x, b.y);
    if (actedOut || stunned || smoked) {
      b.meleeTrapMode = false;
      exitedTrapThisTurn.add(b.playerId);
      events.push({ kind: 'melee_trap_changed', playerId: b.playerId, active: false });
    }
  }

  // queuedPath consumption: if the player submitted `idle` and has a pending
  // queued path, take the head as an implicit `move` action. If they
  // submitted any other action (move/throw), drop the queue.
  for (const b of actors) {
    const act = effectiveActions.get(b.playerId) ?? { kind: 'idle' as const };
    if (!b.queuedPath || b.queuedPath.length === 0) continue;
    if (act.kind === 'idle') {
      const head = b.queuedPath[0];
      if (head) {
        // Synthesize a move action. Use rush if active and there's a second step.
        let rushTarget: { x: number; y: number } | undefined;
        if (BALANCE.match.rush.enabled && b.rushActive && b.queuedPath.length >= 2) {
          rushTarget = b.queuedPath[1];
        }
        const synth: PlayerAction = rushTarget
          ? { kind: 'move', x: head.x, y: head.y, rushX: rushTarget.x, rushY: rushTarget.y }
          : { kind: 'move', x: head.x, y: head.y };
        effectiveActions.set(b.playerId, synth);
      }
    } else {
      // Player overrode — clear queued path
      b.queuedPath = undefined;
    }
  }

  // --- Mutual Melee (start of turn, before movement) ---
  // All bombermen still in trap mode form a graph where edges exist
  // between pairs within Chebyshev 1 AND mutual line-of-sight. Each
  // trap-mode bomberman picks a single target from their LOS-visible
  // neighbor set (first-encountered, else stable tie-break) and unleashes
  // a simultaneous Attack3. Both sides deal 1 damage so mutual stand-offs
  // resolve quickly. (Smoked / stunned defenders already dropped trap
  // mode in the exit check above, so they never reach this filter.)
  const trapModeBombermen = actors.filter(b => b.meleeTrapMode);
  const meleeDamagedThisTurn = new Set<string>();
  // Closed-door tiles for LOS — reused by step-in melee below. Bombs
  // opening doors during this step-5 resolution is irrelevant here; we
  // evaluate LOS before/around movement, not during bomb bursts.
  const meleeClosedDoors = new Set<string>();
  for (const d of state.doors ?? []) {
    if (d.opened) continue;
    for (const t of d.tiles) meleeClosedDoors.add(`${t.x},${t.y}`);
  }
  // Shield walls also block sight for melee detection (they're solid obstacles).
  // Shields placed THIS turn happen later in step 5; here we only see prior-turn walls.
  const meleeShieldTiles = new Set<string>();
  for (const w of state.shieldWalls ?? []) {
    for (const t of w.tiles) meleeShieldTiles.add(`${t.x},${t.y}`);
  }
  const mts = map.tileSize;
  const canSeeTile = (fromX: number, fromY: number, toX: number, toY: number): boolean => {
    return hasLineOfSight(
      fromX * mts + mts / 2, fromY * mts + mts / 2,
      toX * mts + mts / 2, toY * mts + mts / 2,
      map.grid, mts, meleeClosedDoors, meleeShieldTiles, seeThroughTiles,
    );
  };
  if (trapModeBombermen.length >= 2) {
    const pickTarget = (self: BombermanState): BombermanState | null => {
      const candidates = trapModeBombermen.filter(o => o.playerId !== self.playerId &&
        chebyshevDistance(self.x, self.y, o.x, o.y) <= 1 &&
        canSeeTile(self.x, self.y, o.x, o.y));
      if (candidates.length === 0) return null;
      // "First in range" — we have no temporal ordering info, so pick a
      // deterministic one via a stable tie-break (lowest playerId wins).
      // This avoids unreliable randomness while keeping behavior consistent.
      candidates.sort((a, b) => a.playerId.localeCompare(b.playerId));
      return candidates[0];
    };
    for (const attacker of trapModeBombermen) {
      const target = pickTarget(attacker);
      if (!target) continue;
      if (meleeDamagedThisTurn.has(target.playerId)) continue;
      meleeDamagedThisTurn.add(target.playerId);
      target.hp -= 1;
      target.bleedingTurns = BALANCE.match.bleedingDurationTurns;
      const killed = target.hp <= 0;
      events.push({
        kind: 'melee_attack',
        attackerId: attacker.playerId,
        victimId: target.playerId,
        killed,
      });
    }
  }

  /**
   * Every tile each bomberman STEPPED ONTO this turn (including intermediate
   * rush / Fart Escape tiles, NOT including the starting tile). Mine
   * walk-over detection consumes this so a rushing bomberman can't skip
   * over a mine by using its tile as a mid-step.
   */
  const steppedTilesByPlayer = new Map<string, Array<{ x: number; y: number }>>();
  const recordStep = (playerId: string, x: number, y: number): void => {
    let arr = steppedTilesByPlayer.get(playerId);
    if (!arr) { arr = []; steppedTilesByPlayer.set(playerId, arr); }
    arr.push({ x, y });
  };

  // --- 1. Movement (supports Out of Combat Rush: two sequential 1-tile moves per turn) ---
  for (const bomberman of actors) {
    const action = effectiveActions.get(bomberman.playerId) ?? { kind: 'idle' };
    if (action.kind !== 'move') continue;

    // First move: must be adjacent (Chebyshev 1)
    const dist1 = chebyshevDistance(bomberman.x, bomberman.y, action.x, action.y);
    if (dist1 === 1 && isPassable(state, map, action.x, action.y)) {
      const fromX = bomberman.x;
      const fromY = bomberman.y;
      bomberman.x = action.x;
      bomberman.y = action.y;
      recordStep(bomberman.playerId, action.x, action.y);
      events.push({ kind: 'moved', playerId: bomberman.playerId, fromX, fromY, toX: action.x, toY: action.y });
      if (bomberman.bleedingTurns > 0) {
        state.bloodTiles.push({ x: fromX, y: fromY });
      }

      // Rush second move: if active and a second target was provided
      if (BALANCE.match.rush.enabled && bomberman.rushActive &&
          action.rushX !== undefined && action.rushY !== undefined) {
        const dist2 = chebyshevDistance(bomberman.x, bomberman.y, action.rushX, action.rushY);
        if (dist2 === 1 && isPassable(state, map, action.rushX, action.rushY)) {
          const from2X = bomberman.x;
          const from2Y = bomberman.y;
          bomberman.x = action.rushX;
          bomberman.y = action.rushY;
          recordStep(bomberman.playerId, action.rushX, action.rushY);
          events.push({ kind: 'moved', playerId: bomberman.playerId, fromX: from2X, fromY: from2Y, toX: action.rushX, toY: action.rushY });
          if (bomberman.bleedingTurns > 0) {
            state.bloodTiles.push({ x: from2X, y: from2Y });
          }
        }
      }
    } else {
      events.push({ kind: 'idle', playerId: bomberman.playerId, x: bomberman.x, y: bomberman.y });
    }
  }

  // Emit idle events for actors that didn't move and didn't throw
  for (const bomberman of actors) {
    const action = effectiveActions.get(bomberman.playerId);
    if (!action || action.kind === 'idle') {
      events.push({ kind: 'idle', playerId: bomberman.playerId, x: bomberman.x, y: bomberman.y });
    }
  }

  // --- 1.5. Key auto-pickup (floor + dead bodies) ---
  // For every tile a bomberman stepped onto this turn (including rush
  // intermediates), pick up any floor key on it (if under cap), then drain
  // any body's keys on the same tile (one at a time, up to cap).
  // Order within a tile: floor first, then body. A bomberman that crosses
  // through two key tiles in a rush will pick up both, as long as cap allows.
  // (Floor keys are tutorial-only post-NEW_META; bodies still carry keys.)
  {
    const cap = state.isTutorial
      ? BALANCE.keys.tutorialRequiredPerHatch
      : BALANCE.keys.requiredPerHatch;
    for (const [playerId, steps] of steppedTilesByPlayer) {
      const bm = state.bombermen.find(b => b.playerId === playerId);
      if (!bm || !bm.alive || bm.escaped) continue;
      for (const step of steps) {
        // Floor key
        const floorIdx = state.keys.findIndex(k => k.x === step.x && k.y === step.y);
        if (floorIdx >= 0 && (bm.keys ?? 0) < cap) {
          state.keys.splice(floorIdx, 1);
          bm.keys = (bm.keys ?? 0) + 1;
          events.push({ kind: 'key_pickup', playerId, x: step.x, y: step.y, source: 'floor', newCount: bm.keys });
        }
        // Body keys on the same tile (could be multiple bodies stacked)
        for (const body of state.bodies) {
          if (body.x !== step.x || body.y !== step.y) continue;
          while (body.keys > 0 && (bm.keys ?? 0) < cap) {
            body.keys -= 1;
            bm.keys = (bm.keys ?? 0) + 1;
            events.push({ kind: 'key_pickup', playerId, x: step.x, y: step.y, source: 'body', newCount: bm.keys });
          }
        }
      }
    }
  }

  // --- Step-in Melee ---
  // Any bomberman who stepped ONTO a tile (including intermediate rush
  // tiles) within Chebyshev-1 of a trap-mode defender AND in the
  // defender's line-of-sight gets hit. The first qualifying step wins
  // — subsequent steps by the same attacker are ignored (damage cap to
  // 1 per turn). When a mid-step triggered it, we report the intermediate
  // tile so the client can time the attacker's Attack3 to the walk's
  // halfway point. Smoked / stunned defenders already dropped trap mode
  // in the exit check so the `meleeTrapMode` filter implicitly excludes
  // them.
  for (const [attackerId, steps] of steppedTilesByPlayer) {
    if (meleeDamagedThisTurn.has(attackerId)) continue;
    const attacker = state.bombermen.find(b => b.playerId === attackerId);
    if (!attacker || !attacker.alive || attacker.escaped) continue;
    let triggered = false;
    for (let i = 0; i < steps.length && !triggered; i++) {
      const step = steps[i];
      for (const defender of state.bombermen) {
        if (defender.playerId === attackerId) continue;
        if (!defender.alive || defender.escaped) continue;
        if (!defender.meleeTrapMode) continue;
        if (chebyshevDistance(defender.x, defender.y, step.x, step.y) > 1) continue;
        // Defender must also have LOS to the specific tile the attacker
        // stepped on — this is the key rule the user asked for so that
        // "having LOS should count even for cases when the Bomberman is
        // running 2 tiles at a time" works correctly. We check each
        // individual step tile (including intermediate rush tiles)
        // against the defender's position.
        if (!canSeeTile(defender.x, defender.y, step.x, step.y)) continue;
        // Trigger attack.
        meleeDamagedThisTurn.add(attackerId);
        attacker.hp -= 1;
        attacker.bleedingTurns = BALANCE.match.bleedingDurationTurns;
        const finalStep = steps[steps.length - 1];
        const isFinal = step.x === finalStep.x && step.y === finalStep.y;
        events.push({
          kind: 'melee_attack',
          attackerId: defender.playerId,
          victimId: attackerId,
          killed: attacker.hp <= 0,
          intermediate: isFinal ? undefined : { x: step.x, y: step.y },
        });
        triggered = true;
        break;
      }
    }
  }

  // --- 2. Interaction pass (auto-collect treasures + escape; bomb looting is manual) ---
  for (const bomberman of actors) {
    if (!bomberman.alive) continue;

    // Chest treasures / coins / keys — auto-collect on walk-over. Bots clear
    // the chest the same way humans do: any leftover after a bot visit is
    // strictly the keys it couldn't fit (cap). Marked opened on first step.
    const chest = state.chests.find(c => c.x === bomberman.x && c.y === bomberman.y);
    if (chest) {
      if (hasAnyTreasure(chest.treasures)) {
        const picked: TreasureBundle = { ...chest.treasures };
        mergeTreasures(bomberman.treasures, picked);
        events.push({ kind: 'treasures_collected', playerId: bomberman.playerId, treasures: picked });
        chest.treasures = {};
      }
      if (chest.coins > 0) {
        const amount = chest.coins;
        bomberman.coins = (bomberman.coins ?? 0) + amount;
        chest.coins = 0;
        events.push({ kind: 'coins_picked_up', playerId: bomberman.playerId, amount, x: chest.x, y: chest.y, source: 'chest' });
      }
      // Chest keys — auto-pickup up to cap. Leftover stays in the chest for later visitors.
      const keyCap = state.isTutorial ? BALANCE.keys.tutorialRequiredPerHatch : BALANCE.keys.requiredPerHatch;
      while (chest.keys > 0 && (bomberman.keys ?? 0) < keyCap) {
        chest.keys -= 1;
        bomberman.keys = (bomberman.keys ?? 0) + 1;
        events.push({ kind: 'key_pickup', playerId: bomberman.playerId, x: chest.x, y: chest.y, source: 'chest', newCount: bomberman.keys });
      }
      if (!chest.opened) {
        chest.opened = true;
        // First-opener SP credit. Bots and scavs accumulate it but never
        // bank it — keeps the resolver branch-free.
        if (!bomberman.isScav) {
          bomberman.sp += BALANCE.upgrades.sp.perChestOpen;
        }
      }
    }

    // Body treasures + coins — auto-transfer on walk-over (bombs are looted manually via loot panel)
    const bodyIdx = state.bodies.findIndex(b => b.x === bomberman.x && b.y === bomberman.y);
    if (bodyIdx >= 0) {
      const body = state.bodies[bodyIdx];
      if (hasAnyTreasure(body.treasures)) {
        const picked: TreasureBundle = { ...body.treasures };
        mergeTreasures(bomberman.treasures, picked);
        events.push({ kind: 'body_looted', playerId: bomberman.playerId, bodyId: body.id, treasures: picked });
        body.treasures = {};
      }
      if (body.coins > 0) {
        const amount = body.coins;
        bomberman.coins = (bomberman.coins ?? 0) + amount;
        body.coins = 0;
        events.push({ kind: 'coins_picked_up', playerId: bomberman.playerId, amount, x: body.x, y: body.y, source: 'body' });
      }
    }

    // Escape evaluation deferred to step 9.5 (after teleport in step 5).
    // See the onHatchIdleTurns logic below — escape now requires one full
    // turn of the bomberman standing idle on the hatch tile.
  }

  // Door proximity: open doors when any alive Bomberman stands ON the door
  // OR directly IN FRONT/BEHIND it — axis-adjacent on one of its two front
  // tiles. The trigger set is:
  //   - Every door tile itself (closed doors are walkable per current map
  //     semantics, so a player walking ONTO a door opens it).
  //   - Vertical door (tiles stacked along y): the bottom pair's east/west
  //     neighbours — two to the left, two to the right.
  //   - Horizontal door (tiles along x, expected length 2): both tiles'
  //     north/south neighbours — two above, two below.
  // Corner/diagonal tiles are deliberately excluded. Explosions that
  // overlap door tiles still open them (handled in the bomb-burst step).
  for (const door of state.doors ?? []) {
    if (door.opened) continue;
    if (door.tiles.length === 0) continue;
    const triggers: Array<{ x: number; y: number }> = [];
    // Door tiles themselves trigger.
    for (const t of door.tiles) triggers.push({ x: t.x, y: t.y });
    if (door.orientation === 'vertical') {
      // Bottom 2 tiles (largest y) are the front; trigger on their east/west
      // neighbours only. Guard short doors by taking all tiles.
      const sorted = [...door.tiles].sort((a, b) => b.y - a.y);
      const front = sorted.slice(0, Math.min(2, sorted.length));
      for (const t of front) {
        triggers.push({ x: t.x - 1, y: t.y });
        triggers.push({ x: t.x + 1, y: t.y });
      }
    } else {
      for (const t of door.tiles) {
        triggers.push({ x: t.x, y: t.y - 1 });
        triggers.push({ x: t.x, y: t.y + 1 });
      }
    }
    const opener = actors.find(b =>
      b.alive && !b.escaped &&
      triggers.some(t => t.x === b.x && t.y === b.y),
    );
    if (opener) {
      door.opened = true;
      events.push({ kind: 'door_opened', doorId: door.id });
      console.log(`[TurnResolver] door ${door.id} opened by proximity: ${opener.playerId} at (${opener.x},${opener.y})`);
    }
  }

  // --- 2b. Out of Combat Rush state update ---
  if (BALANCE.match.rush.enabled) {
    const rushCfg = BALANCE.match.rush;
    for (const bomberman of actors) {
      if (!bomberman.alive || bomberman.escaped) continue;
      const action = effectiveActions.get(bomberman.playerId) ?? { kind: 'idle' };
      // Non-rush-breaking bomb types (Flare, Ender Pearl, Motion Detector
      // Flare, Fart Escape) are thrown without cancelling rush.
      let threw = action.kind === 'throw';
      if (threw && action.kind === 'throw') {
        // Determine the bomb type from the slot. Slot 0 = rock (always breaks).
        if (action.slotIndex >= 1 && action.slotIndex <= bomberman.inventory.slots.length) {
          const slot = bomberman.inventory.slots[action.slotIndex - 1];
          if (slot && NON_RUSH_BREAKING_BOMBS.has(slot.type)) threw = false;
        }
      }
      // Smoke cloud exception: inside an active smoke cloud the bomberman
      // does not trigger enemy-proximity rush-break.
      const insideSmoke = isInsideSmoke(state, bomberman.x, bomberman.y);
      // Enemy proximity breaks rush only when the two Bombermen have mutual
      // line of sight. `hasLineOfSight` is symmetric on a wall grid — if A
      // can see B, B can see A — so one call covers "both must see each
      // other". This stops flare-discovered enemies (you see them, they
      // don't see you) from nuking your rush.
      const ts = map.tileSize;
      // Closed doors block LoS. Re-compute per-turn (cheap; few doors).
      const closedDoorsForLos = new Set<string>();
      for (const d of state.doors ?? []) {
        if (d.opened) continue;
        for (const t of d.tiles) closedDoorsForLos.add(`${t.x},${t.y}`);
      }
      const shieldTilesForLos = new Set<string>();
      for (const w of state.shieldWalls ?? []) {
        for (const t of w.tiles) shieldTilesForLos.add(`${t.x},${t.y}`);
      }
      // Inside smoke → enemy proximity doesn't break rush (per design).
      // Enemy "nearby" means mutual LOS — both Bombermen must be able to
      // see each other. LOS geometry is symmetric, so checking one side is
      // enough, but the check is capped at the fog sight radius so an
      // enemy that sits behind the player's fog (even with clear
      // geometric LOS) doesn't cancel OOC. This matches what the player
      // actually perceives on their screen.
      const sightCap = Math.min(rushCfg.proximityRadius, BALANCE.match.losRadius);
      const enemyNearby = insideSmoke ? false : actors.some(other => {
        if (other.playerId === bomberman.playerId) return false;
        if (!other.alive || other.escaped) return false;
        if (chebyshevDistance(bomberman.x, bomberman.y, other.x, other.y) > sightCap) return false;
        return hasLineOfSight(
          bomberman.x * ts + ts / 2, bomberman.y * ts + ts / 2,
          other.x * ts + ts / 2, other.y * ts + ts / 2,
          map.grid, ts, closedDoorsForLos, shieldTilesForLos, seeThroughTiles,
        );
      });
      // Bomb landed nearby: same rule — only cancel OOC for bombs the
      // player can actually see (within fog radius + clear LOS). A bomb
      // behind a wall or in the dark shouldn't break the player's rush.
      const bombSightCap = Math.min(rushCfg.bombProximityRadius, BALANCE.match.losRadius);
      const bombNearby = state.bombs.some(bomb => {
        if (bomb.ownerId === bomberman.playerId) return false;
        if (chebyshevDistance(bomberman.x, bomberman.y, bomb.x, bomb.y) > bombSightCap) return false;
        return hasLineOfSight(
          bomberman.x * ts + ts / 2, bomberman.y * ts + ts / 2,
          bomb.x * ts + ts / 2, bomb.y * ts + ts / 2,
          map.grid, ts, closedDoorsForLos, shieldTilesForLos, seeThroughTiles,
        );
      });
      if (enemyNearby || threw || bombNearby) {
        // Combat contact — break rush
        if (bomberman.rushActive) {
          bomberman.rushActive = false;
          events.push({ kind: 'rush_changed', playerId: bomberman.playerId, active: false });
        }
        bomberman.rushCooldown = 0;
      } else {
        // Peaceful turn
        bomberman.rushCooldown++;
        if (!bomberman.rushActive && bomberman.rushCooldown >= rushCfg.cooldownTurns) {
          bomberman.rushActive = true;
          events.push({ kind: 'rush_changed', playerId: bomberman.playerId, active: true });
        }
      }
    }
  }

  // --- 3. Place thrown bombs ---
  // We filter damage output later so a bomb thrown this turn doesn't double-damage its owner on trigger
  for (const bomberman of actors) {
    const action = effectiveActions.get(bomberman.playerId);
    if (!action || action.kind !== 'throw') continue;
    if (!bomberman.alive) continue; // died this turn from something? shouldn't happen pre-explosion

    // Slot layout (UI + network):
    //   0         → Rock (infinite, free)
    //   1..N     → inventory.slots[0..N-1] (custom bombs, N = bomberman.maxCustomSlots)
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
    // Bombs can be thrown at any tile (even walls, when throwing blind into
    // unseen fog). Non-flare bombs on walls will fizzle at trigger time.
    // Only reject clearly out-of-bounds targets.
    if (action.x < 0 || action.y < 0 || action.x >= map.width || action.y >= map.height) continue;

    const def = BOMB_CATALOG[bombType];

    // Fart Escape special flow:
    //   1. Compute a path from bomberman's current tile toward target.
    //   2. Walk up to `fartEscapeMoveTiles` along that path this turn.
    //   3. Store the remainder in queuedPath so next turn the bomberman
    //      continues toward the target unless the player overrides.
    //   4. Spawn the smoke cloud at the bomberman's ORIGINAL pre-move tile.
    //   5. Do NOT push a BombInstance — the fart escape has no fuse / landing
    //      phase; it's entirely resolved here.
    if (bombType === 'fart_escape') {
      const originX = bomberman.x;
      const originY = bomberman.y;
      // Deploy smoke cloud first (at the origin tile) so visuals reflect
      // "smoke appears where I was, then I move".
      const smokeShape = def.behavior.kind === 'smoke' ? def.behavior.shape : { kind: 'circle' as const, radius: 3 };
      const smokeDur = def.behavior.kind === 'smoke' ? def.behavior.durationTurns : 4;
      const closedDoorTiles = new Set<string>();
      for (const door of state.doors ?? []) {
        if (door.opened) continue;
        for (const t of door.tiles) closedDoorTiles.add(`${t.x},${t.y}`);
      }
      const fartShieldWallSet = new Set<string>();
      for (const w of state.shieldWalls ?? []) {
        for (const t of w.tiles) fartShieldWallSet.add(`${t.x},${t.y}`);
      }
      const smokeTiles = shapeTiles(smokeShape, originX, originY, map, closedDoorTiles, fartShieldWallSet);
      const cloud: SmokeCloud = {
        id: nextSmokeId(),
        ownerId: bomberman.playerId,
        x: originX,
        y: originY,
        tiles: smokeTiles.map(t => ({ x: t.x, y: t.y })),
        turnsRemaining: smokeDur,
        radius: smokeShape.kind === 'circle' ? smokeShape.radius : 3,
      };
      state.smokeClouds.push(cloud);
      events.push({
        kind: 'smoke_spawned',
        cloudId: cloud.id,
        x: originX,
        y: originY,
        radius: cloud.radius,
        tiles: cloud.tiles.map(t => ({ x: t.x, y: t.y })),
        ownerId: bomberman.playerId,
      });

      // Pathfind toward target; walk 2 tiles along it. Treat active Shield
      // Walls as blocked so the route goes around them.
      const fartShieldTiles = new Set<string>();
      for (const w of state.shieldWalls ?? []) {
        for (const t of w.tiles) fartShieldTiles.add(`${t.x},${t.y}`);
      }
      const fullPath = findPath(originX, originY, action.x, action.y, map, fartShieldTiles);
      const walkTiles = Math.min(BALANCE.bombs.fartEscapeMoveTiles, fullPath.length);
      let curX = originX;
      let curY = originY;
      for (let i = 0; i < walkTiles; i++) {
        const step = fullPath[i];
        if (!isPassable(state, map, step.x, step.y)) break;
        events.push({
          kind: 'moved',
          playerId: bomberman.playerId,
          fromX: curX,
          fromY: curY,
          toX: step.x,
          toY: step.y,
        });
        curX = step.x;
        curY = step.y;
        recordStep(bomberman.playerId, step.x, step.y);
      }
      bomberman.x = curX;
      bomberman.y = curY;

      // Queue the remainder for next turn. Player can override by submitting
      // a new move target; otherwise we auto-step along this path.
      const remainder = fullPath.slice(walkTiles);
      bomberman.queuedPath = remainder.length > 0 ? remainder.map(t => ({ x: t.x, y: t.y })) : undefined;

      // Emit a throw event so the client sees the Fart Escape happened.
      events.push({
        kind: 'throw',
        playerId: bomberman.playerId,
        bombId: cloud.id,
        type: 'fart_escape',
        fromX: originX,
        fromY: originY,
        x: action.x,
        y: action.y,
      });
      continue; // Skip pushing a BombInstance
    }

    // Slide-off rule: if the target tile carries an active Shield Wall,
    // any incoming bomb (including motion detectors and the regular landing
    // path below) re-targets to the nearest passable tile. Applies uniformly
    // to all bomb types per the Shield Bomb spec.
    let landX = action.x;
    let landY = action.y;
    if (isShieldWallAt(state, landX, landY)) {
      const slid = nearestWhere(map, landX, landY, (x, y) => isPassable(state, map, x, y));
      if (!slid) continue; // no passable tile anywhere — fizzle (shouldn't happen on real maps)
      landX = slid.x;
      landY = slid.y;
    }

    // Motion Detector Flare special flow: arm as a dormant mine, no BombInstance.
    if (bombType === 'motion_detector_flare') {
      if (!isWalkable(map, landX, landY)) continue;
      const mine: Mine = {
        id: nextMineId(),
        kind: 'motion_detector',
        ownerId: bomberman.playerId,
        x: landX,
        y: landY,
        lifetimeRemaining: BALANCE.bombs.motionDetectorLifetime,
        detectionRadius: BALANCE.bombs.motionDetectorRadius,
      };
      state.mines.push(mine);
      events.push({
        kind: 'mine_placed',
        mineId: mine.id,
        x: mine.x,
        y: mine.y,
        mineKind: 'motion_detector',
        ownerId: bomberman.playerId,
      });
      events.push({
        kind: 'throw',
        playerId: bomberman.playerId,
        bombId: mine.id,
        type: 'motion_detector_flare',
        fromX: bomberman.x,
        fromY: bomberman.y,
        x: landX,
        y: landY,
      });
      continue;
    }

    const bomb: BombInstance = {
      id: nextBombId(),
      type: bombType,
      ownerId: bomberman.playerId,
      x: landX,
      y: landY,
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
      x: landX,
      y: landY,
    });
  }

  // --- 4 + 5. Tick fuses and resolve triggered bombs ---
  // Build the set of closed door tiles for explosion ray-stopping.
  // Recomputed each bomb so doors opened by earlier bombs in the same turn
  // don't block subsequent explosions.
  const buildClosedDoorTiles = (): Set<string> => {
    const set = new Set<string>();
    for (const door of state.doors ?? []) {
      if (door.opened) continue;
      for (const t of door.tiles) set.add(`${t.x},${t.y}`);
    }
    return set;
  };
  /** Active shield wall tiles. Recomputed each call so a wall placed earlier
   *  this turn (e.g. shield resolves before another bomb in the same toResolve
   *  loop) blocks the later bomb's explosion rays. */
  const buildShieldWallTiles = (): Set<string> => {
    const set = new Set<string>();
    for (const w of state.shieldWalls ?? []) {
      for (const t of w.tiles) set.add(`${t.x},${t.y}`);
    }
    return set;
  };

  const damagedThisTurn = new Set<string>();
  /** Tracks who last damaged each player (for kill attribution). */
  const lastDamagedBy = new Map<string, string>();
  const triggeredBombIds = new Set<string>();
  /** Mines flagged to trigger this turn, with the triggerer id (null for bomb-hit). */
  const minesToTrigger = new Map<string, string | null>();

  // --- 3.5. Phosphorus pending: spawn deferred fire tiles from last turn. ---
  //   Shield walls suppress these silently — if a wall is up over a tile,
  //   the would-be phosphorus fire just doesn't spawn there.
  // Consumes ALL pending entries and creates fire tiles. Standing-on-fire damage
  // is applied later in step 6 by the existing mechanism.
  if (state.phosphorusPending.length > 0) {
    for (const pending of state.phosphorusPending) {
      for (const off of PHOSPHORUS_FIRE_OFFSETS) {
        const tx = pending.originX + off.dx;
        const ty = pending.originY + off.dy;
        if (!isPassable(state, map, tx, ty)) continue;
        state.fireTiles.push({
          x: tx,
          y: ty,
          turnsRemaining: pending.fireDurationTurns + 1, // +1 so aging at end-of-turn leaves it for the intended duration
          ownerId: pending.ownerId,
          kind: 'phosphorus',
        });
      }
    }
    state.phosphorusPending = [];
  }

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
  // Resolution-order priority (lower = resolves first):
  //   0  Shield Bomb   — places wall + pushes BMs/bombs before anything explodes
  //                      (per spec, even precedes Ender Pearl, because the
  //                      shield can displace the pearl-thrower)
  //   1  Ender Pearl   — teleports the thrower out of danger before damage
  //   2  All others    — FIFO
  // Multiple shields tie-break by ownerId (string compare) for determinism;
  // each shield's push uses state AFTER previous shields placed their tiles.
  toResolve.sort((a, b) => {
    const prio = (b: BombInstance): number =>
      b.type === 'shield' ? 0 : b.type === 'ender_pearl' ? 1 : 2;
    const ap = prio(a);
    const bp = prio(b);
    if (ap !== bp) return ap - bp;
    if (ap === 0) return a.ownerId.localeCompare(b.ownerId);
    return 0;
  });

  while (toResolve.length > 0) {
    const bomb = toResolve.shift()!;
    if (triggeredBombIds.has(bomb.id)) continue;
    triggeredBombIds.add(bomb.id);

    // Shield Bomb: place a + Shield Wall around the landing tile, push BMs and
    // unexploded bombs out of the wall tiles, suppress fires under the wall,
    // and emit shield_pushed events for client vfx. Resolves first in
    // toResolve so that subsequent in-turn explosions ALREADY see the wall as
    // an obstacle (LoS, walkability, ray-stopping all flow from
    // state.shieldWalls).
    if (bomb.type === 'shield') {
      const beh = BOMB_CATALOG[bomb.type].behavior;
      if (beh.kind !== 'shield_wall') {
        events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: bomb.x, y: bomb.y, tiles: [] });
        continue;
      }
      // Compute footprint (uses regular shape rules; obeys level walls only).
      // Closed doors do NOT stop the wall — the wall stands ON TOP of doors,
      // chests, hatches, fires per spec. We pass an empty closed-door set.
      const wallTiles = shapeTiles(beh.shape, bomb.x, bomb.y, map, new Set<string>());
      // Filter: skip tiles already covered by another active shield (so two
      // simultaneous shields don't double-stack on shared tiles).
      const ownedTiles = wallTiles.filter(t => !isShieldWallAt(state, t.x, t.y));
      if (ownedTiles.length === 0) {
        // Entirely overlapping with existing wall — emit trigger event and skip.
        events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: bomb.x, y: bomb.y, tiles: [] });
        continue;
      }
      const ownedSet = new Set(ownedTiles.map(t => `${t.x},${t.y}`));

      // 1. Push Bombermen out of newly-occupied tiles.
      //    Order: deterministic by playerId so simultaneous pushes don't
      //    conflict on the "nearest passable, not on another BM" search.
      const sortedBMs = [...state.bombermen]
        .filter(b => b.alive && !b.escaped && ownedSet.has(`${b.x},${b.y}`))
        .sort((a, b) => a.playerId.localeCompare(b.playerId));
      // Track tiles BMs have moved to so the next push doesn't pick the same tile.
      const claimedByPushedBM = new Set<string>();
      for (const bm of sortedBMs) {
        const occupiedByBM = new Set<string>();
        for (const other of state.bombermen) {
          if (other === bm) continue;
          if (!other.alive || other.escaped) continue;
          occupiedByBM.add(`${other.x},${other.y}`);
        }
        const target = nearestWhere(map, bm.x, bm.y, (x, y) => {
          if (!isWalkable(map, x, y)) return false;
          if (ownedSet.has(`${x},${y}`)) return false; // not into the new wall
          if (isShieldWallAt(state, x, y)) return false;
          if (occupiedByBM.has(`${x},${y}`)) return false;
          if (claimedByPushedBM.has(`${x},${y}`)) return false;
          return true;
        });
        if (!target) continue; // pathologically no walkable tile anywhere
        const fromX = bm.x;
        const fromY = bm.y;
        bm.x = target.x;
        bm.y = target.y;
        bm.teleportedThisTurn = true; // same protection as Ender Pearl
        claimedByPushedBM.add(`${target.x},${target.y}`);
        events.push({
          kind: 'shield_pushed',
          wallId: '', // filled in after wall id is allocated
          playerId: bm.playerId,
          fromX, fromY, toX: target.x, toY: target.y,
        });
      }

      // 2. Push unexploded bombs out — bombs CAN land on tiles occupied by BMs.
      for (const other of state.bombs) {
        if (other.id === bomb.id) continue; // skip the shield itself
        if (!ownedSet.has(`${other.x},${other.y}`)) continue;
        const target = nearestWhere(map, other.x, other.y, (x, y) => {
          if (!isWalkable(map, x, y)) return false;
          if (ownedSet.has(`${x},${y}`)) return false;
          if (isShieldWallAt(state, x, y)) return false;
          return true;
        });
        if (!target) continue;
        const fromX = other.x;
        const fromY = other.y;
        other.x = target.x;
        other.y = target.y;
        events.push({
          kind: 'shield_pushed',
          wallId: '',
          bombId: other.id,
          fromX, fromY, toX: target.x, toY: target.y,
        });
      }

      // 3. Extinguish any fire tiles under the wall.
      state.fireTiles = state.fireTiles.filter(f => !ownedSet.has(`${f.x},${f.y}`));

      // 4. Spawn the wall.
      const wallId = nextShieldId();
      state.shieldWalls.push({
        id: wallId,
        ownerId: bomb.ownerId,
        centerX: bomb.x,
        centerY: bomb.y,
        tiles: ownedTiles.map(t => ({ x: t.x, y: t.y })),
        // +1 because end-of-turn aging step decrements; net = `durationTurns`
        // full turns of standing (NOT counting placement turn).
        turnsRemaining: beh.durationTurns + 1,
      });
      // Backfill wallId on the pushed events so client can group them.
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.kind === 'shield_pushed' && e.wallId === '') {
          e.wallId = wallId;
        } else if (e.kind === 'shield_wall_spawned') {
          break;
        }
      }
      events.push({
        kind: 'shield_wall_spawned',
        wallId,
        ownerId: bomb.ownerId,
        centerX: bomb.x,
        centerY: bomb.y,
        tiles: ownedTiles.map(t => ({ x: t.x, y: t.y })),
      });
      // Emit a bomb_triggered for animation/cleanup parity with other bombs.
      events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: bomb.x, y: bomb.y, tiles: [] });

      // 5. Cancel any cached path that now passes through the wall. If the
      //    final tile WAS the wall, just truncate; otherwise drop the path
      //    entirely (next-turn movement input will rebuild it).
      for (const bm of state.bombermen) {
        if (!bm.queuedPath || bm.queuedPath.length === 0) continue;
        const idx = bm.queuedPath.findIndex(t => ownedSet.has(`${t.x},${t.y}`));
        if (idx === -1) continue;
        const last = bm.queuedPath.length - 1;
        if (idx === last && idx > 0) {
          bm.queuedPath = bm.queuedPath.slice(0, last);
        } else {
          bm.queuedPath = undefined;
        }
      }
      continue;
    }

    // Ender Pearl: teleport the thrower to the landing tile (or nearest
    // walkable tile if the target is an obstacle). Handled before the fizzle
    // check because the pearl explicitly shifts to a valid tile instead of
    // fizzling. Treats active Shield Walls as obstacles.
    if (bomb.type === 'ender_pearl') {
      let destX = bomb.x;
      let destY = bomb.y;
      if (!isPassable(state, map, destX, destY)) {
        const alt = nearestWhere(map, destX, destY, (x, y) => isPassable(state, map, x, y));
        if (alt) { destX = alt.x; destY = alt.y; }
        // If no passable tile exists at all, pearl fizzles (shouldn't happen on real maps)
        else {
          events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: bomb.x, y: bomb.y, tiles: [] });
          continue;
        }
      }
      const thrower = state.bombermen.find(b => b.playerId === bomb.ownerId);
      if (thrower && thrower.alive && !thrower.escaped) {
        const fromX = thrower.x;
        const fromY = thrower.y;
        thrower.x = destX;
        thrower.y = destY;
        // Block escape-on-same-turn for the teleport destination. Cleared at
        // the start of the next resolveTurn call.
        thrower.teleportedThisTurn = true;
        events.push({ kind: 'teleport', playerId: thrower.playerId, fromX, fromY, toX: destX, toY: destY });
      }
      events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: destX, y: destY, tiles: [] });
      continue;
    }

    // Bombs on wall tiles fizzle — except Flare which still lights the area.
    // This allows players to throw blind into fog and have it fail silently.
    const onWall = !isWalkable(map, bomb.x, bomb.y);
    const isFlareType = bomb.type === 'flare';
    if (onWall && !isFlareType) {
      // Fizzle — no effect, just remove
      events.push({ kind: 'bomb_triggered', bombId: bomb.id, type: bomb.type, x: bomb.x, y: bomb.y, tiles: [] });
      continue;
    }

    const closedDoorTiles = buildClosedDoorTiles();
    const shieldWallTilesSet = buildShieldWallTiles();
    const trigger = resolveBombTrigger(bomb.type, bomb.x, bomb.y, map, closedDoorTiles, shieldWallTilesSet);

    // Open any closed doors hit by the explosion. Light-only tiles (Flare)
    // do NOT open doors — flares illuminate without applying force, so a
    // flare landing on a door tile just lights it up.
    const blastTiles = [...trigger.damageTiles, ...trigger.fireTiles];
    for (const door of state.doors ?? []) {
      if (door.opened) continue;
      if (door.tiles.some(dt => blastTiles.some(bt => bt.x === dt.x && bt.y === dt.y))) {
        door.opened = true;
        events.push({ kind: 'door_opened', doorId: door.id });
        console.log(`[TurnResolver] door ${door.id} opened by ${bomb.type} bomb at (${bomb.x},${bomb.y}) — blastTiles=${blastTiles.length} (damage=${trigger.damageTiles.length}, fire=${trigger.fireTiles.length}, light=${trigger.lightTiles.length})`);
      }
    }

    events.push({
      kind: 'bomb_triggered',
      bombId: bomb.id,
      type: bomb.type,
      x: bomb.x,
      y: bomb.y,
      tiles: trigger.damageTiles.length > 0 ? trigger.damageTiles
        : trigger.fireTiles.length > 0 ? trigger.fireTiles
        : trigger.stunTiles.length > 0 ? trigger.stunTiles
        : trigger.lightTiles,
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
        lastDamagedBy.set(b.playerId, bomb.ownerId);
        events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp, attackerId: bomb.ownerId, amount: 1 });
      }
    }

    // Spawn fire tiles (molotov) or phosphorus-flavored fire
    for (const tile of trigger.fireTiles) {
      state.fireTiles.push({
        x: tile.x,
        y: tile.y,
        turnsRemaining: trigger.fireDuration,
        ownerId: bomb.ownerId,
        kind: trigger.fireKind ?? 'molotov',
      });
    }

    // Flare: create an ActiveFlare record (lightTiles are derived from flares each turn)
    if (trigger.lightTiles.length > 0 && trigger.lightDuration > 0 && bomb.type === 'flare') {
      state.flares.push({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        initialRadius: 4, // flare's circle radius from bomb config
        turnsRemaining: trigger.lightDuration,
      });
    }

    // Phosphorus: impact turn reveal + queue deferred fire spawn for next turn.
    // The flare's lifetime is sized to cover the impact turn AND the entire
    // fire-burning lifetime that follows, so the lit area visibly persists
    // while the phosphorus fires are present rather than blinking out after
    // a single turn. fireDurationTurns + 2 = (impact turn) + (fire turns) + (1
    // buffer for end-of-turn aging that runs immediately after the push).
    if (trigger.phosphorusSeed) {
      state.flares.push({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        initialRadius: 5,
        turnsRemaining: trigger.phosphorusSeed.fireDurationTurns + 2,
        kind: 'phosphorus',
      });
      state.phosphorusPending.push({
        id: nextPhosphorusId(),
        ownerId: bomb.ownerId,
        originX: trigger.phosphorusSeed.originX,
        originY: trigger.phosphorusSeed.originY,
        fireDurationTurns: trigger.phosphorusSeed.fireDurationTurns,
      });
    }

    // Stun application (Flash). Applies to bombermen on stunTiles — which is
    // SEPARATE from damageTiles (Flash deals no damage). Spawn with
    // turnsRemaining = stunTurns + 1 so the status survives this turn's
    // end-of-turn aging step and is still active when the stunned player's
    // NEXT input phase runs.
    if (trigger.stunTurns > 0) {
      for (const tile of trigger.stunTiles) {
        for (const b of state.bombermen) {
          if (!b.alive || b.escaped) continue;
          if (b.x !== tile.x || b.y !== tile.y) continue;
          b.statusEffects = (b.statusEffects ?? []).filter(s => s.kind !== 'stunned');
          b.statusEffects.push({ kind: 'stunned', turnsRemaining: trigger.stunTurns + 1, sourceId: bomb.ownerId });
          events.push({ kind: 'stunned', playerId: b.playerId, turnsRemaining: trigger.stunTurns });
        }
      }
    }

    // Cluster seed → place N mines at random positions in the area. Use a
    // seed derived from match + turn + owner for determinism.
    if (trigger.clusterSeed) {
      const { area, mineCount } = trigger.clusterSeed;
      const seedBase = hashString(`${state.matchId}:${state.turnNumber}:${bomb.ownerId}:${bomb.id}`);
      const rng = createSeededRandom(seedBase);
      const halfW = Math.floor(area.w / 2);
      const halfH = Math.floor(area.h / 2);
      const occupied = new Set<string>();
      for (const m of state.mines) occupied.add(`${m.x},${m.y}`);
      for (let i = 0; i < mineCount; i++) {
        const dx = Math.floor(rng() * area.w) - halfW;
        const dy = Math.floor(rng() * area.h) - halfH;
        const mx = bomb.x + dx;
        const my = bomb.y + dy;
        if (!isWalkable(map, mx, my)) continue; // drop — no reroll
        const key = `${mx},${my}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        // If the mine lands directly on a bomberman, trigger immediately.
        const standOn = state.bombermen.find(b => b.alive && !b.escaped && b.x === mx && b.y === my);
        if (standOn) {
          // Immediate plus-r1 explosion at this tile.
          const tiles = shapeTiles({ kind: 'plus', radius: 1 }, mx, my, map, buildClosedDoorTiles(), buildShieldWallTiles());
          events.push({
            kind: 'mine_triggered',
            mineId: `cluster_imm_${i}`,
            x: mx,
            y: my,
            mineKind: 'cluster',
            ownerId: bomb.ownerId,
            triggeredBy: standOn.playerId,
            tiles,
          });
          for (const t of tiles) {
            for (const b of state.bombermen) {
              if (!b.alive || b.escaped) continue;
              if (b.x !== t.x || b.y !== t.y) continue;
              if (damagedThisTurn.has(b.playerId)) continue;
              damagedThisTurn.add(b.playerId);
              b.hp -= 1;
              b.bleedingTurns = BALANCE.match.bleedingDurationTurns;
              lastDamagedBy.set(b.playerId, bomb.ownerId);
              events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp, attackerId: bomb.ownerId, amount: 1 });
            }
          }
          continue;
        }
        const newMine: Mine = {
          id: nextMineId(),
          kind: 'cluster',
          ownerId: bomb.ownerId,
          x: mx,
          y: my,
          lifetimeRemaining: 9999, // cluster mines do not auto-expire
        };
        state.mines.push(newMine);
        events.push({
          kind: 'mine_placed',
          mineId: newMine.id,
          x: newMine.x,
          y: newMine.y,
          mineKind: 'cluster',
          ownerId: bomb.ownerId,
        });
      }
    }

    // Mines hit by this bomb's damage tiles:
    //   - Cluster mines get PRIMED for next turn (shake, then chain).
    //   - Motion detector mines trigger immediately.
    if (trigger.damageTiles.length > 0) {
      for (const mine of state.mines) {
        if (!trigger.damageTiles.some(t => t.x === mine.x && t.y === mine.y)) continue;
        if (mine.kind === 'cluster') {
          if (mine.primedCountdown === undefined) mine.primedCountdown = 1;
        } else {
          minesToTrigger.set(mine.id, null);
        }
      }
    }

    // Scatter → spawn child bombs immediately; fuseTurns decides if they resolve now or next turn.
    // Skip tiles covered by an active Shield Wall (children "slide off" same as a regular throw —
    // and since the parent already ticked, we just drop those children silently).
    for (const spawn of trigger.scatterSpawns) {
      if (!isPassable(state, map, spawn.x, spawn.y)) continue;
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

  // --- 5b. Mine tick + detection + walk-over ---
  // Decrement lifetime; check motion detector proximity; flag expired or
  // walked-on mines for triggering. Cluster mines only trigger on walk-over,
  // direct bomb hits (handled above), or being landed on by the cluster seed
  // itself (handled in cluster_seed branch).
  const ts = map.tileSize;
  for (const mine of state.mines) {
    if (minesToTrigger.has(mine.id)) continue;
    // Primed mines count down each turn (cluster shake-then-chain pattern).
    if (mine.primedCountdown !== undefined) {
      mine.primedCountdown -= 1;
      if (mine.primedCountdown <= 0) {
        minesToTrigger.set(mine.id, null);
        continue;
      }
      // Still shaking — skip other detection paths this turn.
      continue;
    }
    // Walk-over: any bomberman who STEPPED ONTO the mine tile this turn
    // triggers it — including intermediate rush / Fart Escape tiles, not
    // just the final position. Falls back to final position so a
    // bomberman who ended on the mine via spawn / teleport still trips it.
    // Cluster triggers for any bomberman (including owner per spec);
    // motion detector only triggers on enemy.
    let stepper: BombermanState | null = null;
    for (const b of state.bombermen) {
      if (!b.alive || b.escaped) continue;
      const steps = steppedTilesByPlayer.get(b.playerId);
      const stepped = steps?.some(s => s.x === mine.x && s.y === mine.y) ?? false;
      const endsOn = b.x === mine.x && b.y === mine.y;
      if (stepped || endsOn) { stepper = b; break; }
    }
    if (stepper) {
      if (mine.kind === 'cluster') {
        minesToTrigger.set(mine.id, stepper.playerId);
        continue;
      }
      if (mine.kind === 'motion_detector' && stepper.playerId !== mine.ownerId) {
        minesToTrigger.set(mine.id, stepper.playerId);
        continue;
      }
    }
    if (mine.kind === 'motion_detector') {
      // Enemy within Chebyshev detection radius AND with line of sight.
      // Closed doors block the sensor beam the same as walls.
      const radius = mine.detectionRadius ?? BALANCE.bombs.motionDetectorRadius;
      const closedDoorsForMine = buildClosedDoorTiles();
      const shieldTilesForMine = buildShieldWallTiles();
      const detected = state.bombermen.find(b => {
        if (!b.alive || b.escaped) return false;
        if (b.playerId === mine.ownerId) return false;
        if (chebyshevDistance(mine.x, mine.y, b.x, b.y) > radius) return false;
        return hasLineOfSight(
          mine.x * ts + ts / 2, mine.y * ts + ts / 2,
          b.x * ts + ts / 2, b.y * ts + ts / 2,
          map.grid, ts, closedDoorsForMine, shieldTilesForMine, seeThroughTiles,
        );
      });
      if (detected) {
        minesToTrigger.set(mine.id, detected.playerId);
        continue;
      }
    }
    // Tick lifetime — trigger passively if expired.
    mine.lifetimeRemaining -= 1;
    if (mine.lifetimeRemaining <= 0) {
      minesToTrigger.set(mine.id, null);
    }
  }

  // Process triggered mines. Motion detector: spawn an orange flare reveal.
  // Cluster: spawn a plus-r1 explosion that PRIMES (not triggers) adjacent
  // mines — they shake for a turn and chain next turn.
  const mineTriggerList: Array<{ mineId: string; by: string | null }> = [];
  for (const [mineId, by] of minesToTrigger) mineTriggerList.push({ mineId, by });
  for (const { mineId, by } of mineTriggerList) {
    const mineIdx = state.mines.findIndex(m => m.id === mineId);
    if (mineIdx < 0) continue;
    const mine = state.mines[mineIdx];
    state.mines.splice(mineIdx, 1);

    // Cluster mine stepped on = instant combat. Break the stepper's Rush
    // immediately so they can't sprint through a minefield at 2 tiles/turn.
    // Only applies when a bomberman triggered it (by !== null); passive
    // lifetime expiry or bomb-hit chains don't break rush for anyone.
    if (mine.kind === 'cluster' && by) {
      const stepper = state.bombermen.find(b => b.playerId === by);
      if (stepper && stepper.rushActive) {
        stepper.rushActive = false;
        stepper.rushCooldown = 0;
        events.push({ kind: 'rush_changed', playerId: stepper.playerId, active: false });
      } else if (stepper) {
        stepper.rushCooldown = 0;
      }
    }

    let tiles: Tile[] = [];
    if (mine.kind === 'motion_detector') {
      // Fire a flare at this tile (orange variant).
      state.flares.push({
        id: mine.id,
        x: mine.x,
        y: mine.y,
        initialRadius: 4,
        turnsRemaining: 3,
        kind: 'motion_detector',
      });
    } else if (mine.kind === 'cluster') {
      tiles = shapeTiles({ kind: 'plus', radius: 1 }, mine.x, mine.y, map, buildClosedDoorTiles(), buildShieldWallTiles());
      for (const t of tiles) {
        for (const b of state.bombermen) {
          if (!b.alive || b.escaped) continue;
          if (b.x !== t.x || b.y !== t.y) continue;
          if (damagedThisTurn.has(b.playerId)) continue;
          damagedThisTurn.add(b.playerId);
          b.hp -= 1;
          b.bleedingTurns = BALANCE.match.bleedingDurationTurns;
          lastDamagedBy.set(b.playerId, mine.ownerId);
          events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp, attackerId: mine.ownerId, amount: 1 });
        }
        // Prime any adjacent cluster mine (direct hit on its tile) — don't
        // trigger this turn; let it shake for a turn then chain.
        const chained = state.mines.find(m => m.x === t.x && m.y === t.y);
        if (chained && chained.kind === 'cluster' && chained.primedCountdown === undefined) {
          chained.primedCountdown = 1;
        }
      }
    }

    events.push({
      kind: 'mine_triggered',
      mineId: mine.id,
      x: mine.x,
      y: mine.y,
      mineKind: mine.kind,
      ownerId: mine.ownerId,
      triggeredBy: by,
      tiles,
    });
  }

  // --- 5c. UAV overflight (real matches only) ---
  // On scheduled turns, scatter flares across a 7-tile grid covering the map.
  // Radius-4 flares with stride 7 means every grid cell overlaps its neighbors
  // by 2 tiles, guaranteeing full coverage of any walkable tile. Each grid
  // anchor snaps to its nearest walkable tile via BFS; if a region has no
  // walkable tile, nothing spawns there. Flares are otherwise identical to
  // player-thrown flares (initialRadius=4, turnsRemaining=3, default visual).
  if (!state.isTutorial
      && state.uavNextFireTurn !== undefined
      && state.turnNumber === state.uavNextFireTurn) {
    const stride = 7;
    const occupied = new Set<string>();
    const uavTiles: Tile[] = [];
    for (let cy = Math.floor(stride / 2); cy < map.height; cy += stride) {
      for (let cx = Math.floor(stride / 2); cx < map.width; cx += stride) {
        const target = nearestWalkable(map, cx, cy);
        if (!target) continue;
        const key = `${target.x},${target.y}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        const id = `uav_${state.turnNumber}_${target.x}_${target.y}`;
        state.flares.push({
          id,
          x: target.x,
          y: target.y,
          initialRadius: 4,
          turnsRemaining: 3,
        });
        uavTiles.push({ x: target.x, y: target.y });
      }
    }
    // Schedule next UAV. Deterministic seed from match + turn so reconnects
    // and replays agree.
    const seedBase = hashString(`uav:${state.matchId}:${state.turnNumber}`);
    const rng = createSeededRandom(seedBase);
    state.uavNextFireTurn = state.turnNumber + 60 + Math.floor(rng() * 31); // [60, 90]
    events.push({ kind: 'uav_fired', turnNumber: state.turnNumber, tiles: uavTiles });
  }

  // --- 5d. Scavenger NPC spawn wave (real matches only) ---
  // On scheduled turns, drop up to `BALANCE.scavs.perSpawn` Scavenger
  // bombermen at player spawn tiles that no alive bomberman currently has
  // line of sight on. Skips silently if no spawn tile qualifies. Players
  // are NOT informed by design — scavs simply appear. MatchRoom listens
  // to `scav_spawned` events to create a controller (ScavPlayer) for each.
  if (!state.isTutorial
      && state.scavNextSpawnTurn !== undefined
      && state.turnNumber === state.scavNextSpawnTurn) {
    const scavSeed = hashString(`scav:${state.matchId}:${state.turnNumber}`);
    const scavRng = createSeededRandom(scavSeed);
    const losR = BALANCE.match.losRadius;
    const ts = map.tileSize;
    const closedDoorTiles = new Set<string>();
    for (const d of state.doors ?? []) {
      if (d.opened) continue;
      for (const t of d.tiles) closedDoorTiles.add(`${t.x},${t.y}`);
    }
    // Candidate spawn tiles = `map.spawns` filtered by "no alive bomberman
    // in Chebyshev-LoS-radius AND no actual line of sight from any
    // bomberman." Two-stage filter is intentional — Chebyshev first is
    // cheap and rejects the easy cases without touching the DDA cast.
    const candidates: { x: number; y: number }[] = [];
    for (const s of map.spawns) {
      let hidden = true;
      for (const b of state.bombermen) {
        if (!b.alive || b.escaped) continue;
        if (Math.max(Math.abs(b.x - s.x), Math.abs(b.y - s.y)) > losR) continue;
        const fromPx = b.x * ts + ts / 2;
        const fromPy = b.y * ts + ts / 2;
        const toPx = s.x * ts + ts / 2;
        const toPy = s.y * ts + ts / 2;
        if (hasLineOfSight(fromPx, fromPy, toPx, toPy, map.grid, ts, closedDoorTiles, undefined, seeThroughTiles)) {
          hidden = false;
          break;
        }
      }
      if (hidden) candidates.push({ x: s.x, y: s.y });
    }
    // Seeded Fisher–Yates shuffle so spawn placement is replay-stable.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(scavRng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const aliveScavs = state.bombermen.filter(b => b.isScav && b.alive && !b.escaped).length;
    const headroom = Math.max(0, BALANCE.scavs.maxAlive - aliveScavs);
    const desired = Math.min(BALANCE.scavs.perSpawn, headroom);
    const picks = candidates.slice(0, Math.min(desired, candidates.length));
    for (let i = 0; i < picks.length; i++) {
      const tile = picks[i];
      const playerId = `scav_${state.matchId}_${state.turnNumber}_${i}`;
      const tint = rollTint(scavRng);
      const scav: BombermanState = {
        playerId,
        isBot: true,
        isScav: true,
        bombermanId: 'scav',
        name: 'Scavenger',
        colors: { shirt: tint, pants: tint, hair: tint },
        tint,
        character: SCAV_CHARACTER,
        idleAction: 'attack',
        x: tile.x,
        y: tile.y,
        hp: BALANCE.match.bombermanMaxHp,
        maxHp: BALANCE.match.bombermanMaxHp,
        alive: true,
        treasures: {},
        coins: 0,
        keys: 0,
        maxCustomSlots: 4,
        stackSize: 6,
        inventory: {
          slots: [
            { type: 'flare', count: 2 },
            { type: 'bomb', count: 6 },
            { type: 'bomb_wide', count: 3 },
            { type: 'delay_tricky', count: 3 },
          ],
        },
        bleedingTurns: 0,
        escaped: false,
        rushCooldown: 0,
        rushActive: false,
        teleportedThisTurn: false,
        onHatchIdleTurns: 0,
        statusEffects: [],
        meleeTrapMode: false,
        idleStillTurns: 0,
        sp: 0,
      };
      state.bombermen.push(scav);
      events.push({ kind: 'scav_spawned', playerId, x: tile.x, y: tile.y });
    }
    // Reschedule next wave — old UAV [20, 30] cadence, now repurposed.
    state.scavNextSpawnTurn = state.turnNumber + 20 + Math.floor(scavRng() * 11);
  }

  // --- 6. Fire-tile standing damage (Bombermen on existing fire tiles) ---
  for (const fire of state.fireTiles) {
    for (const b of state.bombermen) {
      if (!b.alive || b.escaped) continue;
      if (b.x !== fire.x || b.y !== fire.y) continue;
      if (damagedThisTurn.has(b.playerId)) continue;
      damagedThisTurn.add(b.playerId);
      b.hp -= 1;
      b.bleedingTurns = BALANCE.match.bleedingDurationTurns;
      lastDamagedBy.set(b.playerId, fire.ownerId);
      events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp, attackerId: fire.ownerId, amount: 1 });
    }
  }

  // --- 7. Age fire/light tiles ---
  state.fireTiles = state.fireTiles
    .map(f => ({ ...f, turnsRemaining: f.turnsRemaining - 1 }))
    .filter(f => f.turnsRemaining > 0);
  // Age flares and recompute lightTiles from active flares.
  // After the 2nd turn (turnsRemaining drops to 1), radius shrinks by 1.
  state.flares = state.flares
    .map(f => ({ ...f, turnsRemaining: f.turnsRemaining - 1 }))
    .filter(f => f.turnsRemaining > 0);
  state.lightTiles = [];
  for (const flare of state.flares) {
    // Last-turn radius-shrink is a cosmetic fade for multi-turn flares (the
    // `flare` bomb itself). Phosphorus is sized to match its fire footprint
    // and should hold its full configured radius for the entire active
    // window — shrinking it on its last turn looks like a bug because the
    // lit area abruptly contracts while fires are still burning under it.
    const radius = flare.turnsRemaining <= 1 && flare.kind !== 'phosphorus'
      ? Math.max(1, flare.initialRadius - 1)
      : flare.initialRadius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = flare.x + dx;
        const ty = flare.y + dy;
        if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height) {
          state.lightTiles.push({ x: tx, y: ty, turnsRemaining: flare.turnsRemaining, kind: flare.kind });
        }
      }
    }
  }

  // --- 7b. Age smoke clouds ---
  const expiredCloudIds: string[] = [];
  state.smokeClouds = state.smokeClouds
    .map(c => ({ ...c, turnsRemaining: c.turnsRemaining - 1 }))
    .filter(c => {
      if (c.turnsRemaining <= 0) {
        expiredCloudIds.push(c.id);
        return false;
      }
      return true;
    });
  for (const id of expiredCloudIds) events.push({ kind: 'smoke_expired', cloudId: id });

  // --- 7d. Age Shield Walls. Decrement turnsRemaining; on reach-0, shatter:
  //     emit shield_wall_broken and persist a ShieldShard at each tile.
  //     Shards are cosmetic-only floor decals (no gameplay effect).
  const survivingWalls: typeof state.shieldWalls = [];
  for (const wall of state.shieldWalls ?? []) {
    const next = wall.turnsRemaining - 1;
    if (next <= 0) {
      const shardIds: string[] = [];
      for (const t of wall.tiles) {
        const id = nextShardId();
        state.shieldShards.push({ id, x: t.x, y: t.y });
        shardIds.push(id);
      }
      events.push({
        kind: 'shield_wall_broken',
        wallId: wall.id,
        tiles: wall.tiles.map(t => ({ x: t.x, y: t.y })),
        shardIds,
      });
    } else {
      survivingWalls.push({ ...wall, turnsRemaining: next });
    }
  }
  state.shieldWalls = survivingWalls;

  // --- 7c. Age status effects (Stunned, etc.) ---
  for (const b of state.bombermen) {
    if (!b.statusEffects || b.statusEffects.length === 0) continue;
    const before = b.statusEffects.length;
    b.statusEffects = b.statusEffects
      .map(s => ({ ...s, turnsRemaining: s.turnsRemaining - 1 }))
      .filter(s => {
        if (s.turnsRemaining <= 0) {
          if (s.kind === 'stunned') events.push({ kind: 'stun_expired', playerId: b.playerId });
          return false;
        }
        return true;
      });
    // Guard unused warning
    void before;
  }

  // --- 8. Age bleeding ---
  for (const b of state.bombermen) {
    if (b.bleedingTurns > 0) b.bleedingTurns -= 1;
  }

  // --- 9. Deaths ---
  // Bombermen on escape tiles are immune to death this turn — if they reach
  // the escape with 0 HP they still make it out alive.
  for (const b of state.bombermen) {
    if (b.alive && b.hp <= 0 && !b.escaped) {
      b.alive = false;
      // A dying bomberman can't also be in Melee Trap Mode — drop the
      // flag so clients stop rendering their crouch+sword indicator.
      if (b.meleeTrapMode) {
        b.meleeTrapMode = false;
        events.push({ kind: 'melee_trap_changed', playerId: b.playerId, active: false });
      }
      const killerId = lastDamagedBy.get(b.playerId) ?? null;
      // Kill SP credit. Self-damage (killer==victim) or environmental
      // deaths (killerId==null) award nothing. Scavs can't bank, but we
      // still credit so bots/scavs that "kill" each other don't get
      // special-cased.
      if (killerId && killerId !== b.playerId) {
        const killer = state.bombermen.find(k => k.playerId === killerId);
        if (killer && !killer.isScav) {
          const reward = b.isScav
            ? BALANCE.upgrades.sp.perScavKill
            : BALANCE.upgrades.sp.perPlayerKill;
          killer.sp += reward;
        }
      }
      events.push({ kind: 'died', playerId: b.playerId, x: b.x, y: b.y, killerId });
      // Drop a body with current treasures + inventory
      const bombs: { type: BombType; count: number }[] = [];
      for (const slot of b.inventory.slots) {
        if (slot && slot.count > 0) bombs.push({ type: slot.type, count: slot.count });
      }
      state.bodies.push({
        id: nextBodyId(),
        x: b.x,
        y: b.y,
        ownerPlayerId: b.playerId,
        treasures: b.treasures,
        coins: b.coins ?? 0,
        keys: b.keys ?? 0,
        bombs,
        // Inherit the deceased's tier-stat shape so the body's loot panel
        // displays the right number of slots and stack cap.
        maxCustomSlots: b.maxCustomSlots,
        stackSize: b.stackSize,
      });
      b.treasures = {};
      b.coins = 0;
      b.keys = 0;
      // Reset inventory to the bomberman's own slot count (preserve shape
      // even though the corpse is now empty — we'll keep b around as a
      // placeholder until full removal). Use `b.maxCustomSlots` rather than
      // a hardcoded 4-array.
      b.inventory = { slots: new Array(b.maxCustomSlots).fill(null) };
    }
  }

  // --- 9.25. Melee Trap entry ---
  // Any alive bomberman whose effective action this turn was idle AND
  // who didn't just exit trap mode this turn enters Melee Trap Mode.
  // Stunned bombermen and bombermen standing inside smoke cannot enter
  // — a stun turn doesn't count toward the "skip a turn" requirement,
  // and smoke can't be used as a hiding spot for laying a trap. They'll
  // need to idle another clean turn (out of stun / out of smoke) to arm.
  // The trap-mode bomberman crouches and will counter-attack anyone who
  // walks into their Chebyshev-1 range next turn.
  for (const b of state.bombermen) {
    if (!b.alive || b.escaped) continue;
    if (b.idleAction !== 'attack') continue; // only Attack-class arms a melee trap
    if (b.meleeTrapMode) continue; // already in — stay
    if (exitedTrapThisTurn.has(b.playerId)) continue; // just exited, can't re-enter same turn
    if (isStunned(b)) continue;
    if (isInsideSmoke(state, b.x, b.y)) continue;
    const act = effectiveActions.get(b.playerId) ?? { kind: 'idle' as const };
    if (act.kind === 'idle') {
      b.meleeTrapMode = true;
      events.push({ kind: 'melee_trap_changed', playerId: b.playerId, active: true });
    }
  }

  // --- 9.5. Escape-hatch evaluation ---
  // Run after all position changes (movement in step 1, teleport in step 5)
  // and after death handling in step 9, so a bomberman killed on the hatch
  // doesn't escape post-mortem. Escape requires `BALANCE.escapeHatches
  // .idleTurnsRequired` consecutive turns of idle-on-hatch — a player walking
  // through the tile or throwing from it does not extract. The turn the
  // bomberman moves onto the hatch does NOT count (action was 'move').
  // `onHatchIdleTurns` increments on consecutive idle-on-hatch turns and
  // resets otherwise; escape fires once the count reaches the threshold.
  for (const b of state.bombermen) {
    if (!b.alive || b.escaped) continue;
    const action = effectiveActions.get(b.playerId) ?? { kind: 'idle' };
    const onHatch = state.escapeTiles.some(t => t.x === b.x && t.y === b.y);
    const onBrokenHatch = state.brokenHatches.some(t => t.x === b.x && t.y === b.y);
    // Keys gate: requires the bomberman to be carrying the hatch unlock cost.
    // Tutorial uses a reduced requirement (NEW_META §7) — see docs/NEW_META.md.
    const keysCap = state.isTutorial === true
      ? BALANCE.keys.tutorialRequiredPerHatch
      : BALANCE.keys.requiredPerHatch;
    const hasEnoughKeys = (b.keys ?? 0) >= keysCap;
    if (onHatch && !onBrokenHatch && hasEnoughKeys && action.kind === 'idle') {
      b.onHatchIdleTurns += 1;
      if (b.onHatchIdleTurns >= BALANCE.escapeHatches.idleTurnsRequired) {
        b.escaped = true;
        // Keys are spent on the hatch.
        b.keys = 0;
      }
    } else {
      b.onHatchIdleTurns = 0;
    }
  }

  // --- 9.55. Idle Action progress (Heal / Disguise classes) ---
  // Attack-class bombermen arm a melee trap (step 9.25); Heal and Disguise
  // classes instead accumulate `idleStillTurns` while standing still and fire
  // once their per-class threshold is reached. Moving, throwing, being stunned,
  // standing in smoke, or taking damage this turn all reset the counter (and
  // drop any active disguise) — the spec's "if attacked, the waiting resets".
  const damagedThisTurnIds = new Set<string>();
  for (const e of events) {
    if (e.kind === 'damaged') damagedThisTurnIds.add(e.playerId);
    else if (e.kind === 'melee_attack') damagedThisTurnIds.add(e.victimId);
  }
  for (const b of state.bombermen) {
    if (!b.alive || b.escaped) continue;
    if (b.idleAction === 'attack') continue; // handled by Melee Trap Mode

    const action = effectiveActions.get(b.playerId) ?? { kind: 'idle' as const };
    const stillIdle =
      action.kind === 'idle' &&
      !isStunned(b) &&
      !isInsideSmoke(state, b.x, b.y) &&
      !damagedThisTurnIds.has(b.playerId);

    if (!stillIdle) {
      b.idleStillTurns = 0;
      if (b.disguiseFrame !== undefined) {
        b.disguiseFrame = undefined;
        events.push({ kind: 'disguise_removed', playerId: b.playerId, x: b.x, y: b.y });
      }
      continue;
    }

    if (b.idleAction === 'heal') {
      const onHatch = state.escapeTiles.some(t => t.x === b.x && t.y === b.y);
      // Healing never starts at full HP or while parked on an escape hatch
      // (the hatch has its own ready indicator — avoid a visual clash). No
      // progress accrues, so the client shows no heal hourglass.
      if (onHatch || b.hp >= b.maxHp) {
        b.idleStillTurns = 0;
        continue;
      }
      b.idleStillTurns += 1;
      if (b.idleStillTurns >= BALANCE.idleActions.healIdleTurns) {
        b.hp = Math.min(b.maxHp, b.hp + BALANCE.idleActions.healAmount);
        b.idleStillTurns = 0; // restart the cycle so it can keep healing
        events.push({
          kind: 'heal_applied',
          playerId: b.playerId,
          amount: BALANCE.idleActions.healAmount,
          hpRemaining: b.hp,
          x: b.x,
          y: b.y,
        });
      }
    } else {
      // Disguise class. A bomberman standing on a chest tile can't melt into
      // furniture they're looting — the chest must stay visibly interactable.
      // Reset progress (mirrors the heal-on-hatch guard) so disguising only
      // resumes once they step off the chest.
      const onChest = state.chests.some(c => c.x === b.x && c.y === b.y);
      if (onChest) {
        b.idleStillTurns = 0;
        continue;
      }
      b.idleStillTurns += 1;
      if (b.disguiseFrame === undefined && b.idleStillTurns >= BALANCE.idleActions.disguiseIdleTurns) {
        const seedBase = hashString(`${state.matchId}:${state.turnNumber}:${b.playerId}:disguise`);
        const dRng = createSeededRandom(seedBase);
        const frame = Math.floor(dRng() * BALANCE.idleActions.disguiseObjectCount);
        b.disguiseFrame = frame;
        events.push({ kind: 'disguise_applied', playerId: b.playerId, frame, x: b.x, y: b.y });
      }
    }
  }

  // --- 10. Escapes (remove from future action but keep in list for scoring) ---
  // The bomberman's hatch coordinates are captured here (before any later
  // mutation) and pushed into brokenHatches so the hatch is single-use for
  // the rest of the match.
  for (const b of state.bombermen) {
    if (b.alive && b.escaped) {
      const hatchX = b.x;
      const hatchY = b.y;
      events.push({ kind: 'escaped', playerId: b.playerId, treasures: { ...b.treasures }, hatchX, hatchY });
      const already = state.brokenHatches.some(t => t.x === hatchX && t.y === hatchY);
      if (!already) state.brokenHatches.push({ x: hatchX, y: hatchY });
    }
  }

  // --- 10.5 Survival SP ---
  // +1 SP per `perSurvivalTurns` turns alive. Fires only on the milestone
  // turn (turn % N == 0) so a 30-turn match awards 6 SP at perSurvivalTurns=5.
  // Skip scavs — they don't bank.
  if (state.turnNumber > 0 && state.turnNumber % BALANCE.upgrades.sp.perSurvivalTurns === 0) {
    for (const b of state.bombermen) {
      if (b.alive && !b.escaped && !b.isScav) b.sp += 1;
    }
  }

  // --- 11. Match-end check ---
  // Match ends when: everyone is dead/escaped, OR the turn limit is reached.
  // A sole surviving Bomberman does NOT end the match — they must escape or
  // wait out the timer. Per the brief: "If Players all Escape from the Level
  // or all die the Match will end as well."
  // Scavs are excluded from the alive count — once all real players are
  // dead/escaped the match ends regardless of remaining scavs (otherwise a
  // late-spawned scav could keep an otherwise-finished match running).
  const aliveAndActive = state.bombermen.filter(b => b.alive && !b.escaped && !b.isScav);
  if (aliveAndActive.length === 0) {
    state.phase = 'ended';
    const anyEscaped = state.bombermen.some(b => b.escaped);
    if (anyEscaped) state.endReason = 'all_escaped';
    else state.endReason = 'all_dead';
  } else if (state.turnNumber >= BALANCE.match.turnLimit) {
    // Everyone still alive dies at the turn limit per the brief. Scavs
    // (excluded from aliveAndActive above) also die so deaths get emitted.
    for (const b of state.bombermen) {
      if (!b.alive || b.escaped) continue;
      b.alive = false;
      events.push({ kind: 'died', playerId: b.playerId, x: b.x, y: b.y, killerId: null });
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
 * Try to stash up to `count` of `type` into a Bomberman's custom slots.
 * Fills existing matching stacks first, then uses empty slots.
 * Returns the number of bombs actually stashed.
 *
 * Currently unreferenced (loot logic lives in MatchRoom.handleLoot for the
 * real-time path); kept here as a reusable helper. Pass the Bomberman's
 * own `stackSize` so the cap follows tier rules.
 */
function tryStashBomb(inventory: BombInventory, type: BombType, count: number, stackLimit: number): number {
  if (count <= 0) return 0;
  let remaining = count;

  // 1. Top up matching slots
  for (let i = 0; i < inventory.slots.length && remaining > 0; i++) {
    const slot = inventory.slots[i];
    if (!slot || slot.type !== type) continue;
    const room = stackLimit - slot.count;
    if (room <= 0) continue;
    const take = Math.min(room, remaining);
    slot.count += take;
    remaining -= take;
  }

  // 2. Fill empty slots
  for (let i = 0; i < inventory.slots.length && remaining > 0; i++) {
    if (inventory.slots[i] != null) continue;
    const take = Math.min(stackLimit, remaining);
    inventory.slots[i] = { type, count: take };
    remaining -= take;
  }

  return count - remaining;
}

function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
