import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { PlanningScene } from './scenes/PlanningScene.ts';
import { ExecutionScene } from './scenes/ExecutionScene.ts';
import { ResultsScene } from './scenes/ResultsScene.ts';

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
  scene: [BootScene, LobbyScene, PlanningScene, ExecutionScene, ResultsScene],
};

new Phaser.Game(config);
