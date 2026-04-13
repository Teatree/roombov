/**
 * Bomb icon spritesheet helpers.
 *
 * The `bombs.png` sheet is 80x32, 2 rows × 5 columns of 16x16 icons.
 * Row-major reading order:
 *   0: Rock, 1: Delay, 2: Delay Big, 3: Wide Delay, 4: Delay Tricky,
 *   5: Contact, 6: Banana, 7: Flare, 8: Molotov, 9: Ender Pearl
 */

import Phaser from 'phaser';
import type { BombType } from '@shared/types/bombs.ts';

const BOMB_ICON_FRAMES: Record<BombType, number> = {
  rock: 0,
  delay: 1,
  delay_big: 2,
  delay_wide: 3,
  delay_tricky: 4,
  contact: 5,
  banana: 6,
  banana_child: 6, // reuse banana icon
  flare: 7,
  molotov: 8,
  ender_pearl: 9,
};

/** Preload the bomb icons spritesheet. Idempotent. */
export function preloadBombIcons(scene: Phaser.Scene): void {
  if (!scene.textures.exists('bomb_icons')) {
    scene.load.spritesheet('bomb_icons', 'sprites/bombs.png', {
      frameWidth: 16,
      frameHeight: 16,
    });
  }
}

/** Get the frame index for a bomb type's icon. */
export function bombIconFrame(type: BombType): number {
  return BOMB_ICON_FRAMES[type] ?? 0;
}

/**
 * Create a bomb icon image at (x, y) with a given display size.
 * Returns the Phaser Image so the caller can add it to containers / set depth.
 */
export function createBombIcon(
  scene: Phaser.Scene,
  x: number,
  y: number,
  type: BombType,
  displaySize = 32,
): Phaser.GameObjects.Image {
  const img = scene.add.image(x, y, 'bomb_icons', bombIconFrame(type));
  img.setDisplaySize(displaySize, displaySize);
  return img;
}
