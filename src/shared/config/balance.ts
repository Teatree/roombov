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
    countdownDuration: 5,
    maxPlayersPerMatch: 4,
    // Dev: allow solo matches so you can test controls without a second tab.
    // Raise back to 2 before shipping.
    minPlayersToStart: 1,
  },
  match: {
    turnLimit: 250,
    turnsLeftWarning: 10,
    inputPhaseSeconds: 2,
    transitionPhaseSeconds: 2,
    /** Minimum tile distance between spawning Bombermen (falls back if impossible). */
    minSpawnDistance: 5,
    bombermanMaxHp: 2,
    bleedingDurationTurns: 10,
    bombSlotStackLimit: 5,
    /** Tile radius for per-player line-of-sight fog of war. */
    losRadius: 5,
    /** Out of Combat Rush — move 2 tiles/turn when no enemies are nearby. */
    rush: {
      /** Master toggle for the rush system. */
      enabled: true,
      /**
       * Chebyshev distance to an enemy Bomberman that breaks rush.
       * IMPORTANT: also gated on mutual line-of-sight in TurnResolver —
       * an enemy at 8 tiles with a wall between you does NOT break rush.
       */
      proximityRadius: 8,
      /** Chebyshev distance to a placed bomb that breaks rush. Not LoS-gated —
       *  bombs are loud, you feel them through walls and fog. */
      bombProximityRadius: 8,
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
  // DECAL DECAY — scorch marks, ender pearl decals, and blood splats fade
  // with age measured in turns from the turn they spawned:
  //   age <= fullTurns              → 100% opacity
  //   fullTurns < age < fullTurns + fadeTurns → linearly fades 100% → minOpacity
  //   age >= fullTurns + fadeTurns  → stays at minOpacity forever
  // Default: full for 5 turns, then fades to 50% over the next 20 turns.
  decalDecay: {
    fullTurns: 5,
    fadeTurns: 20,
    minOpacity: 0.5,
  },
  bombs: {
    /** Phosphorus: how many turns the impact-turn reveal lasts. */
    phosphorusRevealTurns: 1,
    /** Phosphorus: how many turns each spawned fire tile burns. */
    phosphorusFireTurns: 2,
    /** Flash: how many turns Stunned status lasts. */
    flashStunTurns: 1,
    /** Visual opacity for the owner's own bomberman inside their smoke. */
    smokePlayerOpacity: 0.65,
    /** Visual opacity for effects (fire/bombs/decals) visible through smoke. */
    smokeFxOpacity: 0.65,
    /** Motion Detector: Chebyshev trigger radius. */
    motionDetectorRadius: 3,
    /** Motion Detector: turns before passive expiry trigger. */
    motionDetectorLifetime: 50,
    /** Fart Escape: how many tiles Bomberman moves toward target on cast. */
    fartEscapeMoveTiles: 2,
    /** Fart Escape: circle radius for the smoke cloud. Bumped from 3 (≈49
     *  tiles) to 5 (≈121 tiles) — roughly doubled area per design request. */
    fartEscapeSmokeRadius: 5,
    /** Fart Escape: how many turns the cloud persists. */
    fartEscapeSmokeTurns: 4,
    /** Cluster Bomb: area dimensions for mine scattering. */
    clusterArea: { w: 11, h: 11 },
    /** Cluster Bomb: attempted mine placements per throw. */
    clusterMineCount: 25,
    /** Client-only: whether bombs visibly shake on the turn before detonation. */
    shakePreDetonation: true,
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
