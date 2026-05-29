import Phaser from 'phaser';
import { ProfileStore } from '../ClientState.ts';

/**
 * Tutorial end screen. Shown instead of `ResultsScene` when the match ended
 * via the `TutorialMatchBackend`. The tutorial intentionally awards nothing
 * (no SP, no coins, no treasures, no kills) so this screen is a flat
 * "you're done, here's what to do next" card rather than a stat readout.
 *
 * Routing:
 *  - Player owns 0 Bombermen → CTA points at the Bomberman Shop.
 *  - Player owns ≥1 Bomberman → CTA points at the Lobby (real matches).
 */
export class TutorialEndScene extends Phaser.Scene {
  constructor() {
    super({ key: 'TutorialEndScene' });
  }

  create(): void {
    const { width, height } = this.scale;
    const profile = ProfileStore.get();
    const ownsBomberman = (profile?.ownedBombermen?.length ?? 0) > 0;

    const bg = this.add.graphics();
    bg.fillStyle(0x0a0a14, 1);
    bg.fillRect(0, 0, width, height);

    this.add.text(width / 2, height * 0.32, 'TUTORIAL FINISHED', {
      fontSize: '56px', color: '#88dd88', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    const subtitle = ownsBomberman
      ? 'Go and play against some real Bombermen'
      : 'Go hire yourself a Bomberman';
    this.add.text(width / 2, height * 0.46, subtitle, {
      fontSize: '22px', color: '#cccccc', fontFamily: 'monospace',
    }).setOrigin(0.5);

    const ctaLabel = ownsBomberman ? '[ PLAY ]' : '[ BOMBERMAN SHOP ]';
    const ctaTarget = ownsBomberman ? 'LobbyScene' : 'BombermanShopScene';
    const ctaBtn = this.add.text(width / 2, height * 0.62, ctaLabel, {
      fontSize: '28px', color: '#44aaff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    ctaBtn.on('pointerover', () => ctaBtn.setColor('#88ccff'));
    ctaBtn.on('pointerout', () => ctaBtn.setColor('#44aaff'));
    ctaBtn.on('pointerdown', () => this.scene.start(ctaTarget));

    const menuBtn = this.add.text(width / 2, height * 0.74, '[ MAIN MENU ]', {
      fontSize: '18px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    menuBtn.on('pointerover', () => menuBtn.setColor('#bbbbbb'));
    menuBtn.on('pointerout', () => menuBtn.setColor('#888888'));
    menuBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));
  }
}
