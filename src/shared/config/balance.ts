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
    // Minimum countdown for the first card in the carousel; subsequent cards
    // are staggered by MatchScheduler.MIN_STAGGER_MS so the second is ≥20s,
    // third is ≥30s, etc.
    countdownDuration: 10,
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
    /**
     * Hard upper bound on stack size across all tiers — used in defensive
     * fallbacks where a per-Bomberman context isn't available. Per-Bomberman
     * `stackSize` is rolled in `TIER_CONFIG[tier].stackSizeRange` and is the
     * primary value loot/equip validation reads from.
     */
    bombSlotStackLimit: 10,
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
    /** Shield Bomb: how many full turns the wall stands AFTER the placement turn. */
    shieldDurationTurns: 3,
  },
  keys: {
    /** Number of keys placed in chests at the start of each match. Post
     *  NEW_META (2026-05-16) these are distributed across spawned chests
     *  by tier weight rather than on the map floor — see docs/NEW_META.md §4. */
    totalOnMap: 15,
    /** Keys needed to use an escape hatch. Also the per-bomberman carry cap. */
    requiredPerHatch: 3,
    /** Tutorial-only override: hatch unlock requirement AND carry cap.
     *  Used when state.isTutorial === true. See docs/NEW_META.md §7. */
    tutorialRequiredPerHatch: 1,
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
  /**
   * Per-Bomberman SP (Skill Points) economy + upgrade costs.
   *
   * SP is earned in-match by the Bomberman who scored the action; it banks
   * to the OwnedBomberman on escape and is lost on death (no body transfer).
   *
   * Tuning target (Phase 6): cheapest upgrade ≈ 2 average matches of SP,
   * most expensive ≈ 15. With the rewards below a "decent" extraction is
   * ~80 SP (2 chests + 1 kill + 25 turns survived = 10 + 50 + 5).
   *
   * Per-tier cost arrays are indexed by 0-based tier (i.e. costs[0] is the
   * cost of going from 0 tiers applied → 1 tier applied). Each tier carries
   * its own SP + coin + treasure cost. Treasure type is fixed per track.
   */
  upgrades: {
    sp: {
      /** First time a Bomberman opens (auto-loots) a chest. */
      perChestOpen: 5,
      /** Awarded on confirmed player-Bomberman kill (last hitter). */
      perPlayerKill: 50,
      /** Awarded on confirmed scav kill (last hitter). */
      perScavKill: 25,
      /** +1 SP per N turns the Bomberman is alive in-match. */
      perSurvivalTurns: 5,
    },
    // Calibration:
    //   avg extraction ≈ 65 SP (2 chest opens = 10, 1 player kill = 50,
    //   25 turns survived = 5). Cheapest tier targets ~2 extractions ≈ 130 SP;
    //   most expensive (HP) targets ~15 extractions ≈ 975 SP.
    cap: {
      /** Per-Bomberman upgrade slots available. */
      maxTiers: 2,
      /** Hard absolute ceiling on total slots (Rock + custom). */
      totalSlotCap: 8,
      treasure: 'mushrooms' as const,
      /** Cost array, indexed by tier-applied count. */
      tiers: [
        { sp: 160, coins: 350, treasure: 12 },  // ~2.5 games
        { sp: 480, coins: 800, treasure: 25 },  // ~7.4 games
      ] as Array<{ sp: number; coins: number; treasure: number }>,
    },
    stack: {
      maxTiers: 3,
      treasure: 'coffee' as const,
      tiers: [
        { sp: 130, coins: 300, treasure: 8 },   // ~2 games (cheapest)
        { sp: 340, coins: 700, treasure: 18 },  // ~5.2 games
        { sp: 760, coins: 1500, treasure: 38 }, // ~11.7 games
      ] as Array<{ sp: number; coins: number; treasure: number }>,
    },
    hp: {
      maxTiers: 1,
      /** Absolute HP cap. Base HP for all Bombermen is currently 2. */
      cap: 3,
      treasure: 'grapes' as const,
      tiers: [
        { sp: 980, coins: 2200, treasure: 60 }, // ~15 games (most expensive)
      ] as Array<{ sp: number; coins: number; treasure: number }>,
    },
  },
  scavs: {
    /** How many scavs spawn per scheduled spawn wave. */
    perSpawn: 2,
    /** Turns to chase / guess after target leaves LOS. Longer than bots — scavs are persistent. */
    chaseTurns: 6,
    /** Chance (0-1) to throw at predicted next-tile instead of current. */
    predictChance: 0.5,
    /** Chance (0-1) per turn to throw a flare while exploring. */
    flareChance: 0.25,
    /** Consecutive turns an enemy must be visible before scavs aggro. 0 = engage immediately. */
    aggroDelayTurns: 0,
    /** Hard cap on alive scavs at any moment. Spawn wave is clamped to (cap - aliveScavs). */
    maxAlive: 2,
  },
} as const;
