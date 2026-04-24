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
import type { MatchConfig, MatchState, PlayerAction, Chest, DroppedBody } from '../shared/types/match.ts';
import type { LootBombMsg } from '../shared/types/messages.ts';
import type { BombermanState } from '../shared/types/bomberman.ts';
import { CHARACTER_VARIANTS } from '../shared/types/bomberman.ts';
import type { MapData } from '../shared/types/map.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { CHEST_CONFIG } from '../shared/config/chests.ts';
import type { BombType } from '../shared/types/bombs.ts';
import { BotPlayer } from './BotPlayer.ts';
import { rollBombermanName } from '../shared/config/bomberman-names.ts';
import { TIER_CONFIG } from '../shared/config/bomberman-tiers.ts';
import { resolveTurn } from '../shared/systems/TurnResolver.ts';
import { createSeededRandom, seededRandInt, seededShuffle } from '../shared/utils/seeded-random.ts';
import { loadMapById } from '../shared/maps/map-loader.ts';
import type { PlayerStore } from './PlayerStore.ts';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface MatchRoomParticipant {
  playerId: string;
  /** Null for bot players (no socket connection). */
  socketId: string | null;
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
  private bots: BotPlayer[] = [];
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

    // Fill empty slots with bots
    this.createBots();

    this.state = this.buildInitialState();
  }

  get id(): string { return this.config.id; }

  private createBots(): void {
    const cfg = BALANCE.bots;
    const realCount = this.participants.length;
    console.log(`[MatchRoom] createBots: real=${realCount} minPlayersForBots=${cfg.minPlayersForBots} maxPerMatch=${cfg.maxPerMatch} fillToTotal=${cfg.fillToTotal}`);
    if (realCount < cfg.minPlayersForBots) {
      console.log(`[MatchRoom] createBots: realCount<minPlayersForBots, no bots`);
      return;
    }
    const slotsToFill = Math.min(cfg.maxPerMatch, cfg.fillToTotal - realCount);
    if (slotsToFill <= 0) {
      console.log(`[MatchRoom] createBots: slotsToFill=${slotsToFill}, no bots`);
      return;
    }

    const rng = () => Math.random();
    const tierWeights = TIER_CONFIG.paid.weights;
    const weightEntries = Object.entries(tierWeights).filter(([, w]) => (w ?? 0) > 0) as [BombType, number][];
    const totalWeight = weightEntries.reduce((s, [, w]) => s + w, 0);

    const rollBomb = (): BombType => {
      let roll = rng() * totalWeight;
      for (const [type, w] of weightEntries) {
        roll -= w;
        if (roll <= 0) return type;
      }
      return weightEntries[weightEntries.length - 1][0];
    };

    for (let i = 0; i < slotsToFill; i++) {
      const botId = `bot_${i}`;
      const bot = new BotPlayer(botId);
      this.bots.push(bot);

      // Generate a random tint (same vivid-pastel palette as shop)
      const hue = rng() * 360;
      const sat = 0.55 + rng() * 0.3;
      const light = 0.62 + rng() * 0.18;
      const c = (1 - Math.abs(2 * light - 1)) * sat;
      const hp = hue / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let r = 0, g = 0, bl = 0;
      if (hp < 1) { r = c; g = x; }
      else if (hp < 2) { r = x; g = c; }
      else if (hp < 3) { g = c; bl = x; }
      else if (hp < 4) { g = x; bl = c; }
      else if (hp < 5) { r = x; bl = c; }
      else { r = c; bl = x; }
      const m = light - c / 2;
      const tint = (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((bl + m) * 255);

      // Generate random inventory (10 bombs from paid tier weights)
      const counts: Partial<Record<BombType, number>> = {};
      // Always include at least 2 flares
      counts['flare'] = 2;
      for (let b = 0; b < 8; b++) {
        const type = rollBomb();
        counts[type] = (counts[type] ?? 0) + 1;
      }
      // Pack into 4 slots
      const sorted = Object.entries(counts)
        .filter(([, c]) => (c ?? 0) > 0)
        .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0)) as [BombType, number][];
      const slots: (null | { type: BombType; count: number })[] = [null, null, null, null];
      for (let si = 0; si < Math.min(4, sorted.length); si++) {
        slots[si] = { type: sorted[si][0], count: Math.min(sorted[si][1], BALANCE.match.bombSlotStackLimit) };
      }

      const tiers = ['free', 'paid', 'paid_expensive'] as const;
      const tier = tiers[Math.floor(rng() * tiers.length)];
      const name = rollBombermanName(tier, rng);

      // Create a dummy profile and participant
      this.participants.push({
        playerId: botId,
        socketId: null,
        profile: {
          id: botId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          coins: 0,
          ownedBombermen: [{
            id: `bot_bm_${i}`,
            name,
            tier,
            colors: { shirt: tint, pants: tint, hair: tint },
            tint,
            character: CHARACTER_VARIANTS[Math.floor(rng() * CHARACTER_VARIANTS.length)],
            inventory: { slots },
            purchasedAt: Date.now(),
            sourceTemplateId: 'bot',
          }],
          equippedBombermanId: `bot_bm_${i}`,
          bombStockpile: {},
        },
      });
    }
    console.log(`[MatchRoom] Created ${slotsToFill} bots for match ${this.config.id}`);
  }


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
        tint: equipped?.tint ?? 0xffffff,
        character: equipped?.character ?? 'char1',
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
        rushCooldown: 0,
        rushActive: false,
        teleportedThisTurn: false,
        onHatchIdleTurns: 0,
        statusEffects: [],
        meleeTrapMode: false,
      };
    });

    // Seeded chests: 1 per zone, tier matches the zone type
    const chests: Chest[] = [];
    const pickWalkable = (zone: { x: number; y: number; w: number; h: number }): { x: number; y: number } | null => {
      const candidates: { x: number; y: number }[] = [];
      for (let dy = 0; dy < zone.h; dy++) {
        for (let dx = 0; dx < zone.w; dx++) {
          const x = zone.x + dx;
          const y = zone.y + dy;
          if (this.map.grid[y]?.[x] === 0) candidates.push({ x, y });
        }
      }
      return candidates.length > 0 ? candidates[seededRandInt(rng, 0, candidates.length)] : null;
    };

    const rollBomb = (tier: 1 | 2): BombType => {
      const cfg = CHEST_CONFIG[tier];
      const entries = Object.entries(cfg.weights).filter(([, w]) => (w ?? 0) > 0) as [BombType, number][];
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let roll = rng() * total;
      for (const [type, w] of entries) {
        roll -= w;
        if (roll <= 0) return type;
      }
      return entries[entries.length - 1][0];
    };

    const spawnChest = (zone: { x: number; y: number; w: number; h: number }, tier: 1 | 2): void => {
      const pick = pickWalkable(zone);
      if (!pick) return;
      const cfg = CHEST_CONFIG[tier];
      const coins = seededRandInt(rng, cfg.coinRange[0], cfg.coinRange[1] + 1);
      const bombs: Array<{ type: BombType; count: number }> = [];
      for (let i = 0; i < cfg.bombCount; i++) {
        bombs.push({ type: rollBomb(tier), count: cfg.bombStackSize });
      }
      chests.push({ id: `chest_${chests.length}`, tier, x: pick.x, y: pick.y, coins, bombs, opened: false });
    };

    for (const zone of this.map.chest1Zones) spawnChest(zone, 1);
    for (const zone of this.map.chest2Zones) spawnChest(zone, 2);

    return {
      matchId: this.config.id,
      mapId: this.config.mapId,
      phase: 'input',
      turnNumber: 1,
      phaseEndsAt: Date.now() + BALANCE.match.inputPhaseSeconds * 1000,
      bombermen,
      chests,
      doors: (this.map.doors ?? []).map(d => ({
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
      escapeTiles: this.map.escapeTiles.map(t => ({ x: t.x, y: t.y })),
      smokeClouds: [],
      mines: [],
      phosphorusPending: [],
    };
  }

  start(): void {
    // Broadcast initial state
    this.broadcastState();
    this.tickBots();
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

    if (msg.sourceKind === 'chest') {
      const chest = this.state.chests.find(
        c => c.id === msg.sourceId && c.x === me.x && c.y === me.y,
      );
      if (!chest) return;
      const bombEntry = chest.bombs.find(b => b.type === msg.bombType);
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
        // Swap: old bombs go back into the chest
        const oldType = slot.type;
        const oldCount = slot.count;
        const take = Math.min(bombEntry.count, stackLimit);
        me.inventory.slots[invIdx] = { type: bombEntry.type, count: take };
        bombEntry.count -= take;
        const existing = chest.bombs.find(b => b.type === oldType);
        if (existing) {
          existing.count += oldCount;
        } else {
          chest.bombs.push({ type: oldType, count: oldCount });
        }
      }

      chest.bombs = chest.bombs.filter(b => b.count > 0);

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

    // Immediately strip dead Bombermen from player profiles so a page
    // refresh doesn't let them re-use a dead Bomberman.
    for (const ev of events) {
      if ((ev as { kind: string }).kind !== 'died') continue;
      const diedPlayerId = (ev as { playerId: string }).playerId;
      const participant = this.participants.find(p => p.playerId === diedPlayerId);
      if (!participant || !participant.socketId) continue; // skip bots
      const profile = participant.profile;
      const bm = this.state.bombermen.find(b => b.playerId === diedPlayerId);
      if (!bm) continue;
      const idx = profile.ownedBombermen.findIndex(ob => ob.id === bm.bombermanId);
      if (idx >= 0) profile.ownedBombermen.splice(idx, 1);
      if (profile.equippedBombermanId === bm.bombermanId) {
        profile.equippedBombermanId = profile.ownedBombermen.length > 0 ? profile.ownedBombermen[0].id : null;
      }
      this.playerStore.save(profile).catch(() => {});
      // Push updated profile to the client so ProfileStore reflects the death
      if (participant.socketId) {
        const sock = this.io.sockets.sockets.get(participant.socketId);
        if (sock) sock.emit('profile', { profile });
      }
    }

    // Immediately persist escaped players' match-end state to their profile.
    // Without this, a player who escapes mid-match (while bots/others still
    // alive) keeps their pre-match inventory + coins until finalize runs —
    // which only happens when the WHOLE match ends. If finalize never runs
    // (player quits, bots keep playing), the match-end changes were lost.
    for (const ev of events) {
      if ((ev as { kind: string }).kind !== 'escaped') continue;
      const escapedPlayerId = (ev as { playerId: string }).playerId;
      const participant = this.participants.find(p => p.playerId === escapedPlayerId);
      if (!participant || !participant.socketId) continue; // skip bots
      const profile = participant.profile;
      const bm = this.state.bombermen.find(b => b.playerId === escapedPlayerId);
      if (!bm) continue;
      const ownedBomberman = profile.ownedBombermen.find(ob => ob.id === bm.bombermanId);
      profile.coins += bm.coins;
      // Drain so finalize() doesn't double-count if the match ends this turn.
      bm.coins = 0;
      if (ownedBomberman) {
        ownedBomberman.inventory = {
          slots: bm.inventory.slots.map(s => (s ? { ...s } : null)),
        };
      }
      this.playerStore.save(profile).catch(() => {});
      if (participant.socketId) {
        const sock = this.io.sockets.sockets.get(participant.socketId);
        if (sock) sock.emit('profile', { profile });
      }
    }

    // Order matters: clients scan `turn_result` events (e.g. to mark bombs
    // that are being thrown) before consuming the new `match_state` snapshot,
    // so deferred visuals like the "landed" bomb sprite can wait for their
    // throw arc to finish. Keep this order aligned with TutorialMatchBackend.
    this.io.to(this.id).emit('turn_result', { events });
    this.io.to(this.id).emit('match_state', { state: this.state });

    // Per-owner notification when one of their mines trips. Only sent to the
    // mine's owner (private ping); the public turn_result still carries the
    // broadcast mine_triggered event for all clients to render the explosion.
    for (const ev of events) {
      const e = ev as { kind: string; mineId?: string; x?: number; y?: number; ownerId?: string };
      if (e.kind !== 'mine_triggered') continue;
      const ownerId = e.ownerId;
      if (!ownerId) continue;
      const participant = this.participants.find(p => p.playerId === ownerId);
      if (!participant || !participant.socketId) continue;
      const sock = this.io.sockets.sockets.get(participant.socketId);
      if (!sock) continue;
      sock.emit('mine_triggered', {
        mineId: e.mineId ?? '',
        x: e.x ?? 0,
        y: e.y ?? 0,
      });
    }

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
    this.tickBots();
    this.scheduleInputPhaseEnd();
  }

  /** Have each bot compute and submit its action for this input phase. */
  private tickBots(): void {
    for (const bot of this.bots) {
      const action = bot.tick(
        this.state,
        this.map,
        (msg) => this.handleLoot(bot.playerId, msg),
      );
      this.submitAction(bot.playerId, action);
    }
  }

  private broadcastState(): void {
    this.io.to(this.id).emit('match_state', { state: this.state });
  }

  private async finalize(): Promise<void> {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);

    for (const participant of this.participants) {
      if (!participant.socketId) continue; // skip bots — no profile to save
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
      if (participant.socketId) {
        const sock = this.io.sockets.sockets.get(participant.socketId);
        if (sock) sock.emit('profile', { profile });
      }
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
