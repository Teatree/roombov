/** Mulberry32 PRNG — fast, deterministic, good distribution */
export function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → unsigned 32-bit int, suitable as a `createSeededRandom`
 *  seed. Deterministic across client and server for a given string. */
export function hashStringToInt(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded integer in range [min, max) */
export function seededRandInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min));
}

/** Seeded Fisher-Yates shuffle (returns new array) */
export function seededShuffle<T>(rng: () => number, arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
