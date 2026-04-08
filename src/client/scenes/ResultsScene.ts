import Phaser from 'phaser';

export interface MatchResultsData {
  winnerId: string | null;
  coinsEarned: number;
  escaped: boolean;
  survived: boolean;
  turnsPlayed: number;
}

/**
 * Results screen shell. Fully wired when the match loop lands in Step 8+.
 */
export class ResultsScene extends Phaser.Scene {
  private results!: MatchResultsData;

  constructor() {
    super({ key: 'ResultsScene' });
  }

  init(data: MatchResultsData): void {
    this.results = data ?? {
      winnerId: null,
      coinsEarned: 0,
      escaped: false,
      survived: false,
      turnsPlayed: 0,
    };
  }

  create(): void {
    const { width, height } = this.scale;
    const r = this.results;

    const success = r.survived || r.escaped;
    const titleColor = success ? '#44ff88' : '#ff4444';

    this.add.text(width / 2, height / 2 - 120, 'MATCH OVER', {
      fontSize: '36px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    const lines = [
      `Turns played: ${r.turnsPlayed}`,
      `Escaped: ${r.escaped ? 'yes' : 'no'}`,
      `Survived: ${r.survived ? 'yes' : 'no'}`,
      '',
      `Coins earned: ${r.coinsEarned}`,
    ];

    this.add.text(width / 2, height / 2 - 20, lines.join('\n'), {
      fontSize: '18px', color: '#cccccc', fontFamily: 'monospace',
      align: 'center', lineSpacing: 8,
    }).setOrigin(0.5);

    const playBtn = this.add.text(width / 2, height / 2 + 120, '[ BACK TO LOBBY ]', {
      fontSize: '24px', color: '#44aaff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    playBtn.on('pointerover', () => playBtn.setColor('#88ccff'));
    playBtn.on('pointerout', () => playBtn.setColor('#44aaff'));
    playBtn.on('pointerdown', () => {
      this.scene.start('LobbyScene');
    });
  }
}
