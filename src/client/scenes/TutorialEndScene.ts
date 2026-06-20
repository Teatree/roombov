import Phaser from 'phaser';
import { ProfileStore } from '../ClientState.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { CSS, FONT } from '../design/tokens.ts';
import { makePixelButton } from '../util/pixelPanel.ts';

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
    this.cameras.main.setBackgroundColor(CSS.bg);

    // Title (§1.2): Press Start + hard pixel shadow, green for the win state.
    this.add.text(width / 2, height * 0.32, 'TUTORIAL FINISHED', {
      fontSize: '40px', color: CSS.green, fontFamily: FONT.press,
    }).setOrigin(0.5).setShadow(5, 5, CSS.stageFrame, 0, true, true);

    const subtitle = ownsBomberman
      ? 'Go and play against some real Bombermen'
      : 'Go hire yourself a Bomberman';
    this.add.text(width / 2, height * 0.46, subtitle, {
      fontSize: '16px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    // Primary CTA — gold pixel button (the one main action on this card).
    const ctaLabel = ownsBomberman ? 'PLAY' : 'BOMBERMAN SHOP';
    const ctaTarget = ownsBomberman ? 'LobbyScene' : 'BombermanShopScene';
    makePixelButton(this, {
      x: width / 2, y: height * 0.62, w: 280, h: 52,
      label: ctaLabel, variant: 'gold', fontPx: 18,
      onClick: () => this.scene.start(ctaTarget),
    });

    // Secondary nav — dim Silkscreen link back to the menu.
    const menuBtn = this.add.text(width / 2, height * 0.74, '[ MAIN MENU ]', {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    menuBtn.on('pointerover', () => menuBtn.setColor(CSS.text));
    menuBtn.on('pointerout', () => menuBtn.setColor(CSS.dim));
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
