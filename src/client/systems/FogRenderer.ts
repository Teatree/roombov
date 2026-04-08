import Phaser from 'phaser';
import type { MapData } from '@shared/types/map.ts';
import { hasLineOfSight } from '@shared/systems/LineOfSight.ts';

/**
 * Three-stage per-player line-of-sight fog of war.
 *
 *  - unseen    : never been in LOS, fully dark
 *  - seen-dim  : previously visible, now not — map structure shown dimmed
 *  - visible   : currently in LOS from the player's Bomberman — fully lit
 *
 * Call `update(tx, ty)` with the Bomberman's current tile before rendering
 * entities. `isVisible(x, y)` returns true when a tile is currently lit —
 * use it to hide enemies (not the map) in seen-dim regions.
 *
 * Client-side only for now. When we ship multiplayer with anti-wallhack,
 * the server will pre-filter match_state per player before sending.
 */

type Stage = 'unseen' | 'seen' | 'visible';

export class FogRenderer {
  private scene: Phaser.Scene;
  private mapData: MapData;
  private radius: number;
  private graphics: Phaser.GameObjects.Graphics;
  private state: Map<string, Stage> = new Map();

  constructor(scene: Phaser.Scene, mapData: MapData, radius: number, depth: number) {
    this.scene = scene;
    this.mapData = mapData;
    this.radius = radius;
    this.graphics = scene.add.graphics().setDepth(depth);
  }

  update(centerX: number, centerY: number): void {
    // Demote previously-visible tiles to seen-dim
    for (const [key, stage] of this.state) {
      if (stage === 'visible') this.state.set(key, 'seen');
    }

    const ts = this.mapData.tileSize;
    const fromPx = centerX * ts + ts / 2;
    const fromPy = centerY * ts + ts / 2;

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

    this.render();
  }

  isVisible(x: number, y: number): boolean {
    return this.state.get(`${x},${y}`) === 'visible';
  }

  isDiscovered(x: number, y: number): boolean {
    const s = this.state.get(`${x},${y}`);
    return s === 'visible' || s === 'seen';
  }

  private render(): void {
    const ts = this.mapData.tileSize;
    this.graphics.clear();

    for (let y = 0; y < this.mapData.height; y++) {
      for (let x = 0; x < this.mapData.width; x++) {
        const stage = this.state.get(`${x},${y}`) ?? 'unseen';
        if (stage === 'visible') continue;

        // Unseen: near-opaque black. Seen-dim: partial overlay.
        const alpha = stage === 'unseen' ? 0.92 : 0.55;
        this.graphics.fillStyle(0x000008, alpha);
        this.graphics.fillRect(x * ts, y * ts, ts, ts);
      }
    }
  }

  destroy(): void {
    this.graphics.destroy();
    this.state.clear();
  }
}
