/**
 * Pixel Panel design tokens — the single source of truth for the UI restyle
 * described in docs/PIXEL_PANEL_STYLE_HANDOFF.md §1.1–1.2.
 *
 * Colors are exported in BOTH forms because Phaser needs different types in
 * different APIs:
 *   - `COL.*`  → number (0xRRGGBB)  for Graphics fill/stroke + Image tints
 *   - `CSS.*`  → string ('#rrggbb') for Text styles (color / backgroundColor)
 *
 * Do NOT invent new colors in scenes; reuse the closest semantic token. If a
 * genuinely new need arises, add it here once.
 */

/** Raw hex strings — the canonical values from the handoff color table. */
export const HEX = {
  bg: '#191428',          // screen background (all screens)
  panel: '#221b35',       // panel fill
  panel2: '#1e1730',      // nested/recessed fill (inside a panel)
  border: '#3a2f54',      // default 2px panel border, 1px inner dividers
  borderHi: '#5b4a7d',    // hover / emphasized border
  text: '#e8e1cf',        // primary text (warm off-white)
  dim: '#9a8eb0',         // secondary text
  faint: '#5e526f',       // tertiary text, labels, empty-state glyphs
  gold: '#ffc83a',        // PRIMARY accent: main CTA fill, coins, partial counts
  goldEdge: '#a87f1a',    // border on gold-filled elements
  goldText: '#241a06',    // text on gold fill (never white-on-gold)
  green: '#7ad159',       // yours / positive: equipped, joined, full, STACK
  red: '#ff5a4a',         // HP stat, urgent timers (<=5s), destructive actions
  blue: '#5db5ff',        // link-style actions, CAP stat, informational
  orange: '#ffa14d',      // special match modes (anything not "Normal")
  stageFrame: '#0d0a18',  // letterbox + title text-shadow + near-black HUD bars
  debugRed: '#7e453c',    // debug-only footer actions (muted)
  statusGreen: '#5d8a4a', // muted connection status line
  tutorialBlue: '#36527a',// dashed tutorial button border (hover -> blue)
} as const;

export type TokenName = keyof typeof HEX;

/** String form for Phaser Text styles. */
export const CSS = HEX;

/** Number form for Phaser Graphics / tints. */
export const COL = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => [k, Number.parseInt(v.slice(1), 16)]),
) as Record<TokenName, number>;

/**
 * Stat color-coding (handoff §1.4) — HP=red, CAP=blue, STACK=green. Used
 * EVERYWHERE a stat appears (boxes, popups, upgrade tracks). Both the label and
 * the value take the color. Keyed by the upgrade-track / stat identifier.
 */
export const STAT_HEX = { hp: HEX.red, cap: HEX.blue, stack: HEX.green } as const;
export const STAT_COL = { hp: COL.red, cap: COL.blue, stack: COL.green } as const;
export type StatKey = keyof typeof STAT_HEX;

/** Font families (loaded via index.html Google Fonts; gated in BootScene). */
export const FONT = {
  /** Headings, button labels, "game data" numerals (timers, prices, counts). */
  press: '"Press Start 2P"',
  /** Body copy, field labels, meta text, link-style actions. */
  silk: '"Silkscreen"',
} as const;

/**
 * Resolve when both pixel fonts have loaded, so Phaser caches correct glyph
 * metrics before the first text is rendered. Safe to call repeatedly; falls
 * back silently if the FontFace API is unavailable or the network fails.
 * Gated once in BootScene.create() before starting MainMenuScene.
 */
export async function ensureFontsLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.all([
      document.fonts.load(`16px ${FONT.press}`),
      document.fonts.load(`16px ${FONT.silk}`),
      document.fonts.load(`700 16px ${FONT.silk}`),
    ]);
    await document.fonts.ready;
  } catch {
    /* use whatever is available */
  }
}

/**
 * Level badge color ramp (handoff §1.4 / §1.7): 1-2 green, 3-4 gold, 5+ red.
 * Returns both forms for convenience.
 */
export function levelRampHex(level: number): string {
  if (level >= 5) return HEX.red;
  if (level >= 3) return HEX.gold;
  return HEX.green;
}
export function levelRampCol(level: number): number {
  if (level >= 5) return COL.red;
  if (level >= 3) return COL.gold;
  return COL.green;
}

/**
 * Timer urgency ramp (handoff §1.4): >15s neutral, <=15s gold, <=5s red.
 * Applied simultaneously to the countdown numeral, the segment bar, and any
 * urgency-promoted button. `neutral` defaults to primary text but callers may
 * pass green for segment fills.
 */
export type Urgency = 'calm' | 'soon' | 'urgent';
export function urgencyOf(secondsRemaining: number): Urgency {
  if (secondsRemaining <= 5) return 'urgent';
  if (secondsRemaining <= 15) return 'soon';
  return 'calm';
}
export function urgencyHex(u: Urgency, calm: string = HEX.text): string {
  return u === 'urgent' ? HEX.red : u === 'soon' ? HEX.gold : calm;
}
export function urgencyCol(u: Urgency, calm: number = COL.green): number {
  return u === 'urgent' ? COL.red : u === 'soon' ? COL.gold : calm;
}
