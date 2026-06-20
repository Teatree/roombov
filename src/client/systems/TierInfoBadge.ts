/**
 * Bomberman Level Badge — a small numbered circle that attaches to the corner
 * of a Bomberman preview. The number is the Bomberman's LEVEL (1 + total upgrade
 * tiers bought), not its shop tier: a fresh Bomberman shows 1 and each upgrade
 * bumps it up. The circle/number color ramps with the level (Pixel Panel §1.4:
 * 1-2 green, 3-4 gold, 5+ red). Hover reveals the §1.7 popup.
 *
 * Used on:
 *   - MainMenuScene equipped preview
 *   - BombermanSelector cards (Bombs Shop + Lobby + Bomberman Shop)
 *   - BombsShopScene equipped panel
 *   - BombermanShopScene shop cards
 *
 * `tier` is retained in the options for callsite compatibility but no longer
 * drives any color (the badge replaces all "Tier" UI — terminology is
 * "Level"/"LV", never "Tier"). The popup (§1.7) reads:
 *   NAME · LV n  /  Class + behavior  /  --- /  HP·CAP·STACK  /  --- /  EXPERIENCE · N SP
 */

import Phaser from 'phaser';
import { BALANCE } from '@shared/config/balance.ts';
import type { BombermanTier, IdleAction } from '@shared/types/bomberman.ts';
import { IDLE_ACTION_LABEL } from '@shared/types/bomberman.ts';
import { IDLE_ACTION_TEXT_COLOR } from './IdleActionBadge.ts';
import { COL, CSS, FONT, STAT_HEX, levelRampCol, levelRampHex } from '../design/tokens.ts';
import { drawNotchedPanel } from '../util/pixelPanel.ts';

export interface TierInfoBadgeOptions {
  /** Local x relative to the parent container. */
  x: number;
  /** Local y relative to the parent container. */
  y: number;
  tier: BombermanTier;
  /** Bomberman level (1 + total upgrade tiers). Drives the badge number and
   *  its color ramp. Shop templates pass 1. */
  level: number;
  /** Idle Action class — drives the popup class line + behavior. */
  idleAction: IdleAction;
  maxCustomSlots: number;
  stackSize: number;
  /** Radius in px. Default 12. */
  radius?: number;
  /** HP override — defaults to BALANCE.match.bombermanMaxHp. */
  hp?: number;
  /** Optional Bomberman name for the popup's first line (NAME · LV n). When
   *  omitted, the popup leads with the class line. */
  name?: string;
  /** Optional experience (SP). When provided, the popup shows the §1.4
   *  experience strip ("EXPERIENCE … N SP"). SP is never shown as a stat. */
  sp?: number;
  /** Tooltip anchor side relative to the badge. Default 'auto'. */
  tooltipSide?: 'auto' | 'left' | 'right' | 'below';
}

/** `0xrrggbb` → '#rrggbb' for Phaser text colors. */
function colorToHexStr(hex: number): string {
  return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
}

/** Real seconds in one full turn — perk line speaks seconds like the HUD clock. */
const SECONDS_PER_TURN =
  BALANCE.match.inputPhaseSeconds + BALANCE.match.transitionPhaseSeconds;

/** One-line perk blurb per Idle Action class, derived from BALANCE so the
 *  popup stays honest when idle-action tuning changes. */
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
 * badge container. The tooltip is created on-demand in the SCENE display list
 * (above the parent) so it sits over neighbouring UI even when clipped.
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

  const ramp = levelRampCol(level);
  const circle = scene.add.circle(0, 0, radius, COL.bg, 1).setStrokeStyle(2, ramp, 1);
  badge.add(circle);

  const label = scene.add.text(0, 0, String(level), {
    fontSize: `${Math.max(9, Math.round(radius * 0.85))}px`,
    color: levelRampHex(level), fontFamily: FONT.press,
  }).setOrigin(0.5);
  badge.add(label);

  let tooltip: Phaser.GameObjects.Container | null = null;

  const showTooltip = (): void => {
    if (tooltip) return;
    const m = new Phaser.GameObjects.Components.TransformMatrix();
    parent.getWorldTransformMatrix(m);
    const sx = m.tx + opts.x;
    const sy = m.ty + opts.y;

    tooltip = buildTooltip(scene, opts, level, hp);
    const sw = scene.scale.width;
    const tw = (tooltip.getData('w') as number) ?? 250;
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
  parent.once(Phaser.GameObjects.Events.DESTROY, hideTooltip);
  badge.once(Phaser.GameObjects.Events.DESTROY, hideTooltip);

  parent.add(badge);
  return badge;
}

function buildTooltip(
  scene: Phaser.Scene,
  opts: TierInfoBadgeOptions,
  level: number,
  hp: number,
): Phaser.GameObjects.Container {
  const pad = 12;
  const tipW = 250;
  const innerW = tipW - pad * 2;
  const { idleAction, maxCustomSlots, stackSize, name, sp } = opts;
  const className = IDLE_ACTION_LABEL[idleAction] ?? IDLE_ACTION_LABEL.attack;
  const classColor = IDLE_ACTION_TEXT_COLOR[idleAction] ?? IDLE_ACTION_TEXT_COLOR.attack;
  const rampHex = levelRampHex(level);

  const c = scene.add.container(0, 0);
  c.setDepth(10000);
  let y = pad;

  // 1. NAME · LV n  (Silkscreen dim; LV n in ramp color)
  if (name) {
    const n = scene.add.text(pad, y, `${name} · `, {
      fontFamily: FONT.silk, fontSize: '13px', color: CSS.dim,
    }).setOrigin(0, 0);
    c.add(n);
    c.add(scene.add.text(pad + n.width, y, `LV ${level}`, {
      fontFamily: FONT.silk, fontSize: '13px', color: rampHex,
    }).setOrigin(0, 0));
    y += 20;
  } else {
    c.add(scene.add.text(pad, y, `LV ${level}`, {
      fontFamily: FONT.silk, fontSize: '13px', color: rampHex,
    }).setOrigin(0, 0));
    y += 20;
  }

  // 2. Class name (class color) + one-line behavior (dim, wrapped)
  c.add(scene.add.text(pad, y, className, {
    fontFamily: FONT.silk, fontSize: '13px', color: classColor,
  }).setOrigin(0, 0));
  y += 18;
  const perk = scene.add.text(pad, y, perkDescription(idleAction), {
    fontFamily: FONT.silk, fontSize: '11px', color: CSS.dim,
    wordWrap: { width: innerW }, lineSpacing: 2,
  }).setOrigin(0, 0);
  c.add(perk);
  y += perk.height + 8;

  // 3. divider
  const divider = (yy: number) => {
    const g = scene.add.graphics();
    g.lineStyle(1, COL.border, 1);
    g.lineBetween(pad, yy, tipW - pad, yy);
    c.add(g);
  };
  divider(y);
  y += 8;

  // 4. HP / CAP / STACK rows, color-coded (label + value both in stat color)
  const statRows: Array<[string, string, string]> = [
    [STAT_HEX.hp, 'HP', String(hp)],
    [STAT_HEX.cap, 'CAP', String(maxCustomSlots)],
    [STAT_HEX.stack, 'STACK', String(stackSize)],
  ];
  for (const [color, lbl, val] of statRows) {
    c.add(scene.add.text(pad, y, lbl, {
      fontFamily: FONT.silk, fontSize: '12px', color,
    }).setOrigin(0, 0));
    c.add(scene.add.text(tipW - pad, y, val, {
      fontFamily: FONT.press, fontSize: '11px', color,
    }).setOrigin(1, 0));
    y += 20;
  }

  // 5/6. divider + EXPERIENCE … N SP (SP is never a stat — §1.4)
  if (sp !== undefined) {
    y += 2;
    divider(y);
    y += 8;
    c.add(scene.add.text(pad, y, 'EXPERIENCE', {
      fontFamily: FONT.silk, fontSize: '12px', color: CSS.faint,
    }).setOrigin(0, 0).setLetterSpacing(2));
    c.add(scene.add.text(tipW - pad, y, `${sp} SP`, {
      fontFamily: FONT.press, fontSize: '11px', color: CSS.text,
    }).setOrigin(1, 0));
    y += 20;
  }

  const tipH = y + pad - 8;
  const bg = scene.add.graphics();
  drawNotchedPanel(bg, 0, 0, tipW, tipH, {
    fill: COL.panel, border: COL.borderHi, borderWidth: 2, notch: 6,
  });
  c.addAt(bg, 0);

  c.setData('w', tipW);
  c.setData('h', tipH);
  return c;
}
