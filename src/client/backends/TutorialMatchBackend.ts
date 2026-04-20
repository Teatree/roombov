import type { MatchBackend } from './MatchBackend.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { resolveTurn, type TurnEvent } from '@shared/systems/TurnResolver.ts';
import { BALANCE } from '@shared/config/balance.ts';
import type { MapData } from '@shared/types/map.ts';
import type { MatchState, PlayerAction } from '@shared/types/match.ts';
import type { BombermanState } from '@shared/types/bomberman.ts';
import type { LootBombMsg, MatchEndMsg } from '@shared/types/messages.ts';
import { TutorialDirector } from '../tutorial/TutorialDirector.ts';
import { TUTORIAL_SCRIPT } from '../tutorial/tutorial-script.ts';
import type { TutorialHost, HighlightTarget } from '../tutorial/types.ts';
import type { TutorialOverlayScene } from '../scenes/TutorialOverlayScene.ts';

export const TUTORIAL_PLAYER_ID = 'tutorial-player';
export const TUTORIAL_MAP_ID = 'tutorial_map';
export const TUTORIAL_MATCH_ID = 'tutorial-match';

/**
 * Tutorial backend — runs `resolveTurn` locally in place of a server round-trip.
 *
 * Phase 2 skeleton: fabricates an initial MatchState (char4 at Spawn1, empty
 * inventory), forwards player actions through `resolveTurn` as the only
 * actor, and emits updated snapshots on every resolve.
 *
 * Later phases will add the TutorialDirector, scripted bots, expected-action
 * validation, loot handling, and the scripted match-end hand-off.
 */
export class TutorialMatchBackend implements MatchBackend {
  private state: MatchState | null = null;
  private map: MapData | null = null;
  private stateCb: ((state: MatchState) => void) | null = null;
  private turnCb: ((events: TurnEvent[]) => void) | null = null;
  private endCb: ((msg: MatchEndMsg) => void) | null = null;
  private started = false;
  private director: TutorialDirector = new TutorialDirector(TUTORIAL_SCRIPT);
  private overlay: TutorialOverlayScene | null = null;
  /** True once both the initial state has been delivered AND the overlay has
   *  attached. The director starts on the second of those two events. */
  private bootstrapComplete = false;
  /** Scripted bot actions queued for the next resolveTurn. Cleared after use. */
  private pendingBotActions = new Map<string, PlayerAction>();

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.bootstrap();
  }

  sendAction(action: PlayerAction): void {
    if (!this.state || !this.map) return;
    if (this.state.phase !== 'input') return;

    // Director gate: self-click-idle may be muted, and an expected action may
    // swallow non-matching inputs. If muted idle → drop. If wrong action →
    // drop (the director has already flashed a hint inside validate*).
    if (action.kind === 'idle' && this.director.shouldSwallowIdle()) return;
    if (!this.director.validatePlayerAction(action)) return;

    this.resolveLocal(action);
    this.director.onTurnResolved();
  }

  sendLoot(msg: LootBombMsg): void {
    if (!this.state) return;
    if (!this.director.validatePlayerLoot(msg.sourceKind, msg.bombType)) return;

    this.applyLootLocally(msg);
    this.stateCb?.(this.state);
    this.director.onLootResolved();
  }

  /**
   * Local port of MatchRoom.handleLoot — chest/body pickup with stack-limit
   * handling and swap-back-to-source. Server-authoritative behavior is
   * mirrored byte-for-byte so the tutorial teaches exactly what a real match
   * does.
   */
  private applyLootLocally(msg: LootBombMsg): void {
    if (!this.state) return;
    const me = this.state.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
    if (!me || !me.alive || me.escaped) return;
    if (msg.targetSlotIndex < 1 || msg.targetSlotIndex > 4) return;
    const invIdx = msg.targetSlotIndex - 1;
    const stackLimit = BALANCE.match.bombSlotStackLimit;

    const next = structuredClone(this.state);
    const meN = next.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID)!;

    if (msg.sourceKind === 'chest') {
      const chest = next.chests.find(c => c.id === msg.sourceId && c.x === meN.x && c.y === meN.y);
      if (!chest) return;
      const entry = chest.bombs.find(b => b.type === msg.bombType);
      if (!entry || entry.count <= 0) return;

      const slot = meN.inventory.slots[invIdx];
      if (!slot) {
        const take = Math.min(entry.count, stackLimit);
        meN.inventory.slots[invIdx] = { type: entry.type, count: take };
        entry.count -= take;
      } else if (slot.type === entry.type) {
        const room = stackLimit - slot.count;
        const take = Math.min(entry.count, room);
        slot.count += take;
        entry.count -= take;
      } else {
        const oldType = slot.type;
        const oldCount = slot.count;
        const take = Math.min(entry.count, stackLimit);
        meN.inventory.slots[invIdx] = { type: entry.type, count: take };
        entry.count -= take;
        const existing = chest.bombs.find(b => b.type === oldType);
        if (existing) existing.count += oldCount;
        else chest.bombs.push({ type: oldType, count: oldCount });
      }
      chest.bombs = chest.bombs.filter(b => b.count > 0);
    } else {
      const body = next.bodies.find(b => b.id === msg.sourceId && b.x === meN.x && b.y === meN.y);
      if (!body) return;
      const entry = body.bombs.find(b => b.type === msg.bombType);
      if (!entry || entry.count <= 0) return;

      const slot = meN.inventory.slots[invIdx];
      if (!slot) {
        const take = Math.min(entry.count, stackLimit);
        meN.inventory.slots[invIdx] = { type: entry.type, count: take };
        entry.count -= take;
      } else if (slot.type === entry.type) {
        const room = stackLimit - slot.count;
        const take = Math.min(entry.count, room);
        slot.count += take;
        entry.count -= take;
      } else {
        const oldType = slot.type;
        const oldCount = slot.count;
        const take = Math.min(entry.count, stackLimit);
        meN.inventory.slots[invIdx] = { type: entry.type, count: take };
        entry.count -= take;
        const existing = body.bombs.find(b => b.type === oldType);
        if (existing) existing.count += oldCount;
        else body.bombs.push({ type: oldType, count: oldCount });
      }
      body.bombs = body.bombs.filter(b => b.count > 0);
    }

    this.state = next;
  }

  onMatchState(cb: (state: MatchState) => void): void {
    this.stateCb = cb;
  }

  onTurnResult(cb: (events: TurnEvent[]) => void): void {
    this.turnCb = cb;
  }

  onMatchEnd(cb: (msg: MatchEndMsg) => void): void {
    this.endCb = cb;
  }

  destroy(): void {
    this.stateCb = null;
    this.turnCb = null;
    this.endCb = null;
    this.state = null;
    this.map = null;
    this.started = false;
    this.overlay = null;
    this.bootstrapComplete = false;
  }

  /** Called by TutorialOverlayScene once it has finished creating its UI.
   *  Triggers the director to start stepping the script. */
  attachOverlay(overlay: TutorialOverlayScene): void {
    this.overlay = overlay;
    this.tryStartDirector();
  }

  /**
   * Runs resolveTurn with the given player action + any queued bot actions.
   * Broken out so the director's forceIdleAndResolve can share the same path.
   */
  private resolveLocal(action: PlayerAction): void {
    if (!this.state || !this.map) return;

    const actions = new Map<string, PlayerAction>();
    actions.set(TUTORIAL_PLAYER_ID, action);
    for (const [botId, botAction] of this.pendingBotActions) {
      actions.set(botId, botAction);
    }
    // Bots without a scripted action this turn idle by default.
    for (const b of this.state.bombermen) {
      if (b.playerId === TUTORIAL_PLAYER_ID) continue;
      if (!actions.has(b.playerId)) actions.set(b.playerId, { kind: 'idle' });
    }
    this.pendingBotActions.clear();

    // Advance to transition first (matches the server's two-phase cycle).
    this.state = { ...this.state, phase: 'transition' };
    this.stateCb?.(this.state);

    const result = resolveTurn(this.state, actions, this.map);
    this.state = {
      ...result.state,
      phase: 'input',
      phaseEndsAt: Date.now() + BALANCE.match.inputPhaseSeconds * 1000,
    };

    this.turnCb?.(result.events);
    this.stateCb?.(this.state);
  }

  /** Start the director once both the initial state and the overlay exist. */
  private tryStartDirector(): void {
    if (this.bootstrapComplete) return;
    if (!this.state || !this.overlay) return;
    this.bootstrapComplete = true;
    const host = this.buildHost();
    this.director.start(host);
  }

  /** Wire the director's host interface to the overlay and backend internals. */
  private buildHost(): TutorialHost {
    const overlay = this.overlay!;
    return {
      showDialogue: (text, onAdvance) => overlay.showDialogue(text, onAdvance),
      hideDialogue: () => overlay.hideDialogue(),
      showPause: (text, onAdvance) => overlay.showPause(text, onAdvance),
      hidePause: () => overlay.hidePause(),
      setHighlight: (t) => overlay.setHighlight(this.resolveHighlight(t)),
      flashHint: (t) => {
        const r = this.resolveHighlight(t);
        if (r) overlay.flashHint(r);
      },
      panCamera: (focus, ms, done) => {
        const world = this.focusToWorld(focus);
        overlay.panCamera(world.x, world.y, ms, done);
      },
      blockInput: (ms) => overlay.blockInput(ms),
      getState: () => this.state,
      mutateState: (fn) => {
        if (!this.state) return;
        const next = structuredClone(this.state);
        fn(next);
        this.state = next;
        this.stateCb?.(this.state);
      },
      forceIdleAndResolve: () => {
        if (!this.state || !this.map) return;
        this.resolveLocal({ kind: 'idle' });
      },
      setBotAction: (botId, action) => {
        this.pendingBotActions.set(botId, action);
      },
      endTutorial: (_message) => {
        // Synthesize a MatchEnd event. MatchScene's onMatchEnd handler
        // transitions to the results screen after the usual delay.
        const coinsEarned: Record<string, number> = {};
        if (this.state) {
          const me = this.state.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
          coinsEarned[TUTORIAL_PLAYER_ID] = me?.coins ?? 0;
        }
        this.endCb?.({
          endReason: 'all_escaped',
          escapedPlayerIds: [TUTORIAL_PLAYER_ID],
          coinsEarned,
        });
      },
    };
  }

  private resolveHighlight(target: HighlightTarget | null): Parameters<TutorialOverlayScene['setHighlight']>[0] {
    if (!target) return null;
    if (target.kind === 'rect') {
      return { x: target.x, y: target.y, w: target.w, h: target.h, space: target.space };
    }
    if (target.kind === 'tile') {
      const ts = this.map?.tileSize ?? 16;
      return { x: target.x * ts, y: target.y * ts, w: ts, h: ts, space: 'world' };
    }
    // HUD-symbolic targets are resolved by the overlay via MatchScene.getHudRect.
    const rect = this.overlay?.getHudRectFor(target);
    return rect ?? null;
  }

  private focusToWorld(focus: { x: number; y: number } | 'player'): { x: number; y: number } {
    const ts = this.map?.tileSize ?? 16;
    if (focus === 'player') {
      const me = this.state?.bombermen.find(b => b.playerId === TUTORIAL_PLAYER_ID);
      if (me) return { x: me.x * ts + ts / 2, y: me.y * ts + ts / 2 };
      return { x: 0, y: 0 };
    }
    return { x: focus.x * ts + ts / 2, y: focus.y * ts + ts / 2 };
  }

  // --- internals ---

  private async bootstrap(): Promise<void> {
    this.map = await loadMapById(TUTORIAL_MAP_ID);
    this.state = this.buildInitialState(this.map);
    this.stateCb?.(this.state);
    this.tryStartDirector();
  }

  /**
   * Fabricates an initial MatchState for the tutorial. Character is fixed to
   * char4 (uncolored) per the brief. Inventory starts empty — the script fills
   * slots via chest loot.
   */
  private buildInitialState(map: MapData): MatchState {
    const spawn = map.spawns[0] ?? { x: 0, y: 0, id: 0 };
    const player: BombermanState = {
      playerId: TUTORIAL_PLAYER_ID,
      bombermanId: 'tutorial-char4',
      colors: { shirt: 0xffffff, pants: 0xffffff, hair: 0xffffff },
      tint: 0xffffff, // uncolored char4 per brief
      character: 'char4',
      x: spawn.x,
      y: spawn.y,
      hp: BALANCE.match.bombermanMaxHp,
      alive: true,
      coins: 0,
      inventory: { slots: [null, null, null, null] },
      bleedingTurns: 0,
      escaped: false,
      rushCooldown: 0,
      rushActive: false,
      teleportedThisTurn: false,
      onHatchIdleTurns: 0,
      statusEffects: [],
      meleeTrapMode: false,
    };

    return {
      matchId: TUTORIAL_MATCH_ID,
      mapId: TUTORIAL_MAP_ID,
      phase: 'input',
      turnNumber: 1,
      phaseEndsAt: Date.now() + BALANCE.match.inputPhaseSeconds * 1000,
      bombermen: [player],
      chests: [], // script adds these via spawnChest later
      doors: (map.doors ?? []).map(d => ({
        id: d.id,
        tiles: d.tiles.map(t => ({ ...t })),
        orientation: d.orientation,
        opened: false,
      })),
      bodies: [],
      bombs: [],
      fireTiles: [],
      lightTiles: [],
      flares: [],
      bloodTiles: [],
      escapeTiles: map.escapeTiles.map(t => ({ x: t.x, y: t.y })),
      smokeClouds: [],
      mines: [],
      phosphorusPending: [],
    };
  }
}
