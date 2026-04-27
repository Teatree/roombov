/**
 * Treasure list — used wherever the player's treasure stash needs to render.
 *
 * Reused across MatchScene HUD, MainMenuScene, ResultsScene, and
 * GamblerStreetScene. Supports two layouts:
 *
 *   - 'vertical'   (default): each treasure on its own row, icon + "xN" text
 *                  to the right (or right-aligned for top-right anchor).
 *   - 'horizontal': cells laid out left-to-right; each cell is icon + "xN"
 *                  text immediately to its right. Used by the results
 *                  screen's "Treasures Gathered" line.
 *
 * Optional `pulseOnCount` drives a continuous scale-yoyo on each icon whose
 * amplitude scales with the current count: empty → no pulse, 20+ → max pulse.
 * Used by MatchScene HUD and the Results "Treasures Gathered" widget so a
 * fat haul "thrums" on screen. Other consumers leave it off.
 *
 * Anchor controls how `(x, y)` is interpreted on the screen for the
 * vertical layout:
 *   - 'top-left'  : (x,y) is the top-left of the list, rows extend down/right.
 *   - 'top-right' : (x,y) is the top-right of the list, rows extend down,
 *                   right-aligned.
 *
 * Tunable constants (constructor options) live at the top of the class so
 * future balancing/visual tweaks are one-liners. iconScale defaults to 0.2
 * (=> 6.4px on a 32px sheet); raise it to 0.4-0.6 for chunkier rows or
 * 1.0 for full 32px native.
 */

import Phaser from 'phaser';
import {
  type TreasureType,
  type TreasureBundle,
  TREASURE_TYPES,
} from '@shared/config/treasures.ts';
import { TREASURE_TEXTURE_KEY, treasureIconFrame, TREASURE_FRAME_SIZE } from './TreasureIcons.ts';

export type TreasureListAnchor = 'top-left' | 'top-right';
export type TreasureListDirection = 'vertical' | 'horizontal';

export interface TreasureListOptions {
  x: number;
  y: number;
  anchor?: TreasureListAnchor;
  direction?: TreasureListDirection;
  /** Multiplier applied to the 32px source frame. */
  iconScale?: number;
  /** Vertical gap between rows in pixels (vertical) / cells (horizontal). */
  rowGap?: number;
  /** Horizontal gap between icon and count text in pixels. */
  iconTextGap?: number;
  /** Tween duration for new-type fade-in. */
  fadeInMs?: number;
  /** Font size for the count text in pixels. */
  fontSize?: number;
  /** Phaser depth for the entire container. Defaults to 0. */
  depth?: number;
  /** When true, never plays the fade-in tween — used for static snapshot
   *  renders (results screen). Defaults to false. */
  staticRender?: boolean;
  /**
   * When true, each icon pulses (scale-yoyo) with amplitude scaling from
   * `pulseMinCount` (no pulse) to `pulseMaxCount` (max pulse). Cap at max.
   * Used by MatchScene HUD + Results "Treasures Gathered". Defaults to false.
   */
  pulseOnCount?: boolean;
  /** Count below or equal to which icon does NOT pulse. Default 0. */
  pulseMinCount?: number;
  /** Count at or above which pulse hits max amplitude. Default 20. */
  pulseMaxCount?: number;
  /**
   * Pulse amplitude at full intensity. Icon scales between
   * (1 - amp/2) and (1 + amp/2). Default 0.20.
   */
  pulseAmplitude?: number;
  /** Pulse cycle duration in ms. Default 700. */
  pulsePeriodMs?: number;
}

interface RowRefs {
  icon: Phaser.GameObjects.Image;
  text: Phaser.GameObjects.Text;
  count: number;
  pulseTween: Phaser.Tweens.Tween | null;
  pulseIntensity: number; // 0..1, what tween is currently configured for
}

export class TreasureListWidget {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private rows: Map<TreasureType, RowRefs> = new Map();
  private opts: Required<TreasureListOptions>;

  constructor(scene: Phaser.Scene, options: TreasureListOptions) {
    this.scene = scene;
    this.opts = {
      x: options.x,
      y: options.y,
      anchor: options.anchor ?? 'top-right',
      direction: options.direction ?? 'vertical',
      iconScale: options.iconScale ?? 0.2,
      rowGap: options.rowGap ?? 4,
      iconTextGap: options.iconTextGap ?? 6,
      fadeInMs: options.fadeInMs ?? 250,
      fontSize: options.fontSize ?? 14,
      depth: options.depth ?? 0,
      staticRender: options.staticRender ?? false,
      pulseOnCount: options.pulseOnCount ?? false,
      pulseMinCount: options.pulseMinCount ?? 0,
      pulseMaxCount: options.pulseMaxCount ?? 20,
      pulseAmplitude: options.pulseAmplitude ?? 0.20,
      pulsePeriodMs: options.pulsePeriodMs ?? 700,
    };
    this.container = scene.add.container(this.opts.x, this.opts.y).setDepth(this.opts.depth);
  }

  /**
   * Diffs `bundle` against the widget's current rows:
   *   - new type with count > 0: append a row, fade in (unless staticRender).
   *   - existing type: update count text + pulse intensity.
   *   - existing type now at 0/missing: leave the row visible with "x0"
   *     (UX choice: once seen, always seen — keeps icon positions stable).
   *
   * Pickup order is preserved by insertion order in `this.rows`.
   */
  setBundle(bundle: TreasureBundle): void {
    for (const t of TREASURE_TYPES) {
      const next = bundle[t] ?? 0;
      const row = this.rows.get(t);
      if (row) {
        if (next !== row.count) {
          row.count = next;
          row.text.setText(`x${next}`);
          this.refreshPulse(row);
        }
      } else if (next > 0) {
        this.appendRow(t, next);
      }
    }
  }

  /**
   * Replace the displayed bundle wholesale (no fade, no diff). Useful for
   * static one-shot renders (results / shop preview) where the list is
   * built once and never updated.
   */
  setBundleStatic(bundle: TreasureBundle): void {
    this.clear();
    for (const t of TREASURE_TYPES) {
      const n = bundle[t] ?? 0;
      if (n > 0) this.appendRow(t, n, true);
    }
  }

  /** Remove every row. */
  clear(): void {
    for (const row of this.rows.values()) {
      row.pulseTween?.stop();
      row.pulseTween?.remove();
      row.icon.destroy();
      row.text.destroy();
    }
    this.rows.clear();
  }

  /** Phaser depth pass-through. */
  setDepth(depth: number): this {
    this.container.setDepth(depth);
    return this;
  }

  /** Reposition the widget's anchor point. */
  setX(x: number): this {
    this.opts.x = x;
    this.container.setX(x);
    return this;
  }
  setY(y: number): this {
    this.opts.y = y;
    this.container.setY(y);
    return this;
  }

  /**
   * Bounding rect in screen space, useful for tutorial highlights and
   * tooltip hit-tests. Returns the union of all current rows.
   */
  getRect(): { x: number; y: number; w: number; h: number } {
    const iconPx = TREASURE_FRAME_SIZE * this.opts.iconScale;
    const rowCount = this.rows.size;
    if (this.opts.direction === 'horizontal') {
      const cellW = this.cellWidthPx(iconPx);
      const w = rowCount > 0 ? rowCount * cellW + (rowCount - 1) * this.opts.rowGap : 0;
      const h = Math.max(iconPx, this.opts.fontSize);
      return { x: this.opts.x, y: this.opts.y, w, h };
    }
    // vertical
    const rowH = Math.max(iconPx, this.opts.fontSize) + this.opts.rowGap;
    const h = rowCount > 0 ? rowCount * rowH - this.opts.rowGap : 0;
    const textPx = this.opts.fontSize * 3;
    const w = iconPx + this.opts.iconTextGap + textPx;
    if (this.opts.anchor === 'top-right') {
      return { x: this.opts.x - w, y: this.opts.y, w, h };
    }
    return { x: this.opts.x, y: this.opts.y, w, h };
  }

  destroy(): void {
    this.clear();
    this.container.destroy();
  }

  // --- internals ---

  /** Approximate per-cell width for horizontal layout. */
  private cellWidthPx(iconPx: number): number {
    return iconPx + this.opts.iconTextGap + this.opts.fontSize * 2.5;
  }

  private appendRow(type: TreasureType, count: number, instant = false): void {
    const iconPx = TREASURE_FRAME_SIZE * this.opts.iconScale;
    const idx = this.rows.size;

    let iconX: number;
    let iconY: number;
    let textX: number;
    let textY: number;
    let textOriginX: number;

    if (this.opts.direction === 'horizontal') {
      // Cells laid out left-to-right at y=0. Origin convention: container
      // anchored at (x,y), cells extend right from there. Each cell holds
      // [icon][gap][xN] flush with center vertical alignment.
      const cellW = this.cellWidthPx(iconPx);
      const cellLeft = idx * (cellW + this.opts.rowGap);
      iconX = cellLeft + iconPx / 2;
      iconY = iconPx / 2;
      textX = cellLeft + iconPx + this.opts.iconTextGap;
      textY = iconPx / 2;
      textOriginX = 0;
    } else {
      const rowH = Math.max(iconPx, this.opts.fontSize) + this.opts.rowGap;
      const yLocal = idx * rowH;
      iconY = yLocal + iconPx / 2;
      textY = yLocal + (rowH - this.opts.rowGap) / 2;
      if (this.opts.anchor === 'top-right') {
        // Container anchor is top-RIGHT — items extend LEFT in local coords.
        textX = 0;
        textOriginX = 1; // right-aligned
        iconX = -(this.opts.fontSize * 3) - this.opts.iconTextGap - iconPx / 2;
      } else {
        iconX = iconPx / 2;
        textX = iconPx + this.opts.iconTextGap;
        textOriginX = 0;
      }
    }

    const icon = this.scene.add.image(iconX, iconY, TREASURE_TEXTURE_KEY, treasureIconFrame(type));
    icon.setDisplaySize(iconPx, iconPx);
    const text = this.scene.add.text(textX, textY, `x${count}`, {
      fontSize: `${this.opts.fontSize}px`,
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(textOriginX, 0.5);

    this.container.add(icon);
    this.container.add(text);

    const row: RowRefs = { icon, text, count, pulseTween: null, pulseIntensity: 0 };
    this.rows.set(type, row);
    this.refreshPulse(row);

    if (instant || this.opts.staticRender || this.opts.fadeInMs <= 0) return;
    icon.setAlpha(0);
    text.setAlpha(0);
    this.scene.tweens.add({
      targets: [icon, text],
      alpha: 1,
      duration: this.opts.fadeInMs,
      ease: 'Quad.easeOut',
    });
  }

  /**
   * Stop the existing pulse tween (if any) and start a new one whose
   * amplitude reflects the row's current count. No-op when pulseOnCount
   * is disabled. The intensity ramps linearly from `pulseMinCount` to
   * `pulseMaxCount`, capping at 1.0 thereafter.
   */
  private refreshPulse(row: RowRefs): void {
    if (!this.opts.pulseOnCount) return;
    const range = Math.max(1, this.opts.pulseMaxCount - this.opts.pulseMinCount);
    const intensity = Math.max(0, Math.min(1,
      (row.count - this.opts.pulseMinCount) / range,
    ));

    // No noticeable change → skip restarting the tween (keeps phase smooth).
    if (Math.abs(intensity - row.pulseIntensity) < 0.05 && row.pulseTween) return;
    row.pulseIntensity = intensity;

    row.pulseTween?.stop();
    row.pulseTween?.remove();
    row.pulseTween = null;

    if (intensity <= 0) {
      row.icon.setScale(1);
      return;
    }

    const amp = this.opts.pulseAmplitude * intensity;
    const peakScale = 1 + amp;
    row.icon.setScale(1);
    row.pulseTween = this.scene.tweens.add({
      targets: row.icon,
      scale: peakScale,
      duration: this.opts.pulsePeriodMs / 2,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }
}
