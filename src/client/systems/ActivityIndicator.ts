import Phaser from 'phaser';
import { NetworkActivity } from '../NetworkActivity.ts';

/**
 * Small hourglass indicator shown in the corner of any scene that wants it.
 * Visible while NetworkActivity.pending > 0.
 *
 * Usage:
 *   const activity = new ActivityIndicator(this);
 *   // Call activity.destroy() in scene.shutdown()
 */
export class ActivityIndicator {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private dot: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private unsubscribe: () => void;
  private tweenRef: Phaser.Tweens.Tween | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const { width } = scene.scale;

    this.container = scene.add.container(width - 30, 30);
    this.container.setScrollFactor(0);
    this.container.setDepth(5000);
    this.container.setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x000000, 0.6);
    bg.fillRoundedRect(-52, -14, 104, 28, 6);
    bg.lineStyle(1, 0xffcc44, 1);
    bg.strokeRoundedRect(-52, -14, 104, 28, 6);
    this.container.add(bg);

    this.dot = scene.add.graphics();
    this.dot.fillStyle(0xffcc44, 1);
    this.dot.fillCircle(-36, 0, 5);
    this.container.add(this.dot);

    this.label = scene.add.text(-24, 0, 'working...', {
      fontSize: '11px', color: '#ffcc44', fontFamily: 'monospace',
    }).setOrigin(0, 0.5);
    this.container.add(this.label);

    this.unsubscribe = NetworkActivity.subscribe((pending) => {
      const visible = pending > 0;
      this.container.setVisible(visible);
      if (visible && !this.tweenRef) {
        this.tweenRef = this.scene.tweens.add({
          targets: this.dot,
          alpha: { from: 0.3, to: 1 },
          duration: 400,
          yoyo: true,
          repeat: -1,
        });
      } else if (!visible && this.tweenRef) {
        this.tweenRef.stop();
        this.tweenRef = null;
        this.dot.setAlpha(1);
      }
    });
  }

  destroy(): void {
    this.unsubscribe();
    if (this.tweenRef) { this.tweenRef.stop(); this.tweenRef = null; }
    this.container.destroy();
  }
}
