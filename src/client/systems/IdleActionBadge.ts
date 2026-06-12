/**
 * Idle Action "class" badge — a small colored label identifying a Bomberman's
 * class (Ambusher / Healster / Disguiser) in the Bomberman Shop and Upgrade
 * panel. Color matches the per-class tint hue family and the in-match under-feet
 * shape, so the shop reads consistently with the battlefield.
 */
import Phaser from 'phaser';
import type { IdleAction } from '@shared/types/bomberman.ts';
import { IDLE_ACTION_LABEL } from '@shared/types/bomberman.ts';

/** Hex text color per class (matches the under-feet shape / tint family). */
export const IDLE_ACTION_TEXT_COLOR: Record<IdleAction, string> = {
  attack: '#ff8888',
  heal: '#66ff99',
  disguise: '#ffcc44',
};

/** Class name shown to the player, e.g. "Healster". */
export function idleActionLongLabel(idleAction: IdleAction): string {
  return IDLE_ACTION_LABEL[idleAction] ?? IDLE_ACTION_LABEL.attack;
}

/**
 * Create a centered class-badge text object. Caller adds it to its container
 * and owns positioning via the returned object's origin (defaults centered).
 */
export function createIdleActionBadge(
  scene: Phaser.Scene,
  x: number,
  y: number,
  idleAction: IdleAction,
  fontSize = '11px',
): Phaser.GameObjects.Text {
  const cls: IdleAction =
    idleAction === 'heal' || idleAction === 'disguise' ? idleAction : 'attack';
  return scene.add.text(x, y, idleActionLongLabel(cls), {
    fontSize,
    color: IDLE_ACTION_TEXT_COLOR[cls],
    fontFamily: 'monospace',
    fontStyle: 'bold',
  }).setOrigin(0.5, 0);
}
