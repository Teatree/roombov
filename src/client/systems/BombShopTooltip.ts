import Phaser from 'phaser';
import type { BombCategory, BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { bombIconFrame } from './BombIcons.ts';

/**
 * Minimal info this tooltip renders. The Bombs Shop passes a full
 * `BombsCatalogEntry` (which structurally satisfies this); in-match callers can
 * pass a slimmer object built from `BOMB_CATALOG`. Only these four fields are read.
 */
export type BombTooltipInfo = {
  type: BombType;
  name: string;
  description: string;
  category: BombCategory;
};

/**
 * Canonical builder for in-match tooltip content, sourced from `BOMB_CATALOG`.
 * The Bombs Shop catalog (server-side) copies the same `name`/`description`/
 * `category` out of `BOMB_CATALOG`, so editing a bomb's text there updates both
 * the shop tooltip and the in-game tooltip.
 */
export function bombTooltipInfoFor(type: BombType): BombTooltipInfo {
  const def = BOMB_CATALOG[type];
  return { type, name: def.name, description: def.description, category: def.category };
}

/**
 * Cursor-anchored hover tooltip for the Bombs Shop redesign.
 *
 * Deliberately separate from the shared `TooltipScene` (which is fixed at
 * bottom-right and used by MatchScene). The shop uses a cursor-following
 * tooltip with edge flip, since the player is comparing tiles rather than
 * looking at an ambient hint.
 *
 * Layout (top → bottom):
 *   - 2px coloured top bar (bomb category)
 *   - icon (40px) on the left; uppercase category label + bomb name on the right
 *   - one-sentence description, wrapped
 *
 * The container is non-interactive — `setInteractive` is never called on any
 * of its children, so pointer events pass straight through to whatever is
 * underneath.
 */

const WIDTH = 260;
const PADDING_X = 12;
const PADDING_Y = 10;
const ICON_SIZE = 40;
const TOP_BAR_H = 2;
const CURSOR_OFFSET_X = 16;
const CURSOR_OFFSET_Y = 14;
const FADE_MS = 120;

const CATEGORY_COLORS: Record<BombCategory, number> = {
  standard: 0x4488dd, // fallback (Rock, Banana Piece — internal only)
  tactical: 0xffd944, // gold — delayed AoE
  utility:  0x44dd88, // green — vision / passive
  instant:  0xff6644, // orange-red — contact / impact
  escape:   0x44ddff, // cyan — self-movement
  special:  0xff44aa, // pink — high-impact endgame
};

const CATEGORY_LABELS: Record<BombCategory, string> = {
  standard: 'STANDARD',
  tactical: 'TACTICAL',
  utility:  'UTILITY',
  instant:  'INSTANT',
  escape:   'ESCAPE',
  special:  'SPECIAL',
};

export class BombShopTooltip {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private shadowGfx: Phaser.GameObjects.Graphics;
  private bgGfx: Phaser.GameObjects.Graphics;
  private topBar: Phaser.GameObjects.Rectangle;
  private icon: Phaser.GameObjects.Image;
  private categoryText: Phaser.GameObjects.Text;
  private nameText: Phaser.GameObjects.Text;
  private descText: Phaser.GameObjects.Text;
  private currentHeight = 0;
  private fadeTween: Phaser.Tweens.Tween | null = null;
  /** Deferred-hide timer — cancelled when show() arrives within the grace window. */
  private hideTimer: Phaser.Time.TimerEvent | null = null;
  /** True from the moment a hide is initiated until it completes (or is cancelled
   *  by show). Guards against callers that invoke hide() every frame — without
   *  it, each call would reset the deferred-hide timer and it would never fire. */
  private hiding = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setDepth(5000).setVisible(false).setAlpha(0);

    this.shadowGfx = scene.add.graphics();
    this.bgGfx = scene.add.graphics();
    this.topBar = scene.add.rectangle(0, 0, WIDTH, TOP_BAR_H, 0xffffff).setOrigin(0, 0);
    this.icon = scene.add.image(PADDING_X + ICON_SIZE / 2, TOP_BAR_H + PADDING_Y + ICON_SIZE / 2, 'bomb_icons', 0)
      .setDisplaySize(ICON_SIZE, ICON_SIZE);

    const textStartX = PADDING_X + ICON_SIZE + 10;
    this.categoryText = scene.add.text(textStartX, TOP_BAR_H + PADDING_Y + 2, '', {
      fontSize: '10px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    this.nameText = scene.add.text(textStartX, TOP_BAR_H + PADDING_Y + 16, '', {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    this.descText = scene.add.text(PADDING_X, TOP_BAR_H + PADDING_Y + ICON_SIZE + 10, '', {
      fontSize: '11px', color: '#aaaaaa', fontFamily: 'monospace',
      wordWrap: { width: WIDTH - PADDING_X * 2 },
      lineSpacing: 2,
    }).setOrigin(0, 0);

    this.container.add([this.shadowGfx, this.bgGfx, this.topBar, this.icon, this.categoryText, this.nameText, this.descText]);
  }

  /**
   * Show (or update content of) the tooltip for the given bomb. Idempotent —
   * passing the same bomb type re-uses the existing layout. Cancels any
   * pending hide so transitions between hover zone and buttons don't flicker.
   */
  show(entry: BombTooltipInfo): void {
    this.hideTimer?.remove();
    this.hideTimer = null;
    this.hiding = false;

    const color = CATEGORY_COLORS[entry.category];
    const label = CATEGORY_LABELS[entry.category];
    const colorHex = '#' + color.toString(16).padStart(6, '0');

    this.icon.setFrame(bombIconFrame(entry.type));
    this.topBar.setFillStyle(color, 1);
    this.categoryText.setColor(colorHex).setText(label);
    this.nameText.setText(entry.name);
    this.descText.setText(entry.description);

    // Compute total height now that text is known.
    const descBottom = this.descText.y + this.descText.height;
    const totalHeight = Math.round(descBottom + PADDING_Y);
    this.currentHeight = totalHeight;
    this.drawBg(totalHeight);

    if (!this.container.visible) {
      this.container.setVisible(true);
      this.fadeTween?.stop();
      this.fadeTween = this.scene.tweens.add({
        targets: this.container,
        alpha: 1,
        duration: FADE_MS,
        ease: 'Quad.easeOut',
      });
    }
  }

  /** Update position based on cursor, flipping near right/bottom edges. */
  move(cursorX: number, cursorY: number): void {
    const { width, height } = this.scene.scale;
    let x = cursorX + CURSOR_OFFSET_X;
    let y = cursorY + CURSOR_OFFSET_Y;
    if (x + WIDTH > width) x = cursorX - WIDTH - CURSOR_OFFSET_X;
    if (y + this.currentHeight > height) y = cursorY - this.currentHeight;
    // Final clamps so the tooltip never bleeds off-screen even with extreme cursor positions.
    x = Math.max(0, Math.min(width - WIDTH, x));
    y = Math.max(0, Math.min(height - this.currentHeight, y));
    this.container.setPosition(x, y);
  }

  /**
   * Hide on a short delay. If show() arrives during the grace window, the
   * hide is cancelled — prevents flicker when moving between hover zone and
   * buttons inside the same tile.
   */
  hide(): void {
    // Already hidden, or a hide is already in flight → do nothing. The second
    // guard is essential: in-match this is called every frame while the cursor
    // is off any bomb, and without it the 60ms timer below would be cancelled
    // and rescheduled each frame (~16ms) and never fire.
    if (!this.container.visible || this.hiding) return;
    this.hiding = true;
    this.hideTimer?.remove();
    this.hideTimer = this.scene.time.delayedCall(60, () => {
      this.hideTimer = null;
      this.fadeTween?.stop();
      this.fadeTween = this.scene.tweens.add({
        targets: this.container,
        alpha: 0,
        duration: FADE_MS,
        ease: 'Quad.easeIn',
        onComplete: () => { this.container.setVisible(false); this.hiding = false; },
      });
    });
  }

  /**
   * Make `camera` skip this tooltip. In MatchScene the tooltip is positioned in
   * screen space (cursor coords) and should render only through the HUD camera;
   * without this the zoomed/scrolled world camera draws a second, mis-placed
   * copy. No-op in single-camera scenes (the Bombs Shop) that never call it.
   */
  ignoreFrom(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore(this.container);
  }

  destroy(): void {
    this.hideTimer?.remove();
    this.hideTimer = null;
    this.fadeTween?.stop();
    this.fadeTween = null;
    this.container.destroy();
  }

  private drawBg(height: number): void {
    this.shadowGfx.clear();
    this.shadowGfx.fillStyle(0x000000, 0.5);
    this.shadowGfx.fillRoundedRect(3, 4, WIDTH, height, 4);

    this.bgGfx.clear();
    this.bgGfx.fillStyle(0x1a1a2e, 0.96);
    this.bgGfx.fillRoundedRect(0, 0, WIDTH, height, 4);
    this.bgGfx.lineStyle(1, 0x333355, 1);
    this.bgGfx.strokeRoundedRect(0, 0, WIDTH, height, 4);
  }
}
