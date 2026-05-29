import Phaser from 'phaser';
import type { BombermanState, CharacterVariant } from '@shared/types/bomberman.ts';
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

export type Facing =
  | 'right' | 'down-right' | 'down' | 'down-left'
  | 'left' | 'up-left' | 'up' | 'up-right';
type AnimState = 'idle' | 'walk' | 'run' | 'hurt' | 'death' | 'throw' | 'attack3' | 'crouch';

/** Frame rate for the death animation — must match the anim registration in BombermanAnimations. */
const DEATH_FPS = 8;
const DEATH_FRAMES = 8;

/**
 * Per-tile sprite anchor. Origin (0.5, 0.75) + a +7px push puts the feet at
 * the tile floor. Frames are 128×128 (2× the prior 64×64 sheets), so scale
 * is 0.5 to keep the on-screen size the same as before.
 */
const SPRITE_ORIGIN_X = 0.5;
const SPRITE_ORIGIN_Y = 0.75;
const SPRITE_Y_OFFSET_PX = 7;
const SPRITE_SCALE = 0.5;

/**
 * Alpha applied to corpse sprites that sit in seen-dim fog (RTS-fog
 * remembered but not in current LOS). Living enemies aren't drawn at all
 * outside LOS, so this only affects corpses. Raised from 0.45 so bodies
 * stay clearly readable even when the area is dimmed.
 */
const CORPSE_SEEN_DIM_ALPHA = 0.75;

export function deathAnimationDurationMs(): number {
  return Math.round((DEATH_FRAMES / DEATH_FPS) * 1000);
}

interface BombermanSpriteEntry {
  playerId: string;
  isMe: boolean;
  sprite: Phaser.GameObjects.Sprite;
  aimShadow: Phaser.GameObjects.Graphics | null;
  facing: Facing;
  animState: AnimState;
  tint: number;
  hp: number;
  /**
   * HP value actually shown in the HUD bar. Trails `hp` to hide damage
   * until the turn's animations finish — `hpDisplayUpdateAt` tells tick()
   * when to swap. The HUD reads this via `getDisplayedHp(playerId)`.
   */
  displayedHp: number;
  /** `scene.time.now` at which displayedHp should be set to hp. 0 = sync now. */
  hpDisplayUpdateAt: number;
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
  /** Wall-clock time at which this escaped Bomberman should be destroyed. 0 means not pending. */
  escapeDestroyAt: number;
  /** Latch — set true the first frame an escape fade-out tween is started so
   *  tick() doesn't keep restarting the tween every frame after lerp end. */
  escapeFadeStarted: boolean;
  /** Mirrors BombermanState.rushActive — drives walk vs run anim selection. */
  rushActive: boolean;
  /** Which char1/char2/char3 sprite sheet this Bomberman uses. */
  character: CharacterVariant;
  /** Stun indicator above the bomberman's head — 2-frame question-mark
   *  sprite (`stunned_effect_anim`) shown to all players whenever the
   *  bomberman has the `stunned` status effect. */
  stunIcon: Phaser.GameObjects.Sprite;
  /** Ambush star — drawn on the tile UNDER the bomberman while in Melee
   *  Trap Mode. Slowly rotates; pulses on a counter-attack; grows + fades
   *  on exit. Replaces the old floating sword icon. */
  ambushStar: Phaser.GameObjects.Graphics;
  /** Whether the ambush star is currently animating its grow-out fade. */
  ambushFading: boolean;
  /** Whether this bomberman is currently in Melee Trap Mode (mirror of state). */
  meleeTrapMode: boolean;
  /** Floating bomberman-name label above the head. Created only for
   *  real-player Bombermen (non-bot, non-scav) outside tutorial mode;
   *  null otherwise. Visible to everyone with LOS. */
  nameLabel: Phaser.GameObjects.Text | null;
  /** Monotonic token incremented on every new hurt/death event so a stale
   *  flicker timer from a previous hit can detect it's been superseded. */
  flickerToken: number;
}

export class BombermanSpriteSystem {
  private scene: Phaser.Scene;
  private layer: Phaser.GameObjects.Container;
  private corpseLayer: Phaser.GameObjects.Container;
  private tileSize: number;
  private entries = new Map<string, BombermanSpriteEntry>();

  constructor(
    scene: Phaser.Scene,
    layer: Phaser.GameObjects.Container,
    corpseLayer: Phaser.GameObjects.Container,
    tileSize: number,
  ) {
    this.scene = scene;
    this.layer = layer;
    this.corpseLayer = corpseLayer;
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
  /**
   * @param isEnemyVisibleNow - true if a tile is in LOS (used for living enemies)
   * @param isCorpseVisible - RTS fog check for dead sprites: visible if in LOS
   *   (which discovers them) OR if previously discovered and tile is in seen-dim.
   *   MatchScene provides this using its knownEntities set.
   */
  syncFromState(
    state: MatchState,
    myPlayerId: string | null,
    aimActive: boolean,
    isEnemyVisibleNow: (x: number, y: number) => boolean,
    isCorpseVisible: (playerId: string, x: number, y: number) => boolean,
  ): void {
    const isTileVisible = (x: number, y: number): boolean => isEnemyVisibleNow(x, y);
    // Precompute smoke cloud tiles once per sync — bombermen on any smoke
    // tile become invisible to enemies (only the owner sees themselves at
    // reduced opacity). Cheap set lookup below.
    const smokedTiles = new Set<string>();
    for (const c of state.smokeClouds ?? []) {
      for (const t of c.tiles) smokedTiles.add(`${t.x},${t.y}`);
    }
    const isSmoked = (x: number, y: number): boolean => smokedTiles.has(`${x},${y}`);
    const seen = new Set<string>();
    for (const b of state.bombermen) {
      if (b.escaped) {
        // Don't destroy immediately — let the walk lerp finish so the sprite
        // visually reaches the escape hatch before disappearing. tick() will
        // destroy once the grace window has passed AND the lerp is done.
        const existing = this.entries.get(b.playerId);
        if (existing) {
          seen.add(b.playerId);
          if (existing.escapeDestroyAt === 0) {
            existing.escapeDestroyAt = this.scene.time.now + BALANCE.match.transitionPhaseSeconds * 1000;
          }
        }
        continue;
      }
      seen.add(b.playerId);
      let entry = this.entries.get(b.playerId);
      if (!entry) {
        entry = this.createEntry(b, b.playerId === myPlayerId);
        this.entries.set(b.playerId, entry);
      }
      // HP update is delayed: the pips show the *previous* displayed HP
      // until the animations in this turn's resolution phase finish.
      // Target HP is captured here; tick() drops `displayedHp` to match
      // once the scheduled update time has passed.
      const prevHp = entry.hp;
      if (b.hp !== entry.hp) {
        entry.hp = b.hp;
        if (b.hp < prevHp) {
          // Damage: hold the pip at the old HP until the hurt/death
          // animation completes — late-transition is a safe general mark.
          entry.hpDisplayUpdateAt = this.scene.time.now
            + BALANCE.match.transitionPhaseSeconds * 1000;
        } else {
          // Heal / init / spawn: update immediately.
          entry.displayedHp = b.hp;
          entry.hpDisplayUpdateAt = 0;
        }
      }
      entry.rushActive = b.rushActive ?? false;
      if (b.playerId === myPlayerId && entry.aimShadow) {
        entry.aimShadow.setVisible(aimActive && b.alive);
      }
      // Visibility: self always visible. Living enemies: LOS only.
      // Dead corpses: RTS fog — visible once discovered, persists in seen-dim.
      // In seen-dim: dimmed (alpha 0.45) so they look "behind the gray film".
      const isMe = b.playerId === myPlayerId;
      let visible: boolean;
      let dimmed = false;
      let alpha = 1;
      if (isMe) {
        visible = true;
        // Owner inside their own smoke renders at reduced opacity so they
        // see themselves but feel submerged in the cloud.
        if (isSmoked(b.x, b.y)) alpha = 0.65;
      } else if (!b.alive || entry.animState === 'death') {
        visible = isCorpseVisible(b.playerId, b.x, b.y);
        // Dimmed if visible but NOT in direct LOS (i.e. in seen-dim)
        if (visible && !isEnemyVisibleNow(b.x, b.y)) dimmed = true;
      } else {
        visible = isEnemyVisibleNow(b.x, b.y);
        // Enemies inside any smoke cloud are fully invisible to other
        // players — the smoke masks them entirely (spec: "other Bomberman
        // become straight up invisible").
        if (isSmoked(b.x, b.y)) visible = false;
      }
      entry.sprite.setVisible(visible);
      entry.sprite.setAlpha(dimmed ? CORPSE_SEEN_DIM_ALPHA : alpha);

      // Stun icon: visible for any bomberman with an active stunned status
      // effect, as long as the sprite itself is visible to this client.
      // Animates as a gentle bob so it reads as a distinct overlay.
      const stunned = (b.statusEffects ?? []).some(
        s => s.kind === 'stunned' && s.turnsRemaining > 0,
      );
      entry.stunIcon.setVisible(stunned && visible && !dimmed);
      entry.stunIcon.setAlpha(dimmed ? CORPSE_SEEN_DIM_ALPHA : 1);

      // --- Melee Trap Mode handling ---
      // Entry: swap to crouch anim, show ambush star at base scale.
      // Exit: play a grow + fade animation at the VERY START of the
      // resolution phase — the walk/throw events this turn are scheduled
      // AFTER SWORD_FADE_MS in MatchScene so this animation reads before
      // the bomberman starts moving.
      const wasTrap = entry.meleeTrapMode;
      const nowTrap = !!b.meleeTrapMode;
      entry.meleeTrapMode = nowTrap;
      const baseAlpha = BombermanSpriteSystem.SWORD_BASE_ALPHA;
      if (nowTrap && !wasTrap) {
        // Just entered — swap anim to crouch idle; star appears at base scale.
        this.setAnim(entry, 'crouch');
        entry.ambushFading = false;
        entry.ambushStar.setAlpha(baseAlpha);
        entry.ambushStar.setScale(1);
      } else if (!nowTrap && wasTrap) {
        // Just exited — grow + fade over the full ambush-fade duration.
        if (entry.animState === 'crouch') this.setAnim(entry, 'idle');
        entry.ambushFading = true;
        entry.ambushStar.setScale(1);
        entry.ambushStar.setAlpha(baseAlpha);
        this.scene.tweens.add({
          targets: entry.ambushStar,
          alpha: 0,
          scale: 1.8,
          duration: BombermanSpriteSystem.SWORD_FADE_MS,
          ease: 'Cubic.easeOut',
          onComplete: () => {
            // Hide the star AND reset its transform so the next trap-entry
            // finds it at a clean baseline.
            entry.ambushFading = false;
            entry.ambushStar.setVisible(false);
            entry.ambushStar.setAlpha(baseAlpha);
            entry.ambushStar.setScale(1);
          },
        });
      }
      // Star visibility — same tile as the bomberman, so re-use the
      // bomberman's own LOS gate.
      const starShown = (nowTrap || entry.ambushFading) && visible && !dimmed;
      entry.ambushStar.setVisible(starShown);
      if (!entry.ambushFading) {
        entry.ambushStar.setAlpha(dimmed ? CORPSE_SEEN_DIM_ALPHA * baseAlpha : baseAlpha);
      }

      // Name label — real players only, never in tutorial, only when the
      // sprite is itself visible to this client (LOS-gated for enemies).
      if (entry.nameLabel) {
        const labelShown = visible && !dimmed && !state.isTutorial && !b.isBot && !b.isScav;
        entry.nameLabel.setVisible(labelShown);
        if (labelShown && entry.nameLabel.text !== (b.name ?? '')) {
          entry.nameLabel.setText(b.name ?? '');
        }
      }
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

    entry.facing = directionFromDelta8(toX - fromX, toY - fromY, entry.facing);
    this.setAnim(entry, entry.rushActive ? 'run' : 'walk');
    this.applyVisualPosition(entry);
  }

  /**
   * Play hurt animation in the current facing. Resumes idle or walk after
   * the animation completes, depending on whether a lerp is still running.
   */
  applyHurtEvent(playerId: string): void {
    const entry = this.entries.get(playerId);
    if (!entry || entry.animState === 'death') return;
    // Red flicker mask runs in parallel with the hurt anim. setTintFill
    // overrides the team-color multiply tint with a solid red mask for the
    // duration of each red frame, then we restore entry.tint to resume the
    // normal sprite + team color while the hurt anim continues.
    this.playHurtFlicker(entry);
    // Remember what to resume after hurt finishes
    entry.resumeAfter = entry.animState === 'walk' || entry.animState === 'run' ? entry.animState : 'idle';
    this.setAnim(entry, 'hurt');
    entry.sprite.once('animationcomplete', () => {
      if (entry.animState !== 'hurt') return; // another state took over
      const stillLerping = this.scene.time.now < entry.lerpEndMs;
      // Rush may have ended while hurt played — re-evaluate live.
      if (stillLerping) this.setAnim(entry, entry.rushActive ? 'run' : 'walk');
      else this.setAnim(entry, 'idle');
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
    entry.facing = directionFromDelta8(toX - fromX, toY - fromY, entry.facing);
    entry.resumeAfter = entry.animState === 'walk' || entry.animState === 'run' ? entry.animState : 'idle';
    entry.animState = 'throw';
    entry.sprite.play({ key: `bomber_throw_${entry.character}_${entry.facing}`, duration: Math.max(100, durationMs) });
    entry.sprite.once('animationcomplete', () => {
      if (entry.animState !== 'throw') return; // hurt/death took over
      const stillLerping = this.scene.time.now < entry.lerpEndMs;
      if (stillLerping) {
        entry.facing = entry.preThrowFacing;
        this.setAnim(entry, entry.rushActive ? 'run' : 'walk');
      } else {
        this.setAnim(entry, 'idle');
      }
    });
  }

  /**
   * Instantly snap a Bomberman sprite to a new tile (Ender Pearl teleport).
   * Cancels any active lerp and plays idle at the destination.
   */
  applyTeleportEvent(playerId: string, tileX: number, tileY: number): void {
    const entry = this.entries.get(playerId);
    if (!entry || entry.animState === 'death') return;
    const ts = this.tileSize;
    entry.visualX = tileX * ts + ts / 2;
    entry.visualY = tileY * ts + ts / 2;
    entry.lerpEndMs = 0;
    this.applyVisualPosition(entry);
    this.setAnim(entry, 'idle');
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

    this.playHurtFlicker(entry);
    this.setAnim(entry, 'death');
    if (entry.aimShadow) entry.aimShadow.setVisible(false);
    // Move corpse sprite to the dedicated corpseLayer (spec: bombs render above corpses).
    this.layer.remove(entry.sprite);
    this.corpseLayer.add(entry.sprite);
    return deathAnimationDurationMs();
  }

  /** Per-frame tick from MatchScene.update. Advances lerps and repositions overlays. */
  tick(nowMs: number): void {
    const toDestroy: string[] = [];
    for (const [playerId, entry] of this.entries) {
      if (entry.lerpEndMs > 0 && nowMs < entry.lerpEndMs) {
        const total = entry.lerpEndMs - entry.lerpStartMs;
        const t = Math.min(1, Math.max(0, (nowMs - entry.lerpStartMs) / total));
        entry.visualX = Phaser.Math.Linear(entry.lerpFromPx, entry.lerpToPx, t);
        entry.visualY = Phaser.Math.Linear(entry.lerpFromPy, entry.lerpToPy, t);
      } else if (entry.lerpEndMs > 0) {
        // Lerp just finished — snap to target and transition walk/run → idle
        entry.visualX = entry.lerpToPx;
        entry.visualY = entry.lerpToPy;
        entry.lerpEndMs = 0;
        if (entry.animState === 'walk' || entry.animState === 'run') this.setAnim(entry, 'idle');
      }
      this.applyVisualPosition(entry);
      // Slowly rotate the ambush star while it's visible (entry, holding, or
      // the brief grow+fade on exit). 6 RPM ≈ 36°/s, low-key like a slow
      // spotlight. Skipped when invisible to save the rotation set on every
      // hidden bomberman.
      if (entry.ambushStar.visible) {
        entry.ambushStar.rotation += 0.6 * (1 / 30); // ~radians/frame at 30fps
      }
      // Delayed HP value swap: a damage this turn scheduled a deferred
      // swap of displayedHp so the HUD bar doesn't drop before the
      // hurt/death animation finishes. Apply when the scheduled time arrives.
      if (entry.hpDisplayUpdateAt > 0 && nowMs >= entry.hpDisplayUpdateAt) {
        entry.displayedHp = entry.hp;
        entry.hpDisplayUpdateAt = 0;
      }
      // Escape: once the walk lerp finishes (sprite has reached the hatch
      // tile), start a one-shot fade-out tween and let its onComplete remove
      // the entry. The current animation frame is frozen so the fade reads
      // cleanly without footstep cycling. `escapeFadeStarted` is a latch so
      // the tween fires exactly once per escape even though tick() runs
      // every frame.
      if (entry.escapeDestroyAt > 0 && entry.lerpEndMs === 0 && !entry.escapeFadeStarted) {
        entry.escapeFadeStarted = true;
        entry.sprite.anims.stop();
        const fadeTargets: Phaser.GameObjects.GameObject[] = [
          entry.sprite, entry.stunIcon, entry.ambushStar,
        ];
        if (entry.nameLabel) fadeTargets.push(entry.nameLabel);
        if (entry.aimShadow) fadeTargets.push(entry.aimShadow);
        const pidForFade = playerId;
        this.scene.tweens.add({
          targets: fadeTargets,
          alpha: 0,
          duration: 300,
          onComplete: () => {
            const e = this.entries.get(pidForFade);
            if (e) {
              this.destroyEntry(e);
              this.entries.delete(pidForFade);
            }
          },
        });
      }
    }
    for (const pid of toDestroy) {
      const e = this.entries.get(pid);
      if (e) {
        this.destroyEntry(e);
        this.entries.delete(pid);
      }
    }
  }

  /**
   * Current DISPLAYED HP for a bomberman — used by the HUD text so the
   * HP number stays in sync with the pip bar's delayed update.
   * Returns null if no entry exists yet.
   */
  getDisplayedHp(playerId: string): number | null {
    const entry = this.entries.get(playerId);
    return entry ? entry.displayedHp : null;
  }

  /** Make the HUD camera ignore every object in this system's layers. */
  ignoreFromCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore(this.layer);
    camera.ignore(this.corpseLayer);
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

    const character: CharacterVariant = b.character ?? 'char1';

    // Ambush star — drawn FIRST so it sits below the sprite (z-order within
    // this layer follows insertion order). Static polygon at origin (0,0);
    // positioning + rotation are handled by applyVisualPosition / tick.
    const ambushStar = this.scene.add.graphics();
    drawAmbushStar(ambushStar, this.tileSize);
    ambushStar.setPosition(cx, cy);
    ambushStar.setVisible(false);
    this.layer.add(ambushStar);

    const sprite = this.scene.add.sprite(cx, cy, `bomber_idle_${character}`);
    sprite.setOrigin(SPRITE_ORIGIN_X, SPRITE_ORIGIN_Y);
    sprite.setScale(SPRITE_SCALE);
    sprite.setTint(b.tint);
    sprite.play(`bomber_idle_${character}_down`);
    this.layer.add(sprite);

    // Self-only red aim-shadow ellipse REMOVED per user request — the
    // throw-target highlight in MatchScene is now the sole aiming indicator,
    // so this overlay was redundant and visually noisy.
    const aimShadow: Phaser.GameObjects.Graphics | null = null;

    // Stun icon — 2-frame question-mark sprite above the head. All players
    // see it whenever the bomberman has the `stunned` status effect. Anim
    // is registered in MatchScene.create() at 2 fps.
    const stunIcon = this.scene.add.sprite(cx, cy, 'stunned_effect');
    stunIcon.setDisplaySize(this.tileSize * 0.7, this.tileSize * 0.7);
    stunIcon.setVisible(false);
    if (this.scene.anims.exists('stunned_effect_anim')) {
      stunIcon.play('stunned_effect_anim');
    }
    this.layer.add(stunIcon);

    // Name label — only for real-player Bombermen (non-bot, non-scav) and
    // never in tutorial. Decided by syncFromState; null here means "this
    // bomberman never gets a name label". Re-evaluated on first sync if
    // we need to upgrade it (e.g. tutorial flag changes mid-life — doesn't
    // happen, but the null-check keeps that cheap).
    let nameLabel: Phaser.GameObjects.Text | null = null;
    const shouldLabel = !b.isBot && !b.isScav;
    if (shouldLabel) {
      nameLabel = this.scene.add.text(cx, cy, b.name ?? '', {
        fontSize: '8px', color: '#ffffff', fontFamily: 'monospace',
        stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5, 1).setAlpha(0.6).setVisible(false);
      // Render the text at 2× resolution and downsample so 8 px monospace
      // stays sharp instead of subpixel-blurry on high-DPI displays.
      nameLabel.setResolution(2);
      this.layer.add(nameLabel);
    }

    const entry: BombermanSpriteEntry = {
      playerId: b.playerId,
      isMe,
      sprite,
      aimShadow,
      stunIcon,
      ambushStar,
      ambushFading: false,
      meleeTrapMode: b.meleeTrapMode ?? false,
      facing: 'down',
      animState: 'idle',
      tint: b.tint,
      hp: b.hp,
      displayedHp: b.hp,
      hpDisplayUpdateAt: 0,
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
      escapeDestroyAt: 0,
      escapeFadeStarted: false,
      rushActive: b.rushActive ?? false,
      character,
      nameLabel,
      flickerToken: 0,
    };
    this.applyVisualPosition(entry);
    return entry;
  }

  /** How long (ms) the Attack3 animation plays on a single strike. */
  static readonly ATTACK3_DURATION_MS = 500;
  /**
   * How long (ms) the sword-fade-out animation runs on Melee-Trap exit.
   * MatchScene uses this to delay the walk/throw visuals for the exiting
   * player so the fade clearly plays before movement.
   */
  static readonly SWORD_FADE_MS = 400;
  /**
   * Base alpha for the ambush star drawn under a bomberman's tile while
   * in Melee Trap Mode. Kept translucent so it reads as an overlay cue
   * without dominating the sprite. (Name kept for back-compat with the
   * old sword-icon implementation that this replaced.)
   */
  static readonly SWORD_BASE_ALPHA = 0.7;

  /**
   * Three-frame red flicker mask applied to the sprite at the start of a
   * hurt or death animation. Uses `setTintFill` for the red frames (which
   * overrides the team-color multiply tint) and `setTint(entry.tint)` to
   * restore. A per-entry `flickerToken` guards against stale timers from
   * an older hurt completing after a newer one has been scheduled — only
   * the timer that matches the current token applies its tint change.
   */
  private playHurtFlicker(entry: BombermanSpriteEntry): void {
    entry.flickerToken += 1;
    const token = entry.flickerToken;
    const RED = 0xff4444;
    const FRAME_MS = 70;
    const apply = (red: boolean) => {
      if (entry.flickerToken !== token) return; // superseded
      if (red) entry.sprite.setTintFill(RED);
      else entry.sprite.setTint(entry.tint);
    };
    apply(true);
    this.scene.time.delayedCall(FRAME_MS, () => apply(false));
    this.scene.time.delayedCall(FRAME_MS * 2, () => apply(true));
    this.scene.time.delayedCall(FRAME_MS * 3, () => apply(false));
  }

  /**
   * Drive a Melee-Trap counter-attack. Attacker plays Attack3 facing the
   * victim; the victim's hurt/death animation is scheduled to start as the
   * Attack3 connects (roughly two-thirds through). Returns the ms at
   * which the victim anim should start — caller uses this to suppress the
   * `damaged` / `died` event's default animation so we don't double-play.
   */
  applyMeleeAttack(
    attackerId: string, victimId: string, killed: boolean,
  ): number {
    const attacker = this.entries.get(attackerId);
    const victim = this.entries.get(victimId);
    if (!attacker || !victim) return 0;
    // Face the victim based on relative tile position.
    attacker.facing = this.facingFromDelta(victim.visualX - attacker.visualX, victim.visualY - attacker.visualY);
    this.setAnim(attacker, 'attack3');
    // When Attack3 finishes, return to CROUCH if the attacker is still in
    // trap mode (they didn't move/throw this turn), else to idle. Uses
    // `animationcomplete` so the transition is tied to actual anim end
    // rather than a fixed timer.
    attacker.sprite.once('animationcomplete', () => {
      if (attacker.animState !== 'attack3') return; // hurt/death/etc. took over
      this.setAnim(attacker, attacker.meleeTrapMode ? 'crouch' : 'idle');
    });
    // Victim anim is scheduled at the Attack3 "connect" point (~65% through
    // the animation) so the hit reads as a contact, not a pose.
    const connectAtMs = Math.round(BombermanSpriteSystem.ATTACK3_DURATION_MS * 0.65);
    this.scene.time.delayedCall(connectAtMs, () => {
      this.playHurtFlicker(victim);
      if (killed) {
        this.setAnim(victim, 'death');
        victim.resumeAfter = 'death';
        // Transfer to the corpse layer so the body renders below any live
        // Bomberman who later walks onto the tile to loot it. Without this
        // step the sprite stays in the active-Bomberman layer (depth 100)
        // and floats above the looter.
        if (victim.aimShadow) victim.aimShadow.setVisible(false);
        this.layer.remove(victim.sprite);
        this.corpseLayer.add(victim.sprite);
      } else {
        this.setAnim(victim, 'hurt');
        victim.resumeAfter = 'idle';
      }
    });
    // Pulse the attacker's ambush star (they're still in trap mode at the
    // moment of contact). Quick scale-up that returns to the rotating base.
    if (attacker.meleeTrapMode) {
      this.scene.tweens.killTweensOf(attacker.ambushStar);
      this.scene.tweens.add({
        targets: attacker.ambushStar,
        scale: 1.4,
        duration: 120,
        yoyo: true,
        ease: 'Sine.easeOut',
      });
    }
    return connectAtMs;
  }

  /** Convert an (x, y) pixel delta into the nearest 8-way facing. */
  private facingFromDelta(dx: number, dy: number): Facing {
    const angle = Math.atan2(dy, dx); // -PI..PI, 0 = right
    // Bucket into 8 facings, 45° each.
    const idx = Math.round(angle / (Math.PI / 4));
    const map: Record<number, Facing> = {
      [-4]: 'left', [-3]: 'up-left', [-2]: 'up', [-1]: 'up-right',
      0: 'right', 1: 'down-right', 2: 'down', 3: 'down-left', 4: 'left',
    };
    return map[idx] ?? 'down';
  }

  private destroyEntry(entry: BombermanSpriteEntry): void {
    entry.sprite.destroy();
    entry.aimShadow?.destroy();
    entry.stunIcon.destroy();
    entry.ambushStar.destroy();
    entry.nameLabel?.destroy();
  }

  /**
   * Swap to a new animation state. Picks the correct directional variant
   * based on `entry.facing`. Skips the play() call only when both the state
   * AND the current anim key already match — so a direction change inside
   * the same state (e.g. diagonal flip during a rush) still re-plays.
   */
  private setAnim(entry: BombermanSpriteEntry, state: AnimState): void {
    const key = `bomber_${state}_${entry.character}_${entry.facing}`;
    const currentKey = entry.sprite.anims.currentAnim?.key;
    if (entry.animState === state && currentKey === key) return;
    entry.animState = state;
    entry.sprite.play(key);
  }

  /** Write the current visualX/visualY to all overlay graphics and the sprite. */
  private applyVisualPosition(entry: BombermanSpriteEntry): void {
    const { visualX, visualY } = entry;
    const ts = this.tileSize;
    // Sprite gets the tuned vertical push so the feet land on the tile floor.
    entry.sprite.setPosition(visualX, visualY + SPRITE_Y_OFFSET_PX);

    // Ambush star — sits ON the tile under the bomberman. We don't reset
    // y between frames so the entry/exit/pulse tweens can own scale/alpha
    // changes; rotation is driven by tick().
    entry.ambushStar.x = visualX;
    entry.ambushStar.y = visualY;

    // Stun icon floats slightly above the head, bobbing gently via time.
    const bob = Math.sin(this.scene.time.now / 220) * 2;
    entry.stunIcon.setPosition(visualX, visualY - ts * 1.75 + bob);

    // Name label sits just above the head. Round to integer pixels so the
    // text doesn't smear when the sprite is mid-lerp at a fractional pixel.
    if (entry.nameLabel) {
      entry.nameLabel.setPosition(Math.round(visualX), Math.round(visualY - ts * 1.2));
    }
  }
}

/**
 * Compute 8-way facing from a movement delta. y+ is south (Phaser screen
 * convention). Returns `fallback` when dx=dy=0.
 */
/**
 * Draw a 12-point ambush star at the Graphics' local origin (0, 0). The
 * caller positions the Graphics each frame; this only paints the polygon.
 * Outer radius ≈ 0.45 tiles, inner ≈ 0.22 tiles — the star reads as a
 * solid floor decal under the bomberman. Light-red single tone with a
 * thin white core for the "white-red" identity the user asked for.
 */
function drawAmbushStar(g: Phaser.GameObjects.Graphics, tileSize: number): void {
  const outerR = tileSize * 0.45;
  const innerR = tileSize * 0.22;
  const points: { x: number; y: number }[] = [];
  const spikes = 12;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    // Start at -90° (top) so the rotation reads symmetrically.
    const angle = -Math.PI / 2 + (i * Math.PI) / spikes;
    points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  g.clear();
  g.fillStyle(0xff8888, 1);
  g.beginPath();
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  g.closePath();
  g.fillPath();
  // Soft white core to brighten the center — gives the "light red / white"
  // tonal blend without alternating spike colors.
  g.fillStyle(0xffffff, 0.55);
  g.fillCircle(0, 0, innerR * 0.6);
}

function directionFromDelta8(dx: number, dy: number, fallback: Facing): Facing {
  if (dx === 0 && dy === 0) return fallback;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (sx ===  1 && sy ===  0) return 'right';
  if (sx ===  1 && sy ===  1) return 'down-right';
  if (sx ===  0 && sy ===  1) return 'down';
  if (sx === -1 && sy ===  1) return 'down-left';
  if (sx === -1 && sy ===  0) return 'left';
  if (sx === -1 && sy === -1) return 'up-left';
  if (sx ===  0 && sy === -1) return 'up';
  /* sx === 1 && sy === -1 */ return 'up-right';
}
