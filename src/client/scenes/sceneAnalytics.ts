import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';

/**
 * Single shared hook — call once from a tracked scene's `create()`.
 * Emits an `enter` event immediately and queues a matching `exit` event
 * on the scene's `SHUTDOWN` event so callers don't have to remember to
 * mirror it in `shutdown()`. Untracked screens (Boot, Match, Tooltip,
 * TutorialOverlay) must not call this.
 *
 * See `docs/ANALYTICS-SPEC.md` ScreenEvents sheet for which screens are
 * tracked and how enter/exit pair up.
 */
export function trackScreen(scene: Phaser.Scene, screen: string): void {
  NetworkManager.screenEvent(screen, 'enter');
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    NetworkManager.screenEvent(screen, 'exit');
  });
}
