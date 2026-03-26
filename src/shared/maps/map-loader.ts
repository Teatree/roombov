import type { MapData } from '../types/map.ts';
import { MAP_MANIFEST } from './map-manifest.ts';

export function loadMap(json: unknown): MapData {
  const data = json as MapData;
  if (!data.id || !data.grid || !data.spawns || !data.exits) {
    throw new Error('Invalid map data: missing required fields');
  }
  return data;
}

/** Lazy-load all .json map files via Vite glob */
const mapModules = import.meta.glob('./*.json', { eager: false }) as Record<string, () => Promise<{ default: unknown }>>;

/** Load a map by its manifest ID */
export async function loadMapById(mapId: string): Promise<MapData> {
  const entry = MAP_MANIFEST.find(m => m.id === mapId);
  if (!entry) throw new Error(`Unknown map ID: ${mapId}`);

  const modulePath = `./${entry.filename}`;
  const loader = mapModules[modulePath];
  if (!loader) throw new Error(`Map file not bundled: ${entry.filename}`);

  const module = await loader();
  return loadMap(module.default);
}
