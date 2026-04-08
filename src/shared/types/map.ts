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
  /**
   * Zones where coin bags may spawn. Each match seeds random positions
   * inside these zones. Empty array → no coin bags on this map.
   */
  coinZones: Zone[];
  /**
   * Zones where collectible bombs may spawn. Same seeded-random behavior
   * as coinZones.
   */
  bombZones: Zone[];
}
