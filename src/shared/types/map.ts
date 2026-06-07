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
  /**
   * Collision tiles that block movement but do not block line-of-sight.
   * Populated by the Tiled converter from Collision-layer tiles whose
   * tileset tile has a truthy `seeThrough` property.
   */
  seeThroughTiles?: TileCoord[];
  spawns: SpawnPoint[];
  escapeTiles: EscapeTile[];
  /**
   * Zones where chests can spawn. Chest type is rolled per-match from
   * CHEST_SPAWN_TABLE (see src/shared/config/chests.ts); the zone itself
   * is type-agnostic. Multi-tile zones spawn a chest on one random
   * walkable tile inside the rectangle.
   */
  chestZones: Zone[];
  /**
   * Key spawn candidates from the Tiled "Keys" object layer. Each circle is
   * interpreted as a single point at its center, converted to tile coords.
   * MatchRoom shuffles these and takes BALANCE.keys.totalOnMap at match start.
   */
  keySpawns: TileCoord[];
  /**
   * Candidate tiles for random decorative objects, from the Tiled `Objects2`
   * tile layer. Purely visual: the client spawns `BALANCE.decor.spawnFraction`
   * of these per match (seeded by matchId) and renders them from
   * disguise_objects.png — the same sheet a Disguise-on-Idle Bomberman uses, so
   * a disguised player blends in. Optional for back-compat with older maps.
   */
  decorSpots?: TileCoord[];
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
