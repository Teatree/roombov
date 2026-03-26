import Phaser from 'phaser';
import { ExpeditionStore } from '@shared/ExpeditionStore.ts';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    ExpeditionStore.clearAll();
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2 - 40, 'ROOMBOV', {
        fontSize: '64px',
        color: '#e0e0e0',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 + 30, 'Autonomous Roomba Missions', {
        fontSize: '20px',
        color: '#888888',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    const startBtn = this.add
      .text(width / 2, height / 2 + 90, '[ ENTER LOBBY ]', {
        fontSize: '24px',
        color: '#44aaff',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    startBtn.on('pointerover', () => startBtn.setColor('#88ccff'));
    startBtn.on('pointerout', () => startBtn.setColor('#44aaff'));
    startBtn.on('pointerdown', () => {
      this.scene.start('LobbyScene');
    });
  }
}
