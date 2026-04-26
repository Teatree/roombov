/**
 * Vertical "spilling-over" list of treasure icons + counts.
 *
 * Reused across MatchScene HUD, MainMenuScene, ResultsScene, and
 * GamblerStreetScene. Stores its own internal pickup-order map and diffs
 * against incoming bundles so newly-acquired types fade in instead of
 * popping. Existing types just refresh their count text in place.
 *
 * Anchor controls how `(x, y)` is interpreted on the screen:
 *   - 'top-left'  : (x,y) is the top-left of the list, rows extend down/right.
 *   - 'top-right' : (x,y) is the top-right of the list, rows extend down,
 *                   right-aligned.
 *
 * Tunable constants (constructor options) live at the top of the class so
 * future balancing/visual tweaks are one-liners. iconScale defaults to 0.2
 * (=> 6.4px on a 32px sheet); raise it to 0.4-0.6 for chunkier rows.
 */

import Phaser from 'phaser';
import {
  type TreasureType,
  type TreasureBundle,
  TREASURE_TYPES,
} from '@shared/config/treasures.ts';
import { TREASURE_TEXTURE_KEY, treasureIconFrame, TREASURE_FRAME_SIZE } from './TreasureIcons.ts';

export type TreasureListAnchor = 'top-left' | 'top-right';

export interface TreasureListOptions {
  x: number;
  y: number;
  anchor?: TreasureListAnchor;
  /** Multiplier applied to the 32px source frame. */
  iconScale?: number;
  /** Vertical gap between rows in pixels. */
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
}

interface RowRefs {
  icon: Phaser.GameObjects.Image;
  text: Phaser.GameObjects.Text;
  count: number;
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
      iconScale: options.iconScale ?? 0.2,
      rowGap: options.rowGap ?? 4,
      iconTextGap: options.iconTextGap ?? 6,
      fadeInMs: options.fadeInMs ?? 250,
      fontSize: options.fontSize ?? 14,
      depth: options.depth ?? 0,
      staticRender: options.staticRender ?? false,
    };
    this.container = scene.add.container(this.opts.x, this.opts.y).setDepth(this.opts.depth);
  }

  /**
   * Diffs `bundle` against the widget's current rows:
   *   - new type with count > 0: append a row, fade in (unless staticRender).
   *   - existing type: update count text.
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

  /**
   * Bounding rect in screen space, useful for tutorial highlights and
   * tooltip hit-tests. Returns the union of all current rows; an empty
   * widget returns a zero-height rect at its anchor point.
   */
  getRect(): { x: number; y: number; w: number; h: number } {
    const iconPx = TREASURE_FRAME_SIZE * this.opts.iconScale;
    const rowH = Math.max(iconPx, this.opts.fontSize) + this.opts.rowGap;
    const rowCount = this.rows.size;
    const h = rowCount > 0 ? rowCount * rowH - this.opts.rowGap : 0;
    // Width: icon + gap + ~3 chars of count text. Approximation good enough
    // for hit-tests; precise text bounds cost more than they're worth.
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

  private appendRow(type: TreasureType, count: number, instant = false): void {
    const iconPx = TREASURE_FRAME_SIZE * this.opts.iconScale;
    const rowH = Math.max(iconPx, this.opts.fontSize) + this.opts.rowGap;
    const idx = this.rows.size;
    const yLocal = idx * rowH;

    // Layout: icon then count to the right of it for both anchors. We mirror
    // x-positions for top-right to keep the list visually right-aligned.
    let iconX: number;
    let textX: number;
    let textOriginX: number;
    if (this.opts.anchor === 'top-right') {
      // The container itself is anchored at (this.opts.x, this.opts.y) which
      // is the top-RIGHT corner. We push items to the LEFT in local coords.
      textX = 0;
      textOriginX = 1; // right-aligned text
      iconX = -(this.opts.fontSize * 3) - this.opts.iconTextGap - iconPx / 2;
    } else {
      iconX = iconPx / 2;
      textX = iconPx + this.opts.iconTextGap;
      textOriginX = 0;
    }

    const icon = this.scene.add.image(iconX, yLocal + iconPx / 2, TREASURE_TEXTURE_KEY, treasureIconFrame(type));
    icon.setDisplaySize(iconPx, iconPx);
    const text = this.scene.add.text(textX, yLocal + (rowH - this.opts.rowGap) / 2, `x${count}`, {
      fontSize: `${this.opts.fontSize}px`,
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(textOriginX, 0.5);

    this.container.add(icon);
    this.container.add(text);
    this.rows.set(type, { icon, text, count });

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
}
