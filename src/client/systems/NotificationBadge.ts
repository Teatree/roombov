import Phaser from 'phaser';
import { COL, CSS, FONT } from '../design/tokens.ts';

/**
 * Mobile-game style red-dot notification: a red circle with a centered count
 * that sits on top of a button. Hidden when the count is zero.
 *
 * Position is given in scene-space; the badge is anchored at its center so
 * callers can place it at the top-right corner of a button by computing
 *   (btn.x + btn.displayWidth/2, btn.y - btn.displayHeight/2).
 */
export class NotificationBadge {
  private container: Phaser.GameObjects.Container;
  private bg: Phaser.GameObjects.Graphics;
  private text: Phaser.GameObjects.Text;
  private radius: number;

  constructor(scene: Phaser.Scene, x: number, y: number, opts: { depth?: number; radius?: number } = {}) {
    this.radius = opts.radius ?? 11;
    this.container = scene.add.container(x, y);
    this.container.setDepth(opts.depth ?? 1100);
    this.container.setVisible(false);

    this.bg = scene.add.graphics();
    this.bg.fillStyle(COL.red, 1);
    this.bg.fillCircle(0, 0, this.radius);
    this.bg.lineStyle(1.5, 0xffffff, 1);
    this.bg.strokeCircle(0, 0, this.radius);
    this.container.add(this.bg);

    this.text = scene.add.text(0, 0, '', {
      fontSize: '9px',
      color: CSS.text,
      fontFamily: FONT.silk,
    }).setOrigin(0.5, 0.5);
    this.container.add(this.text);
  }

  /** Set the count. Hides the badge when count is <= 0. Caps display at "99+". */
  setCount(count: number): void {
    if (count <= 0) {
      this.container.setVisible(false);
      return;
    }
    this.container.setVisible(true);
    this.text.setText(count > 99 ? '99+' : String(count));
  }

  setPosition(x: number, y: number): void {
    this.container.setPosition(x, y);
  }

  destroy(): void {
    this.container.destroy();
  }
}
