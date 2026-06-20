import Phaser from 'phaser';
import { preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { preloadBombIcons } from '../systems/BombIcons.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';
import { CSS, FONT, ensureFontsLoaded } from '../design/tokens.ts';
import { makePixelButton } from '../util/pixelPanel.ts';

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
    // Gate the first rendered text on the pixel fonts so Phaser caches correct
    // glyph metrics. Build the boot screen only once fonts are ready.
    void ensureFontsLoaded().then(() => this.buildBootScreen());
  }

  private buildBootScreen(): void {
    if (!this.scene.isActive()) return;
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2 - 50, 'ROOMBOV', {
        fontFamily: FONT.press,
        fontSize: '40px',
        color: CSS.text,
      })
      .setOrigin(0.5)
      .setShadow(5, 5, CSS.stageFrame, 0, true, true);

    this.add
      .text(width / 2, height / 2 + 6, 'TURN-BASED PVP ARENA', {
        fontFamily: FONT.silk,
        fontSize: '16px',
        color: CSS.dim,
      })
      .setOrigin(0.5)
      .setLetterSpacing(4);

    makePixelButton(this, {
      x: width / 2,
      y: height / 2 + 70,
      w: 240,
      h: 56,
      label: 'START',
      variant: 'gold',
      fontPx: 18,
      onClick: () => this.scene.start('MainMenuScene'),
    });
  }
}
