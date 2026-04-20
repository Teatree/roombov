export enum TileType {
  FLOOR = 0,
  WALL = 1,
  DOOR = 2,
  FURNITURE = 3,
}

/** Tile pairs used throughout map data. */
export interface TileCoord {
  x: number;
  y: number;
}

/** Rectangular zone (tile coords, width/height in tiles). */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tile where Bombermen can spawn at match start. */
export interface SpawnPoint {
  id: number;
  x: number;
  y: number;
}

/**
 * A tile the Bomberman can stand on at turn transition to escape the match.
 * Per the design: standing on an escape tile at turn transition extracts the
 * Bomberman and they keep all collected coins.
 */
export interface EscapeTile {
  id: number;
  x: number;
  y: number;
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
  escapeTiles: EscapeTile[];
  /** Zones where Tier 1 chests spawn (small: coins + 1 bomb). */
  chest1Zones: Zone[];
  /** Zones where Tier 2 chests spawn (large: more coins + 2 bombs). */
  chest2Zones: Zone[];
  /** Double doors detected from the Doors tile layer. */
  doors: DoorDef[];
  /** Optional tutorial-specific point references parsed from the Tutorial object layer. */
  tutorial?: TutorialMapData;
}

/**
 * Tutorial-mode reference points parsed from a `Tutorial` object layer in Tiled.
 * Only the tutorial map populates this; real maps leave it undefined.
 */
export interface TutorialMapData {
  /** Spawn tile for Bot1 (the flare/bomb kill target). */
  bot1: TileCoord;
  /** Spawn tile for Bot2 (the dodge + melee-trap opponent). */
  bot2: TileCoord;
  /** The final tile Bot2 walks to along the scripted path (step-in melee tile). */
  bot2Path: TileCoord;
}

/** A double door placed on the map. */
export interface DoorDef {
  id: number;
  tiles: Array<{ x: number; y: number }>;
  orientation: 'horizontal' | 'vertical';
}
