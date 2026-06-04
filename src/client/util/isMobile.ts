/**
 * Mobile-device detection for the in-match touch control scheme.
 *
 * The result gates the mobile-only UI (Move/Attack buttons + drag selector,
 * one-finger pan, pinch zoom) in MatchScene. Desktop play is completely
 * unaffected when this returns false.
 *
 * Resolution order:
 *   1. URL override `?mobile=1` / `?mobile=0` (also accepts true/false) — used
 *      for Playwright + manual testing on desktop, and to force-disable on a
 *      touch laptop.
 *   2. Auto-detect: a touch-capable device with a coarse primary pointer.
 *      Both must hold so desktop touchscreens with a mouse stay on the PC path.
 *
 * Evaluated once and cached — device class does not change within a session.
 */
let cached: boolean | null = null;

export function isMobileDevice(): boolean {
  if (cached !== null) return cached;
  cached = detect();
  return cached;
}

function detect(): boolean {
  // 1. Explicit URL override.
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('mobile');
    if (forced === '1' || forced === 'true') return true;
    if (forced === '0' || forced === 'false') return false;
  } catch {
    // window.location unavailable (non-browser) — fall through to auto-detect.
  }

  // 2. Auto-detect: touch capability AND a coarse primary pointer.
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const hasTouch = (nav?.maxTouchPoints ?? 0) > 0
    || (typeof window !== 'undefined' && 'ontouchstart' in window);
  const coarsePointer = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;

  return hasTouch && coarsePointer;
}

/** Test-only override; pass null to clear. */
export function __setMobileOverrideForTest(value: boolean | null): void {
  cached = value;
}
