/**
 * Server-side AI for Scavenger NPCs (scavs).
 *
 * Scavs are aggressive bomberman-like enemies that spawn mid-match via the
 * `TurnResolver` step 5d. Same input/output contract as `BotPlayer.tick()` —
 * MatchRoom calls it once per input phase, receives a `PlayerAction`, and
 * pipes it into the same `pendingActions` map as real players + regular bots.
 *
 * Differences from `BotPlayer`:
 *   - No `escape` state. Scavs do not extract.
 *   - No wounded-retreat. No fart_escape / ender_pearl usage.
 *   - Engages on first sight (no 1-turn aggro delay). `BALANCE.scavs.aggroDelayTurns`.
 *   - `BALANCE.scavs` knobs for chase / predict / flare chance.
 *   - Never loots, EXCEPT as a fallback when all 4 custom slots are empty.
 *
 * Shared geometry/decision pieces (avoidBombs, pathStep, pickAttackSlot,
 * visibility, etc.) are duplicated from BotPlayer rather than refactored into
 * a base class — keeps the diff surgical and the duplication is small.
 */

import type { MatchState, PlayerAction } from '../shared/types/match.ts';
import type { BombermanState } from '../shared/types/bomberman.ts';
import type { BombType, BombInstance } from '../shared/types/bombs.ts';
import type { MapData } from '../shared/types/map.ts';
import { TileType } from '../shared/types/map.ts';
import type { LootBombMsg } from '../shared/types/messages.ts';
import { findPath } from '../shared/systems/Pathfinding.ts';
import { getSeeThroughTileSet, hasLineOfSight } from '../shared/systems/LineOfSight.ts';
import { shapeTiles } from '../shared/systems/BombResolver.ts';
import { BOMB_CATALOG } from '../shared/config/bombs.ts';
import { BALANCE } from '../shared/config/balance.ts';

type ScavState = 'explore' | 'fight';

function isInsideSmoke(state: MatchState, x: number, y: number): boolean {
  for (const c of state.smokeClouds ?? []) {
    if (c.tiles.some(t => t.x === x && t.y === y)) return true;
  }
  return false;
}

export class ScavPlayer {
  readonly playerId: string;

  private aiState: ScavState = 'explore';
  private targetEnemyId: string | null = null;
  private lastSeenEnemyPos: { x: number; y: number } | null = null;
  private prevEnemyPos: { x: number; y: number } | null = null;
  private turnsSinceTargetSeen = 0;
  private turnsEnemyVisible = 0;
  private exploreTarget: { x: number; y: number } | null = null;
  private seenTiles = new Set<string>();

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  tick(state: MatchState, map: MapData, onLoot: (msg: LootBombMsg) => void): PlayerAction {
    const me = state.bombermen.find(b => b.playerId === this.playerId);
    if (!me || !me.alive || me.escaped) return { kind: 'idle' };

    const visible = this.computeVisibleTiles(me, state, map);
    for (const key of visible) this.seenTiles.add(key);

    this.tryLoot(me, state, onLoot);
    this.updateAiState(me, state, map, visible);

    switch (this.aiState) {
      case 'fight':   return this.fightAction(me, state, map, visible);
      case 'explore': return this.exploreAction(me, state, map, visible);
    }
  }

  // ---- Visibility ----

  private computeVisibleTiles(me: BombermanState, state: MatchState, map: MapData): Set<string> {
    const visible = new Set<string>();
    const ts = map.tileSize;
    const fromPx = me.x * ts + ts / 2;
    const fromPy = me.y * ts + ts / 2;
    const r = BALANCE.match.losRadius;
    const seeThroughTiles = getSeeThroughTileSet(map);
    const closedDoors = new Set<string>();
    for (const d of state.doors ?? []) {
      if (d.opened) continue;
      for (const t of d.tiles) closedDoors.add(`${t.x},${t.y}`);
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = me.x + dx;
        const ty = me.y + dy;
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > r) continue;
        const toPx = tx * ts + ts / 2;
        const toPy = ty * ts + ts / 2;
        if (hasLineOfSight(fromPx, fromPy, toPx, toPy, map.grid, ts, closedDoors, undefined, seeThroughTiles)) {
          visible.add(`${tx},${ty}`);
        }
      }
    }
    for (const lt of state.lightTiles) visible.add(`${lt.x},${lt.y}`);
    return visible;
  }

  private canSee(x: number, y: number, visible: Set<string>): boolean {
    return visible.has(`${x},${y}`);
  }

  // ---- State transitions ----

  private updateAiState(me: BombermanState, state: MatchState, map: MapData, visible: Set<string>): void {
    void me;
    void map;
    const cfg = BALANCE.scavs;

    // Visible enemies — players, regular bots, even other scavs.
    const enemies = state.bombermen.filter(b =>
      b.playerId !== this.playerId && b.alive && !b.escaped &&
      this.canSee(b.x, b.y, visible) &&
      !isInsideSmoke(state, b.x, b.y),
    );

    if (enemies.length > 0) {
      this.turnsEnemyVisible++;
      if (!this.targetEnemyId || !enemies.find(e => e.playerId === this.targetEnemyId)) {
        this.targetEnemyId = enemies[0].playerId;
      }
      const target = enemies.find(e => e.playerId === this.targetEnemyId)!;
      this.prevEnemyPos = this.lastSeenEnemyPos;
      this.lastSeenEnemyPos = { x: target.x, y: target.y };
      this.turnsSinceTargetSeen = 0;
      // Scavs engage as soon as `turnsEnemyVisible > aggroDelayTurns` —
      // default 0 so first-sight is an immediate fight transition.
      if (this.turnsEnemyVisible > cfg.aggroDelayTurns) {
        this.aiState = 'fight';
        return;
      }
      this.aiState = 'explore';
      return;
    }

    this.turnsEnemyVisible = 0;

    if (this.aiState === 'fight' && this.targetEnemyId) {
      this.turnsSinceTargetSeen++;
      const targetBm = state.bombermen.find(b => b.playerId === this.targetEnemyId);
      if (!targetBm || !targetBm.alive) {
        this.targetEnemyId = null;
        this.lastSeenEnemyPos = null;
        this.aiState = 'explore';
        return;
      }
      if (this.turnsSinceTargetSeen <= cfg.chaseTurns) return;
      this.targetEnemyId = null;
      this.lastSeenEnemyPos = null;
    }

    this.aiState = 'explore';
  }

  // ---- Actions ----

  private fightAction(me: BombermanState, state: MatchState, map: MapData, visible: Set<string>): PlayerAction {
    const cfg = BALANCE.scavs;

    const targetBm = state.bombermen.find(b => b.playerId === this.targetEnemyId) ?? null;
    const targetVisible = !!targetBm
      && this.canSee(targetBm.x, targetBm.y, visible)
      && !isInsideSmoke(state, targetBm.x, targetBm.y);

    // No wounded-retreat for scavs — they never run. Dodge incoming bombs only.
    const dangerAction = this.avoidBombs(me, state, map);
    if (dangerAction) return dangerAction;

    if (targetBm && targetVisible) {
      let throwX = targetBm.x;
      let throwY = targetBm.y;
      if (Math.random() < cfg.predictChance && this.prevEnemyPos) {
        const px = targetBm.x + (targetBm.x - this.prevEnemyPos.x);
        const py = targetBm.y + (targetBm.y - this.prevEnemyPos.y);
        if (px >= 0 && py >= 0 && px < map.width && py < map.height &&
            map.grid[py]?.[px] === 0) {
          throwX = px;
          throwY = py;
        }
      }
      const slot = this.pickAttackSlot(me, targetBm);
      return { kind: 'throw', slotIndex: slot, x: throwX, y: throwY };
    }

    if (this.lastSeenEnemyPos) {
      const flareSlot = this.findSlotWithType(me, 'flare');
      if (flareSlot >= 0 && this.turnsSinceTargetSeen === 1) {
        return { kind: 'throw', slotIndex: flareSlot, x: this.lastSeenEnemyPos.x, y: this.lastSeenEnemyPos.y };
      }
      const attackSlot = this.pickAttackSlot(me);
      if (attackSlot > 0 && this.turnsSinceTargetSeen <= cfg.chaseTurns) {
        return { kind: 'throw', slotIndex: attackSlot, x: this.lastSeenEnemyPos.x, y: this.lastSeenEnemyPos.y };
      }
      const path = findPath(me.x, me.y, this.lastSeenEnemyPos.x, this.lastSeenEnemyPos.y, map);
      if (path.length > 0) return this.pathStep(me, path, state);
    }

    return { kind: 'idle' };
  }

  private exploreAction(me: BombermanState, state: MatchState, map: MapData, visible: Set<string>): PlayerAction {
    void visible;
    const cfg = BALANCE.scavs;

    const dangerAction = this.avoidBombs(me, state, map);
    if (dangerAction) return dangerAction;

    if (Math.random() < cfg.flareChance) {
      const flareSlot = this.findSlotWithType(me, 'flare');
      if (flareSlot >= 0) {
        const slot = me.inventory.slots[flareSlot - 1];
        if (slot && slot.count > 1) {
          const darkTarget = this.findDarkTarget(me, map);
          if (darkTarget) {
            return { kind: 'throw', slotIndex: flareSlot, x: darkTarget.x, y: darkTarget.y };
          }
        }
      }
    }

    // Scavs do NOT detour to chests / keys — they never extract.
    if (!this.exploreTarget || this.seenTiles.has(`${this.exploreTarget.x},${this.exploreTarget.y}`)
        || (me.x === this.exploreTarget.x && me.y === this.exploreTarget.y)) {
      this.exploreTarget = this.pickExploreTarget(me, map);
    }
    if (this.exploreTarget) {
      const path = findPath(me.x, me.y, this.exploreTarget.x, this.exploreTarget.y, map);
      if (path.length > 0) return this.pathStep(me, path, state);
      this.exploreTarget = null;
    }
    return this.randomMove(me, state, map);
  }

  // ---- Helpers (mirrors BotPlayer; loot gated on empty inventory) ----

  private tryLoot(me: BombermanState, state: MatchState, onLoot: (msg: LootBombMsg) => void): void {
    // Out-of-bombs fallback only: if any custom slot still has a bomb, skip
    // looting entirely. Scavs are not scavenging in the colloquial sense —
    // they're predators, only digging through corpses when forced to.
    const hasAnyCustomBomb = me.inventory.slots.some(s => s && s.count > 0);
    if (hasAnyCustomBomb) return;

    for (const chest of state.chests) {
      if (chest.x !== me.x || chest.y !== me.y) continue;
      for (const bomb of chest.bombs) {
        const slot = this.findEmptySlot(me);
        if (slot < 0) break;
        onLoot({ sourceKind: 'chest', sourceId: chest.id, bombType: bomb.type, targetSlotIndex: slot });
      }
    }
    for (const body of state.bodies) {
      if (body.x !== me.x || body.y !== me.y) continue;
      for (const bomb of body.bombs) {
        if (bomb.count <= 0) continue;
        const slot = this.findEmptySlot(me);
        if (slot < 0) break;
        onLoot({ sourceKind: 'body', sourceId: body.id, bombType: bomb.type, targetSlotIndex: slot });
      }
    }
  }

  private findEmptySlot(me: BombermanState): number {
    for (let i = 0; i < me.inventory.slots.length; i++) {
      if (!me.inventory.slots[i]) return i + 1;
    }
    return -1;
  }

  private pathStep(me: BombermanState, path: Array<{ x: number; y: number }>, state?: MatchState): PlayerAction {
    if (path.length === 0) return { kind: 'idle' };
    const isFire = (x: number, y: number): boolean =>
      !!state && state.fireTiles.some(f => f.x === x && f.y === y);
    if (isFire(path[0].x, path[0].y)) return { kind: 'idle' };
    if (me.rushActive && path.length >= 2) {
      if (isFire(path[1].x, path[1].y)) return { kind: 'move', x: path[0].x, y: path[0].y };
      return { kind: 'move', x: path[0].x, y: path[0].y, rushX: path[1].x, rushY: path[1].y };
    }
    return { kind: 'move', x: path[0].x, y: path[0].y };
  }

  private findSlotWithType(me: BombermanState, type: BombType): number {
    for (let i = 0; i < me.inventory.slots.length; i++) {
      const s = me.inventory.slots[i];
      if (s && s.type === type && s.count > 0) return i + 1;
    }
    return -1;
  }

  private pickAttackSlot(me: BombermanState, target?: BombermanState): number {
    const targetStunned = target
      ? (target.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)
      : false;
    if (target && !targetStunned) {
      const flashSlot = this.findSlotWithType(me, 'flash');
      if (flashSlot >= 0) return flashSlot;
    }
    const prefs: BombType[] = ['contact', 'bomb', 'bomb_wide', 'delay_tricky', 'banana', 'molotov', 'big_huge'];
    for (const pref of prefs) {
      const slot = this.findSlotWithType(me, pref);
      if (slot >= 0) return slot;
    }
    return 0;
  }

  private avoidBombs(me: BombermanState, state: MatchState, map: MapData): PlayerAction | null {
    for (const bomb of state.bombs) {
      if (bomb.fuseRemaining > 1) continue;
      const def = BOMB_CATALOG[bomb.type];
      if (def.behavior.kind !== 'explode' && def.behavior.kind !== 'fire') continue;
      const shape = 'shape' in def.behavior ? def.behavior.shape : null;
      if (!shape) continue;
      const tiles = shapeTiles(shape, bomb.x, bomb.y, map);
      if (tiles.some(t => t.x === me.x && t.y === me.y)) {
        const shieldAction = this.maybeDefensiveShield(me, state, map, bomb);
        if (shieldAction) return shieldAction;
        return this.moveAway(me, bomb.x, bomb.y, map, state);
      }
    }
    if (state.fireTiles.some(f => f.x === me.x && f.y === me.y)) {
      return this.randomMove(me, state, map);
    }
    return null;
  }

  private maybeDefensiveShield(me: BombermanState, state: MatchState, map: MapData, bomb: BombInstance): PlayerAction | null {
    void state;
    const shieldSlot = this.findSlotWithType(me, 'shield');
    if (shieldSlot < 0) return null;
    const wallTiles = new Set<string>([
      `${bomb.x},${bomb.y}`,
      `${bomb.x + 1},${bomb.y}`,
      `${bomb.x - 1},${bomb.y}`,
      `${bomb.x},${bomb.y + 1}`,
      `${bomb.x},${bomb.y - 1}`,
    ]);
    if (wallTiles.has(`${me.x},${me.y}`)) return null;
    let hasEscape = false;
    for (let dy = -1; dy <= 1 && !hasEscape; dy++) {
      for (let dx = -1; dx <= 1 && !hasEscape; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = me.x + dx;
        const ny = me.y + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (map.grid[ny]?.[nx] !== TileType.FLOOR) continue;
        if (wallTiles.has(`${nx},${ny}`)) continue;
        hasEscape = true;
      }
    }
    if (!hasEscape) return null;
    return { kind: 'throw', slotIndex: shieldSlot, x: bomb.x, y: bomb.y };
  }

  private moveAway(me: BombermanState, dangerX: number, dangerY: number, map: MapData, state?: MatchState): PlayerAction {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    let bestX = me.x, bestY = me.y, bestDist = 0;
    for (const [dx, dy] of dirs) {
      const nx = me.x + dx;
      const ny = me.y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.grid[ny]?.[nx] !== 0) continue;
      if (state && state.fireTiles.some(f => f.x === nx && f.y === ny)) continue;
      const dist = Math.max(Math.abs(nx - dangerX), Math.abs(ny - dangerY));
      if (dist > bestDist) { bestDist = dist; bestX = nx; bestY = ny; }
    }
    if (bestX === me.x && bestY === me.y) return { kind: 'idle' };
    return { kind: 'move', x: bestX, y: bestY };
  }

  private findDarkTarget(me: BombermanState, map: MapData): { x: number; y: number } | null {
    const r = BALANCE.match.losRadius;
    const candidates: Array<{ x: number; y: number }> = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = me.x + dx;
        const ty = me.y + dy;
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        if (!this.seenTiles.has(`${tx},${ty}`)) candidates.push({ x: tx, y: ty });
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private pickExploreTarget(me: BombermanState, map: MapData): { x: number; y: number } | null {
    let bestTarget: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let attempt = 0; attempt < 50; attempt++) {
      const rx = Math.floor(Math.random() * map.width);
      const ry = Math.floor(Math.random() * map.height);
      if (map.grid[ry]?.[rx] !== 0) continue;
      if (this.seenTiles.has(`${rx},${ry}`)) continue;
      const dist = Math.max(Math.abs(rx - me.x), Math.abs(ry - me.y));
      if (dist < bestDist) { bestDist = dist; bestTarget = { x: rx, y: ry }; }
    }
    return bestTarget;
  }

  private randomMove(me: BombermanState, state: MatchState, map: MapData): PlayerAction {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const shuffled = dirs.sort(() => Math.random() - 0.5);
    for (const [dx, dy] of shuffled) {
      const nx = me.x + dx;
      const ny = me.y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.grid[ny]?.[nx] !== 0) continue;
      if (state.fireTiles.some(f => f.x === nx && f.y === ny)) continue;
      return { kind: 'move', x: nx, y: ny };
    }
    return { kind: 'idle' };
  }
}
