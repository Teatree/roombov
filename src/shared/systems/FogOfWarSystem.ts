import { FogTile } from '../types/game-state.ts';

export class FogOfWarSystem {
  private grid: FogTile[][];
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.grid = [];
    for (let y = 0; y < height; y++) {
      this.grid[y] = new Array(width).fill(FogTile.HIDDEN);
    }
  }

  reveal(cx: number, cy: number, radius: number): { x: number; y: number }[] {
    const revealed: { x: number; y: number }[] = [];
    const r2 = radius * radius;

    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius));
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2 && this.grid[y][x] === FogTile.HIDDEN) {
          this.grid[y][x] = FogTile.REVEALED;
          revealed.push({ x, y });
        }
      }
    }

    return revealed;
  }

  isRevealed(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return this.grid[y][x] === FogTile.REVEALED;
  }

  getGrid(): FogTile[][] {
    return this.grid;
  }

  setGrid(grid: FogTile[][]): void {
    this.grid = grid;
  }
}
