import Phaser from 'phaser';
import { TileType } from '@shared/types/map.ts';
import type { MapData, ExitPoint } from '@shared/types/map.ts';

const TILE_COLORS: Record<TileType, number> = {
  [TileType.FLOOR]: 0x2a2a3e,
  [TileType.WALL]: 0x4a4a5e,
  [TileType.DOOR]: 0x3a5a4e,
  [TileType.FURNITURE]: 0x5a4a3e,
};

export class MapRenderer {
  private graphics: Phaser.GameObjects.Graphics;
  private mapData: MapData;

  constructor(scene: Phaser.Scene, mapData: MapData) {
    this.mapData = mapData;
    this.graphics = scene.add.graphics();
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

        // Grid lines
        this.graphics.lineStyle(1, 0x1a1a2e, 0.3);
        this.graphics.strokeRect(col * tileSize, row * tileSize, tileSize, tileSize);
      }
    }
  }

  renderSpawn(scene: Phaser.Scene, assignedSpawnId: number): void {
    const { spawns, tileSize } = this.mapData;
    const spawn = spawns.find(s => s.id === assignedSpawnId);
    if (!spawn) return;

    const cx = spawn.x * tileSize + tileSize / 2;
    const cy = spawn.y * tileSize + tileSize / 2;
    const g = scene.add.graphics();

    // Pulsing highlight ring
    g.lineStyle(3, 0x44aaff, 0.4);
    g.strokeCircle(cx, cy, tileSize * 0.7);

    // Filled base
    g.fillStyle(0x44aaff, 0.7);
    g.fillCircle(cx, cy, tileSize / 2.5);
    g.lineStyle(2, 0x88ccff, 1);
    g.strokeCircle(cx, cy, tileSize / 2.5);

    // "S" label
    scene.add.text(cx, cy, 'S', {
      fontSize: '14px',
      color: '#ffffff',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
  }

  /** Render only the given assigned exits (all same color) */
  renderAssignedExits(scene: Phaser.Scene, assignedExits: ExitPoint[]): void {
    const { tileSize } = this.mapData;
    const color = 0x44ff88;

    for (const exit of assignedExits) {
      const cx = exit.x * tileSize + tileSize / 2;
      const cy = exit.y * tileSize + tileSize / 2;
      const g = scene.add.graphics();

      // Diamond shape
      const s = tileSize / 3;
      g.fillStyle(color, 0.6);
      g.fillTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.fillTriangle(cx, cy - s, cx - s, cy, cx, cy + s);
      g.lineStyle(2, color, 1);
      g.strokeTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.strokeTriangle(cx, cy - s, cx - s, cy, cx, cy + s);

      // "E" label
      scene.add.text(cx, cy, 'E', {
        fontSize: '10px',
        color: '#ffffff',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(5);
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
  }
}
