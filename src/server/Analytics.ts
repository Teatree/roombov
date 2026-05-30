/**
 * Server-side analytics — fire-and-forget POSTs to a Google Apps Script web
 * app that appends rows to a Google Sheet.
 *
 * Spec: `docs/ANALYTICS-SPEC.md`. One sheet per event type:
 *   - MatchResults     — per real player, per finished match
 *   - ProfileSnapshots — paired with MatchResults; persistent state snapshot
 *   - ScreenEvents     — menu screen enter/exit
 *   - TutorialEvents   — tutorial enter/exit + reason
 *
 * Wire format:
 *   POST { secret, sheet, row: [...columns in spec order...] }
 *
 * The `row` array does NOT include a timestamp — Apps Script prepends its own
 * on receipt. Column order in each `log*` function must match the spec table.
 *
 * Rules:
 *   - No retries, no queues, no batching. Drop on failure.
 *   - No `await` in gameplay hot paths — every caller is fire-and-forget.
 *   - No-op silently when `ANALYTICS_WEBHOOK_URL` is unset.
 */

const WEBHOOK_URL = process.env.ANALYTICS_WEBHOOK_URL ?? '';
const SECRET = process.env.ANALYTICS_SECRET ?? '';

const ENABLED = WEBHOOK_URL.length > 0;

// One-shot status line so it's obvious from the server log whether
// analytics will fire. Logs at module-eval time (right after env.ts has
// already populated process.env from `.env`). Don't log the URL or secret —
// just whether they're present.
console.log(
  `[Analytics] ${ENABLED ? 'enabled' : 'DISABLED (ANALYTICS_WEBHOOK_URL unset)'}`
  + (ENABLED && !SECRET ? ' — warning: ANALYTICS_SECRET is empty' : ''),
);

type Sheet = 'MatchResults' | 'ProfileSnapshots' | 'ScreenEvents' | 'TutorialEvents';
type Cell = string | number | boolean;

function post(sheet: Sheet, row: Cell[]): void {
  if (!ENABLED) return;
  const body = JSON.stringify({ secret: SECRET, sheet, row });
  // Use the built-in fetch and intentionally do NOT await — caller is
  // running in a gameplay or transition hot path. Swallow all errors.
  //
  // Google Apps Script web apps redirect to a script.googleusercontent.com
  // origin to actually run; that redirect must be followed. The default
  // fetch behavior follows redirects, so leave that untouched.
  //
  // Response logging: log status + a body snippet on the first POST after
  // boot and on any non-2xx. Helps diagnose Apps Script deployment-access
  // issues (302 → login, 401, etc.) without spamming render logs.
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then(async (res) => {
      if (res.ok) {
        if (!firstSuccessLogged) {
          firstSuccessLogged = true;
          console.log(`[Analytics] First POST to ${sheet} OK (${res.status})`);
        }
        return;
      }
      // Non-2xx — surface so it's obvious in render logs. Include a body
      // snippet because Apps Script returns useful diagnostics there.
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      console.warn(`[Analytics] ${sheet} POST → HTTP ${res.status} ${res.statusText} | ${snippet}`);
    })
    .catch((err: unknown) => {
      console.warn(`[Analytics] ${sheet} POST network error:`, err);
    });
}

/** Tracks whether at least one POST has succeeded since boot. Drives a
 *  one-shot success log so the render log shows "analytics working" without
 *  spamming on every subsequent event. */
let firstSuccessLogged = false;

export type MatchOutcome = 'escaped' | 'killed' | 'timeout';

export interface MatchResultRow {
  ip: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "FI"). Empty when uncached or
   *  unresolvable (local IPs, lookup failure, lookup still in flight). */
  country: string;
  sessionId: string;
  matchId: string;
  profileId: string;
  profileName: string;
  bombermanName: string;
  bombermanTier: string;
  /** Stable map identifier the match was played on (e.g. "main_map",
   *  "desert_map", "tutorial_map"). Sheet column: `map_name`, positioned
   *  between `bombermanTier` and `outcome`. */
  mapName: string;
  outcome: MatchOutcome;
  turnsAlive: number;
  kills: number;
  /** Total HP this player removed from other Bombermen / Scavs this match.
   *  Sums bomb / mine / fire `damaged` events and `melee_attack` strikes.
   *  Sheet column: `damage_dealt`, between `kills` and `chestsOpened`. */
  damageDealt: number;
  chestsOpened: number;
  /** Number of turns this player ended on a chest tile — regardless of
   *  whether the chest still had loot. Superset of `chestsOpened`.
   *  Sheet column: `chestsLooted`, between `chestsOpened` and `bodiesLooted`. */
  chestsLooted: number;
  /** Same convention as `chestsLooted` but for dropped bodies.
   *  Sheet column: `bodiesLooted`, between `chestsLooted` and `spEarned`. */
  bodiesLooted: number;
  spEarned: number;
  /** Stringified `Partial<Record<TreasureType, number>>`, empty `{}` if killed. */
  treasuresGainedJson: string;
  /** Stringified `Partial<Record<BombType, number>>` of bombs PLACED this match. */
  bombsUsedJson: string;
  coinsAfter: number;
  stashTotalAfter: number;
}

export function logMatchResult(r: MatchResultRow): void {
  post('MatchResults', [
    r.ip,
    r.country,
    r.sessionId,
    r.matchId,
    r.profileId,
    r.profileName,
    r.bombermanName,
    r.bombermanTier,
    r.mapName,
    r.outcome,
    r.turnsAlive,
    r.kills,
    r.damageDealt,
    r.chestsOpened,
    r.chestsLooted,
    r.bodiesLooted,
    r.spEarned,
    r.treasuresGainedJson,
    r.bombsUsedJson,
    r.coinsAfter,
    r.stashTotalAfter,
  ]);
}

export interface ProfileSnapshotRow {
  ip: string;
  country: string;
  sessionId: string;
  profileId: string;
  coins: number;
  treasuresJson: string;
  bombStockpileTotal: number;
  ownedBombermenCount: number;
  totalMatchesPlayed: number;
}

export function logProfileSnapshot(r: ProfileSnapshotRow): void {
  post('ProfileSnapshots', [
    r.ip,
    r.country,
    r.sessionId,
    r.profileId,
    r.coins,
    r.treasuresJson,
    r.bombStockpileTotal,
    r.ownedBombermenCount,
    r.totalMatchesPlayed,
  ]);
}

export type ScreenEventType = 'enter' | 'exit';

export interface ScreenEventRow {
  ip: string;
  country: string;
  sessionId: string;
  visitId: string;
  profileId: string;
  profileName: string;
  screen: string;
  eventType: ScreenEventType;
  /** Empty on `exit`. `Boot` on the first navigation. */
  previousScreen: string;
  /** Empty on `enter`. Stringified empty for the wire. */
  durationMs: number | '';
  coinsAtEvent: number;
}

export function logScreenEvent(r: ScreenEventRow): void {
  post('ScreenEvents', [
    r.ip,
    r.country,
    r.sessionId,
    r.visitId,
    r.profileId,
    r.profileName,
    r.screen,
    r.eventType,
    r.previousScreen,
    r.durationMs,
    r.coinsAtEvent,
  ]);
}

export type TutorialExitReason = 'completed' | 'skipped' | 'abandoned';

export interface TutorialEventRow {
  ip: string;
  country: string;
  sessionId: string;
  tutorialRunId: string;
  profileId: string;
  profileName: string;
  eventType: ScreenEventType;
  /** Empty on `enter`. */
  exitReason: TutorialExitReason | '';
  /** Empty on `enter`. */
  furthestStepReached: string;
  /** Empty on `enter`. */
  durationMs: number | '';
}

export function logTutorialEvent(r: TutorialEventRow): void {
  post('TutorialEvents', [
    r.ip,
    r.country,
    r.sessionId,
    r.tutorialRunId,
    r.profileId,
    r.profileName,
    r.eventType,
    r.exitReason,
    r.furthestStepReached,
    r.durationMs,
  ]);
}

/** Short opaque id for visitId / tutorialRunId — base36, ~8 chars. */
export function newAnalyticsId(): string {
  return Math.random().toString(36).slice(2, 10);
}
