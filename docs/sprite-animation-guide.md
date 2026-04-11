# Sprite Animation Guide (Phaser 3)

How to add an animated sprite to the game. This is the workflow for the
escape hatch, but it applies to any animated entity (bombs, enemies, etc.).

## The mental model

Phaser animations work in three steps:

1. **Load** the spritesheet PNG and tell Phaser how to slice it into frames.
2. **Define** named animations (e.g. `hatch_opening`) as sequences of frame indices.
3. **Play** an animation on a `Sprite` game object.

A `Sprite` is a single game object. Its current frame comes from whichever
animation is playing. You can change animations at runtime with `.play('key')`.

## Step 1 — Prepare the spritesheet

A Phaser spritesheet is a regular PNG with frames arranged in a grid. Every
frame must be the **same size** and there should be **no spacing or margin**
unless you explicitly configure them.

The simplest layout is a single horizontal row: N frames of size W×H.

**Check your file size on disk** before doing anything:

```bash
node -e "const b=require('fs').readFileSync('YOUR_FILE.png'); console.log(b.readUInt32BE(16)+'x'+b.readUInt32BE(20));"
```

If the file is 288x32 and you have 6 frames, each frame is 48x32.
If the file is 192x32 and you have 4 frames, each frame is 48x32.
Always divide total width by frame count — that's your `frameWidth`.

**Where to put it:** `public/sprites/your_thing.png`. Files in `public/` are
served by Vite as static assets at runtime. The scene loads them by relative
path.

## Step 2 — Load in `preload()`

Phaser scenes have a `preload()` lifecycle method that runs before `create()`.
This is where you tell Phaser "fetch this file and slice it into frames":

```ts
preload(): void {
  this.load.spritesheet('escape_hatch', 'sprites/escape_hatch.png', {
    frameWidth: 48,
    frameHeight: 32,
  });
}
```

- **First arg** (`'escape_hatch'`) is the **texture key** you'll reference later.
  Make it unique within the scene.
- **Second arg** is the URL relative to `public/`.
- **Third arg** defines how Phaser slices the image. Add `margin` and `spacing`
  if your sheet has borders or gaps between frames. For a clean grid, omit them.

After load, Phaser has a texture with N numbered frames: `0, 1, 2, ... N-1`.
For a 288×32 sheet with `frameWidth: 48`, that's frames 0..5.

## Step 3 — Define animations in `create()`

Once the texture is loaded, register named animations. Do this in `create()`
(after preload completes, before you create any sprites). Each animation is
a sequence of frame indices plus playback config:

```ts
create(): void {
  // ... other setup ...

  // Idle state — single frame, loops forever (a no-op loop)
  this.anims.create({
    key: 'hatch_closed',
    frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 0 }),
    repeat: -1,
  });

  // Opening animation — plays frames 0 through 5 at 10 fps, then stops
  this.anims.create({
    key: 'hatch_opening',
    frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 5 }),
    frameRate: 10,
    repeat: 0, // play once
  });

  // Open idle — holds on the last frame forever
  this.anims.create({
    key: 'hatch_open',
    frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 5 }),
    repeat: -1,
  });

  // Closing — reverse of opening
  this.anims.create({
    key: 'hatch_closing',
    frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 0 }),
    frameRate: 10,
    repeat: 0,
  });
}
```

**Key config fields:**

- `key` — unique animation name. You'll `sprite.play('key')` with it.
- `frames` — an array of `{ key, frame }` pairs. `generateFrameNumbers` is a
  helper that builds this for a range of frame indices on a single texture.
- `frameRate` — frames per second. Omit for single-frame idle animations.
- `repeat` — how many times after the first play. `0` = play once, `-1` =
  loop forever, `5` = play 6 times total.

## Step 4 — Create a sprite and play the default animation

```ts
const sprite = this.add.sprite(worldX, worldY, 'escape_hatch');
sprite.setDepth(15);            // render order — higher = on top
sprite.play('hatch_closed');    // start on the default animation
```

- `this.add.sprite(x, y, key)` creates a new Sprite at world pixel coords.
- `setDepth(n)` controls draw order. See the depth table below.
- `play(key)` starts the named animation.

**Sizing:** By default the sprite draws at the frame's native pixel size. To
scale it to fit map tiles, use `setDisplaySize(width, height)`:

```ts
// Make the 48x32 frame cover 3 tiles wide × 2 tiles tall on a 16px tile map
sprite.setDisplaySize(16 * 3, 16 * 2);
```

**Origin (anchor point):** Default is `(0.5, 0.5)` — the sprite's center.
`setOrigin(0, 0)` makes it top-left anchored. For a hatch that should sit
ON a specific tile with the center of the sprite aligned to the center of
that tile, keep the default `(0.5, 0.5)`.

## Step 5 — Change animations at runtime

Call `sprite.play('key')` to switch. To run code when an animation finishes,
listen for `animationcomplete`:

```ts
sprite.play('hatch_opening');
sprite.once('animationcomplete', () => {
  sprite.play('hatch_open');
});
```

`once` auto-removes the listener after the first call. If you use `on`, the
listener fires every time any animation completes — and you'll leak listeners.
Always prefer `once` for one-shot handlers.

## Step 6 — Clean up on scene shutdown

Sprites added with `this.add.sprite` are automatically destroyed when the
scene shuts down. But if you hold references (e.g. in `this.escapeSprites`),
clear those arrays in your scene's `shutdown()` method:

```ts
shutdown(): void {
  for (const s of this.escapeSprites) s.sprite.destroy();
  this.escapeSprites = [];
  // ...other cleanup...
}
```

## Where this code lives in our project

All of the above goes in **[src/client/scenes/MatchScene.ts](../src/client/scenes/MatchScene.ts)**:

| What | Where |
|---|---|
| `preload()` — load spritesheet | `MatchScene.preload()` near the top |
| `anims.create()` — register animations | `MatchScene.create()` — there's a `// TODO(you)` comment marking the spot |
| Create sprites per escape tile | Inside `onMatchState`, where the map renderer is constructed (search for `mapRenderer.renderEscapeTiles`). Replace that call with your sprite-creation loop. |
| Animation state machine | There's already a `updateEscapeHatches()` method in `MatchScene` — it looks at `this.escapeSprites` and transitions between `closed → opening → open → closing` based on Bomberman proximity. It only runs when `escapeSprites.length > 0`, so it's a no-op until you populate that array. |
| Cleanup | Already handled in `MatchScene.shutdown()` — it iterates `this.escapeSprites` and destroys each one. |

The `escapeSprites` array is already declared:

```ts
private escapeSprites: Array<{
  x: number; y: number;
  sprite: Phaser.GameObjects.Sprite;
  state: 'closed' | 'opening' | 'open' | 'closing';
}> = [];
```

So your job is basically: load the spritesheet, define the animations, and
push objects into `escapeSprites` with the right initial state. The state
machine does the rest.

## Dual-camera gotcha

The scene uses two cameras: `this.cameras.main` (the world, which zooms/pans)
and `this.hudCamera` (the HUD, which never zooms). World sprites should only
render on the main camera. Every world object needs to be "ignored" by the
HUD camera or it'll appear frozen in screen space.

For sprites, after creating them:

```ts
if (this.hudCamera) this.hudCamera.ignore(sprite);
```

Do this for every sprite you create.

## Depth layering reference

The scene uses explicit depths to control draw order:

| Depth | Contents |
|---|---|
| 0 | Map tiles (tilemap layers) |
| 15 | Escape hatches (suggested) |
| 50 | Fog of war overlay |
| 60 | Path line |
| 80 | Bomb layer (placed bombs, explosions, flare flames) |
| 100 | Entity layer (Bombermen, coin bags, pickups) |
| 150 | Highlights (aim/move targets) |
| 1000+ | HUD (top bar, bomb tray, loot panel) |

Place your sprites below entities (so Bombermen stand on top of the hatch)
but above the map. 15 is a good default.

## Debugging tips

**Sprite shows as a big colored box or slices look wrong:**
Your `frameWidth` / `frameHeight` don't match the actual file. Re-check the
PNG dimensions. Total width ÷ frame count = `frameWidth`.

**"Cannot read properties of undefined":**
Usually means the texture didn't load (wrong path) or the animation key
doesn't exist. Check the browser console for Phaser load errors.

**Animation plays once and gets stuck:**
`repeat: 0` means play once and stop on the last frame. If you want to then
idle on that frame, use an `animationcomplete` handler to switch to a
single-frame looping animation.

**Sprite is invisible:**
Depth is probably below the fog layer (50). Set depth to 15 or higher.
Or you forgot `this.hudCamera.ignore(sprite)` and it's being rendered only
on the HUD camera offscreen.

**Sprite is frozen in place when I scroll the camera:**
You forgot to exclude it from the HUD camera. Or you accidentally called
`setScrollFactor(0)` on it (which locks it to screen space).

## The absolute minimum working example

Paste this into `MatchScene.create()` after all the existing setup code to
get a single test sprite playing an animation. If this works, you know the
load path is correct and you can build from there:

```ts
this.anims.create({
  key: 'test_anim',
  frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 5 }),
  frameRate: 5,
  repeat: -1, // loop forever so you can see it moving
});

const testSprite = this.add.sprite(100, 100, 'escape_hatch');
testSprite.setDepth(15);
testSprite.setScale(4); // make it big enough to see
testSprite.play('test_anim');
if (this.hudCamera) this.hudCamera.ignore(testSprite);
```

You should see a 192×128 animated sprite in the top-left area of the map,
cycling through all 6 frames. If you don't, the problem is in the load step
(step 1–2), not your gameplay logic.
