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

// Original 10-frame sheet indices. New bombs reuse frames (temp visuals)
// until the art sheet is expanded.
const BOMB_ICON_FRAMES: Record<BombType, number> = {
  rock: 0,
  bomb: 2,          // was delay_big frame
  bomb_wide: 3,     // was delay_wide frame
  delay_tricky: 4,
  contact: 5,
  banana: 6,
  banana_child: 6,
  flare: 7,
  molotov: 8,
  ender_pearl: 9,
  // Temp placeholders — reuse existing frames until dedicated art is added.
  fart_escape: 6,           // reuse banana — both are "trickery" bombs
  motion_detector_flare: 7, // reuse flare
  flash: 1,                 // reuse small delay frame (previously unused)
  phosphorus: 8,            // reuse molotov
  cluster_bomb: 2,          // reuse bomb
  big_huge: 3,              // reuse wide bomb
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

/**
 * Bomb types that reuse a legacy icon frame as a placeholder (no dedicated
 * art yet). Rendered with a short text label overlaid on top so players can
 * tell them apart until real icons are added.
 */
export const PLACEHOLDER_ICON_TYPES = new Set<BombType>([
  'fart_escape',
  'motion_detector_flare',
  'flash',
  'phosphorus',
  'cluster_bomb',
  'big_huge',
]);

/** Short uppercase label drawn over placeholder icons. Keep to 5 chars max. */
export const BOMB_SHORT_LABELS: Partial<Record<BombType, string>> = {
  fart_escape: 'FART',
  motion_detector_flare: 'MDET',
  flash: 'FLASH',
  phosphorus: 'PHOS',
  cluster_bomb: 'CLUS',
  big_huge: 'HUGE',
};

/** True if this type should get a text-label overlay on top of its icon. */
export function bombNeedsLabel(type: BombType): boolean {
  return PLACEHOLDER_ICON_TYPES.has(type);
}

/** Short label for a placeholder bomb, or empty string for types with real icons. */
export function bombShortLabel(type: BombType): string {
  return BOMB_SHORT_LABELS[type] ?? '';
}

/**
 * Optionally stamp a short-name label over an icon position. Returns the
 * Text object (so callers can add it to containers / destroy it) or null
 * if the type has a proper icon. Size controls the label font size.
 */
export function createBombLabelOverlay(
  scene: Phaser.Scene,
  x: number,
  y: number,
  type: BombType,
  iconDisplaySize: number,
): Phaser.GameObjects.Text | null {
  if (!bombNeedsLabel(type)) return null;
  const fontPx = Math.max(8, Math.round(iconDisplaySize * 0.32));
  return scene.add.text(x, y, bombShortLabel(type), {
    fontSize: `${fontPx}px`,
    color: '#ffffff',
    fontFamily: 'monospace',
    fontStyle: 'bold',
    stroke: '#000000',
    strokeThickness: 3,
  }).setOrigin(0.5);
}
