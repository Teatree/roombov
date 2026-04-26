/**
 * Bomb icon spritesheet helpers.
 *
 * The `bombs.png` sheet is 256x64 — 2 rows × 8 columns of 32x32 icons,
 * read row-major (frame 0 = top-left, frame 7 = top-right, frame 8 = row 2 col 1).
 *
 * Layout (row, col → frame):
 *   1,1 (0)  Stone / Rock          2,1 (8)  Contact Bomb
 *   1,2 (1)  Delay Bomb Big        2,2 (9)  Banana
 *   1,3 (2)  Wide Delay Bomb       2,3 (10) Flare
 *   1,4 (3)  — intentionally blank — 2,4 (11) Molotov
 *   1,5 (4)  Delay Tricky Bomb     2,5 (12) Ender Pearl
 *   1,6 (5)  Big Huge              2,6 (13) Phosphorus
 *   1,7 (6)  Flash                 2,7 (14) Motion Detector Flare
 *   1,8 (7)  Fart Escape           2,8 (15) Cluster
 */

import Phaser from 'phaser';
import type { BombType } from '@shared/types/bombs.ts';

const BOMB_ICON_FRAMES: Record<BombType, number> = {
  rock: 0,
  bomb: 1,
  bomb_wide: 2,
  delay_tricky: 4,
  big_huge: 5,
  flash: 6,
  fart_escape: 7,
  contact: 8,
  banana: 9,
  banana_child: 9, // shares banana's icon
  flare: 10,
  molotov: 11,
  ender_pearl: 12,
  phosphorus: 13,
  motion_detector_flare: 14,
  cluster_bomb: 15,
};

/** Preload the bomb icons spritesheet. Idempotent. */
export function preloadBombIcons(scene: Phaser.Scene): void {
  if (!scene.textures.exists('bomb_icons')) {
    scene.load.spritesheet('bomb_icons', 'sprites/bombs.png', {
      frameWidth: 32,
      frameHeight: 32,
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
