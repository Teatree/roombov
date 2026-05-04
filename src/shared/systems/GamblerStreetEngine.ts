/**
 * Gambler Street engine — pure functions only.
 *
 * The server calls these to:
 *   - tick state forward to "now" (expire gamblers, schedule respawns,
 *     spawn pending arrivals)
 *   - generate fresh gamblers with weighted treasure picks and staggered
 *     expiry times
 *   - compute coin rewards via the diminishing-returns curve
 *   - resolve a bet (deduct treasure, roll win/loss, queue replacement)
 *
 * NO side effects. The caller persists the resulting state via PlayerStore.
 *
 * Carousel data model: `state.gamblers` is the active list (0..slotCount),
 * left-to-right, leftmost expires first. `state.pendingArrivals` is a queue
 * of `readyAt` timestamps — each pending entry will become a fresh gambler
 * at the right end of the list when the wall clock crosses its readyAt.
 * The two arrays sum to `slotCount` in steady state.
 */

import type { TreasureBundle, TreasureType } from '../config/treasures.ts';
import { TREASURE_TYPES } from '../config/treasures.ts';
import {
  GAMBLER_STREET_GLOBAL,
  GAMBLER_TREASURE_TUNING,
  GAMBLER_NAMES,
  type BetTier,
  type GamblerTreasureTuning,
} from '../config/gambler-street.ts';
import type {
  Gambler,
  GamblerStreetState,
  BetOutcome,
} from '../types/gambler-street.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Reward curve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coins paid for handing over `units` of `type` treasure.
 *
 * The marginal rate `m(u)` (coins per +1 unit) starts at `startRatio` while
 * `u ≤ startUnits`, log-interpolates down to `endRatio` over the interval
 * `[startUnits, curveMaxUnits]`, then stays flat at `endRatio` afterwards.
 *
 * Total reward is the integral of m(u) from 0 to N, computed in closed form.
 * Result is rounded to the nearest whole coin and clamped to ≥ 0.
 *
 *   reward(N) = startRatio * min(N, startUnits)
 *             + ∫[startUnits..min(N, curveMaxUnits)] (a + b·ln u) du
 *             + endRatio * max(0, N - curveMaxUnits)
 *
 * where m(u) = a + b·ln u with boundary conditions
 *   m(startUnits)    = startRatio
 *   m(curveMaxUnits) = endRatio
 *
 * Antiderivative of (a + b·ln u) is u·(a − b + b·ln u).
 */
export function computeCoinReward(type: TreasureType, units: number): number {
  if (units <= 0) return 0;
  const tuning = GAMBLER_TREASURE_TUNING[type];
  const { startRatio, endRatio, startUnits, curveMaxUnits } = tuning.rewardCurve;

  const headCap = Math.min(units, startUnits);
  let total = startRatio * headCap;

  if (units > startUnits) {
    const upper = Math.min(units, curveMaxUnits);
    if (upper > startUnits) {
      const lnRange = Math.log(curveMaxUnits / startUnits);
      const b = (endRatio - startRatio) / lnRange;
      const a = startRatio - b * Math.log(startUnits);
      const F = (u: number) => u * (a - b + b * Math.log(u));
      total += F(upper) - F(startUnits);
    }
    if (units > curveMaxUnits) {
      total += endRatio * (units - curveMaxUnits);
    }
  }

  return Math.max(0, Math.round(total));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick — drive state to current wall-clock time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advance the gambler street state to `now` by processing events in
 * wall-clock order:
 *   - Expiry: leftmost gambler's `expiresAt` ≤ now → remove, queue a
 *     respawn anchored to the gambler's actual expiry time (not `now`).
 *   - Spawn: earliest pendingArrival's `readyAt` ≤ now → generate a fresh
 *     gambler with `createdAt = readyAt`. If the rolled lifespan still puts
 *     the new gambler's expiry in the past (long offline gap), the next
 *     loop iteration will expire it naturally and queue another respawn.
 *
 * Bounded loop: each iteration consumes one event. For typical use the
 * count is tiny; for an hour-long offline gap the count is in the hundreds.
 *
 * Idempotent: calling twice with the same `now` and same rng draws yields
 * the same state. Returns a NEW state object — does not mutate the input.
 */
export function tickGamblerStreet(
  state: GamblerStreetState,
  profileTreasures: TreasureBundle,
  now: number,
  rng: () => number,
): GamblerStreetState {
  const slotCount = GAMBLER_STREET_GLOBAL.slotCount;
  const respawnRange = GAMBLER_STREET_GLOBAL.respawnDelayRangeMs;

  const gamblers: Gambler[] = state.gamblers.slice();
  let pendingArrivals: number[] = state.pendingArrivals.slice();
  let serial = state.nextGamblerSerial;

  pendingArrivals.sort((a, b) => a - b);

  // Generous cap — long offline gaps with short cycles can produce hundreds
  // of events; clock-skew should still terminate quickly.
  const MAX_EVENTS = slotCount * 256;
  for (let i = 0; i < MAX_EVENTS; i++) {
    const nextExpiry = gamblers.length > 0 ? gamblers[0].expiresAt : Infinity;
    const nextSpawn = pendingArrivals.length > 0 ? pendingArrivals[0] : Infinity;
    const nextEvent = Math.min(nextExpiry, nextSpawn);

    if (nextEvent > now) break; // all remaining events are in the future

    if (nextExpiry <= nextSpawn) {
      // Expire the leftmost gambler. Anchor the respawn to its expiry, not
      // to `now` — otherwise long offline gaps wouldn't catch up.
      const expired = gamblers.shift() as Gambler;
      pendingArrivals.push(pickRespawnTime(expired.expiresAt, respawnRange, rng));
      pendingArrivals.sort((a, b) => a - b);
    } else {
      // Spawn the next pending arrival. Use its readyAt as createdAt so the
      // gambler's lifespan is measured from its real spawn time.
      const readyAt = pendingArrivals.shift() as number;
      if (gamblers.length >= slotCount) continue;

      const typeCounts: Partial<Record<TreasureType, number>> = {};
      for (const g of gamblers) typeCounts[g.treasureType] = (typeCounts[g.treasureType] ?? 0) + 1;

      const earliestExpiry = computeNewArrivalEarliestExpiry(gamblers, readyAt);
      const gambler = generateGambler(
        profileTreasures,
        typeCounts,
        readyAt,
        earliestExpiry,
        serial,
        rng,
      );
      serial++;
      gamblers.push(gambler);
    }
  }

  // Defensive top-up — if persisted state somehow lost entries (slotCount
  // increased between deploys, manual edit, etc.).
  while (gamblers.length + pendingArrivals.length < slotCount) {
    pendingArrivals.push(now + pickRespawnTime(0, respawnRange, rng));
  }

  return {
    gamblers,
    pendingArrivals,
    lastTickedAt: now,
    nextGamblerSerial: serial,
  };
}

/** Pick a respawn time `now + uniform(min..max)`. */
function pickRespawnTime(
  now: number,
  range: readonly [number, number],
  rng: () => number,
): number {
  const [min, max] = range;
  const span = Math.max(0, max - min);
  return now + min + Math.floor(rng() * (span + 1));
}

/**
 * For a new gambler arriving at the right end at `createdAt`, compute the
 * minimum expiry time it must satisfy:
 *   - At least `createdAt + lifespanRangeMs[0]` (the gambler always has at
 *     least the minimum lifespan ahead of them from when they spawned).
 *   - At least `lastActive.expiresAt + minStaggerMs` (so timers stay
 *     staggered left-to-right).
 *
 * The actual lifespan rolled in `generateGambler` is then clamped up to
 * this floor before computing expiresAt.
 */
function computeNewArrivalEarliestExpiry(
  activeGamblers: readonly Gambler[],
  createdAt: number,
): number {
  const stagger = GAMBLER_STREET_GLOBAL.minStaggerMs;
  const minLifespan = GAMBLER_STREET_GLOBAL.lifespanRangeMs[0];
  let floor = createdAt + minLifespan;
  if (activeGamblers.length > 0) {
    const lastExpiry = activeGamblers[activeGamblers.length - 1].expiresAt;
    floor = Math.max(floor, lastExpiry + stagger);
  }
  return floor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gambler generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new Gambler: pick a treasure type (weighted, respecting the
 * per-type cap), pick an ask amount, compute the coin reward, pick a name
 * and a lifespan that satisfies the stagger floor.
 *
 * `earliestExpiry` is the minimum acceptable expiresAt; the lifespan roll is
 * clamped up to ensure the floor is hit when the natural roll would have
 * fallen short. This produces the "leftmost expires first" property even
 * after long offline aging.
 *
 * If every treasure type is at the cap (cap × types ≤ slot count is unusual
 * but possible if config is stretched) the cap is relaxed for this generation
 * — we always return a valid Gambler so the carousel never gets stuck.
 */
export function generateGambler(
  profileTreasures: TreasureBundle,
  typeCountsInUse: Partial<Record<TreasureType, number>>,
  createdAt: number,
  earliestExpiry: number,
  serial: number,
  rng: () => number,
): Gambler {
  const cap = GAMBLER_STREET_GLOBAL.maxGamblersPerTreasureType;
  const treasureType = pickWeightedTreasureType(typeCountsInUse, cap, rng);

  const owned = profileTreasures[treasureType] ?? 0;
  const amount = computeAskAmount(treasureType, owned, rng);
  const coinReward = computeCoinReward(treasureType, amount);

  const name = GAMBLER_NAMES[Math.floor(rng() * GAMBLER_NAMES.length)];
  const [lifeMin, lifeMax] = GAMBLER_STREET_GLOBAL.lifespanRangeMs;
  const lifespan = lifeMin + Math.floor(rng() * (lifeMax - lifeMin));
  const naturalExpiry = createdAt + lifespan;
  const expiresAt = Math.max(naturalExpiry, earliestExpiry);

  return {
    id: `g_${createdAt.toString(36)}_${serial.toString(36)}`,
    name,
    treasureType,
    treasureAmount: amount,
    coinReward,
    createdAt,
    expiresAt,
  };
}

/**
 * Weighted pick of a treasure type, excluding any type already at the cap.
 * Falls back to the full weighted pool if all are capped.
 */
function pickWeightedTreasureType(
  typeCountsInUse: Partial<Record<TreasureType, number>>,
  cap: number,
  rng: () => number,
): TreasureType {
  const eligible: TreasureType[] = TREASURE_TYPES.filter(
    (t) => (typeCountsInUse[t] ?? 0) < cap,
  );
  const pool: TreasureType[] = eligible.length > 0 ? eligible : [...TREASURE_TYPES];

  let totalWeight = 0;
  for (const t of pool) totalWeight += GAMBLER_TREASURE_TUNING[t].weight;

  let roll = rng() * totalWeight;
  for (const t of pool) {
    roll -= GAMBLER_TREASURE_TUNING[t].weight;
    if (roll <= 0) return t;
  }
  return pool[pool.length - 1]; // belt-and-braces (float drift)
}

/**
 * Compute how many of `type` the gambler asks for given the player's owned
 * count. Below `amountPctThreshold` we use the absolute floor range; above,
 * we use the percentage range. Result is rounded to `roundAmountTo` and
 * floored at the absolute minimum so the gambler always asks for something
 * meaningful even if the player has 0 owned.
 */
export function computeAskAmount(
  type: TreasureType,
  owned: number,
  rng: () => number,
): number {
  const tuning = GAMBLER_TREASURE_TUNING[type];
  const [minAbs, maxAbs] = tuning.minAmountRange;
  const [minPct, maxPct] = tuning.amountPctRange;

  let raw: number;
  if (owned < tuning.amountPctThreshold) {
    raw = minAbs + Math.floor(rng() * (maxAbs - minAbs + 1));
  } else {
    const pct = minPct + rng() * (maxPct - minPct);
    raw = owned * pct;
  }

  const step = Math.max(1, tuning.roundAmountTo);
  let rounded = Math.round(raw / step) * step;
  if (rounded < minAbs) rounded = minAbs;
  return rounded;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bet resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of attempting to bet. The caller then mutates the profile's
 * treasure & coin counts based on the outcome and removes the gambler from
 * the active list (queuing a respawn arrival in its place).
 */
export type BetResolution =
  | { ok: true; outcome: BetOutcome; respawnAt: number }
  | { ok: false; reason:
      | 'invalid_slot'
      | 'no_gambler'
      | 'gambler_expired'
      | 'insufficient_treasure'
      | 'invalid_tier'
      | 'invalid_hand';
    };

/**
 * Resolve a bet against the gambler at index `slotIndex` of `state.gamblers`.
 *
 * Pure: does not mutate state, treasures, or coins. Returns the bet outcome
 * for the caller to apply, plus the timestamp at which the replacement
 * gambler should arrive.
 *
 * Roll model (per the design): for the chosen tier, the player wins with
 * probability `winChance`. The "correct hand" returned in the outcome is
 * derived from the player's pick + the win result so the popup animation
 * matches the verdict (won → picked hand is "correct"; lost → other hand).
 */
export function resolveBet(
  state: GamblerStreetState,
  profileTreasures: TreasureBundle,
  slotIndex: number,
  tier: BetTier,
  pickedHand: 'left' | 'right',
  now: number,
  rng: () => number,
): BetResolution {
  if (slotIndex < 0 || slotIndex >= state.gamblers.length) {
    return { ok: false, reason: 'invalid_slot' };
  }
  if (pickedHand !== 'left' && pickedHand !== 'right') {
    return { ok: false, reason: 'invalid_hand' };
  }
  const gambler = state.gamblers[slotIndex];
  if (!gambler) return { ok: false, reason: 'no_gambler' };
  if (gambler.expiresAt <= now) return { ok: false, reason: 'gambler_expired' };
  const tierCfg = GAMBLER_STREET_GLOBAL.betTiers[tier];
  if (!tierCfg) return { ok: false, reason: 'invalid_tier' };

  const cost = gambler.treasureAmount * tierCfg.costMultiplier;
  const owned = profileTreasures[gambler.treasureType] ?? 0;
  if (owned < cost) return { ok: false, reason: 'insufficient_treasure' };

  const won = rng() < tierCfg.winChance;
  const correctHand: 'left' | 'right' =
    won ? pickedHand : (pickedHand === 'left' ? 'right' : 'left');

  const outcome: BetOutcome = {
    slotIndex,
    tier,
    won,
    treasureType: gambler.treasureType,
    treasurePaid: cost,
    coinsGained: won ? gambler.coinReward : 0,
    correctHand,
  };

  const respawnAt = pickRespawnTime(now, GAMBLER_STREET_GLOBAL.respawnDelayRangeMs, rng);
  return { ok: true, outcome, respawnAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (re-exports + utility)
// ─────────────────────────────────────────────────────────────────────────────

/** Convenience: total cost of a tier for a given gambler. */
export function betCost(gambler: Gambler, tier: BetTier): number {
  return gambler.treasureAmount * GAMBLER_STREET_GLOBAL.betTiers[tier].costMultiplier;
}

export type { GamblerTreasureTuning };
