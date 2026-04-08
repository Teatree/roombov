/**
 * Match scheduler — owns the rolling carousel of MatchListings broadcast to
 * the lobby. Each listing counts down; when it hits zero the scheduler hands
 * the configured match over to GameServer to instantiate a MatchRoom.
 */

import { BALANCE } from '../shared/config/balance.ts';
import { MAP_MANIFEST } from '../shared/maps/map-manifest.ts';
import type { MatchConfig, MatchListing } from '../shared/types/match.ts';

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

interface InternalListing {
  config: MatchConfig;
  playerCount: number;
  startAt: number;
}

export class MatchScheduler {
  private listings: InternalListing[] = [];
  private nextStartTime: number;

  constructor() {
    const now = Date.now();
    this.nextStartTime = now + BALANCE.lobby.countdownDuration * 1000;
    for (let i = 0; i < BALANCE.lobby.visibleMatches; i++) {
      this.listings.push({
        config: generateMatchConfig(),
        playerCount: 0,
        startAt: this.nextStartTime,
      });
      this.nextStartTime += BALANCE.lobby.matchIntervalSeconds * 1000;
    }
  }

  /**
   * Advance time. Returns the config that just started (if any).
   * Enforces min-players-to-start: if the front listing's timer hits 0 with
   * fewer than the minimum, it gets rescheduled further out.
   */
  tick(): MatchConfig | null {
    const now = Date.now();
    if (this.listings.length === 0) return null;

    const front = this.listings[0];
    if (front.startAt > now) return null;

    if (front.playerCount < BALANCE.lobby.minPlayersToStart) {
      // Not enough players — push this listing to the back of the queue
      // with a fresh countdown.
      this.listings.shift();
      const extended: InternalListing = {
        config: front.config,
        playerCount: front.playerCount,
        startAt: this.nextStartTime,
      };
      this.listings.push(extended);
      this.nextStartTime += BALANCE.lobby.matchIntervalSeconds * 1000;
      return null;
    }

    // Launch the front listing
    this.listings.shift();
    const launched = front.config;

    // Append a fresh listing to keep the carousel at N slots
    this.listings.push({
      config: generateMatchConfig(),
      playerCount: 0,
      startAt: this.nextStartTime,
    });
    this.nextStartTime += BALANCE.lobby.matchIntervalSeconds * 1000;

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
