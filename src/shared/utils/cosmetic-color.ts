/**
 * Cosmetic color helpers shared between the Bomberman shop and the Scavenger
 * spawn path. Single source of truth for the "vivid pastel against dark
 * dungeon" palette — same recipe drives both bomberman cards and scav tints.
 */

import type { CosmeticColors } from '../types/bomberman.ts';

/** HSL → 0xRRGGBB. h in [0,360), s/l in [0,1]. */
export function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

/** Three-channel cosmetic palette (shirt / pants / hair) for shop cards. */
export function rollColors(rng: () => number): CosmeticColors {
  return {
    shirt: hslToRgb(rng() * 360, 0.65, 0.55),
    pants: hslToRgb(rng() * 360, 0.55, 0.35),
    hair: hslToRgb(rng() * 360, 0.55, 0.45),
  };
}

/**
 * Single-channel sprite tint. High saturation + high lightness produces
 * vivid pastels — no grays, no muddy darks. Same range the shop has used
 * since post-NEW_META.
 */
export function rollTint(rng: () => number): number {
  const hue = rng() * 360;
  const sat = 0.55 + rng() * 0.3;
  const light = 0.62 + rng() * 0.18;
  return hslToRgb(hue, sat, light);
}
