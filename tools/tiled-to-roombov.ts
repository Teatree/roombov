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
  tilesets: TiledTileset[];
  layers: TiledLayer[];
}

interface TiledProperty {
  name: string;
  type?: string;
  value?: unknown;
}

interface TiledTilesetTile {
  id: number;
  properties?: TiledProperty[];
}

interface TiledTileset {
  firstgid: number;
  name?: string;
  source?: string;
  tiles?: TiledTilesetTile[];
  [key: string]: unknown;
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
  properties?: TiledProperty[];
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
  seeThroughTiles?: { x: number; y: number }[];
  spawns: { id: number; x: number; y: number }[];
  escapeTiles: { id: number; x: number; y: number }[];
  chestZones: { x: number; y: number; w: number; h: number }[];
  keySpawns: { x: number; y: number }[];
  /** Candidate tiles for random decorative objects, from the `Objects2` tile
   *  layer. The game spawns a fraction of these per match (rendered from
   *  disguise_objects.png). */
  decorSpots: { x: number; y: number }[];
  /** Console footprints from the `Consoles` tile layer — each connected
   *  cluster of marker tiles becomes one console (bounding box, tile coords).
   *  Each bomberman is assigned a trio of these per match (by index). */
  consoleSpots: { x: number; y: number; w: number; h: number }[];
  doors: { id: number; tiles: { x: number; y: number }[]; orientation: 'horizontal' | 'vertical' }[];
  tutorial?: {
    bot1: { x: number; y: number };
    bot2: { x: number; y: number };
    bot2Path: { x: number; y: number };
  };
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
 * Global chunk origin — the min chunk (x,y) across ALL tile layers, in tile
 * units. Used to rebase chunked coords into a zero-based grid. Using a
 * global (rather than per-layer) origin keeps all layers aligned to the
 * same coordinate space, so layers that only painted chunks at non-zero
 * positions don't get shifted relative to the rest of the map.
 */
let globalMinChunkX = 0;
let globalMinChunkY = 0;
{
  let minX = Infinity, minY = Infinity;
  for (const layer of tileLayers) {
    if (!layer.chunks) continue;
    for (const c of layer.chunks) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
    }
  }
  if (Number.isFinite(minX)) globalMinChunkX = minX;
  if (Number.isFinite(minY)) globalMinChunkY = minY;
}

/**
 * Read a gid from a tile layer at (tileX, tileY), handling both flat data
 * arrays (fixed-size maps) and chunked arrays (infinite maps).
 *
 * For chunked layers, (tileX, tileY) are zero-based grid coords relative to
 * the global chunk bounding box. We add the global origin to get absolute
 * Tiled coords, then look up the chunk that contains them.
 */
function readGid(layer: TiledTileLayer, tileX: number, tileY: number): number {
  if (layer.data) {
    // Flat data — tileX/tileY are relative to (0,0).
    const idx = tileY * mapW + tileX;
    return layer.data[idx] ?? 0;
  }
  if (layer.chunks) {
    const absX = tileX + globalMinChunkX;
    const absY = tileY + globalMinChunkY;
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

const GID_FLIP_MASK = 0x0fffffff;

function stripGidFlags(gid: number): number {
  return gid & GID_FLIP_MASK;
}

function isTruthyProperty(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function isSeeThroughName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_\-\s]/g, '');
  return normalized === 'seethrough' || normalized === 'seetrough';
}

function hasTruthySeeThrough(properties: TiledProperty[] | undefined): boolean {
  return (properties ?? []).some(prop => isSeeThroughName(prop.name) && isTruthyProperty(prop.value));
}

function extractXmlAttr(attrs: string, attrName: string): string | undefined {
  const match = new RegExp(`\\b${attrName}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

function extractSeeThroughLocalIdsFromTsx(text: string): number[] {
  const ids: number[] = [];
  const tileRe = /<tile\b([^>]*)>([\s\S]*?)<\/tile>/g;
  for (const tileMatch of text.matchAll(tileRe)) {
    const id = Number(extractXmlAttr(tileMatch[1], 'id'));
    if (!Number.isFinite(id)) continue;

    const body = tileMatch[2];
    const propertyRe = /<property\b([^>]*)\/?>/g;
    for (const propertyMatch of body.matchAll(propertyRe)) {
      const name = extractXmlAttr(propertyMatch[1], 'name');
      if (!name || !isSeeThroughName(name)) continue;
      const value = extractXmlAttr(propertyMatch[1], 'value') ?? true;
      if (isTruthyProperty(value)) {
        ids.push(id);
        break;
      }
    }
  }
  return ids;
}

function collectSeeThroughGids(tilesets: TiledTileset[]): Set<number> {
  const gids = new Set<number>();
  for (const tileset of tilesets) {
    for (const tile of tileset.tiles ?? []) {
      if (hasTruthySeeThrough(tile.properties)) {
        gids.add(tileset.firstgid + tile.id);
      }
    }

    if (!tileset.source) continue;
    const tsxPath = join(dirname(inputPath), String(tileset.source));
    if (!existsSync(tsxPath)) continue;
    try {
      const text = readFileSync(tsxPath, 'utf8');
      for (const localId of extractSeeThroughLocalIdsFromTsx(text)) {
        gids.add(tileset.firstgid + localId);
      }
    } catch (err) {
      console.warn(`  ⚠ failed to read seeThrough properties from ${tileset.source}:`, err);
    }
  }
  return gids;
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
  originPixelX = globalMinChunkX * ts;
  originPixelY = globalMinChunkY * ts;
  console.log(`Origin offset: (${originPixelX}, ${originPixelY}) pixels = (${globalMinChunkX}, ${globalMinChunkY}) tiles`);
}

// Build the walkability grid
const grid: number[][] = [];
const seeThroughTiles: { x: number; y: number }[] = [];

const collisionLayer = tileLayers.find(l => l.name.toLowerCase() === 'collision');
const seeThroughGids = collectSeeThroughGids(tiled.tilesets);

if (collisionLayer) {
  // Mode 1: Collision layer. Any non-zero gid = wall (1), zero = floor (0).
  console.log(`Using Collision layer for walkability`);
  const entireLayerSeeThrough = hasTruthySeeThrough(collisionLayer.properties);
  for (let row = 0; row < finalH; row++) {
    const gridRow: number[] = [];
    for (let col = 0; col < finalW; col++) {
      const gid = readGid(collisionLayer, col, row);
      if (gid === 0) {
        gridRow.push(0);
        continue;
      }
      gridRow.push(1);
      const baseGid = stripGidFlags(gid);
      if (entireLayerSeeThrough || seeThroughGids.has(baseGid)) {
        seeThroughTiles.push({ x: col, y: row });
      }
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
if (seeThroughTiles.length > 0) {
  console.log(`See-through collision tiles: ${seeThroughTiles.length}`);
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

/**
 * Convert ellipse (circle) objects to tile-center coordinates. Each circle
 * becomes one tile coord, picked from the ellipse's bounding-box center.
 * Used for the Keys object layer per docs/keys-system.md §8.
 */
function ellipseLayerToTiles(layer: TiledObjectLayer | undefined): { x: number; y: number }[] {
  if (!layer) return [];
  const seen = new Set<string>();
  const out: { x: number; y: number }[] = [];
  for (const o of layer.objects) {
    if (!o.ellipse) continue;
    const cxPx = o.x + o.width / 2;
    const cyPx = o.y + o.height / 2;
    const t = toTile(cxPx, cyPx);
    const key = `${t.x},${t.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: t.x, y: t.y });
  }
  return out;
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
// Chest zones — unified into a single type-agnostic list. The preferred
// Tiled layer is `ChestZones`; the legacy split layers (Chest1Zones /
// Chest2Zones plus their older aliases) are merged in for back-compat
// until all maps are re-authored.
const chestZones = [
  ...rectLayerToZones(findObjectLayer('ChestZones')),
  ...rectLayerToZones(findObjectLayer('Chest1Zones', 'CoinZones', 'GoodiesZones', 'GoodieZones')),
  ...rectLayerToZones(findObjectLayer('Chest2Zones', 'BombZones', 'TurretZones')),
];

console.log(`\nSpawns: ${spawns.length}${spawns.length > 0 ? ' → ' + spawns.map(s => `(${s.x},${s.y})`).join(', ') : ''}`);
console.log(`EscapeTiles: ${escapeTiles.length}${escapeTiles.length > 0 ? ' → ' + escapeTiles.map(e => `(${e.x},${e.y})`).join(', ') : ''}`);
console.log(`ChestZones: ${chestZones.length}`);

const keySpawns = ellipseLayerToTiles(findObjectLayer('Keys'));
console.log(`Keys: ${keySpawns.length}${keySpawns.length > 0 ? ' → ' + keySpawns.map(k => `(${k.x},${k.y})`).join(', ') : ''}`);

// Scan the "Objects2" tile layer — every painted tile is a candidate spot for
// a random decorative object. The game spawns a fraction of these per match,
// rendered from disguise_objects.png just like a disguised Bomberman. Only the
// candidate positions matter here; which object (frame) appears is rolled at
// runtime. The layer itself is stripped from the public visual .tmj below so
// the raw marker tiles never render.
const decorLayer = tileLayers.find(l => l.name.toLowerCase() === 'objects2');
const decorSpots: { x: number; y: number }[] = [];
if (decorLayer) {
  for (let row = 0; row < finalH; row++) {
    for (let col = 0; col < finalW; col++) {
      if (readGid(decorLayer, col, row) !== 0) decorSpots.push({ x: col, y: row });
    }
  }
  console.log(`Decor spots (Objects2): ${decorSpots.length}`);
} else {
  console.log('Decor spots: 0 (no "Objects2" tile layer found)');
}

// Scan the "Consoles" tile layer — each connected cluster of painted marker
// tiles (typically 2×2: a 32×32 px console on the 16 px grid) becomes ONE
// console, emitted as its bounding box. At runtime each bomberman is
// assigned a seeded trio of these (by index); the game renders consoles.png
// over the footprint (frame 1 = active for that player, frame 0 = inactive).
// The marker layer is stripped from the public visual .tmj below so raw
// tiles never render. Footprint tiles are expected to be solid in the
// Collision layer — players interact from the surrounding ring of tiles.
const consoleLayer = tileLayers.find(l => l.name.toLowerCase() === 'consoles');
const consoleSpots: { x: number; y: number; w: number; h: number }[] = [];
if (consoleLayer) {
  const markerTiles = new Set<string>();
  for (let row = 0; row < finalH; row++) {
    for (let col = 0; col < finalW; col++) {
      if (readGid(consoleLayer, col, row) !== 0) markerTiles.add(`${col},${row}`);
    }
  }
  const visitedConsoles = new Set<string>();
  for (const key of markerTiles) {
    if (visitedConsoles.has(key)) continue;
    const [sx, sy] = key.split(',').map(Number);
    const group: { x: number; y: number }[] = [];
    const queue = [{ x: sx, y: sy }];
    visitedConsoles.add(key);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      group.push(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${cur.x + dx},${cur.y + dy}`;
        if (markerTiles.has(nk) && !visitedConsoles.has(nk)) {
          visitedConsoles.add(nk);
          queue.push({ x: cur.x + dx, y: cur.y + dy });
        }
      }
    }
    const minX = Math.min(...group.map(t => t.x));
    const minY = Math.min(...group.map(t => t.y));
    const maxX = Math.max(...group.map(t => t.x));
    const maxY = Math.max(...group.map(t => t.y));
    consoleSpots.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  // Stable order so per-match seeded assignment is deterministic across runs.
  consoleSpots.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of consoleSpots) {
    for (let yy = c.y; yy < c.y + c.h; yy++) {
      for (let xx = c.x; xx < c.x + c.w; xx++) {
        if (grid[yy]?.[xx] === 0) {
          console.warn(`⚠ Console footprint tile (${xx},${yy}) is walkable — expected solid Collision under consoles.`);
        }
      }
    }
  }
  console.log(`Consoles: ${consoleSpots.length}${consoleSpots.length > 0 ? ' → ' + consoleSpots.map(c => `(${c.x},${c.y} ${c.w}x${c.h})`).join(', ') : ''}`);
} else {
  console.log('Consoles: 0 (no "Consoles" tile layer found)');
}

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

// Optional Tutorial object layer — parses named point objects Tutorial_Bot1,
// Tutorial_Bot2, Tutorial_Bot_Path. Only emitted when all three are present.
let tutorial: BombermanMap['tutorial'];
const tutorialLayer = findObjectLayer('Tutorial');
if (tutorialLayer) {
  const byName = new Map<string, { x: number; y: number }>();
  for (const obj of tutorialLayer.objects) {
    if (!obj.point) continue;
    byName.set(obj.name, toTile(obj.x, obj.y));
  }
  const b1 = byName.get('Tutorial_Bot1');
  const b2 = byName.get('Tutorial_Bot2');
  const bp = byName.get('Tutorial_Bot_Path');
  if (b1 && b2 && bp) {
    tutorial = { bot1: b1, bot2: b2, bot2Path: bp };
    console.log(`Tutorial: bot1 (${b1.x},${b1.y}), bot2 (${b2.x},${b2.y}), path→(${bp.x},${bp.y})`);
  } else {
    const missing = ['Tutorial_Bot1', 'Tutorial_Bot2', 'Tutorial_Bot_Path']
      .filter(n => !byName.has(n));
    console.warn(`⚠ Tutorial layer present but missing points: ${missing.join(', ')}`);
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
  ...(seeThroughTiles.length > 0 ? { seeThroughTiles } : {}),
  spawns,
  escapeTiles,
  chestZones,
  keySpawns,
  decorSpots,
  consoleSpots,
  doors,
  ...(tutorial ? { tutorial } : {}),
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
  const patched = JSON.parse(raw) as TiledMap & { tilesets: Array<{ image?: string; source?: string; name?: string; [k: string]: unknown }> };

  // Inline external .tsx tilesets by reading them from disk and folding
  // their metadata into the patched tmj. Phaser can't resolve external
  // tileset references on its own, so we turn each one into an embedded
  // entry. Tiny regex parse — a full XML parser is overkill for a
  // 3-to-10-line tsx file.
  const inlinedTilesets: typeof patched.tilesets = [];
  for (const ts of patched.tilesets) {
    if (!ts.source) {
      inlinedTilesets.push(ts);
      continue;
    }
    const tsxPath = join(dirname(inputPath), String(ts.source));
    if (!existsSync(tsxPath)) {
      console.warn(`  ⚠ external tileset not found, dropping: ${ts.source}`);
      continue;
    }
    try {
      const text = readFileSync(tsxPath, 'utf8');
      const nameMatch = /name="([^"]+)"/.exec(text);
      const twMatch = /tilewidth="(\d+)"/.exec(text);
      const thMatch = /tileheight="(\d+)"/.exec(text);
      const tcMatch = /tilecount="(\d+)"/.exec(text);
      const colMatch = /columns="(\d+)"/.exec(text);
      const marginMatch = /margin="(\d+)"/.exec(text);
      const spacingMatch = /spacing="(\d+)"/.exec(text);
      const imgMatch = /<image[^>]*\bsource="([^"]+)"/.exec(text);
      const imgWMatch = /<image[^>]*\bwidth="(\d+)"/.exec(text);
      const imgHMatch = /<image[^>]*\bheight="(\d+)"/.exec(text);
      if (!imgMatch) {
        console.warn(`  ⚠ external tileset has no <image>, dropping: ${ts.source}`);
        continue;
      }
      inlinedTilesets.push({
        firstgid: ts.firstgid as number,
        name: nameMatch?.[1] ?? String(ts.source).replace(/\.tsx$/i, ''),
        image: imgMatch[1],
        tilewidth: twMatch ? Number(twMatch[1]) : 16,
        tileheight: thMatch ? Number(thMatch[1]) : 16,
        tilecount: tcMatch ? Number(tcMatch[1]) : undefined,
        columns: colMatch ? Number(colMatch[1]) : undefined,
        margin: marginMatch ? Number(marginMatch[1]) : 0,
        spacing: spacingMatch ? Number(spacingMatch[1]) : 0,
        imagewidth: imgWMatch ? Number(imgWMatch[1]) : undefined,
        imageheight: imgHMatch ? Number(imgHMatch[1]) : undefined,
      });
      console.log(`  inlined external tileset: ${ts.source} → ${imgMatch[1]} (firstgid ${ts.firstgid})`);
    } catch (e) {
      console.warn(`  ⚠ failed to inline ${ts.source}, dropping:`, e);
    }
  }
  // Uniquify tileset names — Tiled sometimes saves the same image twice
  // (e.g. an embedded copy + an external .tsx that also got inlined here).
  // Phaser keys tilesets by name internally, so duplicate names clobber
  // each other's firstgid bindings. We keep all ranges but suffix dup
  // names with the firstgid so each entry is uniquely addressable.
  const seenTilesetNames = new Set<string>();
  patched.tilesets = inlinedTilesets.map(ts => {
    const nm = String(ts.name ?? ts.image ?? '');
    if (!nm || !seenTilesetNames.has(nm)) {
      if (nm) seenTilesetNames.add(nm);
      return ts;
    }
    const unique = `${nm}_${ts.firstgid}`;
    console.log(`  renaming duplicate tileset "${nm}" → "${unique}" (firstgid ${ts.firstgid})`);
    seenTilesetNames.add(unique);
    return { ...ts, name: unique };
  });
  // Strip data-only tile layers (Collision, Doors) — their tiles may
  // reference stripped tilesets and Phaser crashes trying to resolve them.
  if (patched.layers) {
    const stripLayers = (layers: Array<{ name?: string; type?: string; layers?: unknown[] }>): void => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        const ln = (l.name ?? '').toLowerCase();
        // `Objects2` is a marker-only layer (decor candidate spots); the game
        // spawns its own random subset at runtime, so it must not render here.
        // `Consoles` is likewise marker-only (console candidate spots).
        if (l.type === 'tilelayer' && (ln === 'doors' || ln === 'objects2' || ln === 'consoles')) {
          console.log(`  stripping data-only tile layer: ${l.name}`);
          layers.splice(i, 1);
        } else if (l.type === 'group' && l.layers) {
          stripLayers(l.layers as typeof layers);
        }
      }
    };
    stripLayers(patched.layers as Array<{ name?: string; type?: string; layers?: unknown[] }>);
  }

  // Zero-shift chunks so Phaser renders the visual map from world (0,0),
  // aligned with the JSON's zero-based game-logic grid. We subtract the
  // global min chunk (x,y) from every chunk's (x,y). Source tmj is
  // untouched — only this public copy is normalized.
  if (isInfinite && patched.layers) {
    let minChunkX = Infinity, minChunkY = Infinity;
    const walkForMin = (layers: TiledLayer[]): void => {
      for (const l of layers) {
        if (l.type === 'tilelayer' && l.chunks) {
          for (const c of l.chunks) {
            minChunkX = Math.min(minChunkX, c.x);
            minChunkY = Math.min(minChunkY, c.y);
          }
        } else if (l.type === 'group') {
          walkForMin((l as TiledGroupLayer).layers);
        }
      }
    };
    walkForMin(patched.layers as TiledLayer[]);
    const shiftX = Number.isFinite(minChunkX) ? minChunkX : 0;
    const shiftY = Number.isFinite(minChunkY) ? minChunkY : 0;
    // Zero-shift every chunk, then pin EVERY tile layer to a common origin
    // (startx/starty = 0) and the full map size. Tiled writes each layer's
    // startx/starty as that layer's OWN minimum chunk, and Phaser renders an
    // infinite layer's chunks relative to its own startx. When layers cover
    // different regions — e.g. the ground layer was extended into negative
    // coords for a border but the collision/decoration layers weren't — they
    // end up with different startx and render offset from each other by the
    // difference. Forcing a shared origin puts every chunk in the same
    // coordinate space as the JSON game-logic grid, so visuals line up with
    // collision/spawns regardless of per-layer painted extent.
    const normalizeLayers = (layers: Array<Record<string, unknown>>): void => {
      for (const l of layers) {
        if (l.type === 'tilelayer') {
          if (Array.isArray(l.chunks)) {
            for (const c of l.chunks as Array<{ x: number; y: number }>) {
              c.x -= shiftX;
              c.y -= shiftY;
            }
          }
          l.startx = 0;
          l.starty = 0;
          l.width = finalW;
          l.height = finalH;
        }
        if (l.type === 'group' && Array.isArray(l.layers)) {
          normalizeLayers(l.layers as Array<Record<string, unknown>>);
        }
      }
    };
    normalizeLayers(patched.layers as Array<Record<string, unknown>>);
    // The header copied from the source .tmj still carries the old/viewport
    // dimensions; correct it so Phaser sizes the map to the true extent.
    (patched as { width: number; height: number }).width = finalW;
    (patched as { width: number; height: number }).height = finalH;
    console.log(`  normalized visual layers to origin (0,0), ${finalW}x${finalH} (chunk shift -${shiftX},-${shiftY})`);
  }

  const copiedPngs = new Set<string>();
  const copiedTsxs = new Set<string>();
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
    } else if (tsEntry.source) {
      // External .tsx tileset — copy both the .tsx and the PNG it references
      // so the client's runtime preloader can fetch them from public/maps/.
      // The runtime parser (MapRenderer.preloadTiledMap) reads `<image source>`
      // from the .tsx, so the regex applied here must match that one.
      const tsxSource = String(tsEntry.source);
      const tsxName = tsxSource.split(/[\\/]/).pop() ?? '';
      const srcTsx = join(dirname(inputPath), tsxSource);
      const dstTsx = join(publicMapsDir, tsxName);
      if (existsSync(srcTsx) && !copiedTsxs.has(tsxName)) {
        try {
          copyFileSync(srcTsx, dstTsx);
          copiedTsxs.add(tsxName);
          console.log(`  synced external tileset: ${tsxName}`);
          // Also copy the referenced PNG to public/maps/. The .tsx writes
          // the image path relative to its own directory.
          const tsxText = readFileSync(srcTsx, 'utf-8');
          const imgMatch = /<image[^>]*\bsource="([^"]+)"/.exec(tsxText);
          if (imgMatch) {
            const tsxImgRel = imgMatch[1];
            const tsxImgName = tsxImgRel.split(/[\\/]/).pop() ?? '';
            const srcTsxImg = join(dirname(srcTsx), tsxImgRel);
            const dstTsxImg = join(publicMapsDir, tsxImgName);
            if (existsSync(srcTsxImg) && !copiedPngs.has(tsxImgName)) {
              try {
                copyFileSync(srcTsxImg, dstTsxImg);
                copiedPngs.add(tsxImgName);
                console.log(`  synced tileset image: ${tsxImgName} (from ${tsxName})`);
              } catch (err) {
                console.warn(`  ⚠ failed to copy ${srcTsxImg} → ${dstTsxImg}:`, err);
              }
            } else if (!existsSync(srcTsxImg)) {
              console.warn(`  ⚠ tsx image not found on disk: ${srcTsxImg}`);
            }
          } else {
            console.warn(`  ⚠ tsx has no <image source>: ${srcTsx}`);
          }
        } catch (err) {
          console.warn(`  ⚠ failed to publish external tileset ${srcTsx}:`, err);
        }
      } else if (!existsSync(srcTsx)) {
        console.warn(`  ⚠ external tileset not found on disk: ${srcTsx}`);
      }
      // Flatten the source path so the patched .tmj references just the
      // basename — matches the embedded-image branch above.
      tsEntry.source = tsxName;
    }
  }
  const publicTmjPath = join(publicMapsDir, `${mapId}.tmj`);
  writeFileSync(publicTmjPath, JSON.stringify(patched));
  console.log(`✓ Synced tmj to: ${publicTmjPath}`);
} else {
  console.warn(`⚠ public/ not found — not syncing tmj for runtime`);
}
