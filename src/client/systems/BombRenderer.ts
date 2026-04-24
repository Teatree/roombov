import Phaser from 'phaser';
import type { BombInstance, BombType, FireTile, SmokeCloud, Mine } from '@shared/types/bombs.ts';
import type { ActiveFlare } from '@shared/types/match.ts';
import type { Tile } from '@shared/systems/BombResolver.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { bombIconFrame } from './BombIcons.ts';

/**
 * Decal decay — see BALANCE.decalDecay in `src/shared/config/balance.ts`.
 * Returns the opacity multiplier for a decal of a given age (turns since
 * stamp). Full opacity for the first `fullTurns` turns, then linearly
 * decays to `minOpacity` over the next `fadeTurns`.
 */
export function decalDecayAlpha(age: number): number {
  const cfg = BALANCE.decalDecay;
  if (age <= cfg.fullTurns) return 1.0;
  if (age >= cfg.fullTurns + cfg.fadeTurns) return cfg.minOpacity;
  const t = (age - cfg.fullTurns) / cfg.fadeTurns;
  return 1.0 + (cfg.minOpacity - 1.0) * t;
}

/**
 * Persistent bomb / effect renderer.
 *
 * Maintains a keyed map of visuals so bombs don't get recreated every state
 * update — that matters for tween-driven animations (pulse while waiting,
 * flicker for fire, shimmer for flare light). Visuals are diffed against the
 * incoming MatchState each turn: new bombs spawn, gone bombs die.
 *
 * Explosion effects are one-shot animations triggered from `turn_result`
 * events via `spawnExplosion(type, centerX, centerY, tiles)` — they create
 * transient graphics that auto-destroy after their tween completes.
 */
export class BombRenderer {
  private scene: Phaser.Scene;
  /**
   * Layer for persistent/throw visuals that SHOULD be obscured by fog:
   * placed bombs, fuse numbers, throw arcs, fire tiles, flare flames.
   * Sits below the fog layer in the depth stack.
   */
  private layer: Phaser.GameObjects.Container;
  /**
   * Layer for transient burst animations that are always visible, even
   * through fog: all explosion shockwaves. Sits above the fog layer.
   */
  private explosionLayer: Phaser.GameObjects.Container;
  /**
   * Layer for scorch/burn decals from explosions. Sits below pearl and blood
   * decals per the layer spec.
   */
  private scorchDecalLayer: Phaser.GameObjects.Container;
  /**
   * Layer for ender pearl teleport decals. Sits above scorch, below blood.
   */
  private pearlDecalLayer: Phaser.GameObjects.Container;
  private tileSize: number;
  private bombVisuals = new Map<string, BombVisual>();
  private fireVisuals = new Map<string, FireVisual>();
  private flareVisuals = new Map<string, FlareVisual>();
  private smokeVisuals = new Map<string, { destroy: () => void; updateTurns: (t: number) => void }>();
  private mineVisuals = new Map<string, { destroy: () => void; setShake: (on: boolean) => void }>();
  /**
   * Pending cluster-mine visual creations — their appearance is deferred
   * until after the cluster cylinder animation's scatter phase so the
   * mines drop into view as the scatter bombs land, not instantly on the
   * turn broadcast. Keyed by mineId → TimerEvent so we can cancel if the
   * mine disappears from state before the delay fires.
   */
  private pendingMineTimers = new Map<string, Phaser.Time.TimerEvent>();
  /**
   * One decal per tile max — "they don't stack on top of each other".
   * First explosion on a tile wins; subsequent explosions skip it.
   */
  private decals = new Map<string, Phaser.GameObjects.Graphics>();

  constructor(
    scene: Phaser.Scene,
    layer: Phaser.GameObjects.Container,
    explosionLayer: Phaser.GameObjects.Container,
    scorchDecalLayer: Phaser.GameObjects.Container,
    pearlDecalLayer: Phaser.GameObjects.Container,
    tileSize: number,
  ) {
    this.scene = scene;
    this.layer = layer;
    this.explosionLayer = explosionLayer;
    this.scorchDecalLayer = scorchDecalLayer;
    this.pearlDecalLayer = pearlDecalLayer;
    this.tileSize = tileSize;
  }

  /** Smoke mode: local bomberman is inside a smoke cloud. Bombs render
   *  above fog at 95% alpha so the player can still see them clearly. */
  private smokeMode = false;

  /**
   * Bombs whose "landed" visual should be delayed until their throw arc
   * completes. Populated by MatchScene when it sees a `throw` event, read
   * by syncBombs on the next snapshot. Key is bombId, value is the delay
   * in ms. Entries are cleared after the deferred spawn fires.
   */
  private pendingThrowLanding = new Map<string, number>();

  /** Called by MatchScene when a throw arc is spawned. Defers the landed
   *  bomb visual for `delayMs` so the sprite doesn't pop in at the target
   *  while the arc is still mid-flight. */
  markPendingThrow(bombId: string, delayMs: number): void {
    this.pendingThrowLanding.set(bombId, delayMs);
  }

  syncBombs(bombs: BombInstance[]): void {
    const seen = new Set<string>();
    for (const b of bombs) {
      seen.add(b.id);
      if (!this.bombVisuals.has(b.id)) {
        const pendingDelay = this.pendingThrowLanding.get(b.id);
        if (pendingDelay !== undefined) {
          this.pendingThrowLanding.delete(b.id);
          const bombSnapshot = b;
          this.scene.time.delayedCall(pendingDelay, () => {
            if (this.bombVisuals.has(bombSnapshot.id)) return;
            this.bombVisuals.set(bombSnapshot.id, this.createBomb(bombSnapshot));
          });
        } else {
          this.bombVisuals.set(b.id, this.createBomb(b));
        }
      } else {
        // Update the fuse countdown on existing visuals
        this.bombVisuals.get(b.id)!.updateFuse?.(b.fuseRemaining);
      }
      // Shake tween for bombs about to detonate next turn. The resolver
      // decrements fuseRemaining before broadcasting, so a value of 0 in
      // the broadcast state means "triggers on the next turn". All bombs
      // with fuseTurns >= 1 (Bomb, Wide Bomb, Delay Tricky, Banana, Flash,
      // Big Huge, Banana Piece) sit with fuseRemaining=0 for one turn
      // before exploding, and shake during that window.
      // `vis` is undefined during the deferred-landing window for a bomb
      // mid-throw — skip shake/smoke-mode updates until its visual exists.
      const vis = this.bombVisuals.get(b.id);
      vis?.setShake?.(b.fuseRemaining === 0 && BALANCE.bombs.shakePreDetonation);
      // Smoke mode override: bump bomb alpha toward full so it's clearly
      // visible vs the surrounding smoke haze.
      vis?.setSmokeMode?.(this.smokeMode);
    }
    for (const [id, vis] of this.bombVisuals) {
      if (!seen.has(id)) {
        // Bomb is gone from state — but we want it to KEEP SHAKING all the
        // way until the explosion visual kicks in. Defer destruction until
        // the start of Beat 2 (1/3 of the transition) — same moment
        // explosions begin in MatchScene.onTurnResult. The shake tween
        // keeps running in the interim.
        const delay = (BALANCE.match.transitionPhaseSeconds * 1000) / 3;
        this.scene.time.delayedCall(delay, () => vis.destroy());
        this.bombVisuals.delete(id);
      }
    }
  }

  /**
   * Toggle smoke mode: called from MatchScene when the local bomberman's
   * tile is inside a smoke cloud. While on:
   *   - bomb graphics render above the fog layer so they stand out
   *   - bomb alpha is pinned to 0.95 (brighter than surrounding dimmed
   *     effects which stay under the fog layer)
   */
  setSmokeMode(on: boolean): void {
    this.smokeMode = on;
    for (const vis of this.bombVisuals.values()) vis.setSmokeMode?.(on);
  }

  syncFire(tiles: FireTile[], currentTurn: number = 0): void {
    const seen = new Set<string>();
    for (const f of tiles) {
      const key = `${f.x},${f.y}`;
      seen.add(key);
      if (!this.fireVisuals.has(key)) {
        this.fireVisuals.set(key, this.createFire(f.x, f.y, f.kind ?? 'molotov'));
        // Phosphorus specifically: stamp a burn decal as each fire tile
        // lights up, so the trail of where the phosphorus BURNED is what
        // remains after the fires go out (the impact itself leaves no
        // decal). Molotov already gets decals from its direct bomb_triggered
        // event; phosphorus fires spawn separately, hence this path.
        if (f.kind === 'phosphorus') {
          this.stampDecal('phosphorus', { x: f.x, y: f.y }, currentTurn);
        }
      }
    }
    for (const [key, vis] of this.fireVisuals) {
      if (!seen.has(key)) {
        vis.destroy();
        this.fireVisuals.delete(key);
      }
    }
  }

  /**
   * Sync flare visuals. Each flare shows a single flame on its landing tile
   * that decays over 3 turns (bright → medium → dim). Visible from anywhere.
   */
  syncFlares(flares: ActiveFlare[]): void {
    const seen = new Set<string>();
    for (const f of flares) {
      seen.add(f.id);
      if (!this.flareVisuals.has(f.id)) {
        this.flareVisuals.set(f.id, this.createFlareFlame(f.x, f.y, f.turnsRemaining, f.kind ?? 'flare'));
      } else {
        this.flareVisuals.get(f.id)!.updateTurns?.(f.turnsRemaining);
      }
    }
    for (const [id, vis] of this.flareVisuals) {
      if (!seen.has(id)) {
        vis.destroy();
        this.flareVisuals.delete(id);
      }
    }
  }

  /**
   * Animated throw arc. Spawns a bomb visual at the thrower's tile and
   * tweens it along a parabolic path to the target, rotating as it flies.
   * The visual is transient — it destroys itself on landing. A persistent
   * BombInstance visual (from syncBombs) fades in at the target *after*
   * the arc lands, so the two don't visually overlap.
   */
  /**
   * Spawn a simple rotating bomb sprite that flies in a straight line from
   * the thrower's tile to the target tile. Flight time is always half the
   * transition phase so all throws feel consistent regardless of distance.
   *
   * If `isVisible` is provided, the sprite is hidden on any frame where its
   * current tile is outside LOS — so a bomb thrown from darkness appears to
   * emerge from the fog when it enters the visible area, and disappears
   * again if it leaves. The start/end tile is used for the check (the arc
   * is a straight line in screen space, so the current tile is just the
   * bomb's own position / tileSize).
   */
  spawnThrowArc(
    type: BombType,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    isVisible?: (tileX: number, tileY: number) => boolean,
  ): { duration: number } {
    const ts = this.tileSize;
    const sx = fromX * ts + ts / 2;
    const sy = fromY * ts + ts / 2;
    const ex = toX * ts + ts / 2;
    const ey = toY * ts + ts / 2;

    const img = this.scene.add.image(sx, sy, 'bomb_icons', bombIconFrame(type));
    img.setDisplaySize(ts * 0.9, ts * 0.9);
    this.layer.add(img);

    // Seed initial visibility so bombs starting in fog don't flicker on for
    // one frame before the first onUpdate runs.
    if (isVisible) img.setVisible(isVisible(fromX, fromY));

    // Arc duration = one third of the transition (beat 1 window: "Action
    // Perform"). The bomb lands exactly when beat 2 ("Action Result") begins,
    // which is when its explosion/smoke/teleport visual kicks in.
    const duration = (BALANCE.match.transitionPhaseSeconds * 1000) / 3;

    this.scene.tweens.add({
      targets: img,
      x: ex,
      y: ey,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        img.setRotation(img.rotation + 0.15);
        if (isVisible) {
          const tx = Math.floor(img.x / ts);
          const ty = Math.floor(img.y / ts);
          img.setVisible(isVisible(tx, ty));
        }
      },
      onComplete: () => img.destroy(),
    });

    return { duration };
  }

  /**
   * Per-bomb explosion animation. Called from `onTurnResult` when a
   * `bomb_triggered` event arrives. Dispatches to the correct visual style
   * based on the bomb type — see the private helpers below.
   *
   * `centerX, centerY` is the bomb's own tile (used by effects that aren't
   * tile-centered, like the Banana splat). `tiles` is the set the resolver
   * marked as affected.
   */
  /**
   * Spawn the explosion visual for a triggered bomb.
   *
   * @param startDelayMs - wall-clock ms to wait before starting the animation.
   *   MatchScene computes this so explosions kick off at the halfway point
   *   of the transition phase (or when a thrown bomb lands, whichever is later).
   * @param durationMs - total visual duration. Animations are stretched to fill
   *   exactly this window so they run right up to the end of the transition.
   *   Decals stamp at `startDelayMs + durationMs` — i.e. after the burst is done.
   */
  spawnExplosion(
    type: BombType,
    centerX: number,
    centerY: number,
    tiles: Tile[],
    startDelayMs: number,
    durationMs: number,
    spawnTurn: number,
  ): void {
    const dur = Math.max(100, durationMs);
    const startAnim = (): void => {
      // Banana's "explosion" is just a splat at its own tile — the four
      // scattered contact bombs spawn their own explosions when they trigger.
      if (type === 'banana') {
        this.bananaSplat(centerX, centerY, dur);
        return;
      }

      // Phosphorus and Cluster impacts are single-center visuals (not per-tile).
      if (type === 'phosphorus') {
        this.phosphorusFlash({ x: centerX, y: centerY }, dur);
        return;
      }
      if (type === 'cluster_bomb') {
        // Cluster impact is handled by spawnClusterCylinder (invoked
        // directly from MatchScene with mine positions). spawnExplosion
        // also bails here for any code path that still calls in generically.
        return;
      }
      for (const tile of tiles) {
        switch (type) {
          case 'rock': this.rockDust(tile, dur); break;
          case 'bomb': this.fireBoom(tile, { core: 0xffffaa, mid: 0xff8822, outer: 0xcc2200, maxRadius: 0.7, duration: dur, emberCount: 7 }); break;
          case 'bomb_wide': this.fireBoom(tile, { core: 0xffffcc, mid: 0xffbb44, outer: 0xee6622, maxRadius: 0.6, duration: dur, emberCount: 5 }); break;
          case 'contact': this.fireBoom(tile, { core: 0xffeeaa, mid: 0xff6633, outer: 0xaa0000, maxRadius: 0.5, duration: dur, emberCount: 4 }); break;
          case 'banana_child': this.fireBoom(tile, { core: 0xffee44, mid: 0xffcc22, outer: 0xaa8811, maxRadius: 0.5, duration: dur, emberCount: 4 }); break;
          case 'delay_tricky': this.plasmaBurst(tile, dur); break;
          case 'flare': this.flareFlash(tile, dur); break;
          case 'molotov': this.fireSplash(tile, dur); break;
          // New bombs:
          case 'flash': this.fireBoom(tile, { core: 0xaaddff, mid: 0x4488ff, outer: 0x1133aa, maxRadius: 0.7, duration: dur, emberCount: 7 }); break;
          case 'big_huge': this.fireBoom(tile, { core: 0xffffcc, mid: 0xff9944, outer: 0xaa2200, maxRadius: 0.8, duration: dur, emberCount: 9 }); break;
          case 'fart_escape': /* no per-tile explosion; smoke sync handles visuals */ break;
          case 'motion_detector_flare': /* mine placement — sync handles visuals */ break;
        }
      }
    };

    const stampAllDecals = (): void => {
      // Flare doesn't leave a decal — it's light, not an explosion.
      if (type === 'flare') return;
      if (type === 'banana') return; // banana itself doesn't scorch; its children do
      if (type === 'ender_pearl') return; // teleport decal handled separately
      // Phosphorus: the impact itself doesn't scorch — decals only come
      // from the fires that ignite next turn (stamped in syncFire when
      // phosphorus-kind fire tiles appear).
      if (type === 'phosphorus') return;
      // Fart Escape / Motion Detector Flare never stamp impact decals.
      if (type === 'fart_escape' || type === 'motion_detector_flare') return;
      // Flash is pure stun — no damage, no scorch marks.
      if (type === 'flash') return;
      for (const tile of tiles) this.stampDecal(type, tile, spawnTurn);
    };

    if (startDelayMs > 0) {
      this.scene.time.delayedCall(startDelayMs, startAnim);
    } else {
      startAnim();
    }
    this.scene.time.delayedCall(Math.max(0, startDelayMs) + dur, stampAllDecals);

    // Lingering smoke particles after the main burst — visible even after
    // the transition ends, giving the explosion a longer perceived duration.
    if (type !== 'flare' && type !== 'banana' && type !== 'ender_pearl') {
      this.scene.time.delayedCall(Math.max(0, startDelayMs) + dur * 0.7, () => {
        for (const tile of tiles) {
          this.spawnSmoke(tile.x, tile.y);
        }
      });
    }
  }

  /** Lingering smoke puff — fades slowly after the main explosion burst. */
  private spawnSmoke(tileX: number, tileY: number): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2 + (Math.random() - 0.5) * ts * 0.3;
    const cy = tileY * ts + ts / 2 + (Math.random() - 0.5) * ts * 0.3;
    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    const smokeR = ts * (0.2 + Math.random() * 0.15);
    this.scene.tweens.add({
      targets: g,
      duration: 1200 + Math.random() * 600,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        g.fillStyle(0x555555, (1 - t) * 0.35);
        g.fillCircle(cx, cy - t * ts * 0.3, smokeR * (1 + t * 0.5));
      },
      onComplete: () => g.destroy(),
    });
  }

  /**
   * Stamp a persistent scorch mark on a tile. First explosion wins — if a
   * decal already exists on this tile, skip. The decal lives in scorchDecalLayer
   * and is RTS-fog gated via updateDecalVisibility.
   */
  private stampDecal(type: BombType, tile: Tile, spawnTurn: number): void {
    const key = `${tile.x},${tile.y}`;
    if (this.decals.has(key)) return;

    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;
    const g = this.scene.add.graphics();
    // Tag for decal decay — applyDecalDecay multiplies baseAlpha by the age
    // curve every turn. See BALANCE.decalDecay in balance.ts.
    g.setData('spawnTurn', spawnTurn);
    g.setData('baseAlpha', 0.8);
    this.scorchDecalLayer.add(g);

    switch (type) {
      case 'rock':
        this.drawDustDecal(g, cx, cy, ts);
        break;
      case 'bomb':
      case 'bomb_wide':
      case 'contact':
      case 'banana_child':
      case 'big_huge':
      case 'flash':
      case 'cluster_bomb':
        this.drawScorchDecal(g, cx, cy, ts);
        break;
      case 'delay_tricky':
        this.drawPlasmaDecal(g, cx, cy, ts);
        break;
      case 'molotov':
      case 'phosphorus':
        this.drawBurnedDecal(g, cx, cy, ts);
        break;
      default:
        this.drawScorchDecal(g, cx, cy, ts);
        break;
    }

    // Fade in gradually, 20% transparent at rest
    g.setAlpha(0);
    this.scene.tweens.add({ targets: g, alpha: 0.8, duration: 800, ease: 'Sine.easeIn' });

    this.decals.set(key, g);
  }

  /** Small gray dust smudge — Rock impact */
  private drawDustDecal(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ts: number): void {
    g.fillStyle(0x665544, 0.45);
    g.fillCircle(cx, cy, ts * 0.22);
    g.fillStyle(0x887766, 0.3);
    g.fillCircle(cx + ts * 0.08, cy - ts * 0.05, ts * 0.12);
    g.fillCircle(cx - ts * 0.1, cy + ts * 0.06, ts * 0.09);
  }

  /** Dark scorch mark with slightly orange center — standard fire bombs */
  private drawScorchDecal(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ts: number): void {
    // Outer dark soot
    g.fillStyle(0x1a0a05, 0.7);
    g.fillCircle(cx, cy, ts * 0.38);
    // Inner burn
    g.fillStyle(0x331a0a, 0.8);
    g.fillCircle(cx, cy, ts * 0.28);
    // Warm center hint
    g.fillStyle(0x552211, 0.6);
    g.fillCircle(cx, cy, ts * 0.15);
    // A few irregular specks
    g.fillStyle(0x000000, 0.5);
    g.fillCircle(cx + ts * 0.2, cy - ts * 0.15, ts * 0.06);
    g.fillCircle(cx - ts * 0.22, cy + ts * 0.18, ts * 0.07);
    g.fillCircle(cx - ts * 0.05, cy + ts * 0.25, ts * 0.05);
  }

  /** Purple/magenta plasma burn — Delay Tricky */
  private drawPlasmaDecal(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ts: number): void {
    // Dark purple outer
    g.fillStyle(0x220022, 0.7);
    g.fillCircle(cx, cy, ts * 0.36);
    // Magenta inner ring
    g.fillStyle(0x441144, 0.75);
    g.fillCircle(cx, cy, ts * 0.24);
    // Bright magenta center dot
    g.fillStyle(0x883388, 0.6);
    g.fillCircle(cx, cy, ts * 0.1);
    // Radial streaks (star-like)
    g.lineStyle(2, 0x331133, 0.6);
    for (let i = 0; i < 4; i++) {
      const ang = (Math.PI / 2) * i + Math.PI / 4;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(ang) * ts * 0.35, cy + Math.sin(ang) * ts * 0.35);
      g.strokePath();
    }
  }

  /** Scorched earth with dark burned spots — Molotov */
  private drawBurnedDecal(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ts: number): void {
    // Full-tile dark wash
    g.fillStyle(0x0a0505, 0.55);
    g.fillRect(cx - ts * 0.48, cy - ts * 0.48, ts * 0.96, ts * 0.96);
    // Scorch blotches
    g.fillStyle(0x1a0a05, 0.85);
    g.fillCircle(cx, cy, ts * 0.35);
    g.fillStyle(0x2a1505, 0.8);
    g.fillCircle(cx - ts * 0.1, cy + ts * 0.12, ts * 0.18);
    g.fillCircle(cx + ts * 0.15, cy - ts * 0.1, ts * 0.15);
    // Darkest scar spots
    g.fillStyle(0x000000, 0.7);
    g.fillCircle(cx, cy, ts * 0.08);
    g.fillCircle(cx + ts * 0.22, cy + ts * 0.18, ts * 0.05);
    g.fillCircle(cx - ts * 0.25, cy - ts * 0.2, ts * 0.06);
  }

  /**
   * Death animation — a toppling, red-tinted silhouette that rotates and
   * fades out over ~800ms. Used when a `died` turn event fires.
   * We don't need the full Bomberman colors — the fade is fast and the
   * red tint overrides the clothing colors anyway.
   */
  /**
   * Blood splash particles flavored on death. The toppling silhouette and
   * red flash were retired when BombermanSpriteSystem took over death
   * visuals — only the splash particles remain as flavor.
   */
  emitBloodSplash(tileX: number, tileY: number): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;

    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = ts * (0.3 + Math.random() * 0.5);
      const dot = this.scene.add.graphics();
      this.layer.add(dot);
      dot.fillStyle(0x991111, 1);
      dot.fillCircle(0, 0, 2 + Math.random() * 2);
      dot.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: 700 + Math.random() * 200,
        ease: 'Cubic.easeOut',
        onComplete: () => dot.destroy(),
      });
    }
  }

  // ---- per-bomb explosion styles ----

  private rockDust(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        g.fillStyle(0xaaaaaa, (1 - t) * 0.7);
        g.fillCircle(cx, cy, ts * (0.2 + 0.25 * t));
        g.lineStyle(2, 0x776655, (1 - t) * 0.8);
        g.strokeCircle(cx, cy, ts * (0.15 + 0.3 * t));
      },
      onComplete: () => g.destroy(),
    });

    // A few dust motes
    for (let i = 0; i < 4; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dot = this.scene.add.graphics();
      this.explosionLayer.add(dot);
      dot.fillStyle(0x998877, 0.8);
      dot.fillCircle(0, 0, 1.5);
      dot.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * ts * 0.4,
        y: cy + Math.sin(angle) * ts * 0.4,
        alpha: 0,
        duration: durationMs,
        onComplete: () => dot.destroy(),
      });
    }
  }

  private fireBoom(tile: Tile, opts: {
    core: number; mid: number; outer: number;
    maxRadius: number; duration: number; emberCount: number;
  }): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: opts.duration,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Outer shockwave ring — expands fast, fades quick
        g.lineStyle(4, opts.outer, (1 - t) * 0.95);
        g.strokeCircle(cx, cy, ts * opts.maxRadius * (0.3 + 0.9 * t));
        // Middle fire bloom
        g.fillStyle(opts.mid, (1 - t) * 0.8);
        g.fillCircle(cx, cy, ts * opts.maxRadius * (0.25 + 0.4 * t));
        // Bright core flash
        g.fillStyle(opts.core, (1 - t) * 0.95);
        g.fillCircle(cx, cy, ts * opts.maxRadius * (0.15 + 0.2 * t));
      },
      onComplete: () => g.destroy(),
    });

    // Ember particles flying outward
    for (let i = 0; i < opts.emberCount; i++) {
      const angle = (Math.PI * 2 * i) / opts.emberCount + Math.random() * 0.6;
      const dist = ts * opts.maxRadius * (0.8 + Math.random() * 0.5);
      const ember = this.scene.add.graphics();
      this.explosionLayer.add(ember);
      ember.fillStyle(opts.core, 1);
      ember.fillCircle(0, 0, 1.5 + Math.random() * 1.5);
      ember.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: ember,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: opts.duration,
        ease: 'Cubic.easeOut',
        onComplete: () => ember.destroy(),
      });
    }
  }

  private plasmaBurst(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const u = Math.max(ts, 24);
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Sine.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Bright outer shockwave ring
        g.lineStyle(4, 0xcc33cc, Math.max(0, 1 - t * 1.2));
        g.strokeCircle(cx, cy, u * (0.4 + 0.8 * t));
        // Core purple orb — stays bright longer
        g.fillStyle(0xff66ff, Math.max(0, 1 - t * 0.9));
        g.fillCircle(cx, cy, u * (0.3 + 0.35 * t));
        // Hot white center flash
        g.fillStyle(0xffccff, Math.max(0, 1 - t * 1.5));
        g.fillCircle(cx, cy, u * (0.15 + 0.15 * t));
        // Radial lightning spikes
        g.lineStyle(2, 0xffccff, Math.max(0, 1 - t * 1.1));
        const reach = u * (0.5 + 0.7 * t);
        for (let i = 0; i < 8; i++) {
          const ang = (Math.PI * 2 * i) / 8;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(cx + Math.cos(ang) * reach, cy + Math.sin(ang) * reach);
          g.strokePath();
        }
      },
      onComplete: () => g.destroy(),
    });

    // Magenta spark particles
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const dist = u * (0.6 + Math.random() * 0.4);
      const spark = this.scene.add.graphics();
      this.explosionLayer.add(spark);
      spark.fillStyle(0xff88ff, 1);
      spark.fillCircle(0, 0, 2);
      spark.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: spark,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: durationMs,
        ease: 'Cubic.easeOut',
        onComplete: () => spark.destroy(),
      });
    }
  }

  private bananaSplat(centerX: number, centerY: number, durationMs: number): void {
    const ts = this.tileSize;
    const cx = centerX * ts + ts / 2;
    const cy = centerY * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Expanding yellow splat
        g.fillStyle(0xffdd22, (1 - t) * 0.8);
        g.fillCircle(cx, cy, ts * (0.2 + 0.3 * t));
        g.lineStyle(2, 0x997711, (1 - t) * 0.9);
        g.strokeCircle(cx, cy, ts * (0.2 + 0.3 * t));
        // Little peel bits flying diagonally
        g.fillStyle(0xffee55, (1 - t) * 0.9);
        for (let i = 0; i < 4; i++) {
          const ang = (Math.PI / 2) * i + Math.PI / 4;
          const d = ts * 0.4 * t;
          g.fillCircle(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, 3);
        }
      },
      onComplete: () => g.destroy(),
    });
  }

  private flareFlash(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    // Bright flash burst — fast white expansion then fade
    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Outer glow
        g.fillStyle(0xffffff, (1 - t) * 0.6);
        g.fillCircle(cx, cy, ts * (0.5 + 1.5 * t));
        // Inner core
        g.fillStyle(0xffffee, (1 - t) * 0.9);
        g.fillCircle(cx, cy, ts * (0.3 + 0.5 * t));
      },
      onComplete: () => g.destroy(),
    });

    // Radial light rays
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      const ray = this.scene.add.graphics();
      this.explosionLayer.add(ray);
      ray.lineStyle(2, 0xffffcc, 0.9);
      ray.beginPath();
      ray.moveTo(cx, cy);
      ray.lineTo(cx + Math.cos(angle) * ts * 0.5, cy + Math.sin(angle) * ts * 0.5);
      ray.strokePath();
      this.scene.tweens.add({
        targets: ray,
        alpha: 0,
        duration: durationMs,
        onComplete: () => ray.destroy(),
      });
    }
  }

  /**
   * Phosphorus impact — slow white rain of droplets falling over the
   * 11×11 reveal area. Each droplet fades in near the top of the area,
   * falls a short distance, and fades out. Multiple rounds of droplets
   * spawn over the animation duration.
   */
  private phosphorusFlash(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;
    const halfExtent = ts * 5.5; // covers the 11×11 reveal area

    // Gentle lingering glow behind the rain — helps read the affected area.
    const glow = this.scene.add.graphics();
    this.explosionLayer.add(glow);
    this.scene.tweens.add({
      targets: glow,
      duration: durationMs,
      ease: 'Sine.easeInOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        glow.clear();
        const alpha = Math.sin(t * Math.PI) * 0.18; // ease in + out
        glow.fillStyle(0xffffff, alpha);
        glow.fillRect(cx - halfExtent, cy - halfExtent, halfExtent * 2, halfExtent * 2);
      },
      onComplete: () => glow.destroy(),
    });

    // Spawn droplets in waves over the animation duration.
    const dropCount = 90;
    for (let i = 0; i < dropCount; i++) {
      const spawnAt = (i / dropCount) * durationMs * 0.85;
      this.scene.time.delayedCall(spawnAt, () => {
        const px = cx + (Math.random() * 2 - 1) * halfExtent;
        const startY = cy + (Math.random() * 2 - 1) * halfExtent - ts * 0.4;
        const dropLen = ts * (0.5 + Math.random() * 0.9);

        const drop = this.scene.add.graphics();
        this.explosionLayer.add(drop);
        // Short vertical streak (simulates falling droplet) — pale white.
        drop.lineStyle(1.5, 0xffffff, 0.9);
        drop.beginPath();
        drop.moveTo(0, -dropLen);
        drop.lineTo(0, 0);
        drop.strokePath();
        // A small glint at the tip.
        drop.fillStyle(0xffffff, 1);
        drop.fillCircle(0, 0, 1.5);
        drop.setPosition(px, startY);
        drop.setAlpha(0);

        const fallDur = 600 + Math.random() * 400; // slow
        this.scene.tweens.add({
          targets: drop,
          y: startY + ts * 1.3,
          alpha: { from: 0, to: 1 },
          duration: fallDur * 0.3,
          ease: 'Sine.easeIn',
          onComplete: () => {
            this.scene.tweens.add({
              targets: drop,
              y: startY + ts * 2.4,
              alpha: 0,
              duration: fallDur * 0.7,
              ease: 'Sine.easeOut',
              onComplete: () => drop.destroy(),
            });
          },
        });
      });
    }
  }

  /**
   * Motion Detector trigger effect — a small orange streak shoots up from
   * the mine tile (like a flare cartridge firing), fades, and leaves a
   * few trailing sparks. Called when a motion-detector mine trips.
   */
  spawnMotionDetectorLaunch(tileX: number, tileY: number): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const riseHeight = ts * 3.5;

    // Main streak — elongated ellipse, rises and fades.
    const streak = this.scene.add.graphics();
    this.explosionLayer.add(streak);
    streak.fillStyle(0xffaa44, 1);
    streak.fillEllipse(0, 0, ts * 0.22, ts * 0.7);
    streak.fillStyle(0xffeecc, 1);
    streak.fillEllipse(0, ts * 0.1, ts * 0.12, ts * 0.35);
    streak.setPosition(cx, cy);
    streak.setAlpha(0.95);

    this.scene.tweens.add({
      targets: streak,
      y: cy - riseHeight,
      alpha: 0,
      duration: 500,
      ease: 'Cubic.easeOut',
      onComplete: () => streak.destroy(),
    });

    // Small bright flash at the launch tile.
    const flash = this.scene.add.graphics();
    this.explosionLayer.add(flash);
    this.scene.tweens.add({
      targets: flash,
      duration: 220,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        flash.clear();
        flash.fillStyle(0xffcc66, (1 - t) * 0.8);
        flash.fillCircle(cx, cy, ts * (0.15 + 0.15 * t));
        flash.fillStyle(0xffffcc, (1 - t) * 0.9);
        flash.fillCircle(cx, cy, ts * (0.08 + 0.08 * t));
      },
      onComplete: () => flash.destroy(),
    });

    // Trailing sparks chasing the streak upward.
    for (let i = 0; i < 6; i++) {
      const delay = 30 + i * 45;
      this.scene.time.delayedCall(delay, () => {
        const spark = this.scene.add.graphics();
        this.explosionLayer.add(spark);
        spark.fillStyle(0xffaa66, 1);
        spark.fillCircle(0, 0, 1.5);
        const jitterX = cx + (Math.random() * 2 - 1) * ts * 0.15;
        spark.setPosition(jitterX, cy);
        this.scene.tweens.add({
          targets: spark,
          y: cy - riseHeight * (0.6 + Math.random() * 0.4),
          alpha: 0,
          duration: 400 + Math.random() * 200,
          ease: 'Sine.easeOut',
          onComplete: () => spark.destroy(),
        });
      });
    }
  }

  /**
   * Cluster Bomb impact — a tall gray cylindrical canister falls from
   * off-screen at the impact tile, slams down with a small shockwave,
   * then splits open and launches mini-bombs in arcs out to each mine
   * landing position. Mine sprites themselves then appear via syncMines.
   *
   * @param centerX / centerY — impact tile (the dispenser lands here).
   * @param mines — list of tile positions where each mine will land.
   * @param startDelayMs — wait before starting; caller aligns with bomb arc.
   */
  spawnClusterCylinder(
    centerX: number,
    centerY: number,
    mines: Array<{ x: number; y: number }>,
    startDelayMs: number,
  ): void {
    const ts = this.tileSize;
    const cx = centerX * ts + ts / 2;
    const cy = centerY * ts + ts / 2;

    const FALL_MS = 260;
    const SCATTER_MS = 420;

    this.scene.time.delayedCall(Math.max(0, startDelayMs), () => {
      // --- Falling cylinder ---
      const canister = this.scene.add.graphics();
      this.explosionLayer.add(canister);
      const drawCanister = (): void => {
        canister.clear();
        const w = ts * 0.55;
        const h = ts * 1.2;
        // Body
        canister.fillStyle(0x444444, 1);
        canister.fillRect(-w / 2, -h, w, h);
        canister.lineStyle(2, 0x222222, 1);
        canister.strokeRect(-w / 2, -h, w, h);
        // Yellow caution stripes
        canister.fillStyle(0xffcc33, 1);
        canister.fillRect(-w / 2 + 1, -h * 0.85, w - 2, h * 0.08);
        canister.fillRect(-w / 2 + 1, -h * 0.45, w - 2, h * 0.08);
        // Top cap / nose cone
        canister.fillStyle(0x666666, 1);
        canister.fillTriangle(-w / 2, -h, w / 2, -h, 0, -h - ts * 0.4);
        canister.lineStyle(2, 0x222222, 1);
        canister.strokeTriangle(-w / 2, -h, w / 2, -h, 0, -h - ts * 0.4);
        // Bottom rim
        canister.fillStyle(0x222222, 1);
        canister.fillRect(-w / 2 - 2, -1, w + 4, 3);
      };
      drawCanister();
      const startY = cy - ts * 6;
      canister.setPosition(cx, startY);

      // Drop shadow that grows as it descends.
      const shadow = this.scene.add.graphics();
      this.explosionLayer.add(shadow);
      shadow.setPosition(cx, cy + ts * 0.2);

      this.scene.tweens.add({
        targets: canister,
        y: cy,
        duration: FALL_MS,
        ease: 'Cubic.easeIn',
        onUpdate: (tw) => {
          const t = tw.progress;
          shadow.clear();
          shadow.fillStyle(0x000000, 0.35 + t * 0.2);
          shadow.fillEllipse(0, 0, ts * (0.2 + 0.35 * t), ts * (0.08 + 0.14 * t));
        },
        onComplete: () => {
          // Impact thump — small shockwave ring + dust puff.
          const ring = this.scene.add.graphics();
          this.explosionLayer.add(ring);
          this.scene.tweens.add({
            targets: ring,
            duration: 260,
            ease: 'Cubic.easeOut',
            onUpdate: (rtw) => {
              const t = rtw.progress;
              ring.clear();
              ring.lineStyle(3, 0x888866, (1 - t) * 0.8);
              ring.strokeCircle(cx, cy + ts * 0.15, ts * (0.3 + 0.9 * t));
              ring.fillStyle(0x776655, (1 - t) * 0.5);
              ring.fillEllipse(cx, cy + ts * 0.15, ts * (0.4 + 0.6 * t), ts * (0.18 + 0.2 * t));
            },
            onComplete: () => ring.destroy(),
          });

          // --- Scatter phase: launch mini-bombs in arcs to each mine tile ---
          const n = Math.max(1, mines.length);
          for (let i = 0; i < n; i++) {
            const dest = mines[i] ?? { x: centerX, y: centerY };
            const dx = dest.x * ts + ts / 2;
            const dy = dest.y * ts + ts / 2;
            // Slight stagger so all 25 don't fire in exactly the same frame.
            const launchDelay = i * 8 + Math.random() * 20;
            this.scene.time.delayedCall(launchDelay, () => {
              const bomb = this.scene.add.graphics();
              this.explosionLayer.add(bomb);
              bomb.fillStyle(0x221111, 1);
              bomb.fillCircle(0, 0, ts * 0.12);
              bomb.fillStyle(0xaa2200, 1);
              bomb.fillCircle(0, 0, ts * 0.06);
              bomb.setPosition(cx, cy - ts * 0.5);

              // Parabolic arc — interpolate x linearly, y with a parabola
              // so the bombs visibly lob upward before falling to target.
              const counter = { t: 0 };
              const apexLift = ts * (1.2 + Math.random() * 0.8);
              const startX = cx;
              const startYArc = cy - ts * 0.5;
              this.scene.tweens.add({
                targets: counter,
                t: 1,
                duration: SCATTER_MS,
                ease: 'Sine.easeInOut',
                onUpdate: () => {
                  const t = counter.t;
                  const px = startX + (dx - startX) * t;
                  // Parabola: peaks at t=0.5, value = apexLift.
                  const py = startYArc + (dy - startYArc) * t - apexLift * 4 * t * (1 - t);
                  bomb.setPosition(px, py);
                  bomb.setRotation(t * Math.PI * 2);
                },
                onComplete: () => {
                  // Small landing puff.
                  const puff = this.scene.add.graphics();
                  this.explosionLayer.add(puff);
                  this.scene.tweens.add({
                    targets: puff,
                    duration: 260,
                    ease: 'Cubic.easeOut',
                    onUpdate: (ptw) => {
                      const t = ptw.progress;
                      puff.clear();
                      puff.fillStyle(0x776655, (1 - t) * 0.55);
                      puff.fillCircle(dx, dy, ts * (0.08 + 0.12 * t));
                    },
                    onComplete: () => puff.destroy(),
                  });
                  bomb.destroy();
                },
              });
            });
          }

          // Dispose the canister and its shadow shortly after impact.
          this.scene.tweens.add({
            targets: [canister, shadow],
            alpha: 0,
            duration: 180,
            delay: 80,
            onComplete: () => { canister.destroy(); shadow.destroy(); },
          });
        },
      });
    });
  }

  /** Cluster bomb impact — small pop + scatter puff implying mines dropped. */
  private clusterDrop(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs * 0.5,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Dark smoke pop
        g.fillStyle(0x444444, (1 - t) * 0.7);
        g.fillCircle(cx, cy, ts * (0.3 + 0.4 * t));
        // Yellow flash center
        g.fillStyle(0xffdd66, (1 - t) * 0.8);
        g.fillCircle(cx, cy, ts * (0.15 + 0.15 * t));
      },
      onComplete: () => g.destroy(),
    });

    // Scattered mine-deploy pops in a wider area
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = ts * (1.5 + Math.random() * 3.5);
      const pop = this.scene.add.graphics();
      this.explosionLayer.add(pop);
      pop.fillStyle(0x664422, 0.9);
      pop.fillCircle(0, 0, 2 + Math.random() * 1.5);
      pop.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: pop,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: durationMs * (0.6 + Math.random() * 0.4),
        ease: 'Cubic.easeOut',
        onComplete: () => pop.destroy(),
      });
    }
  }

  private fireSplash(tile: Tile, durationMs: number): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.explosionLayer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Orange splash with irregular-looking edge
        g.fillStyle(0xff6633, (1 - t) * 0.8);
        g.fillCircle(cx, cy, ts * (0.3 + 0.35 * t));
        g.fillStyle(0xffaa44, (1 - t) * 0.85);
        g.fillCircle(cx, cy, ts * (0.2 + 0.28 * t));
        g.fillStyle(0xffdd44, (1 - t) * 0.9);
        g.fillCircle(cx, cy, ts * (0.1 + 0.2 * t));
      },
      onComplete: () => g.destroy(),
    });

    // More embers than a delay bomb — it's fire
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const ember = this.scene.add.graphics();
      this.explosionLayer.add(ember);
      ember.fillStyle(0xff9944, 1);
      ember.fillCircle(0, 0, 2);
      ember.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: ember,
        x: cx + Math.cos(angle) * ts * 0.5,
        y: cy + Math.sin(angle) * ts * 0.5,
        alpha: 0,
        duration: durationMs,
        ease: 'Cubic.easeOut',
        onComplete: () => ember.destroy(),
      });
    }
  }

  /**
   * Ender Pearl teleport puff — greenish-blue expanding cloud at a tile.
   * @param aboveFog — if true, renders on explosionLayer (visible through fog);
   *   if false, renders on pearlDecalLayer (RTS-fog gated). FROM puff uses true,
   *   TO puff uses false.
   */
  spawnTeleportPuff(tileX: number, tileY: number, durationMs: number, aboveFog = false): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;

    const g = this.scene.add.graphics();
    (aboveFog ? this.explosionLayer : this.pearlDecalLayer).add(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Outer teal glow
        g.fillStyle(0x22ccaa, (1 - t) * 0.6);
        g.fillCircle(cx, cy, ts * (0.3 + 0.5 * t));
        // Inner bright core
        g.fillStyle(0x44ffcc, (1 - t) * 0.85);
        g.fillCircle(cx, cy, ts * (0.15 + 0.25 * t));
      },
      onComplete: () => g.destroy(),
    });

    // A few sparkle particles on the same layer as the puff
    const particleLayer = aboveFog ? this.explosionLayer : this.pearlDecalLayer;
    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dot = this.scene.add.graphics();
      particleLayer.add(dot);
      dot.fillStyle(0x66ffdd, 0.9);
      dot.fillCircle(0, 0, 1.5 + Math.random());
      dot.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * ts * 0.5,
        y: cy + Math.sin(angle) * ts * 0.5,
        alpha: 0,
        duration: durationMs * 0.8,
        ease: 'Cubic.easeOut',
        onComplete: () => dot.destroy(),
      });
    }
  }

  /** Stamp a greenish-blue Ender Pearl decal on a tile. */
  stampTeleportDecal(tileX: number, tileY: number, spawnTurn: number): void {
    const key = `${tileX},${tileY}`;
    if (this.decals.has(key)) return;
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const g = this.scene.add.graphics();
    // Tag for decal decay — see BALANCE.decalDecay.
    g.setData('spawnTurn', spawnTurn);
    g.setData('baseAlpha', 1.0);
    this.pearlDecalLayer.add(g);
    // Teal outer ring
    g.fillStyle(0x115544, 0.6);
    g.fillCircle(cx, cy, ts * 0.35);
    // Brighter inner spot
    g.fillStyle(0x227766, 0.7);
    g.fillCircle(cx, cy, ts * 0.2);
    // Bright center dot
    g.fillStyle(0x33aa88, 0.5);
    g.fillCircle(cx, cy, ts * 0.08);
    this.decals.set(key, g);
  }

  /**
   * Apply the decal-decay alpha curve to every scorch and pearl decal. Call
   * on each turn boundary (match_state update) — see BALANCE.decalDecay.
   * Blood decals are managed by MatchScene and have their own decay pass.
   */
  applyDecalDecay(currentTurn: number): void {
    for (const g of this.decals.values()) {
      const spawnTurn = g.getData('spawnTurn') as number | undefined;
      const baseAlpha = g.getData('baseAlpha') as number | undefined;
      if (spawnTurn === undefined || baseAlpha === undefined) continue;
      const age = Math.max(0, currentTurn - spawnTurn);
      if (age <= BALANCE.decalDecay.fullTurns) continue; // still full — avoid clobbering the scorch fade-in tween
      g.setAlpha(baseAlpha * decalDecayAlpha(age));
    }
  }

  /**
   * Update decal visibility based on fog. Call each frame from rebuildEntities.
   * Decals are only shown if their tile is currently in LOS. In seen-dim areas,
   * decals stay hidden until the player revisits (RTS fog).
   */
  updateDecalVisibility(isVisible: (x: number, y: number) => boolean): void {
    for (const [key, g] of this.decals) {
      const [sx, sy] = key.split(',').map(Number);
      g.setVisible(isVisible(sx, sy));
    }
  }

  /** Sync persistent smoke cloud visuals against current MatchState. */
  syncSmokeClouds(clouds: SmokeCloud[]): void {
    const seen = new Set<string>();
    for (const c of clouds) {
      seen.add(c.id);
      if (!this.smokeVisuals.has(c.id)) {
        this.smokeVisuals.set(c.id, this.createSmokeCloud(c));
      } else {
        this.smokeVisuals.get(c.id)!.updateTurns(c.turnsRemaining);
      }
    }
    for (const [id, vis] of this.smokeVisuals) {
      if (!seen.has(id)) {
        vis.destroy();
        this.smokeVisuals.delete(id);
      }
    }
  }

  /** Sync persistent mine visuals. */
  syncMines(mines: Mine[]): void {
    const seen = new Set<string>();
    for (const m of mines) {
      seen.add(m.id);
      if (this.mineVisuals.has(m.id)) {
        // Primed mines shake like a bomb about to detonate.
        this.mineVisuals.get(m.id)!.setShake(
          m.primedCountdown !== undefined && BALANCE.bombs.shakePreDetonation,
        );
        continue;
      }
      // Already scheduled for deferred creation — don't double-schedule.
      if (this.pendingMineTimers.has(m.id)) continue;
      if (m.kind === 'cluster') {
        // Cluster mines drop in via the cylinder animation. Defer the
        // visual creation so the mine sprite appears at the scatter
        // landing, not instantly on match_state. We use 85% of the full
        // transition as the delay — this lands the sprites right as the
        // scatter bombs finish their arcs.
        const delay = (BALANCE.match.transitionPhaseSeconds * 1000) * 0.85;
        const snapshot: Mine = { ...m };
        const timer = this.scene.time.delayedCall(delay, () => {
          this.pendingMineTimers.delete(m.id);
          // Only create if the mine is still alive (not destroyed/triggered
          // in the meantime) — tracked by absence from mineVisuals.
          if (!this.mineVisuals.has(m.id)) {
            this.mineVisuals.set(m.id, this.createMineVisual(snapshot));
          }
        });
        this.pendingMineTimers.set(m.id, timer);
        continue;
      }
      // Motion detector / other kinds appear immediately.
      this.mineVisuals.set(m.id, this.createMineVisual(m));
    }
    // Destroy visuals for mines that left state.
    for (const [id, vis] of this.mineVisuals) {
      if (!seen.has(id)) {
        // Same treatment as bombs: keep the shake running until the
        // explosion visual fires at the transition midpoint.
        const delay = (BALANCE.match.transitionPhaseSeconds * 1000) / 2;
        this.scene.time.delayedCall(delay, () => vis.destroy());
        this.mineVisuals.delete(id);
      }
    }
    // Cancel pending-creation timers for mines that vanished before their
    // delay fired (e.g. an explosion wiped them during the same turn).
    for (const [id, timer] of this.pendingMineTimers) {
      if (!seen.has(id)) {
        timer.remove(false);
        this.pendingMineTimers.delete(id);
      }
    }
  }

  private createSmokeCloud(cloud: SmokeCloud): { destroy: () => void; updateTurns: (t: number) => void } {
    const ts = this.tileSize;
    const graphics: Phaser.GameObjects.Graphics[] = [];
    // One soft gray puff per tile in the cloud.
    for (const tile of cloud.tiles) {
      const g = this.scene.add.graphics();
      g.setPosition(tile.x * ts + ts / 2, tile.y * ts + ts / 2);
      g.fillStyle(0x888888, 0.55);
      g.fillCircle(0, 0, ts * 0.55);
      g.fillStyle(0xaaaaaa, 0.3);
      g.fillCircle(-ts * 0.1, -ts * 0.05, ts * 0.35);
      g.fillCircle(ts * 0.12, ts * 0.07, ts * 0.3);
      this.explosionLayer.add(g);
      graphics.push(g);
      // Subtle pulse
      this.scene.tweens.add({
        targets: g,
        alpha: 0.8,
        duration: 900 + Math.random() * 400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    return {
      destroy: () => { for (const g of graphics) g.destroy(); },
      updateTurns: (t: number) => {
        // Fade out on the last turn.
        const alphaMul = t <= 1 ? 0.5 : 1;
        for (const g of graphics) g.setAlpha(0.55 * alphaMul);
      },
    };
  }

  private createMineVisual(mine: Mine): { destroy: () => void; setShake: (on: boolean) => void } {
    const ts = this.tileSize;
    const cx = mine.x * ts + ts / 2;
    const cy = mine.y * ts + ts / 2;
    const g = this.scene.add.graphics();
    g.setPosition(cx, cy);
    this.layer.add(g);

    let pulseTween: Phaser.Tweens.Tween | null = null;
    if (mine.kind === 'motion_detector') {
      // Orange star shape — like a shrunken flare icon.
      g.lineStyle(1, 0xff7733, 1);
      g.fillStyle(0xff9944, 1);
      g.fillCircle(0, 0, ts * 0.25);
      g.strokeCircle(0, 0, ts * 0.25);
      // pulse
      pulseTween = this.scene.tweens.add({
        targets: g,
        alpha: 0.5,
        duration: 700,
        yoyo: true,
        repeat: -1,
      });
    } else {
      // Cluster mine — small dark dot with a red pip.
      g.fillStyle(0x221111, 1);
      g.fillCircle(0, 0, ts * 0.18);
      g.fillStyle(0xaa2200, 1);
      g.fillCircle(0, 0, ts * 0.08);
    }

    let shakeTween: Phaser.Tweens.Tween | null = null;
    const setShake = (on: boolean): void => {
      if (on && !shakeTween) {
        shakeTween = this.scene.tweens.add({
          targets: g,
          x: { from: cx - 2, to: cx + 2 },
          duration: 70,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      } else if (!on && shakeTween) {
        shakeTween.stop();
        shakeTween = null;
        g.setPosition(cx, cy);
      }
    };

    return {
      destroy: () => {
        pulseTween?.stop();
        shakeTween?.stop();
        g.destroy();
      },
      setShake,
    };
  }

  destroy(): void {
    for (const v of this.bombVisuals.values()) v.destroy();
    for (const v of this.fireVisuals.values()) v.destroy();
    for (const v of this.flareVisuals.values()) v.destroy();
    for (const v of this.smokeVisuals.values()) v.destroy();
    for (const v of this.mineVisuals.values()) v.destroy();
    for (const t of this.pendingMineTimers.values()) t.remove(false);
    for (const d of this.decals.values()) d.destroy();
    this.bombVisuals.clear();
    this.fireVisuals.clear();
    this.flareVisuals.clear();
    this.smokeVisuals.clear();
    this.mineVisuals.clear();
    this.pendingMineTimers.clear();
    this.decals.clear();
  }

  // ---- visual builders ----

  private createBomb(bomb: BombInstance): BombVisual {
    const ts = this.tileSize;
    const cx = bomb.x * ts + ts / 2;
    const cy = bomb.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    g.setPosition(cx, cy);
    g.setAlpha(0);
    this.layer.add(g);

    const cfg = bombLook(bomb.type);
    drawBombBody(g, cfg, ts);

    // (Hourglass / clock countdown indicator removed — the pre-detonation
    // shake tween is the sole "about to explode" cue now.)

    const fadeIn = this.scene.tweens.add({
      targets: g,
      alpha: 1,
      duration: 200,
      delay: 550,
    });

    const tween = this.scene.tweens.add({
      targets: g,
      scale: { from: 0.85, to: 1.05 },
      duration: 380,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    let shakeTween: Phaser.Tweens.Tween | null = null;
    const setShake = (on: boolean): void => {
      if (on && !shakeTween) {
        // Small x-axis jitter relative to the bomb's center position.
        shakeTween = this.scene.tweens.add({
          targets: g,
          x: { from: cx - 2, to: cx + 2 },
          duration: 70,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      } else if (!on && shakeTween) {
        shakeTween.stop();
        shakeTween = null;
        g.setPosition(cx, cy);
      }
    };

    const setSmokeMode = (on: boolean): void => {
      // Raise bomb graphics above fog (fog is at depth 50) when the local
      // player is inside a smoke cloud, so bombs stand out clearly at 0.95
      // alpha.
      const depth = on ? 75 : 0; // 0 = inherit from container
      const alpha = on ? 0.95 : 1;
      g.setDepth(depth);
      g.setAlpha(alpha);
    };

    return {
      destroy: () => {
        fadeIn.stop();
        tween.stop();
        shakeTween?.stop();
        g.destroy();
      },
      updateFuse: () => {
        // no-op — shake is toggled from syncBombs
      },
      setShake,
      setSmokeMode,
    };
  }

  private createFire(x: number, y: number, kind: 'molotov' | 'phosphorus' = 'molotov'): FireVisual {
    const ts = this.tileSize;
    const g = this.scene.add.graphics();
    g.setPosition(x * ts + ts / 2, y * ts + ts / 2);
    this.layer.add(g);

    // Phosphorus: whiter palette (bright white-yellow core, pale outer).
    // Molotov: traditional orange palette.
    const palette = kind === 'phosphorus'
      ? { outer: 0xffeecc, mid: 0xffffdd, core: 0xffffff }
      : { outer: 0xff6633, mid: 0xff9944, core: 0xffdd44 };

    const draw = (phase: number): void => {
      g.clear();
      // Wobbling flame: 3 layered circles in the palette
      g.fillStyle(palette.outer, 0.8);
      g.fillCircle(0, 0, ts * (0.42 + 0.05 * Math.sin(phase)));
      g.fillStyle(palette.mid, 0.9);
      g.fillCircle(0, -2, ts * (0.32 + 0.05 * Math.sin(phase + 1)));
      g.fillStyle(palette.core, 1);
      g.fillCircle(0, -4, ts * (0.18 + 0.04 * Math.sin(phase + 2)));
    };

    let phase = 0;
    draw(phase);
    const tween = this.scene.tweens.addCounter({
      from: 0, to: Math.PI * 2,
      duration: 700,
      repeat: -1,
      onUpdate: (tween) => { phase = tween.getValue() ?? 0; draw(phase); },
    });

    return {
      destroy: () => { tween.stop(); g.destroy(); },
    };
  }

  /**
   * A small harmless-looking flame on the tile where the flare landed.
   * Starts bright, gets dimmer each turn. Visible from anywhere on the map
   * (even through fog).
   */
  private createFlareFlame(
    x: number,
    y: number,
    turnsRemaining: number,
    kind: 'flare' | 'phosphorus' | 'motion_detector' = 'flare',
  ): FlareVisual {
    const ts = this.tileSize;
    const cx = x * ts + ts / 2;
    const cy = y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    let currentTurns = turnsRemaining;

    // Color palette per flare kind.
    const palette = kind === 'phosphorus'
      ? { glow: 0xff3322, outer: 0xaa2200, mid: 0xcc3322, inner: 0xff7755 }
      : kind === 'motion_detector'
        ? { glow: 0xffaa44, outer: 0xff7722, mid: 0xff9933, inner: 0xffbb66 }
        : { glow: 0xffcc44, outer: 0xff6622, mid: 0xffaa33, inner: 0xffee66 };

    const drawFlame = (phase: number): void => {
      g.clear();
      // Intensity scales with turns remaining: 3=bright, 2=medium, 1=dim
      const intensity = currentTurns / 3;
      const flameH = ts * (0.3 + 0.15 * intensity);
      const flameW = ts * (0.15 + 0.1 * intensity);
      const wobble = Math.sin(phase) * ts * 0.03;

      // Outer glow
      g.fillStyle(palette.glow, 0.15 * intensity);
      g.fillCircle(cx + wobble, cy - flameH * 0.3, ts * (0.3 + 0.1 * intensity));

      // Flame body
      g.fillStyle(palette.outer, 0.7 * intensity);
      g.fillEllipse(cx + wobble, cy, flameW, flameH);
      g.fillStyle(palette.mid, 0.85 * intensity);
      g.fillEllipse(cx + wobble, cy - flameH * 0.1, flameW * 0.7, flameH * 0.7);
      g.fillStyle(palette.inner, 0.9 * intensity);
      g.fillEllipse(cx + wobble, cy - flameH * 0.15, flameW * 0.4, flameH * 0.4);
    };

    let phase = 0;
    drawFlame(0);
    const tween = this.scene.tweens.addCounter({
      from: 0, to: Math.PI * 2,
      duration: 600,
      repeat: -1,
      onUpdate: (tw) => { phase = tw.getValue() ?? 0; drawFlame(phase); },
    });

    // Turn indicator dots below the flame
    const dots = this.scene.add.text(cx, cy + ts * 0.35, '\u25CF'.repeat(turnsRemaining), {
      fontSize: '5px', color: '#ffcc44', fontFamily: 'monospace',
    }).setOrigin(0.5, 0).setAlpha(0.6);
    this.layer.add(dots);

    return {
      destroy: () => { tween.stop(); g.destroy(); dots.destroy(); },
      updateTurns: (remaining: number) => {
        currentTurns = remaining;
        dots.setText('\u25CF'.repeat(remaining));
      },
    };
  }
}

// ---- per-bomb look ----

interface BombLook {
  /** Main body fill color. */
  body: number;
  /** Outline color. */
  stroke: number;
  /** Accent color (fuse spark, stripe, etc.). */
  accent: number;
  /** Single-letter glyph drawn on top. */
  glyph: string;
  /** Body shape. */
  shape: 'circle' | 'diamond' | 'curve' | 'star' | 'bottle' | 'rock';
}

function bombLook(type: BombType): BombLook {
  switch (type) {
    case 'rock':          return { body: 0x776655, stroke: 0x332211, accent: 0xaa9988, glyph: 'R', shape: 'rock' };
    case 'bomb':          return { body: 0x111122, stroke: 0xffaa44, accent: 0xff8844, glyph: 'B', shape: 'circle' };
    case 'bomb_wide':     return { body: 0x222244, stroke: 0xddaa44, accent: 0xffbb44, glyph: 'W', shape: 'circle' };
    case 'delay_tricky':  return { body: 0x2a1144, stroke: 0xcc88ff, accent: 0xff44cc, glyph: 'T', shape: 'diamond' };
    case 'contact':       return { body: 0x441111, stroke: 0xff4444, accent: 0xffcc44, glyph: 'C', shape: 'circle' };
    case 'banana':        return { body: 0xffcc33, stroke: 0x886611, accent: 0xaa8822, glyph: 'N', shape: 'curve' };
    case 'banana_child':  return { body: 0xffee55, stroke: 0xaa8822, accent: 0xffcc33, glyph: 'n', shape: 'circle' };
    case 'flare':         return { body: 0xffffcc, stroke: 0xffaa33, accent: 0xffffff, glyph: 'F', shape: 'star' };
    case 'molotov':       return { body: 0x225522, stroke: 0x88cc44, accent: 0xff6633, glyph: 'M', shape: 'bottle' };
    case 'ender_pearl':   return { body: 0x114433, stroke: 0x44ddaa, accent: 0x66ffcc, glyph: 'E', shape: 'circle' };
    // New bombs — temp looks, recolor/shape variants.
    case 'fart_escape':          return { body: 0x444422, stroke: 0x99aa55, accent: 0xccffaa, glyph: 'F', shape: 'circle' };
    case 'motion_detector_flare': return { body: 0x552200, stroke: 0xff8833, accent: 0xffaa55, glyph: 'M', shape: 'star' };
    case 'flash':         return { body: 0x112244, stroke: 0x88ccff, accent: 0xaaddff, glyph: 'S', shape: 'diamond' };
    case 'phosphorus':    return { body: 0x442211, stroke: 0xff7755, accent: 0xffffee, glyph: 'P', shape: 'bottle' };
    case 'cluster_bomb':  return { body: 0x221122, stroke: 0x887799, accent: 0xffcc44, glyph: 'K', shape: 'circle' };
    case 'big_huge':      return { body: 0x110011, stroke: 0xffaa44, accent: 0xff6622, glyph: 'H', shape: 'circle' };
  }
}

function drawBombBody(g: Phaser.GameObjects.Graphics, look: BombLook, ts: number): void {
  const r = ts * 0.32;
  g.lineStyle(2, look.stroke, 1);
  g.fillStyle(look.body, 1);

  switch (look.shape) {
    case 'rock':
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
      // fake highlight
      g.fillStyle(look.accent, 0.5);
      g.fillCircle(-r * 0.3, -r * 0.3, r * 0.25);
      break;

    case 'circle':
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
      // fuse stub
      g.lineStyle(2, look.accent, 1);
      g.beginPath();
      g.moveTo(r * 0.5, -r * 0.85);
      g.lineTo(r * 0.85, -r * 1.3);
      g.strokePath();
      g.fillStyle(look.accent, 1);
      g.fillCircle(r * 0.85, -r * 1.3, 2.5);
      break;

    case 'diamond':
      g.beginPath();
      g.moveTo(0, -r);
      g.lineTo(r, 0);
      g.lineTo(0, r);
      g.lineTo(-r, 0);
      g.closePath();
      g.fillPath();
      g.strokePath();
      break;

    case 'curve': {
      // Banana — crescent
      const inner = r * 0.6;
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
      g.fillStyle(0x1a1a2e, 1);
      g.fillCircle(r * 0.35, -r * 0.35, inner);
      break;
    }

    case 'star': {
      // 5-point star
      const spikes = 5;
      const outer = r;
      const innerR = r * 0.45;
      g.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const radius = i % 2 === 0 ? outer : innerR;
        const angle = (Math.PI / spikes) * i - Math.PI / 2;
        const px = Math.cos(angle) * radius;
        const py = Math.sin(angle) * radius;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillPath();
      g.strokePath();
      break;
    }

    case 'bottle': {
      // Molotov — a bottle with liquid
      g.fillRect(-r * 0.5, -r * 0.2, r, r * 1.1);
      g.strokeRect(-r * 0.5, -r * 0.2, r, r * 1.1);
      g.fillRect(-r * 0.25, -r * 0.6, r * 0.5, r * 0.4);
      g.strokeRect(-r * 0.25, -r * 0.6, r * 0.5, r * 0.4);
      g.fillStyle(look.accent, 1);
      g.fillRect(-r * 0.4, 0, r * 0.8, r * 0.7);
      break;
    }
  }

  // Glyph overlay
  // (text requires a scene to create; skipped here — the shape/color is enough)
}

interface BombVisual {
  destroy: () => void;
  updateFuse?: (remaining: number) => void;
  setShake?: (on: boolean) => void;
  setSmokeMode?: (on: boolean) => void;
}
interface FireVisual { destroy: () => void }
interface FlareVisual { destroy: () => void; updateTurns?: (remaining: number) => void }
