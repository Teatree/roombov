import Phaser from 'phaser';
import type { TutorialOverlayScene } from './TutorialOverlayScene.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import {
  type TooltipKey,
  type TooltipIcon,
  tooltipDataFor,
  tooltipKeyEquals,
} from '../tooltip/tooltipData.ts';

const PANEL_W = 220;
const PANEL_H = 52;
const PANEL_MARGIN = 16;
const ICON_SIZE = 28;
const PADDING = 8;
const SHOW_DELAY_MS = 700;
const FADE_IN_MS = 140;
const FADE_OUT_MS = 110;

/**
 * Bottom-right tooltip panel. Parallel scene over MatchScene. Holds at most
 * one active tooltip; calls to `setKey` replace whatever is pending. Suppressed
 * while the tutorial overlay is blocking input.
 */
export class TooltipScene extends Phaser.Scene {
  private panel!: Phaser.GameObjects.Container;
  private panelBg!: Phaser.GameObjects.Rectangle;
  private text!: Phaser.GameObjects.Text;
  private iconImage!: Phaser.GameObjects.Image;
  private iconGfx!: Phaser.GameObjects.Graphics;

  private currentKey: TooltipKey | null = null;
  private pendingKey: TooltipKey | null = null;
  private showAt = 0;
  /** Active alpha tween — killed and replaced when the target alpha changes. */
  private fadeTween: Phaser.Tweens.Tween | null = null;
  /** True while we're mid-cross-fade (fading out before swapping content). The
   *  next content swap waits for the fade-out to complete. */
  private swapping = false;

  constructor() {
    super({ key: 'TooltipScene' });
  }

  preload(): void {
    preloadBombIcons(this);
  }

  create(): void {
    this.events.once('shutdown', () => this.shutdown());

    const { width, height } = this.scale;
    const panelX = width - PANEL_W - PANEL_MARGIN;
    const panelY = height - PANEL_H - PANEL_MARGIN;

    this.panel = this.add.container(panelX, panelY).setDepth(2000).setVisible(false).setAlpha(0);

    this.panelBg = this.add.rectangle(0, 0, PANEL_W, PANEL_H, 0x0a1020, 0.85)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0xffd944, 0.7);

    this.iconImage = this.add.image(PADDING + ICON_SIZE / 2, PANEL_H / 2, 'bomb_icons', 0)
      .setOrigin(0.5)
      .setDisplaySize(ICON_SIZE, ICON_SIZE)
      .setVisible(false);

    this.iconGfx = this.add.graphics();

    this.text = this.add.text(PADDING + ICON_SIZE + PADDING, PANEL_H / 2, '', {
      fontSize: '10px',
      color: '#ffffff',
      fontFamily: 'monospace',
      wordWrap: { width: PANEL_W - ICON_SIZE - PADDING * 3 },
    }).setOrigin(0, 0.5);

    this.panel.add([this.panelBg, this.iconImage, this.iconGfx, this.text]);

    this.scale.on('resize', this.onResize, this);
  }

  private onResize(size: Phaser.Structs.Size): void {
    this.panel?.setPosition(
      size.width - PANEL_W - PANEL_MARGIN,
      size.height - PANEL_H - PANEL_MARGIN,
    );
  }

  /** Cached lookup of the tutorial overlay so we can suppress while it's blocking. */
  private getOverlay(): TutorialOverlayScene | null {
    const sc = this.scene.get('TutorialOverlayScene') as TutorialOverlayScene | null;
    return sc && this.scene.isActive('TutorialOverlayScene') ? sc : null;
  }

  /**
   * Public API. Pass null to clear. Same key as the active one is a no-op so
   * the show delay isn't reset on every pointermove.
   */
  setKey(key: TooltipKey | null): void {
    // While visible, repeated requests for the same key are a no-op (avoid
    // resetting tween / re-rendering on every pointermove tick).
    if (tooltipKeyEquals(this.pendingKey, key) && this.currentKey !== null) return;

    const wasNull = this.pendingKey === null;
    this.pendingKey = key;
    if (key === null) return;

    // Arm the show delay whenever we go from "nothing showing" → "key queued".
    // Switching keys while a tooltip is already visible bypasses the delay and
    // cross-fades instead, handled in update().
    if (this.currentKey === null && (wasNull || !tooltipKeyEquals(this.currentKey, key))) {
      this.showAt = this.time.now + SHOW_DELAY_MS;
    }
  }

  update(): void {
    // Tutorial mode — fully suppress whenever the tutorial overlay is active.
    // Hint text would compete with the tutorial's own dialogue/highlight UI.
    if (this.getOverlay()) {
      if (this.panel.visible) this.fadeOut(() => { this.currentKey = null; });
      return;
    }

    // Clear request → fade out.
    if (this.pendingKey === null) {
      if (this.currentKey !== null && !this.swapping) {
        this.fadeOut(() => { this.currentKey = null; });
      }
      return;
    }

    // Hidden + waiting for delay → show.
    if (this.currentKey === null && !this.swapping && this.time.now >= this.showAt) {
      this.render(this.pendingKey);
      this.currentKey = this.pendingKey;
      this.fadeIn();
      return;
    }

    // Visible but key changed → cross-fade (fade out, swap, fade in).
    if (
      this.currentKey !== null
      && !this.swapping
      && !tooltipKeyEquals(this.currentKey, this.pendingKey)
    ) {
      this.swapping = true;
      this.fadeOut(() => {
        this.swapping = false;
        if (this.pendingKey === null) {
          this.currentKey = null;
          return;
        }
        this.render(this.pendingKey);
        this.currentKey = this.pendingKey;
        this.fadeIn();
      });
    }
  }

  private fadeIn(): void {
    this.fadeTween?.stop();
    this.panel.setVisible(true);
    this.fadeTween = this.tweens.add({
      targets: this.panel,
      alpha: 1,
      duration: FADE_IN_MS,
      ease: 'Quad.easeOut',
    });
  }

  private fadeOut(onComplete: () => void): void {
    this.fadeTween?.stop();
    if (!this.panel.visible || this.panel.alpha === 0) {
      this.panel.setVisible(false);
      onComplete();
      return;
    }
    this.fadeTween = this.tweens.add({
      targets: this.panel,
      alpha: 0,
      duration: FADE_OUT_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.panel.setVisible(false);
        onComplete();
      },
    });
  }

  private render(key: TooltipKey): void {
    const data = tooltipDataFor(key);
    this.renderIcon(data.icon);
    this.renderText(data.parts);
  }

  private renderIcon(icon: TooltipIcon): void {
    this.iconGfx.clear();
    this.iconImage.setVisible(false);
    if (icon.kind === 'bomb') {
      this.iconImage.setFrame(bombIconFrame(icon.bombType));
      this.iconImage.setVisible(true);
      return;
    }
    drawShapeIcon(this.iconGfx, icon.shape, PADDING, Math.round((PANEL_H - ICON_SIZE) / 2), ICON_SIZE);
  }

  private renderText(parts: Array<{ text: string; bold?: boolean }>): void {
    // Phaser's BitmapText/Text doesn't support inline bold spans cleanly.
    // We assemble the full string, but emphasize bold parts by uppercasing
    // and bracketing them so they read as highlighted in monospace. Cheap,
    // readable, no extra typography work.
    const out: string[] = [];
    for (const p of parts) {
      if (p.bold) out.push(p.text.toUpperCase());
      else out.push(p.text);
    }
    this.text.setText(out.join(''));
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.fadeTween?.stop();
    this.fadeTween = null;
    this.swapping = false;
    this.currentKey = null;
    this.pendingKey = null;
  }
}

/**
 * Draw a tiny vector icon for a UI/world category at (x, y) within `size`.
 * Kept minimal — these are placeholder cues, not final art.
 */
function drawShapeIcon(g: Phaser.GameObjects.Graphics, shape: string, x: number, y: number, size: number): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.4;
  switch (shape) {
    case 'heart': {
      g.fillStyle(0xff4466, 1);
      const s = r * 0.9;
      g.fillCircle(cx - s * 0.5, cy - s * 0.2, s * 0.6);
      g.fillCircle(cx + s * 0.5, cy - s * 0.2, s * 0.6);
      g.fillTriangle(cx - s, cy, cx + s, cy, cx, cy + s);
      return;
    }
    case 'coin': {
      g.fillStyle(0xffd944, 1);
      g.fillCircle(cx, cy, r);
      g.fillStyle(0xc09020, 1);
      g.fillCircle(cx, cy, r * 0.7);
      g.fillStyle(0xffd944, 1);
      g.fillRect(cx - r * 0.1, cy - r * 0.45, r * 0.2, r * 0.9);
      return;
    }
    case 'hourglass': {
      g.fillStyle(0x88ccff, 1);
      g.fillTriangle(cx - r, cy - r, cx + r, cy - r, cx, cy);
      g.fillTriangle(cx - r, cy + r, cx + r, cy + r, cx, cy);
      g.lineStyle(2, 0xeeeeee, 1);
      g.strokeRect(cx - r, cy - r - 2, r * 2, 3);
      g.strokeRect(cx - r, cy + r - 1, r * 2, 3);
      return;
    }
    case 'clock': {
      g.fillStyle(0xeeeeee, 1);
      g.fillCircle(cx, cy, r);
      g.fillStyle(0x222233, 1);
      g.fillCircle(cx, cy, r * 0.85);
      g.lineStyle(2, 0xff6644, 1);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx, cy - r * 0.6);
      g.moveTo(cx, cy);
      g.lineTo(cx + r * 0.5, cy);
      g.strokePath();
      return;
    }
    case 'tile': {
      g.fillStyle(0x4a5a3a, 1);
      g.fillRect(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7);
      g.lineStyle(2, 0x8aaa66, 1);
      g.strokeRect(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7);
      return;
    }
    case 'wall': {
      g.fillStyle(0x554433, 1);
      g.fillRect(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7);
      g.lineStyle(2, 0x222222, 1);
      g.strokeRect(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7);
      g.beginPath();
      g.moveTo(x + size * 0.15, cy);
      g.lineTo(x + size * 0.85, cy);
      g.moveTo(cx, y + size * 0.15);
      g.lineTo(cx, y + size * 0.85);
      g.strokePath();
      return;
    }
    case 'door': {
      g.fillStyle(0x884422, 1);
      g.fillRect(cx - r * 0.6, cy - r, r * 1.2, r * 2);
      g.fillStyle(0xffd944, 1);
      g.fillCircle(cx + r * 0.3, cy, 2);
      return;
    }
    case 'chest': {
      g.fillStyle(0x8a5a22, 1);
      g.fillRect(cx - r, cy - r * 0.3, r * 2, r * 1.2);
      g.fillStyle(0x6a3a12, 1);
      g.fillRect(cx - r, cy - r * 0.7, r * 2, r * 0.4);
      g.fillStyle(0xffd944, 1);
      g.fillRect(cx - 2, cy - 2, 4, 4);
      return;
    }
    case 'body': {
      g.fillStyle(0xaa3344, 1);
      g.fillCircle(cx, cy - r * 0.4, r * 0.4);
      g.fillRect(cx - r * 0.5, cy, r, r * 0.6);
      return;
    }
    case 'hatch': {
      g.fillStyle(0x666666, 1);
      g.fillRect(cx - r, cy - r * 0.5, r * 2, r);
      g.lineStyle(2, 0xaaaaaa, 1);
      g.strokeRect(cx - r, cy - r * 0.5, r * 2, r);
      g.fillStyle(0xffd944, 1);
      g.fillCircle(cx, cy, 2);
      return;
    }
    case 'flame': {
      g.fillStyle(0xff6622, 1);
      g.fillTriangle(cx - r * 0.7, cy + r * 0.7, cx + r * 0.7, cy + r * 0.7, cx, cy - r);
      g.fillStyle(0xffd944, 1);
      g.fillTriangle(cx - r * 0.4, cy + r * 0.5, cx + r * 0.4, cy + r * 0.5, cx, cy - r * 0.4);
      return;
    }
    case 'blood': {
      g.fillStyle(0x882222, 1);
      g.fillCircle(cx, cy, r * 0.7);
      g.fillCircle(cx + r * 0.5, cy + r * 0.3, r * 0.3);
      g.fillCircle(cx - r * 0.4, cy - r * 0.4, r * 0.25);
      return;
    }
    case 'pearl': {
      g.fillStyle(0x55ddff, 1);
      g.fillCircle(cx, cy, r * 0.7);
      g.fillStyle(0xffffff, 0.6);
      g.fillCircle(cx - r * 0.2, cy - r * 0.2, r * 0.2);
      return;
    }
    case 'mess': {
      g.fillStyle(0x882222, 0.7);
      g.fillCircle(cx - r * 0.3, cy - r * 0.2, r * 0.4);
      g.fillStyle(0x55ddff, 0.7);
      g.fillCircle(cx + r * 0.3, cy + r * 0.1, r * 0.35);
      g.fillStyle(0x222222, 0.7);
      g.fillCircle(cx, cy + r * 0.4, r * 0.3);
      return;
    }
    case 'fog': {
      g.fillStyle(0x445566, 1);
      g.fillCircle(cx, cy, r);
      // simple "?" rendered as text would need add.text — use a stroke shape
      g.lineStyle(3, 0xffffff, 1);
      g.beginPath();
      g.arc(cx, cy - r * 0.2, r * 0.35, Math.PI, 0, false);
      g.strokePath();
      g.fillStyle(0xffffff, 1);
      g.fillRect(cx - 2, cy + r * 0.4, 4, 4);
      return;
    }
    default:
      g.fillStyle(0xffffff, 1);
      g.fillRect(x + 8, y + 8, size - 16, size - 16);
  }
}
