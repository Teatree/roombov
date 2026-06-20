/**
 * Pixel Panel construction helpers — the signature element of the UI restyle
 * (docs/PIXEL_PANEL_STYLE_HANDOFF.md §1.3 / §1.5). Every container in the new
 * look is a NOTCHED panel: fill + 2px border with the four corners cut into
 * 8x8 pixel notches (NOT rounded). Buttons are panels with hover/press/disabled
 * states. These replace the inline `add.rectangle` / `fillRoundedRect` /
 * `Text-with-backgroundColor` patterns used across the scenes.
 *
 * Implementation note: notches are drawn as an 8-point polygon (true cut
 * corners that follow the border) rather than the spec's "overdraw 4 parent-bg
 * squares" trick — the polygon approach reads correctly even over sprites or
 * the game world, where there is no flat parent color to paint with.
 */
import Phaser from 'phaser';
import { COL, CSS, FONT, HEX } from '../design/tokens.ts';

export interface NotchedPanelOpts {
  fill?: number;
  fillAlpha?: number;
  border?: number;
  borderAlpha?: number;
  borderWidth?: number;
  /** Corner notch size in px (handoff: 8 for top-level, 5–6 for nested). */
  notch?: number;
  /** Skip the fill (border-only frame). */
  noFill?: boolean;
}

/** The 8 polygon points (clockwise from the top-left notch) for a notched rect. */
export function notchedPoints(
  x: number, y: number, w: number, h: number, n: number,
): Phaser.Geom.Point[] {
  return [
    new Phaser.Geom.Point(x + n, y),
    new Phaser.Geom.Point(x + w - n, y),
    new Phaser.Geom.Point(x + w, y + n),
    new Phaser.Geom.Point(x + w, y + h - n),
    new Phaser.Geom.Point(x + w - n, y + h),
    new Phaser.Geom.Point(x + n, y + h),
    new Phaser.Geom.Point(x, y + h - n),
    new Phaser.Geom.Point(x, y + n),
  ];
}

/** Draw a notched panel onto an existing Graphics at (x,y) with size w*h. */
export function drawNotchedPanel(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, w: number, h: number,
  opts: NotchedPanelOpts = {},
): void {
  const {
    fill = COL.panel, fillAlpha = 1,
    border = COL.border, borderAlpha = 1, borderWidth = 2,
    notch = 8, noFill = false,
  } = opts;
  const pts = notchedPoints(x, y, w, h, notch);
  if (!noFill) {
    g.fillStyle(fill, fillAlpha);
    g.fillPoints(pts, true);
  }
  if (borderWidth > 0) {
    g.lineStyle(borderWidth, border, borderAlpha);
    g.strokePoints(pts, true);
  }
}

/** Convenience: create a Graphics, draw a notched panel, return it. */
export function notchedPanel(
  scene: Phaser.Scene,
  x: number, y: number, w: number, h: number,
  opts: NotchedPanelOpts = {},
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  drawNotchedPanel(g, x, y, w, h, opts);
  return g;
}

/** Draw a dashed rectangle border (used for the tutorial button + empty slots). */
export function drawDashedRect(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, w: number, h: number,
  color: number, lineWidth = 2, dash = 6, gap = 4, alpha = 1,
): void {
  g.lineStyle(lineWidth, color, alpha);
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const step = dash + gap;
    const nx = dx / len, ny = dy / len;
    for (let d = 0; d < len; d += step) {
      const e = Math.min(d + dash, len);
      g.lineBetween(x1 + nx * d, y1 + ny * d, x1 + nx * e, y1 + ny * e);
    }
  };
  seg(x, y, x + w, y);
  seg(x + w, y, x + w, y + h);
  seg(x + w, y + h, x, y + h);
  seg(x, y + h, x, y);
}

export interface TabLabelOpts {
  /** Where along the top border the tab sits. */
  side?: 'left' | 'center' | 'right';
  /** Text color (default faint label color). */
  color?: string;
  /** The panel's own fill, painted behind the label to interrupt the border. */
  panelFill?: number;
  fontPx?: number;
  /** Horizontal inset from the panel edge for left/right tabs. */
  inset?: number;
}

/**
 * Add a Silkscreen tab label sitting ON the top border of a panel (handoff
 * §1.3.4). `panelTopY` is the y of the panel's top edge; the label centers on
 * that line. Returns the Text (a fill rect is added behind it). Add the
 * returned object to whatever container owns the panel.
 */
export function addTabLabel(
  scene: Phaser.Scene,
  panelLeftX: number, panelTopY: number, panelW: number,
  text: string,
  opts: TabLabelOpts = {},
): { label: Phaser.GameObjects.Text; bg: Phaser.GameObjects.Rectangle } {
  const {
    side = 'left', color = HEX.faint, panelFill = COL.panel,
    fontPx = 14, inset = 14,
  } = opts;
  const label = scene.add.text(0, panelTopY, text.toUpperCase(), {
    fontFamily: FONT.silk, fontSize: `${fontPx}px`, color,
  }).setOrigin(0, 0.5);
  label.setLetterSpacing(1);
  const lx = side === 'left' ? panelLeftX + inset
    : side === 'right' ? panelLeftX + panelW - inset - label.width
    : panelLeftX + (panelW - label.width) / 2;
  label.setX(lx);
  // Fill rect behind the text so it interrupts the border line.
  const bg = scene.add.rectangle(
    lx - 6, panelTopY, label.width + 12, fontPx + 2, panelFill,
  ).setOrigin(0, 0.5);
  bg.setDepth(label.depth - 1);
  return { label, bg };
}

export type ButtonVariant = 'gold' | 'neutral';

export interface PixelButtonOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  variant?: ButtonVariant;
  fontPx?: number;
  notch?: number;
  enabled?: boolean;
  onClick?: () => void;
}

export interface PixelButton {
  container: Phaser.GameObjects.Container;
  setEnabled(enabled: boolean): void;
  setLabel(text: string): void;
  setVariant(v: ButtonVariant): void;
}

/**
 * A button is a notched panel (handoff §1.5). Hover lightens the border
 * (gold-filled -> white border); press translates the whole button down 2px;
 * disabled is 55% opacity and non-interactive. Content is centered at the
 * container origin so it can be positioned by its center like other panels.
 */
export function makePixelButton(
  scene: Phaser.Scene, opts: PixelButtonOpts,
): PixelButton {
  const { x, y, w, h, fontPx = 13, notch = 6, onClick } = opts;
  let variant: ButtonVariant = opts.variant ?? 'neutral';
  let enabled = opts.enabled ?? true;
  let hovered = false;

  const container = scene.add.container(x, y);
  const g = scene.add.graphics();
  const label = scene.add.text(0, 0, opts.label, {
    fontFamily: FONT.press, fontSize: `${fontPx}px`,
    color: variant === 'gold' ? CSS.goldText : CSS.text,
  }).setOrigin(0.5);
  container.add([g, label]);
  container.setSize(w, h);

  const redraw = () => {
    g.clear();
    if (variant === 'gold') {
      const borderC = hovered && enabled ? 0xffffff : COL.goldEdge;
      drawNotchedPanel(g, -w / 2, -h / 2, w, h, {
        fill: COL.gold, border: borderC, borderWidth: 2, notch,
      });
      label.setColor(CSS.goldText);
    } else {
      const borderC = hovered && enabled ? COL.borderHi : COL.border;
      drawNotchedPanel(g, -w / 2, -h / 2, w, h, {
        fill: COL.panel2, border: borderC, borderWidth: 2, notch,
      });
      label.setColor(CSS.text);
    }
  };

  const applyEnabled = () => {
    container.setAlpha(enabled ? 1 : 0.55);
    if (enabled) {
      // Phaser computes a container's input-local coords from its RENDERED
      // top-left, not its transform origin — so the hit area is anchored at
      // (0,0) with size w*h even though the visuals are drawn centered. A
      // centered rectangle here would leave only the top-left quadrant live.
      container.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, w, h),
        Phaser.Geom.Rectangle.Contains,
      );
    } else if (container.input) {
      container.disableInteractive();
    }
    redraw();
  };

  container.on('pointerover', () => {
    hovered = true;
    if (enabled) scene.input.setDefaultCursor('pointer');
    redraw();
  });
  container.on('pointerout', () => {
    hovered = false;
    container.y = y;
    scene.input.setDefaultCursor('default');
    redraw();
  });
  container.on('pointerdown', () => { if (enabled) container.y = y + 2; });
  container.on('pointerup', () => {
    if (!enabled) return;
    container.y = y;
    onClick?.();
  });

  applyEnabled();

  return {
    container,
    setEnabled(v: boolean) { enabled = v; applyEnabled(); },
    setLabel(t: string) { label.setText(t); },
    setVariant(v: ButtonVariant) { variant = v; redraw(); },
  };
}

/**
 * A link-style text action: Silkscreen blue text in brackets, e.g. `[ EQUIP ]`
 * (handoff §1.5). Hover lightens; no underline. Returns the interactive Text.
 */
export function linkAction(
  scene: Phaser.Scene, x: number, y: number, text: string,
  onClick?: () => void, fontPx = 14,
): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, `[ ${text} ]`, {
    fontFamily: FONT.silk, fontSize: `${fontPx}px`, color: CSS.blue,
  }).setOrigin(0.5).setInteractive({ useHandCursor: true });
  t.on('pointerover', () => t.setColor('#9bd0ff'));
  t.on('pointerout', () => t.setColor(CSS.blue));
  if (onClick) t.on('pointerup', onClick);
  return t;
}

export interface SegmentBarOpts {
  segments?: number;
  /** 0..1 fraction filled. */
  fraction: number;
  segW?: number;
  segH?: number;
  gap?: number;
  color: number;
  emptyColor?: number;
}

/**
 * Draw a segmented progress bar (handoff §3.1 lobby conveyor readout) onto an
 * existing Graphics, left-anchored at (x,y). Default 14 segments of 16x10 with
 * a 3px gap. Filled segments take `color`; the rest take `emptyColor`.
 * Returns the total drawn width.
 */
export function drawSegmentBar(
  g: Phaser.GameObjects.Graphics, x: number, y: number, o: SegmentBarOpts,
): number {
  const { segments = 14, segW = 16, segH = 10, gap = 3, color, emptyColor = COL.panel2 } = o;
  const filled = Math.round(Phaser.Math.Clamp(o.fraction, 0, 1) * segments);
  for (let i = 0; i < segments; i++) {
    g.fillStyle(i < filled ? color : emptyColor, 1);
    g.fillRect(x + i * (segW + gap), y, segW, segH);
  }
  return segments * segW + (segments - 1) * gap;
}
