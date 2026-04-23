# Tutorial Authoring Guide

This doc explains how to edit the tutorial by hand. The whole tutorial lives in
**one file**:

```
src/client/tutorial/tutorial-script.ts
```

It exports a flat array of `TutorialStep` objects. The `TutorialDirector` walks
them top-to-bottom: effect steps auto-advance, blocking steps wait for input.
Anything you change shows up the next time you start the tutorial — no rebuild
step beyond the usual `npm run dev`.

The tutorial runs the **real** game loop (`resolveTurn`) locally, so any
balance or gameplay change you make elsewhere in the codebase is automatically
picked up. You are only authoring the pacing, dialogue, and scripted entities.

---

## How to think about steps

Every step is a plain object with a `kind` discriminator:

```ts
{ kind: 'dialogue', portrait: 'char4', text: 'Welcome.' }
```

Two families:

- **Effect steps** — instant. They mutate state, set a flag, show a highlight,
  spawn something, etc. The director runs them and moves on.
- **Blocking steps** — wait for something. The director parks on them until
  the condition is met (player clicks, player performs a specific action,
  camera pan finishes).

If you put two blocking steps next to each other (e.g. a `dialogue` followed by
a `waitForAction`), the player clicks the dialogue first, then does the action.
If you put a `dialogue` in front of a `waitForAction` where both compete for
the same click, the click will dismiss the dialogue and the action will be
ignored — **always close the dialogue with a click before the action is
armed**.

---

## Tile coordinates

All `x`, `y` fields are **tile coordinates** (0-indexed from the top-left of
the map). The tutorial map is in `src/shared/maps/tutorial_map.json`. Player
spawn is typically `(6, 9)`; the extraction hatch is at `(26, 7)`. You can open
`tutorial_map.tmj` in Tiled to figure out where to put things.

---

## Dialogue, pause, prompt-idle

### `dialogue` — a line of narration

```ts
{ kind: 'dialogue', portrait: 'char4', text: 'Click the highlighted tile.' }
```

- `portrait` — who's talking. Only `'char4'` (the tutorial guide) is currently
  wired up. The asset is `public/sprites/tutorial_guy.png`.
- `text` — what they say. Keep it short; the panel wraps around ~380px.
- **Blocks** until the player clicks anywhere to advance.

### `pause` — full-screen "moment" break

```ts
{ kind: 'pause', text: 'Now it begins.' }
```

- `text` *(optional)* — big centered caption. Defaults to "Click to Continue".
- Dims the whole screen and waits for a click. Use it between beats to signal
  a section change.

### `promptIdle` — "click to wait a turn"

```ts
{ kind: 'promptIdle', text: 'Bomb fuse is one turn. Click to wait.', delayAfterMs: 1000 }
```

Runs a dialogue, then on click fires an `idle` action and resolves a turn.
Used any time you need a turn to tick forward without asking the player to do
anything specific (e.g. waiting for a bomb to explode).

- `text` — dialogue text shown while the player is deciding.
- `delayAfterMs` *(optional)* — extra pause **after** the turn resolves before
  the next step runs. Use this to let death animations or explosion VFX finish.
  The turn itself already takes about 4 seconds (input hold + transition hold),
  so a value of `800`–`1500` is usually enough to cover a death pose.

### `autoIdleTurn` — "tick a turn without asking"

```ts
{ kind: 'autoIdleTurn', delayBeforeMs: 300, delayAfterMs: 500 }
```

Advances one turn with the player's action forced to `idle`. **No dialogue,
no click required.** While this step runs, the director silently rejects any
gameplay action the player tries to submit — so clicks during the input
phase are dropped and the script stays in sync.

Use for cinematic sequences where the player is meant to watch (e.g. an
enemy approaching an ambush, an explosion resolving). Chain several in a
row with `setBotAction` in between to drive scripted bot movement.

- `delayBeforeMs` *(optional)* — pause before the turn starts. Good for
  letting a preceding dialogue's last frame breathe.
- `delayAfterMs` *(optional)* — pause after the turn ends. Needed to cover
  slow animations (the counter-kill + body-drop on the final ambush turn
  wants ~3000 ms).

A full turn already takes ~4 s (2 s input hold + 2 s transition hold),
so keep the totals reasonable — 200–500 ms extra is usually plenty between
ordinary moves, 2–3 s after climactic moments.

---

## Highlights

The overlay pulses a yellow outline around whatever you highlight. **Multiple
highlights stack** — call `highlight` twice in a row and you'll see two rects
at once. A `clearHighlight` wipes all of them.

### `highlight` — add one highlight

```ts
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } }
```

Target kinds:

| Target | Highlights |
|---|---|
| `{ kind: 'tile', x, y }` | A single world tile (world-space, tracks camera) |
| `{ kind: 'slot', index: 0 \| 1 \| 2 \| 3 \| 4 }` | One bomb slot in the HUD tray. Slot 0 is always Rock. |
| `{ kind: 'lootPanel' }` | The whole loot panel when it's open |
| `{ kind: 'lootItem', bombType: 'flare' }` | One specific icon inside the loot panel |
| `{ kind: 'phaseIndicator' }` | Top-left phase text (Action / Resolve) |
| `{ kind: 'timer' }` | Turn timer |
| `{ kind: 'hp' }` | HP pips |
| `{ kind: 'coinCounter' }` | Coin counter |
| `{ kind: 'bombTray' }` | The entire bomb tray at the bottom |
| `{ kind: 'rect', x, y, w, h, space: 'world' \| 'hud' }` | Freeform rectangle |

Common pattern — highlight the slot AND the target tile so the player sees
both "where to click first" and "where it lands":

```ts
{ kind: 'highlight', target: { kind: 'slot', index: 0 } },
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
{ kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 10, y: 9 } },
{ kind: 'clearHighlight' },
```

### `clearHighlight` — remove all highlights

```ts
{ kind: 'clearHighlight' }
```

Resets the list. Use this before moving to the next interaction.

---

## Camera and input control

### `panCamera`

```ts
{ kind: 'panCamera', focus: { x: 18, y: 10 }, durationMs: 800 }
{ kind: 'panCamera', focus: 'player', durationMs: 500 }
```

Smoothly pans the main camera. `focus` is either a tile `{ x, y }` or the
literal string `'player'` (follows the tutorial player's current tile).
**Blocks** until the pan finishes.

### `blockInput`

```ts
{ kind: 'blockInput', durationMs: 800 }
```

Swallows all tutorial-advance clicks for N ms. Handy after a big reveal when
you don't want a stray click to skip the dialogue that's about to show.

Note: `blockInput` only blocks dialogue/pause dismissal clicks. During an
`autoIdleTurn` sequence, player **gameplay** clicks are blocked automatically
by the director (see `autoIdleTurn` below). For persistent blocking across a
longer sequence, chain `autoIdleTurn` steps — they cover their own window.

### `setCameraLocked`

```ts
{ kind: 'setCameraLocked', locked: true }
```

Freeze or unfreeze MatchScene's follow-player camera. While locked, the
camera stays wherever the last `panCamera` put it — your scripted pans
actually stick instead of snapping back to the player on the next frame.

**Start the tutorial with `locked: true`** (this is the current default in
`tutorial-script.ts`). **Unlock** (`locked: false`) only when you want the
player to see follow-cam behavior again — typically right before the final
escape highlight in Beat 7.

---

## Mode flags

### `setIdleMuted`

```ts
{ kind: 'setIdleMuted', muted: true }
```

When muted, clicks on the player's own tile (normally "wait a turn") are
silently ignored. Start the script with `muted: true` so accidental self-clicks
don't eat a turn. Unmute before Beat 6's melee trap training where self-idle
becomes the lesson.

### `setSuppressRush`

```ts
{ kind: 'setSuppressRush', enabled: true }
```

When enabled, the tutorial player's Out-of-Combat Rush is force-reset after
every turn. Keeps the movement beats deterministic (exactly one tile per
click). Turn it **off** only for sequences that deliberately teach rush.

### `setSuppressMeleeTrap`

```ts
{ kind: 'setSuppressMeleeTrap', scope: 'all' }   // default during tutorial
{ kind: 'setSuppressMeleeTrap', scope: 'bots' }  // only player can trap
{ kind: 'setSuppressMeleeTrap', scope: 'none' }  // resolver unmodified
```

Controls who is allowed to enter Melee Trap Mode after the resolver runs.
The tutorial starts with `scope: 'all'` so a stray idle doesn't crouch the
player into a trap they didn't ask for, and so scripted bots don't crouch
mid-approach. Switch to `'bots'` right before the ambush beat so the
player's next idle arms their trap while bots still can't.

### `setBlockMovement`

```ts
{ kind: 'setBlockMovement', blocked: true }   // lock movement on
{ kind: 'setBlockMovement', blocked: false }  // unlock
```

Persistent toggle that rejects every player `move` / `reachTile` action
until flipped back off. `idle` and `throw` still pass. Use it to hold the
player on a teaching tile while a different mechanic is being demonstrated
(HUD slot select, bomb-throw, etc.) without a stray floor click BFS-walking
them somewhere unhelpful.

Different from `autoIdleTurn`'s internal input block: that one auto-clears
at the end of the scripted turn. `setBlockMovement` is sticky.

### `setBlockSlotSelection`

```ts
{ kind: 'setBlockSlotSelection', blocked: true }
{ kind: 'setBlockSlotSelection', blocked: false }
```

Persistent toggle that rejects HUD bomb-slot clicks. While on, clicking a
slot does nothing — the HUD doesn't arm, doesn't disarm. If a `selectBomb`
expectation is also active, wrong-slot clicks still flash the hint so the
player sees *why* nothing happened.

Stays on until flipped back off. Combine with `setBlockMovement` to lock
the player down completely during a cinematic or a dialogue-heavy beat.

---

## Spawning things

### `spawnChest`

```ts
{
  kind: 'spawnChest',
  chestId: 'tut_chest',
  tier: 2,
  x: 10,
  y: 9,
  coins: 25,
  bombs: [
    { type: 'flare', count: 1 },
    { type: 'bomb', count: 1 },
  ],
},
```

- `chestId` — unique string. Used if you ever need to reference it later.
- `tier` — `1` or `2`. Controls visual (tier-2 chests look richer).
- `coins` — auto-picked when the player steps on the tile.
- `bombs` — looted via the panel. Valid `type` values live in
  `src/shared/config/bombs.ts` (`bomb`, `flare`, `contact`, `molotov`, etc.).

### `spawnBot`

```ts
{
  kind: 'spawnBot',
  botId: 'B1',
  x: 17,
  y: 10,
  character: 'char1',
  tint: 0x886644,
  hp: 1,
  inventory: [{ slot: 0, type: 'bomb', count: 1 }],
}
```

- `botId` — unique string. Use it in later `setBotAction` / `mutateState`
  steps to reference this bot.
- `character` *(optional)* — `'char1'`, `'char2'`, `'char3'`, `'char4'`.
  Visual only.
- `tint` *(optional)* — hex color applied to the sprite.
- `hp` *(optional)* — default `2`. Drop to `1` for one-shot kills.
- `inventory` *(optional)* — starting bombs in their slots (0–3).

### `equipPlayerBomb`

```ts
{ kind: 'equipPlayerBomb', slot: 2, type: 'molotov', count: 1 }
```

Instantly put a bomb in the player's inventory. Useful for skipping the loot
step when you want to focus on a specific mechanic.

### `teleportPlayer`

```ts
{ kind: 'teleportPlayer', x: 20, y: 10 }
```

Move the player to any tile. Use it between beats to skip boring walks.

### `mutateState` — the escape hatch

```ts
{
  kind: 'mutateState',
  mutate: (s) => {
    const b2 = s.bombermen.find((b) => b.playerId === 'B2');
    if (!b2) return;
    b2.hp = 1;
    b2.x = 27;
    b2.y = 10;
  },
}
```

Direct access to the full `MatchState`. Anything the other setup steps can't
express — adjusting a bot's cooldowns, opening a door, placing a pre-lit
flare — go through here. Keep it scoped; if you find yourself doing something
five times, it probably deserves its own step kind.

---

## Bot AI

### `setBotAction`

```ts
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 26, y: 10 } }
{ kind: 'setBotAction', botId: 'B1', action: { kind: 'idle' } }
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'throw', slotIndex: 1, x: 20, y: 10 } }
```

Queues the bot's action for the **next** `resolveTurn` call (which happens
when the player submits their own action). Clears after use, so if you want
a bot to move three turns in a row you need three `setBotAction` steps (each
paired with the player's action that drives the turn forward).

Action kinds: `'idle'`, `'move'` (`x`, `y`), `'throw'` (`slotIndex`, `x`, `y`).

Bots without a queued action idle by default.

### `botThrow` — scripted bomb throw with auto-equip

```ts
{
  kind: 'botThrow',
  botId: 'B2',
  slotIndex: 0,
  x: 11,
  y: 10,
  bombType: 'bomb',   // optional, but required for autoEquip
  autoEquip: true,    // default
}
```

Sugar over `setBotAction` with `PlayerAction.throw`. If `autoEquip` is on
(default) and `bombType` is provided, the bot's inventory slot is
force-set to contain that bomb before the throw resolves — so the script
doesn't have to pre-populate bot inventory just to fire a cinematic
throw. Throw ranges are infinite, so any tile on the map is valid.

Timing: a bomb with `fuseTurns: 1` (standard `bomb`) lands this turn at
fuse=0 after the end-of-turn tick, so it **explodes on the next
`resolveTurn`**. Pair with an `autoIdleTurn` to resolve the throw, then
a `waitForAction` that makes the player dodge — the dodge turn is when
the explosion actually fires.

### `botMove` — scripted single-tile move

```ts
{ kind: 'botMove', botId: 'B2', x: 20, y: 10 }
```

Sugar over `setBotAction` with `PlayerAction.move`. Identical behavior to
the longer form — use whichever reads cleaner in the script.

---

## Waiting on player input

### `waitForAction` — the workhorse

```ts
{ kind: 'waitForAction', expected: { kind: 'reachTile', x: 9, y: 10 } }
```

Parks the director until the player performs a specific action. Wrong actions
are silently swallowed (the HUD reticle still shows, but no turn resolves).

`expected` variants:

| `expected.kind` | Matches when |
|---|---|
| `{ kind: 'idle' }` | Player clicks their own tile (self-wait) |
| `{ kind: 'moveTo', x, y }` | Single-tile move. Action's `rushX/rushY` must be absent. |
| `{ kind: 'moveTo', x, y, rushX, rushY }` | Two-tile rush move — all four coords must match. |
| `{ kind: 'reachTile', x, y }` | Multi-turn walk. Accepts every step; script advances only when the player actually arrives at `(x, y)`. Prefer this for anything longer than one tile. |
| `{ kind: 'throwAt', slotIndex, x, y }` | Throw from slot `slotIndex` onto tile `(x, y)`. `slotIndex: 0` is Rock. |
| `{ kind: 'throwAt', slotIndex, x, y, bombType: 'bomb' }` | Same, plus the slot must contain this bomb type. |
| `{ kind: 'lootBomb', sourceKind: 'chest' \| 'body', bombType }` | Player picked `bombType` out of a chest/body via the loot panel. |
| `{ kind: 'selectBomb' }` | Player clicked **any** HUD bomb slot (0 = Rock, 1..4 = inventory). Resolves without advancing a turn. |
| `{ kind: 'selectBomb', slotIndex: 0 }` | Player clicked **this specific** slot. Wrong slots flash the hint and are swallowed (HUD stays unarmed). |

**`reachTile` tip**: the client auto-walks tile-by-tile via BFS. If you use
`moveTo` for a multi-tile path you'll only get the first step. Use `reachTile`
for anything longer than one tile.

### `flashExclamation` — "!" above a tile

```ts
{ kind: 'flashExclamation', x: 17, y: 10, color: '#ff4444' }
```

Pop a floating red "!" over a world tile. Effect step, auto-advances. Used
for enemy reveals.

---

## Lifecycle

### `endTutorial`

```ts
{ kind: 'endTutorial', message: 'Tutorial Finished' }
```

Wraps up: fires a synthetic `MatchEnd`, the scene transitions to the results
screen, and the player keeps whatever coins they carried.

---

## Cookbook

### Teach an action with full HUD + tile highlighting

```ts
{ kind: 'dialogue', portrait: 'char4', text: 'Throw the Rock.' },
{ kind: 'highlight', target: { kind: 'slot', index: 0 } },   // HUD slot
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } }, // target tile
{ kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 10, y: 9 } },
{ kind: 'clearHighlight' },
{ kind: 'dialogue', portrait: 'char4', text: 'Nice.' },
```

### Teach slot selection without letting the player wander

A two-step teach: first arm the slot, then throw. Movement is locked for
the first click so a stray floor click can't BFS-walk the player away
from the teaching tile.

```ts
{ kind: 'setBlockMovement', blocked: true },
{ kind: 'dialogue', portrait: 'char4', text: 'Click the Rock slot (1).' },
{ kind: 'highlight', target: { kind: 'slot', index: 0 } },
{ kind: 'waitForAction', expected: { kind: 'selectBomb', slotIndex: 0 } },
{ kind: 'setBlockMovement', blocked: false },
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
{ kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 10, y: 9 } },
{ kind: 'clearHighlight' },
```

Wrong-slot clicks flash the highlight and are swallowed — the HUD stays
unarmed, so the player doesn't end up aimed at the wrong bomb.

### Let a bomb explode and wait for the death animation

```ts
{ kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 2, x: 16, y: 10, bombType: 'bomb' } },
{ kind: 'clearHighlight' },
{ kind: 'promptIdle', text: 'Click to wait for the fuse.', delayAfterMs: 1000 },
{ kind: 'dialogue', portrait: 'char4', text: 'Down.' },
```

`delayAfterMs: 1000` gives the bot's death animation ~1 second to play after
the turn resolves before "Down." shows up.

### Walk a long path without nagging

```ts
{ kind: 'dialogue', portrait: 'char4', text: 'Walk to the chest.' },
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
{ kind: 'waitForAction', expected: { kind: 'reachTile', x: 10, y: 9 } },
{ kind: 'clearHighlight' },
```

### Scripted bot encounter over several turns

```ts
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 25, y: 10 } },
{ kind: 'autoIdleTurn', delayAfterMs: 200 },
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 24, y: 10 } },
{ kind: 'autoIdleTurn', delayAfterMs: 200 },
// ... and so on
```

Each `setBotAction` + `autoIdleTurn` pair drives exactly one turn. The
player doesn't have to click for any of it — the director force-resolves
the turn and silently rejects stray gameplay clicks.

(If you want the player to **click to wait** between bot moves, swap
`autoIdleTurn` for `waitForAction: { kind: 'idle' }` — but this is usually
worse pacing than the auto version for ambush-style reveals.)

### Offscreen-bomb reveal via `botThrow` (Beat 5 pattern)

Used to sell "a bomb arrives from the dark". The bot actually throws —
throw ranges are infinite so it doesn't matter how far out the shooter
is hiding.

```ts
// Pre-spawn a bomb thrower off-screen. hp=2 survives the later beats.
{ kind: 'spawnBot', botId: 'B2', x: 27, y: 10, hp: 2,
  inventory: [{ slot: 0, type: 'bomb', count: 1 }] },

// Cinematic: pan east toward the dark, queue a real throw, resolve it.
{ kind: 'panCamera', focus: { x: 25, y: 10 }, durationMs: 400 },
{ kind: 'botThrow', botId: 'B2', slotIndex: 0, x: 11, y: 10,
  bombType: 'bomb', autoEquip: true },
// Resolves the throw turn. Player input is auto-blocked during autoIdleTurn.
{ kind: 'autoIdleTurn', delayBeforeMs: 100, delayAfterMs: 300 },
{ kind: 'panCamera', focus: 'player', durationMs: 600 },

// Teach the dodge. The bomb landed at (11, 10) with fuseRemaining=0 after
// the previous turn's tick, so the next resolveTurn is when it explodes.
{ kind: 'highlight', target: { kind: 'tile', x: 10, y: 11 } },
{ kind: 'waitForAction', expected: { kind: 'moveTo', x: 10, y: 11 } },
{ kind: 'clearHighlight' },
// The player moves first (resolver step 1), so their new position is
// outside the plus pattern centered on (11, 10).
{ kind: 'autoIdleTurn', delayAfterMs: 800 },  // let the blast settle
```

**Why `botThrow` instead of a `mutateState` injection** — the bot actually
throwing produces a real `throw` event (arcs, audio, ownerId wiring)
and matches what players see in real matches. `mutateState` bomb
injection still works but stays an escape hatch for bombs that no living
bot could produce.

**Timing** — a standard `bomb` has `fuseTurns: 1`. On the throw turn the
resolver places it (fuse=1) then ticks once (fuse=0); it doesn't explode
that turn (only bombs already at fuse=0 at the **start** of the turn
resolve). The next resolveTurn — the dodge turn — is when it blows. Pair
`botThrow` with `autoIdleTurn` first, then the player's dodge.

**Why prespawn the bot** — every bomb needs a string `ownerId`. The
resolver tolerates strings that don't map to any bomberman, but
kill-attribution events use the field, so linking it to a real bot keeps
telemetry clean even if the bot is never seen.

### Ambush sequence (Beat 6 pattern)

```ts
// Reset bot to start position.
{ kind: 'mutateState', mutate: (s) => {
  const b2 = s.bombermen.find(b => b.playerId === 'B2');
  if (!b2) return;
  b2.hp = 1; b2.x = 27; b2.y = 10;
}},

// Player walks to hiding tile.
{ kind: 'highlight', target: { kind: 'tile', x: 15, y: 9 } },
{ kind: 'waitForAction', expected: { kind: 'reachTile', x: 15, y: 9 } },
{ kind: 'clearHighlight' },

// Open the trap for the player (bots still blocked).
{ kind: 'setSuppressMeleeTrap', scope: 'bots' },
{ kind: 'setIdleMuted', muted: false },

// One silent idle turn arms the trap.
{ kind: 'autoIdleTurn', delayAfterMs: 500 },

// Tell the player what just happened.
{ kind: 'dialogue', portrait: 'char4', text: 'You activate AMBUSH MODE.' },

// Bot advances one tile per turn; final step triggers the counter kill.
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 26, y: 10 } },
{ kind: 'autoIdleTurn', delayAfterMs: 200 },
// ... repeat for each step of the path
{ kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 16, y: 10 } },
{ kind: 'autoIdleTurn', delayAfterMs: 3000 },   // death anim + beat

{ kind: 'dialogue', portrait: 'char4', text: 'He never saw it coming.' },
```

The trap fires inside the resolver when the bot steps to Chebyshev-1 range
of the crouched player — any of the 8 tiles around the player. No
additional script intervention needed.

### Unlock camera control at the end

```ts
{ kind: 'setCameraLocked', locked: false },
{ kind: 'teleportPlayer', x: 25, y: 8 },
{ kind: 'panCamera', focus: { x: 26, y: 7 }, durationMs: 900 },
{ kind: 'highlight', target: { kind: 'tile', x: 26, y: 7 } },
{ kind: 'waitForAction', expected: { kind: 'reachTile', x: 26, y: 7 } },
```

Unlock `setCameraLocked` *before* the final highlight. The follow-camera
takes over on the next frame, which is exactly what the player expects
once they're being asked to move freely.

---

## Common pitfalls

- **Stacked dismissals.** If you write a `dialogue` immediately before a
  `waitForAction`, the dialogue's "click to continue" will consume the first
  click. That's fine — just remember the *first* click dismisses the dialogue,
  and a *second* action is needed to perform the expected action. Don't expect
  one click to both close a dialogue and satisfy a `waitForAction`.
- **Forgetting `clearHighlight`.** Highlights now stack, so if you don't clear
  them between beats you'll end up with a constellation of yellow rects.
- **Using `moveTo` for a multi-tile walk.** The player's click triggers a BFS
  that walks tile-by-tile. `moveTo` only matches the first step; use
  `reachTile` for anything longer than one tile.
- **Rush flipping silently.** If you turn `setSuppressRush` off for a beat,
  turn it back on after. A lingering rush state will cause the player to
  accidentally move two tiles during a beat you expected to be single-step.
- **Bot without an action.** A bot you spawned but never gave a `setBotAction`
  will silently idle every turn. That's fine for stationary targets — just be
  aware of it if you're wondering why B2 isn't chasing you.
- **Clicks during `blockInput`.** Useful for staged reveals, but don't make it
  so long that the player thinks the game is frozen. ~500–1000 ms is usually
  enough. `blockInput` does **not** block gameplay clicks — use `autoIdleTurn`
  if you need scripted turn ticks that survive stray player input.
- **Scripted `panCamera` doesn't stick.** Camera follows the player every
  frame unless `setCameraLocked: true` is active. If your cinematic pan keeps
  snapping back, it's because the lock isn't on.
- **Accidental Melee Trap.** Trap Mode arms on any idle turn, which in a
  tutorial is easy to trigger by accident. Leave `setSuppressMeleeTrap` at
  `scope: 'all'` until the beat that actually teaches the mechanic.
- **Walls on the tutorial map.** Some rows have narrow wall columns (row 9
  has walls at x=19–22). If BFS has to route around a wall, a single-tile
  `moveTo` expectation will fail on the detour. Prefer `reachTile` for any
  walk that crosses rows or gets close to walls.

---

## Where things live

- `src/client/tutorial/tutorial-script.ts` — **the file you edit**.
- `src/client/tutorial/types.ts` — step type definitions. Touch this if you
  want to add a new step kind.
- `src/client/tutorial/TutorialDirector.ts` — step execution logic. Touch
  this to implement a new step kind.
- `src/client/backends/TutorialMatchBackend.ts` — runs `resolveTurn`
  client-side and wires the director's host callbacks to the overlay.
- `src/client/scenes/TutorialOverlayScene.ts` — the dialogue/highlight/pause
  primitives.
- `src/shared/maps/tutorial_map.json` — the map geometry.
- `public/maps/tutorial_map.tmj` — source map file (edit in Tiled; re-export
  via `npm run convert-map`).
