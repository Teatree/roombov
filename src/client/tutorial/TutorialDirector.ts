import type {
  ExpectedAction, HighlightTarget, TutorialHost, TutorialStep,
} from './types.ts';
import type { MatchState, PlayerAction } from '@shared/types/match.ts';
import { TUTORIAL_PLAYER_ID } from '../backends/TutorialMatchBackend.ts';
import { INVENTORY_SLOT_COUNT } from '@shared/types/bomberman.ts';

/**
 * Walks a TutorialStep[] top to bottom. For each step it either performs an
 * effect and auto-advances, or waits for a specific input (dialogue click,
 * player action, pause click).
 *
 * Not responsible for rendering or for calling `resolveTurn` — those are
 * delegated to the host (TutorialMatchBackend + TutorialOverlayScene).
 */
export class TutorialDirector {
  private script: TutorialStep[];
  private cursor = 0;
  private host: TutorialHost | null = null;

  /** When non-null, the backend's sendActionFromPlayer compares against it. */
  private expected: ExpectedAction | null = null;
  /** Pre-built hint target shown when the player submits a wrong action. */
  private hintTarget: HighlightTarget | null = null;

  /** Player self-click-idle is swallowed while muted. Backend-consulted. */
  private idleMuted = true;

  /**
   * When true, the backend resets the tutorial player's rushCooldown and
   * rushActive to 0/false after every resolveTurn so OOC Rush cannot
   * activate during the relevant beats. Flipped via `setSuppressRush` steps.
   */
  private suppressRush = true;

  /**
   * Melee Trap suppression scope applied after every resolveTurn.
   *   - 'all'  → both player and bots have meleeTrapMode force-reset
   *   - 'bots' → only bots reset (player can trap normally)
   *   - 'none' → resolver output is used as-is
   * Starts at 'all' so the mechanic is entirely disabled until the
   * tutorial explicitly opens it up in the ambush beat.
   */
  private suppressMeleeTrap: 'all' | 'bots' | 'none' = 'all';

  /** When true, `validatePlayerAction` / `validatePlayerLoot` reject
   *  everything. Flipped on during `autoIdleTurn` sequences so stray
   *  player clicks don't derail scripted bot-approach turns. */
  private blockPlayerActions = false;

  /** Persistent block on player movement (move + reachTile actions).
   *  Flipped via `setBlockMovement` steps. Independent from the transient
   *  `blockPlayerActions` flag above — both are consulted in
   *  `validatePlayerAction`. */
  private blockMovement = false;

  /** Persistent block on HUD bomb-slot clicks. Flipped via
   *  `setBlockSlotSelection` steps. Consulted in `validateSlotSelection`. */
  private blockSlotSelection = false;

  /** True once all steps are consumed. */
  private finished = false;

  /** Persistent list of highlights — each `highlight` step appends,
   *  `clearHighlight` resets. Pushed to the host on change so the overlay
   *  can render multiple rects at once (e.g. HUD slot + target tile). */
  private activeHighlights: HighlightTarget[] = [];

  constructor(script: TutorialStep[]) {
    this.script = script;
  }

  /** Attach the host and start stepping through the script. */
  start(host: TutorialHost): void {
    this.host = host;
    this.advance();
  }

  /** Backend asks: is this a legal action right now? */
  shouldSwallowIdle(): boolean {
    return this.idleMuted;
  }

  /**
   * Backend funnels every player action through here. Returns:
   *  - true  → action matches expected; backend resolves the turn
   *  - false → wrong action; backend should NOT resolve (director flashes hint)
   */
  validatePlayerAction(action: PlayerAction): boolean {
    if (this.blockPlayerActions) return false;
    // Persistent movement block rejects move + the multi-turn walk that
    // feeds it. Idle and throw still pass so the script can explicitly
    // expect them.
    if (this.blockMovement && action.kind === 'move') return false;
    if (!this.expected) {
      // No specific expectation — accept anything. Used while no waitForAction
      // step is active (shouldn't happen in practice since non-waitForAction
      // steps don't resolve turns).
      return true;
    }
    const ok = this.matchesExpected(action, this.expected);
    if (!ok && this.hintTarget && this.host) {
      this.host.flashHint(this.hintTarget);
    }
    return ok;
  }

  /**
   * Backend asks: is the player allowed to click this HUD bomb slot? Returns
   * true if the click should proceed (MatchScene arms/disarms the slot) and
   * also consumes a `selectBomb` expectation if one is active. False means
   * the click is swallowed.
   *
   * Wrong slot while a `selectBomb` expectation is active flashes the hint
   * rect, matching the pattern used for other expected-action mismatches.
   */
  validateSlotSelection(slotIndex: number): boolean {
    if (this.blockSlotSelection) {
      // Still flash the hint if a script step is waiting on a specific slot,
      // so the player sees *why* their click did nothing.
      if (this.expected?.kind === 'selectBomb' && this.hintTarget && this.host) {
        this.host.flashHint(this.hintTarget);
      }
      return false;
    }
    if (this.expected?.kind !== 'selectBomb') return true;
    const want = this.expected.slotIndex;
    const ok = want === undefined || want === slotIndex;
    if (!ok) {
      // Wrong slot: flash the hint and swallow the click so the HUD stays
      // clean instead of ending up armed on the wrong slot.
      if (this.hintTarget && this.host) this.host.flashHint(this.hintTarget);
      return false;
    }
    // Matched. Advance the script immediately (no turn to resolve).
    this.expected = null;
    this.hintTarget = null;
    this.cursor++;
    this.advance();
    return true;
  }

  /** Validate a loot message against the current expectation. Returns true if
   *  the loot should be applied. */
  validatePlayerLoot(sourceKind: 'chest' | 'body', bombType: string): boolean {
    if (this.blockPlayerActions) return false;
    if (!this.expected) return true;
    if (this.expected.kind !== 'lootBomb') return false;
    return this.expected.sourceKind === sourceKind && this.expected.bombType === bombType;
  }

  /** Called by backend after a lootBomb was successfully applied. */
  onLootResolved(): void {
    if (!this.expected || this.expected.kind !== 'lootBomb') return;
    this.expected = null;
    this.hintTarget = null;
    this.cursor++;
    this.advance();
  }

  /** Called by backend after it has successfully resolved a turn.
   *  `state` is the post-resolve match state — used by `reachTile` to
   *  decide whether the walk is finished (advance) or still in progress
   *  (stay on this step, let the client auto-send the next move). */
  onTurnResolved(state: MatchState | null): void {
    if (!this.expected) return;

    // reachTile is the multi-turn walk. If the player hasn't reached the
    // destination yet, keep the expectation active so the next move is
    // accepted too. The client's `flushStagedAction` will auto-send the
    // next step of its BFS path when the input phase starts.
    if (this.expected.kind === 'reachTile' && state) {
      const me = state.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
      if (me && (me.x !== this.expected.x || me.y !== this.expected.y)) {
        return; // still walking — stay on this step
      }
    }

    this.expected = null;
    this.hintTarget = null;
    // Step past the blocking waitForAction (runStep returned `true` without
    // bumping the cursor).
    this.cursor++;
    // Skip a paired resolveTurn step if the script has one there — the
    // backend already resolved the turn on our behalf.
    if (this.script[this.cursor]?.kind === 'resolveTurn') {
      this.cursor++;
    }
    this.advance();
  }

  /** True once endTutorial was reached. */
  isFinished(): boolean {
    return this.finished;
  }

  /** Backend asks: is idle muted for the player? */
  get isIdleMuted(): boolean {
    return this.idleMuted;
  }

  /** Backend asks: should the player's rush state be reset after each turn? */
  isRushSuppressed(): boolean {
    return this.suppressRush;
  }

  /** Backend asks: which bombermen's meleeTrapMode should be reset after
   *  each turn? Returns 'all' | 'bots' | 'none'. */
  getMeleeTrapSuppression(): 'all' | 'bots' | 'none' {
    return this.suppressMeleeTrap;
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Runs the next step. Loops through auto-advancing steps until a blocker. */
  private advance(): void {
    if (!this.host) return;
    // Eagerly drain auto-advancing steps until we hit one that waits.
    while (this.cursor < this.script.length) {
      const step = this.script[this.cursor];
      const blocking = this.runStep(step);
      if (blocking) return;
      this.cursor++;
    }
    this.finished = true;
  }

  /**
   * Returns `true` if the step blocks further stepping (waiting on input).
   * Returns `false` for effect steps that auto-advance.
   */
  private runStep(step: TutorialStep): boolean {
    const host = this.host!;
    switch (step.kind) {
      case 'dialogue':
        host.showDialogue(step.text, () => {
          host.hideDialogue();
          this.cursor++;
          this.advance();
        });
        return true;

      case 'pause':
        host.showPause(step.text ?? 'Click to Continue', () => {
          host.hidePause();
          this.cursor++;
          this.advance();
        });
        return true;

      case 'autoIdleTurn': {
        // Block player input for the full duration of this turn — otherwise
        // a stray click during the 2s input phase would fire an unexpected
        // move action and desync the bot-approach sequence.
        this.blockPlayerActions = true;
        const before = step.delayBeforeMs ?? 0;
        const after = step.delayAfterMs ?? 0;
        const runTurn = (): void => {
          this.cursor++;
          host.forceIdleAndResolve(() => {
            if (after > 0) {
              setTimeout(() => {
                this.blockPlayerActions = false;
                this.advance();
              }, after);
            } else {
              this.blockPlayerActions = false;
              this.advance();
            }
          });
        };
        if (before > 0) setTimeout(runTurn, before);
        else runTurn();
        return true;
      }

      case 'promptIdle':
        host.showDialogue(step.text, () => {
          host.hideDialogue();
          this.cursor++;
          // Force an idle + resolveTurn regardless of the mute. Waits for
          // the turn to fully resolve (bomb explodes, bot dies, animations
          // settle) before advancing, plus any extra `delayAfterMs` the
          // script asked for (e.g. to let a death animation finish).
          const delay = step.delayAfterMs ?? 0;
          host.forceIdleAndResolve(() => {
            if (delay > 0) {
              setTimeout(() => this.advance(), delay);
            } else {
              this.advance();
            }
          });
        });
        return true;

      case 'highlight':
        this.activeHighlights.push(step.target);
        host.setHighlights(this.activeHighlights);
        return false;

      case 'clearHighlight':
        this.activeHighlights = [];
        host.setHighlights(this.activeHighlights);
        return false;

      case 'panCamera':
        host.panCamera(step.focus, step.durationMs, () => {
          this.cursor++;
          this.advance();
        });
        return true;

      case 'blockInput':
        host.blockInput(step.durationMs);
        // Block auto-advance for the duration so the player has time to read.
        setTimeout(() => {
          this.cursor++;
          this.advance();
        }, step.durationMs);
        return true;

      case 'setCameraLocked':
        host.setCameraLocked(step.locked);
        return false;

      case 'setIdleMuted':
        this.idleMuted = step.muted;
        return false;

      case 'setBlockMovement':
        this.blockMovement = step.blocked;
        return false;

      case 'setBlockSlotSelection':
        this.blockSlotSelection = step.blocked;
        return false;

      case 'setSuppressRush':
        this.suppressRush = step.enabled;
        return false;

      case 'setSuppressMeleeTrap':
        this.suppressMeleeTrap = step.scope;
        return false;

      case 'flashExclamation':
        host.spawnExclamation(step.x, step.y, step.color);
        return false;

      case 'mutateState':
        host.mutateState(step.mutate);
        return false;

      case 'spawnChest':
        host.mutateState(s => {
          s.chests.push({
            id: step.chestId,
            tier: step.tier,
            x: step.x,
            y: step.y,
            treasures: { ...step.treasures },
            bombs: step.bombs.map(b => ({ ...b })),
            opened: false,
          });
        });
        return false;

      case 'spawnBot':
        host.mutateState(s => {
          const slots: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number } | null> =
            new Array(INVENTORY_SLOT_COUNT).fill(null);
          for (const item of step.inventory ?? []) {
            slots[item.slot] = { type: item.type, count: item.count };
          }
          s.bombermen.push({
            playerId: step.botId,
            bombermanId: `bot-${step.botId}`,
            colors: { shirt: 0x884444, pants: 0x442222, hair: 0x221111 },
            tint: step.tint ?? 0xffffff,
            character: step.character ?? 'char1',
            x: step.x,
            y: step.y,
            hp: step.hp ?? 2,
            alive: true,
            treasures: {},
            inventory: { slots },
            bleedingTurns: 0,
            escaped: false,
            rushCooldown: 0,
            rushActive: false,
            teleportedThisTurn: false,
            onHatchIdleTurns: 0,
            statusEffects: [],
            meleeTrapMode: false,
          });
        });
        return false;

      case 'setBotAction':
        host.setBotAction(step.botId, step.action);
        return false;

      case 'botThrow': {
        const bombType = step.bombType;
        const autoEquip = step.autoEquip ?? true;
        // Action convention: slotIndex 0 = rock (no inventory entry),
        // 1..4 → inventory.slots[0..3]. autoEquip only makes sense for the
        // inventory slots; rock is always available on every bomberman.
        if (autoEquip && bombType && step.slotIndex >= 1 && step.slotIndex <= INVENTORY_SLOT_COUNT) {
          const invIdx = step.slotIndex - 1;
          host.mutateState(s => {
            const bot = s.bombermen.find(b => b.playerId === step.botId);
            if (!bot) return;
            const slot = bot.inventory.slots[invIdx];
            if (!slot || slot.type !== bombType || slot.count < 1) {
              bot.inventory.slots[invIdx] = { type: bombType, count: 1 };
            }
          });
        }
        host.setBotAction(step.botId, {
          kind: 'throw',
          slotIndex: step.slotIndex,
          x: step.x,
          y: step.y,
        });
        return false;
      }

      case 'botMove':
        host.setBotAction(step.botId, { kind: 'move', x: step.x, y: step.y });
        return false;

      case 'equipPlayerBomb':
        host.mutateState(s => {
          const me = s.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
          if (!me) return;
          me.inventory.slots[step.slot] = { type: step.type, count: step.count };
        });
        return false;

      case 'teleportPlayer':
        host.mutateState(s => {
          const me = s.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
          if (!me) return;
          me.x = step.x;
          me.y = step.y;
        });
        return false;

      case 'waitForAction':
        this.expected = step.expected;
        this.hintTarget = step.hintText ? null : null; // reserved for Phase 5+
        return true;

      case 'resolveTurn':
        // Only reachable if waitForAction already resolved. Auto-advance.
        return false;

      case 'endTutorial':
        this.finished = true;
        host.endTutorial(step.message);
        return true;
    }
  }

  private matchesExpected(action: PlayerAction, expected: ExpectedAction): boolean {
    switch (expected.kind) {
      case 'idle':
        return action.kind === 'idle';
      case 'moveTo': {
        if (action.kind !== 'move') return false;
        if (action.x !== expected.x || action.y !== expected.y) return false;
        // Rush fields: when the script specifies a rush target, the action
        // must carry matching rushX/rushY. When omitted, the action must
        // NOT carry rush fields (keeps non-rush beats strict).
        if (expected.rushX !== undefined || expected.rushY !== undefined) {
          return action.rushX === expected.rushX && action.rushY === expected.rushY;
        }
        return action.rushX === undefined && action.rushY === undefined;
      }
      case 'reachTile':
        // Multi-turn walk: accept any move action. The client's BFS path
        // determines the exact tile sequence. onTurnResolved decides when
        // we've actually arrived and the script can advance.
        return action.kind === 'move';
      case 'throwAt':
        return action.kind === 'throw'
          && action.slotIndex === expected.slotIndex
          && action.x === expected.x
          && action.y === expected.y;
      case 'lootBomb':
        // lootBomb arrives via sendLoot, not sendAction — never matched here.
        return false;
      case 'selectBomb':
        // selectBomb arrives via onSlotSelected, not sendAction — never
        // matched here. A gameplay action received while a selectBomb
        // expectation is active is rejected (the player has to click the
        // slot first).
        return false;
    }
  }
}
