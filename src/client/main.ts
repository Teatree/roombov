import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { MainMenuScene } from './scenes/MainMenuScene.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { BombermanShopScene } from './scenes/BombermanShopScene.ts';
import { BombsShopScene } from './scenes/BombsShopScene.ts';
import { MatchScene } from './scenes/MatchScene.ts';
import { ResultsScene } from './scenes/ResultsScene.ts';
import { TutorialOverlayScene } from './scenes/TutorialOverlayScene.ts';

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
  scene: [BootScene, MainMenuScene, LobbyScene, BombermanShopScene, BombsShopScene, MatchScene, ResultsScene, TutorialOverlayScene],
};

new Phaser.Game(config);
