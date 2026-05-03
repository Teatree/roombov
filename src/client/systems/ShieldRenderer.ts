/**
 * Shield Wall renderer.
 *
 * Renders the Shield Bomb's + wall and its persistent shattered-shard
 * decals. The wall sprite is the bomb icon (frame 3 in `bombs.png`) tiled
 * once per occupied tile.
 *
 * Visual lifecycle for one wall:
 *   1. spawnWall(walId, tiles) — slam-in animation per tile (scale 0→1
 *      with brief downward translate, ~200ms)
 *   2. shakeWall(wallId)        — subtle wobble on the LAST turn before
 *      shatter (driven by turnsRemaining===1 sync)
 *   3. breakWall(wallId)        — fade out + spawn ShieldShard decals
 *
 * Push vfx (Bomberman or bomb displaced by a wall): a yellow variant of
 * the Ender Pearl teleport puff + a light-gray decal at the destination.
 *
 * Fog gating is delegated to the caller via `isVisible(x, y)` — we only
 * toggle sprite.setVisible() based on that callback. Decal shards are
 * "always visible once revealed" per spec, so the caller maintains a
 * `revealedShards` set independently.
 */

import Phaser from 'phaser';
import type { ShieldWall, ShieldShard } from '@shared/types/bombs.ts';

export const SHIELD_FRAME = 3;

export interface ShieldRendererOptions {
  scene: Phaser.Scene;
  /** Container the wall + shard sprites are added to. */
  wallLayer: Phaser.GameObjects.Container;
  /** Container for the push puff vfx (above-fog). */
  vfxLayer: Phaser.GameObjects.Container;
  /** Container for the push decal (under-fog like pearl decals). */
  decalLayer: Phaser.GameObjects.Container;
  /** Camera that should NOT render world objects (HUD camera). */
  hudCamera?: Phaser.Cameras.Scene2D.Camera | null;
  tileSize: number;
}

interface WallTileSprite {
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  /** Original world Y for the slam-in / shake. */
  baseY: number;
}

interface ShardSprite {
  id: string;
  x: number;
  y: number;
  /** Container holding 3-4 small triangle Graphics objects per tile. */
  container: Phaser.GameObjects.Container;
}

/** Deterministic hash → seeded RNG for piece positions per tile. */
function tileSeed(x: number, y: number): () => number {
  // Simple LCG seeded by the tile coords. Results stay stable across reloads
  // so a player rejoining a match sees the same piece layout.
  let s = (x * 73856093) ^ (y * 19349663);
  if (s < 0) s = -s;
  return (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Build the persistent shard pieces for ONE tile as a Container of Graphics
 * triangles. Returns the container at world position (cx, cy). Pieces start
 * burst-out from centre with scale 0; caller animates them in.
 */
function buildShardPieces(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  tileSize: number,
  rng: () => number,
): { container: Phaser.GameObjects.Container; pieces: Array<{ g: Phaser.GameObjects.Graphics; targetX: number; targetY: number }> } {
  const container = scene.add.container(cx, cy);
  const pieces: Array<{ g: Phaser.GameObjects.Graphics; targetX: number; targetY: number }> = [];
  // 3-4 triangles per tile. Darker bluish palette — deep steel + ink.
  const palette = [0x2c4862, 0x3e5c7a, 0x506e8a, 0x1f3850];
  const count = 3 + Math.floor(rng() * 2); // 3 or 4
  const pieceMaxR = tileSize * 0.18;
  const scatterR = tileSize * 0.22;
  for (let i = 0; i < count; i++) {
    const g = scene.add.graphics();
    // Pick a random rotation and small triangle (irregular, jagged).
    const r1 = pieceMaxR * (0.7 + rng() * 0.5);
    const r2 = pieceMaxR * (0.7 + rng() * 0.5);
    const r3 = pieceMaxR * (0.7 + rng() * 0.5);
    const a1 = rng() * Math.PI * 2;
    const a2 = a1 + (Math.PI * 2 / 3) * (0.85 + rng() * 0.3);
    const a3 = a2 + (Math.PI * 2 / 3) * (0.85 + rng() * 0.3);
    const baseColor = palette[i % palette.length];
    const accentColor = palette[(i + 2) % palette.length];
    g.fillStyle(baseColor, 0.85);
    g.beginPath();
    g.moveTo(Math.cos(a1) * r1, Math.sin(a1) * r1);
    g.lineTo(Math.cos(a2) * r2, Math.sin(a2) * r2);
    g.lineTo(Math.cos(a3) * r3, Math.sin(a3) * r3);
    g.closePath();
    g.fillPath();
    // Thin lighter accent stroke for the "bluish marking" feel.
    g.lineStyle(1, accentColor, 0.9);
    g.strokePath();
    // Final scattered position around the tile centre.
    const sa = rng() * Math.PI * 2;
    const sd = rng() * scatterR;
    const targetX = Math.cos(sa) * sd;
    const targetY = Math.sin(sa) * sd;
    // Start at centre, scaled tiny — caller tweens out.
    g.setPosition(0, 0);
    g.setScale(0.1);
    g.setRotation(rng() * Math.PI * 2);
    container.add(g);
    pieces.push({ g, targetX, targetY });
  }
  return { container, pieces };
}

export class ShieldRenderer {
  private scene: Phaser.Scene;
  private wallLayer: Phaser.GameObjects.Container;
  private vfxLayer: Phaser.GameObjects.Container;
  private decalLayer: Phaser.GameObjects.Container;
  private hudCamera: Phaser.Cameras.Scene2D.Camera | null;
  private tileSize: number;

  private wallSprites = new Map<string, WallTileSprite[]>();
  private shardSprites = new Map<string, ShardSprite>();
  /** Walls already shaking (last turn) so we don't restart the tween every frame. */
  private shaking = new Set<string>();

  constructor(opts: ShieldRendererOptions) {
    this.scene = opts.scene;
    this.wallLayer = opts.wallLayer;
    this.vfxLayer = opts.vfxLayer;
    this.decalLayer = opts.decalLayer;
    this.hudCamera = opts.hudCamera ?? null;
    this.tileSize = opts.tileSize;
  }

  destroy(): void {
    for (const tiles of this.wallSprites.values()) {
      for (const t of tiles) t.sprite.destroy();
    }
    this.wallSprites.clear();
    for (const s of this.shardSprites.values()) s.container.destroy();
    this.shardSprites.clear();
    this.shaking.clear();
  }

  /** Spawn a Shield Wall with the slam-in animation. Idempotent on wallId. */
  spawnWall(wall: ShieldWall): void {
    if (this.wallSprites.has(wall.id)) return;
    const ts = this.tileSize;
    const tiles: WallTileSprite[] = [];
    for (const t of wall.tiles) {
      const cx = t.x * ts + ts / 2;
      const cy = t.y * ts + ts / 2;
      const sprite = this.scene.add
        .image(cx, cy - ts * 0.6, 'bomb_icons', SHIELD_FRAME)
        .setDisplaySize(ts, ts)
        .setAlpha(0)
        .setScale(0.2);
      this.wallLayer.add(sprite);
      if (this.hudCamera) this.hudCamera.ignore(sprite);
      this.scene.tweens.add({
        targets: sprite,
        y: cy,
        alpha: 1,
        scaleX: ts / 32,
        scaleY: ts / 32,
        duration: 200,
        ease: 'Cubic.easeOut',
      });
      tiles.push({ x: t.x, y: t.y, sprite, baseY: cy });
    }
    this.wallSprites.set(wall.id, tiles);
  }

  /**
   * Begin the pre-shatter shake on a wall. Idempotent: subsequent calls do
   * nothing while the wall is already shaking.
   */
  beginShake(wallId: string): void {
    if (this.shaking.has(wallId)) return;
    const tiles = this.wallSprites.get(wallId);
    if (!tiles) return;
    this.shaking.add(wallId);
    for (const t of tiles) {
      this.scene.tweens.add({
        targets: t.sprite,
        y: t.baseY + 1,
        duration: 90,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  /**
   * Break the wall: fade the wall sprites out, then burst the shard pieces
   * out from each tile's centre. Pieces start scaled-down at the centre and
   * settle into their scattered final positions over ~360ms (with a small
   * overshoot for "bounce"). The pieces stay drawn permanently afterward,
   * keyed by `shardIds` from the server so syncShards picks them up without
   * re-creating.
   */
  breakWall(wallId: string, tiles: Array<{ x: number; y: number }>, shardIds: string[]): void {
    const wallTiles = this.wallSprites.get(wallId);
    this.shaking.delete(wallId);
    if (wallTiles) {
      for (const t of wallTiles) {
        this.scene.tweens.killTweensOf(t.sprite);
        this.scene.tweens.add({
          targets: t.sprite,
          alpha: 0,
          scaleX: 0.4,
          scaleY: 0.4,
          duration: 250,
          ease: 'Cubic.easeIn',
          onComplete: () => t.sprite.destroy(),
        });
      }
      this.wallSprites.delete(wallId);
    }

    // Burst the pieces in. We key by shardId from the server so syncShards
    // (called shortly after with the new state) finds them as already-existing.
    const ts = this.tileSize;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const id = shardIds[i];
      if (!id || this.shardSprites.has(id)) continue;
      const cx = t.x * ts + ts / 2;
      const cy = t.y * ts + ts / 2;
      const { container, pieces } = buildShardPieces(this.scene, cx, cy, ts, tileSeed(t.x, t.y));
      this.decalLayer.add(container);
      if (this.hudCamera) this.hudCamera.ignore(container);
      this.shardSprites.set(id, { id, x: t.x, y: t.y, container });
      // Tween each piece outward from centre to its target position with a
      // brief "pop" — start delayed so the wall-fade has visibly begun.
      for (const p of pieces) {
        this.scene.tweens.add({
          targets: p.g,
          x: p.targetX,
          y: p.targetY,
          scaleX: 1,
          scaleY: 1,
          duration: 360,
          delay: 120,
          ease: 'Back.easeOut',
        });
      }
    }
  }

  /** Reconcile wall sprites against `state.shieldWalls`. Adds missing, removes vanished. */
  syncWalls(walls: ShieldWall[]): void {
    const liveIds = new Set(walls.map(w => w.id));
    for (const wallId of [...this.wallSprites.keys()]) {
      if (!liveIds.has(wallId)) {
        // Wall was removed without a break event (e.g. state-snapshot sync) —
        // destroy without animation.
        const tiles = this.wallSprites.get(wallId);
        if (tiles) for (const t of tiles) t.sprite.destroy();
        this.wallSprites.delete(wallId);
        this.shaking.delete(wallId);
      }
    }
    for (const wall of walls) {
      if (!this.wallSprites.has(wall.id)) this.spawnWall(wall);
      // Last turn: start shake.
      if (wall.turnsRemaining <= 1) this.beginShake(wall.id);
    }
  }

  /**
   * Reconcile shard decals against `state.shieldShards`. Persistent — once
   * stamped, pieces stay forever. New shards (e.g. from a state-snapshot
   * sync where we missed the break event) are stamped in their final scattered
   * positions with no animation.
   */
  syncShards(shards: ShieldShard[]): void {
    const ts = this.tileSize;
    const liveIds = new Set(shards.map(s => s.id));
    for (const id of [...this.shardSprites.keys()]) {
      if (!liveIds.has(id)) {
        this.shardSprites.get(id)!.container.destroy();
        this.shardSprites.delete(id);
      }
    }
    for (const s of shards) {
      if (this.shardSprites.has(s.id)) continue;
      const cx = s.x * ts + ts / 2;
      const cy = s.y * ts + ts / 2;
      const { container, pieces } = buildShardPieces(this.scene, cx, cy, ts, tileSeed(s.x, s.y));
      this.decalLayer.add(container);
      if (this.hudCamera) this.hudCamera.ignore(container);
      // Snap to final positions (no burst — we missed the break event).
      for (const p of pieces) {
        p.g.setPosition(p.targetX, p.targetY);
        p.g.setScale(1);
      }
      this.shardSprites.set(s.id, { id: s.id, x: s.x, y: s.y, container });
    }
  }

  /**
   * Toggle wall + shard visibility per tile. Walls are LoS-only (visible only
   * while currently in sight). Shards behave like bomb scorch decals: hidden
   * on tiles the local player has NEVER seen, visible on tiles they have
   * (whether currently in LoS or remembered through fog).
   */
  applyFogVisibility(
    isVisible: (x: number, y: number) => boolean,
    isDiscovered: (x: number, y: number) => boolean,
  ): void {
    for (const tiles of this.wallSprites.values()) {
      for (const t of tiles) {
        t.sprite.setVisible(isVisible(t.x, t.y));
      }
    }
    for (const s of this.shardSprites.values()) {
      s.container.setVisible(isDiscovered(s.x, s.y));
    }
  }

  /**
   * Yellow push puff for shield_pushed events — same shape as the Ender
   * Pearl teleport puff, recolored to gold/yellow.
   */
  spawnPushPuff(tileX: number, tileY: number, durationMs = 240): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const g = this.scene.add.graphics();
    this.vfxLayer.add(g);
    if (this.hudCamera) this.hudCamera.ignore(g);
    this.scene.tweens.add({
      targets: g,
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        g.fillStyle(0xddbb55, (1 - t) * 0.6);
        g.fillCircle(cx, cy, ts * (0.3 + 0.5 * t));
        g.fillStyle(0xfff0aa, (1 - t) * 0.85);
        g.fillCircle(cx, cy, ts * (0.15 + 0.25 * t));
      },
      onComplete: () => g.destroy(),
    });
    // Sparkle particles
    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dot = this.scene.add.graphics();
      this.vfxLayer.add(dot);
      if (this.hudCamera) this.hudCamera.ignore(dot);
      dot.fillStyle(0xfff0aa, 0.9);
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

  /** Light-gray decal at a push destination (parallel to teleport decal). */
  stampPushDecal(tileX: number, tileY: number): void {
    const ts = this.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const g = this.scene.add.graphics();
    this.decalLayer.add(g);
    if (this.hudCamera) this.hudCamera.ignore(g);
    g.fillStyle(0x888888, 0.55);
    g.fillCircle(cx, cy, ts * 0.32);
    g.fillStyle(0xbbbbbb, 0.65);
    g.fillCircle(cx, cy, ts * 0.18);
  }
}
