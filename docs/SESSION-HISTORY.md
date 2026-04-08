# Roombov — Development Session History

This document captures the full development history so future sessions can pick up where we left off.

---

## Session Date: 2026-03-27

### What Was Built (in order)

#### 1. Initial Prototype (Sprints 0-7)
- **Tech stack**: Phaser 3 + TypeScript + Vite + EasyStar.js
- **Project scaffolding**: package.json, tsconfig, vite.config, entry HTML
- **Shared types**: map.ts, entities.ts, nodes.ts, game-state.ts
- **Balance config**: balance.ts with all tuning knobs
- **First map**: apartment-01.json (40x30 hand-authored)
- **Core systems**: PathfindingSystem, FogOfWarSystem, MovementSystem, BehaviorSystem, CombatSystem, InventorySystem
- **Lightweight ECS**: Entity.ts, World.ts
- **Scenes**: BootScene, PlanningScene, ExecutionScene, ResultsScene
- **Rendering**: MapRenderer, FogOfWarRenderer, EntityRenderer, CameraController

#### 2. First Round of Fixes
- **UI click-through fix**: Added UI_PANEL_WIDTH screen-space check
- **Instant death fix**: Reduced turret atkRad from 10 to 5 tiles
- **HUD**: Added persistent HP bar, loot counter, state label
- **Random spawn**: Player auto-assigned a spawn (no clicking)
- **Timers**: Prep timer (20s countdown), execution timer (3:00)
- **Visual overhaul**: Unique shapes for each node type, legend panel, distinct entity visuals
- **Context menu**: Prevented browser right-click menu on canvas
- **Camera padding**: Extended bounds so map can be panned past HUD

#### 3. Movement Bug (Critical)
- **Spawns on walls**: All edge spawns/exits were on wall tiles (border = all walls). Moved 1 tile inward.
- **EasyStar async mode**: `enableSync()` was missing — callbacks never fired. Added it.
- **MOVE_SEARCH state blocking**: Was setting state='searching' which MovementSystem skipped. Fixed to 'moving'.

#### 4. 3-Exit System + Exit Unification
- Player gets 3 randomly assigned exits per stage
- Removed edge/interior color distinction (all green)
- Interior exits no longer auto-reveal fog

#### 5. Projectile System
- Added Projectile type with damage, targetId, source, impacted, explosionTimer
- Damage applied on impact (not instant)
- Rocket visuals: elongated body, white warhead, exhaust trail, smoke puffs
- Impact explosion: shockwave ring, flash, fireball, sparks
- Muzzle flash on turrets and roombas when firing

#### 6. Line of Sight
- Bresenham raycast through tile grid (LineOfSight.ts)
- Walls and furniture block LOS
- CombatSystem and BehaviorSystem both use LOS checks

#### 7. Roomba Turret Visual
- Added barrelAngle + targetId to RoombaState
- Barrel renders on roomba, aims at target or movement direction
- Muzzle flash at barrel tip

#### 8. Death Animations
- Roomba: 3-second explosion (shockwave, flash, debris, smoke, "DESTROYED" label)
- Turret: 1.5-second smaller explosion + permanent corpse wreck

#### 9. 3-Stage Expedition Loop
- ExpeditionData tracks: currentStage, totalStages, fog, kills, goodies across stages
- Stage flow: Planning → Execution → (die/extract/timeout) → next Planning or Results
- Stage indicator dots in HUD
- Fog, killed turrets, collected goodies persist across stages

#### 10. Enemy/Goodie Persistence Across Stages
- ExpeditionStore: module-level singleton (bypasses Phaser scene data issues)
- Changed from Set to Record<string,boolean> (KeyMap) for reliability
- Dead turrets + collected goodies tracked and skipped in initWorld

#### 11. Discovered Items on Planning Map
- discoveredTurrets/discoveredGoodies KeyMaps
- PlanningScene renders: alive turrets (red markers), dead turrets (corpses), uncollected goodies (yellow diamonds)

#### 12. Dead Roombas Drop Goodies
- On death, inventory items scattered near death position
- Added to droppedGoodies[], marked as discovered
- Next stage can pick them up

#### 13. Randomized Entity Positions
- Removed per-stage spawning from map JSON
- All turrets/goodies randomized ONCE at expedition start via randomizePositions()
- Stored in expedition.turretPositions/goodiePositions
- Positions respect turretZones/goodieZones from Tiled maps

#### 14. Move & Attack Behavior
- Roomba stops and fights when enemy in range with LOS
- MovementSystem halts when state='attacking' and targetId set
- Resumes path after target dies

#### 15. Move & Search Goodie Detour
- Finds uncollected goodies within 3 tiles of the A* path or target node
- Sorts by position along path (travel order)
- Builds composite path: current → goodie1 → goodie2 → node

#### 16. Stop & Search / Stop & Ambush
- Stop & Search: 5 seconds at node, searches for nearby goodies within fog radius
- Stop & Ambush: 8 seconds at node, CombatSystem handles attacks
- Each stop triggers once per node (stoppedAtNode map)

#### 17. Keyboard Shortcuts
- Keys 1-6 select node types in PlanningScene
- Labels show numbers: "1 ○ Move & Search"

#### 18. Goodie Pickup Animation
- 1-second pickup with 'picking_up' state
- Visual: pulsing golden ring, clockwise progress arc, floating "+1" text
- Movement halts during pickup, resumes previous state after

#### 19. Turret Count Reduction
- Changed from [20,40] to [10,20]

#### 20. Tiled Map Editor Integration
- Converter script: tools/tiled-to-roombov.ts
- Reads .tmj, converts tile GIDs, snaps spawns/exits to floor tiles
- TurretZones (rectangles) and GoodieZones (ellipses) → tile bounds
- `npm run convert-map src/shared/maps/custom_map1.tmj`
- Game switched to use custom_map1.json

#### 21. Expedition Lobby System
- **LobbyScene**: Carousel of 3 expedition cards with risk/reward stars, stages, player count, 30s countdown
- **ExpeditionConfig**: id, mapId, risk(1-5), reward(1-5), stages(2-5), seed, turret/goodie ranges
- **ExpeditionManager**: generateExpeditionConfig (correlated risk/reward/stages), generateExpeditionEntities (seeded RNG), ExpeditionScheduler (rolling carousel)
- **Seeded RNG**: Mulberry32 PRNG for deterministic entity placement
- **Dynamic map loading**: loadMapById via import.meta.glob
- **Map manifest**: Registers available maps
- **Balance tables**: risk[1-5] → turret ranges, reward[1-5] → goodie ranges
- **ExpeditionStore refactored**: Keyed Map<string, ExpeditionData> with setActive/getActiveId
- **Scene flow**: BootScene → LobbyScene → PlanningScene → ExecutionScene → ResultsScene → LobbyScene

#### 22. Server + Deployment
- Express server serving built client from dist/
- `npm run build` (Vite build) + `npm start` (Express)
- Ready for Render.com deployment

#### 23. Socket.io Multiplayer
- **GameServer.ts**: Persistent server running ExpeditionScheduler, manages Socket.io rooms per expedition
- **Message protocol**: 13 typed events (listings, join, joined, expedition_start, ready, all_ready, position, players, turret_killed, goodie_collected, goodie_rejected, stage_done, stage_result)
- **NetworkManager.ts**: Client socket singleton with typed wrappers
- **LobbyScene**: Receives listings from server, JOIN sends to server, server assigns spawn/exits
- **ExecutionScene**: Broadcasts position every 100ms, renders other players as ghost roombas, syncs turret kills (broadcast to all), goodie collection (first-come-first-served with rejection), stage transitions coordinated by server
- **PlanningScene**: Emits 'ready', waits for 'all_ready' from server
- **Vite dev proxy**: Port 5173 proxies /socket.io to server on port 3000

---

### Current File Structure (key files)

```
src/
├── client/
│   ├── main.ts                    # Phaser game init, scene registration
│   ├── NetworkManager.ts          # Socket.io client singleton
│   ├── scenes/
│   │   ├── BootScene.ts           # Title → LobbyScene
│   │   ├── LobbyScene.ts          # Expedition carousel (server-driven)
│   │   ├── PlanningScene.ts       # Node placement, ready sync
│   │   ├── ExecutionScene.ts      # Simulation + multiplayer sync
│   │   └── ResultsScene.ts        # Expedition summary
│   └── systems/
│       ├── MapRenderer.ts
│       ├── EntityRenderer.ts      # Roombas, turrets, goodies, projectiles, explosions
│       ├── FogOfWarRenderer.ts
│       └── CameraController.ts
├── server/
│   ├── index.ts                   # Express + Socket.io + GameServer
│   └── GameServer.ts              # Multiplayer game logic
└── shared/
    ├── ExpeditionManager.ts       # Config generation, entity placement, scheduler
    ├── ExpeditionStore.ts         # Keyed expedition state store
    ├── config/balance.ts          # All tuning values + risk/reward tables
    ├── ecs/
    │   ├── Entity.ts
    │   └── World.ts
    ├── maps/
    │   ├── map-manifest.ts        # Available maps registry
    │   ├── map-loader.ts          # loadMap + loadMapById
    │   ├── apartment-01.json
    │   └── custom_map1.json
    ├── systems/
    │   ├── BehaviorSystem.ts      # Node execution, goodie detours, stop behaviors
    │   ├── CombatSystem.ts        # Rockets, damage on impact, LOS
    │   ├── MovementSystem.ts
    │   ├── PathfindingSystem.ts   # EasyStar A* (sync mode)
    │   ├── FogOfWarSystem.ts
    │   ├── InventorySystem.ts     # 1s pickup with animation
    │   └── LineOfSight.ts         # Bresenham raycast
    ├── types/
    │   ├── expedition.ts          # ExpeditionConfig, ExpeditionListing, ExpeditionData
    │   ├── entities.ts            # RoombaState, TurretState, GoodieState, Projectile
    │   ├── game-state.ts          # GameEvent, Phase, FogTile
    │   ├── map.ts                 # MapData, TileType, Zone, MapManifestEntry
    │   ├── messages.ts            # Socket.io message protocol types
    │   └── nodes.ts               # BehaviorNode, NodeType
    └── utils/
        └── seeded-random.ts       # Mulberry32 PRNG
```

### Current Balance Values (balance.ts)
```
Roomba:  HP=10, ATK=2, ATK_SPD=2/s, ATK_RAD=5 tiles, SPD=5, INV=10, FOG=12
Turret:  HP=5, ATK=1, ATK_SPD=1/s, ATK_RAD=5 tiles, DROP=1
Expedition: PREP=20s, EXEC=180s, DEFAULT_STAGES=3, MAX_NODES=10
Map: TILE=32px, TURRETS=[10,20], GOODIES=[20,30]
Risk 1-5: turrets [2,5] → [15,25]
Reward 1-5: goodies [5,10] → [20,30]
Lobby: 3 visible, 5s interval, 30s countdown, 4 max players
```

### Known Issues / Not Yet Implemented
- **Multiplayer not tested end-to-end** — code is written but needs two-tab testing
- **Move & Avoid behavior**: Currently just moves slower, doesn't actively path around turrets
- **Move & Rush damage multiplier**: The 1.1x damage taken is defined in balance but not applied in CombatSystem
- **Move & Avoid HP bonus**: The 1.1x HP is defined but not applied
- **Stop & Ambush**: Waits at node and attacks, but doesn't have the "wait for turret to look away" mechanic from original spec
- **Expedition timer on lobby cards**: Uses absolute startTime — if server restarts, timers reset
- **No player names/colors**: Other players render as identical ghost roombas
- **No anti-cheat**: Client-authoritative simulation (trusted client model)
- **Render.com free tier**: Spins down after 15min inactivity, 30s cold start

### How to Continue Tomorrow

1. **Read this file** for full context
2. **Read `design/gdd/prototype-feedback-log.md`** for the detailed feedback+implementation log
3. **Key commands**:
   - `npm run dev` — Vite dev server (port 5173, proxies to :3000)
   - `npm start` — Production server (port 3000, serves from dist/)
   - `npm run build` — Build client to dist/
   - `npm run convert-map <path>` — Convert Tiled .tmj to Roombov .json
4. **To test multiplayer**: `npm run build && npm start`, open two tabs to localhost:3000
5. **To deploy**: Push to GitHub, Render.com auto-deploys (Build: `npm install && npm run build`, Start: `npm start`)
