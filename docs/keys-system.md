# Keys System — Implementation Spec

**Status:** Pending implementation (this session)
**Owner:** Claude Code
**Last updated:** 2026-05-15
**Related:** `docs/escape-hatch-rework.md` (this system extends the hatch escape with a key gate)

A self-contained handoff for the new Keys system. Keys are floor pickups that gate the Escape Hatch: a bomberman cannot escape unless they are carrying enough keys.

---

## 1. Overview

- **15 keys** spawn on the map at match start (configurable: `BALANCE.keys.totalOnMap`).
- **3 keys** are required to use an escape hatch (configurable: `BALANCE.keys.requiredPerHatch`).
- Each bomberman can carry **up to `requiredPerHatch` keys** (the carry cap is tied to the door cost — single knob, always equal).
- Keys lie on the floor and are picked up by walking onto the tile (including any tile traversed during a rush 2-tile move).
- Dead bodies hold the keys their owner was carrying; another bomberman walking onto the body auto-transfers keys up to their cap.
- On escape, the keys are consumed (set to 0). The hatch becomes broken (existing rule from `escape-hatch-rework.md`).
- Keys are match-scoped: not persisted on `PlayerProfile`, reset every match.

---

## 2. Design decisions (locked in)

| Q | Decision |
|---|----------|
| Carry cap vs. door cost | Always equal — single `requiredPerHatch` knob drives both |
| Body pickup mechanism | Auto-pickup on walk-onto the body tile (same path as floor pickup) |
| Tutorial map | **No keys requirement in tutorial** — special-case bypass for `state.isTutorial === true` |
| Bot AI scope | Full integration — bots pathfind to keys, only target hatch when carrying enough |
| Tiled "Keys" layer | Circles interpreted as **single spawn points** at the circle's center tile. If more circles than `totalOnMap` exist, pick 15 with seeded RNG |
| Broken hatch vs. needs-keys priority | **Broken takes precedence** — broken HUD/tooltip overrides the needs-keys warning |
| Hover tooltip on a floor key | Yes — new `tileKey` tooltip key |
| HUD layout | Single small element: key icon + `N/3` text, left of `TreasureListWidget`, in its own column |

---

## 3. Data model

### `MatchState` (`src/shared/types/match.ts`)

Add:
```ts
/** Keys lying on the floor, picked up by walking onto the tile. */
keys: { x: number; y: number }[];
```

### `BombermanState` (`src/shared/types/bomberman.ts`)

Add:
```ts
/** Number of keys currently held (0..BALANCE.keys.requiredPerHatch). */
keys: number;
```

### `DroppedBody` (in `src/shared/types/match.ts`)

Add:
```ts
/** Keys held by the bomberman at the moment they died. */
keys: number;
```

### `MapData` (`src/shared/types/map.ts`)

Add:
```ts
/** Key spawn points from Tiled "Keys" object layer (circle centers as tile coords). */
keySpawns: { x: number; y: number }[];
```

### `TurnEvent` (`src/shared/systems/TurnResolver.ts`)

Add:
```ts
| { kind: 'key_pickup'; playerId: string; x: number; y: number; source: 'floor' | 'body'; newCount: number }
```

The `source` field lets the client choose a slightly different VFX origin (treasure-style flying icon).

---

## 4. Config (`src/shared/config/balance.ts`)

Add a new top-level section:
```ts
keys: {
  /** Number of keys placed on the map at the start of a match. */
  totalOnMap: 15,
  /** Number of keys needed to use an escape hatch (also the carry cap). */
  requiredPerHatch: 3,
},
```

---

## 5. Resolver changes (`src/shared/systems/TurnResolver.ts`)

### `cloneState()` (~line 85)

```ts
keys: (s.keys ?? []).map(k => ({ ...k })),
```

The bomberman/body clones already do `{ ...b }` so the new `keys: number` field is copied automatically.

### New step **1.5 — Auto-pickup (keys from floor + bodies)** (immediately after step 1 movement, before step-in-melee)

Iterate `steppedTilesByPlayer` (already populated by the movement step including rush intermediates). For each stepped tile:

1. **Floor key** — if `state.keys` contains the tile, and the bomberman's `keys < cap`, increment `b.keys`, remove the entry from `state.keys`, emit `key_pickup` with `source: 'floor'`.
2. **Body keys** — if a body exists on the tile with `body.keys > 0`, transfer keys one-at-a-time up to the bomberman's cap, decrementing `body.keys` and incrementing `b.keys`. Emit one `key_pickup` per key transferred with `source: 'body'`.

Order: floor key on the same tile as a body is unusual but allowed; floor first, then body.

### Step **9 — Deaths** (existing, around line 1620)

When a bomberman dies, the existing code creates a `DroppedBody`. Extend it: `body.keys = b.keys`. Zero `b.keys` so the body owns them now.

### Step **9.5 — Escape evaluation** (existing, post-hatch rework)

Wrap the existing escape condition with a key check:

```ts
const cap = BALANCE.keys.requiredPerHatch;
const hasEnoughKeys = state.isTutorial === true || b.keys >= cap;
if (onHatch && !onBrokenHatch && hasEnoughKeys && action.kind === 'idle') {
  b.onHatchIdleTurns += 1;
  if (b.onHatchIdleTurns >= 1) {
    b.escaped = true;
    b.keys = 0;  // keys consumed on escape
  }
} else {
  b.onHatchIdleTurns = 0;
}
```

Tutorial maps bypass the gate entirely (the user asked for the tutorial flow to remain unchanged for now).

---

## 6. Server (`src/server/MatchRoom.ts`)

In `buildInitialState()`:
- Initialize `keys: []`.
- After computing chest spawns, do an analogous keys placement: take `map.keySpawns`, seeded-shuffle it, take the first `BALANCE.keys.totalOnMap`, and assign each to `state.keys`.
- New bombermen are created with `keys: 0`.

---

## 7. Bot AI (`src/server/BotPlayer.ts`)

- New helper `wantsToPickUpKeys(me)`: returns `me.keys < cap`.
- New helper `nearestKeyPath(me, state, map)`: pathfind to the closest `state.keys[]` tile (Chebyshev distance or A*).
- Update `escapeAction`: only target the hatch when `me.keys >= cap`. Otherwise fall back to `nearestKeyPath` or default exploration.
- Update `shouldAvoidEscapes` and similar wandering logic: bots should pathfind toward keys when below cap, as a higher-priority loot target than chests.

Specifics:
- The decision tree is "low HP → flee" → "have full keys → escape" → "want keys + path exists → grab keys" → "loot/explore" → "random".

---

## 8. Tiled converter (`tools/tiled-to-roombov.ts`)

- Find object layer named `Keys` (case-sensitive, per the project convention).
- For each circle/ellipse object in the layer, take its center pixel `(x + width/2, y + height/2)`, convert to tile coord via `tileSize`, and push to `keySpawns`.
- Round to nearest tile; collapse exact duplicates.
- Falls back to an empty array if the layer doesn't exist (old maps still load).

### `BombermanMap` interface

Add `keySpawns: { x: number; y: number }[]` to the converter's output type.

---

## 9. Client (`src/client/scenes/MatchScene.ts`)

### Sprite preload

Add: `this.load.image('key', 'sprites/key.png');`

### Key rendering

Each entry in `state.keys[]` gets a sprite stretched to fit the tile (`setDisplaySize(tileSize, tileSize)`), depth between map and bombermen (`setDepth(15)` is a safe value — above floor decals, below chest tops). Sprites are reconciled each frame: create new for tiles not yet seen, destroy for tiles no longer present.

### Per-client fog-of-war memory for keys

- Maintain `private keyMemory: Map<string, { x: number; y: number; present: boolean }>` keyed by `"${x},${y}"`.
- Update rule (per frame):
  - For every tile in current LOS: set the memory to `present = (state.keys has this tile)`. This handles the "I see a key disappear from a tile I have LOS on" case.
  - For tiles in seen-dim fog: do nothing — the memory's last value (likely `present: true` from a previous LOS) is retained. This is exactly the scenario the user described.
  - For unseen tiles: don't render at all (existing fog masks them).
- Render rule:
  - Iterate `keyMemory` entries with `present === true`.
  - Create a sprite for each if missing; destroy sprites whose memory entry is `present: false`.
- Memory resets each match.

### Pickup VFX

Reuse the existing treasure-pickup flying-icon animation (the codebase already has a "treasure popup" pattern in MatchScene — look for `treasurePopup` or similar; reuse it with the key icon).

### HUD: keys widget

Add a small element to the right edge of the HUD, just left of `TreasureListWidget`:
- Icon: same `key` sprite (smaller, 16×16 via `setDisplaySize`).
- Text: `${me.keys}/${BALANCE.keys.requiredPerHatch}`.
- Update each frame from `state.bombermen[myPlayerId].keys`.

### HUD: needs-keys warning

Extend the existing broken-hatch red-text logic in `renderHud()`:
- If standing on a broken hatch: existing broken message (precedence).
- Else if standing on an intact hatch and `me.keys < cap`: show *"Hatch requires N/3 keys"* in the same position. Hide once on the hatch with enough keys or when stepping off.

### Tooltip: keys on map

- New `tileKey` tooltip key in `tooltipData.ts`: icon = key shape, text = "Pick up to unlock the **Escape Hatch**."
- Add a key shape to `TooltipScene` — small filled rounded rectangle + bow-tie head, simple silhouette.
- MatchScene's hover dispatcher must check `state.keys` before falling through to fog/etc.

### Tooltip: hatch (intact) with key counter

Extend `tileHatch` tooltip text to include the player's current `me.keys / cap` count:
- e.g. *"Stand on it to **Escape**. (1/3 keys)"*
- Requires passing the bomberman state into `tooltipDataFor` OR computing the line in MatchScene before formatting.
- Simpler approach: add a `tileHatchNeedsKeys` variant (analogous to `tileHatchBroken`) that takes a count.

---

## 10. Tutorial backend (`src/client/backends/TutorialMatchBackend.ts`)

- Initialize `state.keys = []` (no keys spawned in the tutorial map).
- `isTutorial: true` already set — the resolver bypasses the keys gate based on this flag (see §5 step 9.5).
- Bomberman starts with `keys: 0`.

---

## 11. Tests (`tests/keys.test.ts`)

Required cases:
1. **`test_keys_walkOntoFloorKey_picksItUp`** — bomberman with `keys: 0` steps onto a floor key tile; `b.keys === 1`, `state.keys` shrinks by one, `key_pickup` event emitted with `source: 'floor'`.
2. **`test_keys_capReached_walkPastKey_doesNotPickUp`** — bomberman with `keys === cap` steps onto a floor key; nothing happens.
3. **`test_keys_rushThroughKeyTile_picksItUp`** — bomberman with rush active uses a 2-tile move where the middle tile has a key; key is picked up.
4. **`test_keys_walkOntoBodyWithKeys_autoTransfers`** — body has 2 keys, bomberman with `keys: 0` steps onto the body's tile; `b.keys === 2`, `body.keys === 0`.
5. **`test_keys_escapeBlocked_whenBelowCap`** — bomberman idles on a hatch with `keys < cap`; not marked escaped; `onHatchIdleTurns` does NOT increment beyond 0 (since the conjunction fails).
6. **`test_keys_escapeAllowed_whenAtOrAboveCap`** — bomberman idles on a hatch with `keys === cap`; escaped on next turn; `b.keys === 0` after escape; hatch added to `brokenHatches`.
7. **`test_keys_deadBomberman_dropsKeysIntoBody`** — bomberman with 2 keys dies; the spawned body has `keys: 2`; the dead bomberman's `keys: 0` (so a respawn doesn't carry them).
8. **`test_keys_tutorialFlag_bypassesGate`** — `state.isTutorial = true`, bomberman with `keys: 0` idles on hatch; escapes normally.
9. **`test_keys_emptyKeysField_isBackfilled`** — legacy state without `keys` field flows through `resolveTurn` without throwing.

---

## 12. Files touched (summary)

```
src/shared/config/balance.ts                     [+keys section]
src/shared/types/match.ts                        [+keys field, +DroppedBody.keys]
src/shared/types/bomberman.ts                    [+keys on BombermanState]
src/shared/types/map.ts                          [+keySpawns]
src/shared/systems/TurnResolver.ts               [+step 1.5, step 9 body, step 9.5 gate, clone, event, escape consumes]
src/server/MatchRoom.ts                          [+keys spawn, init keys: 0]
src/server/BotPlayer.ts                          [+key seeking, gated escape]
tools/tiled-to-roombov.ts                        [+Keys object layer reader]
src/client/scenes/MatchScene.ts                  [+sprite preload, +renderer, +memory, +pickup VFX, +HUD widget + warning, +tooltip dispatch]
src/client/scenes/TooltipScene.ts                [+key icon shape]
src/client/tooltip/tooltipData.ts                [+tileKey, +tileHatchNeedsKeys]
src/client/backends/TutorialMatchBackend.ts      [+keys: [], bm.keys: 0]
tests/keys.test.ts                               [new — 9 cases]
docs/escape-hatch-rework.md                      [note that hatch now requires keys]
docs/keys-system.md                              [this file]
```

---

## 13. Verification checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` — all existing tests pass, new keys tests pass
- [ ] Manual: walk onto floor key → counter goes up, sprite disappears, flying icon plays
- [ ] Manual: walk onto body with keys → counter goes up by the right amount
- [ ] Manual: stand on hatch with < cap keys → red HUD warning + tooltip shows "N/3"
- [ ] Manual: stand on hatch with full keys → escape works, counter zeros
- [ ] Manual: respawn after dying → keys start at 0
- [ ] Manual: tutorial flow still ends on escape (no keys required)
- [ ] Fog-of-war: walk into LOS of a key, leave LOS, another bomberman picks it up, you still see the key — until you re-enter LOS
