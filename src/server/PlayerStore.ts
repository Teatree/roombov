import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import { createEmptyProfile } from '../shared/types/player-profile.ts';
import { CHARACTER_VARIANTS } from '../shared/types/bomberman.ts';
import type { BombermanTier } from '../shared/types/bomberman.ts';
import { defaultStatsForTier } from '../shared/config/bomberman-tiers.ts';
import type { BombType } from '../shared/types/bombs.ts';
import { createEmptyGamblerStreet, type GamblerStreetState } from '../shared/types/gambler-street.ts';
import { GAMBLER_STREET_GLOBAL } from '../shared/config/gambler-street.ts';
import type { TreasureBundle, TreasureType } from '../shared/config/treasures.ts';
import type { FactoryId, FactoryState, FactoryStates } from '../shared/types/factory.ts';
import { createEmptyFactories, FACTORY_IDS } from '../shared/types/factory.ts';

/**
 * Treasures dropped from the active pool by the NEW_META reset (2026-05-16).
 * Stripped from profiles at load time so old data self-heals. The TreasureType
 * union still includes them for type compatibility, just with zero rolls.
 * See docs/NEW_META.md §3.
 */
const DEPRECATED_TREASURES: ReadonlySet<TreasureType> = new Set([
  'fish', 'chalice', 'jade', 'books', 'bones', 'amulets',
]);

function pruneDeprecatedTreasures(raw: unknown): TreasureBundle {
  if (!raw || typeof raw !== 'object') return {};
  const out: TreasureBundle = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (DEPRECATED_TREASURES.has(k as TreasureType)) continue;
    if (typeof v === 'number' && v > 0) out[k as TreasureType] = v;
  }
  return out;
}

/**
 * Rename map for the Apr-2026 bomb catalog cleanup:
 *   - `delay`      → REMOVED (silently strip).
 *   - `delay_big`  → `bomb`
 *   - `delay_wide` → `bomb_wide`
 *
 * Applied during migrateProfile() so older saves keep working without a
 * migration script. Any reference to the removed/renamed types in stockpiles,
 * inventory slots, or bodies is normalized here.
 */
const LEGACY_BOMB_RENAMES: Record<string, BombType | null> = {
  delay_big: 'bomb',
  delay_wide: 'bomb_wide',
  delay: null, // strip
};

function normalizeBombType(raw: string): BombType | null {
  if (raw in LEGACY_BOMB_RENAMES) return LEGACY_BOMB_RENAMES[raw];
  return raw as BombType;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../production/player-data');

/**
 * File-backed player profile store.
 *
 * Profiles are kept in memory after first load and written back to disk on
 * every mutation (write-through). `flush()` on shutdown is a belt-and-braces
 * guarantee — normal operation should never have unsaved writes.
 *
 * This is a tiny handwritten store rather than a real DB because the scale
 * is "a handful of players on a render.com hobby instance". Swap in SQLite
 * later if the player base grows.
 */
export class PlayerStore {
  private cache = new Map<string, PlayerProfile>();

  async init(): Promise<void> {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    const files = await readdir(DATA_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(DATA_DIR, f), 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PlayerProfile>;
        const profile = migrateProfile(parsed);
        this.cache.set(profile.id, profile);
      } catch (err) {
        console.warn(`[PlayerStore] Failed to load ${f}:`, err);
      }
    }
    console.log(`[PlayerStore] Loaded ${this.cache.size} profile(s) from ${DATA_DIR}`);
  }

  /**
   * Returns the profile for the given player id. If the id is empty or unknown,
   * creates a brand-new profile with a freshly generated id.
   */
  async loadOrCreate(playerId: string): Promise<PlayerProfile> {
    if (playerId && this.cache.has(playerId)) {
      return this.cache.get(playerId)!;
    }
    const id = playerId && isValidId(playerId) ? playerId : generatePlayerId();
    if (this.cache.has(id)) return this.cache.get(id)!;

    const profile = createEmptyProfile(id);
    this.cache.set(id, profile);
    await this.persist(profile);
    return profile;
  }

  get(playerId: string): PlayerProfile | null {
    return this.cache.get(playerId) ?? null;
  }

  /**
   * Dev helper: wipe a profile back to a fresh starter state while preserving
   * its id. Used by the "debug reset" button during early development.
   * Synchronous — the cache update is instant and the disk write is fire-and-forget.
   */
  resetProfile(playerId: string): PlayerProfile {
    const fresh = createEmptyProfile(playerId);
    this.cache.set(playerId, fresh);
    void this.persist(fresh).catch((err) => {
      console.warn(`[PlayerStore] background save failed for ${playerId}:`, err);
    });
    return fresh;
  }

  /**
   * Persist a mutated profile. The in-memory cache is the runtime source of
   * truth, so we update it synchronously and fire-and-forget the disk write.
   * This keeps shop responses snappy — previously every buy awaited a Windows
   * fsync which added hundreds of ms of latency before the profile broadcast.
   *
   * flush() on shutdown still awaits all pending writes, so nothing gets lost.
   */
  async save(profile: PlayerProfile): Promise<void> {
    profile.updatedAt = Date.now();
    this.cache.set(profile.id, profile);
    void this.persist(profile).catch((err) => {
      console.warn(`[PlayerStore] background save failed for ${profile.id}:`, err);
    });
  }

  /** Flush all in-memory profiles to disk. Called on graceful shutdown. */
  async flush(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const profile of this.cache.values()) {
      promises.push(this.persist(profile));
    }
    await Promise.all(promises);
  }

  private async persist(profile: PlayerProfile): Promise<void> {
    const path = join(DATA_DIR, `${profile.id}.json`);
    await writeFile(path, JSON.stringify(profile, null, 2), 'utf-8');
  }
}

function generatePlayerId(): string {
  return `p_${randomBytes(6).toString('hex')}`;
}

function isValidId(id: string): boolean {
  return /^p_[a-f0-9]{12}$/.test(id);
}

/**
 * Fill in any fields that are missing from an older on-disk profile.
 * New fields added to PlayerProfile should get default values here so older
 * profiles don't crash anything that assumes the field exists.
 */
function migrateProfile(raw: Partial<PlayerProfile>): PlayerProfile {
  const now = Date.now();
  const owned = (raw.ownedBombermen ?? []).map((b) => {
    // Backfill: old profiles saved before the `tint` field existed. Pick a
    // deterministic-ish vivid tint based on the owned id hash so refreshes
    // don't change the color randomly. Sprite tint must be non-gray.
    // Backfill name for old Bombermen that don't have one
    if (!b.name) {
      const tierNames: Record<string, string[]> = {
        free: ["O'Brien", 'Murphy', 'Kelly', 'Sullivan', 'Walsh', 'Byrne'],
        paid: ['Dusty', 'Slim', 'Butch', 'Doc', 'Hoss', 'Maverick'],
        paid_expensive: ['Achilles', 'Ajax', 'Apollo', 'Ares', 'Atlas', 'Hermes'],
      };
      const pool = tierNames[b.tier ?? 'free'] ?? tierNames.free;
      const idx = ((b.id ?? '').length + (b.tier ?? '').length) % pool.length;
      b = { ...b, name: pool[idx] };
    }
    // Character variant backfill — picked deterministically from id hash so
    // the same owned Bomberman shows the same variant across reloads.
    if (!('character' in b) || !b.character) {
      const h2 = (b.id ?? '').split('').reduce((acc, ch) => ((acc * 17 + ch.charCodeAt(0)) >>> 0), 0);
      b = { ...b, character: CHARACTER_VARIANTS[h2 % CHARACTER_VARIANTS.length] };
    }
    if (typeof b.tint === 'number') return b;
    const hash = (b.id ?? '').split('').reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0);
    const hue = hash % 360;
    const sat = 0.7;
    const light = 0.52;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, bl = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; bl = x; }
    else if (hp < 4) { g = x; bl = c; }
    else if (hp < 5) { r = x; bl = c; }
    else { r = c; bl = x; }
    const m = light - c / 2;
    const tint = (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((bl + m) * 255);
    return { ...b, tint };
  });
  // Normalize bomb types in the stockpile: rename legacy entries, drop removed.
  const rawStockpile = (raw.bombStockpile ?? {}) as Record<string, number>;
  const normalizedStockpile: Record<string, number> = {};
  for (const [type, count] of Object.entries(rawStockpile)) {
    if (typeof count !== 'number' || count <= 0) continue;
    const mapped = normalizeBombType(type);
    if (mapped == null) continue; // `delay` is silently stripped
    normalizedStockpile[mapped] = (normalizedStockpile[mapped] ?? 0) + count;
  }

  // Normalize inventory slots on every owned bomberman (same rules).
  for (const b of owned) {
    if (!b.inventory || !Array.isArray(b.inventory.slots)) continue;
    b.inventory.slots = b.inventory.slots.map((slot) => {
      if (!slot) return null;
      const mapped = normalizeBombType(slot.type as unknown as string);
      if (mapped == null) return null; // strip `delay`
      return { type: mapped, count: slot.count };
    });
  }

  // Tier-based stats backfill: legacy owned Bombermen pre-date `maxCustomSlots`
  // and `stackSize`. Assign mid-tier defaults so they slot into the new
  // system without losing or re-rolling anything else. If the existing
  // inventory length doesn't match the tier-default slot count, resize:
  // shrink with overflow returned to the stockpile (rare; only happens if a
  // pre-tier inventory had >tier-default slots filled).
  for (const b of owned) {
    const tier = (b.tier ?? 'free') as BombermanTier;
    const defaults = defaultStatsForTier(tier);
    if (typeof b.maxCustomSlots !== 'number' || b.maxCustomSlots <= 0) {
      b.maxCustomSlots = defaults.maxCustomSlots;
    }
    if (typeof b.stackSize !== 'number' || b.stackSize <= 0) {
      b.stackSize = defaults.stackSize;
    }
    if (b.inventory && Array.isArray(b.inventory.slots)) {
      if (b.inventory.slots.length > b.maxCustomSlots) {
        // Trim — push any non-null overflow back to the stockpile.
        for (let i = b.maxCustomSlots; i < b.inventory.slots.length; i++) {
          const s = b.inventory.slots[i];
          if (s) {
            const mapped = normalizeBombType(s.type as unknown as string);
            if (mapped) {
              normalizedStockpile[mapped] = (normalizedStockpile[mapped] ?? 0) + s.count;
            }
          }
        }
        b.inventory.slots = b.inventory.slots.slice(0, b.maxCustomSlots);
      } else if (b.inventory.slots.length < b.maxCustomSlots) {
        const extra = b.maxCustomSlots - b.inventory.slots.length;
        b.inventory.slots = [...b.inventory.slots, ...new Array(extra).fill(null)];
      }
    }
  }

  // Backfill gambler street state for older profiles. Migrates legacy
  // `state.slots` (mix of gambler/cooldown kinds) into the new
  // `gamblers` + `pendingArrivals` shape so existing profiles keep their
  // carousel position. Profiles with no field at all get a fresh empty
  // state (engine fills on first tick).
  const gamblerStreet: GamblerStreetState =
    migrateGamblerStreet(raw.gamblerStreet, now);

  return {
    id: raw.id ?? generatePlayerId(),
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    coins: raw.coins ?? 500,
    treasures: pruneDeprecatedTreasures(raw.treasures),
    ownedBombermen: owned,
    equippedBombermanId: raw.equippedBombermanId ?? null,
    bombStockpile: normalizedStockpile as PlayerProfile['bombStockpile'],
    gamblerStreet,
    // Per-player Bomberman shop cycle. Legacy profiles don't have this; the
    // service generates on first request and persists. Backfill known fields
    // on partial-shape entries so older saves still work.
    bombermanShop: migrateBombermanShop(raw.bombermanShop),
    factories: migrateFactories(raw.factories),
  };
}

/**
 * Backfill factory state for older profiles. New profiles get fresh empty
 * factories; existing profiles keep their saved state with type-safe defaults
 * for any missing fields.
 */
function migrateFactories(raw: unknown): FactoryStates {
  if (!raw || typeof raw !== 'object') return createEmptyFactories();
  const out = createEmptyFactories();
  const r = raw as Record<string, unknown>;
  for (const id of FACTORY_IDS) {
    const slot = r[String(id)];
    if (!slot || typeof slot !== 'object') continue;
    const s = slot as Partial<FactoryState>;
    const startedAt = typeof s.firstCycleStartedAt === 'number' ? s.firstCycleStartedAt : null;
    const queueLength = typeof s.queueLength === 'number' && s.queueLength >= 0 ? Math.floor(s.queueLength) : 0;
    const storage = Array.isArray(s.storage) ? s.storage.filter((v) => typeof v === 'string') as FactoryState['storage'] : [];
    const rawSessionDone = typeof s.sessionDone === 'number' && s.sessionDone >= 0 ? Math.floor(s.sessionDone) : 0;
    const rawSessionTotal = typeof s.sessionTotal === 'number' && s.sessionTotal >= 0 ? Math.floor(s.sessionTotal) : 0;
    // If the saved profile predates the session fields but has bombs already
    // in flight, retro-seed the session with sessionTotal = queueLength so the
    // popup's "X / Y done" header doesn't read "bomb 1 of 0".
    const effectiveQueue = startedAt == null ? 0 : queueLength;
    const sessionTotal = rawSessionTotal > 0
      ? Math.max(rawSessionTotal, rawSessionDone)
      : Math.max(rawSessionDone, effectiveQueue);
    out[id as FactoryId] = {
      firstCycleStartedAt: queueLength > 0 ? startedAt : null,
      queueLength: effectiveQueue,
      storage,
      sessionDone: rawSessionDone,
      sessionTotal,
    };
  }
  return out;
}

function migrateBombermanShop(raw: unknown): PlayerProfile['bombermanShop'] {
  if (!raw || typeof raw !== 'object') return null;
  const cast = raw as Partial<PlayerProfile['bombermanShop']> & { bombermen?: unknown };
  if (typeof cast.cycleId !== 'string') return null;
  if (typeof cast.endsAt !== 'number') return null;
  if (!Array.isArray(cast.bombermen)) return null;
  return {
    cycleId: cast.cycleId,
    startedAt: typeof cast.startedAt === 'number' ? cast.startedAt : (cast.endsAt - 2 * 60 * 1000),
    endsAt: cast.endsAt,
    bombermen: cast.bombermen as PlayerProfile['bombermanShop'] extends infer T ? T extends { bombermen: infer B } ? B : never : never,
    boughtTemplateIds: Array.isArray(cast.boughtTemplateIds) ? cast.boughtTemplateIds : [],
  };
}

/**
 * Convert any persisted gambler-street blob (current shape, legacy `slots`
 * shape, or absent) into the current shape.
 *
 * Legacy shape (pre-conveyor): `{ slots: ({kind:'gambler',gambler}|{kind:'cooldown',readyAt})[] }`.
 * New shape: `{ gamblers: Gambler[], pendingArrivals: number[] }`.
 *
 * Why migrate in-place rather than reset: players had carousel state worth
 * preserving (active gamblers + their treasures asked, plus pending arrivals).
 * Throwing it away on the upgrade would feel like a regression.
 */
function migrateGamblerStreet(raw: unknown, now: number): GamblerStreetState {
  if (!raw || typeof raw !== 'object') {
    return createEmptyGamblerStreet(now, GAMBLER_STREET_GLOBAL.slotCount);
  }

  const cast = raw as { gamblers?: unknown; pendingArrivals?: unknown; slots?: unknown; nextGamblerSerial?: unknown };

  // Already current shape
  if (Array.isArray(cast.gamblers) && Array.isArray(cast.pendingArrivals) && typeof cast.nextGamblerSerial === 'number') {
    return raw as GamblerStreetState;
  }

  // Legacy `slots` shape — split into gamblers + pendingArrivals
  if (Array.isArray(cast.slots)) {
    type LegacySlot =
      | { kind: 'gambler'; gambler: { id: string; name: string; treasureType: string; treasureAmount: number; coinReward: number; createdAt: number; expiresAt: number } }
      | { kind: 'cooldown'; readyAt: number };
    const legacy = cast.slots as LegacySlot[];
    const gamblers: GamblerStreetState['gamblers'] = [];
    const pendingArrivals: number[] = [];
    for (const slot of legacy) {
      if (slot.kind === 'gambler' && slot.gambler) {
        gamblers.push(slot.gambler as unknown as GamblerStreetState['gamblers'][number]);
      } else if (slot.kind === 'cooldown' && typeof slot.readyAt === 'number') {
        pendingArrivals.push(slot.readyAt);
      }
    }
    return {
      gamblers,
      pendingArrivals,
      lastTickedAt: typeof (raw as { lastTickedAt?: unknown }).lastTickedAt === 'number'
        ? (raw as { lastTickedAt: number }).lastTickedAt
        : now,
      nextGamblerSerial: typeof cast.nextGamblerSerial === 'number' ? cast.nextGamblerSerial : 1,
    };
  }

  return createEmptyGamblerStreet(now, GAMBLER_STREET_GLOBAL.slotCount);
}
