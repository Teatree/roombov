import type { Server, Socket } from 'socket.io';
import { ExpeditionScheduler, generateExpeditionEntities } from '../shared/ExpeditionManager.ts';
import type { ExpeditionConfig, ExpeditionListing } from '../shared/types/expedition.ts';
import type { ExitPoint } from '../shared/types/map.ts';
import type {
  JoinMsg, JoinedMsg, ReadyMsg, PositionMsg, PlayerPositions,
  TurretKilledMsg, GoodieCollectedMsg, StageDoneMsg, StageResultMsg,
} from '../shared/types/messages.ts';

interface PlayerState {
  socketId: string;
  expeditionId: string | null;
  spawnId: number;
  assignedExits: ExitPoint[];
  ready: boolean;
  currentStage: number;
  position: { x: number; y: number; state: string; hp: number; barrelAngle: number } | null;
}

interface ExpeditionRoom {
  config: ExpeditionConfig;
  players: Map<string, PlayerState>;
  /** Server-authoritative: which turrets are dead */
  killedTurrets: Record<string, string>; // key → killedBy socketId
  /** Server-authoritative: which goodies are collected */
  collectedGoodies: Record<string, string>; // key → collectedBy socketId
  phase: 'lobby' | 'planning' | 'execution' | 'done';
  currentStage: number;
  stagesDone: Map<string, boolean>;
}

export class GameServer {
  private io: Server;
  private scheduler: ExpeditionScheduler;
  private players = new Map<string, PlayerState>();
  private rooms = new Map<string, ExpeditionRoom>();
  private listingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(io: Server) {
    this.io = io;
    this.scheduler = new ExpeditionScheduler();

    // Broadcast listings every second
    this.listingInterval = setInterval(() => {
      this.tickScheduler();
    }, 1000);

    io.on('connection', (socket) => {
      console.log(`Player connected: ${socket.id}`);
      this.onConnect(socket);

      socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        this.onDisconnect(socket);
      });

      socket.on('join', (msg: JoinMsg) => this.onJoin(socket, msg));
      socket.on('ready', (msg: ReadyMsg) => this.onReady(socket, msg));
      socket.on('position', (msg: PositionMsg) => this.onPosition(socket, msg));
      socket.on('turret_killed', (msg: TurretKilledMsg) => this.onTurretKilled(socket, msg));
      socket.on('goodie_collected', (msg: GoodieCollectedMsg) => this.onGoodieCollected(socket, msg));
      socket.on('stage_done', (msg: StageDoneMsg) => this.onStageDone(socket, msg));
    });
  }

  private tickScheduler(): void {
    const started = this.scheduler.tick();
    const listings = this.scheduler.getListings();

    // Broadcast current listings to all clients in the default namespace
    this.io.emit('listings', listings);

    // If an expedition started, notify joined players
    if (started) {
      const room = this.rooms.get(started.id);
      if (room) {
        room.phase = 'planning';
        room.currentStage = 1;
        this.io.to(started.id).emit('expedition_start', { configId: started.id });
        console.log(`Expedition ${started.id} started with ${room.players.size} players`);
      }
    }
  }

  private onConnect(socket: Socket): void {
    const player: PlayerState = {
      socketId: socket.id,
      expeditionId: null,
      spawnId: 0,
      assignedExits: [],
      ready: false,
      currentStage: 1,
      position: null,
    };
    this.players.set(socket.id, player);

    // Send current listings immediately
    socket.emit('listings', this.scheduler.getListings());
  }

  private onDisconnect(socket: Socket): void {
    const player = this.players.get(socket.id);
    if (player?.expeditionId) {
      const room = this.rooms.get(player.expeditionId);
      if (room) {
        room.players.delete(socket.id);
        socket.leave(player.expeditionId);
        // Update listing player count
        const listing = this.scheduler.getListings().find(l => l.config.id === player.expeditionId);
        if (listing) {
          (listing as ExpeditionListing).playerCount = room.players.size;
        }
        if (room.players.size === 0 && room.phase !== 'lobby') {
          this.rooms.delete(player.expeditionId);
        }
      }
    }
    this.players.delete(socket.id);
  }

  private onJoin(socket: Socket, msg: JoinMsg): void {
    const player = this.players.get(socket.id);
    if (!player) return;

    // Can't join if already in an expedition
    if (player.expeditionId) return;

    const config = this.scheduler.joinExpedition(msg.expeditionId);
    if (!config) return;

    // Create room if it doesn't exist
    if (!this.rooms.has(config.id)) {
      this.rooms.set(config.id, {
        config,
        players: new Map(),
        killedTurrets: {},
        collectedGoodies: {},
        phase: 'lobby',
        currentStage: 1,
        stagesDone: new Map(),
      });
    }

    const room = this.rooms.get(config.id)!;

    // Assign a unique spawn from the map (we don't have map data on server,
    // so assign spawn index based on join order)
    const spawnId = room.players.size;

    // Assign 3 random exits (deterministic from seed + player index)
    // For now just pick indices — client will resolve to actual ExitPoints from mapData
    const exitSeed = config.seed + spawnId;
    const assignedExitIndices = [
      exitSeed % 20,
      (exitSeed * 7 + 3) % 20,
      (exitSeed * 13 + 7) % 20,
    ];

    player.expeditionId = config.id;
    player.spawnId = spawnId;
    player.ready = false;
    player.currentStage = 1;

    room.players.set(socket.id, player);
    socket.join(config.id);

    const response: JoinedMsg = {
      expeditionId: config.id,
      spawnId,
      assignedExitIndices,
    };
    socket.emit('joined', response);

    console.log(`Player ${socket.id} joined expedition ${config.id} (spawn ${spawnId}, ${room.players.size} players)`);
  }

  private onReady(socket: Socket, msg: ReadyMsg): void {
    const player = this.players.get(socket.id);
    if (!player?.expeditionId) return;

    const room = this.rooms.get(player.expeditionId);
    if (!room || room.phase !== 'planning') return;

    player.ready = true;

    // Check if all players are ready
    let allReady = true;
    for (const [, p] of room.players) {
      if (!p.ready) { allReady = false; break; }
    }

    if (allReady) {
      room.phase = 'execution';
      room.stagesDone.clear();
      // Reset ready flags for next stage
      for (const [, p] of room.players) p.ready = false;
      this.io.to(player.expeditionId).emit('all_ready', {});
      console.log(`Expedition ${player.expeditionId} stage ${room.currentStage} execution started`);
    }
  }

  private onPosition(socket: Socket, msg: PositionMsg): void {
    const player = this.players.get(socket.id);
    if (!player?.expeditionId) return;

    player.position = {
      x: msg.x,
      y: msg.y,
      state: msg.state,
      hp: msg.hp,
      barrelAngle: msg.barrelAngle,
    };

    // Broadcast all player positions in this expedition
    const room = this.rooms.get(player.expeditionId);
    if (!room) return;

    const positions: PlayerPositions = {};
    for (const [sid, p] of room.players) {
      if (p.position) {
        positions[sid] = p.position;
      }
    }

    this.io.to(player.expeditionId).emit('players', positions);
  }

  private onTurretKilled(socket: Socket, msg: TurretKilledMsg): void {
    const player = this.players.get(socket.id);
    if (!player?.expeditionId) return;

    const room = this.rooms.get(player.expeditionId);
    if (!room) return;

    // First-come-first-served: only register if not already killed
    if (!room.killedTurrets[msg.key]) {
      room.killedTurrets[msg.key] = socket.id;
      // Broadcast to all players in this expedition
      this.io.to(player.expeditionId).emit('turret_killed', {
        key: msg.key,
        killedBy: socket.id,
      });
    }
  }

  private onGoodieCollected(socket: Socket, msg: GoodieCollectedMsg): void {
    const player = this.players.get(socket.id);
    if (!player?.expeditionId) return;

    const room = this.rooms.get(player.expeditionId);
    if (!room) return;

    // First-come-first-served
    if (!room.collectedGoodies[msg.key]) {
      room.collectedGoodies[msg.key] = socket.id;
      this.io.to(player.expeditionId).emit('goodie_collected', {
        key: msg.key,
        collectedBy: socket.id,
      });
    } else {
      // Already collected by someone else — tell this client to undo
      socket.emit('goodie_rejected', { key: msg.key });
    }
  }

  private onStageDone(socket: Socket, msg: StageDoneMsg): void {
    const player = this.players.get(socket.id);
    if (!player?.expeditionId) return;

    const room = this.rooms.get(player.expeditionId);
    if (!room) return;

    room.stagesDone.set(socket.id, true);

    // Check if all players finished this stage
    let allDone = true;
    for (const [sid] of room.players) {
      if (!room.stagesDone.has(sid)) { allDone = false; break; }
    }

    if (allDone) {
      room.stagesDone.clear();

      if (room.currentStage < room.config.stages) {
        room.currentStage++;
        room.phase = 'planning';
        // Reset ready flags
        for (const [, p] of room.players) {
          p.ready = false;
          p.position = null;
        }

        const result: StageResultMsg = { nextStage: room.currentStage };
        this.io.to(player.expeditionId).emit('stage_result', result);
      } else {
        room.phase = 'done';
        const result: StageResultMsg = { expeditionOver: true };
        this.io.to(player.expeditionId).emit('stage_result', result);

        // Cleanup room after a delay
        setTimeout(() => {
          this.rooms.delete(room.config.id);
        }, 5000);
      }
    }
  }

  destroy(): void {
    if (this.listingInterval) clearInterval(this.listingInterval);
  }
}
