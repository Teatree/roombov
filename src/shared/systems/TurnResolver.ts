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
  DroppedBody, MatchState, PlayerAction,
} from '../types/match.ts';
import type { BombermanState, BombInventory, BombSlot } from '../types/bomberman.ts';
import type { BombInstance, FireTile, LightTile, BombType } from '../types/bombs.ts';
import type { MapData } from '../types/map.ts';
import { TileType } from '../types/map.ts';
import { resolveBombTrigger, type Tile } from './BombResolver.ts';
import { hasLineOfSight } from './LineOfSight.ts';

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
    chests: s.chests.map(c => ({ ...c, bombs: c.bombs.map(b => ({ ...b })) })),
    doors: (s.doors ?? []).map(d => ({ ...d, tiles: d.tiles.map(t => ({ ...t })) })),
    bodies: s.bodies.map(b => ({ ...b, bombs: b.bombs.map(bb => ({ ...bb })) })),
    bombs: s.bombs.map(b => ({ ...b })),
    fireTiles: s.fireTiles.map(f => ({ ...f })),
    lightTiles: s.lightTiles.map(l => ({ ...l })),
    flares: s.flares.map(f => ({ ...f })),
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
  | { kind: 'damaged'; playerId: string; hpRemaining: number }
  | { kind: 'died'; playerId: string; x: number; y: number; killerId: string | null }
  | { kind: 'escaped'; playerId: string }
  | { kind: 'coin_collected'; playerId: string; amount: number }
  | { kind: 'body_looted'; playerId: string; bodyId: string; coins: number }
  | { kind: 'teleport'; playerId: string; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'door_opened'; doorId: number }
  | { kind: 'rush_changed'; playerId: string; active: boolean };

export function resolveTurn(
  prev: MatchState,
  actions: Map<string, PlayerAction>,
  map: MapData,
): TurnResolveResult {
  const state = cloneState(prev);
  const events: TurnEvent[] = [];

  // Per-turn flags reset before any step runs. `teleportedThisTurn` is set in
  // step 5 when an Ender Pearl lands its thrower somewhere new; the step 2
  // escape check honors it so teleporting onto an escape hatch does NOT
  // extract same-turn — the player must stay on the hatch into the next turn.
  for (const b of state.bombermen) {
    b.teleportedThisTurn = false;
  }

  // Only alive, non-escaped Bombermen can act
  const actors = state.bombermen.filter(b => b.alive && !b.escaped);

  // --- 1. Movement (supports Out of Combat Rush: two sequential 1-tile moves per turn) ---
  for (const bomberman of actors) {
    const action = actions.get(bomberman.playerId) ?? { kind: 'idle' };
    if (action.kind !== 'move') continue;

    // First move: must be adjacent (Chebyshev 1)
    const dist1 = chebyshevDistance(bomberman.x, bomberman.y, action.x, action.y);
    if (dist1 === 1 && isWalkable(map, action.x, action.y)) {
      const fromX = bomberman.x;
      const fromY = bomberman.y;
      bomberman.x = action.x;
      bomberman.y = action.y;
      events.push({ kind: 'moved', playerId: bomberman.playerId, fromX, fromY, toX: action.x, toY: action.y });
      if (bomberman.bleedingTurns > 0) {
        state.bloodTiles.push({ x: fromX, y: fromY });
      }

      // Rush second move: if active and a second target was provided
      if (BALANCE.match.rush.enabled && bomberman.rushActive &&
          action.rushX !== undefined && action.rushY !== undefined) {
        const dist2 = chebyshevDistance(bomberman.x, bomberman.y, action.rushX, action.rushY);
        if (dist2 === 1 && isWalkable(map, action.rushX, action.rushY)) {
          const from2X = bomberman.x;
          const from2Y = bomberman.y;
          bomberman.x = action.rushX;
          bomberman.y = action.rushY;
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
    const action = actions.get(bomberman.playerId);
    if (!action || action.kind === 'idle') {
      events.push({ kind: 'idle', playerId: bomberman.playerId, x: bomberman.x, y: bomberman.y });
    }
  }

  // --- 2. Interaction pass (auto-collect coins + escape; bomb looting is manual) ---
  for (const bomberman of actors) {
    if (!bomberman.alive) continue;

    // Chest coins — auto-collect on walk-over; also marks chest as opened
    const chest = state.chests.find(c => c.x === bomberman.x && c.y === bomberman.y);
    if (chest) {
      if (chest.coins > 0) {
        bomberman.coins += chest.coins;
        events.push({ kind: 'coin_collected', playerId: bomberman.playerId, amount: chest.coins });
        chest.coins = 0;
      }
      if (!chest.opened) chest.opened = true;
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

    // Escape evaluation deferred to step 9.5 (after teleport in step 5).
    // See the onHatchIdleTurns logic below — escape now requires one full
    // turn of the bomberman standing idle on the hatch tile.
  }

  // Door proximity: open doors when any alive Bomberman is within Chebyshev 1
  for (const door of state.doors ?? []) {
    if (door.opened) continue;
    const nearby = actors.some(b =>
      b.alive && !b.escaped &&
      door.tiles.some(t => Math.max(Math.abs(b.x - t.x), Math.abs(b.y - t.y)) <= 1),
    );
    if (nearby) {
      door.opened = true;
      events.push({ kind: 'door_opened', doorId: door.id });
    }
  }

  // --- 2b. Out of Combat Rush state update ---
  if (BALANCE.match.rush.enabled) {
    const rushCfg = BALANCE.match.rush;
    for (const bomberman of actors) {
      if (!bomberman.alive || bomberman.escaped) continue;
      const action = actions.get(bomberman.playerId) ?? { kind: 'idle' };
      const threw = action.kind === 'throw';
      // Enemy proximity breaks rush only when the two Bombermen have mutual
      // line of sight. `hasLineOfSight` is symmetric on a wall grid — if A
      // can see B, B can see A — so one call covers "both must see each
      // other". This stops flare-discovered enemies (you see them, they
      // don't see you) from nuking your rush.
      const ts = map.tileSize;
      const enemyNearby = actors.some(other => {
        if (other.playerId === bomberman.playerId) return false;
        if (!other.alive || other.escaped) return false;
        if (chebyshevDistance(bomberman.x, bomberman.y, other.x, other.y) > rushCfg.proximityRadius) return false;
        return hasLineOfSight(
          bomberman.x * ts + ts / 2, bomberman.y * ts + ts / 2,
          other.x * ts + ts / 2, other.y * ts + ts / 2,
          map.grid, ts,
        );
      });
      // Bomb landed nearby (any bomb not owned by this player)
      const bombNearby = state.bombs.some(bomb =>
        bomb.ownerId !== bomberman.playerId &&
        chebyshevDistance(bomberman.x, bomberman.y, bomb.x, bomb.y) <= rushCfg.bombProximityRadius,
      );
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
    // Bombs can be thrown at any tile (even walls, when throwing blind into
    // unseen fog). Non-flare bombs on walls will fizzle at trigger time.
    // Only reject clearly out-of-bounds targets.
    if (action.x < 0 || action.y < 0 || action.x >= map.width || action.y >= map.height) continue;

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

  const damagedThisTurn = new Set<string>();
  /** Tracks who last damaged each player (for kill attribution). */
  const lastDamagedBy = new Map<string, string>();
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
  // Ender pearls resolve first — teleport the thrower out of danger
  // before any explosions deal damage. Without this, a player who throws
  // a pearl the same turn a bomb kills them would die before teleporting.
  toResolve.sort((a, b) => {
    const aP = a.type === 'ender_pearl' ? 0 : 1;
    const bP = b.type === 'ender_pearl' ? 0 : 1;
    return aP - bP;
  });

  while (toResolve.length > 0) {
    const bomb = toResolve.shift()!;
    if (triggeredBombIds.has(bomb.id)) continue;
    triggeredBombIds.add(bomb.id);

    // Ender Pearl: teleport the thrower to the landing tile (or nearest
    // walkable tile if the target is an obstacle). Handled before the fizzle
    // check because the pearl explicitly shifts to a valid tile instead of
    // fizzling.
    if (bomb.type === 'ender_pearl') {
      let destX = bomb.x;
      let destY = bomb.y;
      if (!isWalkable(map, destX, destY)) {
        const alt = nearestWalkable(map, destX, destY);
        if (alt) { destX = alt.x; destY = alt.y; }
        // If no walkable tile exists at all, pearl fizzles (shouldn't happen on real maps)
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
    const trigger = resolveBombTrigger(bomb.type, bomb.x, bomb.y, map, closedDoorTiles);

    // Open any closed doors hit by the explosion
    const allBlastTiles = [...trigger.damageTiles, ...trigger.fireTiles, ...trigger.lightTiles];
    for (const door of state.doors ?? []) {
      if (door.opened) continue;
      if (door.tiles.some(dt => allBlastTiles.some(bt => bt.x === dt.x && bt.y === dt.y))) {
        door.opened = true;
        events.push({ kind: 'door_opened', doorId: door.id });
      }
    }

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
        lastDamagedBy.set(b.playerId, bomb.ownerId);
        events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp });
      }
    }

    // Spawn fire tiles
    for (const tile of trigger.fireTiles) {
      state.fireTiles.push({ x: tile.x, y: tile.y, turnsRemaining: trigger.fireDuration, ownerId: bomb.ownerId });
    }

    // Flare: create an ActiveFlare record (lightTiles are derived from flares each turn)
    if (trigger.lightTiles.length > 0 && trigger.lightDuration > 0) {
      state.flares.push({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        initialRadius: 4, // flare's circle radius from bomb config
        turnsRemaining: trigger.lightDuration,
      });
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
      lastDamagedBy.set(b.playerId, fire.ownerId);
      events.push({ kind: 'damaged', playerId: b.playerId, hpRemaining: b.hp });
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
    const radius = flare.turnsRemaining <= 1
      ? Math.max(1, flare.initialRadius - 1)
      : flare.initialRadius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = flare.x + dx;
        const ty = flare.y + dy;
        if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height) {
          state.lightTiles.push({ x: tx, y: ty, turnsRemaining: flare.turnsRemaining });
        }
      }
    }
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
      events.push({ kind: 'died', playerId: b.playerId, x: b.x, y: b.y, killerId: lastDamagedBy.get(b.playerId) ?? null });
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

  // --- 9.5. Escape-hatch evaluation ---
  // Run after all position changes (movement in step 1, teleport in step 5)
  // and after death handling in step 9, so a bomberman killed on the hatch
  // doesn't escape post-mortem. Escape requires one full turn of idle-on-
  // hatch — a player walking through the tile or throwing from it does not
  // extract. `onHatchIdleTurns` increments on consecutive idle-on-hatch
  // turns and resets otherwise; escape fires at count 1.
  for (const b of state.bombermen) {
    if (!b.alive || b.escaped) continue;
    const action = actions.get(b.playerId) ?? { kind: 'idle' };
    const onHatch = state.escapeTiles.some(t => t.x === b.x && t.y === b.y);
    if (onHatch && action.kind === 'idle') {
      b.onHatchIdleTurns += 1;
      if (b.onHatchIdleTurns >= 1) {
        b.escaped = true;
      }
    } else {
      b.onHatchIdleTurns = 0;
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
