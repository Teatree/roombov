import Phaser from 'phaser';
import { ProfileStore } from '../ClientState.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';

/** Design box this card is authored against. Content runs from the title
 *  (~0.32h) down to the MAIN MENU button (~0.74h); 600×600 keeps a comfortable
 *  desktop layout untouched (no-op) and only scales genuinely short viewports. */
const DESIGN_W = 600;
const DESIGN_H = 600;

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
  /** Re-fit the camera when the viewport changes (orientation / window drag). */
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'TutorialEndScene' });
  }

  create(): void {
    const { width } = this.scale;
    // Lay out against the design box so the camera can scale the whole card to
    // fit short viewports. All content here is centered / height-fraction
    // anchored, so we use `layoutH` for the vertical fractions.
    const { layoutH: height } = designViewport(this, DESIGN_W, DESIGN_H);
    const profile = ProfileStore.get();
    const ownsBomberman = (profile?.ownedBombermen?.length ?? 0) > 0;

    // Backdrop is painted as the camera background so it always fills the
    // screen, even when the camera scales the content down (a sized fillRect
    // would leave letterbox gaps at the design-box edges).
    this.cameras.main.setBackgroundColor(0x0a0a14);

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

    // Scale the whole card to fit short/narrow viewports (no-op on desktop).
    this.events.once('shutdown', this.shutdown, this);
    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
  }
}
