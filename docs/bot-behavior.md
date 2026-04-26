# Bot Behaviour

Source: `src/server/BotPlayer.ts` (called once per turn by `MatchRoom`).

## Tunables (`BALANCE.bots`)

| Constant | Value | Effect |
|---|---|---|
| `escapeThreshold` | `0.8` | Switch to escape when ≥ 80 % of `turnLimit` elapsed |
| `chaseTurns` | `3` | Turns to keep chasing after target leaves LoS |
| `predictChance` | `0.33` | Probability of throwing at predicted next-tile instead of current |
| `flareChance` | `0.15` | Per-turn chance to flare an unseen tile while exploring |
| `losRadius` (`match`) | `5` | Bot sight radius (Chebyshev) |
| `bombermanMaxHp` (`match`) | base HP | Compared with current HP for "wounded" gate |

Persistent per-bot state: `aiState`, `targetEnemyId`, `lastSeenEnemyPos`, `prevEnemyPos`, `turnsSinceTargetSeen`, `turnsEnemyVisible`, `exploreTarget`, `seenTiles`.

## Per-turn flow

```
tick()
├─ if dead or escaped → idle
├─ updateVisibility()                  // LoS via DDA, blocked by walls + closed doors
│                                      // + flare-lit tiles always visible
├─ tryLoot()                           // always: stand on chest / body → emit loot for every empty slot
├─ updateAiState()                     // see "State selection" below
└─ dispatch on aiState:
     • escape  → escapeAction
     • fight   → fightAction
     • explore → exploreAction
```

## State selection (priority top-down)

```
? Selector
├─ ESCAPE   if  turnNumber ≥ turnLimit × 0.8
├─ FIGHT    if  enemy visible AND not in smoke
│           AND turnsEnemyVisible ≥ 2          // 1-turn aggro delay
├─ FIGHT    if  was fighting AND target left LoS
│           AND target still alive
│           AND turnsSinceTargetSeen ≤ chaseTurns
└─ EXPLORE  (default)
```

Targeting: locks the first visible enemy as `targetEnemyId`; keeps it until the target dies or `chaseTurns` expires after losing sight. Records `lastSeenEnemyPos` and `prevEnemyPos` (for prediction).

## ESCAPE branch

```
→ Sequence
├─ findNearest(state.escapeTiles) by Chebyshev distance
├─ findPath(me → escape)
└─ pathStep                             // also avoids fire & escape tiles before T/2
```

Falls through to `exploreAction` if no escape tile exists (defensive).

## FIGHT branch

```
? Selector (first match wins)
├─ Wounded retreat
│   if me.hp < maxHp
│   AND (target.hp ≥ me.hp OR being attacked)        // attacked = visible target | bleeding | enemy bomb ≤ 5 tiles
│   ├─ ? Selector
│   │   ├─ throw fart_escape at safe tile           // prefers fart (smoke covers retreat)
│   │   └─ throw ender_pearl at safe tile           // safe tile = random walkable ≥ 5 tiles from any known enemy
├─ Dodge
│   if any bomb with fuseRemaining ≤ 1 covers my tile
│   → moveAway from bomb origin (avoiding fire)
│   if standing on fire → randomMove
├─ Direct attack
│   if target visible AND not smoked
│   ├─ throwTarget = target.pos OR predicted (target + (target − prevPos)) with 33 % chance
│   └─ throw pickAttackSlot() at throwTarget
├─ Lost-target probe (last seen pos exists)
│   ├─ if turnsSinceTargetSeen == 1 AND have flare
│   │       → throw flare at lastSeenPos
│   ├─ if have damage bomb AND turnsSinceTargetSeen ≤ chaseTurns
│   │       → throw pickAttackSlot at lastSeenPos    // blind fire
│   └─ else → pathStep toward lastSeenPos
└─ idle
```

`pickAttackSlot(target?)`:
1. **Stun opener** — if target visible and *not already stunned*, throw `flash`.
2. Else first-available from `[contact, bomb, bomb_wide, delay_tricky, banana, molotov, big_huge]`.
3. Fallback: slot 0 (rock, infinite).

## EXPLORE branch

```
→ Sequence
├─ Dodge   (same as fight branch — bombs ≤ 1 fuse, fire on me)
├─ Speculative flare
│   if rand < flareChance (0.15) AND own ≥ 2 flares
│   → throw flare at random unseen tile within losRadius
├─ exploreTarget refresh
│   if no target OR target now seen OR reached target
│   → pickExploreTarget()                  // 50 random samples, nearest unseen walkable
├─ if have target → pathStep toward it
└─ randomMove                              // 8-direction shuffle, avoids fire & escape tiles before T/2
```

## Movement helper (`pathStep`)

```
→ Sequence
├─ if path empty → idle
├─ if step 0 is escape tile AND turnNumber < turnLimit/2 → idle   // hold position
├─ if step 0 is fire → idle                                       // never walk into fire
├─ if rushActive AND |path| ≥ 2:
│      use rush move(step0, rushTo=step1)
│      ├─ unless step 1 is escape tile (pre-T/2) → drop rush, single step
│      └─ unless step 1 is fire           → drop rush, single step
└─ else single move(step0)
```

## Notes

- **No bomb-placement strategy beyond throws.** Bots never plant defensive mines or motion-detector flares; they only roll those into their inventory if the loot table picks them, and never use them.
- **Smoke is asymmetric.** Bots cannot see enemies inside smoke (matches the player's fog override). Bots will *use* smoke (`fart_escape`) but won't try to break LoS by hiding inside one themselves.
- **No teamwork.** Each bot tracks its own `targetEnemyId`; bots can lock onto each other as well as real players.
- **Loot is greedy.** Every turn, every chest/body the bot is standing on is fully drained into any empty slot. No prioritisation by bomb value.
- **Random tile sampling** drives both `pickExploreTarget` (50 attempts) and `findSafeTile` (20 attempts). On fully-explored or cramped maps these can fail — bot then falls back to `randomMove` / passes.
