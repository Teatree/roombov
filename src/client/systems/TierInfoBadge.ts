/**
 * Tier Info Badge — small Roman-numeral circle that attaches to the corner
 * of a Bomberman preview. Hover reveals a tooltip with HP / Slots / Stack.
 *
 * Used on:
 *   - MainMenuScene equipped preview
 *   - BombermanSelector cards (Bombs Shop + Lobby + Bomberman Shop)
 *   - BombsShopScene equipped panel
 *   - BombermanShopScene shop cards (different placement: alongside the
 *     stats square; same component for consistency)
 *
 * Tier mapping:
 *   free → I (green)
 *   paid → II (blue)
 *   paid_expensive → III (magenta)
 */

import Phaser from 'phaser';
import { BALANCE } from '@shared/config/balance.ts';
import type { BombermanTier } from '@shared/types/bomberman.ts';

export interface TierInfoBadgeOptions {
  /** Local x relative to the parent container. */
  x: number;
  /** Local y relative to the parent container. */
  y: number;
  tier: BombermanTier;
  maxCustomSlots: number;
  stackSize: number;
  /** Radius in px. Default 12. */
  radius?: number;
  /** HP override — defaults to BALANCE.match.bombermanMaxHp (uniform across
   *  tiers today; pass through if a future tier varies HP). */
  hp?: number;
  /** Tooltip anchor side relative to the badge — `auto` chooses based on
   *  available space. Default 'auto'. */
  tooltipSide?: 'auto' | 'left' | 'right' | 'below';
}

const TIER_LABEL: Record<BombermanTier, string> = {
  free: 'I',
  paid: 'II',
  paid_expensive: 'III',
};

const TIER_COLOR: Record<BombermanTier, number> = {
  free: 0x44aa66,           // green
  paid: 0x4477cc,           // blue
  paid_expensive: 0xcc4477, // magenta
};

const TIER_COLOR_DARK: Record<BombermanTier, number> = {
  free: 0x113322,
  paid: 0x111844,
  paid_expensive: 0x331a26,
};

const TIER_NAME: Record<BombermanTier, string> = {
  free: 'Free',
  paid: 'Paid',
  paid_expensive: 'Expensive',
};

/**
 * Add the badge to `parent` at the supplied local coordinates. Returns the
 * badge container so callers can reposition or destroy it later if needed.
 *
 * Tooltip is created on-demand in the SCENE display list (above the parent)
 * so it sits over neighbouring UI even when the parent is clipped.
 */
export function attachTierInfoBadge(
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container,
  opts: TierInfoBadgeOptions,
): Phaser.GameObjects.Container {
  const radius = opts.radius ?? 12;
  const hp = opts.hp ?? BALANCE.match.bombermanMaxHp;
  const badge = scene.add.container(opts.x, opts.y);

  const fill = TIER_COLOR_DARK[opts.tier];
  const stroke = TIER_COLOR[opts.tier];
  const circle = scene.add.circle(0, 0, radius, fill, 1).setStrokeStyle(2, stroke, 1);
  badge.add(circle);

  const label = scene.add.text(0, 0, TIER_LABEL[opts.tier], {
    fontSize: `${Math.max(10, Math.round(radius * 1.05))}px`,
    color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
  }).setOrigin(0.5);
  badge.add(label);

  let tooltip: Phaser.GameObjects.Container | null = null;

  const showTooltip = (): void => {
    if (tooltip) return;
    // Compute screen-space anchor by walking up the parent chain. Phaser
    // doesn't have getWorldTransform on Containers in 3.80, but we can use
    // `parent.getWorldTransformMatrix` to get the absolute matrix and then
    // transform (badge.x, badge.y) into world space.
    const m = new Phaser.GameObjects.Components.TransformMatrix();
    parent.getWorldTransformMatrix(m);
    const sx = m.tx + opts.x;
    const sy = m.ty + opts.y;

    tooltip = buildTooltip(scene, opts.tier, opts.maxCustomSlots, opts.stackSize, hp);
    const sw = scene.scale.width;
    const tw = (tooltip.getData('w') as number) ?? 160;
    const th = (tooltip.getData('h') as number) ?? 90;

    let tx = sx + radius + 8;
    let ty = sy - th / 2;
    let side = opts.tooltipSide ?? 'auto';
    if (side === 'auto') {
      side = (sx + radius + 8 + tw > sw - 8) ? 'left' : 'right';
    }
    if (side === 'left') {
      tx = sx - radius - 8 - tw;
      ty = sy - th / 2;
    } else if (side === 'below') {
      tx = sx - tw / 2;
      ty = sy + radius + 8;
    }
    tooltip.setPosition(tx, ty);
    // Make sure the tooltip floats above other scene content
    scene.children.bringToTop(tooltip);
  };

  const hideTooltip = (): void => {
    if (!tooltip) return;
    tooltip.destroy();
    tooltip = null;
  };

  circle.setInteractive({ useHandCursor: true });
  circle.on('pointerover', showTooltip);
  circle.on('pointerout', hideTooltip);
  // Defensive cleanup — if the parent is destroyed while the tooltip is up,
  // tear the tooltip down too. Phaser fires DESTROY on the parent.
  parent.once(Phaser.GameObjects.Events.DESTROY, hideTooltip);
  badge.once(Phaser.GameObjects.Events.DESTROY, hideTooltip);

  parent.add(badge);
  return badge;
}

function buildTooltip(
  scene: Phaser.Scene,
  tier: BombermanTier,
  maxCustomSlots: number,
  stackSize: number,
  hp: number,
): Phaser.GameObjects.Container {
  const padding = 10;
  const lineH = 20;
  const tipW = 200;
  const tipH = padding * 2 + lineH * 4 + 4;

  const c = scene.add.container(0, 0);
  c.setDepth(10000);
  const bg = scene.add.rectangle(tipW / 2, tipH / 2, tipW, tipH, 0x0e0e1a, 0.96)
    .setStrokeStyle(1, TIER_COLOR[tier], 1);
  c.add(bg);

  const headline = scene.add.text(padding, padding, `${TIER_NAME[tier]} Bomberman`, {
    fontSize: '12px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
  }).setOrigin(0, 0);
  c.add(headline);

  // Stat rows — emoji prefixes give visual rhythm and let the eye scan stats
  // by icon. `maxCustomSlots` is the count WITHOUT Rock (the user-visible
  // "Bomb Slots" number; Rock is implicit and not counted).
  const rows: Array<[string, string, string]> = [
    ['❤️', 'HP', String(hp)],
    ['🟦', 'Bomb Slots', String(maxCustomSlots)],
    ['🟧', 'Stack Size', String(stackSize)],
  ];
  // Use a font stack that pulls in the system emoji font for the icon column,
  // monospace for the rest. Phaser's text uses CSS font-family fallback.
  const emojiFontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace';
  for (let i = 0; i < rows.length; i++) {
    const [emoji, label, value] = rows[i];
    const y = padding + lineH * (i + 1) + 4;
    c.add(scene.add.text(padding, y, emoji, {
      fontSize: '13px', fontFamily: emojiFontFamily,
    }).setOrigin(0, 0));
    c.add(scene.add.text(padding + 22, y, label, {
      fontSize: '11px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0, 0));
    c.add(scene.add.text(tipW - padding, y, value, {
      fontSize: '12px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0));
  }

  c.setData('w', tipW);
  c.setData('h', tipH);
  return c;
}
