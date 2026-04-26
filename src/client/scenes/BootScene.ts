import Phaser from 'phaser';
import { preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { preloadBombIcons } from '../systems/BombIcons.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    // Load Bomberman sprite sheets here so every downstream scene can use
    // them (shop cards, main menu preview, match). Phaser's texture cache
    // is game-global so the load only happens once.
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
    preloadTreasureIcons(this);
  }

  create(): void {
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2 - 40, 'BOMBERMAN', {
        fontSize: '64px',
        color: '#e0e0e0',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 + 30, 'Turn-based PvP Arena', {
        fontSize: '20px',
        color: '#888888',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    const startBtn = this.add
      .text(width / 2, height / 2 + 90, '[ START ]', {
        fontSize: '24px',
        color: '#44aaff',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    startBtn.on('pointerover', () => startBtn.setColor('#88ccff'));
    startBtn.on('pointerout', () => startBtn.setColor('#44aaff'));
    startBtn.on('pointerdown', () => {
      this.scene.start('MainMenuScene');
    });
  }
}
