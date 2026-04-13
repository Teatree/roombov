/**
 * Bomberman name pools by tier.
 *
 * Each tier draws from a thematic pool:
 *  - free: Irish surnames
 *  - paid: Western/cowboy-style nicknames
 *  - paid_expensive: Greek names
 */

import type { BombermanTier } from '../types/bomberman.ts';

const IRISH_NAMES = [
  "O'Brien", "Murphy", "Kelly", "Sullivan", "Walsh", "Byrne",
  "Ryan", "Doyle", "Quinn", "Brennan", "Gallagher", "Flanagan",
  "Casey", "Duffy", "Malone", "Nolan", "Daly", "Connolly",
  "Kavanagh", "Fitzgerald", "Donnelly", "Moriarty", "Regan", "Hogan",
  "Finnegan", "Callaghan", "Rafferty", "Tierney", "McBride", "Rooney",
  "Delaney", "Shaughnessy", "McGrath", "Maguire", "Foley", "Keegan",
];

const WESTERN_NAMES = [
  'Little Bill', 'Big Jake', 'Dusty', 'Slim', 'Butch', 'Sundance',
  'Kid Colt', 'Doc', 'Hoss', 'Wyatt', 'Calamity', 'Maverick',
  'Trigger', 'Buckshot', 'Rattlesnake', 'Coyote', 'El Diablo',
  'Deadshot', 'Six-Gun', 'Copper', 'Spur', 'Sheriff', 'Preacher',
  'Bandit', 'Rustler', 'Gringo', 'Ringo', 'Vaquero', 'Desperado',
  'Tex', 'Clint', 'Lucky', 'One-Eye', 'Red', 'Whiskey',
];

const GREEK_NAMES = [
  'Achilles', 'Ajax', 'Apollo', 'Ares', 'Atlas', 'Castor',
  'Daedalus', 'Helios', 'Hermes', 'Icarus', 'Jason', 'Leonidas',
  'Midas', 'Nereus', 'Orion', 'Perseus', 'Theseus', 'Zephyr',
  'Athena', 'Artemis', 'Circe', 'Elektra', 'Hera', 'Medusa',
  'Nike', 'Pandora', 'Selene', 'Callisto', 'Phoebe', 'Rhea',
  'Orpheus', 'Prometheus', 'Diomedes', 'Agamemnon', 'Hector', 'Odysseus',
];

const POOLS: Record<BombermanTier, readonly string[]> = {
  free: IRISH_NAMES,
  paid: WESTERN_NAMES,
  paid_expensive: GREEK_NAMES,
};

/** Pick a random name for the given tier using the provided RNG (0-1). */
export function rollBombermanName(tier: BombermanTier, rand: () => number): string {
  const pool = POOLS[tier];
  return pool[Math.floor(rand() * pool.length)];
}
