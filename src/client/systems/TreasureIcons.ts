/**
 * Treasure icon spritesheet helpers.
 *
 * `treasures.png` is 160x64 — a 5x2 grid of 32x32 icons, read row-major
 * (frame 0 = top-left, frame 4 = top-right, frame 5 = bottom-row left).
 * Mapping is owned by `TREASURE_ICON_INDEX` in shared config so frame
 * indices stay aligned with the canonical TreasureType order.
 */

import Phaser from 'phaser';
import {
  type TreasureType,
  TREASURE_ICON_INDEX,
} from '@shared/config/treasures.ts';

export const TREASURE_TEXTURE_KEY = 'treasures';
export const TREASURE_FRAME_SIZE = 32;

/** Preload the treasure icons spritesheet. Idempotent. */
export function preloadTreasureIcons(scene: Phaser.Scene): void {
  if (!scene.textures.exists(TREASURE_TEXTURE_KEY)) {
    scene.load.spritesheet(TREASURE_TEXTURE_KEY, 'sprites/treasures.png', {
      frameWidth: TREASURE_FRAME_SIZE,
      frameHeight: TREASURE_FRAME_SIZE,
    });
  }
}

/** Get the frame index for a treasure type's icon. */
export function treasureIconFrame(type: TreasureType): number {
  return TREASURE_ICON_INDEX[type] ?? 0;
}

/**
 * Create a treasure icon image at (x, y) at a given display size.
 * Returns the Phaser Image so the caller can attach to containers / set depth.
 */
export function createTreasureIcon(
  scene: Phaser.Scene,
  x: number,
  y: number,
  type: TreasureType,
  displaySize = TREASURE_FRAME_SIZE,
): Phaser.GameObjects.Image {
  const img = scene.add.image(x, y, TREASURE_TEXTURE_KEY, treasureIconFrame(type));
  img.setDisplaySize(displaySize, displaySize);
  return img;
}
