import Phaser from 'phaser';
import type { CosmeticColors } from '@shared/types/bomberman.ts';

/**
 * Procedural placeholder renderer for a Bomberman.
 *
 * Draws a 3-layer figure (hair / shirt / pants) as tinted rectangles so we
 * can visually distinguish Bombermen without needing sprite assets yet. Real
 * pixel art swaps in by replacing `draw()` with an animated sprite.
 *
 * Size is parametric — shop uses larger figures, the match HUD / tile grid
 * uses smaller ones.
 */
export function drawBomberman(
  graphics: Phaser.GameObjects.Graphics,
  colors: CosmeticColors,
  centerX: number,
  centerY: number,
  size: number,
): void {
  const half = size / 2;
  const third = size / 3;

  // pants (lower third)
  graphics.fillStyle(colors.pants, 1);
  graphics.fillRect(centerX - half * 0.8, centerY + third * 0.2, size * 0.8, third * 0.9);

  // shirt / body (middle third)
  graphics.fillStyle(colors.shirt, 1);
  graphics.fillRect(centerX - half * 0.9, centerY - third * 0.6, size * 0.9, third * 0.9);

  // head (skin tone — fixed light color)
  graphics.fillStyle(0xffd9ba, 1);
  graphics.fillCircle(centerX, centerY - third * 0.95, third * 0.55);

  // hair (top of head)
  graphics.fillStyle(colors.hair, 1);
  graphics.fillRect(
    centerX - third * 0.55,
    centerY - third * 1.45,
    third * 1.1,
    third * 0.55,
  );

  // outline
  graphics.lineStyle(2, 0x111122, 1);
  graphics.strokeRect(centerX - half * 0.9, centerY - third * 1.5, size * 0.9, size * 1.25);
}
