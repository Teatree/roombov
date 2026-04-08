import type { MapManifestEntry } from '../types/map.ts';

/**
 * Available maps. Matches draw a random one from this list.
 * During the Bomberman pivot we only ship the minimal Test Arena so every
 * match is predictable while the core is being tuned. custom_map1 (the
 * Tiled-authored map) can be re-added once the core feels good.
 */
export const MAP_MANIFEST: MapManifestEntry[] = [
  { id: 'test_arena', name: 'Test Arena', filename: 'test_arena.json' },
];
