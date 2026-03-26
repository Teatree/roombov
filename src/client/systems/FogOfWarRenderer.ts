import Phaser from 'phaser';
import { FogOfWarSystem } from '@shared/systems/FogOfWarSystem.ts';
import { TileType } from '@shared/types/map.ts';
import type { MapData } from '@shared/types/map.ts';

export class FogOfWarRenderer {
  private fogGraphics: Phaser.GameObjects.Graphics;
  private fogSystem: FogOfWarSystem;
  private mapData: MapData;
  private dirty = true;

  constructor(scene: Phaser.Scene, mapData: MapData, fogSystem: FogOfWarSystem) {
    this.mapData = mapData;
    this.fogSystem = fogSystem;
    this.fogGraphics = scene.add.graphics();
    this.fogGraphics.setDepth(10);
    this.render();
  }

  markDirty(): void {
    this.dirty = true;
  }

  update(): void {
    if (this.dirty) {
      this.render();
      this.dirty = false;
    }
  }

  private render(): void {
    this.fogGraphics.clear();
    const { tileSize, grid } = this.mapData;

    for (let y = 0; y < this.fogSystem.height; y++) {
      for (let x = 0; x < this.fogSystem.width; x++) {
        if (!this.fogSystem.isRevealed(x, y)) {
          const tile = grid[y][x];
          if (tile === TileType.WALL) {
            // Walls show as dim outlines through fog
            this.fogGraphics.fillStyle(0x111122, 0.85);
          } else {
            // Everything else is fully hidden
            this.fogGraphics.fillStyle(0x0a0a15, 0.92);
          }
          this.fogGraphics.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
      }
    }
  }

  destroy(): void {
    this.fogGraphics.destroy();
  }
}
