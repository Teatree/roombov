# HIDDEN_STUFF.md

Features that are **hidden, not removed**. All code, data, types, tests, and
persistence stay intact — only the player-facing surface is switched off.

The switchboard is **`src/shared/config/features.ts`** (`HIDDEN_FEATURES`).
Flip a flag to `false` to bring that feature back; every gate listed below
reads from it. Keep this file in sync when adding or removing a gate.

---

## 1. Factory (`HIDDEN_FEATURES.factory`)

The 4-machine crafting system (`docs/` context: machines defined in
`src/shared/config/factories.ts`, scene in `src/client/scenes/FactoryScene.ts`).

Hidden on 2026-06-10. Gated sites:

| Site | What the gate does |
| --- | --- |
| `src/client/scenes/MainMenuScene.ts` (`create()` button list) | `[ FACTORY ]` filtered out of the menu button array; rows below shift up. The claim badge + 5s refresh timer self-skip because `factoryBtn` stays `null`. |
| `src/client/scenes/ResultsScene.ts` (shortcut row) | `factoryBtn` is created as `null`; row layout, the nav-wiring loop, and the claim-badge block all skip it. The row re-centers around the remaining buttons. |

**Still alive while hidden:**
- `FactoryScene` is still registered in `src/client/main.ts` and fully
  functional — reachable via `__game.scene.start('FactoryScene')` for testing.
- `FactoryService` (server) still answers factory socket events; profile
  `factories` state keeps persisting and machine cycles keep ticking.
  A player with an in-flight commission keeps it; they just can't reach the
  claim UI until the flag is flipped back.
- `tests/factory.test.ts` still runs and passes.

## 2. Treasure economy (`HIDDEN_FEATURES.treasures`)

Treasures (10 types in `src/shared/config/treasures.ts`) were the in-match
currency looted from chests/bodies, spent as a secondary cost on special
bombs and as Factory inputs.

Hidden on 2026-06-10. Gated sites:

| Site | What the gate does |
| --- | --- |
| `src/client/systems/TreasureListWidget.ts` (constructor) | The widget's container is `setVisible(false)` — **one gate hides the wallet everywhere**: MainMenu, MatchScene HUD, Results "Treasures Gathered", Bombs Shop, Bomberman Shop, Factory, Gambler Street. The full API keeps working (callers need no null checks). |
| `src/client/scenes/ResultsScene.ts` ("Treasures Gathered") | Section header + widget skipped entirely so no orphan header floats over the invisible widget. |
| `src/client/scenes/MatchScene.ts` (tooltip hit-test, top-right HUD) | The `treasureList` tooltip region (W-130..W-5, y 0..48) no longer returns a tooltip — it would otherwise pop over empty space. |
| `src/client/scenes/MatchScene.ts` (turn-event "fourth pass") | The treasure fly-out popups on `treasures_collected` / `body_looted` are suppressed (the local Results tally still accumulates — data, not presentation). |
| `src/server/BombsShopService.ts` (`getCatalog()`) | `treasureCost` omitted from catalog entries sent to the client → the Bombs Shop renders **coin price only** and never shows a treasure shortfall. |
| `src/server/BombsShopService.ts` (`buyBomb()`) | The secondary treasure cost is waived — special bombs are validated and charged in **coins only**. |
| `src/server/MatchRoom.ts` (chest spawn, ~`buildInitialState`) | Chest treasure roll replaced with `{}` → **treasure income from chests is 0**. Bodies/Scavs/escape rewards carry treasures forward from pickups, so with chests at 0 nothing enters circulation. |
| `src/server/BombermanUpgradeService.ts` (`nextTierCost()`) | The treasure component of every upgrade tier is returned as `0` → `applyUpgrade()` validates and charges **SP + coins only**. |
| `src/client/systems/BombermanUpgradePanel.ts` (cost row) | Treasure amount + icon not rendered; treasure shortfall no longer blocks the affordability highlight. |
| `src/client/systems/BombermanSelector.ts` + `src/client/scenes/ResultsScene.ts` (`cardHasAffordableUpgrade` / upgrade pip) | Affordability checks skip the treasure component, matching the server. |

**Bombs affected by the coins-only change** (catalog prices unchanged —
the treasure gate *was* most of their real cost, so revisit coin prices if
they start dominating):

| Bomb | Coin price | Waived treasure cost |
| --- | --- | --- |
| Phosphorus | 40 | 2× grapes |
| Cluster Bomb | 40 | 5× coffee |
| Big Huge | 125 | 2× lanterns |

**Upgrade pricing:** upgrade tiers charge SP + coins only while treasures are
hidden. The 2026-06-10 rebalance (coins absorbing the waived treasure cost)
was superseded by a full reprice on **2026-06-12** — current values below;
see the comment above `BALANCE.upgrades.cap` in
`src/shared/config/balance.ts`.

| Track / tier | SP | Coins | Waived treasure |
| --- | --- | --- | --- |
| CAP 1 | 100 | 500 | 12× mushrooms |
| CAP 2 | 200 | 750 | 25× mushrooms |
| STACK 1 | 50 | 250 | 8× coffee |
| STACK 2 | 100 | 400 | 18× coffee |
| STACK 3 | 200 | 600 | 38× coffee |
| HP 1 | 300 | 500 | 60× grapes |

If treasures are ever un-hidden, the pre-hide coin values were
cap 350/800, stack 300/700/1500, hp 2200 — revisit pricing rather than
restoring them blindly (the 2026-06-12 reprice changed SP too).

**Still alive while hidden:**
- `treasureCost` stays in `BOMB_CATALOG` (`src/shared/config/bombs.ts`) and
  in the type system (`src/shared/types/bombs.ts`, `messages.ts`).
- Upgrade tier `treasure` amounts + per-track `treasure` types stay in
  `BALANCE.upgrades` — they are simply not charged or displayed.
- Chest configs keep their `totalTreasures` / `treasureWeights` /
  `treasureSlotCount` values (`src/shared/config/chests.ts`) — only the roll
  call site is bypassed.
- Player profile `treasures` stashes persist untouched (existing balances are
  kept, invisible). Match-end `treasuresEarned` plumbing still runs (it just
  carries `{}` now).
- Tutorial is unaffected — tutorial chests have had no treasures since
  NEW_META §7.
- `tests/treasure-roll.test.ts` and friends still run against the un-gated
  pure functions.

## 3. Keys (`HIDDEN_FEATURES.keys`) — replaced by the Console system

The escape-hatch unlock cost: 12 keys per match distributed across chests by
tier weight, 3 carried keys required (and consumed) to escape; tutorial
required 1. Docs: `docs/keys-system.md`, `docs/escape-hatch-rework.md`.

Hidden on 2026-06-11. **While hidden, escape is gated by the Console system
instead** (the same flag switches the requirement): each bomberman gets a
seeded trio of `map.consoleSpots` (`assignedConsoles`), channels each by
standing Chebyshev-adjacent for `BALANCE.consoles.interactIdleTurns` (3)
damage-free idle turns (resolver step 9.45), and may escape from any
non-broken hatch once `BALANCE.consoles.requiredToEscape` (3, clamped to the
assigned count) are done. Gated sites:

| Site | What the gate does |
| --- | --- |
| `src/server/MatchRoom.ts` (`buildInitialState`, keys-in-chests block) | Key distribution skipped → chests carry 0 keys; **no keys enter circulation**. The TurnResolver pickup steps stay un-gated (they simply never fire). |
| `src/shared/systems/TurnResolver.ts` (step 9.5 escape gate) | Requirement switches from `keys >= cap` to `consolesUsed.length >= min(requiredToEscape, assignedConsoles.length)`; the `b.keys = 0` spend only runs when keys are visible. |
| `src/client/scenes/MatchScene.ts` (`buildHud` requirement counter) | The key icon becomes a 🖥 emoji Text and "N/3" counts consoles used; hidden entirely on maps with no consoles (tutorial). Same red-pulse / green-at-cap states. |
| `src/client/scenes/MatchScene.ts` (`renderHud` hatch warning + lock badges) | `Keys N/3 — loot chests for more` → `Consoles N/3 — hack your highlighted consoles first`; the hatch lock badge icon is 🖥 and counts consoles. |
| `src/client/scenes/MatchScene.ts` (`updateEscapeReadyIndicator`) | The escape ring's requirement check mirrors the resolver's console gate. |
| `src/client/scenes/MatchScene.ts` + `src/client/tooltip/tooltipData.ts` (`tileHatch`) | Hatch tooltip reads `Needs 🖥 N/3 consoles.` |
| `src/server/BotPlayer.ts` (`updateAiState`, `escapeAction`, `exploreAction`) | Bots skip the keys-chest detours; from `BALANCE.consoles.botStartFraction` (0.6) of the turn limit they seek + channel their trio, then extract. |
| `src/client/tutorial/tutorial-script.ts` | Tutorial chest `keys: 1` → `0`; two dialogue lines reworded (originals quoted below). |

**Original tutorial lines** (restore when un-hiding):
- Chest beat: `keys: 1`
- `"That KEY is for the escape hatch. You'll need it to extract. But that's later."`
- `"You don't have enough Keys to extract, but I'll spot you this one time."`

**Flag-conditional tests:** `tests/keys.test.ts` asserts the old key-spend
behavior in its `HIDDEN_FEATURES.keys === false` branch
(`escapeAllowed_whenAtCap_consumesKeys`), and the escape-block tests give
bombermen an unmet console trio so they hold under either flag state.
`tests/consoles.test.ts` covers the Console system and assumes the flag is on.

**Still alive while hidden:**
- All key pickup plumbing in `TurnResolver` (floor/body/chest, steps 1.5 +
  1.6c), `BALANCE.keys`, chest `keyWeight`s, `state.keys`, `key.png`,
  `spawnKeyPopup`/`spawnKeyFlightToHud`, `updateKeys()` — inert because no
  keys exist, not removed.
- `tests/keys.test.ts` pickup/body/death suites run against the un-gated
  pure functions and still pass.

**The Console system itself is NOT hidden** — it is the live escape
requirement. Its pieces: `BALANCE.consoles`, `map.consoleSpots` (Tiled
`Consoles` tile layer → converter clusters 2×2 marker blocks into bounding
boxes and strips the layer from the public `.tmj`), `consoles.png` (frame 0
inactive / 1 active), `BombermanState.assignedConsoles/consolesUsed/
consoleIdleTurns/consoleEngagedId`, the `console_used` TurnEvent, the cyan
channel ring, and the red nav line (client-only, after ≥1 console done,
never drawn over never-seen fog).

## 4. Gambler Street (hidden earlier, different mechanism)

Shelved post-NEW_META §8, **before** `HIDDEN_FEATURES` existed:
`GamblerStreetScene` is simply **not registered** in `src/client/main.ts`
(commented import). Engine (`src/shared/systems/GamblerStreetEngine.ts`),
config, server service (`src/server/GamblerStreetService.ts`), scene file,
and tests are all preserved. To revive: re-register the scene and add an
entry button (its old entry points were removed).

---

## How to un-hide

1. Open `src/shared/config/features.ts`.
2. Set `factory`, `treasures`, and/or `keys` to `false`.
3. That's it — no other edits needed. Run `npm run typecheck && npm test`
   and eyeball MainMenu/Results/BombsShop/Match HUD.
4. If un-hiding treasures, reconsider the coin prices of Phosphorus /
   Cluster Bomb / Big Huge (they were balanced around treasure gating), and
   restore the old upgrade coin costs (table above — the bumped values
   compensate for the waived treasure component).
5. If un-hiding keys: the escape gate flips back to carried keys and the
   Console system goes dormant — console sprites, the cyan ring, the red nav
   line, and the 🖥 HUD/badge/tooltip swaps are all gated on the same flag,
   so they disappear together (the resolver still tracks channel progress,
   it just gates nothing). Restore the tutorial chest key + the two quoted
   dialogue lines (§3 above).
