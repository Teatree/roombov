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

### 2. Delay Bomb
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse (lands this turn, explodes next turn) |
| Blast pattern | Plus/cross shape, radius 2 (9 tiles total: center + 2 tiles in each cardinal direction) |
| Damage | 1 HP to anyone in the blast zone when it detonates |
| Supply | Up to 5 per slot |
| Shop price | 20 coins |

**Description**: A ticking bomb with a 1-turn delay. Lands on the target tile and sits there visibly with a countdown number ("1") displayed on it. Next turn, it explodes in a cross pattern reaching 2 tiles out in each cardinal direction (north/south/east/west). Enemies can see it and try to move out of the way.

**Visual notes**: Classic round bomb shape. Dark blue-black body with blue-white trim. Should have a visible fuse. The explosion is a fiery orange-yellow bloom with embers.

**Decal**: Dark scorch mark with warm orange center.

---

### 3. Delay Bomb Big
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse |
| Blast pattern | Plus/cross shape, radius 3 (13 tiles total) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 35 coins |

**Description**: A larger, more powerful version of the Delay Bomb. Same 1-turn delay, but the cross pattern reaches 3 tiles in each cardinal direction instead of 2. Covers significantly more ground.

**Visual notes**: Should look noticeably bigger/heavier than the standard Delay Bomb. Darker body with orange-amber trim. The explosion is the same fiery bloom but larger and with more embers.

**Decal**: Same dark scorch mark as standard delay, slightly more dramatic.

---

### 4. Wide Delay Bomb
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse |
| Blast pattern | 3x3 square (9 tiles: the center tile plus all 8 surrounding tiles) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 30 coins |

**Description**: Instead of a cross/plus pattern, this bomb blasts every single tile around where it lands — a full 3x3 square. Great for area denial since there's no safe gap in the diagonals like the standard Delay Bomb has.

**Visual notes**: Should look wider/flatter than a standard Delay Bomb to suggest its spread pattern. Dark blue body with warm gold trim. Same fiery explosion style.

**Decal**: Dark scorch mark.

---

### 5. Delay Tricky Bomb
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse |
| Blast pattern | Diagonal X shape, radius 1 (5 tiles: center + 4 diagonal neighbors) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 25 coins |

**Description**: Explodes in an X pattern (diagonals only) instead of a plus. Hits tiles that other bombs miss. Useful for catching enemies who dodge into diagonal tiles to avoid standard cross-pattern bombs.

**Visual notes**: Should look exotic/unusual. Dark purple body with magenta/pink accents. Diamond-shaped silhouette rather than round. The explosion is a purple plasma burst with radial lightning spikes — distinctly different from the orange fire explosions.

**Decal**: Purple/magenta plasma burn mark with faint star-like streaks.

---

### 6. Contact Bomb
| Property | Value |
|----------|-------|
| Trigger | On contact (instant, same turn as throw) |
| Blast pattern | Plus/cross shape, radius 1 (5 tiles: center + 1 tile in each cardinal direction) |
| Damage | 1 HP |
| Supply | Up to 5 per slot |
| Shop price | 30 coins |

**Description**: Explodes the instant it lands — no fuse delay. Smaller blast radius than a Delay Bomb, but the enemy has zero time to react. A direct, aggressive weapon.

**Visual notes**: Should look volatile/dangerous. Dark red body with bright red trim and yellow accent. Round shape. The explosion is a quick, intense red-orange bloom.

**Decal**: Dark scorch mark.

---

### 7. Banana
| Property | Value |
|----------|-------|
| Trigger | 1-turn fuse, then scatters |
| Blast pattern | Itself: none. Scatters 4 "Banana Pieces" to the 4 diagonal tiles. Each piece then explodes next turn in a plus/cross radius 1 (5 tiles). |
| Damage | 0 on scatter, 1 HP per child explosion |
| Supply | Up to 5 per slot |
| Shop price | 45 coins |

**Description**: A multi-stage bomb. Turn 1: lands on target and sits. Turn 2: splits into 4 Banana Pieces that fly to the 4 diagonal tiles. Turn 3: each piece explodes in a small cross pattern. Total coverage is massive but delayed by 2 full turns, giving enemies time to escape — if they notice it.

**Visual notes**: The main banana should look like a cartoonish yellow banana (curved shape). Bright yellow body with brown trim. The "Banana Pieces" are smaller, lighter yellow fragments. The scatter animation is a yellow splat. Child explosions are warm yellow-orange fire blooms.

**Decal**: Dark scorch marks from the child explosions (the banana itself leaves no mark, only its children do).

---

### 8. Flare
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Effect | Lights up a 9x9 square area (radius 4) for 3 turns. The lit area shrinks by 1 tile radius after 2 turns. |
| Damage | None |
| Supply | Up to 5 per slot |
| Shop price | 15 coins |

**Description**: A utility item, not a weapon. Reveals a large area of the fog of war for all players for 3 turns. The Flare is the only throwable that can land on wall tiles without fizzling — it lights up the area regardless. A flickering flame appears at the landing tile. No damage dealt.

**Visual notes**: Should look like a signal flare or firework — bright white/cream body with orange trim and white accents. Star-shaped silhouette. The "explosion" is a bright white flash that expands outward. A single flame persists on the landing tile for 3 turns, getting dimmer over time.

**Decal**: None (light, not fire).

---

### 9. Molotov
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Blast pattern | Plus/cross shape, radius 1 (5 tiles) |
| Damage | 1 HP on landing, then the fire persists for 2 more turns — anyone who walks onto or stands on a burning tile takes 1 HP damage per turn |
| Supply | Up to 5 per slot |
| Shop price | 40 coins |

**Description**: Area denial weapon. Explodes on impact in a small cross and leaves the ground burning for 2 additional turns. The fire is dangerous — any Bomberman touching a fire tile takes damage that turn. Forces enemies to reroute or take hits.

**Visual notes**: Should look like a glass bottle with liquid inside. Dark green body with lime-green trim and orange accent (the wick/flame). Bottle-shaped silhouette. The explosion is an orange fire splash. Burning tiles show persistent flickering flames.

**Decal**: Scorched earth — dark blackened ground with charred blotches.

---

### 10. Ender Pearl
| Property | Value |
|----------|-------|
| Trigger | On contact (instant) |
| Effect | Teleports the thrower to the landing tile |
| Damage | None |
| Supply | Up to 5 per slot |
| Shop price | 50 coins |

**Description**: Inspired by Minecraft's Ender Pearl. When thrown, the pearl flies to the target tile and the thrower is instantly teleported there. A greenish-blue puff of particles appears at both the origin and destination. If the target tile is a wall (thrown blind into fog of war), the teleportation shifts to the nearest walkable tile instead of failing.

**Visual notes**: Should look like a dark teal/green orb with a luminous shimmer — think dark glass with an inner glow. Round shape. The teleport effect is a teal-cyan particle burst (not fire, more like magical energy). Both the departure point and arrival point get the puff.

**Decal**: Teal/cyan-green mark — a dim glowing ring, distinctly different from fire-based scorch marks.

---

## Blast Pattern Visual Reference

```
SINGLE (Rock)          PLUS r1 (Contact)       PLUS r2 (Delay)
                         .X.                     ..X..
    X                    XXX                     ..X..
                         .X.                     XXXXX
                                                 ..X..
                                                 ..X..

PLUS r3 (Delay Big)    DIAG r1 (Tricky)        CIRCLE r1 (Wide Delay)
   ...X...               X.X                     XXX
   ...X...               .X.                     XXX
   ...X...               X.X                     XXX
   XXXXXXX
   ...X...
   ...X...
   ...X...

CIRCLE r4 (Flare)      SCATTER (Banana)
   XXXXXXXXX             X...X        <- 4 banana pieces land here
   XXXXXXXXX             .....           (diagonals from center)
   XXXXXXXXX             ..B..        <- banana center
   XXXXXXXXX             .....
   XXXXXXXXX             X...X
   XXXXXXXXX
   XXXXXXXXX                          Each piece then explodes
   XXXXXXXXX                          in PLUS r1 next turn
   XXXXXXXXX
```

`X` = affected tile, `.` = unaffected, `B` = banana center (not affected by the scatter itself)

---

## Inventory & Economy Summary

| Bomb | Type | Fuse | Pattern | Price | Rarity hint |
|------|------|------|---------|-------|-------------|
| Rock | Damage | 0 | Single | Free (infinite) | Always available |
| Delay Bomb | Damage | 1 | + r2 | 20 | Very common |
| Delay Bomb Big | Damage | 1 | + r3 | 35 | Uncommon |
| Wide Delay Bomb | Damage | 1 | 3x3 square | 30 | Uncommon |
| Delay Tricky | Damage | 1 | X r1 | 25 | Moderate |
| Contact Bomb | Damage | 0 | + r1 | 30 | Common |
| Banana | Damage (delayed) | 1+1 | Scatter x4 | 45 | Uncommon |
| Flare | Utility | 0 | Light 9x9 | 15 | Common |
| Molotov | Damage + area denial | 0 | + r1 fire 2t | 40 | Moderate |
| Ender Pearl | Utility (teleport) | 0 | Self only | 50 | Rare |

**Stack limit**: 5 per slot. **Slots**: 4 custom + 1 fixed Rock.
