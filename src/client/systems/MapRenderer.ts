import Phaser from 'phaser';
import { TileType } from '@shared/types/map.ts';
import type { MapData, EscapeTile, SpawnPoint } from '@shared/types/map.ts';

/**
 * Map renderer with two modes:
 *
 * 1. **Tiled tilemap mode** — loads the .tmj and tileset images via Phaser's
 *    native tilemap API. Full art, animations, multi-layer rendering.
 *    Used when `preloadTiledMap()` was called before scene create.
 *
 * 2. **Procedural fallback** — colored rectangles per TileType. Used for
 *    test_arena or any map without a .tmj in public/maps/.
 *
 * The collision grid still comes from MapData (built by the converter from
 * the Collision layer). The Phaser tilemap is purely visual.
 */

const TILE_COLORS: Record<TileType, number> = {
  [TileType.FLOOR]: 0x2a2a3e,
  [TileType.WALL]: 0x4a4a5e,
  [TileType.DOOR]: 0x3a5a4e,
  [TileType.FURNITURE]: 0x5a4a3e,
};

/** Tileset metadata needed to add tilesets to the Phaser tilemap. */
interface TilesetInfo {
  name: string;
  key: string; // Phaser texture key
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  firstgid: number;
}

/**
 * Call this in a scene's `preload()` (or before `create()`) to queue the
 * Tiled assets for loading. Returns the tileset info needed at create time.
 * Returns null if the map has no .tmj in public/maps/.
 */
export function preloadTiledMap(
  scene: Phaser.Scene,
  mapId: string,
): { tilemapKey: string; tilesets: TilesetInfo[] } | null {
  const tmjPath = `maps/${mapId}.tmj`;
  const tilemapKey = `tilemap_${mapId}`;

  scene.load.tilemapTiledJSON(tilemapKey, tmjPath);

  // We don't know the tileset names until the JSON is parsed, so we
  // pre-register the known tileset images by convention. The tileset
  // image filenames in public/maps/ match the Tiled tileset names.
  const knownTilesets: TilesetInfo[] = [
    { name: 'Tileset', key: 'ts_Tileset', tileWidth: 16, tileHeight: 16, margin: 0, spacing: 0, firstgid: 1 },
    { name: 'Animated_objects', key: 'ts_Animated_objects', tileWidth: 16, tileHeight: 16, margin: 0, spacing: 0, firstgid: 210 },
    { name: 'Objects', key: 'ts_Objects', tileWidth: 16, tileHeight: 16, margin: 0, spacing: 0, firstgid: 703 },
    { name: 'Objects_small_details', key: 'ts_Objects_small_details', tileWidth: 16, tileHeight: 16, margin: 0, spacing: 0, firstgid: 1023 },
  ];

  for (const ts of knownTilesets) {
    if (!scene.textures.exists(ts.key)) {
      scene.load.image(ts.key, `maps/${ts.name}.png`);
    }
  }

  return { tilemapKey, tilesets: knownTilesets };
}

/** One animated tile instance — keeps its own clock and frame pointer. */
interface AnimatedTileInstance {
  layer: Phaser.Tilemaps.TilemapLayer;
  tileX: number;
  tileY: number;
  firstgid: number;
  /** Animation frames from the Tiled tileset: [{ tileid, duration }] */
  frames: Array<{ tileid: number; duration: number }>;
  currentFrameIdx: number;
  elapsedMs: number;
}

export class MapRenderer {
  private scene: Phaser.Scene | null = null;
  private mapData: MapData;
  private baseDepth: number;
  private proceduralGraphics: Phaser.GameObjects.Graphics | null = null;
  private tilemapObj: Phaser.Tilemaps.Tilemap | null = null;
  private tilemapLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  private extraGraphics: Phaser.GameObjects.GameObject[] = [];
  private animatedTiles: AnimatedTileInstance[] = [];

  constructor(scene: Phaser.Scene, mapData: MapData, baseDepth = 0, tiledInfo?: { tilemapKey: string; tilesets: TilesetInfo[] } | null) {
    this.scene = scene;
    this.mapData = mapData;
    this.baseDepth = baseDepth;

    if (tiledInfo && scene.cache.tilemap.exists(tiledInfo.tilemapKey)) {
      this.renderTiled(scene, tiledInfo);
    } else {
      this.renderProcedural(scene);
    }
  }

  /**
   * Drives the animated tile clock. Call from the scene's update() loop with
   * the frame delta. Advances each animated tile's phase and replaces the
   * tile index when a frame boundary is crossed.
   */
  tick(deltaMs: number): void {
    if (this.animatedTiles.length === 0) return;
    for (const at of this.animatedTiles) {
      at.elapsedMs += deltaMs;
      const currentFrame = at.frames[at.currentFrameIdx];
      if (at.elapsedMs < currentFrame.duration) continue;
      at.elapsedMs -= currentFrame.duration;
      at.currentFrameIdx = (at.currentFrameIdx + 1) % at.frames.length;
      const nextFrame = at.frames[at.currentFrameIdx];
      const newGid = at.firstgid + nextFrame.tileid;
      at.layer.putTileAt(newGid, at.tileX, at.tileY);
    }
  }

  private renderTiled(scene: Phaser.Scene, info: { tilemapKey: string; tilesets: TilesetInfo[] }): void {
    const tilemap = scene.make.tilemap({ key: info.tilemapKey });
    this.tilemapObj = tilemap;

    // Add tilesets
    const phaserTilesets: Phaser.Tilemaps.Tileset[] = [];
    for (const ts of info.tilesets) {
      const added = tilemap.addTilesetImage(ts.name, ts.key, ts.tileWidth, ts.tileHeight, ts.margin, ts.spacing);
      if (added) phaserTilesets.push(added);
    }

    if (phaserTilesets.length === 0) {
      console.warn('[MapRenderer] No tilesets loaded — falling back to procedural');
      this.renderProcedural(scene);
      return;
    }

    // Create all tile layers (skip the Collision layer — it's invisible)
    let layerDepth = this.baseDepth;
    for (const layerData of tilemap.layers) {
      if (layerData.name.toLowerCase() === 'collision') continue;
      const layer = tilemap.createLayer(layerData.name, phaserTilesets);
      if (layer) {
        layer.setDepth(layerDepth);
        this.tilemapLayers.push(layer);
        layerDepth++;
      }
    }

    // Scan each rendered layer for animated tiles and register them.
    // Tiled stores animation data on the tileset; Phaser doesn't tick these
    // automatically, so we drive them from the scene update loop via tick().
    this.collectAnimatedTiles(tilemap);

    console.log(`[MapRenderer] Tiled map rendered: ${this.tilemapLayers.length} visual layers, ${this.animatedTiles.length} animated tiles`);
  }

  /**
   * Walk every visible tile on every layer. If its tileset has animation
   * data for the tile's local id, register an AnimatedTileInstance so tick()
   * can drive the frame updates.
   */
  private collectAnimatedTiles(tilemap: Phaser.Tilemaps.Tilemap): void {
    for (const layer of this.tilemapLayers) {
      layer.forEachTile((tile) => {
        if (tile.index <= 0) return;
        const tileset = this.findTilesetForGid(tilemap, tile.index);
        if (!tileset) return;
        // Phaser stores per-tile animation data on tileset.tileData
        const localId = tile.index - tileset.firstgid;
        const tileData = (tileset.tileData as Record<number, { animation?: Array<{ tileid: number; duration: number }> }>)[localId];
        if (!tileData?.animation || tileData.animation.length === 0) return;

        this.animatedTiles.push({
          layer,
          tileX: tile.x,
          tileY: tile.y,
          firstgid: tileset.firstgid,
          frames: tileData.animation.map(f => ({ tileid: f.tileid, duration: f.duration })),
          currentFrameIdx: 0,
          elapsedMs: 0,
        });
      });
    }
  }

  private findTilesetForGid(tilemap: Phaser.Tilemaps.Tilemap, gid: number): Phaser.Tilemaps.Tileset | null {
    let match: Phaser.Tilemaps.Tileset | null = null;
    for (const ts of tilemap.tilesets) {
      if (gid >= ts.firstgid && (!match || ts.firstgid > match.firstgid)) {
        match = ts;
      }
    }
    return match;
  }

  private renderProcedural(scene: Phaser.Scene): void {
    const { grid, tileSize } = this.mapData;
    const g = scene.add.graphics();
    g.setDepth(this.baseDepth);
    this.proceduralGraphics = g;

    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < grid[row].length; col++) {
        const tile = grid[row][col];
        const color = TILE_COLORS[tile as TileType] ?? 0x2a2a3e;
        g.fillStyle(color, 1);
        g.fillRect(col * tileSize, row * tileSize, tileSize, tileSize);
        g.lineStyle(1, 0x1a1a2e, 0.3);
        g.strokeRect(col * tileSize, row * tileSize, tileSize, tileSize);
      }
    }
  }

  renderSpawn(scene: Phaser.Scene, spawn: SpawnPoint): void {
    const { tileSize } = this.mapData;
    const cx = spawn.x * tileSize + tileSize / 2;
    const cy = spawn.y * tileSize + tileSize / 2;
    const g = scene.add.graphics();
    g.setDepth(this.baseDepth + 20);
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
      g.setDepth(this.baseDepth + 20);
      const s = tileSize / 3;
      g.fillStyle(color, 0.45);
      g.fillTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.fillTriangle(cx, cy - s, cx - s, cy, cx, cy + s);
      g.lineStyle(2, color, 1);
      g.strokeTriangle(cx, cy - s, cx + s, cy, cx, cy + s);
      g.strokeTriangle(cx, cy - s, cx - s, cy, cx, cy + s);
      this.extraGraphics.push(g);
      const label = scene.add.text(cx, cy, 'E', {
        fontSize: '8px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(this.baseDepth + 21);
      this.extraGraphics.push(label);
    }
  }

  /** Tell a camera to ignore all objects owned by this renderer. */
  ignoreFromCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    if (this.proceduralGraphics) camera.ignore(this.proceduralGraphics);
    for (const layer of this.tilemapLayers) camera.ignore(layer);
    for (const g of this.extraGraphics) camera.ignore(g);
  }

  getWorldBounds(): { width: number; height: number } {
    return {
      width: this.mapData.width * this.mapData.tileSize,
      height: this.mapData.height * this.mapData.tileSize,
    };
  }

  destroy(): void {
    this.proceduralGraphics?.destroy();
    this.proceduralGraphics = null;
    for (const layer of this.tilemapLayers) layer.destroy();
    this.tilemapLayers = [];
    if (this.tilemapObj) { this.tilemapObj.destroy(); this.tilemapObj = null; }
    for (const g of this.extraGraphics) g.destroy();
    this.extraGraphics = [];
    this.animatedTiles = [];
    this.scene = null;
  }
}
