import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { type TreasureBundle, hasAnyTreasure } from '@shared/config/treasures.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';

export interface MatchResultsData {
  outcome: 'escaped' | 'died' | 'lost';
  treasuresEarned: TreasureBundle;
  turnsPlayed: number;
  /** Bomb inventory kept (escaped only). */
  inventory: Array<{ name: string; count: number }>;
  /** Number of enemy Bombermen killed this match. */
  kills: number;
  /** Name of the Bomberman who killed you (died only). */
  killerName: string | null;
  /** Name of your Bomberman (died only — shown as "R.I.P. <name>"). */
  myBombermanName: string | null;
}

/**
 * Results screen — shown after the match ends.
 *
 * Three outcomes:
 *  - Escaped: green title, details of gold + items + kills
 *  - Died: red title, shows who killed you
 *  - Lost: red title, shown when player exceeded turn limit
 */
export class ResultsScene extends Phaser.Scene {
  private results!: MatchResultsData;

  constructor() {
    super({ key: 'ResultsScene' });
  }

  init(data: MatchResultsData): void {
    this.results = data ?? {
      outcome: 'died',
      treasuresEarned: {},
      turnsPlayed: 0,
      inventory: [],
      kills: 0,
      killerName: null,
      myBombermanName: null,
    };
  }

  create(): void {
    const { width, height } = this.scale;
    const r = this.results;

    // Background
    const bg = this.add.graphics();
    bg.fillStyle(0x0a0a14, 1);
    bg.fillRect(0, 0, width, height);

    // Title
    let title = '';
    let titleColor = '#ffffff';
    switch (r.outcome) {
      case 'escaped':
        title = 'ESCAPED';
        titleColor = '#44ff88';
        break;
      case 'died':
        title = 'DIED';
        titleColor = '#ff4444';
        break;
      case 'lost':
        title = 'LOST';
        titleColor = '#ff4444';
        break;
    }

    this.add.text(width / 2, height * 0.2, title, {
      fontSize: '48px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    // Subtitle line
    let subtitleY = height * 0.32;

    if (r.outcome === 'escaped') {
      // Treasures earned this match — horizontal row with the same pulse as
      // the in-match HUD so a fat haul "thrums" on the results screen too.
      if (hasAnyTreasure(r.treasuresEarned)) {
        this.add.text(width / 2, subtitleY, 'Treasures Gathered', {
          fontSize: '18px', color: '#c4a566', fontFamily: 'serif', fontStyle: 'bold',
        }).setOrigin(0.5);
        subtitleY += 32;

        // Build the widget centered horizontally. We need to know its width
        // before placing it, so build it once at (0,0), measure, then
        // position. The widget's container is repositioned via its options.
        // Easiest: instantiate, populate, then offset the container.
        const widget = new TreasureListWidget(this, {
          x: 0, // placeholder — corrected below
          y: subtitleY,
          anchor: 'top-left',
          direction: 'horizontal',
          iconScale: 1.0,
          rowGap: 14,
          fontSize: 18,
          staticRender: true,
          pulseOnCount: true,
        });
        widget.setBundleStatic(r.treasuresEarned);
        const rect = widget.getRect();
        // Re-anchor: shift container so the row is centered on screen.
        widget.setX(width / 2 - rect.w / 2);
        subtitleY += rect.h + 16;
      }

      // Kills
      if (r.kills > 0) {
        this.add.text(width / 2, subtitleY, `Bombermen eliminated: ${r.kills}`, {
          fontSize: '16px', color: '#ff8844', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      }

      // Inventory kept
      if (r.inventory.length > 0) {
        this.add.text(width / 2, subtitleY, 'Items kept:', {
          fontSize: '14px', color: '#aaaaaa', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 22;
        for (const item of r.inventory) {
          this.add.text(width / 2, subtitleY, `  ${item.name} x${item.count}`, {
            fontSize: '14px', color: '#cccccc', fontFamily: 'monospace',
          }).setOrigin(0.5);
          subtitleY += 20;
        }
      }

      // Turns
      subtitleY += 10;
      this.add.text(width / 2, subtitleY, `Turns survived: ${r.turnsPlayed}`, {
        fontSize: '13px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);

    } else if (r.outcome === 'died') {
      // R.I.P. Bomberman name
      if (r.myBombermanName) {
        this.add.text(width / 2, subtitleY, `R.I.P. ${r.myBombermanName}`, {
          fontSize: '20px', color: '#cc6666', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5);
        subtitleY += 36;
      }

      // Killed by
      if (r.killerName) {
        this.add.text(width / 2, subtitleY, `Killed by: ${r.killerName}`, {
          fontSize: '16px', color: '#ff8844', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      } else {
        this.add.text(width / 2, subtitleY, 'Killed in action', {
          fontSize: '16px', color: '#888888', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      }

      subtitleY += 10;
      this.add.text(width / 2, subtitleY, `Turns survived: ${r.turnsPlayed}`, {
        fontSize: '13px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);

    } else {
      // Lost (turn limit exceeded)
      this.add.text(width / 2, subtitleY, 'Time ran out!', {
        fontSize: '20px', color: '#ff8844', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      subtitleY += 36;

      this.add.text(width / 2, subtitleY, `You stayed too long (${r.turnsPlayed} turns)`, {
        fontSize: '14px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }

    // Back button
    const playBtn = this.add.text(width / 2, height * 0.82, '[ BACK TO LOBBY ]', {
      fontSize: '24px', color: '#44aaff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    playBtn.on('pointerover', () => playBtn.setColor('#88ccff'));
    playBtn.on('pointerout', () => playBtn.setColor('#44aaff'));
    playBtn.on('pointerdown', () => this.backToLobby());

    this.input.keyboard?.on('keydown-ESC', () => this.backToLobby());
  }

  /**
   * Release the server-side session binding before leaving the scene. Without
   * this, the server still treats us as "in a match" until the room-wide
   * finalize fires, which silently rejects the next `join_match` attempt.
   */
  private backToLobby(): void {
    NetworkManager.getSocket().emit('leave_match');
    this.scene.start('LobbyScene');
  }
}
