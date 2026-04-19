import Phaser from 'phaser';
import type { CharacterVariant } from '@shared/types/bomberman.ts';
import { CHARACTER_VARIANTS } from '@shared/types/bomberman.ts';

/**
 * Shared helpers for loading and registering the animated Bomberman
 * spritesheets. One variant per entry in `CHARACTER_VARIANTS`, each
 * exposing seven states:
 *
 *   idle   — loop (in-match + UI)
 *   walk   — loop (in-match + UI)
 *   run    — loop (in-match, rush only)
 *   hurt   — one-shot (in-match)
 *   death  — one-shot (in-match)
 *   throw  — one-shot (in-match, duration overridden per-play)
 *   idle3  — loop (UI visualization only)
 *
 * Sheets are 1024×1024, 8 rows × 8 columns → 128×128 frames, 8 frames per
 * direction. Row order is clockwise from East: 0=right, 1=down-right,
 * 2=down, 3=down-left, 4=left, 5=up-left, 6=up, 7=up-right.
 *
 * Texture keys follow `bomber_{state}_{char}` (e.g. `bomber_idle_char1`).
 * Animation keys follow `bomber_{state}_{char}_{facing}` —
 * `BombermanSpriteSystem` picks the right one from a BombermanState.
 */

/** 8-way facings, in row-index order. */
const FACINGS = [
  'right', 'down-right', 'down', 'down-left',
  'left', 'up-left', 'up', 'up-right',
] as const;

const FRAMES_PER_DIR = 8;
const FRAME_SIZE = 128;

/** FPS per state. Throw is overridden per-play by the bomb arc duration. */
const IDLE_FPS = 10;
const WALK_FPS = 10;
const RUN_FPS = 14;
const HURT_FPS = 12;
const DEATH_FPS = 8;
const THROW_FPS = 12;
const IDLE3_FPS = 10;
const ATTACK3_FPS = 14;
const CROUCH_FPS = 6;

/**
 * Per-state sheet filename (relative to `public/sprites/`) for a given
 * character. Example: `bomber_idle_char1` → `char1_Idle.png`.
 */
const STATE_TO_FILENAME: Record<string, string> = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  hurt: 'TakeDamage',
  death: 'Die',
  throw: 'Attack2',
  idle3: 'Idle3',
  attack3: 'Attack3',
  crouch: 'CrouchIdle',
};

/** Call from a scene's `preload()` to queue all 21 Bomberman spritesheets. */
export function preloadBombermanSpritesheets(scene: Phaser.Scene): void {
  for (const char of CHARACTER_VARIANTS) {
    for (const [state, filename] of Object.entries(STATE_TO_FILENAME)) {
      const key = `bomber_${state}_${char}`;
      if (scene.textures.exists(key)) continue;
      scene.load.spritesheet(key, `sprites/${char}_${filename}.png`, {
        frameWidth: FRAME_SIZE, frameHeight: FRAME_SIZE,
      });
    }
  }
}

function registerSet(
  scene: Phaser.Scene,
  texture: string,
  animStem: string,
  frameRate: number,
  loop: boolean,
): void {
  for (let row = 0; row < FACINGS.length; row++) {
    const facing = FACINGS[row];
    const start = row * FRAMES_PER_DIR;
    const end = start + FRAMES_PER_DIR - 1;
    const key = `${animStem}_${facing}`;
    if (scene.anims.exists(key)) continue;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(texture, { start, end }),
      frameRate,
      repeat: loop ? -1 : 0,
    });
  }
}

/**
 * Register all 168 Bomberman animation keys (7 states × 8 directions × 3
 * variants). Call from `create()` in any scene that uses the sprites.
 * Idempotent — subsequent calls no-op because the anim cache is game-global.
 */
export function ensureBombermanAnims(scene: Phaser.Scene): void {
  if (scene.anims.exists('bomber_idle_char1_down')) return;

  for (const char of CHARACTER_VARIANTS) {
    registerSet(scene, `bomber_idle_${char}`,    `bomber_idle_${char}`,    IDLE_FPS,    true);
    registerSet(scene, `bomber_walk_${char}`,    `bomber_walk_${char}`,    WALK_FPS,    true);
    registerSet(scene, `bomber_run_${char}`,     `bomber_run_${char}`,     RUN_FPS,     true);
    registerSet(scene, `bomber_hurt_${char}`,    `bomber_hurt_${char}`,    HURT_FPS,    false);
    registerSet(scene, `bomber_death_${char}`,   `bomber_death_${char}`,   DEATH_FPS,   false);
    registerSet(scene, `bomber_throw_${char}`,   `bomber_throw_${char}`,   THROW_FPS,   false);
    registerSet(scene, `bomber_idle3_${char}`,   `bomber_idle3_${char}`,   IDLE3_FPS,   true);
    registerSet(scene, `bomber_attack3_${char}`, `bomber_attack3_${char}`, ATTACK3_FPS, false);
    registerSet(scene, `bomber_crouch_${char}`,  `bomber_crouch_${char}`,  CROUCH_FPS,  true);
  }
}

/**
 * UI animation pool — these are the three looping anims that may be shown
 * behind a Bomberman card / menu preview. Callers pick one at random per
 * render and pass it to `createShopBombermanSprite`.
 */
export type UiAnimation = 'idle' | 'idle3' | 'walk';
export const UI_ANIMATIONS: readonly UiAnimation[] = ['idle', 'idle3', 'walk'];

export function pickRandomUiAnimation(): UiAnimation {
  return UI_ANIMATIONS[Math.floor(Math.random() * UI_ANIMATIONS.length)];
}

export function pickRandomCharacter(): CharacterVariant {
  return CHARACTER_VARIANTS[Math.floor(Math.random() * CHARACTER_VARIANTS.length)];
}

/**
 * Convenience: create a Bomberman preview sprite at a fixed on-screen
 * position, tinted + variant-selected, playing the given UI animation
 * facing south. Used by shop cards, menu previews, selector entries.
 *
 * The origin is 0.5/0.5 so the sprite is visually centered at (x, y) —
 * unlike in-match sprites which anchor the feet to the tile.
 *
 * Frame size is 128×128 (2× the old 64×64 sheets), so the visual scale
 * multiplier (1.5) is half what it used to be (3). Net on-screen size
 * stays consistent with what the UI had before.
 */
export function createShopBombermanSprite(
  scene: Phaser.Scene,
  x: number,
  y: number,
  tint: number,
  character: CharacterVariant,
  animation: UiAnimation = 'walk',
  scale = 1,
): Phaser.GameObjects.Sprite {
  const texture = `bomber_${animation}_${character}`;
  const sprite = scene.add.sprite(x, y, texture);
  sprite.setOrigin(0.5, 0.5);
  sprite.setScale(scale * 1.5);
  sprite.setTint(tint);
  sprite.play(`bomber_${animation}_${character}_down`);
  sprite.anims.timeScale = 0.5;
  return sprite;
}
