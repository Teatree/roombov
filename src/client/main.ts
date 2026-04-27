import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { MainMenuScene } from './scenes/MainMenuScene.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { BombermanShopScene } from './scenes/BombermanShopScene.ts';
import { BombsShopScene } from './scenes/BombsShopScene.ts';
import { MatchScene } from './scenes/MatchScene.ts';
import { ResultsScene } from './scenes/ResultsScene.ts';
import { TutorialOverlayScene } from './scenes/TutorialOverlayScene.ts';
import { TooltipScene } from './scenes/TooltipScene.ts';
import { GamblerStreetScene } from './scenes/GamblerStreetScene.ts';
import { GamblerStreetPopupScene } from './scenes/GamblerStreetPopupScene.ts';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  fps: { target: 30, forceSetTimeOut: true },
  scene: [BootScene, MainMenuScene, LobbyScene, BombermanShopScene, BombsShopScene, GamblerStreetScene, GamblerStreetPopupScene, MatchScene, ResultsScene, TutorialOverlayScene, TooltipScene],
};

const game = new Phaser.Game(config);
// Dev hook: expose for Playwright/manual testing. Stripped by tree-shake in prod.
(window as unknown as { __game?: Phaser.Game }).__game = game;
