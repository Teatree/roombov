/**
 * Tiled .tmj → Roombov map JSON converter
 *
 * Usage:  npx tsx tools/tiled-to-roombov.ts src/shared/maps/custom_map1.tmj
 * Output: src/shared/maps/custom_map1.json
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

// ------- Roombov output types -------

interface RoombovMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  grid: number[][];
  spawns: { id: number; x: number; y: number; edge: string }[];
  exits: { id: number; x: number; y: number; type: string }[];
  turrets: never[]; // not used anymore — runtime randomization
  goodies: never[]; // not used anymore — runtime randomization
  turretZones: { x: number; y: number; w: number; h: number }[];
  goodieZones: { x: number; y: number; w: number; h: number }[];
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

// 1. Convert tile layer → 2D grid
const tileLayer = tiled.layers.find(l => l.type === 'tilelayer') as TiledTileLayer | undefined;
if (!tileLayer) { console.error('No tile layer found'); process.exit(1); }

const grid: number[][] = [];
for (let row = 0; row < mapH; row++) {
  const gridRow: number[] = [];
  for (let col = 0; col < mapW; col++) {
    const gid = tileLayer.data[row * mapW + col];
    const tileId = gid - firstGid; // 0=floor, 1=wall, 2=door, 3=furniture
    gridRow.push(Math.max(0, tileId));
  }
  grid.push(gridRow);
}

// Helper: snap pixel coord to tile, then nudge to nearest walkable tile
function toTile(px: number, py: number): { x: number; y: number } {
  let tx = Math.floor(px / ts);
  let ty = Math.floor(py / ts);
  tx = Math.max(0, Math.min(mapW - 1, tx));
  ty = Math.max(0, Math.min(mapH - 1, ty));

  // If on a wall, search nearby for a floor tile
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

function detectEdge(tx: number, ty: number): string {
  if (ty <= 2) return 'north';
  if (ty >= mapH - 3) return 'south';
  if (tx <= 2) return 'west';
  if (tx >= mapW - 3) return 'east';
  return 'north'; // fallback
}

function detectExitType(tx: number, ty: number): string {
  if (tx <= 2 || tx >= mapW - 3 || ty <= 2 || ty >= mapH - 3) return 'edge';
  return 'interior';
}

// 2. Convert spawn points
const spawnsLayer = tiled.layers.find(l => l.type === 'objectgroup' && l.name === 'Spawns') as TiledObjectLayer | undefined;
const spawns = (spawnsLayer?.objects ?? [])
  .filter(o => o.point)
  .map((o, i) => {
    const t = toTile(o.x, o.y);
    return { id: i, x: t.x, y: t.y, edge: detectEdge(t.x, t.y) };
  });

console.log(`Spawns: ${spawns.length}`);

// 3. Convert exits
const exitsLayer = tiled.layers.find(l => l.type === 'objectgroup' && l.name === 'Exits') as TiledObjectLayer | undefined;
const exits = (exitsLayer?.objects ?? [])
  .filter(o => o.point)
  .map((o, i) => {
    const t = toTile(o.x, o.y);
    return { id: i, x: t.x, y: t.y, type: detectExitType(t.x, t.y) };
  });

console.log(`Exits: ${exits.length}`);

// 4. Convert turret zones (rectangles → tile bounds)
const turretLayer = tiled.layers.find(l => l.type === 'objectgroup' && l.name === 'TurretZones') as TiledObjectLayer | undefined;
const turretZones = (turretLayer?.objects ?? [])
  .filter(o => o.width > 0 && o.height > 0)
  .map(o => ({
    x: Math.floor(o.x / ts),
    y: Math.floor(o.y / ts),
    w: Math.ceil(o.width / ts),
    h: Math.ceil(o.height / ts),
  }));

console.log(`Turret zones: ${turretZones.length}`);

// 5. Convert goodie zones (ellipses → bounding-box tile bounds)
const goodieLayer = tiled.layers.find(l => l.type === 'objectgroup' && l.name === 'GoodiesZones') as TiledObjectLayer | undefined;
const goodieZones = (goodieLayer?.objects ?? [])
  .filter(o => o.width > 0 && o.height > 0)
  .map(o => ({
    x: Math.floor(o.x / ts),
    y: Math.floor(o.y / ts),
    w: Math.ceil(o.width / ts),
    h: Math.ceil(o.height / ts),
  }));

console.log(`Goodie zones: ${goodieZones.length}`);

// 6. Build output
const mapId = basename(inputPath, '.tmj');
const output: RoombovMap = {
  id: mapId,
  name: mapId.replace(/[-_]/g, ' '),
  width: mapW,
  height: mapH,
  tileSize: ts,
  grid,
  spawns,
  exits,
  turrets: [],
  goodies: [],
  turretZones,
  goodieZones,
};

const outPath = join(dirname(inputPath), `${mapId}.json`);
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWritten: ${outPath}`);
console.log('Grid sample (top-left 5x5):');
for (let r = 0; r < 5; r++) {
  console.log('  ' + grid[r].slice(0, 5).join(' '));
}
