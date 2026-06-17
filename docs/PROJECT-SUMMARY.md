# Roombov — Project Summary

A turn-based PvP Bomberman-style browser game with a roguelike loot/extraction
economy. This document is a self-contained context handoff — share it with
another Claude instance (Desktop, web, etc.) so it can reason about the project
without reading the codebase.

Last reviewed against source: **2026-06-13**.

Recent shape of the project:

- **Coins + SP are the two economies.** Coins are the soft shop currency,
  earned in-match by looting chests and banked on escape. SP (Skill Points)
  is per-Bomberman, earned in-match, and spent on that character's permanent
  stat upgrades.
- **Escape is gated by the Console system.** To extract you must first **hack
  your three personal consoles** (channel each by standing next to it for a
  few quiet turns), then leave through any working hatch.
- **The Bomberman Shop is a two-column screen** — a 3-offer character shop on
  the right, an inline per-Bomberman **Upgrade panel** on the left.
- **Bombermen have classes** — Ambusher / Healster / Disguiser — driven by
  what the character does when it stands still (its *idle action*).
- **Responsive-browser mobile build** — always-landscape, drag-and-hold
  touch controls; a no-op on desktop.

---

## 1. The game in one paragraph

Up to 4 players (real + bots, with up to 2 Scav NPCs as a separate AI brain)
drop into a top-down dungeon arena. Combat is **turn-based on a fixed clock**
(see §3 — it behaves more like a slow tick simulation than a take-your-time
turn game). Players carry a small loadout of bombs (each with distinct shapes,
fuses, and side-effects), search the map for **chests** holding bombs and
**coins**, **hack their three assigned consoles** to arm their extraction, and
try to **escape through a hatch** before the turn limit. What they escape with
(coins, SP, the loadout they carried) persists; what they die holding stays on
the corpse for someone else to loot.

The meta is a **two-shop loop** fed by what you carry out of a match:

```
   ┌──────────────────────────────────────────────────────────┐
   │                       MATCH LOOP                          │
   │  spawn → loot chests → hack consoles → fight → escape     │
   │                                                           │
   │  on escape:  + coins, + SP banked on this Bomberman,      │
   │              + the loadout you carried out                │
   │  on death:   - everything carried (drops on body)         │
   └────────────┬──────────────────────────────────────────────┘
                │
       ┌────────┴──────────┐          ┌────────────────────────┐
       │   BOMBS SHOP      │          │    BOMBERMAN SHOP       │
       │ coins → bombs     │          │ coins → new characters  │
       │ (+ stockpile +    │          │ (3-offer rotation)      │
       │  equip to slot)   │          │ + inline UPGRADE panel: │
       │                   │          │   SP + coins → permanent│
       │                   │          │   stat tiers (cap/      │
       │                   │          │   stack/hp)             │
       └─────────┬─────────┘          └────────────┬───────────┘
                 └───────────────┬──────────────────┘
                                 ▼
                       coins earned in-match
```

---

## 2. Tech stack & runtime shape

- **Browser client**: Phaser 3 (TypeScript, ESM), built with Vite.
- **Server**: Node.js + Express + Socket.IO, run via `tsx` (no transpile step
  in dev). One process, no dedicated game-server fleet.
- **Tests**: Vitest. The pure-function game logic is unit-tested directly.
- **Persistence**: per-player JSON files under `production/player-data/`
  (one file per profile id). No database.
- **Hosting target**: render.com (free tier — see §13 caveat).
- Strictly typed TypeScript, ESM-only, `.ts` import extensions required.

The codebase is split into three trees under `src/`:

- `src/shared/` — pure game rules. No DOM, no Phaser, no Node APIs. Imported
  by both client and server.
- `src/server/` — Socket.IO orchestration, match rooms, persistence, shops.
- `src/client/` — Phaser scenes, rendering systems, input.

The single most important rule: **`src/shared/systems/TurnResolver.ts` is a
pure function**. `resolveTurn(state, actions, map) → (nextState, events)` runs
identically on the server (authoritative) and on the client (in tutorial mode,
where there is no real server). It applies a fixed ordered resolution each
turn. Everything derivable from `MatchState` should be derived, not stored.

### Mobile (responsive browser, not a native app)

Roombov ships as a responsive **browser** build — always landscape. Every
mobile piece is a **no-op on desktop**, gated by `isMobileDevice()`
(`src/client/util/isMobile.ts`, overridable via `?mobile=1`/`?mobile=0`):

- **`mobileViewport.ts`** — URL-bar-aware canvas sizing (pins to
  `visualViewport`'s visible px) + a portrait "rotate your device" gate.
- **`responsiveScene.ts`** — menu/UI scenes lay out in a fixed *design box*
  and camera-fit to short viewports; desktop layout is byte-for-byte unchanged.
- **`MobileControls.ts`** — replaces click-to-act with **drag-and-hold**:
  drag the `[MOVE]`/`[ATTACK]` handle onto the map and **release to commit**,
  or **press-and-hold a tile ~0.5s** to commit a move there. Pinch zooms.
  Pure input layer — all state mutation goes through the same
  server-authoritative path the PC build uses. HUD is half-scaled on mobile.

Full reference: `docs/MOBILE.md`.

---

## 3. The "Turn" system — a clocked tick simulation

This is the single most important thing to understand about how Roombov
*feels*, and it is **not** a traditional turn-based game. Read this before
reasoning about pacing, input, or "whose turn is it."

### How a turn actually runs

Each turn is two fixed wall-clock windows, back to back
(`BALANCE.match`, driven by `setTimeout` in `src/server/MatchRoom.ts`):

```
   ┌─ input phase ─┐┌─ transition / resolution ─┐
   │  1.5 seconds  ││         1.5 seconds        │   = one 3-second turn
   └───────────────┘└────────────────────────────┘
```

- During the **input phase** every player may queue **at most one action**
  (move, throw a bomb, interact, or wait). That queued intent is the *entire*
  extent of player control.
- When the window closes the server calls `resolveTurn` **once**, folding in
  **everyone's** queued actions at the same time, then plays the
  transition/resolution animation window.
- Then the next input window opens. Repeat for up to `turnLimit` = **250**
  turns (≈ 12–13 minutes of real time at 3 s/turn).

### Why it is a tick system, not a turn game

The defining peculiarity: **the clock never waits for you, and you never get
to "take a turn" in the chess sense.**

- **No alternation, no initiative, no turn order.** There is no "I move, then
  you move." All actors — every human, every bot, every Scav — resolve
  **simultaneously** inside one deterministic pass. Nobody is ever "waiting
  on" anyone else.
- **The world advances on a heartbeat.** The turn ends and resolves on a fixed
  timer **whether or not you did anything**. You cannot pause to think, cannot
  extend your time, cannot pass priority, and cannot react during resolution.
  If you queue nothing, you simply do nothing that tick (stand still) while the
  world moves on around you.
- **One nudge per tick is the whole game's input surface.** You don't author a
  full move; you drop a single intent into the next tick before it fires. You
  control *neither* the order things resolve in *nor* what anyone else does.
- **Functionally, it's a real-time sim at a very low fixed tick rate** — one
  simulation step every 3 seconds (~0.33 Hz) — dressed up as "turns." It is
  much closer to a simultaneous-resolution / "we-go" lockstep simulation than
  to an I-go-you-go board game. Everything in-match is measured in these ticks:
  bomb fuses count down per turn, Out-of-Combat Rush gives 2 tiles **per
  turn**, console channels and hatch escapes require N quiet **turns**, fire
  and bleeding age per **turn**.

### The UI deliberately hides the turn-ness

The match HUD shows a **real-time `M:SS` countdown clock**, *not* a turn
counter, and the `YOUR TURN` / `RESOLVING…` phase label is hidden
(`MatchScene.formatMatchClock` converts `turnsLeft × 3s + currentRemainingMs`
into minutes:seconds; see the note above `inputPhaseSeconds` in `balance.ts`).
**No game logic ever reads the clock** — it is pure presentation that
reinforces the real-time *feel* while the simulation underneath stays discrete
and turn-based.

### Determinism (why this shape was chosen)

`resolveTurn` is pure: **same `MatchState` + same set of actions → same next
state**, byte for byte. That is what lets the offline tutorial replay real
gameplay client-side (`TutorialMatchBackend`), lets the whole rules layer be
unit-tested as a function, and keeps the server authoritative without trusting
any client. The fixed resolution order matters because many interactions
depend on it. The order each turn:

1. Apply movement (bombermen commit chosen target tiles)
2. Interaction pass (chest/coin pickup, body loot, console channel, escape flag)
3. Place thrown bombs
4. Tick fuses; collect bombs that trigger this turn
5. Resolve triggered bombs (explosions, fire, scatter) — **each Bomberman
   takes at most 1 damage this turn** regardless of how many bombs touch them
6. Apply fire-tile damage to bombermen standing on fire
7. Age fire and light tiles; drop expired ones
8. Age bleeding; drop blood splatter on tiles bleeding bombermen walked on
9. Handle console channel progress + the escape gate
10. Handle deaths (drop bodies, flag `!alive`); handle escapes (remove from board)
11. Check match-end conditions

Do not mutate `state` in callers — `resolveTurn` returns a fresh object the
server diffs and broadcasts.

---

## 4. The match itself

- **Map**: tile-based. Authored in Tiled, exported to JSON, includes a
  required `Collision` layer plus an `escapeTiles[]` candidate pool, a
  `Consoles` layer (→ `consoleSpots`), and optional decor/tutorial layers.
- **Players**: up to 4 (`maxPlayersPerMatch`). Empty seats fill with bots
  (toggleable per lobby listing — "Normal" vs "No-Bots"). Up to 2 Scav NPCs
  may also spawn as a separate, more aggressive AI brain.
- **Turn**: see §3 — 1.5 s input + 1.5 s resolution, on a fixed clock.
- **Turn limit**: 250. The HUD clock flashes a warning under the last few turns.
- **Movement**: 1 tile/turn normally. **Out-of-Combat Rush** (2 tiles/turn)
  activates after 3 peaceful turns when no enemy is within 8 tiles + mutual
  line-of-sight, and no placed bomb is within 8 tiles (bombs break rush
  through walls — they're loud).
- **HP**: base 2, capped at 3 with the HP upgrade track. Each bomb deals at
  most 1 damage per Bomberman per trigger; damage is capped per resolution
  set. Bleeding lasts 10 turns.
- **Fog of war**: per-player line-of-sight, radius 5 tiles. A red screen-edge
  border warns when an enemy has clear mutual line-of-sight to you.
- **Spawning**: minimum 5-tile distance between Bombermen.
- **Win / extraction**: escape through a hatch (after hacking your consoles —
  §9), OR be the last alive when the turn limit hits.
- **Loot**: chests scatter across the map at Tier 1 / Tier 2 / Tier 3 zones
  (**14 / 3 / 1** per match). Killed Bombermen drop a body that can be looted
  by anyone (transfers bombs + coins up to carry cap).
- **Scavs**: up to 2 alive NPC raiders at any moment — separate AI brain from
  bots, more persistent (longer chase, higher predict chance, hostile on sight).

---

## 5. BOMBS — the catalog

Every bomb is data-driven from `src/shared/config/bombs.ts` (`BOMB_CATALOG`).
Bomb behaviors are tagged: `explode`, `fire`, `light`, `smoke`, `place_mine`,
`stun_explode`, `phosphorus_seed`, `cluster_seed`, `scatter`, `teleport`,
`shield_wall`. Tuning constants live in `src/shared/config/balance.ts`.

| Bomb                  | Fuse | Pattern                       | Effect                                       | Coin |
|-----------------------|-----:|-------------------------------|----------------------------------------------|-----:|
| Rock                  |    0 | single tile                   | Infinite fallback, 1 dmg target only         |    0 |
| Bomb                  |    1 | + radius 4                    | Standard blast, 9×9 cross                    |   25 |
| Wide Bomb             |    2 | circle radius 2 (raycast)     | 5×5, walls block                             |   40 |
| Delay Tricky          |    1 | diagonal radius 3             | X-shape blast                                |   25 |
| Contact               |    0 | + radius 1                    | Detonates on landing                         |   95 |
| Banana                |    1 | scatters 4 children diagonally| Each child = + r1 a turn later               |   30 |
| Flare                 |    0 | circle r4 light, 3 turns      | Reveals area, no damage, doesn't break Rush  |    5 |
| Molotov               |    0 | + r1 fire, 2 turns            | Fire ticks each turn                         |  100 |
| Ender Pearl           |    0 | self-teleport                 | Lands → you teleport in. Doesn't break Rush  |   50 |
| Fart Escape           |    0 | move 2 + smoke r5, 4 turns    | Escape move + smoke screen                   |   15 |
| Motion Detector Flare |    0 | proximity mine, r3            | Fires a flare when enemy enters range        |    5 |
| Flash                 |    1 | circle r3 (7×7) stun          | Stuns caught Bombermen 1 turn                |   65 |
| Shield Bomb           |    0 | + r1 wall, 3 turns            | Wall blocks movement & explosions, pushes occupants out without damage | 30 |
| Phosphorus            |    0 | reveal r5, then scattered fire| **Super** — 11×11 reveal then burn pattern   |   40 |
| Cluster Bomb          |    0 | scatters 25 mines in 11×11    | **Super** — touch mines                      |   40 |
| Big Huge              |    2 | circle r5 raycast (11×11)     | **Super** — massive blast                    |  125 |

Notes:

- "Super bombs" (Phosphorus, Cluster, Big Huge) are the premium catalog tail —
  high coin cost and rolled rarely from chests.
- Walls + LoS interact with each bomb shape via `BombResolver` (raycast vs.
  geometric pattern depending on shape kind).
- Status effects: Stunned (Flash), Bleeding (any explosion that didn't kill).
- A confused (stunned) Bomberman stumbles into a random adjacent tile — fire,
  mines, and other hazards are valid destinations (the roguelike intent).
- The Shield Bomb acts before push resolution, extinguishes fire under it,
  suppresses phosphorus, holds mines dormant.

---

## 6. BOMBERMEN (characters), CLASSES, and the BOMBERMAN SHOP

A "Bomberman" is a **character skin + starting bomb inventory + per-instance
stats + per-instance upgrade tiers + a class**. Two shapes:

- `BombermanTemplate` — generated, sits in the shop until bought.
- `OwnedBomberman` — what the player owns; cloned from the template at purchase
  with a stable id, purchase timestamp, its own SP balance + lifetimeSp, and
  per-track upgrade counts.

An OwnedBomberman has:

- `id`, `name`, `sourceTemplateId`, `colors`/`tint`, `character` (sprite
  variant `char1`–`char7`).
- `inventory` — array of `{ type, count }` slots, length = `maxCustomSlots`.
  An infinite **Rock** is granted as a fixed slot at match time on top of these
  (so displayed loadout = customSlots + 1).
- `maxCustomSlots`, `stackSize` — per-instance stat values.
- `sp`, `lifetimeSp` — Skill Points (spendable + uncapped lifetime accumulator
  for the Results hero block).
- `upgrades: { cap, stack, hp }` — per-track applied tiers.
- `idleAction` — the **class** (see below).

**Always read effective stats via `effectiveMaxCustomSlots(owned)` /
`effectiveStackSize(owned)` / `effectiveMaxHp(owned)` from
`src/shared/utils/bomberman-stats.ts`.** Reading raw `maxCustomSlots` /
`stackSize` ignores applied upgrades and has caused multiple cap-display and
slot-validation bugs.

### Classes (idle actions)

A Bomberman's class is `BombermanState.idleAction: 'attack' | 'heal' |
'disguise'` — it decides what the character does after standing still long
enough, resolved inside `resolveTurn`. Player-facing names
(`IDLE_ACTION_LABEL`):

| idleAction | Class name | After N idle turns… |
|------------|------------|---------------------|
| `attack`   | **Ambusher** | Arms an ambush melee trap on the first idle turn. |
| `heal`     | **Healster** | Restores HP after `healIdleTurns` (3) quiet turns. A heal draws a bot hunting party. |
| `disguise` | **Disguiser**| Turns into a random `disguise_objects.png` decor frame after `disguiseIdleTurns` (3) turns; bots are blinded by an active disguise. Cannot disguise while standing on a chest. |

Tuning: `BALANCE.idleActions`. Per-class tint + visuals are client-side.

### The Bomberman Shop (`src/server/BombermanShopService.ts`)

Reworked **2026-06-06** into a **two-column screen**:

- **Right ~60% — the shop.** Offers **3 tier-1 ("blue") Bombermen** on a
  per-player **2-minute** rotation. Every offer has the same stats: **4 custom
  slots, stack 5, 2 HP**. Each rolls **one offensive** bomb ×5 (`bomb` /
  `delay_tricky`), **one escape** ×2 (`fart_escape` / `ender_pearl` /
  `shield`), **one flare** ×2 (`flare` / `motion_detector_flare`), and leaves
  the 4th slot empty. **Price is set purely by the escape it rolled**:
  Ender Pearl 600 / Fart 550 / Shield 500. One of each class
  (Ambusher / Healster / Disguiser) is offered per cycle.
- **Left ~40% — the inline Upgrade panel** (`BombermanUpgradePanel`), targeting
  the **equipped** Bomberman. Clicking a roster card in the shop equips it so
  the panel retargets. (The old standalone `BombermanUpgradeScene` popup was
  removed; everything that used to launch it now routes here.)
- **Bonus FREE Bomberman**: once all three offers are bought, a fourth **free**
  Bomberman is offered (same stats, lighter loadout — offensive ×3 / escape ×1
  / flare ×1, always Ambusher).
- **Broke-player safety net**: a player who owns no Bombermen and can't afford
  anything gets the cheapest still-buyable offer for **free** (hardship
  discount); the cycle is force-refreshed if every card is bought/unaffordable
  so the discount always has a card to free.
- **Roster cap**: 5 owned Bombermen (`BALANCE.player.ownedBombermenCap`).
- First-bought Bomberman auto-equips; switching equipped Bomberman is free.

---

## 7. BOMBS SHOP

`src/server/BombsShopService.ts`. **Flat, always-available** — no rotation,
no expiry.

- The catalog is `PURCHASABLE_BOMBS` from the bomb catalog (everything except
  the infinite Rock). Prices are taken straight from `BOMB_CATALOG` — **coins
  only**.
- Buying a bomb increments `PlayerProfile.bombStockpile[type]` (unbounded).
- The second flow lets the player **equip** bombs from the stockpile into the
  currently equipped Bomberman's custom slots. Slot rules:
  - **Empty** slot: filled with up to `min(stockpile, requestedQty,
    effectiveStackSize)`; taken amount removed from the stockpile.
  - **Same type**: tops up to `effectiveStackSize` (partial if request exceeds
    capacity).
  - **Different type**: swap — old contents flow back to the stockpile, then
    the new contents fill up to `effectiveStackSize`.
- All slot validation runs against **effective** (post-upgrade) stats.
- Validations are server-authoritative (invalid slot index, no equipped
  Bomberman, not in stockpile, etc.).

---

## 8. PER-BOMBERMAN UPGRADES (SP economy)

The primary progression hook for individual characters. Each OwnedBomberman
accumulates **Skill Points** in-match and spends them (plus coins from the
profile) on three permanent stat tracks. Tuning: `BALANCE.upgrades`.

- **Server logic**: `src/server/BombermanUpgradeService.ts`
  (`applyUpgrade(profile, ownedId, track)` — atomic, re-validates costs from
  the balance config, deducts SP from owned + coins from profile, bumps the
  per-track tier counter, saves).
- **Client UI**: the inline **Upgrade panel** in the Bomberman Shop
  (`src/client/systems/BombermanUpgradePanel.ts`). Posts `upgrade_bomberman`;
  the server replies `shop_result` with a fresh profile.
- **Display helpers**: `src/shared/utils/bomberman-stats.ts` —
  `effectiveMaxCustomSlots`, `effectiveStackSize`, `effectiveMaxHp`,
  `tiersRemaining`. Every UI surface that shows slot / stack / HP must go
  through these.

### SP earning (in-match)

| Source                                           | SP   |
|--------------------------------------------------|-----:|
| Chest open (auto-loot, first time only per chest)|    5 |
| Confirmed player-Bomberman kill (last hitter)    |   50 |
| Confirmed Scav kill (last hitter)                |   25 |
| Per 5 survival turns alive                       |  +1  |

A "decent" extraction ≈ 65 SP (2 chests + 1 player kill + 25 turns survived).
SP banks into the OwnedBomberman **only on escape**; death wipes the
match-earned SP.

### Upgrade tracks (costs repriced 2026-06-12 — `BALANCE.upgrades`)

| Track | maxTiers | Hard cap        | Costs (SP / coins) per tier                     |
|-------|---------:|-----------------|-------------------------------------------------|
| cap   |        2 | `totalSlotCap=8` (Rock + customs) | T1: 100 / 500   T2: 200 / 750 |
| stack |        3 | (per-tier curve) | T1: 50 / 250   T2: 100 / 400   T3: 200 / 600   |
| hp    |        1 | `cap=3` HP       | T1: 300 / 500                                   |

Cap/Stack add inventory slots / per-slot stack size; HP raises base HP 2 → 3.
SP roughly doubles per tier within a track; coins are the softer secondary
gate; HP is the SP-heavy capstone.

---

## 9. ESCAPE — Consoles & Hatches (in-match)

Extraction is a **two-step gate**: arm it by hacking your personal consoles,
then leave through a working hatch. Tuning: `BALANCE.consoles` +
`BALANCE.escapeHatches`. Resolver step 9 handles both.

### Consoles (arming extraction)

- Each map declares `consoleSpots` (authored as a Tiled `Consoles` layer of
  2×2 marker blocks; the converter clusters them into solid footprints and
  strips the layer from the shipped `.tmj`).
- At match start each Bomberman is seeded a **personal trio** of consoles
  (`perPlayer` = 3; fewer if the map declares fewer). Only **your** assigned
  consoles count for you.
- **Hacking** a console = standing **Chebyshev-adjacent** to it for
  `interactIdleTurns` (**3**) consecutive **damage-free idle** turns. The
  arrival turn (action `move`) does not count.
- You may escape once `requiredToEscape` (**3**, clamped to your assigned
  count) consoles are done.
- Consoles stay **dark and unhackable** for the first `activationDelayTurns`
  (**10**, ≈ 30 s) so the early game isn't a console rush.
- Completing a console fires a small **mini-flare** from its center
  (reveal radius 2, 3 turns) — a visible tell to other players.
- Client polish (in `MatchScene` / `MapRenderer`): a dotted **red nav path** to
  your next console after the first is done, door-style **fog memory** of seen
  consoles, the cyan **channel ring** while hacking, and a 🖥 **N/3** HUD
  counter.
- **Bots** ignore consoles until `botStartFraction` (0.6) of the turn limit,
  then seek + channel their trio and extract.

### Hatches (leaving)

- `BALANCE.escapeHatches.count` = **5** hatches spawn per match, chosen at
  random from the map's `escapeTiles[]` candidate pool via seeded shuffle (if
  the map declares fewer candidates, every candidate is used).
- Escaping requires standing idle on a hatch for `idleTurnsRequired` (**2**)
  turns (the walk-on turn doesn't count) **and** having armed extraction via
  consoles.
- A hatch **breaks** after a single use — anyone standing on a broken hatch
  sees a red HUD warning.
- Hatches render on a dedicated under-sprite layer (below Bombermen) for
  readability.

---

## 10. CURRENCIES

### Coins (soft currency)

- **Earned in-match** from chests (rolled per tier: T1 50–100, T2 75–150,
  T3 150–250). Auto-collected on chest-open.
- Banked into `PlayerProfile.coins` on escape; lost on death.
- Spent at the Bombs Shop, the Bomberman Shop, and on per-Bomberman upgrades.
- Brand-new profiles spawn with **500** coins (`BALANCE.player.startingCoins`).

### SP (Skill Points)

- **Per-Bomberman**, not a shared wallet. Earned in-match (§8), banked on
  escape, spent on that character's upgrade tracks. See §8.

---

## 11. SCREENS — what the player sees

This section catalogs each visible screen and the function of its elements.
Screens are listed in the order a new player encounters them.

> **Reachable scenes**: Boot → MainMenu → Lobby → BombermanShop → BombsShop →
> Match → Results, plus the parallel overlay scenes TutorialOverlay and
> Tooltip (popup layers, not standalone screens). `TutorialEndScene` replaces
> Results after a tutorial match (tutorial awards nothing — it's a
> "what to do next" card).

### 11.1 BootScene — splash / preload

| Element | What it does |
|---------|--------------|
| Title + `Turn-based PvP Arena` subtitle | Branding / tagline. |
| `[START]` button | Click → MainMenuScene. |

### 11.2 MainMenuScene — hub

| Element | What it does |
|---------|--------------|
| Header + `Main Menu` subtitle | Branding. |
| **Coins display** (top-center, gold) | `PlayerProfile.coins`, live-updating. |
| **Equipped Bomberman preview** (center) | Animated sprite of the equipped character, with name, effective slot/stack/HP badges, and current SP. |
| **Upgrade pip** (on the preview, when affordable) | Pulsing dot when ≥1 upgrade is affordable. Clicking the preview routes to the Bomberman Shop (inline upgrade panel). |
| `[PLAY]` | → LobbyScene. |
| `[BOMBERMAN SHOP]` | → BombermanShopScene. |
| `[BOMBS SHOP]` | → BombsShopScene. |
| `[TUTORIAL]` | → MatchScene in **offline tutorial mode** (`TutorialMatchBackend`). |
| **Connection status** (bottom) | Socket id / "Disconnected". |
| `[DEBUG: RESET PROFILE]` (small, red) | **Dev only.** Wipes the server profile. |

### 11.3 LobbyScene — match carousel

| Element | What it does |
|---------|--------------|
| `LOBBY` header | Branding. |
| **No-Bomberman warning** (conditional) | Hidden once a Bomberman is equipped. |
| **Match cards** (row) | One per scheduled/active match: id, player count (e.g. `3/4`), auto-start countdown, tier badge, and **mode label** (Normal vs No-Bots). Roll in/out on listing changes. |
| `[JOIN]` / `[JOINED]` + `[UNJOIN]` | Server-side join/unjoin. |
| **Bomberman selector** (bottom) | Carousel of owned Bombermen; click to equip. Hover shows `TierInfoBadge` (effective HP/slots/stack + class headline + perk line). Cards show **effective** counts. |
| `[< MENU]` + Esc | Leaves any joined match → MainMenu. |

Reacts to `match_listings`; transitions to MatchScene on `match_start`.

### 11.4 BombermanShopScene — two-column shop + upgrade panel

| Element | What it does |
|---------|--------------|
| `BOMBERMAN SHOP` header | Branding. |
| **Coins counter** (top-right) | `PlayerProfile.coins`. |
| **Roster counter** | `N/5` owned. |
| **Cycle timer** | Counts down to the next 2-minute rotation. |
| **Shop column (right ~60%)** | 3 offered tier-1 Bombermen (+ the free bonus once all are bought): portrait, name, class, loadout icons, slot/stack stats, escape-driven price + `[BUY]`. |
| **Upgrade panel (left ~40%)** | `BombermanUpgradePanel` for the **equipped** Bomberman: CAP / STACK / HP rows with current effective stat, next-tier SP + coin cost, affordability-colored Buy. |
| **Bomberman selector** (bottom) | Roster; clicking a card equips it so both the loadout preview and the upgrade panel retarget. |
| `[< BACK]` + Esc | → MainMenu. |
| **Toast** | Purchase / upgrade outcome, auto-clear. |

Per-player cycle persisted on `profile.bombermanShop`; `shop_cycle` broadcasts
on regeneration so the row updates live.

### 11.5 BombsShopScene — bomb vendor + equip

| Element | What it does |
|---------|--------------|
| `BOMBS SHOP` header | Branding. |
| **Coins counter** (top-right) | `PlayerProfile.coins`. |
| **Catalog column** (left) | Every `PURCHASABLE_BOMBS` entry: icon, name, description, coin price, `[BUY]` → increments `bombStockpile[type]`. |
| **Stockpile column** (middle) | Owned bombs (count > 0). Click to **select**. |
| **Equipped column** (right) | The Bomberman's slot row. **Slot 0 = infinite Rock** (∞, locked). Slots 1..`effectiveMaxCustomSlots` are custom — click empty to equip the selected stockpile bomb; click a different-type slot to swap (old contents return to stockpile). Slot count + stack caps respect upgrades. |
| **Bomberman selector** (bottom) | Switch equipped Bomberman; the Equipped column re-renders. |
| `[< BACK]` + Esc | → MainMenu. |

### 11.6 MatchScene — the actual game

**Top HUD (pinned):**

| Element | What it does |
|---------|--------------|
| **Match clock** (top-center, large) | Real-time `M:SS` countdown to the turn limit (see §3). The turn counter and `YOUR TURN`/`RESOLVING` phase label are **hidden** — the clock is the only time/progress readout. |
| **UAV warning** (conditional) | `✈ UAV: N` (turn it fires); pulses when near. A center banner reads `UAV is Revealing the whole area` when it fires. |
| **Broken-hatch warning** (conditional, red) | Shown when standing on a used hatch. |
| **Coins counter** (top-right) | In-match coins picked from chests. |
| **Console counter** (top-right) | 🖥 `N/3` consoles hacked, with the §9 color states (red pulse when more needed, green when armed). Hidden on maps with no consoles (tutorial). |
| **HP display** (top-right) | `HP N/maxHp` (effective max, 2 or 3). 1-frame delay vs. the sprite so pips read smoothly. |

**Bottom HUD (pinned):**

| Element | What it does |
|---------|--------------|
| **Bomb slot tray** (center) | Slot 0 = infinite Rock (∞). Slots 1..effectiveMaxCustomSlots = equipped bombs with `xN` counts and a `1`–`N` keyboard badge. Click selects (red border); click a map tile to use/throw. Half-scaled on mobile. |
| **Stun overlay** (conditional) | Grayed rect + `STUNNED` banner; blocks slot clicks. |
| **Melee trap icon** (conditional) | Sword icon while in ambush/crouch mode. |

**Loot panel (above the tray, conditional):** `LOOTING` header + per-source
rows (chest `CHEST (TIER N)` and/or `BODY LOOT`) of bomb icons; click a slot to
swap with your selected stockpile bomb. A small stash row echoes your current
slots. Supports the same tap-loot-then-tap-slot swap on PC and mobile.

**World overlays:**

| Element | What it does |
|---------|--------------|
| **Fog of war** | Dark overlay outside line-of-sight (radius 5); adjacent walls and seen doors/consoles stay visible (fog memory). |
| **Danger border** (red screen edge) | Lit when an enemy has clear mutual line-of-sight to you (smoke suppresses it). |
| **Console nav path** (dotted red) | After ≥1 console is hacked, a sticky dotted line points to your next assigned console. |
| **Flare light** | Blue light radius from active flares / console mini-flares. |
| **Walk-target circle / throw-target X** | Hovered move destination (blue) / throw aim (red). |
| **Discovered-eye indicator** | Animated eye above a Bomberman standing on a lit tile (flare/mine/phosphorus/console flare) — suppressed for disguised or smoked Bombermen. |
| **Interactives** | Chests / consoles / hatches — click to walk-and-interact. |
| **Bomberman sprites** | Animated characters with HP pips, status icons (stunned, bleeding), name, per-class tint, and pop-up damage numbers. Disguised Bombermen render as decor frames. |
| **Dropped bodies / bombs / explosions / smoke / mines** | Corpses (with loot indicator) and bomb VFX via `BombRenderer` per `BOMB_CATALOG` shape. |
| **Decorative objects** | Seeded scatter of `disguise_objects.png` frames below fog — purely visual; a Disguiser blends in among them. |

`MatchScene` talks only to a `MatchBackend` interface, so everything renders
identically whether the source is a real socket match (`SocketMatchBackend`)
or an offline scripted tutorial (`TutorialMatchBackend`).

### 11.7 ResultsScene — post-match recap

| Element | What it does |
|---------|--------------|
| **Outcome title** | `ESCAPED` (green) / `DIED` (red) / `LOST` (red, turn limit). |
| **SP hero block** (animated) | Bomberman name + sprite. Escape: `+N SP` counts up, then a **reaction tier** (`Bad` / `Not Bad` / `Nice` / `Excellent`) by SP earned. Death: `R.I.P.` + `Killed by [killer]`. Uses an SP-delta fallback when the server's `spEarned` is missing. |
| **Items Kept** (escape only) | Bomb icons + counts from the loadout carried out. |
| **Kill count** (escape only) | `Bombermen eliminated: N` if > 0. |
| **Turns survived** (always) | `Turns survived: N`. |
| `[UPGRADE]` (when affordable) | → Bomberman Shop (inline upgrade panel). Pip pulses while available. |
| `[BACK TO LOBBY]` (primary) | → LobbyScene. |
| `[BOMBS SHOP]` (shortcut) | → BombsShopScene. |

### 11.8 TutorialOverlayScene — scripted-tutorial overlay

Parallel overlay on MatchScene in tutorial mode only: a bottom-right dialogue
panel (portrait + text + `Click to Continue`), full-screen pause screens,
pulsing HUD/world highlights (box / circle / `X`), a red flash hint on wrong
input, and a transparent input blocker. Lifecycle tied to the tutorial backend.

### 11.9 TooltipScene — global hover tooltip

Floating context box shared across scenes. Shows bomb name + description on HUD
slots, and map tooltips ("Walk here", "Chest — bombs inside (Tier N)",
"Console — hack it to arm your escape", "Escape hatch", "Broken hatch — you
cannot escape from here", "UAV fires in N turns"). Suppressed during tutorial
dialogue/pause, throw-aim mode, and any full-screen overlay.

---

## 12. Where things live (cheat sheet)

```
src/shared/config/
  bombs.ts             # BOMB_CATALOG, PURCHASABLE_BOMBS, phosphorus pattern
  balance.ts           # all global tuning (turn timing, HP, rush, consoles,
                       #   hatches, upgrades, idle actions, bots, scavs, decor)
  chests.ts            # 3 tiers + CHEST_SPAWN_TABLE (14/3/1), coin ranges
  bomberman-tiers.ts   # shop offer model (3 offers, escape-priced) + stats
  bomberman-names.ts   # name pools

src/shared/systems/
  TurnResolver.ts      # PURE ordered turn resolution (see §3)
  BombResolver.ts      # bomb shape geometry / raycast
  LineOfSight.ts       # tile LoS with wall blocking (adjacent-wall rule)
  Pathfinding.ts       # bot pathfinding

src/shared/utils/
  bomberman-stats.ts   # effectiveMaxCustomSlots/effectiveStackSize/effectiveMaxHp
  loot-roll.ts         # weighted unique-pick + largest-remainder distribution
  seeded-random.ts     # deterministic RNG for tutorials/tests

src/server/
  GameServer.ts                # socket event map; owns scheduler + rooms + services
  MatchScheduler.ts            # lobby carousel of joinable matches (+ bots/no-bots cycle)
  MatchRoom.ts                 # one per active match; drives the turn clock, runs resolveTurn
  BombermanShopService.ts      # 3-offer rotation, buy/equip, free bonus, hardship discount
  BombsShopService.ts          # flat catalog, stockpile, equip-to-slot (effective-stats aware)
  BombermanUpgradeService.ts   # SP + coin-gated per-track upgrade transactions
  BotPlayer.ts                 # bot AI as a behaviour tree (docs/bot-behavior.md)
  ScavPlayer.ts                # Scav NPC AI — second brain, hard-capped at 2 alive
  PlayerStore.ts               # JSON file persistence for PlayerProfile
  Analytics.ts                 # fire-and-forget telemetry → Google Sheet (docs/ANALYTICS-SPEC.md)

src/client/
  scenes/                      # Boot, MainMenu, Lobby, BombermanShop, BombsShop,
                               # Match, Results, TutorialEnd, TutorialOverlay, Tooltip
  systems/                     # MapRenderer, BombRenderer, FogRenderer, ShieldRenderer,
                               # BombermanSpriteSystem, BombermanAnimations,
                               # BombermanUpgradePanel, TierInfoBadge, BombermanSelector,
                               # BombIcons, ActivityIndicator, MobileControls, etc.
  backends/                    # MatchBackend interface + Socket / Tutorial impls
  tutorial/                    # scripted tutorial — TutorialDirector + script
  util/                        # isMobile, mobileViewport, responsiveScene

tests/                         # Vitest: BombResolver, LineOfSight, Pathfinding,
                               # bomberman-upgrade, sp-earning, escape-hatch, consoles,
                               # uav, scav, shield-bomb, loot-roll, idle-action,
                               # confused-move, bomberman-shop, match-scheduler
```

---

## 13. Conventions & operational notes

- **`.ts` import extensions are required everywhere** (ESM + tsx).
- **Path aliases**: `@shared/*`, `@client/*` in client code. Inside `src/shared/`
  use **relative imports** — `tsx` runs the server directly.
- **Server-authoritative**: never put gameplay decisions in client code, except
  inside `TutorialMatchBackend`.
- **Effective stats over raw**: always read slot/stack/HP through
  `effectiveMaxCustomSlots` / `effectiveStackSize` / `effectiveMaxHp`.
- **Derive, don't store**: if something can be computed from `MatchState`,
  compute it. Only persist what the resolver needs next turn.
- **Seeded RNG** for any in-match randomness so tutorials and tests are
  reproducible (`src/shared/utils/seeded-random.ts`).
- **No game engine** — Phaser 3 only. Ignore any Godot/Unity/Unreal references
  in inherited template sub-docs.
- **Hosting**: render.com free tier suspends after ~15 min idle, which can kill
  long bot-vs-bot matches mid-flight — critical side effects (e.g. analytics
  rows) fire per-turn at the event, not at finalize.
```
