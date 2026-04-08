import Phaser from 'phaser';
import { TileType } from '@shared/types/map.ts';
import type { MapData, EscapeTile, SpawnPoint } from '@shared/types/map.ts';

const TILE_COLORS: Record<TileType, number> = {
  [TileType.FLOOR]: 0x2a2a3e,
  [TileType.WALL]: 0x4a4a5e,
  [TileType.DOOR]: 0x3a5a4e,
  [TileType.FURNITURE]: 0x5a4a3e,
};

/**
 * Renders a MapData tile grid + optional overlays for spawn points and
 * escape tiles.
 *
 * All created graphics are assigned `baseDepth` so the scene can control
 * draw order independently of insertion order. Entities should use a higher
 * depth than the map.
 */
export class MapRenderer {
  private graphics: Phaser.GameObjects.Graphics;
  private mapData: MapData;
  private baseDepth: number;
  private extraGraphics: Phaser.GameObjects.GameObject[] = [];

  constructor(scene: Phaser.Scene, mapData: MapData, baseDepth = 0) {
    this.mapData = mapData;
    this.baseDepth = baseDepth;
    this.graphics = scene.add.graphics();
    this.graphics.setDepth(baseDepth);
    this.render();
  }

  private render(): void {
    const { grid, tileSize } = this.mapData;

    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < grid[row].length; col++) {
        const tile = grid[row][col];
        const color = TILE_COLORS[tile as TileType] ?? 0x2a2a3e;
        this.graphics.fillStyle(color, 1);
        this.graphics.fillRect(col * tileSize, row * tileSize, tileSize, tileSize);
        this.graphics.lineStyle(1, 0x1a1a2e, 0.3);
        this.graphics.strokeRect(col * tileSize, row * tileSize, tileSize, tileSize);
      }
    }
  }

  renderSpawn(scene: Phaser.Scene, spawn: SpawnPoint): void {
    const { tileSize } = this.mapData;
    const cx = spawn.x * tileSize + tileSize / 2;
    const cy = spawn.y * tileSize + tileSize / 2;
    const g = scene.add.graphics();
    g.setDepth(this.baseDepth + 1);
    g.lineStyle(3, 0x44aaff, 0.4);
    g.strokeCircle(cx, cy, tileSize * 0.7);
    g.fillStyle(0x44aaff, 0.3);
    g.fillCircle(cx, cy, tileSize / 2.5);
    this.extraGraphics.push(g);
  }

  renderEscapeTiles(scene: Phaser.Scene, tiles: EscapeTile[]): void {
    const { tileSize } = this.mapData;
    const color = 0x44ff88;
    for (const tile of tiles) {
      const cx = tile.x * tileSize + tileSize / 2;
      const cy = tile.y * tileSize + tileSize / 2;
      const g = scene.add.graphics();
      g.setDepth(this.baseDepth + 1);
      const s = tileSize / 3;
      g.fillStyle(color, 0.45);
      g.fillTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.fillTriangle(cx, cy - s, cx - s, cy, cx, cy + s);
      g.lineStyle(2, color, 1);
      g.strokeTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.strokeTriangle(cx, cy - s, cx - s, cy, cx, cy + s);
      this.extraGraphics.push(g);
      const label = scene.add.text(cx, cy, 'E', {
        fontSize: '10px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(this.baseDepth + 2);
      this.extraGraphics.push(label);
    }
  }

  getWorldBounds(): { width: number; height: number } {
    return {
      width: this.mapData.width * this.mapData.tileSize,
      height: this.mapData.height * this.mapData.tileSize,
    };
  }

  destroy(): void {
    this.graphics.destroy();
    for (const g of this.extraGraphics) g.destroy();
    this.extraGraphics = [];
  }
}
