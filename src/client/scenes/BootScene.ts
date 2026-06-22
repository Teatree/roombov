import Phaser from 'phaser';
import { preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { preloadBombIcons } from '../systems/BombIcons.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';
import { ensureFontsLoaded } from '../design/tokens.ts';

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
    // No splash screen — go straight to the menu once assets (preload) and the
    // pixel fonts are ready, so the first menu render has correct glyph metrics.
    void ensureFontsLoaded().then(() => {
      if (this.scene.isActive()) this.scene.start('MainMenuScene');
    });
  }
}
