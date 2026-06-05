# Turn Duration Reduction — Impact Analysis & Recommendations

Audit prepared before the planned 25% reduction of each turn phase. Use this
as the per-aspect decision sheet during implementation.

## Change log

- **May 29, 2026 — 25% faster.** Each phase 2.0 s → 1.5 s (turn 4000 → 3000 ms).
  Burst pinned to absolute 1400 ms (see A3). Original subject of this doc.
- **Jun 3, 2026 — another 10% faster.** Each phase 1.5 s → 1.35 s (turn 3000 →
  2700 ms). No bucket-A pins needed — the 1400 ms burst pin from May 29 still
  holds, and melee impact had since been re-anchored to `ATTACK3_DURATION_MS`
  (no longer turn-derived), so the A7/B5 risks below are now moot. Tutorial
  pacing (section D) still NOT reviewed — carry forward.
- **Jun 5, 2026 — Jun 3 reverted.** Each phase 1.35 s → 1.5 s (turn 2700 →
  3000 ms), back to the May 29 timing per design call. Pure two-constant change;
  everything derives from `inputPhaseSeconds`/`transitionPhaseSeconds` so all
  animations rescaled automatically (the fixed-rate explosion sprite, ~667 ms,
  just gains more headroom in the longer transition).

## Context

| Phase       | Original | After May 29 | Jun 3 | Current (Jun 5) |
|-------------|---------:|-------------:|------:|----------------:|
| Input       | 2000 ms  | 1500 ms      | 1350 ms | 1500 ms       |
| Transition  | 2000 ms  | 1500 ms      | 1350 ms | 1500 ms       |
| **Total**   | 4000 ms  | 3000 ms      | 2700 ms | **3000 ms**   |

The change itself is two numbers in `src/shared/config/balance.ts:28-29`
(`inputPhaseSeconds: 2 → 1.5`, `transitionPhaseSeconds: 2 → 1.5`). Almost
everything else in the codebase derives from those constants and will rescale
on its own. The risk is in the handful of timings that are *visually* tied to
turn length — some of those should rescale (snappier = good), others should
NOT (e.g. explosions), and a couple are hardcoded copies that need to be
sanity-checked.

---

## TL;DR — Where to look during implementation

1. `src/shared/config/balance.ts:28-29` — the two source-of-truth values.
2. `src/client/scenes/MatchScene.ts:1503` — **explosion burst window**.
   Currently `transitionMs * 0.7`. **Change to absolute `1400 ms`** so
   explosions don't speed up. This is the single most important manual fix.
3. Everything else under "Auto-rescaled" below can be left alone the first
   pass and tuned only if it feels wrong in playtest.

---

## A. Auto-rescaled (formula-driven from `transitionMs` / `inputMs`)

These will **shorten by 25% automatically** the moment the balance constants
change. For each one, here's whether the shortened version is fine, needs a
tweak, or needs to be pinned to its old absolute value.

### A1. Walk / movement lerp — **LET IT SHRINK**
- `MatchScene.ts:1347` — `BEAT1_END_MS = transitionMs / 3`
- New: 500 ms (was 667 ms)
- Why fine: walks already feel deliberate. Snappier walks read as "more
  responsive turn" rather than "broken". The walk sprite is a fixed-fps loop
  so it just plays fewer frames — no stretch artifacts.

### A2. Throw arc — **LET IT SHRINK**
- `BombRenderer.ts:315` — arc flight `transitionMs / 3`
- `BombRenderer.ts:196` — landing visual deferred by `transitionMs / 3`
- New: 500 ms (was 667 ms)
- Why fine: thrown bombs trace the same arc, just faster. The landing dust
  and shake at fuseRemaining=0 are after the arc, so they're unaffected.

### A3. Explosion burst window — **PIN TO ABSOLUTE** ⚠
- `MatchScene.ts:1500, 1503`:
  - `explosionStartMs = BEAT1_END_MS` (now 500 ms — fine)
  - `burstDurationMs = transitionMs * 0.7` (would become 1050 ms; was 1400 ms)
- **Recommended change**: replace `Math.round(transitionMs * 0.7)` with a
  hard `1400` constant (or `Math.max(1400, Math.round(transitionMs * 0.7))`
  so it survives any future *increase* of the turn).
- Why: explosions should look the same. The sprite itself plays at fixed
  12 fps over ~667 ms regardless of turn length, but the *window* in which
  embers/dust/shock linger is controlled by `burstDurationMs`. Letting it
  shrink would clip ember fades and feel rushed.
- Side effect: explosions will now overlap into the next input phase by
  ~400 ms. That's already the case in places (HP delay, death anim, popup
  fades), so it's consistent with the existing pattern.

### A4. Bomb-landing shake (fuseRemaining=0) — **LET IT SHRINK**
- Same window as walk/throw (`BEAT1_END_MS`). Will become 500 ms. Fine — the
  shake is a brief telegraph, not a slow build.

### A5. HP-display delay — **LET IT SHRINK**
- `BombermanSpriteSystem.ts:203-204` — `hpDisplayUpdateAt = now + transitionMs`
- New: 1500 ms (was 2000 ms)
- Why fine: the delay exists so the HP pips don't flicker before the hurt
  animation finishes. Hurt is 12 fps × ~4 frames ≈ 333 ms, so 1500 ms still
  leaves plenty of buffer.

### A6. Door open delay — **LET IT SHRINK**
- `MatchScene.ts:1663` — `doorDelayMs = BEAT3_START_MS / 3` (so ≈ `transitionMs * 2/9`)
- New: ≈ 333 ms (was 444 ms)
- Why fine: this is just the offset before the door anim starts inside the
  beat-3 reaction window. The door sprite itself plays at fixed 8–12 fps.

### A7. Melee impact delays in MatchScene — **LET IT SHRINK** (verify in playtest)
- `MatchScene.ts:1402` — walk-interrupt impact at `transitionMs * 0.25`
  (375 ms vs 500 ms)
- `MatchScene.ts:1413` — walk-end impact at `transitionMs * 0.5`
  (750 ms vs 1000 ms)
- Why fine: these are *when the impact lands*, not *how long the swing
  takes*. The swing itself is hardcoded (see B5). Impact still lands cleanly
  inside the 500 ms swing window — but 750 ms is now uncomfortably close to
  the end of the swing. If it looks off, drop the multiplier to 0.4 (impact
  at 600 ms).

### A8. Escape-hatch idle indicator — **LET IT SHRINK**
- `MatchScene.ts:2076-2079` — progress ring spans
  `required * inputMs + (required - 1) * transitionMs`
- 2-turn requirement: was 6000 ms window, now 4500 ms.
- Why fine: it's the *visual* of the wait. The wait stays exactly 2 turns —
  it just looks the same proportion of the (now shorter) turn.

### A9. Hourglass / phase-progress widget — **LET IT SHRINK**
- "denominator = totalMs (input + transition)" model. Reads `phaseEndsAt`
  wall-clock — automatic.

---

## B. Hardcoded constants (won't move; decide if they should)

### B1. Sprite-sheet animations (idle / walk / run / hurt / death / throw) — **KEEP**
- `BombermanAnimations.ts:37-42` — fixed fps loops/one-shots (10/10/14/12/8/12 fps).
- Unaffected by turn length. Loops just play fewer cycles per turn.

### B2. Explosion sprite frame rate — **KEEP**
- `MatchScene.ts:513` — `explosion_sprite_anim frameRate: 12`
- 8 frames × 12 fps ≈ 667 ms per cycle, fixed. This is the visual identity
  of the explosion — exactly what we want to preserve. Don't touch.

### B3. Stun-indicator blink — **KEEP**
- `MatchScene.ts:523-525` — 2 fps deliberate blink. Reads correctly at any
  turn length.

### B4. Activity indicator pulse — **KEEP**
- `ActivityIndicator.ts:53` — 400 ms yoyo. Network UI, not gameplay.

### B5. Melee attack swing (`ATTACK3_DURATION_MS = 500`) — **KEEP, but FIX A BUG** ⚠
- `BombermanSpriteSystem.ts:605` — `ATTACK3_DURATION_MS = 500`
- `MatchScene.ts:1396` — **DUPLICATE constant declared as `600`**, with a
  comment that even claims it "matches BombermanSpriteSystem constant" —
  but it doesn't. This is a pre-existing drift bug.
- Recommendation: delete the MatchScene local copy and either import from
  `BombermanSpriteSystem` or promote the constant to `balance.ts`. Worth
  doing in the same commit since we're touching combat pacing.
- Sword fade `SWORD_FADE_MS = 400` — leave alone.

### B6. Coin / key / treasure popups (120 / 1200 / 1800 ms) — **KEEP**
- `MatchScene.ts:1930-1963, 2149-2156, 1902`
- These already routinely span past the end of the turn and that has always
  been fine. Don't shorten — popups are a slow-readable layer over fast
  gameplay.

### B7. Rush entry/exit indicators (1200 ms) — **KEEP**
- `MatchScene.ts:1824, 1842`. Independent of turn cadence.

### B8. Bomberman escape fade-out (300 ms) — **KEEP**
- `BombermanSpriteSystem.ts:484`. Triggered on escape; not turn-paced.

### B9. Explosion sub-effects (ember 533 ms, dust 1200-1800 ms, rock flash/shock/debris 80-900 ms) — **KEEP**
- All hardcoded in `BombRenderer.ts`. They live inside the burst window
  (which we're pinning to 1400 ms — see A3). No change.

### B10. Death animation (8 frames × 8 fps = 1000 ms) — **KEEP**
- Plays into the next turn. Already does today. Fine.

---

## C. Status effects measured in *turns* (real time shrinks 25%)

These don't change in code — but their real-time duration *does* drop with
the shorter turn. Flagged because they affect game feel even though no
constant moves.

### C1. Flash-bomb stun (1 turn) — **ACCEPT**
- Currently ~4 s of disable; will become ~3 s.
- Probably fine — stun was already short. If playtests show it feels too
  forgiving, bump `flashStunTurns` from 1 → 2 separately.

### C2. Confused-stumble (from stun → confused rework, May 28) — **ACCEPT**
- Turn-counted. Same logic as C1.

### C3. Shield-wall persistence (3 turns) — **ACCEPT**
- Was 12 s, becomes 9 s. Still long enough to block one volley.

### C4. Bleeding (10 turns) — **ACCEPT**
- Was 40 s, becomes 30 s. Still slow drain. Fine.

### C5. Phosphorus fire (2 turns) — **ACCEPT**
- Was 8 s, becomes 6 s. Visually unchanged; just a touch less zone control.

### C6. Escape-hatch idle (2 turns required) — **ACCEPT**
- The wait stays 2 turns. The visual ring (A8) rescales automatically.

### C7. Out-of-Combat Rush trigger (3 peaceful turns) — **ACCEPT**
- Triggers slightly sooner in wall-clock terms. Minor positive.

---

## D. Tutorial pacing — **REVIEW LATER** ⚠

`src/client/tutorial/tutorial-script.ts` has many hardcoded `delayBeforeMs` /
`delayAfterMs` values (100–3000 ms) for scripted beats, panning, and
narration pauses. These are NOT tied to turn duration today.

- Decision: don't change in the same commit. The tutorial's "wait for the
  player to read this text" beats are about reading speed, not turn cadence.
  After the turn change, walk through the tutorial once. If any beat feels
  like the action is racing ahead of the narration (likely around
  `delayAfterMs: 1000` at line 147, the fuse explanation), tune those values
  individually.

---

## E. Bot / Scav AI — **NO IMPACT**

`BotPlayer.ts` and `ScavPlayer.ts` compute actions synchronously at the
start of the input phase. No deliberation timer. They get 500 ms less
wall-clock time before their queued action is locked in, but since the
decision is instantaneous, the bot doesn't notice.

---

## F. Networking / server flow — **NO IMPACT**

`MatchRoom.ts:357, 512, 673, 678` all read `inputPhaseSeconds` and
`transitionPhaseSeconds` from `balance.ts`. Changing those constants
propagates to the server's `setTimeout` calls and `phaseEndsAt` broadcasts
automatically. The client computes its beat timings from the same source.
No second source of truth to update.

---

## Implementation steps

1. **Edit `src/shared/config/balance.ts:28-29`**:
   ```ts
   inputPhaseSeconds: 1.5,
   transitionPhaseSeconds: 1.5,
   ```
2. **Edit `src/client/scenes/MatchScene.ts:1503`** — pin explosion burst:
   ```ts
   const burstDurationMs = 1400;  // was: Math.round(transitionMs * 0.7)
   ```
3. **(Optional, same commit) Fix the duplicate `ATTACK3_DURATION_MS`** —
   delete `MatchScene.ts:1396` (the 600 ms copy + the now-misleading
   comment), import the 500 ms value from `BombermanSpriteSystem.ts:605`
   or promote it to `balance.ts`.

## Verification

- `npm test` — confirms no shared-logic regressions (most tests are pure
  TurnResolver tests; they don't care about ms values).
- `npm run typecheck` — guard against accidental type drift.
- Manual playtest checklist:
  1. **Walk** — feels snappier, no jitter at the start/end of the lerp.
  2. **Throw arc** — bomb lands cleanly before fuse tick.
  3. **Bomb shake** — visible at fuseRemaining=0 even though the window is
     500 ms (look for the squish).
  4. **Explosion** — sprite still plays full 8 frames; embers/dust still
     linger the same amount. **Compare side-by-side** with a pre-change
     screenshot/recording if possible.
  5. **Flash stun** — confirm the confused-stumble animation still plays
     cleanly inside one (shorter) turn.
  6. **Melee swing** — impact still lands on the connect frame (~65% in);
     no flicker between swing and idle.
  7. **HUD popups (coin / key / treasure)** — confirm they overlap into the
     next turn cleanly, no stacking artifacts.
  8. **Escape hatch idle ring** — fills smoothly over the 4.5 s window.
  9. **Tutorial** — full run-through. Flag any beat where text gets buried
     by the next action.

## Risks

- **Explosions may still feel faster** even with the burst pinned, because
  the start of the explosion is now 500 ms after walk-start instead of 667
  ms after. If so: also pin `explosionStartMs` to an absolute value
  (e.g. 500 ms is fine as a literal, since walk shrinks to 500 ms too).
- **Melee impact at `transitionMs * 0.5 = 750 ms`** is now uncomfortably
  close to the end of the 500 ms hardcoded swing. May need to drop the
  multiplier to 0.4 (so impact lands at 600 ms) if it looks off.
- **Tutorial** is the dark-horse risk — many hardcoded numbers, easy to
  miss one that needed adjustment. Allocate a dedicated tutorial pass after
  the main change lands.
