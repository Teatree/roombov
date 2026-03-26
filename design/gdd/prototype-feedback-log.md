# Roombov Prototype — Feedback & Implementation Log

This document records every piece of player feedback from the initial prototype session,
what the root cause was, and exactly how it was implemented. Use this as a reference
if the project is ever rebuilt from scratch.

---

## 1. Tech Stack — No Godot, Web-Native Only

**Feedback**: "I never wanted Godot"

**Decision**: The project template had Godot 4.6 configured. The user wanted a browser-playable
game hostable on render.com. Chose Phaser 3 + TypeScript + Vite + EasyStar.js + Socket.io (future).

**Implementation**: `package.json` with phaser, easystarjs, vite, typescript. Vite serves from
`src/client/`, resolves `@shared/` and `@client/` aliases. Monorepo structure: `src/client/`,
`src/server/` (future), `src/shared/`.

---

## 2. Node Placement Behind UI Panel

**Feedback**: "When I click the move mode the nodes get placed behind that UI"

**Root cause**: Left-click handler had no screen-space bounds check — clicks on the UI panel
area (node selector, buttons) propagated to the map and placed nodes.

**Fix**: Added `UI_PANEL_WIDTH = 220` constant. In `handleLeftClick`, first check:
`if (pointer.x < UI_PANEL_WIDTH) return;`. Also added a solid dark background panel
(`Graphics.fillRect`) behind the UI so it's visually clear where the panel boundary is.

---

## 3. Instant Death on Spawn

**Feedback**: "Starting the game I am immediately dying"

**Root cause**: Turret `atkRad` was 10 tiles (320 pixels), covering half the map. Many turrets
were within range of spawn points. Combined with spawns being ON wall tiles (pathfinding
failure), the roomba sat still and got killed.

**Fix**: Reduced `turret.atkRad` from 10 to 5 tiles. Later further balanced to match roomba
`atkRad` of 5 tiles with `fogRevealRadius` of 12 (so player always sees what's shooting).

---

## 4. HP and Goodies Not Visible in HUD

**Feedback**: "Roomba Health should be visible in the hud all the time, same as number of goodies"

**Fix**: Added dedicated HUD elements in both PlanningScene and ExecutionScene:
- HP text + color-coded HP bar (green > yellow > red at thresholds 6, 3)
- Loot counter (`X / 10`)
- Total expedition loot counter
- Current state label
- All as fixed-position (`setScrollFactor(0)`) elements at depth 100.

---

## 5. Random Spawn Assignment

**Feedback**: "Player doesn't choose the first spawn but it's randomly assigned to them"

**Root cause**: Original design had player clicking a spawn to select it.

**Fix**: `PlanningScene.create()` picks a random spawn index on expedition start. Only the
assigned spawn is rendered (with "S" label and highlight ring). Other spawn points are not
shown. The spawn persists across all 3 stages of the expedition.

---

## 6. Missing Timers

**Feedback**: "I don't see timers for either Preparation time or Expedition time"

**Fix**:
- **Prep timer**: Large centered `PREP TIME: Xs` text in PlanningScene. Updates every frame.
  Turns red at 5 seconds. Auto-launches execution when it hits 0.
- **Exec timer**: Large centered `M:SS` countdown in ExecutionScene. Turns red at 30 seconds.
  Ends the stage when it hits 0.

---

## 7. Better Visual Distinction for Game Elements

**Feedback**: "The geometrics are too simple, I need some visual guide to which of them means what"

**Fix**: Complete visual overhaul:
- **Roombas**: Circle body with state-colored ring, inner disc, bumper arc showing movement
  direction, turret barrel aiming at targets, inventory badge
- **Turrets**: Octagonal dark red base, inner square accent, barrel with tip dot, muzzle flash,
  attack radius ring, HP bar, "T" label
- **Goodies**: Yellow diamond/star shape with sparkle center
- **Exits**: Green diamond shapes with "E" label
- **Spawns**: Blue circle with highlight ring and "S" label
- **Legend panel** in PlanningScene showing all symbols
- **Each node type** has a unique shape: circle, diamond, double-circle, arrow, square, crosshair
- Unicode icons in the node palette buttons

---

## 8. Roomba Not Moving (Pathfinding Failure)

**Feedback**: "The roomba doesn't move at all when I press ready"

**Root cause 1 — Spawns on wall tiles**: The entire map border is wall tiles. All spawn points
and edge exits were placed ON the wall (x=0, x=39, y=0, y=29). EasyStar can't pathfind from
an unwalkable tile, so `findPath()` returned empty arrays silently.

**Fix**: Moved all edge spawns and exits 1 tile inward (e.g., x=0 → x=1 for west edge,
x=39 → x=38 for east edge). Verified each target tile is `FLOOR` (0) in the grid.

**Root cause 2 — EasyStar async mode**: EasyStar.js defaults to async mode where `calculate()`
only processes a limited number of iterations per call. The callback never fired within a
single `calculate()` call, so `findPath()` always returned empty.

**Fix**: Added `this.easystar.enableSync()` in PathfindingSystem constructor. This makes
`calculate()` process the entire path synchronously. Confirmed working via Chrome browser
testing.

**Root cause 3 — MOVE_SEARCH state blocking**: `applyNodeBehavior` set MOVE_SEARCH state to
`'searching'`, which MovementSystem was skipping. The roomba had a state that prevented
movement.

**Fix**: MOVE_SEARCH now sets state to `'moving'`. MovementSystem only blocks on `'idle'`,
`'picking_up'`, and `'attacking'` with active target.

---

## 9. Only 1 Exit Visible (Should Be 3)

**Feedback**: "Instead of Player roomba getting 3 exits I see only 1"

**Root cause**: Same wall-tile issue as spawns. Edge exits were on walls. Also, only edge-type
exits had fog revealed — if 2 of 3 random exits were interior type, they were hidden.

**Fix**: Moved all edge exits 1 tile inward. Changed fog reveal to apply to ALL assigned exits
regardless of type.

---

## 10. Right-Click Context Menu

**Feedback**: "Right click does pan, but it also opens the standard browser dropdown"

**Fix**: Added `canvas.addEventListener('contextmenu', e => e.preventDefault())` in
CameraController constructor.

---

## 11. UI Overlapping Map

**Feedback**: "The UI sits on top of a big portion of the map, makes it difficult to place nodes"

**Fix**: Added padding to camera bounds (`-padX` to `worldWidth + padX*2`) so the map can be
scrolled past the UI panel area. Player can right-drag to pan the map anywhere, revealing
areas that were behind the HUD.

---

## 12. No Projectile Visuals

**Feedback**: "It's hard to tell because there are no projectiles"

**Initial fix**: Added visual-only projectiles (colored bullet with white core, trail line).
Damage was still applied instantly.

**Later rework (see #19)**: Full rocket projectile system with damage-on-impact.

---

## 13. Roomba Stops When Hit (Should Keep Moving)

**Feedback**: "Roomba just stops and gets killed, it should move, ignoring the damage"

**Root cause**: In some states, the roomba's path was completing and BehaviorSystem wasn't
re-pathing fast enough. Without visible projectiles, it looked like the roomba froze.

**Fix**: MovementSystem now only blocks movement for explicit states (`idle`, `picking_up`,
`attacking` with active target). In all other states (moving, rushing, avoiding, extracting),
the roomba keeps moving regardless of incoming damage. Turrets deal damage to moving targets
— the roomba absorbs it and continues.

---

## 14. Move & Attack — Stop and Fight

**Feedback**: "If it encounters an enemy it stops and proceeds to shoot at it until either dead"

**Fix**: BehaviorSystem.processRoomba checks: if state is `attacking` AND `hasEnemyInRange()`
returns true → return early (no path advancement, no movement). MovementSystem also checks:
if state is `attacking` AND `targetId !== null` → skip movement. Once the turret dies,
CombatSystem clears targetId, BehaviorSystem stops halting, and roomba resumes its path.

---

## 15. Death Animation Before Results Screen

**Feedback**: "I want some kind of a death animation that lasts like 3 seconds"

**Fix**: When all roombas die, ExecutionScene sets `deathAnimActive = true` with 3-second timer
instead of immediately transitioning. During the animation: expanding orange shockwave rings,
central white flash fading to orange, 8 debris particles scattering outward, dark smoke clouds,
"DESTROYED" label fading in. After 3 seconds, transitions to next stage (or results).

---

## 16. Roomba Turret Visual

**Feedback**: "Add some kind of a turret on the Roomba as well which aims and shoots"

**Fix**: Added `targetId`, `barrelAngle` fields to RoombaState. EntityRenderer draws a gray/silver
barrel line from roomba center, aiming at the current target (or movement direction if no target).
Muzzle flash (blue glow) at barrel tip when `attackCooldown > 70%`. CombatSystem updates
`barrelAngle` to point at the nearest turret with LOS.

---

## 17. 3-Stage Expedition Loop

**Feedback**: "When Roomba dies I get Mission Failed screen, but it should go to the next Stage"

**Fix**: Created `ExpeditionData` type tracking: currentStage, totalGoodiesCollected, roombasLost,
roombasExtracted, fogGrid, assigned exits/spawn. Created `ExpeditionStore` (module-level singleton)
to persist state across Phaser scene transitions. Flow:

```
Stage 1: PlanningScene → ExecutionScene → (die/extract/timeout) → Stage 2
Stage 2: PlanningScene → ExecutionScene → (die/extract/timeout) → Stage 3
Stage 3: PlanningScene → ExecutionScene → (die/extract/timeout) → ResultsScene
```

Fog persists across stages. New exits re-rolled per stage. Same spawn for all stages.
Stage indicator with progress dots in both scenes' HUDs.

---

## 18. Enemies Respawning Between Stages

**Feedback**: "The enemies still respawn on the next Stage"

**Root cause 1 — Staggered spawning**: Map JSON had turrets assigned to stage 1/2/3. `initWorld`
used `filter(t => t.stage <= currentStage)`, so stage 2 introduced NEW turrets that looked like
respawns.

**Fix**: Removed per-stage spawning entirely. ALL turrets and goodies are randomized ONCE at
expedition start via `randomizePositions()` — random floor tiles avoiding spawns, exits, and a
3-tile buffer around the player spawn. Stored in `expedition.turretPositions` and
`expedition.goodiePositions`. Used for all 3 stages.

**Root cause 2 — Set serialization**: Originally used `Set<string>` for killedTurrets/collectedGoodies.
Sets don't survive Phaser's scene data passing.

**Fix**: Changed to `Record<string, boolean>` (KeyMap). Then moved ALL expedition state to a
module-level `ExpeditionStore` singleton, completely bypassing Phaser's scene data mechanism.

---

## 19. Discovered Items Persisting on Planning Map

**Feedback**: "The discovered elements of the map should remain on the map between stages"

**Fix**: Added `discoveredTurrets` and `discoveredGoodies` KeyMaps to ExpeditionData. At stage end,
every turret/goodie on a fog-revealed tile is recorded. PlanningScene renders discovered items:
- **Alive turrets**: semi-transparent red circle + "T" label + faint attack radius fill
- **Dead turrets**: scorch mark + "x" label
- **Uncollected goodies**: semi-transparent yellow diamond
- All drawn at depth 12 so they're visible through the fog overlay.

---

## 20. Dead Roombas Drop Goodies

**Feedback**: "When Player dies they should drop the goodies on the floor"

**Fix**: In `endStage`, if a roomba died with inventory items, each goodie is dropped near the
death position (scattered in a 3x3 grid). Added to `expedition.droppedGoodies[]` and marked
as discovered. Next stage's `initWorld` includes dropped goodies in the goodie pool. A later
roomba can pick them up.

---

## 21. Fewer Enemies

**Feedback**: "Let's reduce the number of enemies to between 10 and 20"

**Fix**: Changed `BALANCE.map.turretCountRange` from `[20, 40]` to `[10, 20]`.

---

## 22. Move & Search Goodie Detour

**Feedback**: "Roomba will build a path through the goodies on the way within 3 squares of the path"

**Fix**: `navigateWithGoodieDetour()` in BehaviorSystem:
1. Compute base A* path from current position to target node
2. Find all uncollected goodies within 3 tiles (Chebyshev distance) of any path tile or the node
3. Sort by position along the base path (travel order)
4. Build composite path: current → goodie1 → goodie2 → ... → node
5. Each segment uses A* pathfinding. Falls back to straight path if inventory full or no goodies.

---

## 23. Stop & Search / Stop & Ambush Working Behaviors

**Feedback**: "Make Roomba spend some time at the spot where they were placed"

**Fix**: Added `stopTimer` to RoombaState. BehaviorSystem:
- **Stop & Search**: On arrival at node, set `state='searching'`, `stopTimer=5`. During timer:
  find nearest uncollected goodie within fogRevealRadius, pathfind to it, pick it up, repeat.
  After 5 seconds, advance to next node.
- **Stop & Ambush**: On arrival, set `state='ambushing'`, `stopTimer=8`. CombatSystem handles
  attacking turrets in range. After 8 seconds, advance.
- Each stop only triggers once per node (`stoppedAtNode` map).

---

## 24. Keyboard Shortcuts for Node Types

**Feedback**: "Each of the move types has a number shortcut on the keyboard"

**Fix**: PlanningScene listens for `keydown` events. Keys 1-6 map to the 6 node types:
1=Move & Search, 2=Move & Attack, 3=Move & Avoid, 4=Move & Rush, 5=Stop & Search,
6=Stop & Ambush. Button labels updated to show the number: `1 ○ Move & Search`.

---

## 25. Goodie Pickup Takes 1 Second With Visual Feedback

**Feedback**: "Picking up goodies takes a second and there is a visual animation"

**Fix**: Added `pickupTimer`, `pickupTargetId`, `previousState` to RoombaState. InventorySystem:
when roomba touches a goodie, set state to `picking_up` for 1 second. Movement halts.
Visual: pulsing golden ring around roomba, clockwise progress arc filling up, floating "+1"
text fading in. After 1 second, goodie collected, state restored.

---

## 26. Spawn Validation — No Entities Inside Obstacles

**Feedback**: "Exits, Spawn Points, Enemies, Goodies can't spawn inside obstacles"

**Fix**: `randomizePositions()` already filters `tile === 0` (floor only). Walls (1), doors (2),
and furniture (3) are excluded. Spawns and exits are hardcoded at known floor tiles in the JSON.

---

## 27. Rocket Projectiles With Damage on Impact

**Feedback**: "Let's make it so both turrets and enemies shoot rockets with damage on hit and explosion"

**Root cause**: Original projectiles were visual-only. Damage was applied instantly when the
turret/roomba fired, then a visual projectile traveled afterward (misleading).

**Fix**: Complete projectile rework. Projectile type now carries: `damage`, `targetId`, `sourceId`,
`source` (turret/roomba), `impacted` flag, `explosionTimer`.

- CombatSystem creates projectile with damage payload, NO instant damage
- Projectile travels at speed 4 (0→1 in 0.25s)
- On `progress >= 1`: `impacted = true`, damage applied to target, death/drop logic runs
- Explosion visual: 0.4s — expanding shockwave ring, white flash, colored fireball, 4 orange sparks
- Rocket visual: elongated body along travel direction, white warhead, orange exhaust trail, gray smoke puffs

---

## 28. Line of Sight

**Feedback**: "Roomba or Turrets shouldn't be able to shoot through walls"

**Fix**: Created `src/shared/systems/LineOfSight.ts` with `hasLineOfSight()` using Bresenham's
line algorithm on the tile grid. Walls and furniture block LOS. Start/end tiles allowed
(entities stand on them).

Applied to:
- CombatSystem: turrets only target roombas with clear LOS, roombas only target turrets with LOS
- BehaviorSystem: Move & Attack only stops to fight if enemy has clear LOS
- Both systems accept the grid at construction time

---

## 29. Empty Path — Skip Stage

**Feedback**: "If Player hadn't chosen any path and prep time expired, go to next Stage"

**Fix**: PlanningScene.update checks `if (this.nodes.length === 0)` when prep timer expires.
Calls `skipStage()` which increments stage, counts as roombasLost++, transitions to next
PlanningScene (or ResultsScene after stage 3).

---

## Stats Location

All tuning values are in `src/shared/config/balance.ts`. Current values at prototype end:
```
Roomba:  HP=10, ATK=2, ATK_SPD=2/s, ATK_RAD=5 tiles, SPD=5, INV=10, FOG=12 tiles
Turret:  HP=5,  ATK=1, ATK_SPD=1/s, ATK_RAD=5 tiles, DROP=1 goodie
Expedition: PREP=20s, EXEC=180s, STAGES=3, MAX_NODES=10
Map: TILE=32px, TURRETS=[10,20], GOODIES=[20,30]
Sim: TICK_RATE=30Hz
```
