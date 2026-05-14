# Escape Hatch Rework — Implementation Spec

**Status:** Pending implementation
**Owner:** Claude Code (this session and future ones)
**Last updated:** 2026-05-14

This document is a self-contained handoff for the upcoming Escape Hatch rework. It captures the current behavior, the new requirements, the design decisions, and the concrete code-touch list. A future Claude (or other LLM) reading this should be able to implement the change without re-deriving any of the design.

---

## 1. Current behavior (what exists today)

### Server / shared (`src/shared/systems/TurnResolver.ts`)

- `MatchState.escapeTiles: Array<{x, y}>` — a flat list of hatch coordinates copied from the map JSON. Hatches have no IDs and no per-hatch state.
- Step **9.5 — Escape-hatch evaluation** (`TurnResolver.ts:1678-1697`):
  - For each alive, non-escaped bomberman, if they are on a hatch tile **and** their action this turn was `idle`, `onHatchIdleTurns` increments; otherwise it resets to 0.
  - When `onHatchIdleTurns >= 1`, `b.escaped = true`.
- Step **10 — Escapes** (`TurnResolver.ts:1699-1704`): emits one `escaped` event per newly-escaped bomberman with `{ playerId, treasures }`.
- A hatch can be used any number of times. No usage state is tracked.

### Client (`src/client/scenes/MatchScene.ts`)

- `escapeSprites: Array<{ x, y, sprite, state }>` is created once when the map loads (around `MatchScene.ts:652-673`). One animated sprite per escape tile.
- Animations registered in `BootScene` / preload section (`MatchScene.ts:322-345`): `hatch_closed`, `hatch_opening`, `hatch_open`, `hatch_closing`.
- `updateEscapeHatches()` (`MatchScene.ts:1668-1700+`) — runs every update, drives the per-hatch state machine purely from current `MatchState`:
  - If **any** alive non-escaped bomberman is within Chebyshev distance 1 → opening → open
  - If an `escaped` bomberman is on the tile → closing → closed
  - If no one is nearby and state is `open` → closing → closed
- All clients see the same animation off the broadcast state. **There is no per-client memory.** The fog-of-war (`FogRenderer.ts`) gates rendering of dynamic entities like enemies, but the hatch sprite is always drawn — it inherits the same dimming as the rest of the map under "seen-dim" / "unseen" fog, but its frame state always reflects authoritative state.

### Map data (`src/shared/types/map.ts`)

- `escapeTiles: TilePos[]` on `MapData`. No metadata beyond position.

### Bot AI (`src/server/BotPlayer.ts`)

- Hatches are treated as escape targets when looting/HP/timer conditions are met.

---

## 2. New behavior (what we are changing to)

### 2.1 Animation timing change

The opening animation should **no longer** play when a bomberman is merely adjacent to a hatch. Instead:

1. A bomberman stepping onto a hatch does **not** trigger the opening animation.
2. They idle on the hatch for one full turn (`onHatchIdleTurns >= 1`) — this is the existing escape-trigger logic, unchanged.
3. On the turn the escape resolves, the opening animation plays, the bomberman sprite disappears (existing behavior), then the closing animation plays.
4. After the closing animation finishes, the hatch sprite is swapped to `escape_hatch_broken.png` (already added at `public/sprites/escape_hatch_broken.png`).

### 2.2 One-time use

- A hatch becomes **broken** after exactly one bomberman uses it to escape.
- A broken hatch can never be used again — even if another bomberman idles on it for a turn, the escape does not fire.
- Map authoring is unchanged; brokenness is a runtime/match-scoped property.

### 2.3 Standing on a broken hatch (UX)

- **HUD red text**: while the local player is standing on a broken hatch, show a tiny red string to the right of the turn counter: *"This Hatch is Broken, you won't be able to Escape from it"*. The text disappears as soon as the player steps off.
- **Hover hint**: hovering over a broken hatch shows the same message in the existing tooltip system. The icon is the same hatch icon, **darkened programmatically via tint** (no new image asset — we don't have separate icons for these). A 0.5 brightness tint is a reasonable default.

### 2.4 Per-client "last known hatch state" (fog-of-war memory)

This is the most architecturally significant change. Today the fog renderer hides things but every client sees the same authoritative state. We now need a **local memory layer per client**:

- Each client maintains a `Map<"${x},${y}", "intact" | "broken">` of every hatch it has ever observed.
- A client updates its memory entry for a hatch only when the hatch tile is in its current LOS (`FogRenderer.isVisible(x, y) === true`) at the moment the escape event fires (for the broken transition) or during the regular update tick (for "still intact").
- Rendering rule:
  - Hatch tile **currently in LOS** → render authoritative state (intact or broken).
  - Hatch tile **in seen-dim (unseen-but-discovered) fog** → render the client's last-known memory state for that tile.
  - Hatch tile **fully unseen** → render whatever the rest of fog handles for unseen tiles (the sprite is hidden under the black layer anyway).
- Memory is session-local. It resets on every new match. No persistence across reconnects.

#### Worked example (must be testable end-to-end)

> Bomberman A escapes from hatch H1. Bomberman B has previously discovered the area around H1 (so it's under seen-dim fog) but does **not** have LOS on either A or H1 at the moment of escape.
>
> - B does **not** see the opening/closing animation play.
> - B's view of H1 remains **intact** (because B's last-known state was "intact" and it hasn't been updated).
> - If B later walks back into LOS of H1, B's memory updates to "broken" and the sprite swaps to `escape_hatch_broken`. No retroactive animation is played for B.

### 2.5 Bot AI

`BotPlayer.ts` must treat broken hatches as **non-escape tiles** when planning escape routes — skip them entirely. Pathing through them is fine (they're still walkable floor).

---

## 3. Design decisions (locked in)

| Q | Decision |
|---|----------|
| LOS rule for "saw the escape" | LOS on the hatch tile at the moment the `escaped` event fires |
| Hatch identity | Coord-key, `"${x},${y}"` — no ID field needed |
| Server event for "hatch was used" | **Piggyback on the existing `escaped` event** — add hatch coords to its payload |
| Red HUD text persistence | Visible only while the local player is standing on a broken hatch |
| Broken-hatch icon | Generated programmatically via tint (no new image) |
| Bot behavior | Broken hatches are skipped when picking an escape target |
| Local memory persistence | Match-scoped only (resets every match) |

---

## 4. Implementation plan

### 4.1 Shared layer

**`src/shared/types/match.ts`**
- Add to `MatchState`: `brokenHatches: Array<{ x: number; y: number }>` (or a coord-string set serialized as an array — array of `{x,y}` matches existing patterns and serializes cleanly).

**`src/shared/types/messages.ts`** (or wherever `TurnEvent` lives — check `messages.ts` first, then `match.ts`)
- Extend the `escaped` event variant: `{ kind: 'escaped'; playerId: string; treasures: TreasureBundle; hatchX: number; hatchY: number }`.
- All existing emit sites and consumers of `escaped` must be updated.

**`src/shared/systems/TurnResolver.ts`**
- `cloneState()` (`TurnResolver.ts:102`): add `brokenHatches: s.brokenHatches.map(t => ({ ...t }))`.
- Initial state construction (search for where `MatchState` is built — likely in `MatchRoom.ts` server-side and in `TutorialMatchBackend.ts`): initialize `brokenHatches: []`.
- Step 9.5: **before** setting `b.escaped = true`, check that `state.brokenHatches` does **not** include `{b.x, b.y}`. If broken, do not escape — but also do not reset `onHatchIdleTurns` punitively; the player can step off and the next idle on a different hatch should not be penalized. (Reasonable behavior: skip the escape check entirely on a broken hatch; the counter still increments harmlessly.)
- Step 10: when emitting `escaped`, include `hatchX: b.x, hatchY: b.y` and push the hatch into `state.brokenHatches` (de-duped — though by construction it can only happen once per hatch since the second escape attempt is now blocked).

### 4.2 Server layer

**`src/server/MatchRoom.ts`**
- Wherever the initial `MatchState` is created, initialize `brokenHatches: []`. (Confirm there isn't a defensive backfill pattern in use — see existing patterns for newly-added fields per `MEMORY.md > feedback_architecture`.)

**`src/server/BotPlayer.ts`**
- Filter `state.escapeTiles` against `state.brokenHatches` whenever the bot considers an escape destination.

### 4.3 Client layer

**`src/client/scenes/MatchScene.ts`**
- **Sprite preload**: load `escape_hatch_broken.png` in the preload section near where `escape_hatch.png` is loaded (~line 264). It's a static image, not a spritesheet.
- **Local memory field**: add `private hatchMemory: Map<string, 'intact' | 'broken'> = new Map()` (cleared in `shutdown()` / on scene init).
- **Replace `updateEscapeHatches()`** (~`MatchScene.ts:1668`) with a new state machine driven by:
  - The local `hatchMemory` for the rendered frame state when the tile is not currently in LOS.
  - The authoritative `state.brokenHatches` for the frame state when the tile **is** in LOS (and update memory at the same time).
  - Animation playback is now triggered **only** by handling the `escaped` event (see below) — not by passive bomberman proximity.
- **Event handler for `escaped`**: in the existing per-event dispatch in MatchScene (search for `ev.kind === 'escaped'` — currently around `MatchScene.ts:1387`), if the local fog renderer reports the hatch tile is visible at this moment, play `hatch_opening` on that sprite, chained to `hatch_closing`, then swap the sprite texture to `escape_hatch_broken`. If the hatch tile is **not** visible, do nothing — `hatchMemory` will remain on its prior value (which may be `intact`), and the broken state only propagates to this client when LOS is later re-established.
- **HUD red text**: in the HUD layer (find the turn counter — search for "Turn" string), add a `Phaser.GameObjects.Text` to its right with color `#ff4040` (or similar), visibility toggled each frame based on whether the local bomberman's `{x, y}` is in `state.brokenHatches`. Hidden by default. Hide on `shutdown()`.

**`src/client/systems/MapRenderer.ts`** (and/or wherever hover/tooltip lookups happen)
- Tooltip / hover hint for a broken hatch: show the existing hatch icon tinted to e.g. `0x808080` (50% brightness) with the message *"This Hatch is Broken, you won't be able to Escape from it"*. Hook this into the existing tooltip dispatch — search for the keyword `Tooltip` or `TooltipScene` to find the hover-icon registration site.

**`src/client/backends/TutorialMatchBackend.ts`**
- Tutorial backend also runs `resolveTurn` locally; ensure `brokenHatches: []` is part of the initial state it builds. If the tutorial includes the hatch step (it does — see memory S107), confirm the tutorial still completes after this change. The tutorial uses one hatch; after escaping the tutorial ends, so broken-state never matters in tutorial — but `brokenHatches` must be a valid empty array so the resolver and renderer don't crash.

### 4.4 Tests (vitest, pure-function)

- **New test file**: `tests/escape-hatch.test.ts`
  - A bomberman idling on a hatch for one turn sets `escaped` and pushes coords into `brokenHatches`.
  - A second bomberman idling on the same hatch later does **not** escape, and `brokenHatches` does not grow.
  - The `escaped` event payload includes `hatchX` and `hatchY`.
  - Cloning state preserves `brokenHatches`.
- Update any existing tests that destructure or pattern-match on the `escaped` event payload.

### 4.5 Playwright MCP test (multi-perspective)

**Constraint discovered while writing this spec:** the Playwright MCP exposes `mcp__playwright__browser_tabs` for managing multiple tabs in a single browser, but does **not** expose multi-context / incognito creation. The client stores `playerId` in `localStorage` (`NetworkManager.ts:41-52`), and localStorage is shared across tabs. Therefore, two tabs in one Playwright session both authenticate as the same player.

**Recommended approach** for the fog-of-war scenario test: use **one Playwright tab as the human player and let the existing `BotPlayer` fill the opposing slot.** The bot can be steered into specific positions for the test by carefully crafting the match start state, or — if more determinism is needed — add a small test-only hook to script bot actions.

**Less-recommended fallbacks** if a true two-human-player test is needed later:
- Use `mcp__playwright__browser_evaluate` to override `localStorage` per tab before the BootScene reads it.
- Add a permanent `?playerId=foo` query-string override in `BootScene` (small permanent change for QA only).

**Test scenario** (must hold per the spec):

1. Start a 2-player match: P1 = human (Playwright), P2 = bot.
2. Drive P1 to a position where they can see hatch H1 but not hatch H2, and where they have explored the area around H2 (so H2 is in seen-dim fog for P1, not unseen).
3. Wait for the bot to escape via H2 (or scripted-bot-move to that effect).
4. **Assert**: P1 does not see an opening/closing animation play on H2. P1's view of H2 still shows the intact `escape_hatch` sprite (not `escape_hatch_broken`).
5. Move P1 toward H2 until LOS is acquired.
6. **Assert**: H2's sprite swaps to `escape_hatch_broken` immediately (no animation), and stepping P1 onto H2 shows the red HUD text + idling on it does **not** escape.

Capture screenshots (`mcp__playwright__browser_take_screenshot`) at each assertion step. Record a GIF (`mcp__claude-in-chrome__gif_creator`) of the whole flow for review.

---

## 5. Files touched (summary)

```
src/shared/types/match.ts                    [+brokenHatches field]
src/shared/types/messages.ts (or match.ts)   [+hatchX, hatchY on escaped event]
src/shared/systems/TurnResolver.ts           [skip broken, push broken, payload]
src/server/MatchRoom.ts                      [init brokenHatches: []]
src/server/BotPlayer.ts                      [filter broken hatches]
src/client/backends/TutorialMatchBackend.ts  [init brokenHatches: []]
src/client/scenes/MatchScene.ts              [memory, render rule, event animation, HUD text, broken sprite preload]
src/client/systems/MapRenderer.ts            [tooltip hover wiring — confirm exact site]
tests/escape-hatch.test.ts                   [new vitest file]
docs/escape-hatch-rework.md                  [this file]
```

---

## 6. Out of scope

- Persisting hatch usage across reconnects or page refreshes.
- New art assets beyond the already-present `escape_hatch_broken.png`.
- Changing the existing one-turn idle escape rule.
- Tutorial flow changes.
- Cosmetic polish beyond the opening → closing → broken sprite swap (e.g. dust puff, particle burst — separate ticket if desired).

---

## 7. Verification checklist (before declaring done)

- [ ] `npm run typecheck` clean
- [ ] `npm test` — all existing tests pass, new escape-hatch tests pass
- [ ] Manual: open one match, escape once, second bomberman attempting to escape from the same hatch is blocked
- [ ] Manual: stepping on a broken hatch shows the red HUD text and removes it on step-off
- [ ] Manual: hover tooltip on a broken hatch shows the dimmed icon and broken message
- [ ] Playwright: fog-of-war scenario in §4.5 passes the two assertions

---

## 8. Memory hooks for future Claude sessions

- The change is recorded in `MEMORY.md` after implementation.
- Cross-reference: `docs/PROJECT-SUMMARY.md` should get a one-line update under the escape/match flow if any.
- Existing memory `feedback_architecture` already covers "defensive backfill for new persisted fields" — `brokenHatches` should be backfilled defensively when reading older saved/in-flight states. Add this defensive read in `MatchRoom`'s state construction and in `cloneState()`.
