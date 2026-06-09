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

**Upgrade coin rebalance (2026-06-10):** unlike the bombs, upgrade tiers got
**higher coin costs** to absorb the waived treasure cost (SP unchanged).
Conversion: (treasure amount ÷ avg per-run haul) × ~300 coins per-run income,
rounded — see the comment above `BALANCE.upgrades.cap` in
`src/shared/config/balance.ts`.

| Track / tier | SP (unchanged) | Coins old → new | Waived treasure |
| --- | --- | --- | --- |
| CAP 1 | 160 | 350 → 400 | 12× mushrooms |
| CAP 2 | 480 | 800 → 900 | 25× mushrooms |
| STACK 1 | 130 | 300 → 350 | 8× coffee |
| STACK 2 | 340 | 700 → 850 | 18× coffee |
| STACK 3 | 760 | 1500 → 1800 | 38× coffee |
| HP 1 | 980 | 2200 → 3000 | 60× grapes |

If treasures are ever un-hidden, restore the old coin values alongside.

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

## 3. Gambler Street (hidden earlier, different mechanism)

Shelved post-NEW_META §8, **before** `HIDDEN_FEATURES` existed:
`GamblerStreetScene` is simply **not registered** in `src/client/main.ts`
(commented import). Engine (`src/shared/systems/GamblerStreetEngine.ts`),
config, server service (`src/server/GamblerStreetService.ts`), scene file,
and tests are all preserved. To revive: re-register the scene and add an
entry button (its old entry points were removed).

---

## How to un-hide

1. Open `src/shared/config/features.ts`.
2. Set `factory` and/or `treasures` to `false`.
3. That's it — no other edits needed. Run `npm run typecheck && npm test`
   and eyeball MainMenu/Results/BombsShop/Match HUD.
4. If un-hiding treasures, reconsider the coin prices of Phosphorus /
   Cluster Bomb / Big Huge (they were balanced around treasure gating), and
   restore the old upgrade coin costs (table above — the bumped values
   compensate for the waived treasure component).
