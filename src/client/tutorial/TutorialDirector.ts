import type {
  ExpectedAction, HighlightTarget, TutorialHost, TutorialStep,
} from './types.ts';
import type { PlayerAction } from '@shared/types/match.ts';
import { TUTORIAL_PLAYER_ID } from '../backends/TutorialMatchBackend.ts';

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

  /** True once all steps are consumed. */
  private finished = false;

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

  /** Validate a loot message against the current expectation. Returns true if
   *  the loot should be applied. */
  validatePlayerLoot(sourceKind: 'chest' | 'body', bombType: string): boolean {
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

  /** Called by backend after it has successfully resolved a turn. */
  onTurnResolved(): void {
    if (!this.expected) return;
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

      case 'promptIdle':
        host.showDialogue(step.text, () => {
          host.hideDialogue();
          this.cursor++;
          // Force an idle + resolveTurn regardless of the mute. Director
          // advances once the resolveTurn's emitted state settles.
          host.forceIdleAndResolve();
          this.advance();
        });
        return true;

      case 'highlight':
        host.setHighlight(step.target);
        return false;

      case 'clearHighlight':
        host.setHighlight(null);
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

      case 'setIdleMuted':
        this.idleMuted = step.muted;
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
            coins: step.coins,
            bombs: step.bombs.map(b => ({ ...b })),
            opened: false,
          });
        });
        return false;

      case 'spawnBot':
        host.mutateState(s => {
          const slots: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number } | null> =
            [null, null, null, null];
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
            coins: 0,
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
      case 'moveTo':
        return action.kind === 'move' && action.x === expected.x && action.y === expected.y;
      case 'throwAt':
        return action.kind === 'throw'
          && action.slotIndex === expected.slotIndex
          && action.x === expected.x
          && action.y === expected.y;
      case 'lootBomb':
        // lootBomb arrives via sendLoot, not sendAction — never matched here.
        return false;
    }
  }
}
