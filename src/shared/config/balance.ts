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
    // NOTE: The HUD presents the match as a real-time clock, not a turn count.
    // The match still runs on these discrete turns under the hood; the UI just
    // converts turns into minutes:seconds using the per-turn duration
    // (inputPhaseSeconds + transitionPhaseSeconds = one turn). Changing these
    // values therefore changes the displayed clock length too — but no game
    // logic reads the clock. See MatchScene.formatMatchClock.
    inputPhaseSeconds: 1.5,
    transitionPhaseSeconds: 1.5,
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
  /**
   * Idle Actions — what a Bomberman does when it stands still long enough.
   * Drives the three Bomberman classes (see IdleAction in types/bomberman.ts).
   * Attack-on-idle (Ambush Mode) enters on the first idle turn and is governed
   * by the melee-trap logic, not these knobs.
   */
  idleActions: {
    /** Heal class: consecutive idle turns in place before +HP is applied. */
    healIdleTurns: 3,
    /** Heal class: HP restored each time the heal threshold is reached. */
    healAmount: 1,
    /** Disguise class: consecutive idle turns before turning into an object. */
    disguiseIdleTurns: 3,
    /** Number of frames in public/sprites/disguise_objects.png — the disguise
     *  picks a random frame in [0, disguiseObjectCount). */
    disguiseObjectCount: 6,
  },
  /**
   * Decorative map objects (the Tiled `Objects2` candidate layer). Purely
   * visual — rendered client-side from disguise_objects.png so a Disguise-class
   * Bomberman blends in among them. See `MapData.decorSpots`.
   */
  decor: {
    /** Fraction of the map's `decorSpots` candidates that actually spawn each
     *  match (rounded). Selection is seeded by matchId, so all clients agree. */
    spawnFraction: 0.3,
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
    totalOnMap: 12,
    /** Keys needed to use an escape hatch. Also the per-bomberman carry cap. */
    requiredPerHatch: 3,
    /** Tutorial-only override: hatch unlock requirement AND carry cap.
     *  Used when state.isTutorial === true. See docs/NEW_META.md §7. */
    tutorialRequiredPerHatch: 1,
  },
  escapeHatches: {
    /** Number of escape hatches spawned per match — chosen at random from the
     *  map's pre-authored `escapeTiles[]` candidate pool. If the map declares
     *  fewer candidates than `count`, every candidate is used. Mirrors how
     *  chest zones are seeded into a smaller subset. */
    count: 5,
    /** Consecutive idle-on-hatch turns required before escape resolves. The
     *  turn during which the bomberman walks onto the hatch does NOT count
     *  (action was 'move', not 'idle'); the counter starts on the next turn.
     *  Increase to make extraction more committed. The client's progress ring
     *  derives its fill duration from this value. */
    idleTurnsRequired: 2,
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
    /** Per-bot chance to "notice" a Heal-on-idle effect when it fires. If any
     *  bot notices, a small hunting party converges on the heal location. */
    healNoticeChance: 0.15,
    /** Min/max size of the hunting party recruited (nearest bots to the heal,
     *  including the noticers). Clamped to the number of alive bots. */
    healHuntPartyMin: 2,
    healHuntPartyMax: 4,
    /** How many turns a recruited bot investigates the heal area before giving
     *  up (cleared early if it reaches the spot or finds a real target/danger). */
    healHuntTurns: 6,
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
    //   25 turns survived = 5). First tier on every track is a cheap taster
    //   (cap 30 / stack 50 / hp 50 SP, 2026-06-10) so a new player can buy
    //   one upgrade within their first game; later tiers keep the original
    //   multi-extraction targets.
    // Coin costs bumped 2026-06-10 when the treasure cost was waived
    // (HIDDEN_FEATURES.treasures — see features.ts + HIDDEN_STUFF.md): each
    // tier's coins absorb its old treasure cost, valued as
    // (treasure amount / avg per-run haul) × ~300 coins per-run income,
    // rounded (avg hauls: mushrooms ~206, coffee ~46, grapes ~22 per run).
    // Old coins: cap 350/800, stack 300/700/1500, hp 2200. The `treasure`
    // fields are kept (un-charged while hidden) for an eventual un-hide —
    // restore the old coin values if that happens.
    cap: {
      /** Per-Bomberman upgrade slots available. */
      maxTiers: 2,
      /** Hard absolute ceiling on total slots (Rock + custom). */
      totalSlotCap: 8,
      treasure: 'mushrooms' as const,
      /** Cost array, indexed by tier-applied count. */
      tiers: [
        { sp: 30, coins: 400, treasure: 12 },   // first-upgrade taster (<1 game)
        { sp: 480, coins: 900, treasure: 25 },  // ~7.4 games
      ] as Array<{ sp: number; coins: number; treasure: number }>,
    },
    stack: {
      maxTiers: 3,
      treasure: 'coffee' as const,
      tiers: [
        { sp: 50, coins: 350, treasure: 8 },    // first-upgrade taster (<1 game)
        { sp: 340, coins: 850, treasure: 18 },  // ~5.2 games
        { sp: 760, coins: 1800, treasure: 38 }, // ~11.7 games
      ] as Array<{ sp: number; coins: number; treasure: number }>,
    },
    hp: {
      maxTiers: 1,
      /** Absolute HP cap. Base HP for all Bombermen is currently 2. */
      cap: 3,
      treasure: 'grapes' as const,
      tiers: [
        { sp: 50, coins: 3000, treasure: 60 },  // first-upgrade taster SP; coins carry the gate
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
