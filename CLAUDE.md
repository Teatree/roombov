# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Roombov** — a turn-based PvP Bomberman-style browser game with a roguelike loot/extraction economy.

- **Runtime**: browser (Phaser 3) + Node.js server (Express + Socket.IO)
- **Language**: TypeScript (strict), ES2020, ESM-only (`"type": "module"`, `.ts` imports with explicit extensions)
- **Bundler**: Vite (client). Server runs directly via `tsx`
- **Tests**: Vitest
- **No game engine** — Phaser 3 only. Ignore any Godot/Unity/Unreal references in sub-docs; engine-specialist agents do not apply here.

## Common commands

```bash
npm run dev          # Vite client dev server on :5173 (proxies /socket.io → :3000)
npm run dev:server   # tsx --watch server on :3000
npm run build        # Vite build → dist/
npm start            # Run built server (serves dist/ + runs Socket.IO)
npm test             # Vitest run (single pass)
npx vitest run tests/BombResolver.test.ts   # Run a single test file
npx vitest --watch                          # Watch mode
npm run typecheck    # tsc --noEmit
npm run convert-map  # tools/tiled-to-roombov.ts (Tiled JSON → map JSON)
```

Dev loop: run `dev:server` and `dev` in parallel. The client hits `http://localhost:5173`; socket traffic is proxied to the server. `src/client/main.ts` exposes the Phaser game on `window.__game` for Playwright / manual scene navigation (e.g. `__game.scene.start('BombsShop')`).

## Architecture

Three top-level source trees under `src/`:

- **`src/shared/`** — engine-agnostic, pure, no DOM / no Phaser / no Node. Both client and server import from here. This is where the game rules live.
- **`src/server/`** — Node-only. Socket.IO, match orchestration, persistence.
- **`src/client/`** — browser-only. Phaser scenes and rendering systems.

Path aliases (configured in `vite.config.ts` and `tsconfig.json`): `@shared/*`, `@client/*`. Imports within `src/shared/` use relative paths with `.ts` extensions (runtime `tsx` requires this).

### The single most important rule: `TurnResolver` is pure

`src/shared/systems/TurnResolver.ts` exports `resolveTurn(state, actions, map) → (nextState, events)`. It is a **pure function** with a fixed 11-step resolution order (movement → interactions → bomb placement → fuse tick → explosions → fire damage → fire/light aging → bleeding → deaths → escapes → end-check). Damage per bomberman is capped per set. Everything derivable from state should be derived, not stored.

**Consequences:**
- Same function runs on the server (authoritative) and the client (tutorial mode — see below).
- New mechanics must be expressed as serializable fields on `MatchState` and applied inside the resolver, in the correct step.
- Do not mutate `state` in callers; `resolveTurn` returns a fresh object the server diffs and broadcasts.
- The module uses top-level mutable ID counters (`bombIdCounter`, etc.) — safe for the tutorial because it only runs one match, but be aware if tests or scripts run multiple matches in one process.

### Server flow

`src/server/index.ts` boots `PlayerStore` (persistent player profiles), then `GameServer`, which owns:

- `MatchScheduler` — lobby carousel of joinable matches with auto-start countdowns
- `MatchRoom` instances — one per active match, owns per-match state and runs `resolveTurn` each turn
- `BombermanShopService` / `BombsShopService` / `FactoryService` — meta-progression shops and crafting
- `BombermanUpgradeService` — spends per-Bomberman SP on CAP/STACK/HP tracks (`upgrade_bomberman` event → `shop_result`)
- `BotPlayer` / `ScavPlayer` — server-side AI: `BotPlayer` is the PvP opponent behaviour tree; `ScavPlayer` drives the loot-stealing Scav NPC

Socket event map lives on `GameServer` (`auth`, `join_match`, `player_action`, `loot_bomb`, shop events, etc.). All gameplay-affecting events are validated server-side; clients are not trusted.

**Gambler Street** is a meta-progression subsystem (seeded RNG, bet state machine): `src/shared/systems/GamblerStreetEngine.ts` runs pure in shared/; `src/shared/config/gambler-street.ts` holds tuning; `src/server/GamblerStreetService.ts` is the authoritative wrapper (lazy ticking, bet resolution, persistence via `PlayerStore`); `src/client/scenes/GamblerStreetScene.ts` renders the UI. **Currently shelved post-NEW_META §8** — scene is unregistered in `src/client/main.ts` but files are preserved for revival.

**Factory** is the active post-NEW_META crafting/production meta system. `src/shared/config/factories.ts` defines 4 named machines with escalating costs and cycle times; machine 4 (`DETONATORIUM`) produces super bombs. `src/client/scenes/FactoryScene.ts` is the 4-machine crafting room. A claimable-bomb badge surfaces on the Factory button in both `MainMenuScene` and `ResultsScene`.

**Analytics** is a server-side, fire-and-forget telemetry pipe to a Google Apps Script web app that appends rows to a Google Sheet — spec in `docs/ANALYTICS-SPEC.md`. `src/server/Analytics.ts` owns four sheets (`MatchResults`, `ProfileSnapshots`, `ScreenEvents`, `TutorialEvents`); column order in each `log*` function must match the spec table, and Apps Script prepends its own timestamp. **No retries/queues/batching, no `await` in hot paths; no-ops silently when `ANALYTICS_WEBHOOK_URL` is unset.** Match rows are emitted per-turn at `match_end` (not at finalize) to survive Render free-tier suspension during long bot matches. `src/server/IpCountryCache.ts` resolves player country once per unique IP via **ip-api.com** (not ipapi.co — it rate-limits datacenter IPs with a 200-status plain-text body); the cache is file-backed and normalizes IPv4-mapped IPv6 first. On the client, `src/client/scenes/sceneAnalytics.ts` exports `trackScreen(scene, name)` — call once in a tracked scene's `create()`; it emits `enter` immediately and auto-queues `exit` on `SHUTDOWN`. Untracked screens (Boot, Match, Tooltip, TutorialOverlay) must not call it.

### Client flow

`src/client/main.ts` registers Phaser scenes (order is significant): `BootScene → MainMenuScene → LobbyScene → BombermanShopScene → BombsShopScene → FactoryScene → MatchScene → ResultsScene → TutorialEndScene → TutorialOverlayScene → TooltipScene → BombermanUpgradeScene`. (`GamblerStreetScene` is intentionally unregistered post-NEW_META §8; see Gambler Street note below.)

- `TutorialEndScene` replaces `ResultsScene` when a match ended via `TutorialMatchBackend` (tutorial awards nothing, so it's a "what to do next" card whose CTA routes to the Bomberman Shop or Lobby depending on whether the player owns any Bomberman).
- `BombermanUpgradeScene` is a modal popup launched with `scene.launch('BombermanUpgradeScene', { ownedId })` from any roster screen. It spends **per-Bomberman SP** (`owned.sp`, not `profile.sp`) on CAP/STACK/HP tracks; every UPGRADE click fires the server-authoritative `upgrade_bomberman` event and re-renders on the returned `profile` snapshot.

Rendering is split into systems under `src/client/systems/` (`MapRenderer`, `BombRenderer`, `FogRenderer`, `BombermanSpriteSystem`, `BombermanAnimations`, `ActivityIndicator`, etc.). Reusable UI widgets also live there (`TreasureListWidget`, `BombShopTooltip`, `TierInfoBadge`, `NotificationBadge`, `BombermanSelector`, `BombIcons`, `TreasureIcons`). `MatchScene` wires the rendering systems to state updates.

### Mobile (responsive browser, not a native app)

Roombov ships as a responsive **browser** build — always landscape, never a separate app. All pieces are **no-ops on desktop**:

- **`src/client/util/isMobile.ts`** — `isMobileDevice()` gates all mobile-only behavior. Resolves via `?mobile=1`/`?mobile=0` URL override first (used for Playwright + forcing on/off a touch laptop), then auto-detects (touch capability **and** `(pointer: coarse)`). Cached once per session; `__setMobileOverrideForTest` for tests.
- **`src/client/util/mobileViewport.ts`** — `installMobileViewport(game)` (called once in `main.ts`). Two concerns: (1) **URL-bar-aware sizing** — Phaser's `Scale.RESIZE` fits the canvas to the `#game` parent, so on visualViewport `resize`/`scroll` we pin `#game` to `visualViewport`'s *visible* px (not `100vh`, which on mobile includes the area under the URL bar and clips the bottom HUD) and call `game.scale.resize`; `index.html` uses `100dvh` as the no-JS baseline. (2) **Portrait gate** — a full-screen DOM overlay ("rotate your device", twisting-phone CSS animation) shown whenever the phone is held portrait; the game stays landscape-only.
- **`src/client/util/responsiveScene.ts`** — menu/UI scenes lay content out in a fixed *design box* (`designViewport(scene, DW, DH)` → `layoutW/layoutH`; anchor edge elements to those, not `this.scale.*`) and `fitSceneToViewport(scene, DW, DH)` scales the scene's main camera to fit short viewports. Call `fitSceneToViewport` at the end of `create()` **and** on `scale.resize`. When the viewport already meets the design size it leaves the camera at zoom 1 / no scroll, so desktop layout is byte-for-byte unchanged. Wired into `MainMenuScene`, `LobbyScene`, `BombermanShopScene`, `BombsShopScene`, `BombermanUpgradeScene`, `TutorialEndScene` (`FactoryScene` has its own custom responsive layout and does not use this).
- **`src/client/systems/MobileControls.ts`** — replaces the PC click-to-act model in-match with a **drag-and-hold** touch scheme. The bottom-right `[MOVE]`/`[ATTACK]` buttons are drag handles: press one and, in the same gesture, drag onto the map (the selector/ghost sticks to the finger); **releasing commits** (a confirm flash plays) — there is no separate confirm/cancel step. Alternatively, **press-and-hold a map tile ~0.5s** to commit a move there, telegraphed by a radial hourglass; a one-finger map press is disambiguated from a pan by movement (travel beyond a forgiving tolerance → pan instead). Pinch zooms. It is a **pure input+presentation layer** — all state mutation goes through the `MobileHooks` bundle built by `MatchScene.buildMobileHooks` (reusing the same server-authoritative BFS path + ghost/trajectory preview the PC build uses; ATTACK throws the currently-armed tray slot). `MatchScene` halves HUD sizing (`hudScale`, `slotSize`, `slotGap`) when `isMobileDevice()` — including the loot panel, which is scaled to match the loadout tray and supports the same tap-loot-then-tap-slot swap as PC.

### The `MatchBackend` abstraction (client-side)

`src/client/backends/MatchBackend.ts` is an interface with two implementations:

- `SocketMatchBackend` — production path; forwards actions over Socket.IO and receives authoritative state
- `TutorialMatchBackend` — offline path; runs `resolveTurn` **locally** in the client, scripts bot actions, and drives the `TutorialDirector` (scripted beats, expected-action validation, highlight/reticle overlays)

`MatchScene` talks only to the backend interface, so tutorial and real matches share all rendering and input code. When changing match-facing plumbing, verify **both** backends still compile and that state shape stays serializable.

### Data model

See `src/shared/types/match.ts` for the full `MatchState` shape. Key nouns: `BombermanState`, `Chest`, `DoorInstance`, `DroppedBody`, `ActiveFlare`, `BombInstance`, `FireTile`, `LightTile`, `SmokeCloud`, `Mine`, `PhosphorusPending`. All bomb behavior is data-driven from `src/shared/config/bombs.ts` + `BOMB_CATALOG`; balance constants in `src/shared/config/balance.ts`; chest loot (bombs **and** treasures) in `src/shared/config/chests.ts`. **Bomberman tiers** (`src/shared/config/bomberman-tiers.ts`) drive inventory slot counts, treasure stack caps, and shop prices per tier — touch this when adjusting character progression.

**Treasures** are the in-match currency picked up from chests + dead bodies (10 types, defined in `src/shared/config/treasures.ts`). Stored as a sparse `TreasureBundle = Partial<Record<TreasureType, number>>` on `Chest`, `DroppedBody`, `BombermanState`, and `PlayerProfile`. Rolled with `rollTreasureLoot` (mirrors `rollBombLoot` — pick K unique types, distribute total by weight). Persistent profile stash is shown by `TreasureListWidget` (horizontal layout, right-aligned) in MainMenu, MatchScene HUD, Results, Bombs Shop, and Factory. Coins (`PlayerProfile.coins`) remain the soft currency for shops but are **not** earned in-match. Persistent `PlayerProfile` instances are stored as JSON files under `production/player-data/` by `PlayerStore`.

Maps are authored in Tiled (`public/maps/*.tmj`) and converted to JSON under `src/shared/maps/` via `npm run convert-map` (`tools/tiled-to-roombov.ts`); the pipeline expects a `Collision` layer. At runtime, `src/shared/maps/map-loader.ts` resolves a map by ID through three strategies in order: static imports (`STATIC_MAPS` — must be edited when adding a shippable map), Vite `import.meta.glob` (browser only, for iteration), and a Node `fs` fallback (server only).

### Tests

`tests/` contains Vitest unit tests: pure systems (`BombResolver`, `LineOfSight`, `Pathfinding`), meta subsystems (`gambler-street-engine`, `gambler-street-rewards`, `loot-roll`, `treasure-roll`, `factory`), and per-mechanic regression suites (`shield-bomb`, `escape-hatch`, `keys`, `uav`, `scav`, `bomberman-upgrade`, `sp-earning`, `confused-move`), plus two e2e smoke harnesses (`e2e-match.ts`, `e2e-smoke.ts` — not auto-run by `npm test`). New gameplay logic should be testable as a pure function of state — if it isn't, reconsider the design before adding the test.

## Conventions

- **`.ts` extensions in imports** are required (ESM + tsx). Do not drop them.
- **Path aliases** (`@shared`, `@client`) are available in client code; `src/shared/` uses relative imports because the server runs it directly.
- **Server-authoritative**: never put gameplay decisions in client code except inside `TutorialMatchBackend`.
- **Derive, don't store**: if something can be computed from `MatchState` each frame, compute it. Only persist what the resolver needs next turn.
- **Seeded RNG**: use `src/shared/utils/seeded-random.ts` for any in-match randomness so tutorials/tests are reproducible.

## Included sub-docs

The following files are auto-included by Claude Code and contain standards, coordination rules, and context-management guidance. They are generic (inherited from the Claude Code Game Studios template) — treat their engine/Godot/agent-studio content as not applicable to this project, but the collaboration protocol and coding/design standards still apply.

@.claude/docs/coordination-rules.md
@.claude/docs/coding-standards.md
@.claude/docs/context-management.md

**Collaboration protocol** (from the template, still in force here): Question → Options → Decision → Draft → Approval. Ask before writing or editing files the user hasn't asked you to change; show drafts or summaries before large changes; never commit without explicit instruction.

**Project documentation** — the following live in `docs/` and are useful cross-tool references:
- `docs/PROJECT-SUMMARY.md` — full context handoff with economy subsystems, character tiers, all meta-progression systems, and per-screen UI inventory
- `docs/NEW_META.md` — locked spec for the May 16-17 meta reset (stack +2, coins in chests, treasure trim, keys in chests, bot rework, all-paid pricing, tutorial updates, Factory). Authoritative when this file or memory drifts.
- `docs/keys-system.md` — keys/escape-hatch design (12 keys per match distributed across chests by tier weight, 3 keys per player to escape; see `BALANCE.keys` in `src/shared/config/balance.ts`)
- `docs/escape-hatch-rework.md` — current hatch behavior and UX (lock badge, ready-to-escape indicator)
- `docs/bot-behavior.md` — AI behavior tree and decision-making for `BotPlayer.ts`
- `docs/BOMB_SHOP_CHANGE.md` — Bombs Shop three-panel redesign spec (implemented; kept for reference on tooltip / category / panel intent)
- `docs/sprite-animation-guide.md` — sprite-sheet authoring + `BombermanAnimations` conventions
- `docs/ANALYTICS-SPEC.md` — analytics event schema: the four Google-Sheet tabs and exact per-row column order (see Analytics under Server flow)
- `docs/MOBILE.md` — full reference for the mobile (responsive-browser) build: every difference from desktop, the `isMobileDevice()` gate, viewport/portrait handling, `hudScale`, the drag-and-hold touch controls, and tuning constants. Read before touching any mobile code (expands on the "Mobile" subsection above).
