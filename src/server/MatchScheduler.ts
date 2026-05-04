/**
 * Match scheduler — owns the rolling carousel of MatchListings broadcast to
 * the lobby. Each listing counts down; when it hits zero the scheduler hands
 * the configured match over to GameServer to instantiate a MatchRoom.
 *
 * Behavior:
 *   - Listings have a hard `expiresAt` lifespan. If they sit unfilled past
 *     that deadline they're removed (the lobby UI animates them flying off).
 *   - Listings that hit `startAt` with at least `minPlayersToStart` players
 *     are launched. Unfilled listings simply expire on `expiresAt`; they
 *     don't get recycled in place.
 *   - After ANY removal (launch OR expiry), a replacement listing arrives
 *     after a random 1–3 s delay so the lobby has a breath between cards.
 */

import { BALANCE } from '../shared/config/balance.ts';
import { MAP_MANIFEST } from '../shared/maps/map-manifest.ts';
import type { MatchConfig, MatchListing } from '../shared/types/match.ts';

const UNFILLED_MAX_LIFESPAN_MS = 90 * 1000;
// Sub-second gap between a match disappearing and its replacement arriving —
// keeps the carousel feeling continuously full while still letting the
// fly-off + roll-in animations play without overlapping awkwardly.
const REPLACEMENT_DELAY_MIN_MS = 200;
const REPLACEMENT_DELAY_MAX_MS = 700;
// Minimum gap between any two listings' `startAt` timers. Without this,
// rapid back-to-back replacements would land at near-identical countdowns,
// making the lobby UI a confusing wall of "5s 5s 5s" cards. 2 s gives the
// row a clear left-to-right order: leftmost expires first, then the next.
const MIN_STAGGER_MS = 2000;

let nextId = 0;
function genMatchId(): string { return `match_${Date.now()}_${nextId++}`; }

function generateMatchConfig(): MatchConfig {
  const mapEntry = MAP_MANIFEST[Math.floor(Math.random() * MAP_MANIFEST.length)];
  return {
    id: genMatchId(),
    mapId: mapEntry.id,
    mapName: mapEntry.name,
    maxPlayers: BALANCE.lobby.maxPlayersPerMatch,
  };
}

function pickReplacementDelay(): number {
  const span = REPLACEMENT_DELAY_MAX_MS - REPLACEMENT_DELAY_MIN_MS;
  return REPLACEMENT_DELAY_MIN_MS + Math.floor(Math.random() * (span + 1));
}

interface InternalListing {
  config: MatchConfig;
  playerCount: number;
  /** Unix ms when the countdown reaches 0 (filled launch trigger). */
  startAt: number;
  /** Unix ms when the listing auto-expires if still unfilled. */
  expiresAt: number;
}

export class MatchScheduler {
  private listings: InternalListing[] = [];
  /** Unix ms timestamps for upcoming arrivals (replacement after a removal). */
  private pendingArrivals: number[] = [];

  constructor() {
    const now = Date.now();
    // Initial seed — all visible slots start with listings already alive.
    // makeListing enforces the MIN_STAGGER_MS spacing, so the seeded set
    // comes out neatly stepped left-to-right (e.g., 5 s, 7 s, 9 s).
    for (let i = 0; i < BALANCE.lobby.visibleMatches; i++) {
      this.listings.push(this.makeListing(now));
    }
  }

  private makeListing(now: number): InternalListing {
    const startAt = this.pickStaggeredStartAt(now);
    return {
      config: generateMatchConfig(),
      playerCount: 0,
      startAt,
      expiresAt: now + UNFILLED_MAX_LIFESPAN_MS,
    };
  }

  /**
   * Pick a `startAt` timestamp that's at least MIN_STAGGER_MS away from every
   * existing listing's `startAt`. Walks the sorted neighbor list and bumps
   * the candidate forward whenever it lands inside another listing's
   * exclusion window. Idempotent — callers don't need to retry.
   */
  private pickStaggeredStartAt(now: number): number {
    let candidate = now + BALANCE.lobby.countdownDuration * 1000;
    if (this.listings.length === 0) return candidate;
    const sorted = this.listings.map(l => l.startAt).sort((a, b) => a - b);
    // Bump candidate past any neighbor it falls within MIN_STAGGER_MS of.
    // Iterate until no conflict — a single pass through `sorted` may leave
    // the candidate within range of a later neighbor.
    let changed = true;
    while (changed) {
      changed = false;
      for (const other of sorted) {
        if (Math.abs(candidate - other) < MIN_STAGGER_MS) {
          candidate = other + MIN_STAGGER_MS;
          changed = true;
          break;
        }
      }
    }
    return candidate;
  }

  /**
   * Advance time. Returns configs that just started this tick. Also
   * processes auto-expiry on unfilled matches and spawns replacements
   * from the pending-arrivals queue.
   */
  tick(): MatchConfig[] {
    const now = Date.now();
    const launched: MatchConfig[] = [];

    // 1. Resolve any listing whose `startAt` countdown has reached 0:
    //    - With enough players → launch.
    //    - Without enough players → expire (the lobby UI will animate it
    //      flying off; a replacement arrives 1–3 s later).
    //    Either way, the listing is removed from the visible row.
    for (let i = 0; i < this.listings.length;) {
      const l = this.listings[i];
      if (l.startAt <= now) {
        if (l.playerCount >= BALANCE.lobby.minPlayersToStart) {
          launched.push(l.config);
        }
        this.listings.splice(i, 1);
        this.pendingArrivals.push(now + pickReplacementDelay());
        continue;
      }
      i++;
    }

    // 2. Hard-expire any listing past its absolute deadline (defensive — in
    //    practice step 1 handles unfilled-match expiry first).
    for (let i = 0; i < this.listings.length;) {
      const l = this.listings[i];
      if (l.expiresAt <= now) {
        this.listings.splice(i, 1);
        this.pendingArrivals.push(now + pickReplacementDelay());
        continue;
      }
      i++;
    }

    // 3. Process pending arrivals whose readyAt has passed.
    this.pendingArrivals.sort((a, b) => a - b);
    while (this.pendingArrivals.length > 0 && this.pendingArrivals[0] <= now) {
      this.pendingArrivals.shift();
      this.listings.push(this.makeListing(now));
    }

    // 4. Defensive top-up — if we somehow dipped below visibleMatches and
    //    have no pending, schedule a replacement.
    while (this.listings.length + this.pendingArrivals.length < BALANCE.lobby.visibleMatches) {
      this.pendingArrivals.push(now + pickReplacementDelay());
    }

    return launched;
  }

  /** Snapshot for broadcast (with fresh countdowns). */
  getListings(): MatchListing[] {
    const now = Date.now();
    return this.listings.map(l => ({
      config: l.config,
      playerCount: l.playerCount,
      countdown: Math.max(0, (l.startAt - now) / 1000),
    }));
  }

  joinMatch(matchId: string): MatchConfig | null {
    const listing = this.listings.find(l => l.config.id === matchId);
    if (!listing) return null;
    if (listing.playerCount >= listing.config.maxPlayers) return null;
    listing.playerCount += 1;
    return listing.config;
  }

  leaveMatch(matchId: string): void {
    const listing = this.listings.find(l => l.config.id === matchId);
    if (listing && listing.playerCount > 0) listing.playerCount -= 1;
  }
}
