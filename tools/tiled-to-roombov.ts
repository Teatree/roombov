/**
 * Tiled .tmj → Bomberman map JSON converter.
 *
 * Usage:  npx tsx tools/tiled-to-roombov.ts src/shared/maps/main_map.tmj
 * Output: src/shared/maps/main_map.json
 *
 * ## Tile layers
 *
 * The converter supports two modes for building the walkability grid:
 *
 * **Mode 1 — Collision layer (recommended for complex maps)**
 *   Create a tile layer named exactly `Collision`. Paint any tile on cells
 *   that should block movement (walls, abyss, obstacles). Leave walkable
 *   floor cells empty (gid 0). The converter builds the grid from this
 *   layer only — all other tile layers are purely visual.
 *
 * **Mode 2 — Legacy single-layer (for test_arena / simple maps)**
 *   If there is no `Collision` layer, the converter falls back to the first
 *   tile layer and maps gid→tileId: 0=floor, 1=wall, 2=door, 3=furniture.
 *
 * ## Object layers
 *
 *  - Spawns        → SpawnPoint[] (point objects)
 *  - EscapeTiles   → EscapeTile[] (point objects)
 *  - BombZones     → Zone[] (rectangle objects)
 *  - CoinZones     → Zone[] (rectangle objects)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { basename, dirname, join } from 'path';

// ------- Tiled types (subset) -------

interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: { firstgid: number; name?: string; source?: string }[];
  layers: TiledLayer[];
}

type TiledLayer = TiledTileLayer | TiledObjectLayer | TiledGroupLayer;

interface TiledChunk {
  x: number;
  y: number;
  width: number;
  height: number;
  data: number[];
}

interface TiledTileLayer {
  type: 'tilelayer';
  name: string;
  /** Flat data array (fixed-size maps). */
  data?: number[];
  /** Chunked data (infinite maps). */
  chunks?: TiledChunk[];
  startx?: number;
  starty?: number;
  width: number;
  height: number;
  visible: boolean;
}

interface TiledObjectLayer {
  type: 'objectgroup';
  name: string;
  objects: TiledObject[];
}

interface TiledGroupLayer {
  type: 'group';
  name: string;
  layers: TiledLayer[];
}

interface TiledObject {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
  ellipse?: boolean;
}

// ------- Output schema -------

interface BombermanMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  grid: number[][];
  spawns: { id: number; x: number; y: number }[];
  escapeTiles: { id: number; x: number; y: number }[];
  chest1Zones: { x: number; y: number; w: number; h: number }[];
  chest2Zones: { x: number; y: number; w: number; h: number }[];
  doors: { id: number; tiles: { x: number; y: number }[]; orientation: 'horizontal' | 'vertical' }[];
}

// ------- Helpers -------

/** Recursively flatten all layers (handles group layers). */
function flattenLayers(layers: TiledLayer[]): TiledLayer[] {
  const out: TiledLayer[] = [];
  for (const l of layers) {
    if (l.type === 'group') {
      out.push(...flattenLayers((l as TiledGroupLayer).layers));
    } else {
      out.push(l);
    }
  }
  return out;
}

// ------- Main -------

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx tools/tiled-to-roombov.ts <path-to-tmj>');
  process.exit(1);
}

const raw = readFileSync(inputPath, 'utf-8');
const tiled: TiledMap = JSON.parse(raw);
const ts = tiled.tilewidth;
const mapW = tiled.width;
const mapH = tiled.height;

console.log(`Map: ${mapW}x${mapH}, tileSize: ${ts}`);
console.log(`Tilesets: ${tiled.tilesets.map(t => `${t.name ?? t.source}(gid ${t.firstgid})`).join(', ')}`);

const allLayers = flattenLayers(tiled.layers);
const tileLayers = allLayers.filter((l): l is TiledTileLayer => l.type === 'tilelayer');
const objectLayers = allLayers.filter((l): l is TiledObjectLayer => l.type === 'objectgroup');

console.log(`Tile layers: ${tileLayers.map(l => l.name).join(', ')}`);
console.log(`Object layers: ${objectLayers.map(l => l.name).join(', ')}`);

/**
 * Read a gid from a tile layer at (tileX, tileY), handling both flat data
 * arrays (fixed-size maps) and chunked arrays (infinite maps).
 */
function readGid(layer: TiledTileLayer, tileX: number, tileY: number): number {
  if (layer.data) {
    // Flat data — tileX/tileY are relative to (0,0).
    const idx = tileY * mapW + tileX;
    return layer.data[idx] ?? 0;
  }
  if (layer.chunks) {
    // Chunked (infinite) — convert zero-based grid coords back to absolute
    // Tiled tile coords by adding the chunk-space origin (which is the
    // min chunk x/y across all layers).
    let minChunkX = Infinity, minChunkY = Infinity;
    for (const c of layer.chunks) {
      minChunkX = Math.min(minChunkX, c.x);
      minChunkY = Math.min(minChunkY, c.y);
    }
    const absX = tileX + minChunkX;
    const absY = tileY + minChunkY;
    for (const chunk of layer.chunks) {
      if (absX >= chunk.x && absX < chunk.x + chunk.width &&
          absY >= chunk.y && absY < chunk.y + chunk.height) {
        const localX = absX - chunk.x;
        const localY = absY - chunk.y;
        return chunk.data[localY * chunk.width + localX] ?? 0;
      }
    }
    return 0;
  }
  return 0;
}

/**
 * For infinite (chunked) maps, derive the true map dimensions from the
 * union of all tile layer chunks. The header's width/height is just a
 * viewport hint and is unreliable.
 */
const isInfinite = tileLayers.some(l => !!l.chunks);
let actualW = mapW;
let actualH = mapH;
if (isInfinite) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layer of tileLayers) {
    if (!layer.chunks) continue;
    for (const chunk of layer.chunks) {
      minX = Math.min(minX, chunk.x);
      minY = Math.min(minY, chunk.y);
      maxX = Math.max(maxX, chunk.x + chunk.width);
      maxY = Math.max(maxY, chunk.y + chunk.height);
    }
  }
  actualW = maxX - minX;
  actualH = maxY - minY;
  console.log(`\nInfinite map detected. Chunk bounds: (${minX},${minY}) to (${maxX},${maxY}) = ${actualW}x${actualH}`);
}

// Override map dimensions for infinite maps
const finalW = isInfinite ? actualW : mapW;
const finalH = isInfinite ? actualH : mapH;

/**
 * For infinite maps, objects and chunks use absolute Tiled coordinates that
 * can be negative. We need an origin offset to translate them into our
 * zero-based grid. The origin is the top-left corner of the chunk bounding
 * box, expressed in pixels.
 */
let originPixelX = 0;
let originPixelY = 0;
if (isInfinite) {
  let minChunkX = Infinity, minChunkY = Infinity;
  for (const layer of tileLayers) {
    if (!layer.chunks) continue;
    for (const chunk of layer.chunks) {
      minChunkX = Math.min(minChunkX, chunk.x);
      minChunkY = Math.min(minChunkY, chunk.y);
    }
  }
  originPixelX = minChunkX * ts;
  originPixelY = minChunkY * ts;
  console.log(`Origin offset: (${originPixelX}, ${originPixelY}) pixels = (${minChunkX}, ${minChunkY}) tiles`);
}

// Build the walkability grid
const grid: number[][] = [];

const collisionLayer = tileLayers.find(l => l.name.toLowerCase() === 'collision');

if (collisionLayer) {
  // Mode 1: Collision layer. Any non-zero gid = wall (1), zero = floor (0).
  console.log(`Using Collision layer for walkability`);
  for (let row = 0; row < finalH; row++) {
    const gridRow: number[] = [];
    for (let col = 0; col < finalW; col++) {
      const gid = readGid(collisionLayer, col, row);
      gridRow.push(gid === 0 ? 0 : 1);
    }
    grid.push(gridRow);
  }
} else {
  // Mode 2: Legacy single-layer fallback (only works for non-chunked maps).
  console.log(`\n⚠ No "Collision" layer found — using legacy first-tile-layer mode`);
  const firstTileLayer = tileLayers[0];
  if (!firstTileLayer) { console.error('No tile layers found at all'); process.exit(1); }
  if (firstTileLayer.chunks) {
    console.error('ERROR: Infinite (chunked) map requires a "Collision" tile layer.');
    console.error('In Tiled, create a new Tile Layer named "Collision".');
    console.error('Paint any tile on cells that should block movement (walls, abyss).');
    console.error('Leave walkable floors empty.');
    process.exit(1);
  }
  const firstGid = tiled.tilesets[0]?.firstgid ?? 1;
  for (let row = 0; row < finalH; row++) {
    const gridRow: number[] = [];
    for (let col = 0; col < finalW; col++) {
      const gid = readGid(firstTileLayer, col, row);
      const tileId = gid - firstGid;
      gridRow.push(Math.max(0, tileId));
    }
    grid.push(gridRow);
  }
}

// Count walkable vs blocked
let walkable = 0;
let blocked = 0;
for (let y = 0; y < finalH; y++) {
  for (let x = 0; x < finalW; x++) {
    if (grid[y][x] === 0) walkable++; else blocked++;
  }
}
console.log(`Grid: ${walkable} walkable, ${blocked} blocked (${((blocked / (finalW * finalH)) * 100).toFixed(0)}% walls)`);

// Object layer lookup
function findObjectLayer(...names: string[]): TiledObjectLayer | undefined {
  for (const name of names) {
    const l = objectLayers.find(layer => layer.name === name);
    if (l) return l;
  }
  return undefined;
}

function toTile(px: number, py: number): { x: number; y: number } {
  // Subtract the origin so negative Tiled coords become zero-based grid coords
  let tx = Math.floor((px - originPixelX) / ts);
  let ty = Math.floor((py - originPixelY) / ts);
  tx = Math.max(0, Math.min(finalW - 1, tx));
  ty = Math.max(0, Math.min(finalH - 1, ty));
  // If landing on a wall, nudge to nearest floor tile
  if (grid[ty][tx] !== 0) {
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = ty + dy;
          const nx = tx + dx;
          if (ny >= 0 && ny < finalH && nx >= 0 && nx < finalW && grid[ny][nx] === 0) {
            return { x: nx, y: ny };
          }
        }
      }
    }
  }
  return { x: tx, y: ty };
}

function pointLayerToTiles(layer: TiledObjectLayer | undefined): { id: number; x: number; y: number }[] {
  if (!layer) return [];
  return layer.objects
    .filter(o => o.point)
    .map((o, i) => {
      const t = toTile(o.x, o.y);
      return { id: i, x: t.x, y: t.y };
    });
}

function rectLayerToZones(layer: TiledObjectLayer | undefined): { x: number; y: number; w: number; h: number }[] {
  if (!layer) return [];
  return layer.objects
    .filter(o => o.width > 0 && o.height > 0)
    .map(o => ({
      x: Math.floor((o.x - originPixelX) / ts),
      y: Math.floor((o.y - originPixelY) / ts),
      w: Math.ceil(o.width / ts),
      h: Math.ceil(o.height / ts),
    }));
}

const spawns = pointLayerToTiles(findObjectLayer('Spawns'));
const escapeTiles = pointLayerToTiles(findObjectLayer('EscapeTiles', 'Exits'));
// Chest zones — new names preferred, old names as fallback for transition
const chest1Zones = rectLayerToZones(findObjectLayer('Chest1Zones', 'CoinZones', 'GoodiesZones', 'GoodieZones'));
const chest2Zones = rectLayerToZones(findObjectLayer('Chest2Zones', 'BombZones', 'TurretZones'));

console.log(`\nSpawns: ${spawns.length}${spawns.length > 0 ? ' → ' + spawns.map(s => `(${s.x},${s.y})`).join(', ') : ''}`);
console.log(`EscapeTiles: ${escapeTiles.length}${escapeTiles.length > 0 ? ' → ' + escapeTiles.map(e => `(${e.x},${e.y})`).join(', ') : ''}`);
console.log(`Chest1Zones: ${chest1Zones.length}`);
console.log(`Chest2Zones: ${chest2Zones.length}`);

// Scan "Doors" tile layer — find connected groups of door tiles
const doorLayer = tileLayers.find(l => l.name.toLowerCase() === 'doors');
const doors: BombermanMap['doors'] = [];
if (doorLayer) {
  // Collect all door tile positions
  const doorTiles = new Set<string>();
  for (let row = 0; row < finalH; row++) {
    for (let col = 0; col < finalW; col++) {
      if (readGid(doorLayer, col, row) !== 0) {
        doorTiles.add(`${col},${row}`);
      }
    }
  }
  // Flood-fill connected groups
  const visited = new Set<string>();
  for (const key of doorTiles) {
    if (visited.has(key)) continue;
    const [sx, sy] = key.split(',').map(Number);
    const group: { x: number; y: number }[] = [];
    const queue = [{ x: sx, y: sy }];
    visited.add(key);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      group.push(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${cur.x + dx},${cur.y + dy}`;
        if (doorTiles.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push({ x: cur.x + dx, y: cur.y + dy });
        }
      }
    }
    // Sort tiles: by x for horizontal, by y for vertical
    group.sort((a, b) => a.x - b.x || a.y - b.y);
    // Determine orientation: all same y → horizontal; all same x → vertical
    const allSameY = group.every(t => t.y === group[0].y);
    const allSameX = group.every(t => t.x === group[0].x);
    let orientation: 'horizontal' | 'vertical' = 'horizontal';
    if (allSameX && group.length >= 3) orientation = 'vertical';
    else if (allSameY && group.length >= 2) orientation = 'horizontal';
    doors.push({ id: doors.length, tiles: group, orientation });
  }
  console.log(`Doors: ${doors.length} (${doors.filter(d => d.orientation === 'horizontal').length}H, ${doors.filter(d => d.orientation === 'vertical').length}V)`);
} else {
  console.log('Doors: 0 (no "Doors" tile layer found)');
}

// Validate spawns land on walkable tiles
for (const s of spawns) {
  if (grid[s.y]?.[s.x] !== 0) {
    console.warn(`⚠ Spawn ${s.id} at (${s.x},${s.y}) is on a blocked tile!`);
  }
}
for (const e of escapeTiles) {
  if (grid[e.y]?.[e.x] !== 0) {
    console.warn(`⚠ EscapeTile ${e.id} at (${e.x},${e.y}) is on a blocked tile!`);
  }
}

const mapId = basename(inputPath, '.tmj');
const output: BombermanMap = {
  id: mapId,
  name: mapId.replace(/[-_]/g, ' '),
  width: finalW,
  height: finalH,
  tileSize: ts,
  grid,
  spawns,
  escapeTiles,
  chest1Zones,
  chest2Zones,
  doors,
};

const outPath = join(dirname(inputPath), `${mapId}.json`);
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\n✓ Written: ${outPath}`);

// Also sync the .tmj to public/maps/ so Phaser's tilemap loader picks up
// the latest visual edits at runtime. We patch tileset image paths to be
// relative filenames (matching the PNGs already in public/maps/).
const publicMapsDir = join(dirname(inputPath), '../../../public/maps');
if (existsSync(join(publicMapsDir, '..'))) {
  if (!existsSync(publicMapsDir)) mkdirSync(publicMapsDir, { recursive: true });

  // Patch tileset image paths in the tmj and write to public/maps/
  const patched = JSON.parse(raw) as TiledMap & { tilesets: Array<{ image?: string; source?: string; [k: string]: unknown }> };
  // Strip external (non-embedded) tilesets — Phaser can't load them
  patched.tilesets = patched.tilesets.filter(ts => {
    if (ts.source) {
      console.log(`  stripping external tileset: ${ts.source} (embed it in Tiled to include it)`);
      return false;
    }
    return true;
  });
  // Strip data-only tile layers (Collision, Doors) — their tiles may
  // reference stripped tilesets and Phaser crashes trying to resolve them.
  if (patched.layers) {
    const stripLayers = (layers: Array<{ name?: string; type?: string; layers?: unknown[] }>): void => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        const ln = (l.name ?? '').toLowerCase();
        if (l.type === 'tilelayer' && (ln === 'doors')) {
          console.log(`  stripping data-only tile layer: ${l.name}`);
          layers.splice(i, 1);
        } else if (l.type === 'group' && l.layers) {
          stripLayers(l.layers as typeof layers);
        }
      }
    };
    stripLayers(patched.layers as Array<{ name?: string; type?: string; layers?: unknown[] }>);
  }

  const copiedPngs = new Set<string>();
  for (const tsEntry of patched.tilesets) {
    if (tsEntry.image) {
      const imgName = String(tsEntry.image).split(/[\\/]/).pop() ?? '';
      // Copy the referenced PNG from its source location to public/maps/
      const srcImg = join(dirname(inputPath), String(tsEntry.image));
      const dstImg = join(publicMapsDir, imgName);
      if (existsSync(srcImg) && !copiedPngs.has(imgName)) {
        try {
          copyFileSync(srcImg, dstImg);
          copiedPngs.add(imgName);
          console.log(`  synced tileset image: ${imgName}`);
        } catch (err) {
          console.warn(`  ⚠ failed to copy ${srcImg} → ${dstImg}:`, err);
        }
      }
      tsEntry.image = imgName;
    }
  }
  const publicTmjPath = join(publicMapsDir, `${mapId}.tmj`);
  writeFileSync(publicTmjPath, JSON.stringify(patched));
  console.log(`✓ Synced tmj to: ${publicTmjPath}`);
} else {
  console.warn(`⚠ public/ not found — not syncing tmj for runtime`);
}
