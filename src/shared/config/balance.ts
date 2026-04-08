/**
 * Central tuning constants for the Bomberman core.
 *
 * All gameplay values live here and should be editable without touching logic
 * code. As new systems come online (shops, bombs, matches) each gets its own
 * section.
 */

export const BALANCE = {
  map: {
    tileSize: 32,
  },
  lobby: {
    visibleMatches: 3,
    matchIntervalSeconds: 5,
    countdownDuration: 30,
    maxPlayersPerMatch: 4,
    // Dev: allow solo matches so you can test controls without a second tab.
    // Raise back to 2 before shipping.
    minPlayersToStart: 1,
  },
  match: {
    turnLimit: 50,
    turnsLeftWarning: 10,
    inputPhaseSeconds: 2,
    transitionPhaseSeconds: 1,
    /** Minimum tile distance between spawning Bombermen (falls back if impossible). */
    minSpawnDistance: 5,
    bombermanMaxHp: 2,
    bleedingDurationTurns: 3,
    bombSlotStackLimit: 5,
    /** Tile radius for per-player line-of-sight fog of war. */
    losRadius: 5,
  },
  player: {
    /** Coins granted to a brand-new profile. */
    startingCoins: 500,
    /** Hard cap on how many Bombermen a player can own at once. */
    ownedBombermenCap: 5,
  },
} as const;
