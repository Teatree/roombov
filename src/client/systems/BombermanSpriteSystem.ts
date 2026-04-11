import Phaser from 'phaser';
import type { BombermanState } from '@shared/types/bomberman.ts';
import type { MatchState } from '@shared/types/match.ts';
import { BALANCE } from '@shared/config/balance.ts';

/**
 * Persistent Bomberman sprite manager.
 *
 * Lives across match_state updates — sprites are created once per player,
 * updated in place, and destroyed only when a player escapes (and for dead
 * players, after the death animation finishes and the corpse stays on the
 * final frame for the rest of the match).
 *
 * Responsibilities:
 *  - Swap animations (idle/walk/hurt/death) per direction
 *  - Track facing direction (last move wins, default 'down')
 *  - Lerp sprite position from old tile to new tile over the transition
 *    phase duration (driven by `moved` turn events)
 *  - Render attached HP pips, self-ring (local player), and aim shadow
 *    (local player in aim mode) at the sprite's lerped visual position
 *  - Apply per-Bomberman tint via Sprite.setTint
 *
 * MatchScene drives this by calling:
 *   - syncFromState(state, myPlayerId, aimActive) on every match_state
 *   - applyMoveEvent / applyHurtEvent / applyDeathEvent on turn_result events
 *   - setAimActive whenever the local inputMode flips in/out of 'aim'
 *   - tick(time) every frame from update()
 */

export type Facing = 'down' | 'left' | 'right' | 'up';
type AnimState = 'idle' | 'walk' | 'hurt' | 'death' | 'throw';

/** Frame rate for the death animation — must match the anim registration in MatchScene. */
const DEATH_FPS = 8;
const DEATH_FRAMES = 7;
/** Frame rate for the hurt animation. */
const HURT_FPS = 12;
const HURT_FRAMES = 5;

export function deathAnimationDurationMs(): number {
  return Math.round((DEATH_FRAMES / DEATH_FPS) * 1000);
}

interface BombermanSpriteEntry {
  playerId: string;
  sprite: Phaser.GameObjects.Sprite;
  hpPips: Phaser.GameObjects.Graphics;
  aimShadow: Phaser.GameObjects.Graphics | null;
  facing: Facing;
  animState: AnimState;
  tint: number;
  hp: number;
  maxHp: number;
  /** Current visual position in world pixels (may differ from logical tile during lerp). */
  visualX: number;
  visualY: number;
  /** Lerp state. When `lerpEndMs <= 0`, no lerp is active. */
  lerpFromPx: number;
  lerpFromPy: number;
  lerpToPx: number;
  lerpToPy: number;
  lerpStartMs: number;
  lerpEndMs: number;
  /** If hurt or throw is playing, what state to resume after it finishes. */
  resumeAfter: AnimState;
  /** Facing to restore when a throw anim resumes to walk (so the walk cycle goes back to the move direction). */
  preThrowFacing: Facing;
}

export class BombermanSpriteSystem {
  private scene: Phaser.Scene;
  private layer: Phaser.GameObjects.Container;
  private tileSize: number;
  private entries = new Map<string, BombermanSpriteEntry>();

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Container, tileSize: number) {
    this.scene = scene;
    this.layer = layer;
    this.tileSize = tileSize;
  }

  /**
   * Reconcile sprites with a new match state. Creates entries for new
   * Bombermen, updates HP / aim shadow for existing ones, destroys entries
   * for players that have escaped or left (dead stays — handled by
   * applyDeathEvent, which marks them as 'death' so we don't destroy).
   *
   * Does NOT touch sprite position — lerps drive positioning.
   */
  /**
   * @param isEnemyVisibleNow - returns true if a tile is currently in the
   *   local player's line of sight. Used to hide enemy sprites that walked
   *   out of LOS without destroying them (so a sprite re-entering LOS keeps
   *   its facing/animation state instead of resetting).
   */
  syncFromState(
    state: MatchState,
    myPlayerId: string | null,
    aimActive: boolean,
    isEnemyVisibleNow: (x: number, y: number) => boolean,
  ): void {
    const seen = new Set<string>();
    for (const b of state.bombermen) {
      if (b.escaped) continue; // escaped Bombermen are gone from the board
      seen.add(b.playerId);
      let entry = this.entries.get(b.playerId);
      if (!entry) {
        entry = this.createEntry(b, b.playerId === myPlayerId);
        this.entries.set(b.playerId, entry);
      }
      // Update HP (redraws pips)
      entry.hp = b.hp;
      this.drawHpPips(entry);
      // Sync aim shadow visibility for the local player
      if (b.playerId === myPlayerId && entry.aimShadow) {
        entry.aimShadow.setVisible(aimActive && b.alive);
      }
      // Enemy fog: hide if their server-authoritative tile is outside LOS.
      // Self always visible. Dead Bombermen always visible (their corpse).
      const isMe = b.playerId === myPlayerId;
      const visible = isMe || entry.animState === 'death' || isEnemyVisibleNow(b.x, b.y);
      entry.sprite.setVisible(visible);
      entry.hpPips.setVisible(visible);
    }
    // Destroy entries for players no longer in state OR that escaped.
    // Keep dead Bombermen — their corpse persists.
    for (const [playerId, entry] of this.entries) {
      if (!seen.has(playerId) && entry.animState !== 'death') {
        this.destroyEntry(entry);
        this.entries.delete(playerId);
      }
    }
  }

  /** Called from MatchScene when the local player enters/exits aim mode. */
  setAimActive(playerId: string, active: boolean): void {
    const entry = this.entries.get(playerId);
    if (!entry || !entry.aimShadow) return;
    entry.aimShadow.setVisible(active && entry.animState !== 'death');
  }

  /**
   * Start a walk lerp for a `moved` turn event. Called from onTurnResult.
   * `durationMs` is typically transitionPhaseSeconds * 1000.
   */
  applyMoveEvent(playerId: string, fromX: number, fromY: number, toX: number, toY: number, durationMs: number): void {
    const entry = this.entries.get(playerId);
    if (!entry || entry.animState === 'death') return;

    const ts = this.tileSize;
    entry.lerpFromPx = fromX * ts + ts / 2;
    entry.lerpFromPy = fromY * ts + ts / 2;
    entry.lerpToPx = toX * ts + ts / 2;
    entry.lerpToPy = toY * ts + ts / 2;
    entry.visualX = entry.lerpFromPx;
    entry.visualY = entry.lerpFromPy;
    entry.lerpStartMs = this.scene.time.now;
    entry.lerpEndMs = this.scene.time.now + Math.max(1, durationMs);

    entry.facing = directionFromDelta(toX - fromX, toY - fromY, entry.facing);
    this.setAnim(entry, 'walk');
    this.applyVisualPosition(entry);
  }

  /**
   * Play hurt animation in the current facing. Resumes idle or walk after
   * the animation completes, depending on whether a lerp is still running.
   */
  applyHurtEvent(playerId: string): void {
    const entry = this.entries.get(playerId);
    if (!entry || entry.animState === 'death') return;
    // Remember what to resume after hurt finishes
    entry.resumeAfter = entry.animState === 'walk' ? 'walk' : 'idle';
    this.setAnim(entry, 'hurt');
    entry.sprite.once('animationcomplete', () => {
      if (entry.animState !== 'hurt') return; // another state took over
      const stillLerping = this.scene.time.now < entry.lerpEndMs;
      this.setAnim(entry, stillLerping ? 'walk' : 'idle');
    });
  }

  /**
   * Play throw animation in the direction of the throw target, stretched to
   * match the bomb's arc flight time. Facing snaps to the throw direction for
   * the duration of the anim; if a walk lerp is still running when the throw
   * completes, facing restores to the pre-throw (movement) direction so the
   * walk cycle resumes correctly.
   */
  applyThrowEvent(playerId: string, fromX: number, fromY: number, toX: number, toY: number, durationMs: number): void {
    const entry = this.entries.get(playerId);
    if (!entry || entry.animState === 'death') return;

    entry.preThrowFacing = entry.facing;
    entry.facing = directionFromDelta(toX - fromX, toY - fromY, entry.facing);
    entry.resumeAfter = entry.animState === 'walk' ? 'walk' : 'idle';
    entry.animState = 'throw';
    entry.sprite.play({ key: `bomber_throw_${entry.facing}`, duration: Math.max(100, durationMs) });
    entry.sprite.once('animationcomplete', () => {
      if (entry.animState !== 'throw') return; // hurt/death took over
      const stillLerping = this.scene.time.now < entry.lerpEndMs;
      if (stillLerping) {
        entry.facing = entry.preThrowFacing;
        this.setAnim(entry, 'walk');
      } else {
        this.setAnim(entry, 'idle');
      }
    });
  }

  /**
   * Play death animation. Sprite stops lerping and the final frame persists
   * as a corpse for the rest of the match. Returns animation duration (ms)
   * so MatchScene can schedule the results screen transition.
   */
  applyDeathEvent(playerId: string, tileX: number, tileY: number): number {
    const entry = this.entries.get(playerId);
    if (!entry) return deathAnimationDurationMs();

    // Snap to the death tile — death is at the final resolved position
    const ts = this.tileSize;
    entry.visualX = tileX * ts + ts / 2;
    entry.visualY = tileY * ts + ts / 2;
    entry.lerpEndMs = 0; // cancel any active lerp
    this.applyVisualPosition(entry);

    this.setAnim(entry, 'death');
    if (entry.aimShadow) entry.aimShadow.setVisible(false);
    return deathAnimationDurationMs();
  }

  /** Per-frame tick from MatchScene.update. Advances lerps and repositions overlays. */
  tick(nowMs: number): void {
    for (const entry of this.entries.values()) {
      if (entry.lerpEndMs > 0 && nowMs < entry.lerpEndMs) {
        const total = entry.lerpEndMs - entry.lerpStartMs;
        const t = Math.min(1, Math.max(0, (nowMs - entry.lerpStartMs) / total));
        entry.visualX = Phaser.Math.Linear(entry.lerpFromPx, entry.lerpToPx, t);
        entry.visualY = Phaser.Math.Linear(entry.lerpFromPy, entry.lerpToPy, t);
      } else if (entry.lerpEndMs > 0) {
        // Lerp just finished — snap to target and transition walk → idle
        entry.visualX = entry.lerpToPx;
        entry.visualY = entry.lerpToPy;
        entry.lerpEndMs = 0;
        if (entry.animState === 'walk') this.setAnim(entry, 'idle');
      }
      this.applyVisualPosition(entry);
    }
  }

  /** Make the HUD camera ignore every object in this system's layer. */
  ignoreFromCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore(this.layer);
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
  }

  // ---- internals ----

  private createEntry(b: BombermanState, isMe: boolean): BombermanSpriteEntry {
    const ts = this.tileSize;
    const cx = b.x * ts + ts / 2;
    const cy = b.y * ts + ts / 2;

    const sprite = this.scene.add.sprite(cx, cy, 'bomber_idle');
    // Floor reference point: local (32, 40) in a 64x64 frame → origin (0.5, 0.625)
    sprite.setOrigin(0.5, 0.625);
    // Native scale per plan — the sprite visually overflows the tile on purpose
    sprite.setScale(1);
    sprite.setTint(b.tint);
    sprite.play('bomber_idle_down');
    this.layer.add(sprite);

    // HP pips above the sprite's head
    const hpPips = this.scene.add.graphics();
    this.layer.add(hpPips);

    // Self-only overlay: red aim shadow ellipse. Yellow ring removed per
    // user request — the sprite itself is distinct enough.
    let aimShadow: Phaser.GameObjects.Graphics | null = null;
    if (isMe) {
      aimShadow = this.scene.add.graphics();
      aimShadow.setVisible(false);
      this.layer.add(aimShadow);
    }

    const entry: BombermanSpriteEntry = {
      playerId: b.playerId,
      sprite,
      hpPips,
      aimShadow,
      facing: 'down',
      animState: 'idle',
      tint: b.tint,
      hp: b.hp,
      maxHp: BALANCE.match.bombermanMaxHp,
      visualX: cx,
      visualY: cy,
      lerpFromPx: cx,
      lerpFromPy: cy,
      lerpToPx: cx,
      lerpToPy: cy,
      lerpStartMs: 0,
      lerpEndMs: 0,
      resumeAfter: 'idle',
      preThrowFacing: 'down',
    };
    this.drawHpPips(entry);
    this.applyVisualPosition(entry);
    return entry;
  }

  private destroyEntry(entry: BombermanSpriteEntry): void {
    entry.sprite.destroy();
    entry.hpPips.destroy();
    entry.aimShadow?.destroy();
  }

  /**
   * Swap to a new animation state. Picks the correct directional variant
   * based on `entry.facing`. Safe to call with the same state — guarded to
   * avoid restarting animations on every tick.
   */
  private setAnim(entry: BombermanSpriteEntry, state: AnimState): void {
    if (entry.animState === state && entry.animState !== 'hurt' && entry.animState !== 'death' && entry.animState !== 'throw') return;
    entry.animState = state;
    const key = `bomber_${state}_${entry.facing}`;
    entry.sprite.play(key);
  }

  /** Write the current visualX/visualY to all overlay graphics and the sprite. */
  private applyVisualPosition(entry: BombermanSpriteEntry): void {
    const { visualX, visualY } = entry;
    entry.sprite.setPosition(visualX, visualY);

    // HP pips float above the character's head
    const ts = this.tileSize;
    this.drawHpPipsAt(entry, visualX - ts * 0.4, visualY - ts * 2.2);

    if (entry.aimShadow) {
      entry.aimShadow.clear();
      entry.aimShadow.fillStyle(0xff2222, 0.45);
      entry.aimShadow.fillEllipse(visualX, visualY + ts * 0.15, ts * 0.75, ts * 0.3);
      entry.aimShadow.lineStyle(1, 0xff4444, 0.9);
      entry.aimShadow.strokeEllipse(visualX, visualY + ts * 0.15, ts * 0.75, ts * 0.3);
    }
  }

  private drawHpPips(entry: BombermanSpriteEntry): void {
    // Reposition happens in applyVisualPosition — this just draws the pips at
    // whatever position the graphics object currently holds. For simplicity
    // we clear and redraw in drawHpPipsAt which is called every tick anyway.
    const ts = this.tileSize;
    this.drawHpPipsAt(entry, entry.visualX - ts * 0.4, entry.visualY - ts * 2.2);
  }

  private drawHpPipsAt(entry: BombermanSpriteEntry, x: number, y: number): void {
    const g = entry.hpPips;
    g.clear();
    const pipW = 6;
    const pipH = 4;
    const gap = 2;
    for (let i = 0; i < entry.maxHp; i++) {
      g.fillStyle(i < entry.hp ? 0xff4444 : 0x333333, 1);
      g.fillRect(x + i * (pipW + gap), y, pipW, pipH);
    }
  }
}

/** Compute facing from a movement delta. Vertical axis wins on diagonals. */
function directionFromDelta(dx: number, dy: number, fallback: Facing): Facing {
  if (dy > 0) return 'down';
  if (dy < 0) return 'up';
  if (dx > 0) return 'right';
  if (dx < 0) return 'left';
  return fallback;
}
