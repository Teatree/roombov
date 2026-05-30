/**
 * File-backed IP → country cache.
 *
 * Each unique IP is looked up exactly once across the server's lifetime —
 * subsequent hits read from memory, and from disk after a restart.
 *
 * Provider: **ip-api.com**. Endpoint `http://ip-api.com/line/<ip>?fields=countryCode`
 * returns the 2-letter ISO country code as a single plain-text line. Free
 * tier is 45 req/min from any single egress IP, no API key, no daily cap.
 *
 * Why not ipapi.co (initial choice in the spec): ipapi.co aggressively
 * rate-limits data-center egress IPs (Render, AWS, etc.) and returns a
 * "Sorry, you have been rate limited" plain-text body instead of a 4xx
 * status — silent failure. ip-api.com is designed for server-side use and
 * doesn't blanket-block hosting providers.
 *
 * Free tier of ip-api.com is HTTP-only (HTTPS requires paid). That's fine
 * for backend → backend; render egress isn't user-observable.
 *
 * Lookups are fire-and-forget. Callers DO NOT await; they kick off a lookup
 * at socket connect time so by the player's first analytics event the cache
 * is usually populated. If it isn't yet, the row goes out with country=''
 * and subsequent events from the same IP carry the resolved code.
 *
 * On-disk format: `production/ip-country-cache.json` — flat
 * `{ "<ip>": "<CC>" }`. Atomic-write isn't strictly necessary (the file is
 * append-mostly, single-process), so we follow PlayerStore.persist's pattern:
 * one writeFile per mutation.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../production');
const CACHE_PATH = join(DATA_DIR, 'ip-country-cache.json');

const API_URL = (ip: string): string =>
  `http://ip-api.com/line/${encodeURIComponent(ip)}?fields=countryCode`;
const LOOKUP_TIMEOUT_MS = 2000;

export class IpCountryCache {
  private cache = new Map<string, string>();
  /** IPs currently being looked up — prevents request stampede when several
   *  sockets connect from the same address at once. */
  private inflight = new Set<string>();

  async init(): Promise<void> {
    try {
      if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
      if (!existsSync(CACHE_PATH)) {
        console.log('[IpCountryCache] No cache file — starting empty');
        return;
      }
      const raw = await readFile(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [ip, country] of Object.entries(parsed)) {
        if (typeof country === 'string' && /^[A-Z]{2}$/.test(country)) {
          this.cache.set(ip, country);
        }
      }
      console.log(`[IpCountryCache] Loaded ${this.cache.size} entries`);
    } catch (err) {
      console.warn('[IpCountryCache] Failed to load cache:', err);
    }
  }

  /** Synchronous read. Returns empty string for uncached IPs, local IPs, or
   *  while a lookup is in flight. */
  get(ip: string): string {
    return this.cache.get(ip) ?? '';
  }

  /**
   * Fire-and-forget lookup. No-op when:
   *   - ip is empty
   *   - ip is local / private (loopback, RFC1918, link-local, ULA)
   *   - ip is already cached (under either the raw OR normalized form)
   *   - a lookup is already in flight for this ip
   *
   * Cache lookups use the raw IP for both reads and writes so callers
   * (server session) can do a simple `cache.get(session.ip)` without
   * having to normalize first. We also store under the normalized form
   * so a second connection from the same address-in-a-different-shape
   * gets a cache hit.
   *
   * On API failure / timeout the ip is simply not cached; the next session
   * for the same address will try again. No retry inside this call.
   */
  lookup(ip: string): void {
    if (!ip || isLocalIp(ip)) return;
    if (this.cache.has(ip)) return;
    if (this.inflight.has(ip)) return;
    this.inflight.add(ip);
    void this.fetchAndStore(ip);
  }

  private async fetchAndStore(ip: string): Promise<void> {
    // Normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to plain IPv4 — ipapi.co
    // doesn't recognize the v6-wrapped form and returns "Undefined". Render
    // / Cloudflare-style proxies sometimes pass this form in x-forwarded-for.
    const apiIp = normalizeForApi(ip);
    try {
      console.log(`[IpCountryCache] looking up ${ip}${apiIp !== ip ? ` (as ${apiIp})` : ''}`);
      const res = await fetch(API_URL(apiIp), { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (!res.ok) {
        console.warn(`[IpCountryCache] ${ip} → HTTP ${res.status}`);
        return;
      }
      const body = (await res.text()).trim();
      // ipapi.co signals quota/error conditions via the response body, not
      // via status. Filter strictly to 2-letter ISO codes so a "Undefined"
      // or "rate-limited" payload doesn't poison the cache.
      if (!/^[A-Z]{2}$/.test(body)) {
        console.warn(`[IpCountryCache] ${ip} → unexpected body: ${body.slice(0, 64)}`);
        return;
      }
      // Store under BOTH the raw form (so callers can `cache.get(session.ip)`
      // with whatever shape extractIp returned) AND the normalized form
      // (so a different connection that gets the bare IPv4 also hits cache).
      this.cache.set(ip, body);
      if (apiIp !== ip) this.cache.set(apiIp, body);
      await this.persist();
      console.log(`[IpCountryCache] ${ip} → ${body} (cached)`);
    } catch (err) {
      console.warn(`[IpCountryCache] lookup failed for ${ip}:`, err);
    } finally {
      this.inflight.delete(ip);
    }
  }

  private async persist(): Promise<void> {
    try {
      const obj: Record<string, string> = {};
      // Sort keys for stable diffs across writes.
      const keys = [...this.cache.keys()].sort();
      for (const k of keys) obj[k] = this.cache.get(k)!;
      await writeFile(CACHE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[IpCountryCache] persist failed:', err);
    }
  }
}

/** ipapi.co accepts plain IPv4 / plain IPv6 but NOT IPv4-mapped IPv6
 *  (`::ffff:1.2.3.4` returns "Undefined"). Strip the prefix when present. */
function normalizeForApi(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isLocalIp(ip: string): boolean {
  if (!ip) return true;
  // Loopback
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // IPv4-mapped IPv6 — recurse after stripping the prefix
  if (ip.startsWith('::ffff:')) return isLocalIp(ip.slice(7));
  // RFC1918 private ranges
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  // IPv6 link-local / unique-local
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}
