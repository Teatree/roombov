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

Dev loop: run `dev:server` and `dev` in parallel. The client hits `http://localhost:5173`; socket traffic is proxied to the server.

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
- `BombermanShopService` / `BombsShopService` — meta-progression shops

Socket event map lives on `GameServer` (`auth`, `join_match`, `player_action`, `loot_bomb`, shop events, etc.). All gameplay-affecting events are validated server-side; clients are not trusted.

### Client flow

`src/client/main.ts` registers Phaser scenes (order is significant): `BootScene → MainMenuScene → LobbyScene → BombermanShopScene → BombsShopScene → MatchScene → ResultsScene`, plus `TutorialOverlayScene` which runs in parallel over `MatchScene`.

Rendering is split into systems under `src/client/systems/` (`MapRenderer`, `BombRenderer`, `FogRenderer`, `BombermanSpriteSystem`, `BombermanAnimations`, `ActivityIndicator`, etc.). `MatchScene` wires them to state updates.

### The `MatchBackend` abstraction (client-side)

`src/client/backends/MatchBackend.ts` is an interface with two implementations:

- `SocketMatchBackend` — production path; forwards actions over Socket.IO and receives authoritative state
- `TutorialMatchBackend` — offline path; runs `resolveTurn` **locally** in the client, scripts bot actions, and drives the `TutorialDirector` (scripted beats, expected-action validation, highlight/reticle overlays)

`MatchScene` talks only to the backend interface, so tutorial and real matches share all rendering and input code. When changing match-facing plumbing, verify **both** backends still compile and that state shape stays serializable.

### Data model

See `src/shared/types/match.ts` for the full `MatchState` shape. Key nouns: `BombermanState`, `Chest`, `DoorInstance`, `DroppedBody`, `ActiveFlare`, `BombInstance`, `FireTile`, `LightTile`, `SmokeCloud`, `Mine`, `PhosphorusPending`. All bomb behavior is data-driven from `src/shared/config/bombs.ts` + `BOMB_CATALOG`; balance constants in `src/shared/config/balance.ts`; chest loot (bombs **and** treasures) in `src/shared/config/chests.ts`.

**Treasures** are the in-match currency picked up from chests + dead bodies (10 types, defined in `src/shared/config/treasures.ts`). Stored as a sparse `TreasureBundle = Partial<Record<TreasureType, number>>` on `Chest`, `DroppedBody`, `BombermanState`, and `PlayerProfile`. Rolled with `rollTreasureLoot` (mirrors `rollBombLoot` — pick K unique types, distribute total by weight). Persistent profile stash is shown by `TreasureListWidget` in MainMenu, MatchScene HUD (top-right), Results, and Gambler Street. Coins (`PlayerProfile.coins`) remain the soft currency for shops but are **not** earned in-match.

Maps are JSON under `public/maps/`, authored in Tiled and converted via `npm run convert-map` (`tools/tiled-to-roombov.ts`). The pipeline expects a `Collision` layer.

### Tests

`tests/` contains Vitest unit tests for the pure systems (`BombResolver`, `LineOfSight`, `Pathfinding`) plus two e2e smoke harnesses. New gameplay logic should be testable as a pure function of state — if it isn't, reconsider the design before adding the test.

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
