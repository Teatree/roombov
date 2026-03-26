import Phaser from 'phaser';

interface ResultsData {
  totalGoodiesCollected: number;
  roombasExtracted: number;
  roombasLost: number;
  stagesCompleted: number;
}

export class ResultsScene extends Phaser.Scene {
  private results!: ResultsData;

  constructor() {
    super({ key: 'ResultsScene' });
  }

  init(data: ResultsData): void {
    this.results = data;
  }

  create(): void {
    const { width, height } = this.scale;
    const d = this.results;

    const success = d.roombasExtracted > 0;
    const titleColor = success ? '#44ff88' : '#ff4444';
    const titleText = 'EXPEDITION OVER';

    this.add.text(width / 2, height / 2 - 120, titleText, {
      fontSize: '36px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    const lines = [
      `Stages Completed: ${d.stagesCompleted}`,
      `Roombas Extracted: ${d.roombasExtracted}`,
      `Roombas Lost: ${d.roombasLost}`,
      '',
      `Total Goodies: ${d.totalGoodiesCollected}`,
    ];

    this.add.text(width / 2, height / 2 - 20, lines.join('\n'), {
      fontSize: '18px', color: '#cccccc', fontFamily: 'monospace',
      align: 'center', lineSpacing: 8,
    }).setOrigin(0.5);

    // Verdict
    const verdictText = d.totalGoodiesCollected === 0 ? 'No loot recovered.'
      : d.totalGoodiesCollected < 5 ? 'A meager haul.'
      : d.totalGoodiesCollected < 15 ? 'Decent haul!'
      : 'Excellent run!';
    const verdictColor = d.totalGoodiesCollected === 0 ? '#666666'
      : d.totalGoodiesCollected < 5 ? '#aa8844'
      : d.totalGoodiesCollected < 15 ? '#44aaff'
      : '#44ff88';

    this.add.text(width / 2, height / 2 + 80, verdictText, {
      fontSize: '22px', color: verdictColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    // New Expedition button
    const playBtn = this.add.text(width / 2, height / 2 + 140, '[ NEW EXPEDITION ]', {
      fontSize: '24px', color: '#44aaff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    playBtn.on('pointerover', () => playBtn.setColor('#88ccff'));
    playBtn.on('pointerout', () => playBtn.setColor('#44aaff'));
    playBtn.on('pointerdown', () => {
      this.scene.start('LobbyScene');
    });

    // Main Menu
    const menuBtn = this.add.text(width / 2, height / 2 + 190, '[ MAIN MENU ]', {
      fontSize: '18px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    menuBtn.on('pointerover', () => menuBtn.setColor('#cccccc'));
    menuBtn.on('pointerout', () => menuBtn.setColor('#888888'));
    menuBtn.on('pointerdown', () => {
      this.scene.start('BootScene');
    });
  }
}
