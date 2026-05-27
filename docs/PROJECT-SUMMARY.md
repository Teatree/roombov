# Roombov — Project Summary

A turn-based PvP Bomberman-style browser game with a roguelike loot/extraction
economy. This document is a self-contained context handoff — share it with
another Claude instance (Desktop, web, etc.) so it can reason about the project
without reading the codebase.

Last reviewed against source: **2026-05-26**.

Recent shape of the project (since the NEW_META reset, May 16-17 → present):

- **Gambler Street is gone** from the live build (scene unregistered, files
  preserved). Its role as the meta loop is filled by the **Factory** and the
  per-Bomberman **SP / Upgrade** system.
- **Coins are earned in-match** by looting chests (50–250 per chest depending
  on tier). They are no longer a purely meta currency.
- **3 chest tiers** (Tier 1 / 2 / 3) — Tier 3 added post-NEW_META.
- **Active treasure pool is 4 types only**: mushrooms, coffee, grapes,
  lanterns. The other 6 treasure types still exist in the type system at
  weight 0 (never rolled).
- **Per-Bomberman stats**: each owned Bomberman carries its own `maxCustomSlots`,
  `stackSize`, and (since May 24-25) `sp` + `upgrades` for the three upgrade
  tracks (cap, stack, hp).
- **Escape hatches are randomized** — 5 per match, picked from the map's
  candidate `escapeTiles[]` pool via seeded shuffle.
- **Results-screen redesign** (May 26): bomberman hero block with sprite +
  animated SP/R.I.P. text + reaction tier ("Bad" / "Not Bad" / "Nice" /
  "Excellent") based on SP earned.

---

## 1. The game in one paragraph

Up to 4 players (real + bots, with up to 2 Scav NPCs as a separate AI brain)
drop into a top-down dungeon arena. Combat is **turn-based** with a fixed
input phase, then a deterministic resolution phase. Players carry a small
loadout of bombs (each with distinct shapes, fuses, and side-effects), search
the map for **chests** holding bombs, treasures, **coins**, and **keys**, and
try to **escape through a hatch** (3 keys required) before the turn limit.
What they escape with persists into a profile-level stash; what they die
holding stays on the corpse for someone else to loot.

The economy is now a **three-loop**:

```
   ┌──────────────────────────────────────────────────────────┐
   │                       MATCH LOOP                          │
   │  spawn → loot chests → fight → escape (or die)            │
   │                                                           │
   │  on escape:  + treasures, + coins, + keys-consumed,       │
   │              + SP banked on this Bomberman                │
   │  on death:   - everything carried (drops on body)         │
   └────────────┬──────────────────────────────────────────────┘
                │
       ┌────────┴──────────┐   ┌──────────────────┐   ┌──────────────────┐
       │   BOMBS SHOP      │   │ BOMBERMAN SHOP   │   │   FACTORY        │
       │ coins → bombs     │   │ coins → new      │   │ treasures →      │
       │ (+ stockpile +    │   │ characters       │   │ bombs (wall-clock│
       │  equip to slot)   │   │ (2-min rotating  │   │ machines, idle-  │
       │                   │   │ carousel)        │   │ income loop)     │
       └─────────┬─────────┘   └─────────┬────────┘   └────────┬─────────┘
                 │                       │                     │
                 └─────────┬─────────────┴────────┬────────────┘
                           ▼                      ▼
                 ┌──────────────────────────────────────┐
                 │   PER-BOMBERMAN UPGRADES             │
                 │   SP + coins + treasures → permanent │
                 │   stat tiers on a specific Bomberman │
                 │   (cap / stack / hp)                 │
                 └──────────────────────────────────────┘
```

---

## 2. Tech stack & runtime shape

- **Browser client**: Phaser 3 (TypeScript, ESM), built with Vite.
- **Server**: Node.js + Express + Socket.IO, run via `tsx` (no transpile step
  in dev). One process, no dedicated game-server fleet.
- **Tests**: Vitest. The pure-function game logic is unit-tested directly.
- **Persistence**: per-player JSON files under `production/player-data/`
  (one file per profile id). No database.
- **Hosting target**: render.com.
- Strictly typed TypeScript, ESM-only, `.ts` import extensions required.

The codebase is split into three trees under `src/`:

- `src/shared/` — pure game rules. No DOM, no Phaser, no Node APIs. Imported
  by both client and server.
- `src/server/` — Socket.IO orchestration, match rooms, persistence, shops.
- `src/client/` — Phaser scenes, rendering systems, input.

The single most important rule: **`src/shared/systems/TurnResolver.ts` is a
pure function**. It runs identically on the server (authoritative) and on the
client (in tutorial mode, where there is no real server). It applies an
**11-step** resolution order each turn (movement → interactions → bomb
placement → fuse tick → explosions → fire damage → fire/light aging →
bleeding → deaths → escapes → end-check). Everything derivable from
`MatchState` should be derived, not stored.

---

## 3. The match itself

- **Map**: tile-based. Authored in Tiled, exported to JSON, includes a
  required `Collision` layer plus an `escapeTiles` candidate pool and
  `chestZones` for content seeding.
- **Turn**: 2s input phase + 2s transition/resolution phase. Players queue a
  single action (move, throw bomb, interact, wait). Server is authoritative.
- **Turn limit**: 250. Warning HUD lights up under 10 turns left.
- **Movement**: 1 tile/turn normally. **Out-of-Combat Rush** (2 tiles/turn)
  activates after 3 peaceful turns when no enemy is within 8 tiles + mutual
  line-of-sight, and no placed bomb is within 8 tiles (bombs break rush
  through walls — they're loud).
- **HP**: base 2, capped at 3 with the HP upgrade track. Each bomb deals at
  most 1 damage per Bomberman per trigger; damage is capped per resolution
  set. Bleeding lasts 10 turns.
- **Fog of war**: per-player line-of-sight, radius 5 tiles.
- **Spawning**: minimum 5-tile distance between Bombermen.
- **Win condition**: escape through a hatch (carrying ≥3 keys), OR be the
  last alive when the turn limit hits.
- **Loot**: chests scatter across the map at Tier 1 / Tier 2 / Tier 3 zones
  (14 / 3 / 1 per match). Killed Bombermen drop a body that can be looted
  by anyone (transfers bombs + treasures + keys up to carry cap).
- **Escape hatches**: 5 per match, randomly chosen from the map's
  pre-authored candidate pool via seeded shuffle. Each hatch costs 3 keys and
  **breaks** after a single use.
- **Scavs**: up to 2 alive NPC raiders at any moment — separate AI brain
  from bots, more persistent (longer chase, higher predict chance, hostile
  on sight).

---

## 4. BOMBS — the catalog

Every bomb is data-driven from `src/shared/config/bombs.ts` (`BOMB_CATALOG`).
Bomb behaviors are tagged: `explode`, `fire`, `light`, `smoke`, `place_mine`,
`stun_explode`, `phosphorus_seed`, `cluster_seed`, `scatter`, `teleport`,
`shield_wall`. Tuning constants live in `src/shared/config/balance.ts`.

| Bomb                  | Fuse | Pattern                       | Effect                                       | Coin | Treasure Cost   |
|-----------------------|-----:|-------------------------------|----------------------------------------------|-----:|-----------------|
| Rock                  |    0 | single tile                   | Infinite fallback, 1 dmg target only         |    0 | —               |
| Bomb                  |    1 | + radius 4                    | Standard blast, 9×9 cross                    |   25 | —               |
| Wide Bomb             |    2 | circle radius 2 (raycast)     | 5×5, walls block                             |   40 | —               |
| Delay Tricky          |    1 | diagonal radius 3             | X-shape blast                                |   25 | —               |
| Contact               |    0 | + radius 1                    | Detonates on landing                         |   95 | —               |
| Banana                |    1 | scatters 4 children diagonally| Each child = + r1 a turn later               |   30 | —               |
| Flare                 |    0 | circle r4 light, 3 turns      | Reveals area, no damage, doesn't break Rush  |    5 | —               |
| Molotov               |    0 | + r1 fire, 2 turns            | Fire ticks each turn                         |  100 | —               |
| Ender Pearl           |    0 | self-teleport                 | Lands → you teleport in. Doesn't break Rush  |   50 | —               |
| Fart Escape           |    0 | move 2 + smoke r5, 4 turns    | Escape move + smoke screen                   |   15 | —               |
| Motion Detector Flare |    0 | proximity mine, r3            | Fires a flare when enemy enters range        |    5 | —               |
| Flash                 |    1 | circle r3 (7×7) stun          | Stuns caught Bombermen 1 turn                |   65 | —               |
| Shield Bomb           |    0 | + r1 wall, 3 turns            | Wall blocks movement & explosions, pushes occupants out without damage | 30 | — |
| Phosphorus            |    0 | reveal r5, then scattered fire| **Super** — 11×11 reveal then burn pattern   |   40 | 2 grapes        |
| Cluster Bomb          |    0 | scatters 25 mines in 11×11    | **Super** — touch mines                      |   40 | 5 coffee        |
| Big Huge              |    2 | circle r5 raycast (11×11)     | **Super** — massive blast                    |  125 | 2 lanterns      |

Notes:

- "Super bombs" (Phosphorus, Cluster, Big Huge) carry **both a coin price
  AND a treasure cost** at the Bombs Shop. Treasure types are tuned against
  per-run haul: grapes (rare-ish) for phosphorus, coffee (common) for
  cluster, lanterns (rarest) for big_huge.
- Walls + LoS interact with each bomb shape via `BombResolver` (raycast vs.
  geometric pattern depending on shape kind).
- Status effects: Stunned (Flash), Bleeding (any explosion that didn't kill).
- The Shield Bomb acts before push resolution, extinguishes fire under it,
  suppresses phosphorus, holds mines dormant.

---

## 5. TREASURES (in-match earning, persistent stash)

Defined in `src/shared/config/treasures.ts`. There are 10 type slots in the
type system (mapped 1:1 to a 5×2 sprite sheet), but post-NEW_META **only 4
are actively rolled** from chests:

```
mushrooms (weight 200) — common,    used in CAP upgrades + machine 1 cycles
coffee    (weight  50) — uncommon,  used in STACK upgrades + machines 2/3
grapes    (weight  25) — rare,      used in HP upgrade + machines 3/4
lanterns  (weight  10) — rarest,    used in machine 4 (super-bomb factory)
```

The other six types (`fish`, `chalice`, `jade`, `books`, `bones`, `amulets`)
remain in the type system for back-compat but have weight 0 — they no longer
appear in chest rolls or any active code path.

### Storage shape

```ts
type TreasureBundle = Partial<Record<TreasureType, number>>;
```

Sparse — an absent or 0 entry means "none of that type". The same type appears
on `Chest`, `DroppedBody`, `BombermanState` (in-match carry), and
`PlayerProfile.treasures` (persistent stash). Helpers: `mergeTreasures(a, b)`,
`totalTreasures(b)`, `hasAnyTreasure(b)`.

### Where treasures come from

- **Chests**: rolled with the same algorithm as bomb loot (`rollTreasureLoot`):
  pick K unique types from the tier's weighted pool, then split a fixed total
  count across them in proportion to weights. Per `src/shared/config/chests.ts`:
  - **Tier 1**: 25 treasures, 3 unique types, 5 bombs across 1–2 unique slots,
    50–100 coins, keyWeight 25.
  - **Tier 2**: 75 treasures, 5 unique types, 8 bombs across 2–3 unique slots,
    75–150 coins, keyWeight 75. Has access to super bombs at weight 15.
  - **Tier 3**: 150 treasures, 6 unique types, 12 bombs across 3–4 unique
    slots, 150–250 coins, keyWeight 100. Super bombs at weight 100 (commonly
    rolled, not rare). The premium chest.
- **Dead bodies**: when a Bomberman dies their carried treasures stay on the
  body and can be looted.

### Where treasures go

- On **escape**, all carried treasures merge into `PlayerProfile.treasures`.
  This is the only way to bank them — die and they stay on the corpse.
- **Spent at the Factory** (`config/factories.ts`) — treasures pay for
  machine cycles that produce bombs over wall-clock time.
- **Spent on per-Bomberman upgrades** (§8) — cap track costs mushrooms,
  stack track costs coffee, HP track costs grapes.
- **Spent at the Bombs Shop** as part of the price of super bombs (alongside
  coins).
- **Display surfaces**: `TreasureListWidget` shows the persistent stash on
  MainMenu, the in-match HUD top-right, Results, Bombs Shop, Factory, and
  the Bomberman Upgrade popup.

### Keys

15 keys are distributed at match start across spawned chests via each tier's
`keyWeight` (T1=25, T2=75, T3=100). Auto-collected on chest-open up to the
carry cap (= `requiredPerHatch` = 3). Keys do **not** persist — they reset
each match.

### Coins

Coins are still the soft currency for shops, but they now flow:

- **Earned in-match** from chests (50–250 per chest depending on tier).
- **Auto-collected** on chest-open, same as treasures and keys.
- Banked into `PlayerProfile.coins` on escape (lost on death).
- Brand-new profiles spawn with 500 coins.

---

## 6. BOMBERMEN (characters) and the BOMBERMAN SHOP

A "Bomberman" is a **character skin + starting bomb inventory + per-instance
stats + per-instance upgrade tiers**. Two shapes:

- `BombermanTemplate` — generated, sits in the shop carousel until bought.
- `OwnedBomberman` — what the player owns; cloned from the template at
  purchase with stable id, purchase timestamp, and (since May 24-25) its
  own SP balance + lifetimeSp + per-track upgrade counts.

An OwnedBomberman has:

- `id`, `name`, `sourceTemplateId`
- `tier` — `'free' | 'paid' | 'paid_expensive'`
- `price` — formula-driven (see below), 0 only when the hardship discount
  fires.
- `colors` — random RGB triple `{ shirt, pants, hair }` used by the shop card
  procedural illustration.
- `tint` — single 24-bit RGB used in-match via Phaser `setTint`.
- `character` — sprite-sheet variant `char1`–`char7`.
- `inventory` — array of `{ type, count }` pairs, length = `maxCustomSlots`
  (per-tier). An infinite Rock is granted as a fixed slot at match time on
  top of these (so `displayed loadout = customSlots + 1`).
- `maxCustomSlots`, `stackSize` — rolled per-Bomberman from the tier config.
- `sp`, `lifetimeSp` — Skill Points (spendable + uncapped lifetime accumulator
  for the Results hero block).
- `upgrades: { cap: 0..2, stack: 0..3, hp: 0..1 }` — per-track applied tiers.

**Always read effective stats via `effectiveMaxCustomSlots(owned)` /
`effectiveStackSize(owned)` / `effectiveMaxHp(owned)` from
`src/shared/utils/bomberman-stats.ts`.** Reading the raw `maxCustomSlots` /
`stackSize` fields ignores applied upgrades and has been the source of
multiple cap-display and slot-validation bugs.

### Per-tier rolls (`src/shared/config/bomberman-tiers.ts`)

Each tier specifies `customSlots`, `stackSizeRange`, `totalBombs`,
`maxUniqueSlots`, and a weighted bomb pool. Inventory is rolled with
`rollBombLoot` — pick unique types weighted, then distribute total across
them by largest-remainder.

| Tier            | customSlots | stackSize | totalBombs | maxUnique | Pool highlights                                                   |
|-----------------|------------:|-----------|-----------:|----------:|-------------------------------------------------------------------|
| free            |           4 | 6–7       |         10 |         3 | Standard bombs, flare, banana, fart_escape, ender, flash, shield  |
| paid            |           5 | 8–9       |         14 |         4 | + contact (10), molotov (10), motion detector (40)                |
| paid_expensive  |           6 | 10–12     |         16 |         4 | + super bombs (phosphorus/cluster/big_huge, weight 10)            |

### Pricing formula (post NEW_META §6, May 24 retune)

```
slotCost  = max(0, totalSlots - slotThreshold)   × coinPerExtraSlot
stackCost = max(0, stackSize  - stackThreshold)  × coinPerExtraStack
bombCost  = Σ (slot.count × BOMB_CATALOG[slot.type].price) × bombCostRatio
raw       = (slotCost + stackCost + bombCost)    × priceMultiplier
price     = max(minPrice × priceMultiplier, round-to-nearest-5(raw))
```

Current coefficients (`BOMBERMAN_PRICING`):

| Field               | Value | Notes                                                |
|---------------------|------:|------------------------------------------------------|
| slotThreshold       |     5 |                                                      |
| coinPerExtraSlot    |    50 |                                                      |
| stackThreshold      |     5 |                                                      |
| coinPerExtraStack   |    25 |                                                      |
| bombCostRatio       |   1.0 | The Bomberman costs 100% of its loadout's coin value. Raised from 0.08 on May 24. |
| roundToNearest      |     5 |                                                      |
| minPrice            |    50 | Pre-multiplier floor — keeps free tier ≥50.          |
| priceMultiplier     |     2 | Global 2× scalar, applied May 23.                    |

The pricing formula runs on **every** tier including free; rolled prices
typically land free ~100–200, paid ~300–700, paid_expensive ~800–1500.

### The Bomberman Shop (`src/server/BombermanShopService.ts`)

- The shop runs on a **per-player 2-minute cycle**
  (`SHOP_CYCLE_DURATION_MS`).
- Each cycle has a fixed composition: **2 free + 2 paid + 1 paid_expensive
  = 5 cards** (`SHOP_CYCLE_COMPOSITION`).
- Cycle generation is **lazy / on-demand**: any caller that asks for the
  current cycle past `endsAt` triggers a regeneration. A `shop_cycle` socket
  broadcast fires on regeneration so connected clients see the new roster live.
- Cards are seeded from a hash of the cycle id; same seed reproduces the
  same cards (useful for debugging).
- **Roster cap**: 5 owned Bombermen (`BALANCE.player.ownedBombermenCap`).
- A profile cannot buy the same template twice within a cycle (dedup against
  `sourceTemplateId`). New cycle → new ids → can buy a similar one again.
- First-bought Bomberman auto-equips. Switching equipped Bomberman is free.
- **Hardship discount**: when the player owns zero Bombermen and the
  cheapest non-purchased card in the current roster is unaffordable, that
  card is **rendered as FREE (price 0)** for this player. Implemented
  server-side, not a UI trick.

---

## 7. BOMBS SHOP

`src/server/BombsShopService.ts`. **Flat, always-available** — no carousel,
no tier rolls, no expiry.

- The catalog is `PURCHASABLE_BOMBS` from the bomb catalog (everything
  except the infinite Rock). Prices are taken straight from `BOMB_CATALOG`.
- Super bombs (`phosphorus`, `cluster_bomb`, `big_huge`) carry **both** a
  coin price and a treasure cost. The treasure must be in the player's
  persistent stash at purchase time.
- Buying a bomb increments `PlayerProfile.bombStockpile[type]`. Stockpile is
  unbounded.
- The second flow lets the player **equip** bombs from the stockpile into
  the currently equipped Bomberman's custom slots. Slot rules:
  - Slot is **empty**: filled with up to `min(stockpile, requestedQty,
    effectiveStackSize)`. Taken amount is removed from the stockpile.
  - Slot has **same type**: tops up to `effectiveStackSize`; partial top-up
    if the request exceeds available capacity.
  - Slot has **different type**: swap — old contents flow back to the
    stockpile, then the new contents fill the slot up to `effectiveStackSize`.
- All slot validation runs against **effective** stats (post-upgrade), not
  raw tier values.
- Validations are server-authoritative: invalid slot index, no equipped
  Bomberman, not in stockpile, treasure shortfall on super-bomb purchase, etc.

---

## 8. PER-BOMBERMAN UPGRADES (SP economy)

The current primary progression hook for individual characters. Each
OwnedBomberman accumulates **Skill Points** in-match and can spend them
(plus coins + treasures from the profile stash) on three permanent stat
upgrade tracks. Tuning lives in `BALANCE.upgrades` (`config/balance.ts`).

- **Server logic**: `src/server/BombermanUpgradeService.ts`
  (`applyUpgrade(profile, ownedId, track)` — atomic, re-validates all costs
  from the balance config, deducts SP from owned + coins + treasure from
  profile, bumps the per-track tier counter, saves).
- **Client UI**: `src/client/scenes/BombermanUpgradeScene.ts` — a modal popup
  scene launched on top of MainMenu / Results when the player taps the
  upgrade affordance. Shows current tier dots, next-tier cost (SP / coins /
  treasure), and an affordability-colored Buy button.
- **Display helpers**: `src/shared/utils/bomberman-stats.ts` —
  `effectiveMaxCustomSlots`, `effectiveStackSize`, `effectiveMaxHp`,
  `tiersRemaining`. Every UI surface that shows slot count, stack count, or
  HP must go through these.

### SP earning (in-match)

| Source                                          | SP   |
|-------------------------------------------------|-----:|
| Chest open (auto-loot, first time only per chest)|    5 |
| Confirmed player-Bomberman kill (last hitter)   |   50 |
| Confirmed Scav kill (last hitter)               |   25 |
| Per N survival turns alive                      |  +1/5 turns |

A "decent" extraction ≈ 65 SP (2 chests + 1 player kill + 25 turns survived
= 10 + 50 + 5). SP is banked into the OwnedBomberman **only on escape**;
death wipes the match-earned SP.

### Upgrade tracks

| Track | maxTiers | Treasure | Hard cap         | Costs (sp / coins / treasure) per tier            |
|-------|---------:|----------|------------------|---------------------------------------------------|
| cap   |        2 | mushrooms| `totalSlotCap=8` (Rock + customs) | T1: 160 / 350 / 12  T2: 480 / 800 / 25 |
| stack |        3 | coffee   | (per-tier curve) | T1: 130 / 300 / 8   T2: 340 / 700 / 18   T3: 760 / 1500 / 38 |
| hp    |        1 | grapes   | `cap=3` HP       | T1: 980 / 2200 / 60                               |

Calibration target: cheapest tier ≈ 2 extractions, most expensive ≈ 15.
Cap+Stack add inventory slots / per-slot stack size respectively; HP raises
base HP from 2 → 3.

---

## 9. FACTORY (meta-progression idle loop)

A single room with **four machines** that convert treasures into bombs on a
**wall-clock timer** — they keep producing while you're offline. Bombs that
finish go into the machine's storage; the player visits to claim them into
their persistent stockpile (`PlayerProfile.bombStockpile`), which is the
same stockpile the Bombs Shop fills.

- Tuning: `src/shared/config/factories.ts` (`FACTORIES`)
- Persistent state: `PlayerProfile.factory` (per-machine queue + storage +
  wall-clock cursor)
- Server orchestration: `src/server/FactoryService.ts`
- Client UI: `src/client/scenes/FactoryScene.ts`

### The four machines

| # | Name           | Cycle | Cost (treasures per cycle)            | Bomb pool (weights)                                                            |
|--:|----------------|------:|---------------------------------------|--------------------------------------------------------------------------------|
| 1 | SPROKKET-5K    | 5 min | 25 mushrooms                          | bomb 10, delay_tricky 10, ender_pearl 5, flare 10                              |
| 2 | KLANGWERKS-88  |10 min | 10 coffee + 25 mushrooms              | bomb_wide 10, flash 10, motion_detector_flare 10, shield 5                     |
| 3 | GLOMBULATOR    |20 min | 10 grapes + 15 coffee                 | bomb_wide 5, banana 10, fart_escape 10, cluster_bomb 5, shield 5               |
| 4 | DETONATORIUM   |30 min | 8 lanterns + 15 grapes + 50 mushrooms | contact 10, molotov 10, phosphorus 10, big_huge 10 (premium / "super" pool)    |

### Flow

1. Player opens a machine pop-up and presses **BUY** to queue **N cycles**.
   Treasure cost is paid **up-front** (N × cost), so a 3-cycle queue costs
   3× the listed cost. There is no refund for cancelling.
2. Each cycle ticks down by wall-clock ms. When `cycleDurationMs` elapses,
   the system rolls a bomb from `bombWeights` and pushes it into the
   machine's **storage**.
3. The player visits and presses **TAKE ALL** to move storage →
   `PlayerProfile.bombStockpile`.

The Main Menu and Results screen show a **red badge** on the Factory button
summing total bombs-claimable across all machines (polls every 5s).

---

## 10. KEYS & ESCAPE HATCHES (in-match)

Added in the NEW_META reset (full spec: `docs/keys-system.md`). The escape
hatch is no longer a free exit — it is **gated by carrying enough keys**.

- **15 keys** spawn per match (`BALANCE.keys.totalOnMap`), distributed
  across chests by each tier's `keyWeight`. Keys are no longer scattered
  loose on the floor — they only come out of chests.
- **3 keys** are required to use an escape hatch
  (`BALANCE.keys.requiredPerHatch`). The carry cap **always equals**
  `requiredPerHatch`.
- **Tutorial mode** uses `tutorialRequiredPerHatch=1` (single-key gate so the
  scripted beat completes quickly).
- Auto-collected on chest-open up to the carry cap.
- Killed Bombermen leave their keys on the body. Walking onto a corpse
  auto-transfers keys up to the cap.
- On escape, the keys are consumed (set to 0) AND the hatch becomes
  **broken**. Broken hatches cannot be used again this match — anyone
  standing on one sees a red HUD warning.
- Keys are **match-scoped**: not persisted to `PlayerProfile`, reset every
  match.
- Bots and Scavs path to keys (via chests) when short and only target the
  hatch once carrying enough.

### Hatch randomization (May 26)

Each map declares a candidate pool of `escapeTiles[]` positions.
`BALANCE.escapeHatches.count = 5` hatches per match are picked at random
from that pool via seeded shuffle. If the map declares fewer candidates
than `count`, every candidate becomes a hatch. Hatches render on a new
under-sprite layer (below Bombermen) for visual readability.

### HUD priority order on the keys/hatch widget

1. **Broken hatch** warning (red) — overrides everything else.
2. **Need keys** warning (red, pulsating) when standing on a hatch with too
   few keys.
3. **Keys at cap** indicator (green, steady) when ready to escape.
4. **Default** (yellow) — just a key count, e.g. `1/3`.

---

## 11. SCREENS — what the player sees

This section catalogs every visible screen and the function of every element
on it. Use it for UX/visual design discussions without needing to read scene
code. Screens are listed in the order a new player encounters them.

> **Scene boot order** (`src/client/main.ts:27`): registered scenes are
> Boot → MainMenu → Lobby → BombermanShop → BombsShop → **Factory** →
> Match → Results → TutorialOverlay → Tooltip → **BombermanUpgrade**.
> `BombermanUpgradeScene`, `TutorialOverlayScene`, and `TooltipScene` run
> **in parallel** to other scenes (popup/overlay layers), not as
> standalone screens. `GamblerStreetScene` is imported-but-commented-out;
> its files remain in the tree but it is not registered or reachable.

### 11.1 BootScene — splash / preload

**Purpose:** asset preloader and the only screen where the player can
confirm "the game loaded." One click leads into the hub.

| Element | What it does |
|---------|--------------|
| `BOMBERMAN` title (large monospace, white) | Branding only |
| `Turn-based PvP Arena` subtitle (dim gray) | Tagline only |
| `[START]` button (centered) | Click → MainMenuScene. Hovers brighter. |

**Entry/Exit:** game launch → MainMenu. No back navigation.

### 11.2 MainMenuScene — hub

**Purpose:** the player's home base. From here you can play, browse shops,
visit the Factory, run the tutorial, see your profile at a glance, and
launch the upgrade popup for the currently equipped Bomberman.

| Element | What it does |
|---------|--------------|
| `BOMBERMAN` header + `Main Menu` subtitle | Branding |
| **Coins display** (top-center, gold) | Shows `PlayerProfile.coins`. Live-updates from ProfileStore. |
| **Treasures widget** (top-right) | `TreasureListWidget` — icon + count rows for every treasure type with `> 0`. Pulses on increment. |
| **Equipped Bomberman preview** (center) | Animated sprite of the currently equipped character, with name, effective slot/stack/HP badges, and current SP. |
| **Upgrade pip** (on the preview, when affordable) | Pulsing dot indicating ≥1 affordable upgrade. Clicking the preview opens `BombermanUpgradeScene`. |
| `[PLAY]` button | → LobbyScene. |
| `[BOMBERMAN SHOP]` button | → BombermanShopScene. |
| `[BOMBS SHOP]` button | → BombsShopScene. |
| `[FACTORY]` button | → FactoryScene. |
| **Factory badge** (red dot on the Factory button) | Total bombs ready to claim across all 4 machines. Refreshes every 5s. Hidden when zero. |
| `[TUTORIAL]` button (bottom of menu) | → MatchScene in **offline tutorial mode** (uses `TutorialMatchBackend`). |
| **Connection status** (bottom-center, small) | Socket id / "Disconnected" with color feedback. |
| `[DEBUG: RESET PROFILE]` (bottom-center, small red) | **Dev only.** Wipes profile on the server; shows a "Resetting…" toast then success/error. |

### 11.3 LobbyScene — match carousel

**Purpose:** browse joinable matches, see how full they are and when they
auto-start, and equip a Bomberman before joining.

| Element | What it does |
|---------|--------------|
| `LOBBY` header + `Choose a match` subtitle | Branding |
| **No-Bomberman warning** (top-center, conditional) | "⚠ No Bomberman equipped — visit the shop first." Hidden once one is equipped. |
| **Match cards** (horizontal row) | One card per scheduled/active match. Each card shows match id, player count (e.g. `3/4`), auto-start countdown (`mm:ss`), and tier badge. Cards roll in from the right on listing add, animate up + fade on remove. |
| `[JOIN]` button (per card, not-joined state) | Server-side join request. On success the card flips to the joined state. |
| `[JOINED]` label + `[UNJOIN]` button (joined state) | Static "joined" label plus a red unjoin button. |
| **Bomberman selector** (bottom-center) | `BombermanSelector` widget — carousel of owned Bombermen. Click a card to equip it. Hover shows the `TierInfoBadge` (effective HP, slots, stack, perk). Cards display **effective** counts, not base. |
| `[< MENU]` (bottom-left) + Esc | Leaves any joined match and returns to MainMenuScene. |
| **Connection status** (bottom-center) | Socket connection state. |

**Notable state:** reacts to `match_listings` socket events (pushed ~every
second); transitions to MatchScene on `match_start`.

### 11.4 BombermanShopScene — character carousel

**Purpose:** spend coins on new characters from a rotating roster. Per-player
2-minute cycle. Each cycle has 5 cards (2 free + 2 paid + 1 paid_expensive).

| Element | What it does |
|---------|--------------|
| `BOMBERMAN SHOP` header | Branding |
| **Coins counter** (top-right, gold) | `PlayerProfile.coins`. |
| **Roster counter** (top-left, dim) | `N/5` owned (cap is 5). |
| **Cycle timer** (top-center, dim) | Counts down to next cycle. On 0, requests the next cycle and re-animates the row. |
| **Card carousel** (center, 5 cards) | Per card: portrait, name, tier badge, full inventory icons, slot/stack stats, formula-driven price + `[BUY]` button (gold if affordable, gray if not). Cards roll in from the right on cycle start; fly off right on purchase or expiry. |
| **Hardship discount** (per-card, conditional) | If the player owns **zero** Bombermen and the cheapest non-purchased card is unaffordable, that card is **rendered as `FREE`** (price 0) for this player. Server-side. |
| **Bomberman selector** (bottom-center) | Same widget as in Lobby — always shows your roster so you can equip what you just bought. |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |
| **Toast** (center-bottom, transient) | "Purchased!" / error reasons, auto-clear ~2.5s. |

**Notable state:** each player has their own cycle persisted on
`profile.bombermanShop`. `shop_cycle` broadcasts on regeneration so the row
updates live.

### 11.5 BombsShopScene — bomb vendor + equip

**Purpose:** buy individual bombs with coins (and treasures for super bombs),
then equip them into the currently equipped Bomberman's custom slots.

| Element | What it does |
|---------|--------------|
| `BOMBS SHOP` header | Branding |
| **Coins + treasures** (top-right) | `PlayerProfile.coins` + the `TreasureListWidget` so super-bomb treasure costs are visible. |
| **Catalog column** (left) | Vertical list of every `PURCHASABLE_BOMBS` entry: icon, name, short description, price (coin + optional treasure cost icon), `[BUY]` button. Buy increments `bombStockpile[type]`. |
| **Stockpile column** (middle) | Bombs the player owns (count > 0). Click an entry to **select** it (highlight). "(empty — buy some bombs)" placeholder. |
| **Equipped column** (right) | Current Bomberman's slot row. **Slot 0 = infinite Rock** (locked, ∞). Slots 1..`effectiveMaxCustomSlots` are custom. Click an empty slot to equip the selected stockpile bomb. Click an occupied slot of a different type to swap (old contents flow back to stockpile). The visible slot count and per-slot stack cap respect applied upgrades. |
| **Bomberman selector** (bottom-center) | Switch equipped Bomberman; the Equipped column re-renders for the new one. |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |
| **Toast** (center-bottom, transient) | Purchase/equip outcome, auto-clear ~2s. |

### 11.6 FactoryScene — meta-progression room

**Purpose:** the idle income loop. Four machines convert treasures into bombs
over real wall-clock time.

| Element | What it does |
|---------|--------------|
| **Factory background** (full-screen, cover-scaled) | `factory_bg.png` scaled to cover the viewport. Title/back-button use a stroke + depth=100 so they stay legible over the BG. |
| **Machine overlay (idle)** | Neutral highlight on each of the 4 machine areas of the background. |
| **Machine overlay (working)** | Animated overlay shown while a cycle is in progress. |
| **Status panel** (anchored ~40px above each machine, conditional) | Shows for any machine with an active queue **or** waiting storage. Contains: treasures-spent-so-far icons + counts, progress bar (0–100%), target bomb icon, and a **red corner badge** with the storage count when bombs are waiting. |
| **Shortcut widget** (smaller variant, conditional) | When storage > 0 but no cycle is active, shows a compact "N bombs ready" notification instead of a full panel. |
| **Treasure widget** (top-right) | Always-visible `TreasureListWidget` so the player can see what they have to spend without leaving the screen. |
| **Machine pop-up** (modal, opens on machine click) | Three sections — top-anchored, with a stable container reference (does not re-create per frame): **Commission** (cost breakdown + cycle duration + `[BUY 1]` / `[BUY N]` buttons, the Commission button is light-yellow), **Queue** (active cycle progress + time remaining + queued cycles count), **Storage** (grid of finished bomb icons + counts + `[TAKE ALL]`). `[X]` close button (top-right). |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |

**Notable state:** server-authoritative (cycle progress derived from
wall-clock ms stored in `PlayerProfile.factory`). Client predicts the
progress bar locally for smoothness; next server update is authoritative.

### 11.7 MatchScene — the actual game

**Purpose:** real-time turn-based arena gameplay. The designer-relevant
elements are the HUD, the world overlays, and the loot UI.

**Top HUD (pinned at top):**

| Element | What it does |
|---------|--------------|
| **Phase indicator** (top-left) | `YOUR TURN` (green) / `RESOLVING…` (yellow) / `MATCH OVER` (red). |
| **Turn timer** (left-center, large bold) | Counts down current input phase in 0.1s steps. |
| **Turn counter** (top-center) | `Turn N / 250`. Warning color when few turns remain. |
| **UAV warning** (center, conditional) | `✈ UAV: 18` (turn it fires). Pulsates when 3 turns away. A 3s center-screen banner reads `UAV is Revealing the whole area` when it fires. |
| **Broken-hatch warning** (top-center, conditional, red) | `This Hatch is Broken, you won't be able to Escape from it`. Overrides the keys warning when both apply. |
| **Coins counter** (top-right) | In-match coins picked from chests. Format: gold circle + `x42`. |
| **Keys widget** (top-right, below coins) | Small key icon + `N/3`. Color states per §10's priority order — broken (red) > need-keys (red pulse) > at-cap (green) > default (yellow). Hatch tiles near you also show small `N/3` badges. |
| **HP display** (top-right, below keys) | `HP N/maxHp` where `maxHp` is the Bomberman's effective max (2 or 3 with HP upgrade). 1-frame delay vs. the sprite so the pip animation reads smoothly. |
| **Treasures column** (top-right, stacked) | `TreasureListWidget` — persistent stash icons + counts. Pulses on pickup. |

**Bottom HUD (pinned at bottom):**

| Element | What it does |
|---------|--------------|
| **Bomb slot tray** (center, dynamic count, 56×56 each, 8px gaps, dark rounded rect bg) | Slot 0 = infinite Rock (∞). Slots 1..effectiveMaxCustomSlots = equipped bombs with `xN` counts. Each slot has a `1`–`N` keyboard badge bottom-left. Click selects (red border); click a map tile to use/throw. |
| **Stun overlay** (over the tray, conditional) | Grayed rect + `STUNNED` banner; blocks slot clicks. |
| **Melee trap icon** (left of tray, conditional) | Small sword icon when in melee-trap (crouching) mode. |

**Loot panel (above the bomb tray, conditional):**

| Element | What it does |
|---------|--------------|
| `LOOTING` header (green) | Shown when standing on a tile with chest/body loot. |
| **Per-source rows** | Chest row (`CHEST (TIER N)`) and/or body row (`BODY LOOT`). Each row shows bomb icons + counts scaled to the source's slot count. Click a slot to swap with your selected stockpile bomb. |
| **Stash row** (smallest, optional) | Echoes your current custom slots so you can see what you're swapping out. |

**World overlays (drawn into the world, not the HUD):**

| Element | What it does |
|---------|--------------|
| **Fog of war** | Semi-transparent dark overlay outside line-of-sight (radius 5). Walls adjacent to visible tiles are also visible (May 26 fix). Doors under lesser fog also visible. |
| **Flare light** | Blue light radius from active flare bombs. |
| **Walk-target circle** (blue) | Hovered destination tile in movement mode. |
| **Throw-target X** (red) | Targeted tile in throw-aim mode. |
| **Lock badges on hatches** | Small `N/3` over hatch tiles within sight. |
| **Chest/door/hatch interactives** | Click to walk-and-interact (resolver handles approach + use). Hatches render on a dedicated under-sprite layer. |
| **Bomberman sprites** | Animated characters with HP pips, status icons (stunned, bleeding), and pop-up damage numbers. Each sprite shows its name. |
| **Dropped bodies** | Corpse sprites with a small loot indicator if they hold anything. |
| **Active bombs / explosions / smoke / mines** | Visualized by `BombRenderer` per `BOMB_CATALOG` shape. |

**Notable state:** `MatchScene` talks only to a `MatchBackend` interface, so
all of the above renders identically whether the source is a real socket
match (`SocketMatchBackend`) or an offline scripted tutorial
(`TutorialMatchBackend`).

### 11.8 ResultsScene — post-match recap

**Purpose:** show what happened and route the player to their next meta
action (Lobby for another match, or a shop/Factory to spend/claim/upgrade).

| Element | What it does |
|---------|--------------|
| **Outcome title** (large, top) | `ESCAPED` (green) / `DIED` (red) / `LOST` (red, ran out of turn limit). |
| **SP hero block** (center, animated) | Bomberman name above the animated sprite. On escape: `+N SP` counts up with the sprite reacting, then a **reaction tier label** (`Bad` / `Not Bad` / `Nice` / `Excellent`) fades in below the SP number based on SP earned. On death: `R.I.P.` text under the sprite and `Killed by [killer]` (or "in action"). Uses an SP-delta fallback (`currentOwned.sp − mySpAtStart`) when the server's `spEarned[playerId]` is missing or 0. |
| **Treasures Gathered** (escape only) | Horizontal row of icons + counts gained this match. |
| **Items Kept** (escape only) | Bomb icons + counts from the loadout carried out. |
| **Kill count** (escape only) | `Bombermen eliminated: N` if > 0. |
| **Turns survived** (always, dim) | `Turns survived: N`. |
| `[UPGRADE]` (when ≥1 upgrade affordable) | Opens `BombermanUpgradeScene` on top of Results. Pip indicator pulses while available. |
| `[BACK TO LOBBY]` (primary) | → LobbyScene. |
| `[FACTORY]` (shortcut, small) | → FactoryScene. Shows the same claim-count badge as the main menu. |
| `[BOMBS SHOP]` (shortcut, small) | → BombsShopScene. |

### 11.9 BombermanUpgradeScene — upgrade popup

**Purpose:** modal popup launched on top of MainMenu or Results when the
player chooses to spend SP on the equipped Bomberman.

| Element | What it does |
|---------|--------------|
| **Backdrop** (full-screen dim, click-to-close on dead zones) | Dims the scene behind it; popup is centered. |
| **Sprite + name** (top of popup) | The Bomberman being upgraded. |
| **Tier dots** (per track) | Small filled/empty dots showing applied tiers / total available tiers per track. |
| **Three upgrade rows** (CAP / STACK / HP) | Each row shows: track icon, current effective stat (e.g. `5 → 6`), next-tier cost in SP (blue if affordable, red if not), coins (yellow if affordable, red if not) with the `c` suffix always yellow, and the track's treasure cost (white if affordable, red if not). Buy button on the right. |
| **`[X]` close button** | Closes the popup, returns to the underlying scene. |

**Notable state:** server-authoritative. Each `[BUY]` press posts `shop_upgrade`
to the server, which re-validates against `BALANCE.upgrades` and pushes a
fresh profile on success.

### 11.10 TutorialOverlayScene — scripted-tutorial overlay

**Purpose:** parallel overlay on top of MatchScene only in tutorial mode.
Renders dialogue, pause screens, input blocking, and highlight reticles for
beats driven by `TutorialDirector`.

| Element | What it does |
|---------|--------------|
| **Dialogue panel** (bottom-right, 420×160) | Dark rect + blue stroke. Left: 128×128 portrait. Right: text (~200 chars wrapped). Footer: `Click to Continue` (italic blue). Click to advance. |
| **Pause screen** (full-screen) | Dim overlay + centered message + `Click to Continue`. Click/Esc resumes. |
| **HUD highlights** (pulsing, screen-space) | Orange/blue pulsing box around UI elements (e.g. bomb slot 1, treasure widget). |
| **World highlights** (pulsing, world-space) | Circle (walk target), `X` (throw target), or box (region), transformed through the main camera. |
| **Flash hint** (red, transient) | Brief red rect on wrong input. Fades in ~0.3s. |
| **Input blocker** (transparent full-screen) | Intercepts clicks while dialogue or pause is open so the player can't accidentally trigger gameplay. |

**Notable state:** scene runs in parallel to MatchScene; lifecycle is tied to
the tutorial backend.

### 11.11 TooltipScene — global hover tooltip

**Purpose:** floating context tooltip that follows the cursor and is shared
across all scenes.

| Element | What it does |
|---------|--------------|
| **Floating box** (dark bg, accent border, autosizes) | Shows the contextual blurb for the hovered element. Repositions to stay on-screen and avoid the cursor. |
| **HUD tooltips** | Bomb name + description; key cost; treasure type label. |
| **Map tooltips** | "Walk here"; "Chest — bombs inside (Tier N)"; "Escape hatch — need 3 keys"; "Broken hatch — you cannot escape from here"; "UAV fires in N turns". |
| **Suppression** | Hidden during tutorial dialogue/pause, throw-aim mode, and any full-screen overlay (including the upgrade popup). |

---

## 12. Where things live (cheat sheet)

```
src/shared/config/
  bombs.ts             # BOMB_CATALOG (16 types), PURCHASABLE_BOMBS, phosphorus pattern
  balance.ts           # all global tuning (HP, fuse, rush, keys, hatches, upgrades, scavs)
  chests.ts            # 3 tiers, coin/treasure/key tables, CHEST_SPAWN_TABLE (14/3/1)
  bomberman-tiers.ts   # free / paid / paid_expensive (4/5/6 slots, stack 6-7/8-9/10-12)
  bomberman-names.ts   # name pools per tier
  treasures.ts         # 10 types defined; only 4 active in chest rolls (post-NEW_META)
  factories.ts         # FACTORIES — the 4 Factory machines, costs, cycles, pools
  gambler-street.ts    # SHELVED — file preserved, not imported anywhere

src/shared/systems/
  TurnResolver.ts      # PURE 11-step turn resolution
  BombResolver.ts      # bomb shape geometry / raycast
  LineOfSight.ts       # tile LoS with wall blocking (adjacent-wall rule)
  Pathfinding.ts       # bot pathfinding
  GamblerStreetEngine.ts  # SHELVED — preserved, not imported

src/shared/utils/
  bomberman-stats.ts   # effectiveMaxCustomSlots/effectiveStackSize/effectiveMaxHp + tiersRemaining
  loot-roll.ts         # weighted unique-pick + largest-remainder distribution
  seeded-random.ts     # deterministic RNG for tutorials/tests

src/server/
  GameServer.ts                # socket event map, owns scheduler+rooms+services
  MatchScheduler.ts            # lobby carousel of joinable matches
  MatchRoom.ts                 # one per active match; runs resolveTurn each turn
  BombermanShopService.ts      # 2-min cycle, 5-card carousel, buy/equip, hardship discount
  BombsShopService.ts          # flat catalog, stockpile, equip-to-slot (effective stats aware)
  BombermanUpgradeService.ts   # SP/coin/treasure-gated per-track upgrade transactions
  FactoryService.ts            # Factory orchestration — queue, tick, claim, persist
  GamblerStreetService.ts      # SHELVED — not wired to GameServer anymore
  BotPlayer.ts                 # bot AI as a behaviour tree (see docs/bot-behavior.md)
  ScavPlayer.ts                # Scav NPC AI — second brain, hard-capped at 2 alive
  PlayerStore.ts               # JSON file persistence for PlayerProfile (defensive normalize on save)

src/client/
  scenes/                      # Boot, MainMenu, Lobby,
                               # BombermanShop, BombsShop, Factory, Match, Results,
                               # TutorialOverlay, Tooltip, BombermanUpgrade
                               # (GamblerStreetScene exists but is unregistered)
  systems/                     # MapRenderer, BombRenderer, FogRenderer,
                               # ShieldRenderer, BombermanSpriteSystem,
                               # BombermanAnimations, ActivityIndicator,
                               # TreasureListWidget, TierInfoBadge,
                               # BombermanSelector, BombIcons, TreasureIcons, etc.
  backends/                    # MatchBackend interface + Socket / Tutorial impls
  tutorial/                    # scripted tutorial — TutorialDirector + script

tests/                         # Vitest. Highlights:
                               # BombResolver, LineOfSight, Pathfinding,
                               # bomberman-upgrade, sp-earning,
                               # escape-hatch, keys, uav, scav, shield-bomb,
                               # loot-roll, treasure-roll, factory,
                               # gambler-street-engine/rewards (kept while shelved)
```

---

## 13. Conventions worth knowing before reading code

- **`.ts` import extensions are required everywhere** (ESM + tsx).
- **Path aliases**: `@shared/*`, `@client/*` in client code. Inside `src/shared/`
  use **relative imports** because `tsx` runs the server directly.
- **Server-authoritative**: never put gameplay decisions in client code, except
  inside `TutorialMatchBackend`.
- **Effective stats over raw**: never read `owned.maxCustomSlots` / `stackSize`
  / base HP directly when displaying or validating. Always go through
  `effectiveMaxCustomSlots(owned)` / `effectiveStackSize(owned)` /
  `effectiveMaxHp(owned)`. Multiple cap-display bugs have come from skipping
  this.
- **Derive, don't store**: if something can be computed from `MatchState`,
  compute it.
- **Seeded RNG** for any in-match randomness so tutorials and tests are
  reproducible (`src/shared/utils/seeded-random.ts`).
- **No game engine** — Phaser 3 only. Ignore any Godot/Unity/Unreal references
  in sub-docs; they're inherited from a generic template.
