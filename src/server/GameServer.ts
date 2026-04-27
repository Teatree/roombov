import type { Server, Socket } from 'socket.io';
import type {
  AuthMsg, BuyBombermanMsg, BuyBombMsg, ClientToServerEvents, EquipBombermanMsg,
  EquipBombMsg, GamblerStreetBetMsg, JoinMatchMsg, LootBombMsg, PlayerActionMsg,
  ServerToClientEvents, UnequipBombMsg,
} from '../shared/types/messages.ts';
import type { MatchConfig } from '../shared/types/match.ts';
import { PlayerStore } from './PlayerStore.ts';
import { BombermanShopService } from './BombermanShopService.ts';
import { BombsShopService } from './BombsShopService.ts';
import { GamblerStreetService } from './GamblerStreetService.ts';
import { MatchScheduler } from './MatchScheduler.ts';
import { MatchRoom, loadMapForMatch, type MatchRoomParticipant } from './MatchRoom.ts';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Tracks which match (if any) a socket has joined in the lobby or in play. */
interface PlayerSession {
  playerId: string;
  joinedMatchId: string | null;
}

export class GameServer {
  private io: TypedServer;
  private playerStore: PlayerStore;
  private bombermanShop: BombermanShopService;
  private bombsShop: BombsShopService;
  private gamblerStreet: GamblerStreetService;
  private matchScheduler: MatchScheduler;
  /** active MatchRooms keyed by matchId */
  private matchRooms = new Map<string, MatchRoom>();
  /** socketId → session info */
  private sessions = new Map<string, PlayerSession>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(io: TypedServer, playerStore: PlayerStore) {
    this.io = io;
    this.playerStore = playerStore;
    this.bombermanShop = new BombermanShopService(playerStore, (cycle) => {
      this.io.emit('bomberman_shop_cycle', cycle);
    });
    this.bombsShop = new BombsShopService(playerStore);
    this.gamblerStreet = new GamblerStreetService(playerStore);
    this.matchScheduler = new MatchScheduler();

    this.tickInterval = setInterval(() => this.tickLobby(), 1000);

    io.on('connection', (socket) => {
      console.log(`[Server] Socket connected: ${socket.id}`);

      socket.on('auth', (msg) => this.onAuth(socket, msg));
      socket.on('debug_reset', () => this.onDebugReset(socket));
      socket.on('bomberman_shop_request', () => this.onBombermanShopRequest(socket));
      socket.on('buy_bomberman', (msg) => this.onBuyBomberman(socket, msg));
      socket.on('equip_bomberman', (msg) => this.onEquipBomberman(socket, msg));
      socket.on('bombs_shop_request', () => this.onBombsShopRequest(socket));
      socket.on('buy_bomb', (msg) => this.onBuyBomb(socket, msg));
      socket.on('equip_bomb', (msg) => this.onEquipBomb(socket, msg));
      socket.on('unequip_bomb', (msg) => this.onUnequipBomb(socket, msg));
      socket.on('match_listings_request', () => this.sendListings(socket));
      socket.on('join_match', (msg) => this.onJoinMatch(socket, msg));
      socket.on('leave_match', () => this.onLeaveMatch(socket));
      socket.on('player_action', (msg) => this.onPlayerAction(socket, msg));
      socket.on('loot_bomb', (msg) => this.onLootBomb(socket, msg));
      socket.on('gambler_street_request', () => this.onGamblerStreetRequest(socket));
      socket.on('gambler_street_bet', (msg) => this.onGamblerStreetBet(socket, msg));

      socket.on('disconnect', () => {
        const session = this.sessions.get(socket.id);
        console.log(`[Server] Socket disconnected: ${socket.id} (player ${session?.playerId ?? 'unknown'})`);
        if (session?.joinedMatchId) {
          this.matchScheduler.leaveMatch(session.joinedMatchId);
        }
        this.sessions.delete(socket.id);
      });
    });
  }

  private tickLobby(): void {
    const launched = this.matchScheduler.tick();
    this.io.emit('match_listings', { listings: this.matchScheduler.getListings() });
    if (launched) {
      void this.launchMatch(launched);
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
    });
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
    this.sessions.set(socket.id, { playerId: profile.id, joinedMatchId: null });
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

  private onBombermanShopRequest(socket: TypedSocket): void {
    const cycle = this.bombermanShop.getCurrentCycle();
    socket.emit('bomberman_shop_cycle', cycle);
  }

  private async onBuyBomberman(socket: TypedSocket, msg: BuyBombermanMsg): Promise<void> {
    const profile = this.getProfileForSocket(socket);
    if (!profile) return;
    const result = await this.bombermanShop.buyBomberman(profile, msg.templateId);
    if (result.ok) {
      socket.emit('profile', { profile });
      socket.emit('shop_result', { ok: true, action: 'buy_bomberman', message: 'Purchased!' });
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

  async destroy(): Promise<void> {
    if (this.tickInterval) clearInterval(this.tickInterval);
    for (const room of this.matchRooms.values()) room.destroy();
    this.matchRooms.clear();
    await this.playerStore.flush();
  }
}
