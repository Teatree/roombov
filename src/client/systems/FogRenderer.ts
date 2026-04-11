import Phaser from 'phaser';
import type { MapData } from '@shared/types/map.ts';
import { hasLineOfSight } from '@shared/systems/LineOfSight.ts';

/**
 * Three-stage per-player line-of-sight fog of war.
 *
 *  - unseen    : never been in LOS — fully opaque black, hides map layout
 *  - seen-dim  : previously visible — map structure dimmed, enemies hidden
 *  - visible   : currently in LOS — everything fully lit
 *
 * External sources can force tiles visible via `addRevealedTiles(tiles)` —
 * used by Flare bombs, which reveal an area for ALL players.
 */

type Stage = 'unseen' | 'seen' | 'visible';

export class FogRenderer {
  private scene: Phaser.Scene;
  private mapData: MapData;
  private radius: number;
  private graphics: Phaser.GameObjects.Graphics;
  private state: Map<string, Stage> = new Map();
  /** Extra tiles force-revealed this turn (e.g. by Flare). Cleared each update. */
  private externalReveals = new Set<string>();

  constructor(scene: Phaser.Scene, mapData: MapData, radius: number, depth: number) {
    this.scene = scene;
    this.mapData = mapData;
    this.radius = radius;
    this.graphics = scene.add.graphics().setDepth(depth);
  }

  /**
   * Add tiles that are visible regardless of LOS this turn (from Flare light
   * tiles in the match state). Call before `update()`.
   */
  setExternalReveals(tiles: Array<{ x: number; y: number }>): void {
    this.externalReveals.clear();
    for (const t of tiles) {
      this.externalReveals.add(`${t.x},${t.y}`);
    }
  }

  update(centerX: number, centerY: number): void {
    // Demote previously-visible tiles to seen-dim
    for (const [key, stage] of this.state) {
      if (stage === 'visible') this.state.set(key, 'seen');
    }

    const ts = this.mapData.tileSize;
    const fromPx = centerX * ts + ts / 2;
    const fromPy = centerY * ts + ts / 2;

    // LOS from the player's Bomberman
    for (let dy = -this.radius; dy <= this.radius; dy++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) > this.radius) continue;
        const tx = centerX + dx;
        const ty = centerY + dy;
        if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) continue;

        const toPx = tx * ts + ts / 2;
        const toPy = ty * ts + ts / 2;
        if (hasLineOfSight(fromPx, fromPy, toPx, toPy, this.mapData.grid, ts)) {
          this.state.set(`${tx},${ty}`, 'visible');
        }
      }
    }

    // External reveals (Flare) — force-visible regardless of LOS
    for (const key of this.externalReveals) {
      this.state.set(key, 'visible');
    }

    this.render();
  }

  isVisible(x: number, y: number): boolean {
    return this.state.get(`${x},${y}`) === 'visible';
  }

  isDiscovered(x: number, y: number): boolean {
    const s = this.state.get(`${x},${y}`);
    return s === 'visible' || s === 'seen';
  }

  /** True if the tile has never been seen at all. */
  isUnseen(x: number, y: number): boolean {
    return (this.state.get(`${x},${y}`) ?? 'unseen') === 'unseen';
  }

  private render(): void {
    const ts = this.mapData.tileSize;
    this.graphics.clear();

    for (let y = 0; y < this.mapData.height; y++) {
      for (let x = 0; x < this.mapData.width; x++) {
        const stage = this.state.get(`${x},${y}`) ?? 'unseen';
        if (stage === 'visible') continue;

        if (stage === 'unseen') {
          // Fully opaque black — hides the map layout entirely
          this.graphics.fillStyle(0x000000, 1);
        } else {
          // Seen-dim — semi-transparent so map structure is visible
          this.graphics.fillStyle(0x000011, 0.55);
        }
        this.graphics.fillRect(x * ts, y * ts, ts, ts);
      }
    }
  }

  ignoreFromCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore(this.graphics);
  }

  destroy(): void {
    this.graphics.destroy();
    this.state.clear();
  }
}
