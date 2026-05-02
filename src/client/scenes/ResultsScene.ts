import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { type TreasureBundle, hasAnyTreasure } from '@shared/config/treasures.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { createBombIcon } from '../systems/BombIcons.ts';
import type { BombType } from '@shared/types/bombs.ts';

export interface MatchResultsData {
  outcome: 'escaped' | 'died' | 'lost';
  treasuresEarned: TreasureBundle;
  turnsPlayed: number;
  /** Bomb inventory kept (escaped only). Includes the bomb type so icons can
   *  render (mirroring the treasure tally). */
  inventory: Array<{ type: BombType; name: string; count: number }>;
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
      // Section header style is shared between Treasures Gathered + Items
      // Kept so they read as parallel summaries.
      const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
        fontSize: '18px', color: '#c4a566', fontFamily: 'monospace', fontStyle: 'bold',
      };

      // Treasures earned this match — horizontal row with the same pulse as
      // the in-match HUD so a fat haul "thrums" on the results screen too.
      if (hasAnyTreasure(r.treasuresEarned)) {
        this.add.text(width / 2, subtitleY, 'Treasures Gathered', headerStyle).setOrigin(0.5);
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

      // Items Kept — horizontal row of bomb icons + "xN" counts, mirroring
      // the Treasures Gathered layout above so the two tallies read as
      // parallel summaries.
      if (r.inventory.length > 0) {
        this.add.text(width / 2, subtitleY, 'Items Kept', headerStyle).setOrigin(0.5);
        subtitleY += 32;
        subtitleY += this.renderItemsKeptRow(width / 2, subtitleY, r.inventory) + 16;
      }

      // Kills (positioned below Items Kept so the haul tallies come first)
      if (r.kills > 0) {
        this.add.text(width / 2, subtitleY, `Bombermen eliminated: ${r.kills}`, {
          fontSize: '16px', color: '#ff8844', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      }

      // Turns — sized to match Bombermen eliminated; keeps its dim gray so
      // the eye lands on the headline tallies first.
      subtitleY += 10;
      this.add.text(width / 2, subtitleY, `Turns survived: ${r.turnsPlayed}`, {
        fontSize: '16px', color: '#888888', fontFamily: 'monospace',
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
   * Renders the "Items Kept" row as horizontal cells of [icon][gap][xN],
   * centered on `centerX` at `topY`. Mirrors TreasureListWidget's horizontal
   * layout so the two tallies read as visually parallel. Returns the row
   * height in pixels so the caller can advance the cursor.
   */
  private renderItemsKeptRow(
    centerX: number,
    topY: number,
    inventory: MatchResultsData['inventory'],
  ): number {
    const iconPx = 32;
    const fontSize = 18;
    const iconTextGap = 6;
    const cellGap = 14;
    // Approximate cell width (icon + gap + count text). Count text is short
    // ("x12" worst case) so we budget ~3 chars at the font's em width.
    const cellW = iconPx + iconTextGap + fontSize * 2.5;
    const totalW = inventory.length * cellW + (inventory.length - 1) * cellGap;

    const container = this.add.container(centerX - totalW / 2, topY);
    inventory.forEach((item, idx) => {
      const cellLeft = idx * (cellW + cellGap);
      const icon = createBombIcon(this, cellLeft + iconPx / 2, iconPx / 2, item.type, iconPx);
      const text = this.add.text(cellLeft + iconPx + iconTextGap, iconPx / 2, `x${item.count}`, {
        fontSize: `${fontSize}px`, color: '#ffffff', fontFamily: 'monospace',
      }).setOrigin(0, 0.5);
      container.add([icon, text]);
    });
    return Math.max(iconPx, fontSize);
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
