import EasyStar from 'easystarjs';
import { TileType } from '../types/map.ts';
import type { MapData } from '../types/map.ts';

export interface Point {
  x: number;
  y: number;
}

export class PathfindingSystem {
  private easystar: EasyStar.js;
  private grid: number[][];

  constructor(mapData: MapData) {
    this.easystar = new EasyStar.js();
    this.grid = mapData.grid.map(row => [...row]);

    this.easystar.enableSync();
    this.easystar.setGrid(this.grid);
    this.easystar.setAcceptableTiles([TileType.FLOOR, TileType.DOOR, TileType.FURNITURE]);
    this.easystar.setTileCost(TileType.DOOR, 1.5);
    this.easystar.enableDiagonals();
    this.easystar.enableCornerCutting();
  }

  /** Synchronous pathfinding — EasyStar.calculate() fires callbacks immediately */
  findPath(from: Point, to: Point): Point[] {
    let result: Point[] = [];
    this.easystar.findPath(from.x, from.y, to.x, to.y, (path) => {
      if (path !== null) {
        result = path.map(p => ({ x: p.x, y: p.y }));
      }
    });
    this.easystar.calculate();
    return result;
  }

  updateTile(x: number, y: number, walkable: boolean): void {
    this.grid[y][x] = walkable ? TileType.FLOOR : TileType.WALL;
    this.easystar.setGrid(this.grid);
    this.easystar.setAcceptableTiles([TileType.FLOOR, TileType.DOOR, TileType.FURNITURE]);
  }
}
