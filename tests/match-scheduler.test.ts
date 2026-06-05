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
});
