import type { MapData } from '../types/map.ts';
import { MAP_MANIFEST } from './map-manifest.ts';
import testArena from './test_arena.json';

/**
 * Map loading with three resolution strategies, tried in order:
 *
 *   1. Static imports (STATIC_MAPS) — fastest, available in both client and
 *      server, and immune to Vite's glob caching issues. Add new maps here
 *      when they're ready to ship.
 *   2. Vite glob — only populated in the browser. Picks up any map .json in
 *      this folder without needing a code change, handy during iteration.
 *   3. Node fs fallback — only runs on the server, reads from disk.
 */

const STATIC_MAPS: Record<string, MapData> = {
  test_arena: testArena as unknown as MapData,
};

export function loadMap(json: unknown): MapData {
  const data = json as MapData;
  if (!data.id || !data.grid || !data.spawns || !data.escapeTiles) {
    throw new Error('Invalid map data: missing required Bomberman fields (id, grid, spawns, escapeTiles)');
  }
  return data;
}

let mapModules: Record<string, () => Promise<{ default: unknown }>> = {};
if (typeof (import.meta as unknown as { glob?: unknown }).glob === 'function') {
  mapModules = (import.meta as unknown as {
    glob: (p: string, o: { eager: boolean }) => Record<string, () => Promise<{ default: unknown }>>;
  }).glob('./*.json', { eager: false });
}

export async function loadMapById(mapId: string): Promise<MapData> {
  // 1. Static import
  if (STATIC_MAPS[mapId]) return loadMap(STATIC_MAPS[mapId]);

  const entry = MAP_MANIFEST.find(m => m.id === mapId);
  if (!entry) throw new Error(`Unknown map ID: ${mapId}`);

  // 2. Vite glob
  const modulePath = `./${entry.filename}`;
  const loader = mapModules[modulePath];
  if (loader) {
    const module = await loader();
    return loadMap(module.default);
  }

  // 3. Server-side fs fallback
  const { readFile } = await import('fs/promises');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, entry.filename), 'utf-8');
  return loadMap(JSON.parse(raw));
}
