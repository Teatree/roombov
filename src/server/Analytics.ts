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

type Sheet = 'MatchResults' | 'ProfileSnapshots' | 'ScreenEvents' | 'TutorialEvents';
type Cell = string | number | boolean;

function post(sheet: Sheet, row: Cell[]): void {
  if (!ENABLED) return;
  const body = JSON.stringify({ secret: SECRET, sheet, row });
  // Use the built-in fetch and intentionally do NOT await — caller is
  // running in a gameplay or transition hot path. Swallow all errors.
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch((err: unknown) => {
    console.warn(`[Analytics] ${sheet} POST failed:`, err);
  });
}

export type MatchOutcome = 'escaped' | 'killed' | 'timeout';

export interface MatchResultRow {
  ip: string;
  sessionId: string;
  matchId: string;
  profileId: string;
  profileName: string;
  bombermanName: string;
  bombermanTier: string;
  outcome: MatchOutcome;
  turnsAlive: number;
  kills: number;
  chestsOpened: number;
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
    r.sessionId,
    r.matchId,
    r.profileId,
    r.profileName,
    r.bombermanName,
    r.bombermanTier,
    r.outcome,
    r.turnsAlive,
    r.kills,
    r.chestsOpened,
    r.spEarned,
    r.treasuresGainedJson,
    r.bombsUsedJson,
    r.coinsAfter,
    r.stashTotalAfter,
  ]);
}

export interface ProfileSnapshotRow {
  ip: string;
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
