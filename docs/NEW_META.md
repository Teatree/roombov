# NEW_META — Meta-Progression Reset

**Status:** Spec locked, implementation pending
**Owner:** Claude Code (this session)
**Last updated:** 2026-05-16
**Related:** `docs/keys-system.md`, `docs/escape-hatch-rework.md`, `docs/PROJECT-SUMMARY.md`

A self-contained spec for the seven-part meta-system reset that precedes the new Factory subsystem. Each section records the change, locked decisions, files touched, and acceptance criteria.

Implementation order is at the bottom — sections are independently verifiable so we can pause after any one.

---

## 1. +2 Bomberman stack shift

**Change:** Every tier's rolled stack-size range shifts up by 2.

**Decisions:**
- `TIER_CONFIG.stackSizeRange` in `src/shared/config/bomberman-tiers.ts`:
  - `free`: `[4, 5]` → `[6, 7]`
  - `paid`: `[6, 7]` → `[8, 9]`
  - `paid_expensive`: `[8, 10]` → `[10, 12]`
- `defaultStatsForTier()` inherits automatically (it midpoints the range).
- Existing owned Bombermen on persisted profiles keep their rolled `stackSize`. No retroactive bump. New rolls (Bomberman Shop) get the new range immediately.

**Files:**
- `src/shared/config/bomberman-tiers.ts`

**Acceptance:**
- `npm run typecheck` clean.
- A freshly purchased Bomberman from each tier rolls inside the new range.

---

## 2. Coins back in chests (parallel to treasures)

**Change:** Each chest spawns with a coin amount rolled in a tier-specific range. Coins are an in-match wallet on the Bomberman, banked into `PlayerProfile.coins` on escape — same lifecycle as treasures.

**Decisions:**

| Chest tier | Coin range (uniform) |
| --- | --- |
| 1 (Wooden) | 50–100 |
| 2 (Iron) | 75–150 |
| 3 (Golden) | 150–250 |

- New field `coins: number` on `Chest`, `DroppedBody`, `BombermanState`.
- Auto-collected on chest-open (step-on tile), same pass that auto-collects treasures.
- Pickup spawns a flying coin animation **identical** to the treasure pickup animation (re-use the same code path, just with a coin icon).
- HUD treasure list (top-right MatchScene) **always** shows Coins at the top of the column, regardless of amount — including zero.
- When a Bomberman dies, current coin count transfers to `DroppedBody.coins`. Another Bomberman walking onto the body picks them up (no cap on coins).
- On escape (TurnResolver step 9.5 / escape event → `MatchRoom` profile commit), coins fold into `PlayerProfile.coins`. Treasures stay on the same flow.
- Tutorial chest gets a fixed amount (no random roll); see §6.

**Files:**
- `src/shared/types/match.ts` — add `coins` to `Chest`, `DroppedBody`, `BombermanState`.
- `src/shared/config/chests.ts` — add `coinRange: [number, number]` to `ChestTierConfig`, populate per tier.
- `src/server/MatchRoom.ts` — roll coins at chest spawn (`buildInitialState`), initialize `b.coins = 0` on bombermen, fold coins into profile on escape (existing escape handler).
- `src/shared/systems/TurnResolver.ts` — step 2 (interactions): when a chest opens, add `chest.coins` to bomberman wallet and emit a `coins_picked_up` event; step 9 (deaths): copy coins onto body; body-walk-on transfer.
- `src/shared/types/match.ts` — extend `TurnEvent` with `{ kind: 'coins_picked_up', playerId, amount, x, y }`.
- `src/client/scenes/MatchScene.ts` — render flying coin animation on `coins_picked_up`; ensure HUD treasure list pins Coins to top.
- `src/client/tutorial/TutorialDirector.ts` — `spawnChest` step accepts `coins: number`.

**Acceptance:**
- Open a chest of each tier; HUD coin counter increases by an amount in range.
- Die after looting; another player walks onto the body and gains the coins.
- Escape with non-zero coins; profile coin balance increases by exactly that amount.
- Coins row always visible top-right, even at 0.

---

## 3. Treasure variety trimmed to 4

**Change:** Only four treasure types appear in chests. Existing player profiles get the other six silently zeroed at load time.

**Decisions:**

| Treasure | Weight |
| --- | --- |
| 🍄 mushrooms | 200 |
| ☕ coffee | 50 |
| 🍇 grapes | 25 |
| 🏮 lanterns | 10 |

- The 10 `TreasureType` enum values remain in the type system for compatibility — old data deserializes fine.
- `treasureWeights` in every tier in `chests.ts` replaced by the 4-entry map above. Same weights across tiers 1/2/3 (the spec doesn't differentiate per-tier weights).
- `PlayerStore.loadProfile` zeroes `fish`, `chalice`, `jade`, `books`, `bones`, `amulets` from `profile.treasures` on read. Self-healing — saves over time as profiles get written back.

**Files:**
- `src/shared/config/chests.ts` — replace `UNIFORM_TREASURE_WEIGHTS` block and the tier-3 weight overrides.
- `src/server/PlayerStore.ts` — in the profile-load path (`loadProfile`), strip the 6 removed treasure types.

**Acceptance:**
- Open 10 chests across a few matches; only mushroom/coffee/grapes/lantern appear.
- Reload an existing profile that has e.g. `chalice: 5`; profile `treasures.chalice` is undefined after load.
- Tests `treasure-roll.test.ts` still pass (or updated to reflect new weights).

---

## 4. Keys spawn in chests, not on the map

**Change:** The 15 keys per match are distributed across spawned chests by tier weight. Floor-key map spawning is disabled but its code is preserved.

**Decisions:**

| Chest tier | Key weight |
| --- | --- |
| 1 (Wooden) | 50 |
| 2 (Iron) | 75 |
| 3 (Golden) | 100 |

- Distribution algorithm: for each of the 15 keys, pick one chest by weighted random over the spawned chest list (weights from the table). Multiple keys on the same chest are fine. No per-chest cap — a Golden chest on a small map may legitimately hold many keys.
- New field `keys: number` on `Chest`.
- Pickup: when a Bomberman steps on a chest (open OR already-opened-with-leftover), auto-collect `min(chest.keys, requiredPerHatch - bomberman.keys)`; decrement `chest.keys`. Keys stay collectable from chests with leftover keys even after the chest is opened.
- **Not** shown in the loot UI. No visible badge, no leftover count. Internal-only.
- Floor-key spawning (`MatchRoom` reads `map.keySpawns`) is **commented out** with a `// DISABLED:` block. `state.keys: []` always empty for real matches. Map `keySpawns` data + `map.ts` type + Tiled object layer remain intact for re-enabling.
- Tutorial keeps its scripted floor keys (TutorialDirector spawns them directly into `state.keys`), so the floor-key pickup code path in TurnResolver stays alive.

**Files:**
- `src/shared/types/match.ts` — add `keys: number` to `Chest`.
- `src/shared/config/chests.ts` — add `keyWeight: number` per tier.
- `src/shared/config/balance.ts` — keys section gets a comment noting chests are the source for real matches.
- `src/server/MatchRoom.ts` — comment out the `keySpawnPool` block; after chests are rolled, run the weighted distribution and assign `chest.keys`.
- `src/shared/systems/TurnResolver.ts` — interaction pass: on chest step, pick up keys up to cap; emit existing `key_picked_up` event (one per key).
- `src/client/tutorial/TutorialDirector.ts` — `spawnChest` step accepts `keys: number`.

**Acceptance:**
- Across 20 simulated chest distributions, the sum is always 15 keys total.
- Tier 3 chests on average hold roughly 4× as many keys as tier 1 chests.
- Walking on an opened chest with leftover keys still picks them up.
- `state.keys` is empty in real matches; floor-key sprite layer renders nothing.
- Tutorial floor keys still work.

---

## 5. Bots seek chests, not floor keys

**Change:** Replace bot floor-key targeting with nearest-unlooted-chest targeting.

**Decisions:**
- Per-bot state: `lootedChestIds: Set<string>` — chests this bot has personally stepped on. Persists across turns inside the bot instance.
- When a bot needs keys (below `requiredPerHatch` cap):
  - Find the **nearest reachable chest** by path distance whose `id` is not in `lootedChestIds`.
  - If found, route there.
  - If none found (all known chests looted, or none in current LOS / memory), fall through to existing exploration behavior.
- Remove `findNearestKnownKey` references in `BotPlayer.ts`. Replace both call sites (line ~203 and ~349) with `findNearestUnlootedChest`.
- "Nearest" is path distance (using existing `findPath`), not Chebyshev — same as the floor-key version.
- Bot adds `chest.id` to `lootedChestIds` after stepping on the chest tile (detect via `state.chests.find(c => c.x === me.x && c.y === me.y && c.opened)` post-move, or by listening for chest_opened events if available).

**Files:**
- `src/server/BotPlayer.ts`

**Acceptance:**
- Bot with 0 keys navigates toward the nearest known unlooted chest.
- Bot does not loop back to a chest it's already stepped on.
- Bot reaching key cap (3) reverts to hatch-seeking.

---

## 6. All Bombermen paid (formula-driven, free tier removed special-case)

**Change:** Remove the `tier === 'free' ? 0` hard-pin. Let `computeBombermanPrice` run for free-tier Bombermen too. Verify range lands in ~50–120; adjust pricing coefficients only if it doesn't.

**Decisions:**
- Single line change in `BombermanShopService.rollBomberman` (line ~128–130): drop the conditional.
- After change, before merging: simulate 100 free-tier rolls with the new stack range (`[6, 7]`) and current pricing coefficients (`stackThreshold=5`, `coinPerExtraStack=25`, `bombCostRatio=0.30`, `roundToNearest=5`). Report observed min/max.
  - Rough hand math: slotCost = 0 (4 slots, threshold 5). stackCost = 25 or 50. bombCost ≈ Σ(10 bombs × ~15 avg price × 0.30) = ~45. Total before rounding ≈ 70–95. Plausibly in range.
- If observed range falls outside 50–120, the **only** lever to touch is `BOMBERMAN_PRICING.coinPerExtraStack` and/or `bombCostRatio`. Adjust and re-simulate. No new tier-specific coefficient.
- Free tier comment in `bomberman-tiers.ts` updated to reflect no special pricing case.

**Files:**
- `src/server/BombermanShopService.ts` — drop the free-tier zero shortcut.
- `src/shared/config/bomberman-tiers.ts` — comment update only.

**Acceptance:**
- Simulated 100 rolls of `free` tier produce prices in [50, 120].
- Existing `paid` and `paid_expensive` price ranges unchanged.

---

## 7. Tutorial updates

**Change:** Tutorial chest gives only coins + 1 key (no treasures); a new dialog beat introduces keys; hatch requires 1 key instead of 3.

**Decisions:**

**7a. Tutorial chest contents:**
- Fixed: 75 coins, 1 key, **no treasures**, existing bombs unchanged.
- `TutorialDirector.spawnChest` step now passes `coins: 75, keys: 1, treasures: {}`.

**7b. New tutorial dialog beat (drafted, awaiting copy approval):**
- Trigger: after the player auto-loots the chest (coins + key fly up).
- Copy draft: *"That key is for the escape hatch. You'll need one to extract. Keep it safe."*
- (Final wording can be tightened with the writer agent later — this is just placeholder for the spec.)

**7c. Tutorial hatch keys requirement:**
- New balance constant `BALANCE.keys.tutorialRequiredPerHatch = 1`.
- In `TurnResolver` step 9.5 (escape-hatch evaluation): use `state.isTutorial ? BALANCE.keys.tutorialRequiredPerHatch : BALANCE.keys.requiredPerHatch`.
- Key carry cap also follows the tutorial value (so tutorial Bomberman maxes at 1 key, not 3) — affects interaction pass key auto-pickup cap.
- Existing tutorial "bypass keys entirely" carve-out is removed.

**Files:**
- `src/client/tutorial/TutorialDirector.ts` — modify the relevant `spawnChest` step and add a new dialog step.
- `src/shared/config/balance.ts` — add `tutorialRequiredPerHatch: 1`.
- `src/shared/systems/TurnResolver.ts` — use the tutorial value when `state.isTutorial`.
- `tests/escape-hatch.test.ts` and `tests/keys.test.ts` — update tutorial-flow assertions if any.

**Acceptance:**
- Run the tutorial; chest grants 75 coins and 1 key, no treasures.
- Tutorial Bomberman cannot pick up a second key (cap respected at 1).
- Escape hatch accepts the Bomberman with 1 key.

---

## 8. Hide Gambler Street, add Factory placeholder

**Change:** Gambler Street UI is hidden and scene-unwired; server-side service is left running but unreferenced. New empty Factory scene takes its slot.

**Decisions:**
- `MainMenuScene` button array: remove the `[ GAMBLER STREET ]` entry; insert `[ FACTORY ]` → `this.scene.start('FactoryScene')` in the same position.
- `src/client/main.ts`: remove `GamblerStreetScene` from the scene array (it stays as a source file, just unregistered). Add `FactoryScene` registration.
- `src/client/scenes/GamblerStreetScene.ts`: untouched on disk. Code-comment header gets a `// DISABLED — meta system reset 2026-05-16` line at top.
- Server-side `GamblerStreetService`: untouched. Profile field `gamblerStreet` remains. The lazy tick is harmless since no client triggers it.
- Treasure tooltip / widget copy that mentions "Gambler Street": replace with neutral text like "spent at meta-progression locations" (one-line change).
- New `src/client/scenes/FactoryScene.ts`: minimal Phaser scene, dark background, centered title "FACTORY", centered subtitle "(coming soon)", `[ BACK ]` button → `this.scene.start('MainMenuScene')`.

**Files:**
- `src/client/scenes/MainMenuScene.ts`
- `src/client/main.ts`
- `src/client/scenes/FactoryScene.ts` (new)
- `src/client/scenes/GamblerStreetScene.ts` (comment header only)
- Wherever "Gambler Street" appears in user-facing copy (one or two strings).

**Acceptance:**
- Main Menu shows `[ FACTORY ]` in the position previously occupied by `[ GAMBLER STREET ]`.
- Clicking `[ FACTORY ]` opens an empty scene with title + back button.
- Gambler Street is unreachable through normal navigation.
- Existing player profiles with active gamblers do not crash on load.

---

## Implementation order

Each block runs `npm run typecheck` after and `npm test` at the end:

1. **§1 stack shift** — single config edit, low blast radius.
2. **§3 treasure trim + profile heal** — config + loader. Establishes the new treasure surface before coins land.
3. **§2 coins in chests** — data plumbing through `MatchState`, resolver, HUD. Largest section.
4. **§4 keys in chests** — depends on §3-ish (chest spawn flow already touched). Distribute keys; disable floor spawn.
5. **§5 bot rework** — depends on §4 (chest is now the key source).
6. **§6 all-paid pricing** — independent; can land any time post-§1 (since stack range affects price).
7. **§7 tutorial updates** — independent of above except needs `coins` and `keys` fields on `spawnChest`.
8. **§8 Gambler hide + Factory add** — UI-only, independent. Land last to keep the diff readable.

After each block: typecheck + relevant tests. Final pass: full `npm test`.

---

## Out of scope (do not touch this pass)

- The Factory's actual functionality — purely a placeholder scene.
- Retroactive `stackSize` bumps on owned Bombermen.
- Deletion of unused treasure types from the type system.
- Server-side disabling of `GamblerStreetService` (kept dormant for revival).
- Live-ops, balancing, or playtesting of the new economy. We're shipping the wiring; tuning comes later.
