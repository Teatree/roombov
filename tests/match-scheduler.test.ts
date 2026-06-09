import { describe, it, expect } from 'vitest';
import { MatchScheduler } from '../src/server/MatchScheduler.ts';

/**
 * The lobby alternates "Normal" (allowBots) and "No Bots or Scavs" matches:
 * every second listing generated is AI-free, so the visible row reads
 * Normal → No Bots or Scavs → Normal → ... On a fresh server process the
 * sequence starts Normal (the module sequence counter starts at 0).
 *
 * NB: that counter is module-global, so only the *first* MatchScheduler in a
 * process starts on Normal — hence these tests assert the alternation invariant
 * (adjacent listings differ) rather than a fixed starting parity, which is the
 * property that actually guards against the "every card identical" bug.
 */
describe('MatchScheduler bots/scavs alternation', () => {
  it('alternates allowBots across the visible row (adjacent listings differ)', () => {
    const listings = new MatchScheduler().getListings();
    expect(listings.length).toBeGreaterThan(1);
    for (let i = 1; i < listings.length; i++) {
      expect(listings[i].config.allowBots).not.toBe(listings[i - 1].config.allowBots);
    }
  });

  it('every listing carries an explicit boolean allowBots flag (never undefined)', () => {
    const listings = new MatchScheduler().getListings();
    for (const l of listings) {
      expect(typeof l.config.allowBots).toBe('boolean');
    }
  });

  it('produces both Normal and No-Bots matches (not all one kind)', () => {
    const listings = new MatchScheduler().getListings();
    const flags = listings.map(l => l.config.allowBots);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  // Regression: map and mode used to rotate in lock-step (two independent
  // counters), pinning Desert to No-Bots forever. The cycle is now
  // Main(Normal) → Main(NoBots) → Desert(Normal) → Desert(NoBots) → …, i.e.
  // each map appears in BOTH modes back-to-back. Asserted as a parity-free
  // invariant (the counter is module-global, so the row's start offset is
  // arbitrary): a Normal listing is always the first half of a map pair, so
  // the next listing keeps the map; a No-Bots listing closes the pair, so
  // the next listing switches map (with 2 maps in the manifest).
  it('pairs each map with both modes (Normal keeps the map, No-Bots advances it)', () => {
    // Arrange
    const listings = new MatchScheduler().getListings();
    expect(listings.length).toBeGreaterThan(2);

    // Act
    const row = listings.map(l => ({ mapId: l.config.mapId, allowBots: l.config.allowBots }));

    // Assert
    for (let i = 1; i < row.length; i++) {
      if (row[i - 1].allowBots) {
        expect(row[i].mapId).toBe(row[i - 1].mapId);
      } else {
        expect(row[i].mapId).not.toBe(row[i - 1].mapId);
      }
    }
  });
});
