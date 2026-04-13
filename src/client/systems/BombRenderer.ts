import Phaser from 'phaser';
import type { BombInstance, BombType, FireTile } from '@shared/types/bombs.ts';
import type { ActiveFlare } from '@shared/types/match.ts';
import type { Tile } from '@shared/systems/BombResolver.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { bombIconFrame } from './BombIcons.ts';

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
   * Layer for persistent scorch marks left by explosions. Sits above fog
   * (visible to all players even through fog of war) but below entities
   * (Bombermen stand on top of decals).
   */
  private decalLayer: Phaser.GameObjects.Container;
  private tileSize: number;
  private bombVisuals = new Map<string, BombVisual>();
  private fireVisuals = new Map<string, FireVisual>();
  private flareVisuals = new Map<string, FlareVisual>();
  /**
   * One decal per tile max — "they don't stack on top of each other".
   * First explosion on a tile wins; subsequent explosions skip it.
   */
  private decals = new Map<string, Phaser.GameObjects.Graphics>();

  constructor(
    scene: Phaser.Scene,
    layer: Phaser.GameObjects.Container,
    explosionLayer: Phaser.GameObjects.Container,
    decalLayer: Phaser.GameObjects.Container,
    tileSize: number,
  ) {
    this.scene = scene;
    this.layer = layer;
    this.explosionLayer = explosionLayer;
    this.decalLayer = decalLayer;
    this.tileSize = tileSize;
  }

  syncBombs(bombs: BombInstance[]): void {
    const seen = new Set<string>();
    for (const b of bombs) {
      seen.add(b.id);
      if (!this.bombVisuals.has(b.id)) {
        this.bombVisuals.set(b.id, this.createBomb(b));
      } else {
        // Update the fuse countdown on existing visuals
        this.bombVisuals.get(b.id)!.updateFuse?.(b.fuseRemaining);
      }
    }
    for (const [id, vis] of this.bombVisuals) {
      if (!seen.has(id)) {
        vis.destroy();
        this.bombVisuals.delete(id);
      }
    }
  }

  syncFire(tiles: FireTile[]): void {
    const seen = new Set<string>();
    for (const f of tiles) {
      const key = `${f.x},${f.y}`;
      seen.add(key);
      if (!this.fireVisuals.has(key)) {
        this.fireVisuals.set(key, this.createFire(f.x, f.y));
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
        this.flareVisuals.set(f.id, this.createFlareFlame(f.x, f.y, f.turnsRemaining));
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
   */
  spawnThrowArc(type: BombType, fromX: number, fromY: number, toX: number, toY: number): { duration: number } {
    const ts = this.tileSize;
    const sx = fromX * ts + ts / 2;
    const sy = fromY * ts + ts / 2;
    const ex = toX * ts + ts / 2;
    const ey = toY * ts + ts / 2;

    const img = this.scene.add.image(sx, sy, 'bomb_icons', bombIconFrame(type));
    img.setDisplaySize(ts * 0.9, ts * 0.9);
    this.layer.add(img);

    const duration = (BALANCE.match.transitionPhaseSeconds * 1000) / 2;

    this.scene.tweens.add({
      targets: img,
      x: ex,
      y: ey,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        img.setRotation(img.rotation + 0.15);
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
  ): void {
    const dur = Math.max(100, durationMs);
    const startAnim = (): void => {
      // Banana's "explosion" is just a splat at its own tile — the four
      // scattered contact bombs spawn their own explosions when they trigger.
      if (type === 'banana') {
        this.bananaSplat(centerX, centerY, dur);
        return;
      }

      for (const tile of tiles) {
        switch (type) {
          case 'rock': this.rockDust(tile, dur); break;
          case 'delay': this.fireBoom(tile, { core: 0xffffaa, mid: 0xffaa33, outer: 0xff5511, maxRadius: 0.55, duration: dur, emberCount: 5 }); break;
          case 'delay_big': this.fireBoom(tile, { core: 0xffffaa, mid: 0xff8822, outer: 0xcc2200, maxRadius: 0.7, duration: dur, emberCount: 7 }); break;
          case 'delay_wide': this.fireBoom(tile, { core: 0xffffcc, mid: 0xffbb44, outer: 0xee6622, maxRadius: 0.6, duration: dur, emberCount: 5 }); break;
          case 'contact': this.fireBoom(tile, { core: 0xffeeaa, mid: 0xff6633, outer: 0xaa0000, maxRadius: 0.5, duration: dur, emberCount: 4 }); break;
          case 'banana_child': this.fireBoom(tile, { core: 0xffee44, mid: 0xffcc22, outer: 0xaa8811, maxRadius: 0.5, duration: dur, emberCount: 4 }); break;
          case 'delay_tricky': this.plasmaBurst(tile, dur); break;
          case 'flare': this.flareFlash(tile, dur); break;
          case 'molotov': this.fireSplash(tile, dur); break;
        }
      }
    };

    const stampAllDecals = (): void => {
      // Flare doesn't leave a decal — it's light, not an explosion.
      if (type === 'flare') return;
      if (type === 'banana') return; // banana itself doesn't scorch; its children do
      if (type === 'ender_pearl') return; // teleport decal handled separately
      for (const tile of tiles) this.stampDecal(type, tile);
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
   * decal already exists on this tile, skip. The decal lives in decalLayer
   * (above fog, below entities) so everyone sees it regardless of LOS.
   */
  private stampDecal(type: BombType, tile: Tile): void {
    const key = `${tile.x},${tile.y}`;
    if (this.decals.has(key)) return;

    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;
    const g = this.scene.add.graphics();
    this.decalLayer.add(g);

    switch (type) {
      case 'rock':
        this.drawDustDecal(g, cx, cy, ts);
        break;
      case 'delay':
      case 'delay_big':
      case 'delay_wide':
      case 'contact':
      case 'banana_child':
        this.drawScorchDecal(g, cx, cy, ts);
        break;
      case 'delay_tricky':
        this.drawPlasmaDecal(g, cx, cy, ts);
        break;
      case 'molotov':
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
   *   if false, renders on decalLayer (hidden by fog). FROM puff uses true,
   *   TO puff uses false.
   */
  spawnTeleportPuff(tileX: number, tileY: number, durationMs: number, aboveFog = false): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;

    const g = this.scene.add.graphics();
    (aboveFog ? this.explosionLayer : this.decalLayer).add(g);
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
    const particleLayer = aboveFog ? this.explosionLayer : this.decalLayer;
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
  stampTeleportDecal(tileX: number, tileY: number): void {
    const key = `${tileX},${tileY}`;
    if (this.decals.has(key)) return;
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const g = this.scene.add.graphics();
    this.decalLayer.add(g);
    // Teal outer ring
    g.fillStyle(0x115544, 0.6);
    g.fillCircle(cx, cy, ts * 0.35);
    // Brighter inner spot
    g.fillStyle(0x227766, 0.7);
    g.fillCircle(cx, cy, ts * 0.2);
    // Bright center dot
    g.fillStyle(0x33aa88, 0.5);
    g.fillCircle(cx, cy, ts * 0.08);
    // Render on top of other decals within the container
    g.setDepth(1);
    this.decals.set(key, g);
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

  destroy(): void {
    for (const v of this.bombVisuals.values()) v.destroy();
    for (const v of this.fireVisuals.values()) v.destroy();
    for (const v of this.flareVisuals.values()) v.destroy();
    for (const d of this.decals.values()) d.destroy();
    this.bombVisuals.clear();
    this.fireVisuals.clear();
    this.flareVisuals.clear();
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

    // Clock circle indicator — sweeps like an hourglass over the transition phase.
    // For multi-turn fuses, an outer ring shows total turns remaining.
    let clockGraphics: Phaser.GameObjects.Graphics | null = null;
    let clockTween: Phaser.Tweens.Tween | null = null;
    const clockRadius = ts * 0.45;
    if (bomb.fuseRemaining > 0) {
      clockGraphics = this.scene.add.graphics();
      clockGraphics.setPosition(cx, cy);
      clockGraphics.setAlpha(0);
      this.layer.add(clockGraphics);

      // Outer ring for multi-turn indicator
      if (bomb.fuseRemaining > 1) {
        clockGraphics.lineStyle(2, 0xffffff, 0.3);
        clockGraphics.strokeCircle(0, 0, clockRadius + 3);
      }

      // Animated sweep: full circle → empty over the transition phase
      const counter = { t: 0 };
      clockTween = this.scene.tweens.add({
        targets: counter,
        t: 1,
        duration: BALANCE.match.transitionPhaseSeconds * 1000,
        repeat: bomb.fuseRemaining - 1,
        onUpdate: () => {
          clockGraphics!.clear();
          // Outer ring redraw for multi-turn
          if (bomb.fuseRemaining > 1) {
            clockGraphics!.lineStyle(2, 0xffffff, 0.3);
            clockGraphics!.strokeCircle(0, 0, clockRadius + 3);
          }
          // Sweeping arc: starts full, empties clockwise
          const endAngle = -Math.PI / 2 + (1 - counter.t) * Math.PI * 2;
          clockGraphics!.lineStyle(2, 0xffffff, 0.7);
          clockGraphics!.beginPath();
          clockGraphics!.arc(0, 0, clockRadius, -Math.PI / 2, endAngle, true);
          clockGraphics!.strokePath();
        },
      });
    }

    const fadeIn = this.scene.tweens.add({
      targets: [g, clockGraphics].filter(Boolean),
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

    return {
      destroy: () => {
        fadeIn.stop();
        tween.stop();
        clockTween?.stop();
        g.destroy();
        clockGraphics?.destroy();
      },
      updateFuse: () => {
        // Clock handles the visual countdown automatically via the tween
      },
    };
  }

  private createFire(x: number, y: number): FireVisual {
    const ts = this.tileSize;
    const g = this.scene.add.graphics();
    g.setPosition(x * ts + ts / 2, y * ts + ts / 2);
    this.layer.add(g);

    const draw = (phase: number): void => {
      g.clear();
      // Wobbling flame: 3 layered circles in orange/yellow
      g.fillStyle(0xff6633, 0.8);
      g.fillCircle(0, 0, ts * (0.42 + 0.05 * Math.sin(phase)));
      g.fillStyle(0xff9944, 0.9);
      g.fillCircle(0, -2, ts * (0.32 + 0.05 * Math.sin(phase + 1)));
      g.fillStyle(0xffdd44, 1);
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
  private createFlareFlame(x: number, y: number, turnsRemaining: number): FlareVisual {
    const ts = this.tileSize;
    const cx = x * ts + ts / 2;
    const cy = y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    let currentTurns = turnsRemaining;

    const drawFlame = (phase: number): void => {
      g.clear();
      // Intensity scales with turns remaining: 3=bright, 2=medium, 1=dim
      const intensity = currentTurns / 3;
      const flameH = ts * (0.3 + 0.15 * intensity);
      const flameW = ts * (0.15 + 0.1 * intensity);
      const wobble = Math.sin(phase) * ts * 0.03;

      // Outer glow
      g.fillStyle(0xffcc44, 0.15 * intensity);
      g.fillCircle(cx + wobble, cy - flameH * 0.3, ts * (0.3 + 0.1 * intensity));

      // Flame body (yellow → orange → red from bottom to top)
      g.fillStyle(0xff6622, 0.7 * intensity);
      g.fillEllipse(cx + wobble, cy, flameW, flameH);
      g.fillStyle(0xffaa33, 0.85 * intensity);
      g.fillEllipse(cx + wobble, cy - flameH * 0.1, flameW * 0.7, flameH * 0.7);
      g.fillStyle(0xffee66, 0.9 * intensity);
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
    case 'delay':         return { body: 0x222233, stroke: 0x88aaff, accent: 0xff8844, glyph: 'D', shape: 'circle' };
    case 'delay_big':     return { body: 0x111122, stroke: 0xffaa44, accent: 0xff8844, glyph: 'B', shape: 'circle' };
    case 'delay_tricky':  return { body: 0x2a1144, stroke: 0xcc88ff, accent: 0xff44cc, glyph: 'T', shape: 'diamond' };
    case 'contact':       return { body: 0x441111, stroke: 0xff4444, accent: 0xffcc44, glyph: 'C', shape: 'circle' };
    case 'banana':        return { body: 0xffcc33, stroke: 0x886611, accent: 0xaa8822, glyph: 'N', shape: 'curve' };
    case 'banana_child':  return { body: 0xffee55, stroke: 0xaa8822, accent: 0xffcc33, glyph: 'n', shape: 'circle' };
    case 'flare':         return { body: 0xffffcc, stroke: 0xffaa33, accent: 0xffffff, glyph: 'F', shape: 'star' };
    case 'molotov':       return { body: 0x225522, stroke: 0x88cc44, accent: 0xff6633, glyph: 'M', shape: 'bottle' };
    case 'delay_wide':    return { body: 0x222244, stroke: 0xddaa44, accent: 0xffbb44, glyph: 'W', shape: 'circle' };
    case 'ender_pearl':   return { body: 0x114433, stroke: 0x44ddaa, accent: 0x66ffcc, glyph: 'E', shape: 'circle' };
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

interface BombVisual { destroy: () => void; updateFuse?: (remaining: number) => void }
interface FireVisual { destroy: () => void }
interface FlareVisual { destroy: () => void; updateTurns?: (remaining: number) => void }
