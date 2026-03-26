export enum TileType {
  FLOOR = 0,
  WALL = 1,
  DOOR = 2,
  FURNITURE = 3,
}

export interface SpawnPoint {
  id: number;
  x: number;
  y: number;
  edge: 'north' | 'south' | 'east' | 'west';
}

export interface ExitPoint {
  id: number;
  x: number;
  y: number;
  type: 'edge' | 'interior';
}

export interface TurretPlacement {
  x: number;
  y: number;
  stage: number;
}

export interface GoodiePlacement {
  x: number;
  y: number;
  stage: number;
}

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapManifestEntry {
  id: string;
  name: string;
  filename: string;
}

export interface MapData {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  grid: TileType[][];
  spawns: SpawnPoint[];
  exits: ExitPoint[];
  turrets: TurretPlacement[];
  goodies: GoodiePlacement[];
  turretZones?: Zone[];
  goodieZones?: Zone[];
}
