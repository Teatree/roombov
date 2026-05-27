# Explosion sprite animation

Replaces the hand-drawn per-tile blast (`fireBoom` / `plasmaBurst`) with a shared 8-frame sprite-sheet animation for a defined list of bombs. Drop-in: same per-tile dispatch, same duration window, same layer (above fog), same smoke/decal follow-ups.

## Asset

- **Path**: `public/sprites/explosion_sprite_sheet.png`
- **Size**: 384 × 48 px, 8 horizontal frames of 48 × 48 each
- **Texture key**: `explosion_sprite`
- **Loaded in**: `src/client/scenes/MatchScene.ts` — `preload()`, alongside `escape_hatch`
- **Animation key**: `explosion_sprite_anim` (registered in `MatchScene.create()`)

Sprite is scaled to the current `tileSize` via `setDisplaySize(ts, ts)` at play time, so 48-px source frames render at whatever the match's tile size is.

## Bombs that use it

| Catalog `type`   | Display name        | Notes                                              |
| ---------------- | ------------------- | -------------------------------------------------- |
| `bomb`           | Bomb                | Plus radius 4                                      |
| `bomb_wide`      | Wide Bomb           | 5×5 Chebyshev disc                                 |
| `contact`        | Contact Bomb        | Also covers exploding cluster mines                |
| `banana_child`   | Banana Piece        | The four scattered children, not the initial throw |
| `big_huge`       | Big Huge            | Large blast                                        |
| `delay_tricky`   | Delay Tricky Bomb   | Tinted `0xcc66ff` (purple), replaces `plasmaBurst` |

Driven by the `SPRITE_EXPLOSION_TYPES` set at the top of `src/client/systems/BombRenderer.ts`.

**Untouched** (intentionally): `rock` (`rockDust`), `flash` (its blue `fireBoom`), `flare` (`flareFlash`), `molotov` (`fireSplash`), `phosphorus`, `cluster_bomb` initial impact (`spawnClusterCylinder`), `banana` initial splat (`bananaSplat`), `ender_pearl`, `fart_escape`, `motion_detector_flare`, `shield`.

### Cluster mines

Cluster mines explode via `MatchScene.ts:1462`, which calls `spawnExplosion('contact', ...)`. Because `contact` is in `SPRITE_EXPLOSION_TYPES`, cluster mine explosions inherit the new sprite for free — no separate plumbing needed.

## Adding another bomb to the sprite path

1. Add the catalog type to `SPRITE_EXPLOSION_TYPES` (top of `BombRenderer.ts`).
2. Add a `case 'foo': this.spriteExplosion(tile, dur); break;` in `spawnExplosion()`'s switch.

That's it — the wave effect, the layer, the smoke follow-up, and the decal stamp all apply automatically.

## Tinting

Pass `{ tint: 0xRRGGBB }` as the third arg to `spriteExplosion`. Phaser applies a multiplicative tint to the whole sprite. Currently used only for `delay_tricky`. To add a new tinted variant, follow the `delay_tricky` case as a template, and consider declaring the tint as a named constant alongside `DELAY_TRICKY_TINT` for clarity.

## Wave effect

Per-tile sprite explosions can fan out from the bomb center in a wave. Each tile is delayed by `stepDist × EXPLOSION_WAVE_MS_PER_STEP`, where `stepDist` is the Chebyshev distance (`max(|dx|, |dy|)`) from the bomb's center tile. The source tile (`stepDist = 0`) fires immediately; each subsequent ring follows.

### Tunable constants (top of `BombRenderer.ts`)

| Constant                       | Default | Purpose                                                              |
| ------------------------------ | ------- | -------------------------------------------------------------------- |
| `EXPLOSION_WAVE_ENABLED`       | `true`  | Master toggle. Set `false` to spawn all tiles simultaneously.        |
| `EXPLOSION_WAVE_MS_PER_STEP`   | `33`    | Per-ring delay in ms. 33 ms is "almost imperceptible"; 50–80 reads more obviously as a wave. |

### Why Chebyshev

Every bomb shape currently in the catalog (`plus`, `circle`, `diag`, `single`) maps cleanly to ring indices via `max(|dx|, |dy|)`:

- A plus-radius-N blast has rings 0…N along each axis arm.
- A Chebyshev `circle` of radius N has rings 0…N where ring K is a hollow square at distance K.
- A `diag` of radius N has rings 0, 1, …, N at the diagonal tiles (Chebyshev still works: the four diagonals at distance K are all ring K).

This means the wave is consistent regardless of bomb shape.

### Scope

The wave is gated on `SPRITE_EXPLOSION_TYPES.has(type)`, so the legacy renderers (`rockDust`, `flareFlash`, `fireSplash`, `fireBoom` for `flash`) still spawn all tiles simultaneously. If you want to extend the wave to legacy types, move the wave block out of that gate.

## Timing

The sprite animation plays at a **fixed frame rate**, not stretched to the parent burst window. `explosion_sprite_anim` is registered in `MatchScene.create()` with `frameRate: 12`, so 8 frames ≈ 667 ms regardless of `transitionPhaseSeconds`. `spriteExplosion` calls `sprite.play('explosion_sprite_anim')` without passing a `duration` override, so the registered frameRate is what plays.

The `durationMs` argument is accepted for call-site symmetry with the other per-tile renderers but is ignored here. It's intentionally fine for the sprite to outlast the parent `spawnExplosion`'s `burstDurationMs` (~70% of transition) — the spec is "fixed visual length, looks good on its own". To change the playback speed, edit the `frameRate` on the `this.anims.create({ key: 'explosion_sprite_anim', ... })` call in `MatchScene.create()`.

Decals (`stampAllDecals` at `dur * 0.5`) and smoke (`spawnSmoke` at `dur * 0.7`) are scheduled by the parent and still use the unscaled `dur` — they fire on the same schedule as before.

## Layering and fog of war

`spriteExplosion` adds the sprite to `BombRenderer.explosionLayer`, the same container that `fireBoom` uses. `explosionLayer` is at depth 120 in MatchScene's stack — above the fog overlay. Sprite explosions therefore render through fog, identical to the previous behavior. There is intentionally no `fogRenderer.isVisible(...)` gate — the user spec is "works the same way as the previous explosions."

## Smoke and decals

`spawnExplosion()` schedules two follow-ups around the per-tile dispatch:

- `stampAllDecals()` at `startDelayMs + dur * 0.5` (mid-burst peak): stamps the scorch/blood decal for each affected tile.
- `spawnSmoke()` at `startDelayMs + dur * 0.7`: lingering smoke puff per tile.

Both run unconditionally for sprite-path bombs (no opt-out flag added). If a future sprite-explosion bomb shouldn't stamp a decal, add it to the early-return list in `stampAllDecals()`.

## File reference

- **`src/client/scenes/MatchScene.ts`** — sprite-sheet preload (~line 351), animation creation (~line 456 in `create()`).
- **`src/client/systems/BombRenderer.ts`** — wave constants + `SPRITE_EXPLOSION_TYPES` (top of file), `spawnExplosion()` switch + wave gate, `spriteExplosion()` method.
- **`src/shared/config/balance.ts`** — `match.transitionPhaseSeconds` (current 2s) drives `burstDurationMs`.

## Verification

1. `npm run typecheck` — must pass.
2. `npm test` — 146 tests should remain green (pure resolver tests don't touch the renderer).
3. Manual in browser (`npm run dev` + `npm run dev:server`):
   - Throw a **Bomb** — sprite plays on each plus-shape tile, fans out from center.
   - Throw a **Wide Bomb** — 5×5 area, larger wave.
   - Throw a **Delay Tricky** — purple-tinted sprite on the diagonal tiles.
   - Throw a **Cluster Bomb** — initial cylinder is unchanged; when mines later trigger, the contact-explosion sprite plays.
   - Throw a **Banana** — initial splat unchanged; child bananas detonate with the sprite.
   - Throw a **Contact** and **Big Huge** — sprite + wave.
   - Set `EXPLOSION_WAVE_ENABLED = false`, repeat one bomb — all tiles burst together.
   - Explode in fog — sprite still renders (same as before the change).
