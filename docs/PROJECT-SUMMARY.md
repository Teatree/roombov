# Roombov — Project Summary

A turn-based PvP Bomberman-style browser game with a roguelike loot/extraction
economy. This document is a self-contained context handoff — share it with
another Claude instance (Desktop, web, etc.) so it can reason about the project
without reading the codebase.

Last reviewed against source: 2026-05-23. Major changes since May 4: the
**NEW_META reset** (`docs/NEW_META.md`) shipped between May 16-17, which
shelved Gambler Street, added the **Factory** meta-progression subsystem, added
**Keys** (escape gate), and put coins into chests so they're earned in-match.
Per-tier shop pricing was overhauled. May 21 added a hard cap of 2 concurrent
**Scav** NPCs (a second AI brain alongside the bot) and a hardship discount on
the Bomberman Shop.

---

## 1. The game in one paragraph

Up to 4 players (real + bots) drop into a top-down dungeon arena. Combat is
**turn-based** with a fixed input phase, then a deterministic resolution phase.
Players carry a small loadout of bombs (each with distinct shapes, fuses, and
side-effects), search the map for **chests** holding more bombs and
**treasures**, and try to **escape through a door** before the turn limit. The
treasures escaped with persist into a profile-level stash. Coins are a separate
soft currency earned outside matches, primarily by **gambling treasures** at
Gambler Street. Coins are spent at two shops to acquire characters and bombs.

The result is a three-loop economy:

```
   ┌──────────────────────────────────────────────────────────┐
   │                       MATCH LOOP                          │
   │  spawn → loot chests → fight → escape (or die)           │
   │                                                          │
   │  on escape: + treasures (persistent)                      │
   │  on death:  - all carried bombs, - 50% treasures (TBD)    │
   └────────────┬─────────────────────────────────────────────┘
                │
   ┌────────────┴──────────────┐    ┌──────────────────────────┐
   │  GAMBLER STREET (meta)    │    │   BOMBS SHOP (meta)       │
   │  spend treasures → coins  │    │   spend coins → bombs    │
   └────────────┬──────────────┘    └──────────────┬───────────┘
                │                                  │
                └──────────┬───────────────────────┘
                           ▼
                 ┌─────────────────────┐
                 │  BOMBERMAN SHOP     │
                 │  spend coins → new  │
                 │  characters & their │
                 │  starting loadouts  │
                 └─────────────────────┘
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
client (in tutorial mode, where there is no real server). It applies an 11-step
resolution order each turn (movement → interactions → bomb placement → fuse
tick → explosions → fire damage → fire/light aging → bleeding → deaths →
escapes → end-check). Everything derivable from `MatchState` should be derived,
not stored.

---

## 3. The match itself (briefly)

- **Map**: 32×32 tiles. Authored in Tiled, exported to JSON, includes a
  required `Collision` layer.
- **Turn**: fixed input phase (~2s), then resolution; players queue an action
  (move, throw bomb, interact). Server is authoritative.
- **Movement**: 1 tile/turn normally. **Out-of-Combat Rush** (2 tiles/turn)
  triggers after 3 peaceful turns when no enemy is within 8 tiles + mutual
  line-of-sight, and no placed bomb is within 8 tiles (bombs break rush
  through walls — they're loud).
- **HP**: 2 max. Each bomb deals at most 1 damage per Bomberman per trigger;
  damage is capped per resolution set. Bleeding lasts 10 turns.
- **Fog of war**: per-player line-of-sight, radius 5 tiles.
- **Win condition**: escape through the exit door, OR be the last alive when
  the turn limit (250) hits.
- **Loot**: chests scatter across the map at Tier 1 / Tier 2 zones. Killed
  Bombermen drop a body that can be looted by anyone.

The match's "currency" is **treasures** — coins are not earned in-match.

---

## 4. BOMBS — the catalog

Every bomb is data-driven from `src/shared/config/bombs.ts` (`BOMB_CATALOG`).
Bomb behaviors are tagged: `explode`, `fire`, `light`, `smoke`, `place_mine`,
`stun_explode`, `phosphorus_seed`, `cluster_seed`, `scatter`, `teleport`,
`shield_wall`. Tuning constants live in `src/shared/config/balance.ts`.

| Bomb                  | Fuse | Pattern                       | Effect                                    | Price |
|-----------------------|------|-------------------------------|-------------------------------------------|------:|
| Rock                  | 0    | single tile                   | Infinite fallback, 1 dmg target only      | 0     |
| Bomb                  | 1    | + radius 4                    | Standard blast                            | 25    |
| Wide Bomb             | 2    | circle radius 2 (raycast)     | 5×5, walls block                          | 60    |
| Delay Tricky          | 1    | diag radius 3                 | X-shape blast                             | 50    |
| Contact               | 0    | + radius 1                    | Detonates on impact                       | 100   |
| Banana                | 1    | scatters 4 children diagonally| Each child = + r1 a turn later            | 75    |
| Flare                 | 0    | circle r4 light, 3 turns      | Reveals area, no damage, doesn't break Rush | 25  |
| Molotov               | 0    | + r1 fire, 2 turns            | Fire ticks each turn                      | 150   |
| Ender Pearl           | 0    | self-teleport                 | Lands → you teleport in. Doesn't break Rush | 100 |
| Fart Escape           | 0    | move 2 + smoke r5, 4 turns    | Escape move + smoke screen                | 1     |
| Motion Detector Flare | 0    | proximity mine, r3            | Fires a flare when enemy enters range     | 1     |
| Flash                 | 1    | circle r3 (7×7) stun          | Stuns caught Bombermen 1 turn             | 1     |
| Phosphorus            | 0    | reveal r5, then scattered fire| **Super bomb** — 11×11 reveal then burn   | 1     |
| Cluster Bomb          | 0    | scatters 25 mines in 11×11    | **Super bomb** — touch mines              | 1     |
| Big Huge              | 2    | circle r5 raycast (11×11)     | **Super bomb** — massive blast            | 1     |
| Shield Bomb           | 0    | + r1 wall, 3 turns            | Wall blocks movement & explosions, pushes occupants out without damage | 1 |

Notes:

- "Super bombs" (Phosphorus, Cluster, Big Huge) are powerful and rare in chest
  loot; each shows up at weight 15 in Tier 2 chests vs the standard 100.
- Walls + LoS interact with each bomb shape via `BombResolver` (raycast vs.
  geometric pattern depending on shape kind).
- Status effects: Stunned (Flash), Bleeding (any explosion that didn't kill).
- The Shield Bomb (latest addition) acts before push resolution, extinguishes
  fire under it, suppresses phosphorus, holds mines dormant; full spec lives
  in `design/bomb-reference.md` §11.

---

## 5. TREASURES (in-match currency)

Defined in `src/shared/config/treasures.ts`. There are exactly **10 types**,
mapped 1:1 to a 5×2 sprite sheet:

```
fish, chalice, jade,    books,    coffee
grapes, lanterns, bones, mushrooms, amulets
```

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
  count across them in proportion to weights. Tiers (`config/chests.ts`):
  - **Tier 1 chest**: 25 treasures, 3 unique types, uniform weights, also
    contains 5 bombs across 1–2 unique slots.
  - **Tier 2 chest**: 75 treasures, 5 unique types, uniform weights, also
    contains 8 bombs across 2–3 unique slots, plus access to all super bombs
    and shield.
- **Dead bodies**: when a Bomberman dies their carried treasures stay on the
  body and can be looted.

### Where treasures go

- On **escape**, all carried treasures merge into `PlayerProfile.treasures`.
  This is the only way to bank them — die and they stay on the corpse.
- **Spent at Gambler Street** (only sink — see §7).
- **Display surfaces**: `TreasureListWidget` shows the persistent stash on
  MainMenu, the in-match HUD top-right, the Results screen, and Gambler Street.

Treasures explicitly replaced the older "in-match coins" model. Coins are now
a separate, slower meta currency earned at Gambler Street.

---

## 6. BOMBERMEN (characters) and the BOMBERMAN SHOP

A "Bomberman" is a **character skin + starting bomb inventory**. Two shapes:

- `BombermanTemplate` — generated, sits in the shop carousel until bought.
- `OwnedBomberman` — what the player owns; cloned from the template at purchase
  with stable id + purchase timestamp.

A Bomberman has:

- `name` — rolled from per-tier name lists
- `tier` — `'free' | 'paid' | 'paid_expensive'`
- `price` — 0 for free, 100–200 for paid, 250–300 for paid_expensive (rounded
  to nearest 5)
- `colors` — random RGB triple `{ shirt, pants, hair }` used by the shop card
  procedural illustration
- `tint` — single 24-bit RGB used in-match via Phaser `setTint` (vivid pastel
  range — high saturation 0.55–0.85, high lightness 0.62–0.8 — to pop on the
  dark dungeon floor)
- `character` — sprite-sheet variant `char1`–`char7` (animation set)
- `inventory` — 5 custom slots (`INVENTORY_SLOT_COUNT = 5`) each holding a
  `{ type, count }` pair; per-slot stack limit is 5 (`bombSlotStackLimit`).
  An infinite Rock is granted as a fixed slot at match time on top of these.

### The Bomberman Shop (`src/server/BombermanShopService.ts`)

- The shop runs on a **rotating 2-minute cycle** (`SHOP_CYCLE_DURATION_MS`).
- Each cycle has a fixed composition: **2 free + 2 paid + 1 paid_expensive
  = 5 cards** (`SHOP_CYCLE_COMPOSITION`).
- Cycle generation is **lazy / on-demand**: any caller that asks for the
  current cycle past `endsAt` triggers a regeneration. A `shop_cycle` socket
  broadcast fires on regeneration so connected clients see the new roster live.
- Cards are seeded from a hash of the cycle id; same seed on the same wall
  clock would reproduce the same cards (useful for debugging).

### Tier rolls (`src/shared/config/bomberman-tiers.ts`)

Each tier specifies `totalBombs`, `maxUniqueSlots`, `priceRange`, and a
weighted bomb pool. Inventory is rolled with `rollBombLoot` — pick unique
types weighted, then distribute total across them by largest-remainder.

| Tier            | Slots used | Total bombs | Price    | Pool highlights                                           |
|-----------------|-----------:|------------:|---------:|-----------------------------------------------------------|
| free            | up to 3    | 10          | 0        | Standard bombs, flare, banana, fart_escape, ender, shield |
| paid            | up to 4    | 14          | 100–200  | + contact (10), molotov (10), motion detector (40)        |
| paid_expensive  | up to 4    | 16          | 250–300  | + super bombs (phosphorus/cluster/big_huge, weight 10)    |

### Purchase rules

- A roster cap of **5 owned Bombermen** (`BALANCE.player.ownedBombermenCap`).
- A profile cannot buy the same template twice within a cycle (dedup against
  `sourceTemplateId`). New cycle → new ids → can buy a "similar" one again.
- First-bought Bomberman auto-equips. Switching equipped Bomberman is free.
- The equip-Bomberman ID is the only "active loadout" — when a match starts,
  the server reads this, deep-clones the inventory, and projects it into the
  match's `BombermanState`.

---

## 7. BOMBS SHOP

`src/server/BombsShopService.ts`. **Flat, always-available** — no carousel,
no tier rolls, no expiry.

- The catalog is just `PURCHASABLE_BOMBS` from the bomb catalog (everything
  except the infinite Rock). Prices are taken straight from `BOMB_CATALOG`.
- Buying a bomb increments `PlayerProfile.bombStockpile[type]`. Stockpile is
  unbounded — buy as many as your coins allow.
- The second flow lets the player **equip** bombs from the stockpile into one
  of the 5 custom slots on their currently equipped Bomberman. Slot rules:
  - Slot is **empty**: filled with up to `min(stockpile, requestedQty, stackLimit=5)`.
    The taken amount is removed from the stockpile.
  - Slot has **same type**: tops up to stack limit; partial top-up if the
    request exceeds available capacity.
  - Slot has **different type**: swap — old contents flow back to the
    stockpile, then the new contents fill the slot up to stack limit.
- Validations are server-authoritative: invalid slot index, no equipped
  Bomberman, not in stockpile, etc.

Use cases: this is how a player tunes their loadout outside the random rolls
that the Bomberman Shop hands them. You can't change the *shape* of an equipped
Bomberman's slots (5 custom slots is fixed), but you can refill them with
whatever the stockpile allows.

---

## 8. GAMBLER STREET (SHELVED post-NEW_META §8)

> **Status (2026-05-23):** the Gambler Street scene is unregistered from the
> client (`main.ts` has the import commented out) and removed from the player
> flow. The engine/service/config files are preserved for possible revival but
> are not reachable in the current build. The Factory subsystem (§9) is the
> active meta loop in its place. The remaining text in this section is the
> archived spec from May 4 — useful if the system is ever revived.

This was the **primary coin sink-and-source** for the soft economy. The player
visits a "street" with **5 carousel slots** of NPC gamblers. Each gambler asks
for some quantity of one specific treasure type. The player can:

- Pay the **cheap bet** at the asked amount and a 50% win chance, OR
- Pay the **premium bet** at 2× the asked amount and a 75% win chance.

Win or lose, the treasure is consumed and the gambler leaves. On a win the
player gets a coin payout determined by a diminishing-returns curve. After
either outcome, the slot enters cooldown and a new gambler arrives later.

Sources:

- Tuning: `src/shared/config/gambler-street.ts`
- Pure engine: `src/shared/systems/GamblerStreetEngine.ts`
- Server orchestration: `src/server/GamblerStreetService.ts`
- Persistent state: `PlayerProfile.gamblerStreet` (per-profile, server-saved)
- Client UI: `GamblerStreetScene` + `GamblerStreetPopupScene` (the "Which hand?"
  reveal animation with confetti)

### State shape

```ts
type GamblerStreetState = {
  slots: GamblerSlot[];          // length === GAMBLER_STREET_GLOBAL.slotCount (5)
  lastTickedAt: number;          // unix ms (debug only, tick is idempotent)
  nextGamblerSerial: number;     // monotonic id minter
};

type GamblerSlot =
  | { kind: 'gambler'; gambler: Gambler }
  | { kind: 'cooldown'; readyAt: number };

type Gambler = {
  id: string;
  name: string;                  // e.g. "Lucía Reyes" — pool is mixed Spanish/Italian/English/German/French
  treasureType: TreasureType;
  treasureAmount: number;        // base (cheap-tier) ask; premium = ×2
  coinReward: number;            // payout on win, either tier
  createdAt: number;             // unix ms
  expiresAt: number;             // unix ms — leaves on its own here
};
```

All times are **wall-clock unix ms**, so the carousel keeps aging while the
player is offline. When they log back in, the engine ticks state forward to
`now`, expiring stale gamblers, advancing cooldowns, and minting fresh
gamblers as needed — same code path as a live tick.

### Global parameters (`GAMBLER_STREET_GLOBAL`)

| Field                          | Value                  | Notes                                                              |
|--------------------------------|------------------------|--------------------------------------------------------------------|
| `slotCount`                    | 5                      | Always 5 visible slots                                             |
| `lifespanRangeMs`              | 30–60 minutes          | A new gambler stays this long if no bet placed; bumped from brief's 3–5 min |
| `postBetCooldownMs`            | 2 minutes              | Empty slot after a bet (win or loss) before next gambler arrives   |
| `expiryCooldownMs`             | 10 seconds             | Shorter cooldown when a gambler leaves on their own (no bet)       |
| `betTiers.cheap`               | 1× cost, 50% win       |                                                                    |
| `betTiers.premium`             | 2× cost, 75% win       | Same coin payout as cheap                                           |
| `maxGamblersPerTreasureType`   | 2                      | Cap on simultaneous gamblers asking for the same treasure type      |

### How a gambler is generated

1. **Pick a treasure type** by weight (`weight` in `GAMBLER_TREASURE_TUNING`).
   Heavy-circulation treasures (fish, bones, coffee) are more likely;
   amulets are rarest (weight 40).
2. **Compute the ask amount** based on how much of that treasure the player
   already owns:
   - If owned `< amountPctThreshold`: ask = uniform random integer in
     `minAmountRange` (e.g. fish 20–100).
   - Otherwise: ask = `owned × uniformFloat(amountPctRange[0], amountPctRange[1])`
     (always 10%–30% of owned in current tuning).
   - Round the result to the nearest `roundAmountTo` (5 for bulk treasures,
     1 for rare ones), with a floor at the lower bound of `minAmountRange`.
3. **Compute the coin reward** via the diminishing-returns curve below.
4. Pick a name from the multilingual `GAMBLER_NAMES` pool.
5. Set `expiresAt = now + uniform(lifespanRangeMs)`.

The `maxGamblersPerTreasureType` cap is enforced during generation — if two
slots already ask for `fish`, no third fish gambler will be minted (the
weighted pick re-rolls until it lands on an under-cap type).

### The reward curve (`computeCoinReward`)

For each treasure type, the marginal rate `m(u)` (coins paid for the +1th
unit) is:

```
m(u) = startRatio                                      while u ≤ startUnits
m(u) = log-interpolated(startRatio → endRatio)         while startUnits < u ≤ curveMaxUnits
m(u) = endRatio                                        while u > curveMaxUnits
```

The total reward is the integral from 0 to `units`, computed in closed form
in the engine, rounded to the nearest whole coin.

The shape: small treasure piles pay full rate, then beyond a "soft cap"
the rate decays logarithmically toward an asymptotic floor. The intent is to
reward players for spending modest amounts often, and gently penalize hoarding
massive piles to dump on a single big bet.

#### Per-treasure tuning (current values)

| Treasure  | Weight | Min ask range | startRatio | endRatio | startUnits | curveMaxUnits | Notes                       |
|-----------|-------:|---------------|-----------:|---------:|-----------:|--------------:|-----------------------------|
| fish      |    100 | 20–100        | 0.10       | 0.02     | 200        | 1000          | Common bulk; 10:1 head, 50:1 tail |
| chalice   |     70 | 5–30          | 0.50       | 0.10     | 50         | 300           | Mid-rarity                  |
| jade      |     60 | 5–25          | 0.60       | 0.12     | 40         | 250           | Mid-rarity                  |
| books     |     80 | 10–50         | 0.25       | 0.05     | 100        | 500           |                             |
| coffee    |     90 | 15–70         | 0.18       | 0.04     | 150        | 700           |                             |
| grapes    |     85 | 15–60         | 0.20       | 0.04     | 120        | 600           |                             |
| lanterns  |     65 | 5–25          | 0.55       | 0.11     | 45         | 280           |                             |
| bones     |     95 | 20–80         | 0.12       | 0.025    | 180        | 900           |                             |
| mushrooms |     75 | 10–40         | 0.30       | 0.06     | 80         | 450           |                             |
| amulets   |     40 | 3–15          | 1.00       | 0.20     | 25         | 150           | Rarest; 1:1 head, 5:1 tail  |

Worked example for `fish` with `startUnits=200`, `curveMaxUnits=1000`:

| Hand-over (units) | Reward (coins) |
|------------------:|---------------:|
| 100               | ~10            |
| 200               | ~20            |
| 500               | ~42            |
| 1000              | ~60            |
| 2000              | ~80            |

### Bet resolution flow

1. Player picks a slot and a tier (cheap or premium).
2. Server validates the slot still holds the same gambler and the player has
   the required treasure (cheap=`treasureAmount`, premium=`treasureAmount × 2`).
3. Treasure is deducted **immediately**, before the roll.
4. RNG roll — `rng() < winChance` → won.
5. On win: `profile.coins += gambler.coinReward`. On loss: nothing more
   happens.
6. Slot transitions to `cooldown` with `readyAt = now + postBetCooldownMs (2 min)`.
7. The result is returned as a `BetOutcome`:
   - `won: boolean`
   - `treasureType`, `treasurePaid`, `coinsGained`
   - `correctHand: 'left' | 'right'` — derived from `playerPick + won` so the
     popup can render the "Which hand?" reveal: pick=left & won → left
     correct; pick=left & lost → right correct.

### Cooldown behaviour

There are two distinct cooldowns:

- **Post-bet cooldown** (2 min): after a player bets, the slot stays empty for
  2 minutes. The "social" beat — you can't immediately re-spin the same slot.
- **Expiry cooldown** (10 s): if a gambler leaves on their own (lifespan ran
  out without a bet), the slot only waits 10 seconds before a fresh one
  appears. This keeps the carousel feeling lively for casual visitors.

The engine's `tickGamblerStreet` is **idempotent** for a given `(state, now,
rng draws)` — calling it twice with the same `now` and the same RNG state
yields the same output. Tests pin RNG via `seeded-random.ts`; production uses
`Math.random`.

---

## 9. FACTORY (current meta loop)

The Factory replaces Gambler Street as the primary post-match destination.
It is a single room with **four machines** that convert treasures into bombs
on a **wall-clock timer** — they keep producing while you're offline. Bombs
that finish go into the machine's storage; the player visits to claim them
into their persistent stockpile (`PlayerProfile.bombStockpile`), which is the
same stockpile the Bombs Shop fills.

- Tuning: `src/shared/config/factories.ts` (`FACTORIES`)
- Persistent state: `PlayerProfile.factory` (per-machine queue + storage + wall-clock cursor)
- Server orchestration: `src/server/FactoryService.ts`
- Client UI: `src/client/scenes/FactoryScene.ts`

### The four machines

| # | Name           | Cycle | Cost (treasures per cycle)           | Bomb pool (weights)                                                            |
|--:|----------------|------:|--------------------------------------|--------------------------------------------------------------------------------|
| 1 | SPROKKET-5K    | 5 min | 25 mushrooms                         | bomb 10, delay_tricky 10, ender_pearl 5, flare 10                              |
| 2 | KLANGWERKS-88  |10 min | 10 coffee + 25 mushrooms             | bomb_wide 10, flash 10, motion_detector_flare 10, shield 5                     |
| 3 | GLOMBULATOR    |20 min | 10 grapes + 15 coffee                | bomb_wide 5, banana 10, fart_escape 10, cluster_bomb 5, shield 5               |
| 4 | DETONATORIUM   |30 min | 8 lanterns + 15 grapes + 50 mushrooms| contact 10, molotov 10, phosphorus 10, big_huge 10 (premium / "super" pool)    |

### Flow

1. Player opens the machine pop-up and presses **BUY** to queue **N cycles**.
   Treasure cost is paid **up-front** (N × cost), so a 3-cycle queue costs 3×
   the listed cost. There is no refund for cancelling.
2. Each cycle ticks down by wall-clock ms. When `cycleDurationMs` elapses,
   the system rolls a bomb from `bombWeights` and pushes it into the machine's
   **storage**.
3. The player visits the machine and presses **TAKE ALL** to move storage →
   `PlayerProfile.bombStockpile`. Same stockpile equipped from the Bombs Shop.

The Main Menu shows a **red badge** on the Factory button summing total
bombs-claimable across all machines (polls every 5s while the menu is open).
The Results screen shows the same badge on its Factory shortcut button.

---

## 10. KEYS & ESCAPE HATCHES (in-match)

Added in the NEW_META reset (full spec: `docs/keys-system.md`). The escape
hatch is no longer a free exit — it is **gated by carrying enough keys**.

- **15 keys** spawn on the map at match start (`BALANCE.keys.totalOnMap`).
- **3 keys** are required to use an escape hatch (`BALANCE.keys.requiredPerHatch`).
- The carry cap is **always equal** to the door cost — one knob drives both.
- Keys lie on the floor; walking onto a key tile picks it up (including any
  tile traversed during a 2-tile Rush move).
- Killed Bombermen leave their keys on the body. Walking onto a corpse
  auto-transfers keys up to the carry cap.
- On escape, the keys are consumed (set to 0) AND the hatch becomes
  **broken** (existing rule from `escape-hatch-rework.md`). Broken hatches
  cannot be used again this match — anyone standing on one sees a red HUD
  warning.
- Keys are **match-scoped**: not persisted to `PlayerProfile`, reset every match.
- Tutorial maps **bypass the key gate** (`state.isTutorial === true`).
- Bots and Scavs path to keys when they don't have enough, and only target
  the hatch once carrying enough.

### HUD priority order on the keys/hatch widget

1. **Broken hatch** warning (red) — overrides everything else.
2. **Need keys** warning (red, pulsating) when standing on a hatch with too few keys.
3. **Keys at cap** indicator (green, steady) when ready to escape.
4. **Default** (yellow) — just a key count, e.g. `1/3`.

---

## 11. SCREENS — what the player sees

This section catalogs every visible screen and the function of every element
on it. Use it for UX/visual design discussions without needing to read scene
code. Screens are listed in the order a new player encounters them.

> **A note on scene boot order** (`src/client/main.ts:26`): registered scenes
> are Boot → MainMenu → Lobby → BombermanShop → BombsShop → **Factory** →
> Match → Results → TutorialOverlay → Tooltip. `GamblerStreetScene` is
> imported-but-commented-out (see §8). `TutorialOverlayScene` and
> `TooltipScene` run **in parallel** to other scenes (overlay/HUD layers),
> not as standalone screens.

### 11.1 BootScene — splash / preload

**Purpose:** asset preloader and the only screen where the player can confirm
"the game loaded." One click leads into the hub.

| Element | What it does |
|---------|--------------|
| `BOMBERMAN` title (large monospace, white) | Branding only |
| `Turn-based PvP Arena` subtitle (dim gray) | Tagline only |
| `[START]` button (centered) | Click → MainMenuScene. Hovers brighter. |

**Entry/Exit:** game launch → MainMenu. No back navigation.

### 11.2 MainMenuScene — hub

**Purpose:** the player's home base. From here you can play, browse shops,
visit the Factory, run the tutorial, and see your profile at a glance.

| Element | What it does |
|---------|--------------|
| `BOMBERMAN` header + `Main Menu` subtitle | Branding |
| **Coins display** (top-center, gold) | Shows `PlayerProfile.coins`. Live-updates from ProfileStore. |
| **Treasures widget** (top-right) | `TreasureListWidget` — icon + count rows for every treasure type with `> 0`. Pulses on increment. |
| **Equipped Bomberman preview** (center) | Animated sprite of the currently equipped character. |
| `[PLAY]` button | → LobbyScene. |
| `[TUTORIAL]` button | → MatchScene in **offline tutorial mode** (uses `TutorialMatchBackend`). |
| `[BOMBERMAN SHOP]` button | → BombermanShopScene. |
| `[BOMBS SHOP]` button | → BombsShopScene. |
| `[FACTORY]` button | → FactoryScene. |
| **Factory badge** (red dot on the Factory button) | Total bombs ready to claim across all 4 machines. Refreshes every 5s. Hidden when zero. |
| **Connection status** (bottom-center, small) | Socket id / "Disconnected" with color feedback. |
| `[DEBUG: RESET PROFILE]` (bottom-center, small red) | **Dev only.** Wipes profile on the server; shows a "Resetting…" toast then success/error. |

**Entry/Exit:** ← BootScene; → LobbyScene, MatchScene (tutorial),
BombermanShopScene, BombsShopScene, FactoryScene.

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
| **Bomberman selector** (bottom-center) | `BombermanSelector` widget — carousel of owned Bombermen. Click a card to equip it. Hover shows the `TierInfoBadge` (HP, slots, perk). |
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
| **Card carousel** (center, 5 cards) | Per card: portrait, name, tier badge, full inventory icons, price + `[BUY]` button (gold if affordable, gray if not). Cards roll in from the right on cycle start; fly off right on purchase or expiry. |
| **Hardship discount** (per-card, conditional) | If the player owns **zero** Bombermen and the cheapest non-purchased card is unaffordable, that card is **rendered as `FREE`** (price 0) for this player. Implemented server-side, not a UI trick. |
| **Bomberman selector** (bottom-center) | Same widget as in Lobby — always shows your roster so you can equip what you just bought. |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |
| **Toast** (center-bottom, transient) | "Purchased!" / error reasons, auto-clear ~2.5s. |

**Notable state:** each player has their own cycle persisted on
`profile.bombermanShop`. `shop_cycle` broadcasts on regeneration so the row
updates live.

### 11.5 BombsShopScene — bomb vendor + equip

**Purpose:** buy individual bombs with coins, then equip them into the
currently equipped Bomberman's 5 custom slots.

| Element | What it does |
|---------|--------------|
| `BOMBS SHOP` header | Branding |
| **Coins counter** (top-right, gold) | `PlayerProfile.coins`. |
| **Catalog column** (left) | Vertical list of every `PURCHASABLE_BOMBS` entry: icon, name, short description, price, `[BUY]` button. Buy increments `bombStockpile[type]`. |
| **Stockpile column** (middle) | Bombs the player owns (count > 0). Click an entry to **select** it (highlight). "(empty — buy some bombs)" placeholder. |
| **Equipped column** (right) | Current Bomberman's slot row. Slot 0 (Rock, ∞) is locked; slots 1–4 are custom. Click an empty slot to equip the selected stockpile bomb. Click an occupied slot of a different type to swap (old contents flow back to stockpile). |
| **Bomberman selector** (bottom-center) | Switch equipped Bomberman; the Equipped column re-renders for the new one. |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |
| **Toast** (center-bottom, transient) | Purchase/equip outcome, auto-clear ~2s. |

### 11.6 FactoryScene — meta-progression room

**Purpose:** the current primary meta-loop screen. Four machines convert
treasures into bombs over real wall-clock time.

| Element | What it does |
|---------|--------------|
| **Factory background** (full-screen, cover-scaled) | `factory_bg.png` scaled to cover the viewport (origin-centered, no margins). Title/back-button use a stroke + depth=100 so they stay legible over the BG. |
| **Machine overlay (idle)** | Neutral highlight on each of the 4 machine areas of the background. |
| **Machine overlay (working)** | Animated overlay shown while a cycle is in progress. |
| **Status panel** (anchored ~40px above each machine, conditional) | Shows for any machine with an active queue **or** waiting storage. Contains: treasures-spent-so-far icons + counts, progress bar (0–100%), target bomb icon, and a **red corner badge** with the storage count when bombs are waiting. |
| **Shortcut widget** (smaller variant, conditional) | When storage > 0 but no cycle is active, shows a compact "N bombs ready" notification instead of a full panel. |
| **Treasure widget** (top-right) | Always-visible `TreasureListWidget` so the player can see what they have to spend without leaving the screen. |
| **Machine pop-up** (modal, opens on machine click) | Three sections — top-anchored, with a stable container reference (does not re-create per frame): **Commission** (cost breakdown + cycle duration + `[BUY 1]` / `[BUY N]` buttons), **Queue** (active cycle progress + time remaining + queued cycles count), **Storage** (grid of finished bomb icons + counts + `[TAKE ALL]`). `[X]` close button (top-right). |
| `[< BACK]` (bottom-left) + Esc | → MainMenuScene. |

**Notable state:** server-authoritative (cycle progress derived from
wall-clock ms stored in `PlayerProfile.factory`). Client predicts the
progress bar locally for smoothness; next server update is authoritative.

### 11.7 MatchScene — the actual game

**Purpose:** real-time turn-based arena gameplay. Massive scene — the
designer-relevant elements are the HUD, the world overlays, and the loot UI.

**Top HUD (pinned at top):**

| Element | What it does |
|---------|--------------|
| **Phase indicator** (top-left) | `YOUR TURN` (green) / `RESOLVING…` (yellow) / `MATCH OVER` (red). |
| **Turn timer** (left-center, large bold) | Counts down current input phase in 0.1s steps. |
| **Turn counter** (top-center) | `Turn N / 250`. Warning color when few turns remain. |
| **UAV warning** (center, conditional) | `✈ UAV: 18` (turn it fires). Pulsates when 3 turns away. A 3s center-screen banner reads `UAV is Revealing the whole area` when it fires. |
| **Broken-hatch warning** (top-center, conditional, red) | `This Hatch is Broken, you won't be able to Escape from it`. Overrides the keys warning when both apply. |
| **Coins counter** (top-right) | In-match coins picked from chests (NEW_META §2). Format: gold circle + `x42`. |
| **Keys widget** (top-right, below coins) | Small key icon + `N/3`. Color states per §10's priority order — broken (red) > need-keys (red pulse) > at-cap (green) > default (yellow). Hatch tiles near you also show small `N/3` badges. |
| **HP display** (top-right, below keys) | `HP 2/2` (red when alive, gray when dead). Has a 1-frame delay vs. the sprite so the pip animation reads smoothly. |
| **Treasures column** (top-right, stacked) | `TreasureListWidget` — persistent stash icons + counts. Pulses on pickup. |

**Bottom HUD (pinned at bottom):**

| Element | What it does |
|---------|--------------|
| **Bomb slot tray** (center, 5 slots, 56×56 each, 8px gaps, dark rounded rect bg) | Slot 0 = infinite Rock (∞). Slots 1–4 = equipped bombs with `xN` counts. Each slot has a `1`–`5` keyboard badge bottom-left. Click selects (red border); click a map tile to use/throw. |
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
| **Fog of war** | Semi-transparent dark overlay outside line-of-sight (radius 5). |
| **Flare light** | Blue light radius from active flare bombs. |
| **Walk-target circle** (blue) | Hovered destination tile in movement mode. |
| **Throw-target X** (red) | Targeted tile in throw-aim mode. |
| **Lock badges on hatches** | Small `N/3` over hatch tiles within sight. |
| **Chest/door/hatch interactives** | Click to walk-and-interact (resolver handles approach + use). |
| **Bomberman sprites** | Animated characters with HP pips, status icons (stunned, bleeding), and pop-up damage numbers. |
| **Dropped bodies** | Corpse sprites with a small loot indicator if they hold anything. |
| **Active bombs / explosions / smoke / mines** | Visualized by `BombRenderer` per `BOMB_CATALOG` shape. |

**Notable state:** `MatchScene` talks only to a `MatchBackend` interface, so
all of the above renders identically whether the source is a real socket
match (`SocketMatchBackend`) or an offline scripted tutorial
(`TutorialMatchBackend`).

### 11.8 ResultsScene — post-match recap

**Purpose:** show what happened and route the player to their next meta
action (Lobby for another match, or a shop/Factory to spend/claim).

| Element | What it does |
|---------|--------------|
| **Outcome title** (large, top) | `ESCAPED` (green) / `DIED` (red) / `LOST` (red, ran out turn limit). |
| **Treasures Gathered** (escape only) | Horizontal row of icons + counts gained this match. |
| **Items Kept** (escape only) | Bomb icons + counts from the loadout carried out. |
| **Kill count** (escape only) | `Bombermen eliminated: N` if > 0. |
| **Turns survived** (always, dim) | `Turns survived: N`. |
| **R.I.P. line** (death only) | `R.I.P. [name]` + `Killed by: [killer]` (or "in action"). |
| `[BACK TO LOBBY]` (primary) | → LobbyScene. |
| `[FACTORY]` (shortcut, small) | → FactoryScene. Shows the same claim-count badge as the main menu. |
| `[BOMBS SHOP]` (shortcut, small) | → BombsShopScene. |

### 11.9 TutorialOverlayScene — scripted-tutorial overlay

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

### 11.10 TooltipScene — global hover tooltip

**Purpose:** floating context tooltip that follows the cursor and is shared
across all scenes.

| Element | What it does |
|---------|--------------|
| **Floating box** (dark bg, accent border, autosizes) | Shows the contextual blurb for the hovered element. Repositions to stay on-screen and avoid the cursor. |
| **HUD tooltips** | Bomb name + description; key cost; treasure type label. |
| **Map tooltips** | "Walk here"; "Chest — bombs inside (Tier N)"; "Escape hatch — need 3 keys"; "Broken hatch — you cannot escape from here"; "UAV fires in N turns". |
| **Suppression** | Hidden during tutorial dialogue/pause, throw-aim mode, and any full-screen overlay (rule confirmed for the FULL tutorial, not just dialogue). |

**Notable state:** `MatchScene.refreshTooltip(x, y)` queries
`getTooltipAt(screenX, screenY)` whenever the cursor moves and forwards the
result to this scene.

---

## 12. Where things live (cheat sheet)

```
src/shared/config/
  bombs.ts             # BOMB_CATALOG, PURCHASABLE_BOMBS, phosphorus pattern
  balance.ts           # all global tuning (HP, fuse durations, rush, keys, etc.)
  chests.ts            # tier 1 / tier 2 chest loot tables (now includes coins + keys)
  bomberman-tiers.ts   # free / paid / paid_expensive shop config (2-min cycle)
  bomberman-names.ts   # name pools per tier
  treasures.ts         # 10 treasure types, sprite indices, helpers
  factories.ts         # FACTORIES — the 4 Factory machines, costs, cycles, pools
  gambler-street.ts    # SHELVED — gambler tuning (file preserved, not reachable)

src/shared/systems/
  TurnResolver.ts      # PURE 11-step turn resolution
  BombResolver.ts      # bomb shape geometry / raycast
  LineOfSight.ts       # tile LoS with wall blocking
  Pathfinding.ts       # bot pathfinding
  GamblerStreetEngine.ts  # SHELVED — PURE engine (preserved, not reachable)

src/server/
  GameServer.ts            # socket event map, owns scheduler+rooms+services
  MatchScheduler.ts        # lobby carousel of joinable matches
  MatchRoom.ts             # one per active match; runs resolveTurn each turn
  BombermanShopService.ts  # 2-min cycle, 5-card carousel, buy/equip, hardship discount
  BombsShopService.ts      # flat catalog, stockpile, equip-to-slot
  FactoryService.ts        # Factory orchestration — queue, tick, claim, persist
  GamblerStreetService.ts  # SHELVED — gambler carousel (preserved, not wired)
  BotPlayer.ts             # bot AI as a behaviour tree (see docs/bot-behavior.md)
  ScavPlayer.ts            # Scav NPC AI — second brain, hard-capped at 2 alive
  PlayerStore.ts           # JSON file persistence for PlayerProfile

src/client/
  scenes/                  # Phaser scenes — Boot, MainMenu, Lobby,
                           # BombermanShop, BombsShop, Factory, Match, Results,
                           # TutorialOverlay, Tooltip
                           # GamblerStreetScene exists but is unregistered
  systems/                 # MapRenderer, BombRenderer, FogRenderer,
                           # ShieldRenderer, BombermanSpriteSystem,
                           # TreasureListWidget, TierInfoBadge, etc.
  backends/                # MatchBackend interface + Socket / Tutorial impls
  tutorial/                # scripted tutorial — TutorialDirector + script
```

---

## 13. Conventions worth knowing before reading code

- **`.ts` import extensions are required everywhere** (ESM + tsx).
- **Path aliases**: `@shared/*`, `@client/*` in client code. Inside `src/shared/`
  use **relative imports** because `tsx` runs the server directly.
- **Server-authoritative**: never put gameplay decisions in client code, except
  inside `TutorialMatchBackend`.
- **Derive, don't store**: if something can be computed from `MatchState`,
  compute it.
- **Seeded RNG** for any in-match randomness so tutorials and tests are
  reproducible (`src/shared/utils/seeded-random.ts`).
- **No game engine** — Phaser 3 only. Ignore any Godot/Unity/Unreal references
  in sub-docs; they're inherited from a generic template.
