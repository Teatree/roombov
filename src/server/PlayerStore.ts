import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import { createEmptyProfile } from '../shared/types/player-profile.ts';

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
  return {
    id: raw.id ?? generatePlayerId(),
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    coins: raw.coins ?? 500,
    ownedBombermen: owned,
    equippedBombermanId: raw.equippedBombermanId ?? null,
    bombStockpile: raw.bombStockpile ?? {},
  };
}
