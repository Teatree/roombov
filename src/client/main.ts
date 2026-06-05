import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { MainMenuScene } from './scenes/MainMenuScene.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { BombermanShopScene } from './scenes/BombermanShopScene.ts';
import { BombsShopScene } from './scenes/BombsShopScene.ts';
import { MatchScene } from './scenes/MatchScene.ts';
import { ResultsScene } from './scenes/ResultsScene.ts';
import { TutorialEndScene } from './scenes/TutorialEndScene.ts';
import { TutorialOverlayScene } from './scenes/TutorialOverlayScene.ts';
import { TooltipScene } from './scenes/TooltipScene.ts';
import { FactoryScene } from './scenes/FactoryScene.ts';
import { BombermanUpgradeScene } from './scenes/BombermanUpgradeScene.ts';
import { installMobileViewport } from './util/mobileViewport.ts';
// GamblerStreetScene unregistered post-NEW_META §8. File preserved for revival.
// import { GamblerStreetScene } from './scenes/GamblerStreetScene.ts';

// Prefer the *visible* viewport so the dynamic mobile URL bar doesn't leave the
// bottom HUD clipped (see installMobileViewport). Falls back to window.* on
// browsers without visualViewport.
const initialW = Math.round(window.visualViewport?.width ?? window.innerWidth);
const initialH = Math.round(window.visualViewport?.height ?? window.innerHeight);

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: initialW,
  height: initialH,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  fps: { target: 30, forceSetTimeOut: true },
  scene: [BootScene, MainMenuScene, LobbyScene, BombermanShopScene, BombsShopScene, FactoryScene, MatchScene, ResultsScene, TutorialEndScene, TutorialOverlayScene, TooltipScene, BombermanUpgradeScene],
};

const game = new Phaser.Game(config);
// Mobile: size to the visible viewport (URL-bar aware) + portrait rotate gate.
// No-op on desktop.
installMobileViewport(game);
// Dev hook: expose for Playwright/manual testing. Stripped by tree-shake in prod.
(window as unknown as { __game?: Phaser.Game }).__game = game;
