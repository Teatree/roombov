/**
 * Factory — placeholder scene introduced by NEW_META §8 (2026-05-16).
 *
 * Empty page that the player can navigate to from MainMenu. The actual
 * Factory meta-progression system lands in a future change; for now this
 * scene just renders a title and a [BACK] button.
 */

import Phaser from 'phaser';

export class FactoryScene extends Phaser.Scene {
  constructor() {
    super('FactoryScene');
  }

  create(): void {
    const { width, height } = this.scale.gameSize;

    this.cameras.main.setBackgroundColor('#1a1a2e');

    this.add.text(width / 2, height / 2 - 60, 'FACTORY', {
      fontSize: '48px',
      color: '#44aaff',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, height / 2, '(coming soon)', {
      fontSize: '18px',
      color: '#888888',
      fontFamily: 'monospace',
    }).setOrigin(0.5);

    const backBtn = this.add.text(40, height - 60, '[ BACK ]', {
      fontSize: '20px',
      color: '#44aaff',
      fontFamily: 'monospace',
      backgroundColor: '#222244',
      padding: { x: 16, y: 8 },
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });

    backBtn.on('pointerover', () => backBtn.setColor('#88ccff'));
    backBtn.on('pointerout', () => backBtn.setColor('#44aaff'));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    // Esc returns to main menu — parity with other menu scenes.
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));
  }
}
