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
    matchIntervalSeconds: 3,
    // Dev: short countdown for fast iteration. Bump back up before shipping.
    countdownDuration: 8,
    maxPlayersPerMatch: 4,
    // Dev: allow solo matches so you can test controls without a second tab.
    // Raise back to 2 before shipping.
    minPlayersToStart: 1,
  },
  match: {
    turnLimit: 150,
    turnsLeftWarning: 10,
    inputPhaseSeconds: 2,
    transitionPhaseSeconds: 2,
    /** Minimum tile distance between spawning Bombermen (falls back if impossible). */
    minSpawnDistance: 5,
    bombermanMaxHp: 2,
    bleedingDurationTurns: 5,
    bombSlotStackLimit: 5,
    /** Tile radius for per-player line-of-sight fog of war. */
    losRadius: 5,
    /** Out of Combat Rush — move 2 tiles/turn when no enemies are nearby. */
    rush: {
      /** Master toggle for the rush system. */
      enabled: true,
      /** Chebyshev distance to an enemy Bomberman that breaks rush. */
      proximityRadius: 6,
      /** Chebyshev distance to a placed bomb that breaks rush. */
      bombProximityRadius: 6,
      /** Consecutive peaceful turns needed to activate rush. */
      cooldownTurns: 3,
    },
  },
  player: {
    /** Coins granted to a brand-new profile. */
    startingCoins: 500,
    /** Hard cap on how many Bombermen a player can own at once. */
    ownedBombermenCap: 5,
  },
  bots: {
    /** Max bots that can be added to a single match. */
    maxPerMatch: 2,
    /** Only add bots if at least this many real players joined. */
    minPlayersForBots: 1,
    /** Fill the match up to this many total players (real + bot). */
    fillToTotal: 4,
    /** Fraction of match turns elapsed before bots start trying to escape. */
    escapeThreshold: 0.8,
    /** Chance (0-1) per turn to throw a flare while exploring. */
    flareChance: 0.15,
    /** Chance (0-1) to predict enemy movement instead of throwing at current pos. */
    predictChance: 0.33,
    /** Turns to chase / guess after target leaves LOS. */
    chaseTurns: 3,
  },
} as const;
