import Phaser from 'phaser';
import { ProfileStore } from '../ClientState.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';

/**
 * Gambler Street — placeholder scene.
 *
 * The full Gambler Street system (treasure-spending mini-games, payouts) is
 * a separate feature. For now this scene exists so the navigation path is
 * wired up: it shows the player's persistent treasure stash via the shared
 * `TreasureListWidget` and offers a back button.
 */
export class GamblerStreetScene extends Phaser.Scene {
  private treasureList!: TreasureListWidget;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super({ key: 'GamblerStreetScene' });
  }

  preload(): void {
    preloadTreasureIcons(this);
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    const { width, height } = this.scale;

    this.add.text(width / 2, 80, 'GAMBLER STREET', {
      fontSize: '48px', color: '#e0a040', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, 130, 'Coming soon — bring your treasures.', {
      fontSize: '16px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Treasure stash on the top-right, same widget the rest of the game uses.
    this.treasureList = new TreasureListWidget(this, {
      x: width - 20,
      y: 20,
      anchor: 'top-right',
    });

    const backBtn = this.add.text(width / 2, height - 80, '[ BACK ]', {
      fontSize: '24px', color: '#44aaff', fontFamily: 'monospace',
      backgroundColor: '#222244', padding: { x: 24, y: 10 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#88ccff'));
    backBtn.on('pointerout', () => backBtn.setColor('#44aaff'));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    this.unsubscribe = ProfileStore.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.treasureList.setBundle(profile.treasures);
  }

  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.treasureList?.destroy();
  }
}
