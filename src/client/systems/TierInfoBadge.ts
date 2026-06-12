/**
 * Bomberman Info Badge — small numbered circle that attaches to the corner of
 * a Bomberman preview. The number is the Bomberman's LEVEL (1 + total upgrade
 * tiers bought), not its shop tier: a fresh Bomberman shows 1 and each upgrade
 * bumps it up. The circle/number color ramps with the level (extending the old
 * green→blue→magenta tier sequence). Hover reveals a tooltip with HP/Slots/Stack.
 *
 * Used on:
 *   - MainMenuScene equipped preview
 *   - BombermanSelector cards (Bombs Shop + Lobby + Bomberman Shop)
 *   - BombsShopScene equipped panel
 *   - BombermanShopScene shop cards (different placement: alongside the
 *     stats square; same component for consistency)
 *
 * `tier` is still passed through — it drives only the hover tooltip's border
 * color, never the badge number/color. The tooltip headline reads
 * "<Class> Bomberman lvl <N>" (e.g. "Healster Bomberman lvl 1") and a perk
 * line at the bottom describes the class's Idle Action.
 */

import Phaser from 'phaser';
import { BALANCE } from '@shared/config/balance.ts';
import type { BombermanTier, IdleAction } from '@shared/types/bomberman.ts';
import { IDLE_ACTION_LABEL } from '@shared/types/bomberman.ts';
import { IDLE_ACTION_TEXT_COLOR } from './IdleActionBadge.ts';

export interface TierInfoBadgeOptions {
  /** Local x relative to the parent container. */
  x: number;
  /** Local y relative to the parent container. */
  y: number;
  tier: BombermanTier;
  /** Bomberman level (1 + total upgrade tiers). Drives the badge number and
   *  its color ramp. Shop templates pass 1. */
  level: number;
  /** Idle Action class — drives the tooltip headline ("Healster Bomberman
   *  lvl 1") and the perk description line. */
  idleAction: IdleAction;
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

const TIER_COLOR: Record<BombermanTier, number> = {
  free: 0x44aa66,           // green
  paid: 0x4477cc,           // blue
  paid_expensive: 0xcc4477, // magenta
};

/** Badge color ramp by Bomberman level (1..N). Extends the old per-tier
 *  green→blue→magenta sequence; levels past the array clamp to the last. */
const LEVEL_COLORS: number[] = [
  0x44aa66, // 1  green
  0x4477cc, // 2  blue
  0xcc4477, // 3  magenta
  0xdd8a33, // 4  orange
  0xdd4040, // 5  red
  0xe0c93a, // 6  gold
  0x44d6d6, // 7  cyan
];

function levelColor(level: number): number {
  const i = Math.min(Math.max(1, level), LEVEL_COLORS.length) - 1;
  return LEVEL_COLORS[i];
}

/** Darken a color toward black — used for the badge fill behind the number. */
function darkenColor(hex: number, f = 0.22): number {
  const r = Math.round(((hex >> 16) & 0xff) * f);
  const g = Math.round(((hex >> 8) & 0xff) * f);
  const b = Math.round((hex & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/** `0xrrggbb` → '#rrggbb' for Phaser text colors. */
function colorToHexStr(hex: number): string {
  return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
}

/** Real seconds in one full turn — the HUD presents turns as a clock, so the
 *  perk line speaks seconds too (see BALANCE.match note on the phase split). */
const SECONDS_PER_TURN =
  BALANCE.match.inputPhaseSeconds + BALANCE.match.transitionPhaseSeconds;

/** One-line perk blurb per Idle Action class, derived from BALANCE so the
 *  tooltip stays honest when idle-action tuning changes. */
function perkDescription(idleAction: IdleAction): string {
  const ia = BALANCE.idleActions;
  switch (idleAction) {
    case 'heal':
      return `When idle for ${Math.round(ia.healIdleTurns * SECONDS_PER_TURN)}s, heals ${ia.healAmount} HP.`;
    case 'disguise':
      return `When idle for ${Math.round(ia.disguiseIdleTurns * SECONDS_PER_TURN)}s, disguises as a map object.`;
    default:
      return 'When idle, sets a melee ambush that hits passing enemies.';
  }
}

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
  const level = Math.max(1, Math.round(opts.level));
  const badge = scene.add.container(opts.x, opts.y);

  const ramp = levelColor(level);
  const circle = scene.add.circle(0, 0, radius, darkenColor(ramp), 1).setStrokeStyle(2, ramp, 1);
  badge.add(circle);

  const label = scene.add.text(0, 0, String(level), {
    fontSize: `${Math.max(10, Math.round(radius * 1.05))}px`,
    color: colorToHexStr(ramp), fontFamily: 'monospace', fontStyle: 'bold',
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

    tooltip = buildTooltip(
      scene, opts.tier, level, opts.idleAction, opts.maxCustomSlots, opts.stackSize, hp,
    );
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
  level: number,
  idleAction: IdleAction,
  maxCustomSlots: number,
  stackSize: number,
  hp: number,
): Phaser.GameObjects.Container {
  const padding = 10;
  const lineH = 20;
  const tipW = 212;

  const c = scene.add.container(0, 0);
  c.setDepth(10000);

  const className = IDLE_ACTION_LABEL[idleAction] ?? IDLE_ACTION_LABEL.attack;
  const headline = scene.add.text(padding, padding, `${className} Bomberman lvl ${level}`, {
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

  // Perk line — the class's Idle Action described as a perk, in the class
  // color (same hue as the IdleActionBadge / under-feet shape). Wraps, so the
  // background height is measured after the text is laid out.
  const perkY = padding + lineH * (rows.length + 1) + 8;
  const perk = scene.add.text(
    padding, perkY, `"${className}" - ${perkDescription(idleAction)}`, {
      fontSize: '10px',
      color: IDLE_ACTION_TEXT_COLOR[idleAction] ?? IDLE_ACTION_TEXT_COLOR.attack,
      fontFamily: 'monospace',
      wordWrap: { width: tipW - padding * 2 },
      lineSpacing: 2,
    },
  ).setOrigin(0, 0);
  c.add(perk);

  const tipH = perkY + perk.height + padding;
  const bg = scene.add.rectangle(tipW / 2, tipH / 2, tipW, tipH, 0x0e0e1a, 0.96)
    .setStrokeStyle(1, TIER_COLOR[tier], 1);
  c.addAt(bg, 0);

  c.setData('w', tipW);
  c.setData('h', tipH);
  return c;
}
