import type { Server, Socket } from 'socket.io';
import type {
  AnalyticsScreenEventMsg, AnalyticsTutorialEventMsg,
  AuthMsg, BuyBombermanMsg, BuyBombMsg, ClientToServerEvents, EquipBombermanMsg,
  EquipBombMsg, FactoryClaimMsg, FactoryStartMsg, GamblerStreetBetMsg, JoinMatchMsg,
  LootBombMsg, PlayerActionMsg, ServerToClientEvents, UnequipBombMsg, UpgradeBombermanMsg,
} from '../shared/types/messages.ts';
import type { MatchConfig } from '../shared/types/match.ts';
import { PlayerStore } from './PlayerStore.ts';
import { BombermanShopService } from './BombermanShopService.ts';
import { BombsShopService } from './BombsShopService.ts';
import { BombermanUpgradeService } from './BombermanUpgradeService.ts';
import { GamblerStreetService } from './GamblerStreetService.ts';
import { FactoryService } from './FactoryService.ts';
import { MatchScheduler } from './MatchScheduler.ts';
import { MatchRoom, loadMapForMatch, type MatchRoomParticipant } from './MatchRoom.ts';
import {
  logScreenEvent, logTutorialEvent, newAnalyticsId,
  type TutorialExitReason,
} from './Analytics.ts';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Tracks which match (if any) a socket has joined in the lobby or in play.
 *  Also holds in-memory analytics state — IP, current screen visit, current
 *  tutorial run. NOT persisted to the profile JSON. */
interface PlayerSession {
  playerId: string;
  joinedMatchId: string | null;
  /** Best-effort client IP. Empty string when unknown. */
  ip: string;
  /** Most recently exited screen, used for `previousScreen` on the next enter.
   *  Starts as `Boot` so the first navigation reports `Boot` as the source. */
  lastScreen: string;
  /** Currently-open screen visit; null when no tracked screen is active. */
  currentScreen: string | null;
  currentVisitId: string | null;
  /** Unix ms the current screen was entered. */
  screenEnteredAt: number;
  /** Currently-open tutorial run; null when not in tutorial. */
  tutorialRunId: string | null;
  tutorialEnteredAt: number;
}

/** Tracked menu screens — matches the spec exactly. Boot / Match / Tooltip /
 *  TutorialOverlay are intentionally excluded. */
const TRACKED_SCREENS = new Set<string>([
  'MainMenu', 'Lobby', 'BombermanShop', 'BombsShop',
  'Factory', 'BombermanUpgrade', 'Results',
]);

function extractIp(socket: TypedSocket): string {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0]?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address ?? '';
}

export class GameServer {
  private io: TypedServer;
  private playerStore: PlayerStore;
  private bombermanShop: BombermanShopService;
  private bombsShop: BombsShopService;
  private upgradeService: BombermanUpgradeService;
  private gamblerStreet: GamblerStreetService;
  private factories: FactoryService;
  private matchScheduler: MatchScheduler;
  /** active MatchRooms keyed by matchId */
  private matchRooms = new Map<string, MatchRoom>();
  /** socketId → session info */
  private sessions = new Map<string, PlayerSession>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(io: TypedServer, playerStore: PlayerStore) {
    this.io = io;
    this.playerStore = playerStore;
    // Per-player shop state — no global broadcast. Each socket gets its own
    // cycle when it requests via `bomberman_shop_request`, and pushes its
    // own update on purchase.
    this.bombermanShop = new BombermanShopService(playerStore);
    this.bombsShop = new BombsShopService(playerStore);
    this.upgradeService = new BombermanUpgradeService(playerStore);
    this.gamblerStreet = new GamblerStreetService(playerStore);
    this.factories = new FactoryService(playerStore);
    this.matchScheduler = new MatchScheduler();

    this.tickInterval = setInterval(() => this.tickLobby(), 1000);

    io.on('connection', (socket) => {
      console.log(`[Server] Socket connected: ${socket.id}`);
      // Stash IP on socket.data so we can read it again after auth without
      // re-parsing handshake headers (and so it survives the auth flow).
      const ip = extractIp(socket);
      (socket.data as { ip?: string }).ip = ip;

      socket.on('auth', (msg) => this.onAuth(socket, msg));
      socket.on('debug_reset', () => this.onDebugReset(socket));
      socket.on('bomberman_shop_request', () => this.onBombermanShopRequest(socket));
      socket.on('buy_bomberman', (msg) => this.onBuyBomberman(socket, msg));
      socket.on('equip_bomberman', (msg) => this.onEquipBomberman(socket, msg));
      socket.on('bombs_shop_request', () => this.onBombsShopRequest(socket));
      socket.on('buy_bomb', (msg) => this.onBuyBomb(socket, msg));
      socket.on('equip_bomb', (msg) => this.onEquipBomb(socket, msg));
      socket.on('unequip_bomb', (msg) => this.onUnequipBomb(socket, msg));
      socket.on('upgrade_bomberman', (msg) => this.onUpgradeBomberman(socket, msg));
      socket.on('match_listings_request', () => this.sendListings(socket));
      socket.on('join_match', (msg) => this.onJoinMatch(socket, msg));
      socket.on('leave_match', () => this.onLeaveMatch(socket));
      socket.on('player_action', (msg) => this.onPlayerAction(socket, msg));
      socket.on('loot_bomb', (msg) => this.onLootBomb(socket, msg));
      socket.on('gambler_street_request', () => this.onGamblerStreetRequest(socket));
      socket.on('gambler_street_bet', (msg) => this.onGamblerStreetBet(socket, msg));
      socket.on('factory_request', () => this.onFactoryRequest(socket));
      socket.on('factory_start', (msg) => this.onFactoryStart(socket, msg));
      socket.on('factory_claim', (msg) => this.onFactoryClaim(socket, msg));
      socket.on('analytics_screen_event', (msg) => this.onAnalyticsScreenEvent(socket, msg));
      socket.on('analytics_tutorial_event', (msg) => this.onAnalyticsTutorialEvent(socket, msg));

      socket.on('disconnect', () => {
        const session = this.sessions.get(socket.id);
        console.log(`[Server] Socket disconnected: ${socket.id} (player ${session?.playerId ?? 'unknown'})`);
        if (session?.joinedMatchId) {
          this.matchScheduler.leaveMatch(session.joinedMatchId);
        }
        // Tutorial sessions still in progress at disconnect count as abandoned.
        // Per spec: "Crashed/closed sessions leave a dangling enter with no
        // matching exit" is fine for screens (orphans surface drop-offs), but
        // we DO emit a synthetic abandoned exit for tutorial because that's
        // the only signal the analyst has for "started but never finished".
        if (session && session.tutorialRunId) {
          this.emitTutorialExit(session, 'abandoned', '');
        }
        this.sessions.delete(socket.id);
      });
    });
  }

  private tickLobby(): void {
    const launched = this.matchScheduler.tick();
    this.io.emit('match_listings', { listings: this.matchScheduler.getListings() });
    for (const config of launched) {
      void this.launchMatch(config);
    }
  }

  private async launchMatch(config: MatchConfig): Promise<void> {
    // Gather participants from sessions
    const participants: MatchRoomParticipant[] = [];
    for (const [socketId, session] of this.sessions) {
      if (session.joinedMatchId !== config.id) continue;
      const profile = this.playerStore.get(session.playerId);
      if (!profile) continue;
      participants.push({ playerId: session.playerId, socketId, profile });
    }

    if (participants.length === 0) {
      console.log(`[Server] Match ${config.id} launched with 0 participants — skipping`);
      return;
    }

    const map = await loadMapForMatch(config.mapId);
    const room = new MatchRoom(config, map, participants, this.io, this.playerStore, () => {
      this.matchRooms.delete(config.id);
      // Clear session binding AND unsubscribe each participant's socket from
      // the match's socket.io room. Without the .leave() call, a player who
      // later joins a different match keeps receiving broadcasts from this
      // one (flickering state, stale camera targets, etc.).
      for (const p of participants) {
        if (!p.socketId) continue; // skip bots
        const sess = this.sessions.get(p.socketId);
        if (sess) sess.joinedMatchId = null;
        const sock = this.io.sockets.sockets.get(p.socketId);
        if (sock) sock.leave(config.id);
      }
    }, this.getAnalyticsContextForPlayer.bind(this));
    this.matchRooms.set(config.id, room);

    // Move everyone into the socket.io room and notify
    for (const p of participants) {
      if (!p.socketId) continue; // skip bots
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) sock.join(config.id);
    }
    this.io.to(config.id).emit('match_start', { matchId: config.id });

    // Short delay so clients can transition scenes before the first state arrives
    setTimeout(() => room.start(), 250);
    console.log(`[Server] Match ${config.id} started with ${participants.length} participant(s)`);
  }

  private sendListings(socket: TypedSocket): void {
    socket.emit('match_listings', { listings: this.matchScheduler.getListings() });
  }

  private getProfileForSocket(socket: TypedSocket) {
    const session = this.sessions.get(socket.id);
    if (!session) return null;
    return this.playerStore.get(session.playerId);
  }

  private getSession(socket: TypedSocket): PlayerSession | null {
    return this.sessions.get(socket.id) ?? null;
  }

  private async onAuth(socket: TypedSocket, msg: AuthMsg): Promise<void> {
    const profile = await this.playerStore.loadOrCreate(msg.playerId);
    const ip = (socket.data as { ip?: string }).ip ?? '';
    // Preserve in-flight analytics state on re-auth (same socket, repeat auth)
    // — otherwise a reconnection in the middle of a tutorial would lose its
    // run id. New socket → new session.
    const existing = this.sessions.get(socket.id);
    this.sessions.set(socket.id, {
      playerId: profile.id,
      joinedMatchId: existing?.joinedMatchId ?? null,
      ip,
      lastScreen: existing?.lastScreen ?? 'Boot',
      currentScreen: existing?.currentScreen ?? null,
      currentVisitId: existing?.currentVisitId ?? null,
      screenEnteredAt: existing?.screenEnteredAt ?? 0,
      tutorialRunId: existing?.tutorialRunId ?? null,
      tutorialEnteredAt: existing?.tutorialEnteredAt ?? 0,
    });
    socket.emit('profile', { profile });
    socket.emit('match_listings', { listings: this.matchScheduler.getListings() });
    console.log(`[Server] Auth: socket ${socket.id} → player ${profile.id} (coins=${profile.coins})`);
  }

  private onDebugReset(socket: TypedSocket): void {
    const t0 = Date.now();
    const session = this.getSession(socket);
    if (!session) {
      console.warn(`[Server] debug_reset from unknown socket ${socket.id}`);
      return;
    }
    console.log(`[Server] debug_reset received from ${session.playerId}`);
    if (session.joinedMatchId) this.matchScheduler.leaveMatch(session.joinedMatchId);
    session.joinedMatchId = null;
    const fresh = this.playerStore.resetProfile(session.playerId);
    socket.emit('profile', { profile: fresh });
    console.log(`[Server] debug_reset completed for ${session.playerId} in ${Date.now() - t0}ms`);
  }

  private async onBombermanShopRequest(socket: TypedSocket): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const cycle = await this.bombermanShop.getCycleForClient(profile);
    socket.emit('bomberman_shop_cycle', cycle);
  }

  private async onBuyBomberman(socket: TypedSocket, msg: BuyBombermanMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombermanShop.buyBomberman(profile, msg.templateId);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'buy_bomberman', message: 'Purchased!' });
      // Re-broadcast the (now-mutated) cycle so the client knows about the
      // freshly-added bought-template-id and can animate the card out.
      if (profile.bombermanShop) {
        socket.emit('bomberman_shop_cycle', await this.bombermanShop.getCycleForClient(profile));
      }
    } else {
      socket.emit('shop_result', { ok: false, action: 'buy_bomberman', reason: result.reason });
    }
  }

  private async onEquipBomberman(socket: TypedSocket, msg: EquipBombermanMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombermanShop.equipBomberman(profile, msg.ownedId);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'equip_bomberman', message: 'Equipped!' });
    } else {
      socket.emit('shop_result', { ok: false, action: 'equip_bomberman', reason: result.reason });
    }
  }

  private onBombsShopRequest(socket: TypedSocket): void {
    socket.emit('bombs_catalog', { catalog: this.bombsShop.getCatalog() });
  }

  private async onBuyBomb(socket: TypedSocket, msg: BuyBombMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombsShop.buyBomb(profile, msg.type, msg.quantity);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'buy_bomb', message: 'Purchased!' });
    } else {
      socket.emit('shop_result', { ok: false, action: 'buy_bomb', reason: result.reason });
    }
  }

  private async onEquipBomb(socket: TypedSocket, msg: EquipBombMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombsShop.equipToSlot(profile, msg.type, msg.slotIndex, msg.quantity);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'equip_bomb', message: 'Equipped!' });
    } else {
      socket.emit('shop_result', { ok: false, action: 'equip_bomb', reason: result.reason });
    }
  }

  private async onUpgradeBomberman(socket: TypedSocket, msg: UpgradeBombermanMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.upgradeService.applyUpgrade(profile, msg.ownedId, msg.track);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'upgrade_bomberman', message: 'Upgraded!' });
    } else {
      socket.emit('shop_result', { ok: false, action: 'upgrade_bomberman', reason: result.reason });
    }
  }

  private async onUnequipBomb(socket: TypedSocket, msg: UnequipBombMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombsShop.unequipSlot(profile, msg.slotIndex);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'equip_bomb', message: 'Unequipped' });
    } else {
      socket.emit('shop_result', { ok: false, action: 'equip_bomb', reason: result.reason });
    }
  }

  private onJoinMatch(socket: TypedSocket, msg: JoinMatchMsg): void {
    const session = this.getSession(socket);
    if (!session) return;
    // Stale-session cleanup: if we still think this socket is in a match but
    // that match no longer exists (died/escaped players whose client missed
    // the leave_match emit, or races with match finalize), drop the binding
    // and allow the join to proceed. Prevents the "Join does nothing" bug.
    if (session.joinedMatchId && !this.matchRooms.has(session.joinedMatchId)) {
      session.joinedMatchId = null;
    }
    if (session.joinedMatchId) return; // actively in a running match

    const profile = this.playerStore.get(session.playerId);
    if (!profile) return;
    if (!profile.equippedBombermanId) {
      socket.emit('shop_result', { ok: false, action: 'buy_bomberman', reason: 'no_equipped_bomberman', message: 'Equip a Bomberman first!' });
      return;
    }

    const config = this.matchScheduler.joinMatch(msg.matchId);
    if (!config) return;
    session.joinedMatchId = config.id;
    socket.emit('joined_match', { matchId: config.id });
    this.io.emit('match_listings', { listings: this.matchScheduler.getListings() });
  }

  private onLeaveMatch(socket: TypedSocket): void {
    const session = this.getSession(socket);
    if (!session?.joinedMatchId) return;
    const leavingId = session.joinedMatchId;
    this.matchScheduler.leaveMatch(leavingId);
    session.joinedMatchId = null;
    // Unsubscribe from the old match's socket.io room so we stop receiving
    // its `match_state`/`turn_result` broadcasts while playing a new match.
    socket.leave(leavingId);
    this.io.emit('match_listings', { listings: this.matchScheduler.getListings() });
  }

  private onPlayerAction(socket: TypedSocket, msg: PlayerActionMsg): void {
    const session = this.getSession(socket);
    if (!session?.joinedMatchId) return;
    const room = this.matchRooms.get(session.joinedMatchId);
    if (!room) return;
    room.submitAction(session.playerId, msg.action);
  }

  private onLootBomb(socket: TypedSocket, msg: LootBombMsg): void {
    const session = this.getSession(socket);
    if (!session?.joinedMatchId) return;
    const room = this.matchRooms.get(session.joinedMatchId);
    if (!room) return;
    room.handleLoot(session.playerId, msg);
  }

  private async onGamblerStreetRequest(socket: TypedSocket): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const state = await this.gamblerStreet.refresh(profile);
    socket.emit('gambler_street_state', { state });
    // Profile may have changed (lastTickedAt, slot updates) — broadcast so the
    // ProfileStore on the client also has the latest gamblerStreet snapshot
    // and the persistent treasure widget stays in sync.
    socket.emit('profile', { profile });
  }

  private async onGamblerStreetBet(socket: TypedSocket, msg: GamblerStreetBetMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.gamblerStreet.bet(profile, msg.slotIndex, msg.tier, msg.pickedHand);
    if (result.ok) {
      socket.emit('gambler_street_bet_result', {
        ok: true,
        outcome: result.outcome,
        state: result.state,
      });
      socket.emit('profile', { profile });
    } else {
      socket.emit('gambler_street_bet_result', { ok: false, reason: result.reason });
    }
  }

  private async onFactoryRequest(socket: TypedSocket): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    // Lazy resolve. Persist + re-emit profile if anything completed so the
    // client sees newly-produced bombs in storage right away.
    const changed = this.factories.resolveAll(profile);
    if (changed) await this.playerStore.save(profile);
    socket.emit('profile', { profile });
  }

  private async onFactoryStart(socket: TypedSocket, msg: FactoryStartMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.factories.startCycle(profile, msg.factoryId);
    socket.emit('factory_result', {
      ok: result.ok,
      action: 'start',
      factoryId: msg.factoryId,
      reason: result.ok ? undefined : result.reason,
    });
    if (result.ok) socket.emit('profile', { profile });
  }

  private async onFactoryClaim(socket: TypedSocket, msg: FactoryClaimMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = msg.index == null
      ? await this.factories.claimAll(profile, msg.factoryId)
      : await this.factories.claimOne(profile, msg.factoryId, msg.index);
    socket.emit('factory_result', {
      ok: result.ok,
      action: 'claim',
      factoryId: msg.factoryId,
      reason: result.ok ? undefined : result.reason,
    });
    if (result.ok) socket.emit('profile', { profile });
  }

  /**
   * Look up the per-socket session for a given player id. MatchRoom uses
   * this at settlement time to read IP + sessionId for analytics rows.
   * Returns null for bots/scavs (no socket) or disconnected players.
   */
  getAnalyticsContextForPlayer(playerId: string): { sessionId: string; ip: string } | null {
    for (const [socketId, session] of this.sessions) {
      if (session.playerId === playerId) {
        return { sessionId: socketId, ip: session.ip };
      }
    }
    return null;
  }

  private onAnalyticsScreenEvent(socket: TypedSocket, msg: AnalyticsScreenEventMsg): void {
    const session = this.getSession(socket);
    if (!session) return;
    if (!TRACKED_SCREENS.has(msg.screen)) return;
    const profile = this.playerStore.get(session.playerId);
    const profileName = profile?.name ?? '';
    const coinsAtEvent = profile?.coins ?? 0;
    const now = Date.now();

    if (msg.eventType === 'enter') {
      // Close any orphaned visit first — if the client never sent the matching
      // exit (e.g. crashed scene transition), drop a synthetic exit so the row
      // pairing still works. The dangling-enter pattern from the spec only
      // applies to disconnected sessions, not normal scene churn.
      if (session.currentScreen && session.currentVisitId) {
        logScreenEvent({
          ip: session.ip,
          sessionId: socket.id,
          visitId: session.currentVisitId,
          profileId: session.playerId,
          profileName,
          screen: session.currentScreen,
          eventType: 'exit',
          previousScreen: '',
          durationMs: Math.max(0, now - session.screenEnteredAt),
          coinsAtEvent,
        });
        session.lastScreen = session.currentScreen;
      }
      const visitId = newAnalyticsId();
      session.currentScreen = msg.screen;
      session.currentVisitId = visitId;
      session.screenEnteredAt = now;
      logScreenEvent({
        ip: session.ip,
        sessionId: socket.id,
        visitId,
        profileId: session.playerId,
        profileName,
        screen: msg.screen,
        eventType: 'enter',
        previousScreen: session.lastScreen,
        durationMs: '',
        coinsAtEvent,
      });
    } else {
      // Only emit if the exit matches the open visit. Stray exits (mismatched
      // scene name) are silently ignored.
      if (session.currentScreen !== msg.screen || !session.currentVisitId) return;
      logScreenEvent({
        ip: session.ip,
        sessionId: socket.id,
        visitId: session.currentVisitId,
        profileId: session.playerId,
        profileName,
        screen: msg.screen,
        eventType: 'exit',
        previousScreen: '',
        durationMs: Math.max(0, now - session.screenEnteredAt),
        coinsAtEvent,
      });
      session.lastScreen = msg.screen;
      session.currentScreen = null;
      session.currentVisitId = null;
    }
  }

  private onAnalyticsTutorialEvent(socket: TypedSocket, msg: AnalyticsTutorialEventMsg): void {
    const session = this.getSession(socket);
    if (!session) return;
    const profile = this.playerStore.get(session.playerId);
    const profileName = profile?.name ?? '';

    if (msg.eventType === 'enter') {
      // Close any in-flight tutorial first (rapid re-enter or missed exit).
      if (session.tutorialRunId) {
        this.emitTutorialExit(session, 'abandoned', '');
      }
      session.tutorialRunId = newAnalyticsId();
      session.tutorialEnteredAt = Date.now();
      logTutorialEvent({
        ip: session.ip,
        sessionId: socket.id,
        tutorialRunId: session.tutorialRunId,
        profileId: session.playerId,
        profileName,
        eventType: 'enter',
        exitReason: '',
        furthestStepReached: '',
        durationMs: '',
      });
    } else {
      const reason: TutorialExitReason = msg.exitReason ?? 'abandoned';
      const step = msg.furthestStepReached ?? '';
      this.emitTutorialExit(session, reason, step);
    }
  }

  /** Emit a tutorial exit row using the open run id, then clear it. No-op if
   *  no tutorial run is open on this session. */
  private emitTutorialExit(session: PlayerSession, reason: TutorialExitReason, step: string): void {
    if (!session.tutorialRunId) return;
    const profile = this.playerStore.get(session.playerId);
    logTutorialEvent({
      ip: session.ip,
      sessionId: this.sessionIdForPlayer(session.playerId) ?? '',
      tutorialRunId: session.tutorialRunId,
      profileId: session.playerId,
      profileName: profile?.name ?? '',
      eventType: 'exit',
      exitReason: reason,
      furthestStepReached: step,
      durationMs: Math.max(0, Date.now() - session.tutorialEnteredAt),
    });
    session.tutorialRunId = null;
  }

  private sessionIdForPlayer(playerId: string): string | null {
    for (const [socketId, session] of this.sessions) {
      if (session.playerId === playerId) return socketId;
    }
    return null;
  }

  async destroy(): Promise<void> {
    if (this.tickInterval) clearInterval(this.tickInterval);
    for (const room of this.matchRooms.values()) room.destroy();
    this.matchRooms.clear();
    await this.playerStore.flush();
  }
}
