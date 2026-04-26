/**
 * Server-side bot AI for Bomberman matches.
 *
 * Each BotPlayer maintains its own simulated fog of war and a state machine
 * that drives action selection each turn. Bots emulate real players: they
 * explore, loot, fight, and try to escape before the match timer runs out.
 *
 * The MatchRoom calls `tick()` at the start of each input phase. The bot
 * returns a `PlayerAction` and optionally triggers loot pickups via a callback.
 */

import type { MatchState, PlayerAction, Chest, DoorInstance } from '../shared/types/match.ts';
import type { BombermanState } from '../shared/types/bomberman.ts';
import { INVENTORY_SLOT_COUNT } from '../shared/types/bomberman.ts';
import type { BombType, BombInstance } from '../shared/types/bombs.ts';
import type { MapData } from '../shared/types/map.ts';
import type { LootBombMsg } from '../shared/types/messages.ts';
import { findPath } from '../shared/systems/Pathfinding.ts';
import { hasLineOfSight } from '../shared/systems/LineOfSight.ts';
import { shapeTiles } from '../shared/systems/BombResolver.ts';
import { BOMB_CATALOG } from '../shared/config/bombs.ts';
import { BALANCE } from '../shared/config/balance.ts';

type BotState = 'explore' | 'fight' | 'escape';

/** True when any smoke cloud covers the given tile. */
function isInsideSmoke(state: MatchState, x: number, y: number): boolean {
  for (const c of state.smokeClouds ?? []) {
    if (c.tiles.some(t => t.x === x && t.y === y)) return true;
  }
  return false;
}

export class BotPlayer {
  readonly playerId: string;

  // AI state
  private aiState: BotState = 'explore';
  private targetEnemyId: string | null = null;
  private lastSeenEnemyPos: { x: number; y: number } | null = null;
  private prevEnemyPos: { x: number; y: number } | null = null;
  private turnsSinceTargetSeen = 0;
  /** Consecutive turns an enemy has been visible — bot waits 1 turn before aggroing. */
  private turnsEnemyVisible = 0;
  private exploreTarget: { x: number; y: number } | null = null;

  // Visibility
  private seenTiles = new Set<string>();

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  /**
   * Called at the start of each input phase. Returns the action the bot wants
   * to take this turn. Also triggers loot pickups via the callback.
   */
  tick(
    state: MatchState,
    map: MapData,
    onLoot: (msg: LootBombMsg) => void,
  ): PlayerAction {
    const me = state.bombermen.find(b => b.playerId === this.playerId);
    if (!me || !me.alive || me.escaped) return { kind: 'idle' };

    // Update visibility
    const visible = this.computeVisibleTiles(me, state, map);
    for (const key of visible) this.seenTiles.add(key);

    // Try to loot before deciding action
    this.tryLoot(me, state, onLoot);

    // Determine AI state
    this.updateAiState(me, state, map, visible);

    // Compute action based on state
    switch (this.aiState) {
      case 'escape': return this.escapeAction(me, state, map);
      case 'fight':  return this.fightAction(me, state, map, visible);
      case 'explore': return this.exploreAction(me, state, map, visible);
    }
  }

  // ---- Visibility ----

  private computeVisibleTiles(
    me: BombermanState, state: MatchState, map: MapData,
  ): Set<string> {
    const visible = new Set<string>();
    const ts = map.tileSize;
    const fromPx = me.x * ts + ts / 2;
    const fromPy = me.y * ts + ts / 2;
    const r = BALANCE.match.losRadius;
    // Closed doors block the bot's sight just like walls.
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
        if (hasLineOfSight(fromPx, fromPy, toPx, toPy, map.grid, ts, closedDoors)) {
          visible.add(`${tx},${ty}`);
        }
      }
    }

    // Flare-lit tiles are also visible
    for (const lt of state.lightTiles) {
      visible.add(`${lt.x},${lt.y}`);
    }

    return visible;
  }

  private canSee(x: number, y: number, visible: Set<string>): boolean {
    return visible.has(`${x},${y}`);
  }

  // ---- State transitions ----

  private updateAiState(
    me: BombermanState, state: MatchState, map: MapData, visible: Set<string>,
  ): void {
    const cfg = BALANCE.bots;

    // ESCAPE overrides everything
    if (state.turnNumber >= BALANCE.match.turnLimit * cfg.escapeThreshold) {
      this.aiState = 'escape';
      return;
    }

    // Check for visible enemies. Bombermen inside a smoke cloud are hidden
    // to bots — same rule as the player's fog override, just enforced
    // server-side here since bots bypass the client renderer.
    const enemies = state.bombermen.filter(b =>
      b.playerId !== this.playerId && b.alive && !b.escaped &&
      this.canSee(b.x, b.y, visible) &&
      !isInsideSmoke(state, b.x, b.y),
    );

    if (enemies.length > 0) {
      this.turnsEnemyVisible++;
      // Lock onto first encountered target, or keep existing if still visible
      if (!this.targetEnemyId || !enemies.find(e => e.playerId === this.targetEnemyId)) {
        this.targetEnemyId = enemies[0].playerId;
      }
      const target = enemies.find(e => e.playerId === this.targetEnemyId)!;
      this.prevEnemyPos = this.lastSeenEnemyPos;
      this.lastSeenEnemyPos = { x: target.x, y: target.y };
      this.turnsSinceTargetSeen = 0;
      // Wait 1 turn before becoming aggroed — don't attack immediately
      if (this.turnsEnemyVisible >= 2) {
        this.aiState = 'fight';
        return;
      }
      // First turn seeing an enemy — continue exploring but track the target
      this.aiState = 'explore';
      return;
    }

    // No enemies visible — reset the aggro delay counter
    this.turnsEnemyVisible = 0;

    // Target left LOS
    if (this.aiState === 'fight' && this.targetEnemyId) {
      this.turnsSinceTargetSeen++;
      // Check if target is dead
      const targetBm = state.bombermen.find(b => b.playerId === this.targetEnemyId);
      if (!targetBm || !targetBm.alive) {
        this.targetEnemyId = null;
        this.lastSeenEnemyPos = null;
        this.aiState = 'explore';
        return;
      }
      if (this.turnsSinceTargetSeen <= cfg.chaseTurns) {
        // Still fighting (chasing / guessing)
        return;
      }
      // Give up chase
      this.targetEnemyId = null;
      this.lastSeenEnemyPos = null;
    }

    this.aiState = 'explore';
  }

  // ---- Actions ----

  private escapeAction(me: BombermanState, state: MatchState, map: MapData): PlayerAction {
    // Find nearest escape tile
    let bestEscape: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const esc of state.escapeTiles) {
      const d = Math.max(Math.abs(esc.x - me.x), Math.abs(esc.y - me.y));
      if (d < bestDist) { bestDist = d; bestEscape = esc; }
    }
    if (!bestEscape) return this.exploreAction(me, state, map, new Set());

    const path = findPath(me.x, me.y, bestEscape.x, bestEscape.y, map);
    return this.pathStep(me, path, state);
  }

  private fightAction(
    me: BombermanState, state: MatchState, map: MapData, visible: Set<string>,
  ): PlayerAction {
    const cfg = BALANCE.bots;

    // Target lookup (reused for multiple decisions below).
    const targetBm = state.bombermen.find(b => b.playerId === this.targetEnemyId) ?? null;
    const targetVisible = !!targetBm
      && this.canSee(targetBm.x, targetBm.y, visible)
      && !isInsideSmoke(state, targetBm.x, targetBm.y);

    // Retreat with Fart Escape when hurt and the target has equal-or-more
    // HP than us — same motivation as Ender Pearl but newer, so prefer
    // Fart when available (leaves a smoke cloud so the target also loses
    // vision of us).
    const outgunned = !!targetBm && me.hp < targetBm.hp;
    const activelyAttacked = targetVisible || me.bleedingTurns > 0
      || state.bombs.some(bomb => bomb.ownerId !== me.playerId
        && Math.max(Math.abs(bomb.x - me.x), Math.abs(bomb.y - me.y)) <= 5);
    if (me.hp < BALANCE.match.bombermanMaxHp && (outgunned || activelyAttacked)) {
      const fartSlot = this.findSlotWithType(me, 'fart_escape');
      if (fartSlot >= 0) {
        const escapeTarget = this.findSafeTile(me, state, map);
        if (escapeTarget) {
          return { kind: 'throw', slotIndex: fartSlot, x: escapeTarget.x, y: escapeTarget.y };
        }
      }
      const pearlSlot = this.findSlotWithType(me, 'ender_pearl');
      if (pearlSlot >= 0) {
        const escapeTarget = this.findSafeTile(me, state, map);
        if (escapeTarget) {
          return { kind: 'throw', slotIndex: pearlSlot, x: escapeTarget.x, y: escapeTarget.y };
        }
      }
    }

    // Avoid bombs first
    const dangerAction = this.avoidBombs(me, state, map);
    if (dangerAction) return dangerAction;

    // If target is visible AND not inside a smoke cloud, attack. Smoked
    // targets are invisible to bots (matches the player's fog override).
    if (targetBm && targetVisible) {
      // Pick throw target: current pos (2/3) or predicted (1/3)
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

    // Target left LOS — chase or guess
    if (this.lastSeenEnemyPos) {
      // Try throwing a flare toward last seen position
      const flareSlot = this.findSlotWithType(me, 'flare');
      if (flareSlot >= 0 && this.turnsSinceTargetSeen === 1) {
        return { kind: 'throw', slotIndex: flareSlot, x: this.lastSeenEnemyPos.x, y: this.lastSeenEnemyPos.y };
      }

      // Has real bombs? Throw into the dark for a few turns. No target
      // reference passed — flash isn't useful without visible confirmation.
      const attackSlot = this.pickAttackSlot(me);
      if (attackSlot > 0 && this.turnsSinceTargetSeen <= cfg.chaseTurns) {
        return { kind: 'throw', slotIndex: attackSlot, x: this.lastSeenEnemyPos.x, y: this.lastSeenEnemyPos.y };
      }

      // Follow toward last known position
      const path = findPath(me.x, me.y, this.lastSeenEnemyPos.x, this.lastSeenEnemyPos.y, map);
      if (path.length > 0) return this.pathStep(me, path, state);
    }

    return { kind: 'idle' };
  }

  private exploreAction(
    me: BombermanState, state: MatchState, map: MapData, visible: Set<string>,
  ): PlayerAction {
    const cfg = BALANCE.bots;

    // Avoid bombs first
    const dangerAction = this.avoidBombs(me, state, map);
    if (dangerAction) return dangerAction;

    // Occasionally throw a flare into the dark
    if (Math.random() < cfg.flareChance) {
      const flareSlot = this.findSlotWithType(me, 'flare');
      if (flareSlot >= 0) {
        // Count remaining flares — keep 1 in reserve
        const slot = me.inventory.slots[flareSlot - 1];
        if (slot && slot.count > 1) {
          const darkTarget = this.findDarkTarget(me, map);
          if (darkTarget) {
            return { kind: 'throw', slotIndex: flareSlot, x: darkTarget.x, y: darkTarget.y };
          }
        }
      }
    }

    // Move toward unexplored area
    if (!this.exploreTarget || this.seenTiles.has(`${this.exploreTarget.x},${this.exploreTarget.y}`)
        || (me.x === this.exploreTarget.x && me.y === this.exploreTarget.y)) {
      this.exploreTarget = this.pickExploreTarget(me, map);
    }

    if (this.exploreTarget) {
      const path = findPath(me.x, me.y, this.exploreTarget.x, this.exploreTarget.y, map);
      if (path.length > 0) return this.pathStep(me, path, state);
      // Unreachable — pick a new target next turn
      this.exploreTarget = null;
    }

    // Nothing to explore — wander randomly
    return this.randomMove(me, state, map);
  }

  // ---- Helpers ----

  private tryLoot(me: BombermanState, state: MatchState, onLoot: (msg: LootBombMsg) => void): void {
    // Loot chests
    for (const chest of state.chests) {
      if (chest.x !== me.x || chest.y !== me.y) continue;
      for (const bomb of chest.bombs) {
        const slot = this.findEmptySlot(me);
        if (slot < 0) break;
        onLoot({ sourceKind: 'chest', sourceId: chest.id, bombType: bomb.type, targetSlotIndex: slot });
      }
    }
    // Loot bodies
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
    for (let i = 0; i < INVENTORY_SLOT_COUNT; i++) {
      if (!me.inventory.slots[i]) return i + 1; // slotIndex 1..INVENTORY_SLOT_COUNT
    }
    return -1;
  }

  /** Pick move action from a path: two sequential 1-tile moves if rush, one otherwise. */
  private pathStep(me: BombermanState, path: Array<{ x: number; y: number }>, state?: MatchState): PlayerAction {
    if (path.length === 0) return { kind: 'idle' };
    const isFire = (x: number, y: number): boolean =>
      !!state && state.fireTiles.some(f => f.x === x && f.y === y);
    // Avoid stepping onto escape tiles before 50% of match
    if (state && this.shouldAvoidEscapes(state) && this.isEscapeTile(path[0].x, path[0].y, state)) {
      return { kind: 'idle' };
    }
    // Avoid walking into a burning tile — bot would take damage.
    if (isFire(path[0].x, path[0].y)) {
      return { kind: 'idle' };
    }
    if (me.rushActive && path.length >= 2) {
      // Don't rush onto an escape tile
      if (state && this.shouldAvoidEscapes(state) && this.isEscapeTile(path[1].x, path[1].y, state)) {
        return { kind: 'move', x: path[0].x, y: path[0].y };
      }
      // Don't rush THROUGH fire either — stop short.
      if (isFire(path[1].x, path[1].y)) {
        return { kind: 'move', x: path[0].x, y: path[0].y };
      }
      return { kind: 'move', x: path[0].x, y: path[0].y, rushX: path[1].x, rushY: path[1].y };
    }
    return { kind: 'move', x: path[0].x, y: path[0].y };
  }

  private findSlotWithType(me: BombermanState, type: BombType): number {
    for (let i = 0; i < INVENTORY_SLOT_COUNT; i++) {
      const s = me.inventory.slots[i];
      if (s && s.type === type && s.count > 0) return i + 1;
    }
    return -1;
  }

  private pickAttackSlot(me: BombermanState, target?: BombermanState): number {
    // Stun-first finisher pattern: if we have a Flash and the target is
    // NOT already stunned, open with Flash so we (and any teammate) get a
    // free turn to line up a damage bomb. If the target IS already stunned,
    // skip Flash — it'd be wasted — and pick a damage bomb to finish.
    const targetStunned = target
      ? (target.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)
      : false;
    if (target && !targetStunned) {
      const flashSlot = this.findSlotWithType(me, 'flash');
      if (flashSlot >= 0) return flashSlot;
    }
    // Damage-bomb preference order. 'flash' excluded here — it's handled
    // above as an opener only.
    const prefs: BombType[] = ['contact', 'bomb', 'bomb_wide', 'delay_tricky', 'banana', 'molotov', 'big_huge'];
    for (const pref of prefs) {
      const slot = this.findSlotWithType(me, pref);
      if (slot >= 0) return slot;
    }
    return 0; // rock
  }

  private avoidBombs(me: BombermanState, state: MatchState, map: MapData): PlayerAction | null {
    // Check if current tile is in danger from any bomb about to explode
    for (const bomb of state.bombs) {
      if (bomb.fuseRemaining > 1) continue;
      const def = BOMB_CATALOG[bomb.type];
      if (def.behavior.kind !== 'explode' && def.behavior.kind !== 'fire') continue;
      const shape = 'shape' in def.behavior ? def.behavior.shape : null;
      if (!shape) continue;
      const tiles = shapeTiles(shape, bomb.x, bomb.y, map);
      if (tiles.some(t => t.x === me.x && t.y === me.y)) {
        // In danger! Move to a safe adjacent tile (avoid fire too).
        return this.moveAway(me, bomb.x, bomb.y, map, state);
      }
    }
    // Also check fire tiles
    if (state.fireTiles.some(f => f.x === me.x && f.y === me.y)) {
      return this.randomMove(me, state, map);
    }
    return null;
  }

  private moveAway(me: BombermanState, dangerX: number, dangerY: number, map: MapData, state?: MatchState): PlayerAction {
    // Try each adjacent tile, prefer the one furthest from danger
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    let bestX = me.x, bestY = me.y, bestDist = 0;
    for (const [dx, dy] of dirs) {
      const nx = me.x + dx;
      const ny = me.y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.grid[ny]?.[nx] !== 0) continue;
      // Don't dodge INTO fire — prefer any other walkable tile.
      if (state && state.fireTiles.some(f => f.x === nx && f.y === ny)) continue;
      const dist = Math.max(Math.abs(nx - dangerX), Math.abs(ny - dangerY));
      if (dist > bestDist) { bestDist = dist; bestX = nx; bestY = ny; }
    }
    if (bestX === me.x && bestY === me.y) return { kind: 'idle' };
    return { kind: 'move', x: bestX, y: bestY };
  }

  private findSafeTile(me: BombermanState, state: MatchState, map: MapData): { x: number; y: number } | null {
    // Find a tile far from known enemies for ender pearl escape
    const enemies = state.bombermen.filter(b =>
      b.playerId !== this.playerId && b.alive && !b.escaped,
    );
    // Pick a random walkable tile at least 5 tiles away from all known enemies
    for (let attempt = 0; attempt < 20; attempt++) {
      const rx = Math.floor(Math.random() * map.width);
      const ry = Math.floor(Math.random() * map.height);
      if (map.grid[ry]?.[rx] !== 0) continue;
      const farEnough = enemies.every(e => Math.max(Math.abs(e.x - rx), Math.abs(e.y - ry)) > 5);
      if (farEnough) return { x: rx, y: ry };
    }
    return null;
  }

  private findDarkTarget(me: BombermanState, map: MapData): { x: number; y: number } | null {
    // Find an unseen tile within throw range (LOS radius)
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
    // Find the nearest unseen walkable tile
    let bestTarget: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    // Sample tiles rather than checking all (performance)
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

  /** True if the bot should avoid stepping on escape tiles (before 50% of match). */
  private shouldAvoidEscapes(state: MatchState): boolean {
    return state.turnNumber < BALANCE.match.turnLimit * 0.5;
  }

  private isEscapeTile(x: number, y: number, state: MatchState): boolean {
    return state.escapeTiles.some(e => e.x === x && e.y === y);
  }

  private randomMove(me: BombermanState, state: MatchState, map: MapData): PlayerAction {
    const avoidEscapes = this.shouldAvoidEscapes(state);
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const shuffled = dirs.sort(() => Math.random() - 0.5);
    for (const [dx, dy] of shuffled) {
      const nx = me.x + dx;
      const ny = me.y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.grid[ny]?.[nx] !== 0) continue;
      if (avoidEscapes && this.isEscapeTile(nx, ny, state)) continue;
      // Skip burning tiles — bot shouldn't walk into fire.
      if (state.fireTiles.some(f => f.x === nx && f.y === ny)) continue;
      return { kind: 'move', x: nx, y: ny };
    }
    return { kind: 'idle' };
  }
}
