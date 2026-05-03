# Bomb Reference Guide

Artist brief for all throwable items in the game. Each entry describes what the item looks like thematically, how it behaves in gameplay, and what visual effects it produces. Use this to design icons, inventory art, and in-world sprites.

---

## General Rules (All Bombs)

- Every Bomberman carries **5 bomb slots**: slots 1-4 are custom (filled from the shop or loot), slot 5 is always **Rock** (infinite, never runs out).
- Each custom slot can hold up to **5 units** of a single bomb type (the stack limit).
- Bombs are **consumed on use** — once you throw all 5, that slot is empty for the rest of the match.
- A Bomberman can throw **one bomb per turn**. The throw replaces movement for that turn (you can move OR throw, not both in a single turn).
- Bombs are thrown at a **target tile** within the player's throw range. They fly in a straight line from the thrower to the target, rotating as they travel. Flight time is half the turn's resolution phase (~0.5 seconds).
- **Damage cap**: even if multiple bombs hit the same Bomberman on the same turn, they take at most **1 damage** that turn.
- Bombermen have **2 HP**. Taking damage also causes **bleeding** (cosmetic blood trail) for 3 turns.
- **Explosions cannot pass through walls.** If a bomb's blast pattern would extend through a wall tile, the explosion stops at the wall. It does not wrap around or leak through.
- **Fog of war**: explosions are always visible to all players even through fog. Decals (scorch marks) are hidden behind the darkest unexplored fog but visible through dimly-lit previously-seen areas.

---

## The Bombs

### 1. Rock
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Blast pattern | Single tile (only the target) |
| Damage | 1 HP to anyone standing on the target tile |
| Supply | Infinite — always available in slot 5 |
| Shop price | Not purchasable |

**Description**: A simple stone. The default fallback weapon every Bomberman always has. Hits only the exact tile you throw it at. No explosion radius, no special effects — just a direct hit. Reliable but weak.

**Visual notes**: Should look like a rough, round stone. Dull gray-brown tones. The "explosion" is a puff of dust/debris, not fire.

**Decal**: Small gray dust smudge on the ground.

---

### 2. Bomb
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse (lands this turn, explodes next turn) |
| Blast pattern | Plus/cross, radius 4 (17 tiles total: center + 4 tiles in each cardinal direction) |
| Damage | 1 HP to anyone in the blast zone when it detonates |
| Supply | Up to 5 per slot |
| Shop price | 25 coins |

**Description**: The standard delay bomb. Lands on the target tile, sits there visibly with a countdown ("1"), and next turn explodes in a long cross pattern reaching 4 tiles in each cardinal direction. Reach is its main strength — the long arms catch enemies trying to flee straight away from it.

**Visual notes**: Classic round bomb shape. Dark blue-black body with blue-white trim. Visible fuse. Explosion is a fiery orange-yellow bloom with embers along each arm.

**Decal**: Dark scorch mark with warm orange center.

---

### 3. Wide Bomb
| Property | Value |
|----------|-------|
| Trigger | 2-turn fuse |
| Blast pattern | 5×5 area blast — circle radius 2, **rays from centre** (walls block; cannot wrap around corners) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 60 coins |

**Description**: A heavier delay bomb that takes 2 turns to detonate but covers a full 5×5 area. Unlike the standard Bomb's plus pattern, this fills the area uniformly — no safe diagonal gaps. Because it uses ray-cast fill, walls and Shield Walls fully block the blast (no corner wrap), so positioning matters: a wall between you and the centre is real cover.

**Visual notes**: Heavier, wider silhouette than the standard Bomb. Dark blue body with warm gold trim. Same orange-yellow fire explosion style but spread over the full 5×5.

**Decal**: Dark scorch mark.

---

### 4. Delay Tricky Bomb
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse |
| Blast pattern | Diagonal X, radius 3 (13 tiles: center + 3 tiles along each diagonal) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 50 coins |

**Description**: Explodes in a long X pattern (diagonals only) instead of a plus. Hits tiles that cardinal-pattern bombs miss, including the corner spots enemies often dodge into to avoid plus blasts.

**Visual notes**: Exotic. Dark purple body with magenta/pink accents. Diamond silhouette rather than round. Explosion is a purple plasma burst with radial lightning spikes — distinctly different from orange fire blasts.

**Decal**: Purple/magenta plasma burn mark with faint star-like streaks.

---

### 5. Contact Bomb
| Property | Value |
|----------|-------|
| Trigger | On contact (instant, same turn as throw) |
| Blast pattern | Plus/cross, radius 1 (5 tiles) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 100 coins |

**Description**: Explodes the instant it lands — zero fuse. Small blast radius, but the enemy has no time to react. A premium aggressive weapon.

**Visual notes**: Volatile-looking. Dark red body with bright red trim and yellow accent. Round shape. Explosion is a quick, intense red-orange bloom.

**Decal**: Dark scorch mark.

---

### 6. Banana
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse, then scatters |
| Blast pattern | Itself: none. Scatters 4 "Banana Pieces" to the 4 diagonal tiles. Each piece then explodes the following turn in plus radius 1 (5 tiles). |
| Damage | 0 on scatter, 1 HP per child explosion |
| Supply | Up to 5 per slot |
| Shop price | 75 coins |

**Description**: A multi-stage bomb. Turn 1: lands on target and sits. Turn 2: splits into 4 Banana Pieces flying to the 4 diagonal tiles. Turn 3: each piece explodes in a small cross. Total coverage is massive but delayed by 2 full turns, giving enemies time to escape — if they notice it.

**Visual notes**: Main banana looks cartoonish (curved). Bright yellow body with brown trim. Banana Pieces are smaller lighter-yellow fragments. Scatter animation is a yellow splat; child explosions are warm yellow-orange fire blooms.

**Decal**: Dark scorch marks from the child explosions (the banana itself leaves no mark).

---

### 7. Flare
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Effect | Lights up a 9×9 square area (circle radius 4) for 3 turns. Lit area shrinks by 1 tile radius after the 2nd turn. |
| Damage | None |
| Supply | Up to 5 per slot |
| Shop price | 25 coins |

**Description**: Utility, not a weapon. Reveals a large area of the fog of war for all players for 3 turns. The Flare is the only throwable that can land on wall tiles without fizzling — it lights the area regardless. A flickering flame appears at the landing tile. Does not break Out-of-Combat Rush.

**Visual notes**: Signal-flare look. Bright white/cream body with orange trim and white accents. Star silhouette. "Explosion" is a bright white flash expanding outward. A single flame persists on the landing tile for 3 turns, dimming over time.

**Decal**: None (light, not fire).

---

### 8. Molotov
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Blast pattern | Plus/cross, radius 1 (5 tiles) |
| Damage | 1 HP on landing, then fire persists for 2 more turns — anyone who walks onto or stands on a burning tile takes 1 HP per turn |
| Supply | Up to 5 per slot |
| Shop price | 150 coins |

**Description**: Premium area-denial. Explodes on impact in a small cross and leaves the ground burning for 2 additional turns. Fire damages any Bomberman touching a tile that turn — forces reroutes or hits.

**Visual notes**: Glass bottle silhouette. Dark green body with lime-green trim and orange accent (wick/flame). Explosion is an orange fire splash. Burning tiles show persistent flickering flames.

**Decal**: Scorched earth — dark blackened ground with charred blotches.

---

### 9. Ender Pearl
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Effect | Teleports the thrower to the landing tile |
| Damage | None |
| Supply | Up to 5 per slot |
| Shop price | 100 coins |

**Description**: Inspired by Minecraft's Ender Pearl. When thrown, the pearl flies to the target and the thrower instantly teleports there. A greenish-blue puff appears at both origin and destination. If the target is unwalkable (wall, closed door, Shield Wall), the destination shifts to the nearest passable tile rather than failing. Does not break Out-of-Combat Rush. Resolves before all other bombs **except Shield** so the thrower escapes danger before any same-turn explosion lands.

**Visual notes**: Dark teal/green orb with luminous shimmer — dark glass with inner glow. Round. Teleport effect is a teal-cyan particle burst (magical energy, not fire). Both origin and destination get the puff.

**Decal**: Teal/cyan-green ring — distinctly non-fire.

---

### 10. Fart Escape
| Property | Value |
|----------|-------|
| Trigger | On contact (instant — but the bomb has no landing entity; it's a self-cast move) |
| Effect | Steps the thrower 2 tiles toward the target along a pathfound route, then deploys an 11×11 smoke cloud (circle radius 5) at the **origin** tile that lasts 4 turns |
| Damage | None |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: A panic button. The thrower moves 2 tiles toward the chosen direction immediately AND drops a thick smoke cloud where they were standing. The smoke blinds anyone inside it (including the thrower if they re-enter) — they can only see their own tile + previously-discovered terrain in dim. Use it to break LoS, escape encirclement, or set up an unseen trap. Path is auto-queued so the thrower keeps walking next turn unless overridden.

**Visual notes**: Small green-brown bottle/canister with a wisp of brown smoke. Smoke cloud is a soft brown-green opacity field that pulses gently and dissipates over the 4 turns. Animation: thrower puffs out smoke as they move.

**Decal**: None (smoke disperses entirely).

---

### 11. Motion Detector Flare
| Property | Value |
|----------|-------|
| Trigger | On contact (instant — arms as a dormant mine, NOT a BombInstance) |
| Effect | Places a Motion Detector mine on the target tile. When an enemy enters Chebyshev radius 3 with line-of-sight, the mine fires an orange Flare (lights up the area, alerts the owner). |
| Damage | None directly |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |
| Lifetime | 50 turns (passive) before auto-trigger |

**Description**: A scout/intel tool. Plant it at a chokepoint or near an objective and forget about it — when an enemy moves into range, the mine flares orange so you know they're there. Doesn't damage anyone; it's purely a detection-and-reveal tool. Owner sees the flare too, so it doubles as a warning system.

**Visual notes**: Small flat disc embedded in the floor with an orange LED-like dot. When triggered, fires a Motion-Detector Flare straight up — same flame visual as the standard Flare but tinted orange.

**Decal**: After triggering, the disc is visibly spent (dim).

---

### 12. Flash
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse |
| Blast pattern | 7×7 square (circle radius 3, BFS-flood) |
| Damage | None — Stuns instead. Caught Bombermen lose their next turn (1 turn of Stunned status). |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: A non-lethal control bomb. Detonates in a wide blue flash that stuns every Bomberman caught in it for 1 full turn — they can't move, throw, or react. Pair with a Contact or Molotov for a guaranteed follow-up hit. Coverage flood-fills around walls (it's a flash of light, not an explosion).

**Visual notes**: Dark blue body with cyan trim, diamond silhouette. Detonation is a bright white-blue flash. Stunned Bombermen show a dazed icon over their head for the next turn.

**Decal**: None (light burst).

---

### 13. Phosphorus
| Property | Value |
|----------|-------|
| Trigger | On contact (instant — reveals on impact, fires spawn next turn) |
| Effect | Lights up an 11×11 area (radius 5, red flare) for 1 turn, then on the FOLLOWING turn scatters burning tiles in a fixed dispersed pattern across the same area. Fires last 2 turns each. |
| Damage | None on impact; 1 HP per turn for any Bomberman standing in a phosphorus fire tile |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: SUPER BOMB. Two-stage: first the impact flash reveals the area (red light, useful as a scout), then a turn later white-hot phosphorus tiles dot the floor in a sparse but wide pattern. Fires are individual tiles (not a contiguous blob), so escape lanes exist if you read the layout. Devastating against entrenched enemies.

**Visual notes**: Heavy white-orange canister with hazard markings. Impact flash is bright red. Phosphorus fire tiles render with a whiter, more intense flame than Molotov.

**Decal**: Bleached/white scorch marks where the fires sat.

---

### 14. Cluster Bomb
| Property | Value |
|----------|-------|
| Trigger | On contact (instant — seeds mines) |
| Effect | Scatters up to 25 cluster mines randomly across an 11×11 area centred on the landing tile. Each mine triggers on touch (Bomberman steps on it → plus radius 1 explosion at that tile). |
| Damage | 1 HP per triggered mine (1-damage cap per Bomberman per turn still applies) |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: SUPER BOMB. Carpet-mines a wide area in a single throw. Mines are invisible to enemies (subject to fog rules) and trigger when stepped on, with a 1-turn shake-then-chain delay if a separate explosion hits them — so you can chain Cluster + standard bombs for dramatic combos. Mines under a Shield Wall sit dormant until the wall shatters.

**Visual notes**: Bulky dark grey canister with multiple smaller bomb silhouettes hinted on the body. Seed animation: small puffs at each mine landing tile. Mines render as small dark bumps on the floor.

**Decal**: Each triggered mine leaves a small scorch mark.

---

### 15. Big Huge
| Property | Value |
|----------|-------|
| Trigger | 2-turn fuse |
| Blast pattern | 11×11 area blast — circle radius 5, **rays from centre** (walls block; cannot wrap around corners) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: SUPER BOMB. The biggest single-blast damage bomb in the game. 2-turn fuse so enemies have time to flee, but the blast covers a full 11×11 area — anyone caught flat-footed dies. Like the Wide Bomb, uses ray-cast fill: walls and Shield Walls actually block it, so positioning + cover matters. A perfect counter to enemies hiding behind a single tile.

**Visual notes**: Massive, ornate dark bomb with multiple fuses or rivets. Detonation is a huge orange-red bloom with a bright white core; shockwave ripples across the full area.

**Decal**: Heavy dark scorch with a bright orange center, larger and more dramatic than the standard Bomb.

---

### 16. Shield Bomb
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Effect | Spawns a + Shield Wall (radius 1, 5 tiles) at the landing tile, lasts 3 turns AFTER placement |
| Damage | None directly. Pushes Bombermen and unexploded bombs out of wall tiles. |
| Supply | Up to 5 per slot |
| Shop price | 1 coin |

**Description**: A defensive bomb that forms a wall of shields on impact. The wall blocks **movement, line of sight, and explosion rays** — anything trying to walk through, see through, or blow through it is stopped cold (the wall tiles themselves take no damage; explosion rays die at the wall's edge). Lasts for 3 full turns after the placement turn, then shatters into a permanent floor decal.

The Shield Bomb is special because it **resolves before all other bomb effects on the same turn — even before the Ender Pearl**. This means:

- **Pushes Bombermen**: any Bomberman standing on a tile that becomes a Shield Wall is teleported to the nearest walkable tile (cannot land on another Bomberman). Yellow puff vfx + light-gray decal at origin and destination.
- **Pushes unexploded bombs**: same logic, but bombs CAN land on tiles occupied by Bombermen.
- **Extinguishes fires**: any fire tiles under the wall are removed entirely.
- **Suppresses phosphorus pending**: phosphorus fires that would spawn under a shield wall are silently dropped.
- **Doesn't trigger mines**: mines under the wall sit dormant until the wall shatters.
- **Bombs slide off**: any bomb thrown at a tile with a Shield Wall slides to the nearest walkable tile (no vfx, just a different landing point).

**Self-targeting allowed**: a player can throw a Shield onto their OWN tile — they get pushed to a neighbor, the wall forms around them.

**Bot AI**: bots use Shield defensively — when an incoming bomb threatens them they throw the shield directly at the bomb to wall it off. Bots refuse to throw a shield if it would leave them with no walkable neighbors (self-trap avoidance).

**Visual notes**: The bomb itself uses the shield icon (frame 3 in `bombs.png`, column 4 row 1). The wall is the same shield icon tiled once per occupied tile. Spawn animation: each tile slams in from above (scale 0→1 + downward translate, ~200ms). On the LAST turn before shatter, the wall shakes subtly. On shatter, sprites fade out and a persistent light-gray shard decal is stamped on each tile.

**Decal**: 3-4 small **bluish triangular pieces** scattered around each tile (drawn via primitives — no sprite asset). On shatter, the wall icon fades out and the pieces "burst" out from the centre with a brief overshoot before settling into their final scattered positions. Persistent for the rest of the match. Always visible once revealed (no fog re-hiding).

**Visibility through fog**: the wall is fog-gated like any other entity (only visible if in LoS or lit by a Flare). A Bomberman inside a smoke cloud only sees the wall if it's in their direct LoS — smoke does not bypass the wall's fog gate.

---

## Blast Pattern Visual Reference

```
SINGLE (Rock)          PLUS r1 (Contact, Molotov)   PLUS r4 (Bomb)
                                                       ....X....
                          .X.                          ....X....
    X                     XXX                          ....X....
                          .X.                          ....X....
                                                       XXXXXXXXX
                                                       ....X....
                                                       ....X....
                                                       ....X....
                                                       ....X....

DIAG r3 (Delay Tricky)        CIRCLE r2 ray-cast (Wide Bomb)
   X.....X                       XXXXX
   .X...X.                       XXXXX
   ..X.X..                       XXXXX  ← 5×5 disc, walls fully block
   ...X...                       XXXXX     (rays from centre)
   ..X.X..                       XXXXX
   .X...X.
   X.....X

CIRCLE r3 flood (Flash 7×7)        CIRCLE r4 flood (Flare 9×9)
   XXXXXXX                          XXXXXXXXX
   XXXXXXX                          XXXXXXXXX
   XXXXXXX                          XXXXXXXXX
   XXXXXXX                          XXXXXXXXX
   XXXXXXX                          XXXXXXXXX  ← walls block, but
   XXXXXXX                          XXXXXXXXX     coverage flood-fills
   XXXXXXX                          XXXXXXXXX     around corners
                                    XXXXXXXXX
                                    XXXXXXXXX

CIRCLE r5 ray-cast (Big Huge 11×11)    CIRCLE r5 flood (Phosphorus reveal,
   XXXXXXXXXXX                          Fart Escape smoke — same disc)
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX  ← walls fully           XXXXXXXXXXX
   XXXXXXXXXXX     block (rays)         XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
   XXXXXXXXXXX                          XXXXXXXXXXX
                                        XXXXXXXXXXX

SCATTER (Banana)              SHIELD WALL (Shield Bomb)
   X...X        ← 4 banana       .S.    ← 5 tiles of solid wall
   .....           pieces land   SSS       (3 turns standing,
   ..B..           here          .S.        then crumbles)
   .....
   X...X        Each piece then
                explodes in PLUS r1
                next turn

PHOSPHORUS FIRE PATTERN (after 1-turn delay) — 11×11 sparse layout:
   .X...X...X.
   XXX.XXX.XXX
   .X...X...X.
   ...X...X...
   .X...X...X.
   XXX.XXX.XXX  ← `.` = bare floor, `X` = burning phosphorus tile
   .X...X...X.
   ...X...X...
   .X...X...X.
   XXX.XXX.XXX
   .X...X...X.
```

`X` = affected tile, `.` = unaffected, `B` = banana center (not affected by the scatter itself), `S` = Shield Wall tile.

**Two fill modes for circles**:
- **Ray-cast** (Wide Bomb, Big Huge) — explosion only reaches tiles with a clear line from the centre. Walls, closed doors, and Shield Walls **fully block**.
- **Flood** (Flare, Phosphorus reveal, Fart Escape smoke, Flash stun) — fills via 8-neighbour BFS. Walls block but coverage diffuses around corners (gas/light bouncing).

---

## Inventory & Economy Summary

| # | Bomb | Type | Fuse | Pattern | Price | Notes |
|---|------|------|------|---------|-------|-------|
| 1 | Rock | Damage | 0 | Single | Free (infinite) | Slot 0 always |
| 2 | Bomb | Damage | 1 | + r4 | 25 | Long arms |
| 3 | Wide Bomb | Damage | 2 | Circle r2 ray-cast (5×5) | 60 | Walls block |
| 4 | Delay Tricky | Damage | 1 | Diag r3 (X) | 50 | Diagonals only |
| 5 | Contact | Damage | 0 | + r1 | 100 | Same-turn |
| 6 | Banana | Damage (delayed) | 1+1 | Scatter ×4 → + r1 each | 75 | 2-turn windup |
| 7 | Flare | Utility (light) | 0 | Circle r4 flood (9×9, 3t) | 25 | Doesn't break Rush |
| 8 | Molotov | Damage + denial | 0 | + r1 fire 2t | 150 | Premium denial |
| 9 | Ender Pearl | Utility (teleport) | 0 | Self only | 100 | Doesn't break Rush |
| 10 | Fart Escape | Utility (escape + smoke) | 0 | Move 2 + smoke r5 (4t) | 1 | Self-cast |
| 11 | Motion Detector Flare | Utility (detection) | 0 | Mine + r3 detection | 1 | 50-turn lifetime |
| 12 | Flash | Control (stun) | 1 | Circle r3 flood (7×7) stun 1t | 1 | No damage |
| 13 | Phosphorus | Damage (delayed fire) | 0 | Reveal r5 + sparse fire 2t | 1 | SUPER |
| 14 | Cluster Bomb | Mine carpet | 0 | 25 mines in 11×11 area | 1 | SUPER |
| 15 | Big Huge | Damage | 2 | Circle r5 ray-cast (11×11) | 1 | SUPER |
| 16 | Shield Bomb | Utility (defensive wall) | 0 | + r1 wall, 3 turns | 1 | Resolves before everything |

**Stack limit**: 5 per slot. **Slots**: 4 custom + slot 0 fixed Rock.

**Internal type** (not player-facing, not in shop): `banana_child` — the 4 sub-bombs spawned by Banana, fuse 1, + r1.

---

## Resolution Order Note

Bombs that all trigger on the same turn (fuse 0 or fuse expiry) resolve in this order:
1. **Shield Bomb** — places its wall and pushes Bombermen/bombs first.
2. **Ender Pearl** — teleports the thrower out of danger.
3. **All others** — FIFO.

Standard per-turn rules still apply afterward: damage cap 1 per Bomberman, fire-tile damage step, etc.

---

## Explosion Ray Semantics

Two fill modes for circle-shape blasts:

- **Ray-cast (damage explosions)** — Wide Bomb, Big Huge. Each tile in the bounding disc is hit only if a clear ray reaches it from the centre (LoS rule, same DDA used for fog-of-war). Walls, closed doors, and Shield Walls block the ray, so an explosion **cannot wrap around a corner**. The strict-corner rule prevents diagonal slip between two walls that meet at a corner.
- **Flood (utility coverage)** — Flare light, Phosphorus reveal, Fart Escape smoke, Flash stun. Fills via 8-neighbour BFS up to the Chebyshev radius. Naturally "diffuses" around corners, which reads as believable for gas/light/concussion. Walls block propagation; Shield Walls fully block; closed doors are included in the footprint but stop further propagation.

Plus and diag shapes (`bomb`, `bomb_wide`'s old shape, `delay_tricky`, `contact`, `molotov`, `banana_child`) already use ray-casting along their cardinal/diagonal axes — unchanged.
