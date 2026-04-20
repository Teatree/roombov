# Tutorial — Design & Implementation Plan (v3)

## 0. Changes from v2

- **New Beats 0 & 2 (HUD Primer, Practice Throw)** added to the front of the
  lesson plan.
- **Beat 6 (Melee Trap) sequencing reworked**: the player is directed to the
  crouch tile `(17, 10)` *first*. Bot2 stays dormant at `(27, 10)` until the
  player arrives and crouches. Only then does Bot2 begin its scripted walk.
- **Self-click-to-idle is muted** in all beats before Beat 6. When a beat
  needs the player to wait a turn (bomb timers, flare recharge, etc.) the
  tutorial uses a new `promptIdle` step that displays "Click to wait this
  turn" and, on click, fires an idle + `resolveTurn` via the director —
  bypassing the mute. Beat 6 is the first place the player is explicitly
  **taught** self-click-to-idle (as the crouch input), and the mute is
  lifted there and for the rest of the tutorial.
- **Doors** are parsed and rendered identically to the main game. No
  tutorial-specific door logic. Existing proximity-open mechanic applies to
  Bot2 as it walks the path.
- **Dialogue/pause skip text** unified to **"Click to Continue"**.
  Click-only, no key-based advance.
- **Exit**: `endTutorial` hands off to the existing `MatchEndScene` with
  `{ title: "Tutorial Finished", subtitle: "Ready for a real match?" }`,
  whose "Main Menu" button returns to `MainMenuScene`.
- **Portrait** is a runtime crop of the `char4` idle spritesheet (top 40%,
  2× scaled). No new asset required.
- **Open questions from v2 (§10)** are all resolved; the §10 section is
  removed.

---

## 1. Context

An earlier iteration built a standalone `TutorialScene` that reimplemented
large parts of `MatchScene` (bomb tray, loot panel, IDLE button, input
handling). That failed the core test of a tutorial: **teach the real UI**.
Players ended up learning widgets that don't exist in a live match.

This revision **reuses `MatchScene` unchanged** for the in-game view and
drives it through a pluggable `MatchBackend` abstraction. The tutorial runs
inside the real match loop, with scripted bots and a thin overlay scene
layered on top for dialogue, highlights, and pause control. Everything the
player sees in the tutorial — slots, loot panel, HP pips, throw arcs,
timer, fog, doors, explosions — matches a live match byte-for-byte.

This means future balance changes (turn time, HP, bomb blast radius),
renderer changes, and gameplay rule changes automatically flow into the
tutorial. The tutorial does not fork the game; it *scripts* it.

---

## 2. What the tutorial teaches (in order)

| # | Beat | Summary |
|---|---|---|
| 0 | **HUD Primer** | Passive tour of the interface: phase, timer, HP, coins, bomb tray. |
| 1 | **Movement** | Click a highlighted tile to walk. One tile per turn. |
| 2 | **Practice Throw** | Use the Rock slot to throw at a wall — teaches arc and commit. |
| 3 | **Looting (Chest)** | Walk onto chest; coins auto, bombs via the real loot panel. |
| 4 | **Flare + Bomb kill** | Arm Flare, illuminate bot. Arm Bomb, kill bot. Wait one turn for fuse. |
| 5 | **Avoid a bomb** | Bot2 throws at the player's tile — move diagonally, wait it out. |
| 6 | **Melee Trap** | Walk to (17, 10). Crouch (self-click = idle). Bot2 walks into range. Counter-kills on step-in. |
| 7 | **Loot the body** | Walk onto Bot2's body. Real loot panel for its dropped bombs. |
| 8 | **Escape** | Walk to the hatch. Idle one turn to extract. |

Plus: opening dialogue, beat-boundary pauses, closing summary, `MatchEnd`
hand-off.

---

## 3. Required UX directives

| Directive | How it's built |
|---|---|
| **Total pause** | Full-screen dim + centered text "Click to Continue". Click anywhere advances. |
| **Highlight** | Pulsing yellow outline on a tile or a HUD element. Tutorial queries `MatchScene.getHudRect(target)` / `getWorldRect(x, y)` — **no hardcoded screen positions**. Re-queried each frame while active so HUD layout changes don't break it. |
| **Dialogue** | Character portrait (close-up char4) + text **docked bottom-right**. Footer reads "Click to Continue". Clicking anywhere advances. |
| **Input block** | Timed `inputBlockedUntil` gate. The overlay's full-screen click catcher swallows clicks while set. |
| **Camera pan (lerp)** | `cameras.main.pan(x, y, ms, 'Cubic.easeOut', force=true, onComplete)`. When the pan completes the director advances. |
| **Idle mute** | Director flag. Player `sendAction({kind:'idle'})` is swallowed until the Melee Trap beat unmutes it. Internal `director.forceIdleAndResolve()` is never muted. |

---

## 4. Architecture

### 4.1 The `MatchBackend` abstraction

`MatchScene` today is coupled to the network through a narrow surface (3
`socket.on` listeners, 2 `socket.emit` calls, 1 `ProfileStore.get()`). We
extract that surface into an interface:

```ts
export interface MatchBackend {
  /** Called once by MatchScene in create(). Backend begins feeding state. */
  start(): void;

  /** Client → server (or client → local resolver). */
  sendAction(action: PlayerAction): void;
  sendLoot(msg: LootBombMsg): void;

  /** Server → client (or resolver → client). MatchScene subscribes once. */
  onMatchState(cb: (state: MatchState) => void): void;
  onTurnResult(cb: (events: TurnEvent[]) => void): void;
  onMatchEnd(cb: (data: MatchEndData) => void): void;

  /** Called by MatchScene.shutdown(). Must unregister everything. */
  destroy(): void;
}
```

Two implementations:

- `SocketMatchBackend` — today's wiring, lifted unchanged out of MatchScene.
  Zero behavior change for real matches.
- `TutorialMatchBackend` — owns a `TutorialDirector`, runs `resolveTurn`
  locally, fires `onMatchState` / `onTurnResult` callbacks as if they came
  from the server.

### 4.2 MatchScene changes (minimal, surgical)

```ts
MatchScene.init(data: {
  matchId?: string | null;
  mode?: 'network' | 'tutorial';        // new; default 'network'
}): void
```

In `create()`:

```ts
this.backend = this.mode === 'tutorial'
  ? new TutorialMatchBackend(this)
  : new SocketMatchBackend();
this.backend.onMatchState(s => this.onMatchState(s));
this.backend.onTurnResult(e => this.onTurnResult(e));
this.backend.onMatchEnd(d => this.onMatchEnd(d));
this.backend.start();

if (this.mode === 'tutorial') {
  this.scene.launch('TutorialOverlayScene', { backend: this.backend });
}
```

Every `socket.emit('player_action', ...)` / `.emit('loot_bomb', ...)`
becomes `this.backend.sendAction(...)` / `this.backend.sendLoot(...)`.
Every `socket.on(...)` / `socket.off(...)` is deleted from MatchScene —
the backend owns those.

`ProfileStore` coupling (line 230-238): in tutorial mode, MatchScene uses
a hard-coded `myPlayerId = 'tutorial-player'` and skips `UiAnimLock.clear`
calls that assume a network round-trip.

**Total diff to MatchScene: ~30–40 lines** (remove 3 socket.on blocks, add
backend field + wiring, add mode check in `create()`/`shutdown()`, add
`getHudRect()` / `getWorldRect()` / `getMainCamera()` accessors for the
overlay). All rendering, input, HUD, fog, pathfinding, loot UI stays
byte-identical.

### 4.3 The overlay — a parallel Phaser scene

`TutorialOverlayScene` runs **in parallel** with `MatchScene`. It has its
own camera (ignoring the world), sits above MatchScene's HUD camera, and
owns:

- **Dialogue panel** (bottom-right, 420×140 px): portrait box (128×128) +
  text (with word wrap) + "Click to Continue" footer.
- **Pause screen**: full-screen dim (0×0 to game size, 0x000000 at 0.6α) +
  centered message.
- **Highlight layer**: pulsing yellow rectangle outlines. Draws over both
  world and HUD — world-space highlights use `MatchScene.getMainCamera()`'s
  transform; HUD-space highlights use screen coords.
- **Click catcher**: transparent full-screen quad on top of everything
  during dialogue/pause. Swallows click events and fires the appropriate
  advance signal.
- **MatchEnd hand-off**: when director fires `endTutorial`, the overlay
  emits a `MatchEndData`-shaped message to the backend, which emits
  `onMatchEnd`, which makes MatchScene transition to `MatchEndScene`
  exactly as in a real match.

The overlay queries `MatchScene` for HUD positions rather than hardcoding:

```ts
class MatchScene {
  getHudRect(target: HighlightTarget): Rect | null;
  getWorldRect(tileX: number, tileY: number): Rect;
  getMainCamera(): Phaser.Cameras.Scene2D.Camera;
}
```

### 4.4 The `TutorialDirector`

Lives inside `TutorialMatchBackend`:

- Reads the script (typed `TutorialStep[]` from `tutorial-script.ts`).
- Maintains `expected: ExpectedAction | null` and `idleMuted: boolean`.
- When MatchScene calls `backend.sendAction(a)`:
  - If `a.kind === 'idle'` **and** `idleMuted` → swallow silently.
  - Else if `a` matches `expected` → forward to local `resolveTurn`,
    emit `match_state` + `turn_result` back via the `on*` callbacks,
    advance script past the `waitForAction`.
  - Else → command overlay to flash a hint, swallow the action. MatchScene
    sees no state change, no animation. The click felt real but the
    tutorial stays on the lesson.
- Commands the overlay for non-blocking steps (dialogue, highlight,
  panCamera, pause, blockInput, promptIdle).
- Forces idles via `forceIdleAndResolve()` when `promptIdle` clicks advance,
  bypassing the mute.

### 4.5 Overall scene layout

```
MainMenuScene
  └─ [ TUTORIAL ] button ─► scene.start('MatchScene', { mode: 'tutorial' })
                             │
                             MatchScene.create():
                             ├─ backend = new TutorialMatchBackend(this)
                             ├─ backend.start()                            // fires first match_state
                             └─ scene.launch('TutorialOverlayScene', …)    // parallel
                                                                │
                                                                overlay.create():
                                                                ├─ director = backend.director
                                                                └─ director.start()

(Overlay runs forever-on-top until director.end() → backend emits
 match_end → MatchScene transitions to MatchEndScene → MainMenu)
```

---

## 5. The tutorial map

The user has authored `public/maps/tutorial_map.tmj` (32×48 tiles, 16 px).

| Layer | Object | Tile coords |
|---|---|---|
| Spawns | `Spawn1` | (6, 9) |
| EscapeTiles | `Escape1` | (26, 7) |
| Chest2Zones | `Chest2Zone1` | ~(10, 9) |
| **Tutorial** | `Tutorial_Bot1` | (17, 10) |
| **Tutorial** | `Tutorial_Bot2` | (27, 10) |
| **Tutorial** | `Tutorial_Bot_Path` | (18, 10) |
| Doors | (standard tile layer) | whatever the map author placed |

### 5.1 Pipeline changes

1. **Extend `MapData`** (in `src/shared/types/map.ts`) with an optional
   `tutorial` field:
   ```ts
   tutorial?: {
     bot1: { x: number; y: number };
     bot2: { x: number; y: number };
     bot2Path: { x: number; y: number };
   };
   ```
2. **Extend `tools/tiled-to-roombov.ts`** to scan the `Tutorial` object
   layer and populate `tutorial` in the output JSON. Objects keyed by
   `name`: `Tutorial_Bot1`, `Tutorial_Bot2`, `Tutorial_Bot_Path`.
3. **Run the converter**: `./export-maps.sh tutorial_map` produces
   `src/shared/maps/tutorial_map.json` and `public/maps/tutorial_map.json`.
4. **Register** in `src/shared/maps/map-loader.ts`: static-import the new
   JSON and add to `STATIC_MAPS`. (No manifest change needed — static
   import short-circuits the manifest lookup.)

### 5.2 Doors

No tutorial-specific door logic. The converter's existing door-parsing
pass handles the `Doors` tile layer as normal; MatchScene's existing
`DoorRenderer` and proximity-open rule (Chebyshev ≤ 1 to any Bomberman)
governs behavior. If the author places a closed door on Bot2's path,
Bot2 will open it as it walks into range — same as any Bomberman.

### 5.3 Bot path geometry (confirmed)

- Bot 1 spawns at `(17, 10)` from `Tutorial_Bot1`. Dies in place in Beat 4
  → body at `(17, 10)`.
- Bot 2 spawns at `(27, 10)` from `Tutorial_Bot2`. Throws a bomb in Beat 5.
  In Beat 6 walks west tile-by-tile toward `(18, 10)` (the
  `Tutorial_Bot_Path` terminus). Stops at `(18, 10)` permanently.
- Player crouches at `(17, 10)` (on top of Bot1's body — legal, bodies are
  walkable). `(17, 10)` is Chebyshev-1 adjacent to `(18, 10)`, so Bot2's
  step-in to `(18, 10)` triggers the melee counter. Bot2 dies, body at
  `(18, 10)`.
- Beat 7 body-loot: player walks `(17, 10) → (18, 10)`.
- Beat 8 escape: player walks from `(18, 10)` toward hatch `(26, 7)`;
  teleport shortens the distance to keep pacing tight.

---

## 6. Files to create / modify

| File | Kind | Est. LOC |
|---|---|---|
| `src/shared/types/map.ts` | modify — add optional `tutorial` field | +6 |
| `tools/tiled-to-roombov.ts` | modify — parse Tutorial layer | +25 |
| `src/shared/maps/tutorial_map.json` | **generated** by converter | ~2k |
| `src/shared/maps/map-loader.ts` | modify — static-import tutorial_map | +3 |
| `src/client/backends/MatchBackend.ts` | new — interface + shared types | ~40 |
| `src/client/backends/SocketMatchBackend.ts` | new — today's socket wiring lifted out | ~80 |
| `src/client/backends/TutorialMatchBackend.ts` | new — local resolver + director host | ~220 |
| `src/client/scenes/MatchScene.ts` | modify — `backend` field, `mode` init, `getHudRect/getWorldRect/getMainCamera` | ~-40 / +50 |
| `src/client/scenes/TutorialOverlayScene.ts` | new — parallel scene: dialogue/pause/highlights/click-catcher | ~300 |
| `src/client/tutorial/TutorialDirector.ts` | new — script state machine, idle mute, expected-action validation | ~280 |
| `src/client/tutorial/types.ts` | new — `TutorialStep` / `ExpectedAction` / `HighlightTarget` | ~110 |
| `src/client/tutorial/tutorial-script.ts` | new — **the editable script** | ~320 |
| `src/client/scenes/MainMenuScene.ts` | modify — add `[ TUTORIAL ]` button | +3 |
| `src/client/main.ts` | modify — register `TutorialOverlayScene` | +2 |

Total: ~1350 lines of new code, ~50 lines of modifications to existing
files. MatchScene's net change is near zero (refactor socket wiring into a
backend, then swap backend based on mode).

---

## 7. The editable script

TypeScript, not JSON — `mutateState` needs closures, and compile-time
`BombType` / `CharacterVariant` checks catch script typos immediately.

### 7.1 Step kinds

```ts
export type TutorialStep =
  // Narration
  | { kind: 'dialogue'; portrait: PortraitId; text: string }
  | { kind: 'pause'; text?: string }

  // Idle prompts (while self-click-idle is muted)
  | { kind: 'promptIdle'; text: string }        // click fires forced idle + resolveTurn

  // Attention
  | { kind: 'highlight'; target: HighlightTarget }
  | { kind: 'clearHighlight' }
  | { kind: 'panCamera'; focus: { x: number; y: number } | 'player'; durationMs: number }
  | { kind: 'blockInput'; durationMs: number }

  // Mode flags
  | { kind: 'setIdleMuted'; muted: boolean }

  // Setup (non-blocking; mutates the local match state)
  | { kind: 'mutateState'; mutate: (s: MatchState) => void }
  | { kind: 'spawnBot'; botId: string; x: number; y: number;
      character?: CharacterVariant; tint?: number; hp?: number;
      inventory?: Array<{ slot: 0|1|2|3; type: BombType; count: number }> }
  | { kind: 'spawnChest'; chestId: string; tier: 1|2; x: number; y: number;
      coins: number; bombs: Array<{ type: BombType; count: number }> }
  | { kind: 'equipPlayerBomb'; slot: 0|1|2|3; type: BombType; count: number }
  | { kind: 'teleportPlayer'; x: number; y: number }

  // Scripted turn resolution
  | { kind: 'waitForAction'; expected: ExpectedAction; hintText?: string }
  | { kind: 'setBotAction'; botId: string; action: PlayerAction }
  | { kind: 'resolveTurn' }

  // Lifecycle
  | { kind: 'endTutorial'; message?: string };

export type ExpectedAction =
  | { kind: 'moveTo'; x: number; y: number }
  | { kind: 'throwAt'; slotIndex: 0|1|2|3|4; x: number; y: number; bombType?: BombType }
  | { kind: 'idle' }
  | { kind: 'lootBomb'; sourceKind: 'chest'|'body'; bombType: BombType };

export type HighlightTarget =
  | { kind: 'tile'; x: number; y: number }
  | { kind: 'slot'; index: 0|1|2|3|4 }         // 0 = Rock, 1-4 = inventory
  | { kind: 'lootPanel' }
  | { kind: 'phaseIndicator' }
  | { kind: 'timer' }
  | { kind: 'hp' }
  | { kind: 'coinCounter' }
  | { kind: 'bombTray' }                        // all four inventory slots as one rect
  | { kind: 'rect'; x: number; y: number; w: number; h: number; space: 'world'|'hud' };

export type PortraitId = 'char4' | 'char4_angry' | null;
```

### 7.2 Idle: mute, prompt, and teach

The real game has **no IDLE button**. Players idle by pressing ESC or by
clicking their own tile. The tutorial teaches **self-click-to-idle** (the
more discoverable of the two) — but not until Beat 6, where idling
*is the mechanic being taught* (crouch → Melee Trap Mode).

Before Beat 6, self-click-to-idle is muted:
- Script emits `{ kind: 'setIdleMuted', muted: true }` as the very first
  step (redundant with the default, but explicit).
- `TutorialDirector.sendActionFromPlayer(a)` checks `idleMuted` before
  validating against `expected`. If `a.kind === 'idle'` and muted, the
  action is swallowed silently.
- When a beat needs the player to wait (e.g. bomb fuse), the script uses
  `promptIdle` instead — the overlay renders a dialogue-like prompt
  ("Click to wait this turn"), and on click the overlay calls
  `director.forceIdleAndResolve()` which bypasses the mute and runs
  `resolveTurn` with an idle action on the player's behalf.
- Beat 6's first instruction is `{ kind: 'setIdleMuted', muted: false }`.
  From then on, normal self-click-to-idle works in the tutorial exactly as
  in a real match.

### 7.3 Loot via the real panel

The loot panel is MatchScene's existing `renderLootPanel()` — it
auto-opens when the player stands on a chest or body with bombs. The
tutorial's `waitForAction: { kind: 'lootBomb', ... }` hooks
`backend.sendLoot()` and validates the bomb type. The panel the player
clicks is the **real** panel, with swap logic and stack limits. The
tutorial just waits for the right loot message.

---

## 8. Beat-by-beat (using the real map)

All coordinates are tile-space unless stated. All `resolveTurn` calls use
the real `resolveTurn` from the shared turn resolver.

### Prologue

```
setIdleMuted muted=true
panCamera → 'player', 800ms
dialogue(char4, "Welcome to the dungeon.")
dialogue(char4, "Every click is a turn. Everyone moves at once.")
dialogue(char4, "Let's learn the basics.")
pause("Click to Continue.")
```

### Beat 0 — HUD Primer (NEW)

Passive, no player input expected. Each highlight is held for the duration
of its dialogue line.

```
highlight phaseIndicator
dialogue("This tells you what phase we're in — Action or Resolve.")
highlight timer
dialogue("Your turn timer. Make a decision before it locks.")
highlight hp
dialogue("Your HP. Two pips. Don't lose them.")
highlight coinCounter
dialogue("Coins. You keep these after extraction.")
highlight bombTray
dialogue("Four bomb slots. Loot to fill them.")
clearHighlight
pause("Let's move.")
```

### Beat 1 — Movement (from Spawn1 at (6, 9))

```
highlight tile (7, 9)
dialogue("Click the highlighted tile to walk one step.")
waitForAction moveTo (7, 9)
resolveTurn

clearHighlight
dialogue("Longer paths work too — one tile resolves per turn.")
highlight tile (9, 9)
waitForAction moveTo (8, 9)      // BFS auto-first-tile
resolveTurn
waitForAction moveTo (9, 9)
resolveTurn

clearHighlight
dialogue("Movement: done.")
pause("Try throwing something.")
```

### Beat 2 — Practice Throw (Rock slot)

The Rock slot is always available, free, and infinite — the perfect
teaching aid for the throw mechanic without needing inventory prep.

```
panCamera focus=(11, 9), 500ms
dialogue("Your Rock slot is always available. Try it.")
highlight slot 0                 // rock slot
waitForAction throwAt slotIndex=0 x=(12, 9)
     hintText="Click the Rock slot, then the highlighted tile."
highlight tile (12, 9)
// (waitForAction resolves on correct throw target)
resolveTurn                      // rock lands, no meaningful effect
clearHighlight
dialogue("That's the arc. You commit the slot when you click the tile.")
pause("Now let's find real bombs.")
```

### Beat 3 — Chest loot (Chest2Zone at ~(10, 9))

```
spawnChest id=tut_chest, tier=2, at (10, 9), coins=25,
  bombs=[{ type: 'flare', count: 1 }, { type: 'bomb', count: 1 }]
panCamera focus=(10, 9), 500ms
highlight tile (10, 9)
dialogue("Chest. Coins auto-pick. Bombs via the loot panel.")
waitForAction moveTo (10, 9)
resolveTurn                      // coin_collected event fires

clearHighlight
highlight lootPanel              // the REAL panel is now open
dialogue("Click the Flare to grab it.")
waitForAction lootBomb sourceKind=chest bombType='flare'

dialogue("And the Bomb too.")
waitForAction lootBomb sourceKind=chest bombType='bomb'

clearHighlight
dialogue("Two slots filled. Time to use them.")
pause("There's an enemy ahead.")
```

### Beat 4 — Flare + Bomb kill (Bot1 at (17, 10))

```
spawnBot id=B1, x=17, y=10, character='char1', tint=0x886644, hp=1
panCamera focus=(14, 10), 600ms
dialogue("An enemy. Let's light them up first — Flare reveals tiles.")
highlight slot 1                 // slot 1 = Flare
waitForAction throwAt slotIndex=1 x=17 y=10 bombType='flare'
     hintText="Click the Flare slot, then the enemy's tile."
setBotAction B1 → idle
resolveTurn                      // flare: tiles illuminate around (17,10)
clearHighlight

dialogue("Lit. Now finish them.")
highlight slot 2                 // slot 2 = Bomb
waitForAction throwAt slotIndex=2 x=17 y=10 bombType='bomb'
     hintText="Click the Bomb slot, then the enemy's tile."
setBotAction B1 → idle
resolveTurn                      // bomb placed, fuseRemaining=1

clearHighlight
promptIdle text="Bomb fuse is one turn. Click to wait."
                                 // director.forceIdleAndResolve:
                                 //   fires idle, resolveTurn,
                                 //   B1 dies in blast → body1 at (17,10)

dialogue("Down.")
pause("They throw back, though. Let's dodge.")
```

### Beat 5 — Dodging (Bot2 at (27, 10))

```
spawnBot id=B2, x=27, y=10, character='char2', tint=0x4488cc, hp=2,
  inventory=[{ slot:0, type:'bomb', count:1 }]
teleportPlayer (20, 10)          // close the gap for pacing
panCamera focus=(23, 10), 700ms
dialogue("They're aimed at you.")
dialogue("Movement resolves before explosions. Step off the target.")
highlight tile (21, 9)           // safe diagonal
setBotAction B2 → throw slotIndex=1 x=20 y=10   // at player's current tile
waitForAction moveTo (21, 9)
resolveTurn                      // player moves, bomb lands fuse=1

clearHighlight
promptIdle text="Bomb placed. Click to wait one turn."
setBotAction B2 → idle
                                 // force idle + resolveTurn → bomb explodes
                                 // on empty (20,10), player safe at (21,9)
dialogue("Safe.")
pause("Some close the distance. Trap them.")
```

### Beat 6 — Melee Trap (player arrives first, bot walks second)

Player moves to `(17, 10)` **before** Bot2 is activated. Bot2 stays
dormant at `(27, 10)` this whole phase.

```
// --- Phase A: player walks to the crouch tile ---
mutateState: B2.pendingAction = null   // Bot2 stays idle
panCamera focus=(17, 10), 800ms
dialogue("Corners are defensive. Walk to the highlighted tile.")
highlight tile (17, 10)          // right next to Bot1's body
waitForAction moveTo (18, 9) OR equivalent path tile   // BFS auto-step
resolveTurn
// (multiple waitForAction+resolveTurn iterations until player reaches (17,10);
//  script lists the exact path based on map geometry — ~4 steps from (21, 9))

// Player now on (17, 10).
clearHighlight
setIdleMuted muted=false         // UNMUTE — we're about to teach self-click
dialogue("You can wait in place by clicking your own tile.")
dialogue("That puts you in Melee Trap Mode — crouched, counter ready.")
highlight tile (17, 10)          // the player's own tile
waitForAction idle               // real self-click, via real input pipeline
                                 // (validated by director because expected=idle)
resolveTurn                      // player.meleeTrapMode = true

// --- Phase B: Bot2 walks the path ---
clearHighlight
dialogue("Crouched. Stay still — they're coming.")
setBotAction B2 → move toward (18, 10)     // one tile per resolveTurn
waitForAction idle               // player self-click to wait
resolveTurn                      // Bot2 steps west to (26, 10)

dialogue("They're closer.")
setBotAction B2 → move toward (18, 10)
waitForAction idle
resolveTurn                      // (25, 10)

// …repeat for (24,10), (23,10), (22,10), (21,10), (20,10), (19,10)…
// The script writes each step explicitly so timing + dialogue are authored.
// Any doors on the path open naturally via the main-game proximity rule.

// Final approach — step-in triggers counter:
setBotAction B2 → move to (18, 10)
waitForAction idle
resolveTurn                      // Bot2 steps onto (18,10),
                                 // player (17,10) is Cheby-1 → MELEE COUNTER
                                 // Bot2 takes fatal damage, body2 at (18,10)

clearHighlight
dialogue("Counter kill.")
pause("They dropped something. Scavenge it.")
```

Notes on Phase B: every inter-step dialogue line is one "Click to Continue"
— so the player has agency on the pacing and the walk doesn't feel like a
cutscene. Each resolveTurn fires after the player's self-click idle, which
is now taught and legal.

### Beat 7 — Body loot

```
mutateState: body2.coins=15, body2.bombs=[{type:'bomb',count:1}]
highlight tile (18, 10)
dialogue("Walk onto the body. Coins auto-transfer.")
waitForAction moveTo (18, 10)
resolveTurn                      // body_looted event (coins); panel opens

clearHighlight
highlight lootPanel
dialogue("Grab their bomb.")
waitForAction lootBomb sourceKind=body bombType='bomb'

clearHighlight
dialogue("Scavenging keeps you alive.")
pause("Last lesson: extraction.")
```

### Beat 8 — Escape (hatch at (26, 7))

```
panCamera focus=(26, 7), 900ms
dialogue("That's the hatch. Walk onto it, then wait a turn to extract.")
highlight tile (26, 7)
teleportPlayer (25, 8)           // short pacing hop
waitForAction moveTo (26, 8)
resolveTurn
waitForAction moveTo (26, 7)
resolveTurn                      // onHatchIdleTurns = 0 (action was move)

dialogue("On the hatch. Now wait one turn.")
highlight tile (26, 7)           // self-tile (they're standing on hatch)
waitForAction idle               // self-click — now a normal input
resolveTurn                      // escaped=true, escaped event fires
clearHighlight

dialogue("Extracted. You keep everything you carried.")
pause("Tutorial complete.")
```

### Epilogue

```
dialogue("You've learned: move, loot, throw, dodge, trap, scavenge, escape.")
dialogue("Real matches add three more players and fog of war. Same rules.")
endTutorial message="Tutorial Finished"
     // → backend emits onMatchEnd({ title: "Tutorial Finished",
     //                              subtitle: "Ready for a real match?" })
     // → MatchScene transitions to MatchEndScene
     // → MatchEndScene's "Main Menu" button → MainMenuScene
```

---

## 9. Implementation phases

Each phase ends with a working, typecheck-passing, testable slice.

| # | Phase | Output |
|---|---|---|
| 0 | **Map pipeline** | Tutorial layer parsed; `tutorial_map.json` generated; `MapData.tutorial` typed; loader registers it. Real matches unaffected. |
| 1 | **`MatchBackend` + `SocketMatchBackend`** | Today's behavior intact — socket.on/emit all route through the backend. Real matches still work; manual regression test required. |
| 2 | **`TutorialMatchBackend` skeleton** | Menu's TUTORIAL button starts `MatchScene{mode:'tutorial'}`; backend fabricates an initial state (char4 at Spawn1, empty inventory); no scripted flow, but the player can walk the tutorial map. |
| 3 | **`TutorialOverlayScene` primitives** | Dialogue, pause, highlight (HUD + world), camera pan, input block, click catcher. Rendered on top of a live MatchScene view. |
| 4 | **Director core + Prologue + Beat 0** | Steps dispatch in order. HUD primer tour plays end-to-end. No `waitForAction` yet. |
| 5 | **Beats 1 + 2 (Movement + Practice Throw)** | `waitForAction` + `resolveTurn` + `setIdleMuted`. Real input pipeline validated by director. |
| 6 | **Beat 3 (Chest)** | Real `renderLootPanel` driven by tutorial via `sendLoot` interception. Deterministic chest contents. |
| 7 | **Beat 4 (Flare + Bomb kill)** | `promptIdle` + bot action scripting + fuse timing. |
| 8 | **Beat 5 (Dodge)** | Bot throw + move/idle resolution. |
| 9 | **Beat 6 (Melee Trap)** | Two-phase sequencing (player arrives first, bot walks second). `setIdleMuted muted=false`. Door interaction validated if the map has one on the path. |
| 10 | **Beats 7 + 8 (Body loot + Escape)** | `body_looted` event + hatch extraction. |
| 11 | **Epilogue + `endTutorial`** | Hand-off to `MatchEndScene` with "Tutorial Finished" title. Return to `MainMenuScene`. |
| 12 | **Polish** | Portrait crop tuning, pan/dialogue timing, skip button polish. Regression: enter tutorial → finish → start real match → verify no lingering state, no socket listeners leaked, `UiAnimLock` clean. |

---

## 10. Acceptance criteria (high-level)

A playtester running the tutorial with no prior knowledge of the game
should:

1. Reach Beat 8 without needing external help.
2. Never see any UI element that does not exist in a real match (no
   "Skip", "Wait", or "Idle" buttons baked into the HUD; only overlay
   prompts and dialogue).
3. Never have a self-click-idle succeed before Beat 6's crouch tutorial
   (mute holds).
4. See the real loot panel for both chest and body, and actually click it.
5. Experience a door auto-open if the map has a closed door on Bot2's
   path (verifying parity with main game).
6. Return to Main Menu after the `MatchEndScene` "Tutorial Finished"
   screen, with no lingering tutorial state if they then start a real
   match.

A subsequent code audit should confirm:

- `MatchScene` has no tutorial-specific rendering branches in its render
  pipeline (only `mode` checks in `create`/`shutdown` and the backend
  construction).
- No duplication of `resolveTurn` logic between client and tutorial — both
  use the same shared resolver.
- Removing `TutorialMatchBackend`, `TutorialOverlayScene`, and the tutorial
  directory would leave real matches 100% functional.
