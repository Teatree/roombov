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
  | { kind: 'lootBomb'; sourceKind: 'chest' | 'body'; bombType: BombType }
  // Waits for the player to click a bomb slot in the HUD. Satisfied by any
  // slot click if `slotIndex` is omitted, otherwise only by that exact slot.
  // Resolves without advancing a turn — selecting a slot is a UI state
  // change, not a gameplay action. Wrong-slot clicks flash the hint like
  // other expected-action mismatches.
  | { kind: 'selectBomb'; slotIndex?: 0 | 1 | 2 | 3 | 4 };

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
  //
  // `delayAfterMs` adds a pause AFTER the turn finishes resolving (and its
  // transition animation plays) before the next script step runs. Use this
  // to let death/explosion animations finish before the next dialogue.
  | { kind: 'promptIdle'; text: string; delayAfterMs?: number }

  // Advances one turn with the player forced idle AND no dialogue / click
  // required. Use during scripted sequences where the player is meant to
  // watch (e.g. an enemy approaching during an ambush). `delayBeforeMs`
  // and `delayAfterMs` pad the automatic turn with pauses so the pacing
  // doesn't feel like a cutscene on fast-forward.
  | { kind: 'autoIdleTurn'; delayBeforeMs?: number; delayAfterMs?: number }

  // Attention
  | { kind: 'highlight'; target: HighlightTarget }
  | { kind: 'clearHighlight' }
  | { kind: 'panCamera'; focus: { x: number; y: number } | 'player'; durationMs: number }
  | { kind: 'blockInput'; durationMs: number }
  // Freeze the follow-player camera so scripted panCamera destinations stay
  // visible instead of snapping back to the player on the next frame. Lock
  // for the duration of the tutorial's cinematic sequences; unlock when the
  // player regains free control.
  | { kind: 'setCameraLocked'; locked: boolean }

  // Mode flags
  | { kind: 'setIdleMuted'; muted: boolean }
  // Persistent block on player movement (both `move` and `reachTile` actions
  // are rejected). Stays on until explicitly flipped back off. Use this to
  // teach other mechanics without the player wandering off the scripted
  // tile. Distinct from the transient `blockPlayerActions` that
  // `autoIdleTurn` manages internally.
  | { kind: 'setBlockMovement'; blocked: boolean }
  // Persistent block on HUD bomb-slot clicks. While on, clicking a slot
  // does nothing (the director flashes a hint if a `selectBomb` expectation
  // is also active, otherwise the click is silently dropped). Stays on
  // until explicitly flipped back off.
  | { kind: 'setBlockSlotSelection'; blocked: boolean }
  // When enabled, the backend resets rushCooldown + rushActive on the
  // tutorial player after every resolveTurn, so OOC Rush never activates
  // during these beats. Disabled for Beat 6 where rush teaching applies.
  | { kind: 'setSuppressRush'; enabled: boolean }
  // Melee Trap Mode gate. 'all' blocks both player and bots from entering
  // trap mode (default during tutorial so the mechanic doesn't fire
  // accidentally). 'bots' only blocks bots — use this once the player is
  // positioned for the ambush so their next idle arms the trap. 'none'
  // lets the resolver run unmodified.
  | { kind: 'setSuppressMeleeTrap'; scope: 'all' | 'bots' | 'none' }
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
  // Queue a real bot throw for the next resolveTurn. Sugar around
  // `setBotAction` with `PlayerAction.throw`, plus optional auto-equip that
  // guarantees the bot has the specified bomb in the given slot (mutates
  // state before the throw resolves). Throw ranges are infinite, so any
  // target tile on the map is valid.
  | {
      kind: 'botThrow';
      botId: string;
      /** Action-convention slot: 0 = Rock (always available),
       *  1..4 → `inventory.slots[0..3]`. */
      slotIndex: 0 | 1 | 2 | 3 | 4;
      x: number;
      y: number;
      bombType?: BombType;
      /** If true (default) and `slotIndex` is 1..4, make sure the bot has
       *  `bombType` in the matching inventory slot before the throw
       *  resolves. Ignored for slotIndex 0 (Rock is always available). */
      autoEquip?: boolean;
    }
  // Queue a single-tile bot move. Sugar around `setBotAction` with
  // `PlayerAction.move`.
  | { kind: 'botMove'; botId: string; x: number; y: number }
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
  setHighlights(targets: HighlightTarget[]): void;
  flashHint(target: HighlightTarget): void;
  panCamera(focus: { x: number; y: number } | 'player', durationMs: number, onComplete: () => void): void;
  blockInput(durationMs: number): void;
  /** Freeze / unfreeze the follow-player camera so scripted panCamera
   *  destinations stick. Lock during cinematic sequences; unlock when
   *  player regains control. */
  setCameraLocked(locked: boolean): void;

  // State accessors
  getState(): MatchState | null;

  // Turn-resolution hooks (backend side)
  mutateState(fn: (s: MatchState) => void): void;
  /** Run a synthetic idle turn. `onResolved` fires after the turn has
   *  fully resolved AND the input-phase hold has elapsed — use it to
   *  delay subsequent script steps until death/explosion animations
   *  have settled. */
  forceIdleAndResolve(onResolved?: () => void): void;

  // Scripted bot actions. Queued into the next resolveTurn call.
  setBotAction(botId: string, action: PlayerAction): void;

  // Fires the MatchEnd path — MatchScene transitions to the results screen.
  endTutorial(message?: string): void;

  // Spawn a floating "!" above a world tile (used for enemy-reveal cues).
  spawnExclamation(tileX: number, tileY: number, color?: string): void;
}
