import type { BombType } from '@shared/types/bombs.ts';
import type { CharacterVariant } from '@shared/types/bomberman.ts';
import type { MatchState, PlayerAction } from '@shared/types/match.ts';

/**
 * Character portrait used in the dialogue panel. Only char4 is used per the
 * brief ("We always use uncolored char4"). Reserved for future variants if
 * we add an angry/excited expression in Phase 12 polish.
 */
export type PortraitId = 'char4' | 'char4_angry' | null;

/**
 * Thing the player is expected to do next. The director validates incoming
 * player actions against this and swallows anything that doesn't match.
 *
 * `moveTo` optionally accepts `rushX`/`rushY` for the OOC-Rush two-tile
 * move: when both are provided, the player's action must carry matching
 * `rushX`/`rushY` values. When omitted, the action must NOT carry rush
 * fields (keeps strict matching during the no-rush beats).
 *
 * `reachTile` is the multi-turn walk variant: the player clicks the final
 * destination and the client auto-walks one tile per turn via
 * `inputMode === 'pathing'`. The director accepts every intermediate move
 * action but only advances the script once the player's bomberman state
 * reports it has actually reached (x, y). Use this for any walk longer
 * than one tile so the tutorial teaches how the pathing system works.
 */
export type ExpectedAction =
  | { kind: 'moveTo'; x: number; y: number; rushX?: number; rushY?: number }
  | { kind: 'reachTile'; x: number; y: number }
  | { kind: 'throwAt'; slotIndex: 0 | 1 | 2 | 3 | 4; x: number; y: number; bombType?: BombType }
  | { kind: 'idle' }
  | { kind: 'lootBomb'; sourceKind: 'chest' | 'body'; bombType: BombType };

/**
 * Where to draw a pulsing highlight. World rects are in map-pixel coords;
 * HUD rects are in screen space; symbolic targets (slot[i], lootPanel,
 * phase, timer, hp, coins, bombTray) are resolved to screen rects by
 * `MatchScene.getHudRect()` each frame so HUD layout changes don't break
 * the tutorial.
 */
export type HighlightTarget =
  | { kind: 'tile'; x: number; y: number }
  | { kind: 'slot'; index: 0 | 1 | 2 | 3 | 4 }
  | { kind: 'lootPanel' }
  | { kind: 'lootItem'; bombType: BombType }
  | { kind: 'phaseIndicator' }
  | { kind: 'timer' }
  | { kind: 'hp' }
  | { kind: 'coinCounter' }
  | { kind: 'bombTray' }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; space: 'world' | 'hud' };

/**
 * One step in the tutorial script. The director walks steps top-to-bottom;
 * each step either auto-advances (setup / effect steps) or waits for a
 * specific input (dialogue / pause / promptIdle / waitForAction).
 */
export type TutorialStep =
  // Narration — player clicks once to advance.
  | { kind: 'dialogue'; portrait: PortraitId; text: string }
  | { kind: 'pause'; text?: string }

  // Waits one turn on the player's behalf while self-click-idle is muted.
  // Rendered like a dialogue ("Click to wait this turn"); advance internally
  // fires an idle + resolveTurn via director.forceIdleAndResolve().
  | { kind: 'promptIdle'; text: string }

  // Attention
  | { kind: 'highlight'; target: HighlightTarget }
  | { kind: 'clearHighlight' }
  | { kind: 'panCamera'; focus: { x: number; y: number } | 'player'; durationMs: number }
  | { kind: 'blockInput'; durationMs: number }

  // Mode flags
  | { kind: 'setIdleMuted'; muted: boolean }
  // When enabled, the backend resets rushCooldown + rushActive on the
  // tutorial player after every resolveTurn, so OOC Rush never activates
  // during these beats. Disabled for Beat 6 where rush teaching applies.
  | { kind: 'setSuppressRush'; enabled: boolean }
  // Tutorial-only scripted attention: spawn a floating red "!" above the
  // given tile. Used to flag enemy reveals and other one-off cues.
  | { kind: 'flashExclamation'; x: number; y: number; color?: string }

  // Setup — non-blocking, mutates the local match state.
  | { kind: 'mutateState'; mutate: (s: MatchState) => void }
  | {
      kind: 'spawnBot';
      botId: string;
      x: number;
      y: number;
      character?: CharacterVariant;
      tint?: number;
      hp?: number;
      inventory?: Array<{ slot: 0 | 1 | 2 | 3; type: BombType; count: number }>;
    }
  | {
      kind: 'spawnChest';
      chestId: string;
      tier: 1 | 2;
      x: number;
      y: number;
      coins: number;
      bombs: Array<{ type: BombType; count: number }>;
    }
  | { kind: 'equipPlayerBomb'; slot: 0 | 1 | 2 | 3; type: BombType; count: number }
  | { kind: 'teleportPlayer'; x: number; y: number }

  // Scripted turn resolution
  | { kind: 'waitForAction'; expected: ExpectedAction; hintText?: string }
  | { kind: 'setBotAction'; botId: string; action: PlayerAction }
  | { kind: 'resolveTurn' }

  // Lifecycle
  | { kind: 'endTutorial'; message?: string };

/**
 * Dependency surface the director needs from its host (the backend and the
 * overlay). Keeps director logic decoupled from Phaser so it's unit-testable
 * in isolation once scripts get complex.
 */
export interface TutorialHost {
  // Overlay primitives
  showDialogue(text: string, onAdvance: () => void): void;
  hideDialogue(): void;
  showPause(text: string, onAdvance: () => void): void;
  hidePause(): void;
  setHighlight(target: HighlightTarget | null): void;
  flashHint(target: HighlightTarget): void;
  panCamera(focus: { x: number; y: number } | 'player', durationMs: number, onComplete: () => void): void;
  blockInput(durationMs: number): void;

  // State accessors
  getState(): MatchState | null;

  // Turn-resolution hooks (backend side)
  mutateState(fn: (s: MatchState) => void): void;
  forceIdleAndResolve(): void;

  // Scripted bot actions. Queued into the next resolveTurn call.
  setBotAction(botId: string, action: PlayerAction): void;

  // Fires the MatchEnd path — MatchScene transitions to the results screen.
  endTutorial(message?: string): void;

  // Spawn a floating "!" above a world tile (used for enemy-reveal cues).
  spawnExclamation(tileX: number, tileY: number, color?: string): void;
}
