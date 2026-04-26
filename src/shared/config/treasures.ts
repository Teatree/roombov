/**
 * Treasure types — the in-match currency picked up from chests and dead
 * bodies. There are 10 types, mapped 1:1 to the 5x2 grid in
 * `public/sprites/treasures.png` (32×32 per icon, top-row left → bottom-row
 * right).
 *
 * Treasures persist into the player's profile on escape (mirroring how coins
 * used to). They are spent at Gambler Street (separate system).
 */

export type TreasureType =
  | 'fish'
  | 'chalice'
  | 'jade'
  | 'books'
  | 'coffee'
  | 'grapes'
  | 'lanterns'
  | 'bones'
  | 'mushrooms'
  | 'amulets';

/** Catalog order — display order in HUD lists, results, profile. */
export const TREASURE_TYPES: readonly TreasureType[] = [
  'fish',
  'chalice',
  'jade',
  'books',
  'coffee',
  'grapes',
  'lanterns',
  'bones',
  'mushrooms',
  'amulets',
];

/** Display name shown in tooltips and dialogue. */
export const TREASURE_DISPLAY_NAMES: Record<TreasureType, string> = {
  fish: 'Fish',
  chalice: 'Chalice',
  jade: 'Jade',
  books: 'Books',
  coffee: 'Coffee',
  grapes: 'Grapes',
  lanterns: 'Lanterns',
  bones: 'Bones',
  mushrooms: 'Mushrooms',
  amulets: 'Amulets',
};

/**
 * Frame index into the 5×2 treasures spritesheet.
 *   row 0 (top):    fish=0, chalice=1, jade=2, books=3, coffee=4
 *   row 1 (bottom): grapes=5, lanterns=6, bones=7, mushrooms=8, amulets=9
 */
export const TREASURE_ICON_INDEX: Record<TreasureType, number> = {
  fish: 0,
  chalice: 1,
  jade: 2,
  books: 3,
  coffee: 4,
  grapes: 5,
  lanterns: 6,
  bones: 7,
  mushrooms: 8,
  amulets: 9,
};

/** Sparse map: type → count. Missing or zero entries mean "none of that type". */
export type TreasureBundle = Partial<Record<TreasureType, number>>;

/** Add `b` into `a` in place. Returns `a` for chaining. */
export function mergeTreasures(a: TreasureBundle, b: TreasureBundle): TreasureBundle {
  for (const t of TREASURE_TYPES) {
    const add = b[t] ?? 0;
    if (add > 0) a[t] = (a[t] ?? 0) + add;
  }
  return a;
}

/** Total count across all types. */
export function totalTreasures(b: TreasureBundle): number {
  let sum = 0;
  for (const t of TREASURE_TYPES) sum += b[t] ?? 0;
  return sum;
}

/** True if the bundle has at least one of any type. */
export function hasAnyTreasure(b: TreasureBundle): boolean {
  for (const t of TREASURE_TYPES) if ((b[t] ?? 0) > 0) return true;
  return false;
}
