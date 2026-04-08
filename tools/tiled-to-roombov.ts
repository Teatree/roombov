/**
 * Tiled .tmj → Bomberman map JSON converter.
 *
 * Usage:  npx tsx tools/tiled-to-roombov.ts src/shared/maps/custom_map1.tmj
 * Output: src/shared/maps/custom_map1.json
 *
 * Recognized object layers (in order of preference; aliases allow migration
 * from the old Roombov maps without touching Tiled files):
 *  - Spawns        → SpawnPoint[]
 *  - EscapeTiles   (alias: Exits) → EscapeTile[]
 *  - BombZones     (alias: TurretZones) → Zone[]
 *  - CoinZones     (alias: GoodiesZones, GoodieZones) → Zone[]
 *
 * Tile layer: grid int = (gid - firstGid), clamped to 0. Mapping:
 *   0=floor, 1=wall, 2=door, 3=furniture
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

// ------- Tiled types (subset) -------

interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: { firstgid: number }[];
  layers: TiledLayer[];
}

type TiledLayer = TiledTileLayer | TiledObjectLayer;

interface TiledTileLayer {
  type: 'tilelayer';
  name: string;
  data: number[];
  width: number;
  height: number;
}

interface TiledObjectLayer {
  type: 'objectgroup';
  name: string;
  objects: TiledObject[];
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

// ------- Bomberman output schema -------

interface BombermanMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  grid: number[][];
  spawns: { id: number; x: number; y: number }[];
  escapeTiles: { id: number; x: number; y: number }[];
  coinZones: { x: number; y: number; w: number; h: number }[];
  bombZones: { x: number; y: number; w: number; h: number }[];
}

// ------- Main -------

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx tools/tiled-to-roombov.ts <path-to-tmj>');
  process.exit(1);
}

const raw = readFileSync(inputPath, 'utf-8');
const tiled: TiledMap = JSON.parse(raw);
const firstGid = tiled.tilesets[0]?.firstgid ?? 1;
const ts = tiled.tilewidth;
const mapW = tiled.width;
const mapH = tiled.height;

console.log(`Map: ${mapW}x${mapH}, tileSize: ${ts}, firstGid: ${firstGid}`);

// Tile layer → 2D grid
const tileLayer = tiled.layers.find((l): l is TiledTileLayer => l.type === 'tilelayer');
if (!tileLayer) { console.error('No tile layer found'); process.exit(1); }

const grid: number[][] = [];
for (let row = 0; row < mapH; row++) {
  const gridRow: number[] = [];
  for (let col = 0; col < mapW; col++) {
    const gid = tileLayer.data[row * mapW + col];
    const tileId = gid - firstGid;
    gridRow.push(Math.max(0, tileId));
  }
  grid.push(gridRow);
}

function findObjectLayer(...names: string[]): TiledObjectLayer | undefined {
  for (const name of names) {
    const l = tiled.layers.find((layer): layer is TiledObjectLayer =>
      layer.type === 'objectgroup' && layer.name === name,
    );
    if (l) return l;
  }
  return undefined;
}

function toTile(px: number, py: number): { x: number; y: number } {
  let tx = Math.floor(px / ts);
  let ty = Math.floor(py / ts);
  tx = Math.max(0, Math.min(mapW - 1, tx));
  ty = Math.max(0, Math.min(mapH - 1, ty));
  if (grid[ty][tx] !== 0) {
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = ty + dy;
          const nx = tx + dx;
          if (ny >= 0 && ny < mapH && nx >= 0 && nx < mapW && grid[ny][nx] === 0) {
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
      x: Math.floor(o.x / ts),
      y: Math.floor(o.y / ts),
      w: Math.ceil(o.width / ts),
      h: Math.ceil(o.height / ts),
    }));
}

const spawns = pointLayerToTiles(findObjectLayer('Spawns'));
const escapeTiles = pointLayerToTiles(findObjectLayer('EscapeTiles', 'Exits'));
const bombZones = rectLayerToZones(findObjectLayer('BombZones', 'TurretZones'));
const coinZones = rectLayerToZones(findObjectLayer('CoinZones', 'GoodiesZones', 'GoodieZones'));

console.log(`Spawns: ${spawns.length}`);
console.log(`EscapeTiles: ${escapeTiles.length}`);
console.log(`BombZones: ${bombZones.length}`);
console.log(`CoinZones: ${coinZones.length}`);

const mapId = basename(inputPath, '.tmj');
const output: BombermanMap = {
  id: mapId,
  name: mapId.replace(/[-_]/g, ' '),
  width: mapW,
  height: mapH,
  tileSize: ts,
  grid,
  spawns,
  escapeTiles,
  coinZones,
  bombZones,
};

const outPath = join(dirname(inputPath), `${mapId}.json`);
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWritten: ${outPath}`);
