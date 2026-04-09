import Phaser from 'phaser';
import type { BombInstance, BombType, FireTile, LightTile } from '@shared/types/bombs.ts';
import type { Tile } from '@shared/systems/BombResolver.ts';

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
  private layer: Phaser.GameObjects.Container;
  private tileSize: number;
  private bombVisuals = new Map<string, BombVisual>();
  private fireVisuals = new Map<string, FireVisual>();
  private lightVisuals = new Map<string, LightVisual>();

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Container, tileSize: number) {
    this.scene = scene;
    this.layer = layer;
    this.tileSize = tileSize;
  }

  syncBombs(bombs: BombInstance[]): void {
    const seen = new Set<string>();
    for (const b of bombs) {
      seen.add(b.id);
      if (!this.bombVisuals.has(b.id)) {
        this.bombVisuals.set(b.id, this.createBomb(b));
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

  syncLight(tiles: LightTile[]): void {
    const seen = new Set<string>();
    for (const l of tiles) {
      const key = `${l.x},${l.y}`;
      seen.add(key);
      if (!this.lightVisuals.has(key)) {
        this.lightVisuals.set(key, this.createLight(l.x, l.y));
      }
    }
    for (const [key, vis] of this.lightVisuals) {
      if (!seen.has(key)) {
        vis.destroy();
        this.lightVisuals.delete(key);
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
  spawnThrowArc(type: BombType, fromX: number, fromY: number, toX: number, toY: number): { duration: number } {
    const ts = this.tileSize;
    const sx = fromX * ts + ts / 2;
    const sy = fromY * ts + ts / 2;
    const ex = toX * ts + ts / 2;
    const ey = toY * ts + ts / 2;

    const g = this.scene.add.graphics();
    drawBombBody(g, bombLook(type), ts);
    g.setPosition(sx, sy);
    g.setScale(0.7);
    this.layer.add(g);

    // Trailing streak
    const streak = this.scene.add.graphics();
    streak.setDepth(g.depth);
    this.layer.add(streak);

    const dist = Math.hypot(ex - sx, ey - sy);
    const duration = Math.min(650, 250 + dist * 0.8);
    const peakHeight = Math.min(90, Math.max(30, dist * 0.55));

    const counter = { t: 0 };
    const prev = { x: sx, y: sy };
    const trail: Array<{ x: number; y: number; life: number }> = [];

    this.scene.tweens.add({
      targets: counter,
      t: 1,
      duration,
      ease: 'Sine.easeOut',
      onUpdate: () => {
        const t = counter.t;
        const x = sx + (ex - sx) * t;
        const baseY = sy + (ey - sy) * t;
        const arc = -Math.sin(t * Math.PI) * peakHeight;
        const py = baseY + arc;
        g.setPosition(x, py);
        g.setRotation(t * Math.PI * 4);
        g.setScale(0.7 + Math.sin(t * Math.PI) * 0.3);

        // Record trail points
        trail.push({ x, y: py, life: 1 });
        if (trail.length > 8) trail.shift();
        // Decay
        streak.clear();
        for (let i = 0; i < trail.length; i++) {
          const p = trail[i];
          const alpha = (i / trail.length) * 0.6;
          streak.fillStyle(0xffcc44, alpha);
          streak.fillCircle(p.x, p.y, 3 + (i / trail.length) * 2);
        }

        prev.x = x; prev.y = py;
      },
      onComplete: () => {
        // Landing poof
        const poof = this.scene.add.graphics();
        this.layer.add(poof);
        this.scene.tweens.add({
          targets: poof,
          duration: 200,
          onUpdate: (tw) => {
            poof.clear();
            const t = tw.progress;
            poof.fillStyle(0xffeeaa, (1 - t) * 0.7);
            poof.fillCircle(ex, ey, ts * (0.1 + 0.25 * t));
          },
          onComplete: () => poof.destroy(),
        });
        g.destroy();
        streak.destroy();
      },
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
  spawnExplosion(type: BombType, centerX: number, centerY: number, tiles: Tile[]): void {
    // Banana's "explosion" is just a splat at its own tile — the four
    // scattered contact bombs spawn their own explosions when they trigger.
    if (type === 'banana') {
      this.bananaSplat(centerX, centerY);
      return;
    }

    for (const tile of tiles) {
      switch (type) {
        case 'rock': this.rockDust(tile); break;
        case 'delay': this.fireBoom(tile, { core: 0xffffaa, mid: 0xffaa33, outer: 0xff5511, maxRadius: 0.55, duration: 500, emberCount: 5 }); break;
        case 'delay_big': this.fireBoom(tile, { core: 0xffffaa, mid: 0xff8822, outer: 0xcc2200, maxRadius: 0.7, duration: 600, emberCount: 7 }); break;
        case 'contact': this.fireBoom(tile, { core: 0xffeeaa, mid: 0xff6633, outer: 0xaa0000, maxRadius: 0.5, duration: 400, emberCount: 4 }); break;
        case 'banana_child': this.fireBoom(tile, { core: 0xffee44, mid: 0xffcc22, outer: 0xaa8811, maxRadius: 0.5, duration: 450, emberCount: 4 }); break;
        case 'delay_tricky': this.plasmaBurst(tile); break;
        case 'flare': this.flareFlash(tile); break;
        case 'molotov': this.fireSplash(tile); break;
      }
    }
  }

  /**
   * Death animation — a toppling, red-tinted silhouette that rotates and
   * fades out over ~800ms. Used when a `died` turn event fires.
   * We don't need the full Bomberman colors — the fade is fast and the
   * red tint overrides the clothing colors anyway.
   */
  spawnDeathAnimation(tileX: number, tileY: number): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;

    // Red flash rectangle covering the tile
    const flash = this.scene.add.graphics();
    this.layer.add(flash);
    flash.fillStyle(0xff0000, 0.55);
    flash.fillRect(tileX * ts, tileY * ts, ts, ts);
    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 700,
      ease: 'Cubic.easeOut',
      onComplete: () => flash.destroy(),
    });

    // Toppling silhouette — simple red body/head shape that rotates 90° and fades
    const body = this.scene.add.graphics();
    body.setPosition(cx, cy + ts * 0.1);
    this.layer.add(body);
    const bodyW = ts * 0.5;
    const bodyH = ts * 0.55;
    body.fillStyle(0xcc1111, 1);
    body.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    body.lineStyle(2, 0x660000, 1);
    body.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    body.fillStyle(0xff4444, 1);
    body.fillCircle(0, -bodyH / 2 - ts * 0.15, ts * 0.17);
    body.lineStyle(2, 0x660000, 1);
    body.strokeCircle(0, -bodyH / 2 - ts * 0.15, ts * 0.17);

    this.scene.tweens.add({
      targets: body,
      angle: 90,
      y: cy + ts * 0.3,
      alpha: 0.1,
      duration: 800,
      ease: 'Cubic.easeIn',
      onComplete: () => body.destroy(),
    });

    // Blood splash particles
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

  private rockDust(tile: Tile): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: 300,
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
      this.layer.add(dot);
      dot.fillStyle(0x998877, 0.8);
      dot.fillCircle(0, 0, 1.5);
      dot.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * ts * 0.4,
        y: cy + Math.sin(angle) * ts * 0.4,
        alpha: 0,
        duration: 300,
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
    this.layer.add(g);
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
      this.layer.add(ember);
      ember.fillStyle(opts.core, 1);
      ember.fillCircle(0, 0, 1.5 + Math.random() * 1.5);
      ember.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: ember,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: opts.duration * 1.3,
        ease: 'Cubic.easeOut',
        onComplete: () => ember.destroy(),
      });
    }
  }

  private plasmaBurst(tile: Tile): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: 480,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        // Core purple orb
        g.fillStyle(0xff66ff, (1 - t) * 0.9);
        g.fillCircle(cx, cy, ts * (0.18 + 0.18 * t));
        // Magenta halo
        g.lineStyle(3, 0xcc33cc, (1 - t) * 0.85);
        g.strokeCircle(cx, cy, ts * (0.25 + 0.4 * t));
        // Radial lightning spikes (4 diagonals)
        g.lineStyle(2, 0xffccff, (1 - t) * 0.9);
        const reach = ts * (0.3 + 0.35 * t);
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
  }

  private bananaSplat(centerX: number, centerY: number): void {
    const ts = this.tileSize;
    const cx = centerX * ts + ts / 2;
    const cy = centerY * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: 350,
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

  private flareFlash(tile: Tile): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: 450,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        g.fillStyle(0xffffff, (1 - t) * 0.85);
        g.fillCircle(cx, cy, ts * (0.25 + 0.35 * t));
        g.fillStyle(0xffffcc, (1 - t) * 0.6);
        g.fillCircle(cx, cy, ts * (0.4 + 0.3 * t));
      },
      onComplete: () => g.destroy(),
    });
  }

  private fireSplash(tile: Tile): void {
    const ts = this.tileSize;
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    this.layer.add(g);
    this.scene.tweens.add({
      targets: g,
      duration: 500,
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
      this.layer.add(ember);
      ember.fillStyle(0xff9944, 1);
      ember.fillCircle(0, 0, 2);
      ember.setPosition(cx, cy);
      this.scene.tweens.add({
        targets: ember,
        x: cx + Math.cos(angle) * ts * 0.5,
        y: cy + Math.sin(angle) * ts * 0.5,
        alpha: 0,
        duration: 600,
        ease: 'Cubic.easeOut',
        onComplete: () => ember.destroy(),
      });
    }
  }

  destroy(): void {
    for (const v of this.bombVisuals.values()) v.destroy();
    for (const v of this.fireVisuals.values()) v.destroy();
    for (const v of this.lightVisuals.values()) v.destroy();
    this.bombVisuals.clear();
    this.fireVisuals.clear();
    this.lightVisuals.clear();
  }

  // ---- visual builders ----

  private createBomb(bomb: BombInstance): BombVisual {
    const ts = this.tileSize;
    const cx = bomb.x * ts + ts / 2;
    const cy = bomb.y * ts + ts / 2;

    const g = this.scene.add.graphics();
    g.setPosition(cx, cy);
    g.setAlpha(0); // fade in after the arc lands
    this.layer.add(g);

    const cfg = bombLook(bomb.type);
    drawBombBody(g, cfg, ts);

    // Fade in (delayed so throw arc can finish before the persistent
    // visual appears at the target tile)
    const fadeIn = this.scene.tweens.add({
      targets: g,
      alpha: 1,
      duration: 200,
      delay: 550,
    });

    // Pulse tween on scale so any bomb shape breathes while ticking down
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
        g.destroy();
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

  private createLight(x: number, y: number): LightVisual {
    const ts = this.tileSize;
    const g = this.scene.add.graphics();
    g.setPosition(x * ts + ts / 2, y * ts + ts / 2);
    this.layer.add(g);

    g.fillStyle(0xfff5aa, 0.18);
    g.fillRect(-ts / 2, -ts / 2, ts, ts);
    g.fillStyle(0xffffee, 0.28);
    g.fillCircle(0, 0, ts * 0.35);

    const tween = this.scene.tweens.add({
      targets: g,
      alpha: { from: 0.75, to: 1 },
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    return {
      destroy: () => { tween.stop(); g.destroy(); },
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

interface BombVisual { destroy: () => void }
interface FireVisual { destroy: () => void }
interface LightVisual { destroy: () => void }
