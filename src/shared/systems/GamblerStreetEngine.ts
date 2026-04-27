/**
 * Gambler Street engine — pure functions only.
 *
 * The server calls these to:
 *   - tick state forward to "now" (expire gamblers, fill cooldowns)
 *   - generate fresh gamblers with weighted treasure picks
 *   - compute coin rewards via the diminishing-returns curve
 *   - resolve a bet (deduct treasure, roll win/loss, mint cooldown slot)
 *
 * NO side effects. The caller persists the resulting state via PlayerStore.
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
  GamblerSlot,
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

  // Head: linear at startRatio.
  const headCap = Math.min(units, startUnits);
  let total = startRatio * headCap;

  if (units > startUnits) {
    // Log-interpolated middle: ∫(a + b·ln u) du from startUnits to upperBound.
    const upper = Math.min(units, curveMaxUnits);
    if (upper > startUnits) {
      const lnRange = Math.log(curveMaxUnits / startUnits);
      // m(u) = a + b·ln(u); solved from boundary conditions:
      const b = (endRatio - startRatio) / lnRange;
      const a = startRatio - b * Math.log(startUnits);
      const F = (u: number) => u * (a - b + b * Math.log(u));
      total += F(upper) - F(startUnits);
    }

    // Tail: linear at endRatio for any units beyond curveMaxUnits.
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
 * Advance the gambler street state to `now`:
 *   1. Any active gambler whose `expiresAt` has passed becomes a 10s-cooldown slot.
 *   2. Any cooldown slot whose `readyAt` has passed gets a freshly-generated gambler.
 *
 * Idempotent: calling twice with the same `now` and `profileTreasures` yields
 * the same state (modulo RNG draws — the caller passes a seeded rng to keep
 * tests deterministic; in production the server uses Math.random).
 *
 * On generation, this respects the per-treasure-type cap so the carousel
 * never has more than `maxGamblersPerTreasureType` of the same type.
 *
 * Returns a NEW state object — does not mutate the input.
 */
export function tickGamblerStreet(
  state: GamblerStreetState,
  profileTreasures: TreasureBundle,
  now: number,
  rng: () => number,
): GamblerStreetState {
  const slotCount = GAMBLER_STREET_GLOBAL.slotCount;

  // Defensive: slot count may have changed across versions. Resize.
  let slots: GamblerSlot[] = state.slots.slice(0, slotCount);
  while (slots.length < slotCount) {
    slots.push({ kind: 'cooldown', readyAt: now });
  }

  // Step 1 — expire active gamblers whose lifespan has run out.
  slots = slots.map((slot) => {
    if (slot.kind === 'gambler' && slot.gambler.expiresAt <= now) {
      return {
        kind: 'cooldown' as const,
        readyAt: now + GAMBLER_STREET_GLOBAL.expiryCooldownMs,
      };
    }
    return slot;
  });

  // Step 2 — fill cooldown slots whose readyAt has passed.
  let serial = state.nextGamblerSerial;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.kind !== 'cooldown') continue;
    if (slot.readyAt > now) continue;

    // Compute existing-type counts for the dedupe cap, ignoring this slot.
    const typeCounts: Partial<Record<TreasureType, number>> = {};
    for (let j = 0; j < slots.length; j++) {
      if (j === i) continue;
      const s = slots[j];
      if (s.kind !== 'gambler') continue;
      const t = s.gambler.treasureType;
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }

    const gambler = generateGambler(profileTreasures, typeCounts, now, serial, rng);
    slots[i] = { kind: 'gambler', gambler };
    serial++;
  }

  return {
    slots,
    lastTickedAt: now,
    nextGamblerSerial: serial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gambler generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new Gambler: pick a treasure type (weighted, respecting the
 * per-type cap), pick an ask amount, compute the coin reward, pick a name
 * and a lifespan.
 *
 * If every treasure type is at the cap (cap × types ≤ slot count is unusual
 * but possible if config is stretched) the cap is relaxed for this generation
 * — we always return a valid Gambler so a slot never gets stuck.
 */
export function generateGambler(
  profileTreasures: TreasureBundle,
  typeCountsInUse: Partial<Record<TreasureType, number>>,
  now: number,
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

  return {
    id: `g_${now.toString(36)}_${serial.toString(36)}`,
    name,
    treasureType,
    treasureAmount: amount,
    coinReward,
    createdAt: now,
    expiresAt: now + lifespan,
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
    // Inclusive of both endpoints.
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
 * treasure & coin counts based on the outcome and replaces the slot with
 * a `postBetCooldownMs` cooldown.
 *
 * Errors are surfaced as a discriminated union so the server can return a
 * clean reason string to the client.
 */
export type BetResolution =
  | { ok: true; outcome: BetOutcome; nextSlot: GamblerSlot }
  | { ok: false; reason:
      | 'invalid_slot'
      | 'no_gambler'
      | 'gambler_expired'
      | 'insufficient_treasure'
      | 'invalid_tier'
      | 'invalid_hand';
    };

/**
 * Resolve a bet against the gambler at `slotIndex` with the given tier and
 * the player's hand pick.
 *
 * Pure: does not mutate state, treasures, or coins. Returns the bet outcome
 * for the caller to apply.
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
  if (slotIndex < 0 || slotIndex >= state.slots.length) {
    return { ok: false, reason: 'invalid_slot' };
  }
  if (pickedHand !== 'left' && pickedHand !== 'right') {
    return { ok: false, reason: 'invalid_hand' };
  }
  const slot = state.slots[slotIndex];
  if (slot.kind !== 'gambler') return { ok: false, reason: 'no_gambler' };
  if (slot.gambler.expiresAt <= now) return { ok: false, reason: 'gambler_expired' };
  const tierCfg = GAMBLER_STREET_GLOBAL.betTiers[tier];
  if (!tierCfg) return { ok: false, reason: 'invalid_tier' };

  const { gambler } = slot;
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

  const nextSlot: GamblerSlot = {
    kind: 'cooldown',
    readyAt: now + GAMBLER_STREET_GLOBAL.postBetCooldownMs,
  };

  return { ok: true, outcome, nextSlot };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (re-exports + utility)
// ─────────────────────────────────────────────────────────────────────────────

/** Convenience: total cost of a tier for a given gambler. */
export function betCost(gambler: Gambler, tier: BetTier): number {
  return gambler.treasureAmount * GAMBLER_STREET_GLOBAL.betTiers[tier].costMultiplier;
}

export type { GamblerTreasureTuning };
