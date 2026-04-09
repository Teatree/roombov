/**
 * Authoritative runtime for a single in-progress match.
 *
 * Owns:
 *  - the 5-second input window + 3-second transition window
 *  - collection of player actions
 *  - calling TurnResolver at phase flip
 *  - broadcasting turn results to every player in the match
 *  - scoring / profile writeback on match end
 *
 * The server broadcasts the full MatchState on phase transitions. Clients are
 * stateless with respect to rules — they just render what the server sends.
 */

import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types/messages.ts';
import type { MatchConfig, MatchState, PlayerAction, CoinBag, CollectibleBomb, DroppedBody } from '../shared/types/match.ts';
import type { LootBombMsg } from '../shared/types/messages.ts';
import type { BombermanState } from '../shared/types/bomberman.ts';
import type { MapData } from '../shared/types/map.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { resolveTurn } from '../shared/systems/TurnResolver.ts';
import { createSeededRandom, seededRandInt, seededShuffle } from '../shared/utils/seeded-random.ts';
import { loadMapById } from '../shared/maps/map-loader.ts';
import type { PlayerStore } from './PlayerStore.ts';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface MatchRoomParticipant {
  playerId: string;
  socketId: string;
  profile: PlayerProfile;
}

export class MatchRoom {
  readonly config: MatchConfig;
  readonly map: MapData;
  readonly participants: MatchRoomParticipant[];
  private io: TypedServer;
  private playerStore: PlayerStore;
  private state: MatchState;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingActions = new Map<string, PlayerAction>();
  private onEnd: () => void;

  constructor(
    config: MatchConfig,
    map: MapData,
    participants: MatchRoomParticipant[],
    io: TypedServer,
    playerStore: PlayerStore,
    onEnd: () => void,
  ) {
    this.config = config;
    this.map = map;
    this.participants = participants;
    this.io = io;
    this.playerStore = playerStore;
    this.onEnd = onEnd;

    this.state = this.buildInitialState();
  }

  get id(): string { return this.config.id; }

  private buildInitialState(): MatchState {
    const seed = hashString(this.config.id);
    const rng = createSeededRandom(seed);

    // Pick spawn points with minimum distance rule
    const spawnsOrdered = seededShuffle(rng, this.map.spawns);
    const minDist = BALANCE.match.minSpawnDistance;
    const chosen: typeof this.map.spawns = [];
    for (const candidate of spawnsOrdered) {
      if (chosen.every(c => Math.max(Math.abs(c.x - candidate.x), Math.abs(c.y - candidate.y)) >= minDist)) {
        chosen.push(candidate);
      }
      if (chosen.length === this.participants.length) break;
    }
    // Fallback: if we couldn't meet the distance rule, just take the first N
    while (chosen.length < this.participants.length) {
      chosen.push(spawnsOrdered[chosen.length % spawnsOrdered.length]);
    }

    const bombermen: BombermanState[] = this.participants.map((p, i) => {
      const spawn = chosen[i];
      const equipped = p.profile.ownedBombermen.find(b => b.id === p.profile.equippedBombermanId);
      return {
        playerId: p.playerId,
        bombermanId: equipped?.id ?? 'none',
        colors: equipped?.colors ?? { shirt: 0x888888, pants: 0x444444, hair: 0x222222 },
        x: spawn.x,
        y: spawn.y,
        hp: BALANCE.match.bombermanMaxHp,
        alive: true,
        coins: 0,
        inventory: equipped
          ? { slots: equipped.inventory.slots.map(s => (s ? { ...s } : null)) }
          : { slots: [null, null, null, null] },
        bleedingTurns: 0,
        escaped: false,
      };
    });

    // Seeded coin bags inside coinZones (1 per zone)
    const coinBags: CoinBag[] = [];
    for (const zone of this.map.coinZones) {
      const candidates: { x: number; y: number }[] = [];
      for (let dy = 0; dy < zone.h; dy++) {
        for (let dx = 0; dx < zone.w; dx++) {
          const x = zone.x + dx;
          const y = zone.y + dy;
          if (this.map.grid[y]?.[x] === 0) candidates.push({ x, y });
        }
      }
      if (candidates.length === 0) continue;
      const pick = candidates[seededRandInt(rng, 0, candidates.length)];
      coinBags.push({
        id: `coin_${coinBags.length}`,
        x: pick.x,
        y: pick.y,
        amount: seededRandInt(rng, 5, 26),
      });
    }

    // Seeded collectible bombs inside bombZones (2 per zone)
    const collectibleBombs: CollectibleBomb[] = [];
    const bombPool: Array<{ type: CollectibleBomb['type']; count: number }> = [
      { type: 'delay', count: 2 },
      { type: 'contact', count: 2 },
      { type: 'delay_big', count: 1 },
      { type: 'molotov', count: 1 },
      { type: 'banana', count: 1 },
      { type: 'flare', count: 2 },
      { type: 'delay_tricky', count: 2 },
    ];
    for (const zone of this.map.bombZones) {
      for (let n = 0; n < 2; n++) {
        const candidates: { x: number; y: number }[] = [];
        for (let dy = 0; dy < zone.h; dy++) {
          for (let dx = 0; dx < zone.w; dx++) {
            const x = zone.x + dx;
            const y = zone.y + dy;
            if (this.map.grid[y]?.[x] === 0) candidates.push({ x, y });
          }
        }
        if (candidates.length === 0) continue;
        const pick = candidates[seededRandInt(rng, 0, candidates.length)];
        const pool = bombPool[seededRandInt(rng, 0, bombPool.length)];
        collectibleBombs.push({
          id: `pickup_${collectibleBombs.length}`,
          x: pick.x,
          y: pick.y,
          type: pool.type,
          count: pool.count,
        });
      }
    }

    return {
      matchId: this.config.id,
      mapId: this.config.mapId,
      phase: 'input',
      turnNumber: 1,
      phaseEndsAt: Date.now() + BALANCE.match.inputPhaseSeconds * 1000,
      bombermen,
      coinBags,
      collectibleBombs,
      bodies: [],
      bombs: [],
      fireTiles: [],
      lightTiles: [],
      bloodTiles: [],
      escapeTiles: this.map.escapeTiles.map(t => ({ x: t.x, y: t.y })),
    };
  }

  start(): void {
    // Broadcast initial state
    this.broadcastState();
    this.scheduleInputPhaseEnd();
  }

  submitAction(playerId: string, action: PlayerAction): void {
    if (this.state.phase !== 'input') return;
    const b = this.state.bombermen.find(bb => bb.playerId === playerId);
    if (!b || !b.alive || b.escaped) return;
    this.pendingActions.set(playerId, action);
  }

  /**
   * Real-time loot handler — not turn-gated.
   *
   * Validates the player is alive, on the source tile, and the slot logic
   * from the brief:
   *  - Empty slot: fill with the looted bomb (up to stack limit)
   *  - Same-type slot: top up (up to stack limit)
   *  - Different-type slot: swap — old stack returns to the source
   *
   * On success, mutates MatchState in place and broadcasts a fresh snapshot.
   */
  handleLoot(playerId: string, msg: LootBombMsg): void {
    const me = this.state.bombermen.find(b => b.playerId === playerId);
    if (!me || !me.alive || me.escaped) return;

    // Target slot must be 1..4 (slot 0 is Rock, never writable)
    if (msg.targetSlotIndex < 1 || msg.targetSlotIndex > 4) return;
    const invIdx = msg.targetSlotIndex - 1;

    const stackLimit = BALANCE.match.bombSlotStackLimit;

    if (msg.sourceKind === 'collectible') {
      const pickup = this.state.collectibleBombs.find(
        p => p.id === msg.sourceId && p.x === me.x && p.y === me.y,
      );
      if (!pickup) return;
      if (pickup.type !== msg.bombType) return;

      const slot = me.inventory.slots[invIdx];
      if (!slot) {
        // Empty slot — fill it
        const take = Math.min(pickup.count, stackLimit);
        me.inventory.slots[invIdx] = { type: pickup.type, count: take };
        pickup.count -= take;
      } else if (slot.type === pickup.type) {
        // Same type — top up
        const room = stackLimit - slot.count;
        const take = Math.min(pickup.count, room);
        slot.count += take;
        pickup.count -= take;
      } else {
        // Different type — swap: old stack → create a new collectible at this tile
        const oldType = slot.type;
        const oldCount = slot.count;
        const take = Math.min(pickup.count, stackLimit);
        me.inventory.slots[invIdx] = { type: pickup.type, count: take };
        pickup.count -= take;
        // Drop old bombs as a new collectible on this tile
        this.state.collectibleBombs.push({
          id: `swap_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          x: me.x,
          y: me.y,
          type: oldType,
          count: oldCount,
        });
      }

      // Remove the pickup if fully consumed
      if (pickup.count <= 0) {
        this.state.collectibleBombs = this.state.collectibleBombs.filter(p => p.id !== msg.sourceId);
      }

    } else if (msg.sourceKind === 'body') {
      const body = this.state.bodies.find(
        b => b.id === msg.sourceId && b.x === me.x && b.y === me.y,
      );
      if (!body) return;

      const bombEntry = body.bombs.find(b => b.type === msg.bombType);
      if (!bombEntry || bombEntry.count <= 0) return;

      const slot = me.inventory.slots[invIdx];
      if (!slot) {
        const take = Math.min(bombEntry.count, stackLimit);
        me.inventory.slots[invIdx] = { type: bombEntry.type, count: take };
        bombEntry.count -= take;
      } else if (slot.type === bombEntry.type) {
        const room = stackLimit - slot.count;
        const take = Math.min(bombEntry.count, room);
        slot.count += take;
        bombEntry.count -= take;
      } else {
        // Swap: old bombs go back onto the body
        const oldType = slot.type;
        const oldCount = slot.count;
        const take = Math.min(bombEntry.count, stackLimit);
        me.inventory.slots[invIdx] = { type: bombEntry.type, count: take };
        bombEntry.count -= take;
        // Return old to body
        const existing = body.bombs.find(b => b.type === oldType);
        if (existing) {
          existing.count += oldCount;
        } else {
          body.bombs.push({ type: oldType, count: oldCount });
        }
      }

      body.bombs = body.bombs.filter(b => b.count > 0);
    }

    // Broadcast the updated state immediately so the client sees the change
    this.broadcastState();
  }

  private scheduleInputPhaseEnd(): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    const ms = Math.max(0, this.state.phaseEndsAt - Date.now());
    this.phaseTimer = setTimeout(() => this.endInputPhase(), ms);
  }

  private endInputPhase(): void {
    // Enter transition phase
    this.state.phase = 'transition';
    this.state.phaseEndsAt = Date.now() + BALANCE.match.transitionPhaseSeconds * 1000;

    // Resolve the turn
    const { state: nextState, events } = resolveTurn(this.state, this.pendingActions, this.map);
    this.pendingActions.clear();

    // Keep transition timing on nextState (resolver clones and may or may not keep phase)
    if (nextState.phase !== 'ended') {
      nextState.phase = 'transition';
      nextState.phaseEndsAt = this.state.phaseEndsAt;
    }

    this.state = nextState;
    this.io.to(this.id).emit('match_state', { state: this.state });
    this.io.to(this.id).emit('turn_result', { events });

    if (this.state.phase === 'ended') {
      this.finalize();
      return;
    }

    // After the transition window, re-enter input phase
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => this.beginNextInputPhase(), BALANCE.match.transitionPhaseSeconds * 1000);
  }

  private beginNextInputPhase(): void {
    this.state.phase = 'input';
    this.state.phaseEndsAt = Date.now() + BALANCE.match.inputPhaseSeconds * 1000;
    this.broadcastState();
    this.scheduleInputPhaseEnd();
  }

  private broadcastState(): void {
    this.io.to(this.id).emit('match_state', { state: this.state });
  }

  private async finalize(): Promise<void> {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);

    for (const participant of this.participants) {
      const b = this.state.bombermen.find(bb => bb.playerId === participant.playerId);
      if (!b) continue;
      const profile = participant.profile;
      const ownedBomberman = profile.ownedBombermen.find(ob => ob.id === b.bombermanId);

      if (b.escaped) {
        // Escaped: keep coins earned during the match
        profile.coins += b.coins;

        // Sync the match-end inventory back to the profile.
        // Spent bombs are gone, looted bombs are added.
        if (ownedBomberman) {
          ownedBomberman.inventory = {
            slots: b.inventory.slots.map(s => (s ? { ...s } : null)),
          };
        }
      } else {
        // Dead: lose the Bomberman entirely — strip from the profile roster.
        // Coins on the Bomberman were already dropped as a body in-match.
        const idx = profile.ownedBombermen.findIndex(ob => ob.id === b.bombermanId);
        if (idx >= 0) {
          profile.ownedBombermen.splice(idx, 1);
        }
        // Clear equipped if it was the one that died
        if (profile.equippedBombermanId === b.bombermanId) {
          profile.equippedBombermanId = profile.ownedBombermen.length > 0
            ? profile.ownedBombermen[0].id
            : null;
        }
      }

      await this.playerStore.save(profile);
      const sock = this.io.sockets.sockets.get(participant.socketId);
      if (sock) sock.emit('profile', { profile });
    }

    this.io.to(this.id).emit('match_end', {
      endReason: this.state.endReason ?? 'all_dead',
      escapedPlayerIds: this.state.escapedPlayerIds ?? [],
      coinsEarned: Object.fromEntries(
        this.state.bombermen.map(b => [b.playerId, b.coins]),
      ),
    });

    this.onEnd();
  }

  destroy(): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
  }
}

export async function loadMapForMatch(mapId: string): Promise<MapData> {
  return loadMapById(mapId);
}

function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
