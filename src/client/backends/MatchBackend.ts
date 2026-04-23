import type { MatchState, PlayerAction } from '@shared/types/match.ts';
import type { TurnEvent } from '@shared/systems/TurnResolver.ts';
import type { LootBombMsg, MatchEndMsg } from '@shared/types/messages.ts';

/**
 * Abstraction over the source of authoritative match events. Two
 * implementations exist today:
 *
 *  - `SocketMatchBackend` — forwards to/from the real server over socket.io.
 *    Used by live multiplayer matches.
 *  - `TutorialMatchBackend` — runs `resolveTurn` locally and is driven by
 *    the TutorialDirector. Used by the single-player tutorial.
 *
 * `MatchScene` talks only to this interface, so no rendering or input code
 * needs to know which mode is active.
 *
 * Lifecycle contract:
 *   1. MatchScene constructs the backend.
 *   2. MatchScene calls `onMatchState`/`onTurnResult`/`onMatchEnd` to register
 *      its handlers (exactly once per backend lifetime).
 *   3. MatchScene calls `start()` — the backend begins delivering events.
 *   4. MatchScene calls `sendAction` / `sendLoot` as the player inputs.
 *   5. MatchScene calls `destroy()` in shutdown — backend unregisters
 *      socket listeners, cancels timers, and releases all handlers.
 */
export interface MatchBackend {
  /** Called once after handlers are registered. Backend begins feeding events. */
  start(): void;

  /** Player → authority: submit this player's action for the current turn. */
  sendAction(action: PlayerAction): void;

  /** Player → authority: loot a bomb from a chest or a body. */
  sendLoot(msg: LootBombMsg): void;

  /**
   * Client → backend: the player clicked a HUD bomb slot (0 = Rock, 1..4 =
   * inventory). Not a gameplay action (no turn resolution), but the tutorial
   * backend routes it to the director so scripts can wait for a
   * `selectBomb` expectation and block slot selection via
   * `setBlockSlotSelection`. Returns false to signal the selection should
   * be suppressed (director is blocking clicks); MatchScene keeps its
   * armed-slot state unchanged in that case. The socket backend always
   * returns true — slot selection is a purely local UI state.
   */
  onSlotSelected(slotIndex: number): boolean;

  /** Authority → player: full match state snapshot. Called on every broadcast. */
  onMatchState(cb: (state: MatchState) => void): void;

  /** Authority → player: ordered turn events (explosions, deaths, etc.). */
  onTurnResult(cb: (events: TurnEvent[]) => void): void;

  /** Authority → player: match has ended. */
  onMatchEnd(cb: (msg: MatchEndMsg) => void): void;

  /** MatchScene.shutdown() calls this. Must release every resource and listener. */
  destroy(): void;
}
