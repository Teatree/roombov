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
import { CHEST_CONFIG, CHEST_SPAWN_TABLE } from '../shared/config/chests.ts';
import type { BombType } from '../shared/types/bombs.ts';
import { BotPlayer } from './BotPlayer.ts';
import { ScavPlayer } from './ScavPlayer.ts';
import { rollBombermanName } from '../shared/config/bomberman-names.ts';
import { TIER_CONFIG, defaultStatsForTier } from '../shared/config/bomberman-tiers.ts';
import { effectiveMaxCustomSlots, effectiveMaxHp, effectiveStackSize } from '../shared/utils/bomberman-stats.ts';
import { resolveTurn } from '../shared/systems/TurnResolver.ts';
import { createSeededRandom, seededRandInt, seededShuffle } from '../shared/utils/seeded-random.ts';
import { rollBombLoot, rollTreasureLoot } from '../shared/utils/loot-roll.ts';
import { mergeTreasures, type TreasureBundle } from '../shared/config/treasures.ts';
import { createEmptyGamblerStreet } from '../shared/types/gambler-street.ts';
import { createEmptyFactories } from '../shared/types/factory.ts';
import { GAMBLER_STREET_GLOBAL } from '../shared/config/gambler-street.ts';
import { loadMapById } from '../shared/maps/map-loader.ts';
import type { PlayerStore } from './PlayerStore.ts';
import { logMatchResult, logProfileSnapshot, type MatchOutcome } from './Analytics.ts';

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
  /** AI controllers for Scavenger NPCs. Populated lazily after each turn
   *  resolution — TurnResolver step 5d adds `isScav` bombermen to state and
   *  we reconcile a ScavPlayer for each in `endInputPhase`. */
  private scavs: ScavPlayer[] = [];
  /** Snapshot of each escaped Bomberman's treasures, captured **before** the
   *  drain in the escape handler. Used by `match_end` to ship the haul to
   *  every client (the live `b.treasures` is empty by then). */
  private escapedTreasureSnapshots = new Map<string, TreasureBundle>();
  /** Per-player SP earned this match. Captured at escape time so the
   *  `match_end` payload can report it after `bm.sp` has been drained. */
  private spEarnedSnapshots = new Map<string, number>();
  /** Per-player snapshot of the equipped Bomberman's `lifetimeSp` AFTER this
   *  match's SP has been banked. Captured at escape time alongside the
   *  earned-this-match snapshot. For dead players we record the pre-death
   *  value (no banking happened) — see the `died` handler below. */
  private lifetimeSpSnapshots = new Map<string, number>();
  /** Per-real-player analytics counters, accumulated across every turn.
   *  `bombsUsed` is a sparse `{ [bombType]: count }` reflecting bombs PLACED
   *  (throw or contact-detonate from the resolver's `throw` event), not bombs
   *  bought or held in inventory. `turnsAlive` snapshots `state.turnNumber`
   *  on death; for survivors it advances each turn so escape/timeout reads
   *  the final value. */
  private analyticsCounters = new Map<string, {
    chestsOpened: number;
    kills: number;
    bombsUsed: Partial<Record<BombType, number>>;
    turnsAlive: number;
  }>();
  private onEnd: () => void;
  /** GameServer-provided lookup for per-socket IP + sessionId, used at
   *  settlement time. Null for bots or disconnected players. */
  private lookupAnalyticsContext: (playerId: string) => { sessionId: string; ip: string } | null;

  constructor(
    config: MatchConfig,
    map: MapData,
    participants: MatchRoomParticipant[],
    io: TypedServer,
    playerStore: PlayerStore,
    onEnd: () => void,
    lookupAnalyticsContext: (playerId: string) => { sessionId: string; ip: string } | null = () => null,
  ) {
    this.config = config;
    this.map = map;
    this.participants = participants;
    this.io = io;
    this.playerStore = playerStore;
    this.onEnd = onEnd;
    this.lookupAnalyticsContext = lookupAnalyticsContext;

    // Seed analytics counters for real players. Bots and Scavs are tracked
    // implicitly (we just never call log* for them) but seeding the map keeps
    // the per-turn increment paths branchless.
    for (const p of participants) {
      if (!p.socketId) continue;
      this.analyticsCounters.set(p.playerId, {
        chestsOpened: 0,
        kills: 0,
        bombsUsed: {},
        turnsAlive: 0,
      });
    }

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

      // Pick a tier first — drives slot count, stack size, and inventory shape.
      const tiers = ['free', 'paid', 'paid_expensive'] as const;
      const tier = tiers[Math.floor(rng() * tiers.length)];
      const tierStats = defaultStatsForTier(tier);
      const maxCustomSlots = tierStats.maxCustomSlots;
      const stackSize = tierStats.stackSize;

      // Generate random inventory (10 bombs from paid tier weights)
      const counts: Partial<Record<BombType, number>> = {};
      counts['flare'] = 2;
      for (let b = 0; b < 8; b++) {
        const type = rollBomb();
        counts[type] = (counts[type] ?? 0) + 1;
      }
      // Pack into the bot's slot count, capped by its stack size.
      const sorted = Object.entries(counts)
        .filter(([, c]) => (c ?? 0) > 0)
        .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0)) as [BombType, number][];
      const slots: (null | { type: BombType; count: number })[] = new Array(maxCustomSlots).fill(null);
      for (let si = 0; si < Math.min(maxCustomSlots, sorted.length); si++) {
        slots[si] = { type: sorted[si][0], count: Math.min(sorted[si][1], stackSize) };
      }

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
          treasures: {},
          ownedBombermen: [{
            id: `bot_bm_${i}`,
            name,
            tier,
            colors: { shirt: tint, pants: tint, hair: tint },
            tint,
            character: CHARACTER_VARIANTS[Math.floor(rng() * CHARACTER_VARIANTS.length)],
            maxCustomSlots,
            stackSize,
            inventory: { slots },
            purchasedAt: Date.now(),
            sourceTemplateId: 'bot',
            sp: 0,
            lifetimeSp: 0,
            upgrades: { cap: 0, stack: 0, hp: 0 },
          }],
          equippedBombermanId: `bot_bm_${i}`,
          bombStockpile: {},
          gamblerStreet: createEmptyGamblerStreet(Date.now(), GAMBLER_STREET_GLOBAL.slotCount),
          bombermanShop: null,
          factories: createEmptyFactories(),
          totalMatchesPlayed: 0,
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
      // Fallback stats if equipped is somehow missing (shouldn't happen):
      // give the participant a free-tier shape so the match doesn't crash.
      const fallback = defaultStatsForTier('free');
      // Effective stats fold in any persistent upgrades the player has
      // bought for this Bomberman. Untouched if no upgrades applied.
      const maxCustomSlots = equipped
        ? effectiveMaxCustomSlots(equipped)
        : fallback.maxCustomSlots;
      const stackSize = equipped
        ? effectiveStackSize(equipped)
        : fallback.stackSize;
      const maxHp = equipped
        ? effectiveMaxHp(equipped)
        : BALANCE.match.bombermanMaxHp;
      return {
        playerId: p.playerId,
        isBot: p.socketId === null,
        bombermanId: equipped?.id ?? 'none',
        name: equipped?.name ?? '???',
        colors: equipped?.colors ?? { shirt: 0x888888, pants: 0x444444, hair: 0x222222 },
        tint: equipped?.tint ?? 0xffffff,
        character: equipped?.character ?? 'char1',
        x: spawn.x,
        y: spawn.y,
        hp: maxHp,
        alive: true,
        treasures: {},
        coins: 0,
        keys: 0,
        maxCustomSlots,
        stackSize,
        inventory: equipped
          ? {
              // Pad with nulls if CAP upgrades have widened the effective slot
              // count past the persisted (base-length) inventory array.
              slots: (() => {
                const cloned = equipped.inventory.slots.map(s => (s ? { ...s } : null));
                while (cloned.length < maxCustomSlots) cloned.push(null);
                return cloned.slice(0, maxCustomSlots);
              })(),
            }
          : { slots: new Array(maxCustomSlots).fill(null) },
        bleedingTurns: 0,
        escaped: false,
        rushCooldown: 0,
        rushActive: false,
        teleportedThisTurn: false,
        onHatchIdleTurns: 0,
        statusEffects: [],
        meleeTrapMode: false,
        sp: 0,
      };
    });

    // Seeded chests: zones are type-agnostic. Expand CHEST_SPAWN_TABLE into
    // a flat tier pool (e.g. [1,1,1,1,1,1,1, 2,2,2, 3]), shuffle both the
    // pool and the zone list, then pair them. Excess zones stay empty.
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

    const tierPool: (1 | 2 | 3)[] = [];
    for (const entry of CHEST_SPAWN_TABLE) {
      for (let i = 0; i < entry.count; i++) tierPool.push(entry.tier);
    }
    const shuffledZones = seededShuffle(rng, this.map.chestZones);
    const shuffledTiers = seededShuffle(rng, tierPool);
    const pairCount = Math.min(shuffledZones.length, shuffledTiers.length);

    for (let i = 0; i < pairCount; i++) {
      const zone = shuffledZones[i];
      const tier = shuffledTiers[i];
      const pick = pickWalkable(zone);
      if (!pick) continue;
      const cfg = CHEST_CONFIG[tier];
      const slots = seededRandInt(rng, cfg.slotCount[0], cfg.slotCount[1] + 1);
      const bombs = rollBombLoot(cfg.weights, cfg.totalBombs, slots, rng);
      const treasureSlots = seededRandInt(rng, cfg.treasureSlotCount[0], cfg.treasureSlotCount[1] + 1);
      const treasures = rollTreasureLoot(cfg.treasureWeights, cfg.totalTreasures, treasureSlots, rng);
      const coins = seededRandInt(rng, cfg.coinRange[0], cfg.coinRange[1] + 1);
      chests.push({ id: `chest_${chests.length}`, tier, x: pick.x, y: pick.y, treasures, coins, keys: 0, bombs, opened: false });
    }

    // Keys-in-chests distribution (NEW_META §4): allocate BALANCE.keys.totalOnMap
    // keys across spawned chests by weighted random pick over CHEST_CONFIG[tier].keyWeight.
    // Multiple keys on the same chest accumulate. No per-chest cap.
    if (chests.length > 0) {
      const chestWeights = chests.map(c => CHEST_CONFIG[c.tier].keyWeight);
      const totalWeight = chestWeights.reduce((a, b) => a + b, 0);
      if (totalWeight > 0) {
        for (let k = 0; k < BALANCE.keys.totalOnMap; k++) {
          let roll = rng() * totalWeight;
          for (let j = 0; j < chests.length; j++) {
            roll -= chestWeights[j];
            if (roll <= 0) { chests[j].keys += 1; break; }
          }
        }
      }
    }

    // DISABLED (NEW_META §4): floor-key spawning. Keys now come from chests.
    // Code preserved for re-enabling — see docs/NEW_META.md §4.
    // const keySpawnPool = (this.map.keySpawns ?? []).map(k => ({ x: k.x, y: k.y }));
    // const shuffledKeys = seededShuffle(rng, keySpawnPool);
    // const pickedKeys = shuffledKeys.slice(0, BALANCE.keys.totalOnMap);
    const pickedKeys: { x: number; y: number }[] = [];

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
      shieldWalls: [],
      shieldShards: [],
      flares: [],
      bloodTiles: [],
      // Randomly select a fixed-size subset of the map's authored escape-tile
      // pool — same pattern as chest zone selection. If the map declares
      // fewer hatches than the configured count, all candidates are used.
      escapeTiles: seededShuffle(rng, this.map.escapeTiles)
        .slice(0, BALANCE.escapeHatches.count)
        .map(t => ({ x: t.x, y: t.y })),
      brokenHatches: [],
      keys: pickedKeys,
      smokeClouds: [],
      mines: [],
      phosphorusPending: [],
      isTutorial: false,
      uavNextFireTurn: 60 + Math.floor(Math.random() * 31), // first UAV in turns 60-90
      scavNextSpawnTurn: 20 + Math.floor(Math.random() * 11), // first scav wave in turns 20-30
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

    // Target slot must be 1..maxCustomSlots (slot 0 is Rock, never writable)
    if (msg.targetSlotIndex < 1 || msg.targetSlotIndex > me.maxCustomSlots) return;
    const invIdx = msg.targetSlotIndex - 1;

    const stackLimit = me.stackSize;

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

    // Per-match analytics counter updates from this turn's events. We derive
    // chestsOpened, kills, and bombsUsed from events emitted by TurnResolver
    // so the resolver itself (and BombermanState) stays untouched.
    for (const ev of events) {
      const e = ev as { kind: string; playerId?: string; killerId?: string | null; source?: string; type?: BombType };
      switch (e.kind) {
        case 'coins_picked_up': {
          // Every chest has coinRange > 0 in every tier (CHEST_CONFIG),
          // so a chest-sourced coin pickup is a 1:1 proxy for "chest opened".
          if (e.source !== 'chest' || !e.playerId) break;
          const c = this.analyticsCounters.get(e.playerId);
          if (c) c.chestsOpened += 1;
          break;
        }
        case 'throw': {
          if (!e.playerId || !e.type) break;
          const c = this.analyticsCounters.get(e.playerId);
          if (!c) break;
          c.bombsUsed[e.type] = (c.bombsUsed[e.type] ?? 0) + 1;
          break;
        }
        case 'died': {
          // Credit the killer (last hitter). `killerId` can be null for
          // suicide / no-attributable-source deaths — those don't credit
          // anyone.
          if (e.killerId) {
            const c = this.analyticsCounters.get(e.killerId);
            if (c) c.kills += 1;
          }
          // Snapshot turnsAlive for the victim — they won't be ticked again.
          if (e.playerId) {
            const c = this.analyticsCounters.get(e.playerId);
            if (c) c.turnsAlive = this.state.turnNumber;
          }
          break;
        }
      }
    }
    // Tick turnsAlive forward for everyone still alive (and not escaped).
    // Survivors read the final value at settlement; escapees see this turn
    // number on the escape event row.
    for (const bm of this.state.bombermen) {
      const c = this.analyticsCounters.get(bm.playerId);
      if (!c) continue;
      if (bm.alive && !bm.escaped) c.turnsAlive = this.state.turnNumber;
    }

    // Reconcile Scavenger controllers. TurnResolver step 5d pushed new
    // `isScav: true` bombermen into state this turn; create a `ScavPlayer`
    // AI for each one we haven't seen yet so the next input phase ticks
    // them. Stub participant entry too — gives missing-action defaults a
    // playerId to anchor to and mirrors how bots are wired (socketId: null).
    for (const bm of this.state.bombermen) {
      if (!bm.isScav) continue;
      if (this.scavs.some(s => s.playerId === bm.playerId)) continue;
      this.scavs.push(new ScavPlayer(bm.playerId));
      this.participants.push({
        playerId: bm.playerId,
        socketId: null,
        profile: {
          id: bm.playerId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          coins: 0,
          treasures: {},
          ownedBombermen: [],
          equippedBombermanId: null,
          bombStockpile: {},
          gamblerStreet: createEmptyGamblerStreet(Date.now(), GAMBLER_STREET_GLOBAL.slotCount),
          bombermanShop: null,
          factories: createEmptyFactories(),
          totalMatchesPlayed: 0,
        },
      });
    }

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
      // Snapshot lifetime SP BEFORE removing the OwnedBomberman so the
      // Results screen can show what this Bomberman accumulated across its
      // life. On death no banking happened, so we just record the current
      // lifetime value.
      if (idx >= 0) {
        // Lifetime SP is a pure history counter — even SP earned on a doomed
        // run counts toward "all SP this Bomberman was ever able to gather".
        // Bank the in-match accumulator into lifetimeSp BEFORE we strip the
        // Bomberman so the Results screen can still report it.
        const owned = profile.ownedBombermen[idx];
        const dyingLifetime = (owned.lifetimeSp ?? 0) + (bm.sp ?? 0);
        this.lifetimeSpSnapshots.set(diedPlayerId, dyingLifetime);
        profile.ownedBombermen.splice(idx, 1);
      }
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
    // alive) keeps their pre-match inventory + treasures until finalize runs —
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
      // Snapshot treasures BEFORE the drain so `match_end` can still report the
      // haul to clients (`b.treasures` is empty after this point).
      this.escapedTreasureSnapshots.set(escapedPlayerId, { ...bm.treasures });
      mergeTreasures(profile.treasures, bm.treasures);
      // Bank coins picked up during the match (NEW_META §2).
      profile.coins += bm.coins;
      bm.coins = 0;
      // Drain so finalize() doesn't double-count if the match ends this turn.
      bm.treasures = {};
      if (ownedBomberman) {
        ownedBomberman.inventory = {
          slots: bm.inventory.slots.map(s => (s ? { ...s } : null)),
        };
        // Bank Skill Points earned this match. Dropped on death (handled
        // by simply NOT crediting in the death branch above).
        const earned = bm.sp;
        const before = ownedBomberman.sp ?? 0;
        ownedBomberman.sp = before + earned;
        ownedBomberman.lifetimeSp = (ownedBomberman.lifetimeSp ?? before) + earned;
        this.spEarnedSnapshots.set(escapedPlayerId, earned);
        this.lifetimeSpSnapshots.set(escapedPlayerId, ownedBomberman.lifetimeSp);
        bm.sp = 0;
        console.log(`[SP-BANK] player=${escapedPlayerId} bm=${ownedBomberman.id} earned=${earned} before=${before} after=${ownedBomberman.sp}`);
      } else {
        // If we hit this, escape SP for this player is lost — match_end
        // shows nothing AND nothing banks. Common cause: bm.bombermanId
        // doesn't match any owned bomberman (e.g. legacy 'none' fallback).
        console.warn(`[SP-BANK] no ownedBomberman for player=${escapedPlayerId} (bm.bombermanId=${bm.bombermanId}); SP earned=${bm.sp} is lost`);
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

  /** Have each bot (and each Scavenger NPC) compute and submit its action
   *  for this input phase. Scavs use the same loot callback as bots, but
   *  ScavPlayer gates loot to "all custom slots empty" so the callback is
   *  rarely fired. */
  private tickBots(): void {
    for (const bot of this.bots) {
      const action = bot.tick(
        this.state,
        this.map,
        (msg) => this.handleLoot(bot.playerId, msg),
      );
      this.submitAction(bot.playerId, action);
    }
    for (const scav of this.scavs) {
      const bm = this.state.bombermen.find(b => b.playerId === scav.playerId);
      if (!bm || !bm.alive || bm.escaped) continue;
      const action = scav.tick(
        this.state,
        this.map,
        (msg) => this.handleLoot(scav.playerId, msg),
      );
      this.submitAction(scav.playerId, action);
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

      // Capture name+tier BEFORE the dead branch strips the OwnedBomberman.
      // BombermanState carries `name` already (copied at match start) but
      // tier only lives on the OwnedBomberman; fall back if it's gone.
      const bombermanName = b.name ?? ownedBomberman?.name ?? '';
      const bombermanTier = ownedBomberman?.tier ?? 'free';
      const outcome: MatchOutcome = b.escaped
        ? 'escaped'
        : (this.state.endReason === 'turn_limit' ? 'timeout' : 'killed');

      if (b.escaped) {
        // Escaped: keep treasures earned during the match
        mergeTreasures(profile.treasures, b.treasures);

        // Sync the match-end inventory back to the profile.
        // Spent bombs are gone, looted bombs are added.
        if (ownedBomberman) {
          ownedBomberman.inventory = {
            slots: b.inventory.slots.map(s => (s ? { ...s } : null)),
          };
        }
      } else {
        // Dead: lose the Bomberman entirely — strip from the profile roster.
        // Treasures on the Bomberman were already dropped as a body in-match.
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

      // Bump lifetime match count — any outcome counts. Drives the
      // `totalMatchesPlayed` column on ProfileSnapshots.
      profile.totalMatchesPlayed = (profile.totalMatchesPlayed ?? 0) + 1;

      await this.playerStore.save(profile);
      if (participant.socketId) {
        const sock = this.io.sockets.sockets.get(participant.socketId);
        if (sock) sock.emit('profile', { profile });
      }

      // Emit analytics rows for this player — one MatchResults followed by
      // one ProfileSnapshot. Reads the POST-settlement profile so coin /
      // treasure / stockpile / match-count snapshots are the final values.
      this.emitMatchAnalytics(participant, b, outcome, bombermanName, bombermanTier);
    }

    // Per-player treasures: prefer the pre-drain snapshot for escapees (live
    // `b.treasures` is wiped at escape time); fall back to current state for
    // anyone who didn't escape (dead/turn-limit).
    this.io.to(this.id).emit('match_end', {
      endReason: this.state.endReason ?? 'all_dead',
      escapedPlayerIds: this.state.escapedPlayerIds ?? [],
      treasuresEarned: Object.fromEntries(
        this.state.bombermen.map(b => [
          b.playerId,
          { ...(this.escapedTreasureSnapshots.get(b.playerId) ?? b.treasures) },
        ]),
      ),
      // SP only banks on escape; for dead players we report 0 (SP discarded).
      spEarned: Object.fromEntries(
        this.state.bombermen.map(b => [
          b.playerId,
          this.spEarnedSnapshots.get(b.playerId) ?? 0,
        ]),
      ),
      // Lifetime SP (cumulative across all matches incl. spent SP). Captured
      // at escape banking time and at the moment of death so this still
      // works when the OwnedBomberman has been removed from the profile.
      lifetimeSp: Object.fromEntries(
        this.state.bombermen.map(b => [
          b.playerId,
          this.lifetimeSpSnapshots.get(b.playerId) ?? 0,
        ]),
      ),
    });

    this.onEnd();
  }


  /** Fire-and-forget — one analytics row pair (MatchResults + ProfileSnapshot)
   *  per real player at match-end settlement. The PlayerStore snapshot read
   *  here reflects post-banking state (coins / treasures / stockpile /
   *  totalMatchesPlayed already mutated). */
  private emitMatchAnalytics(
    participant: MatchRoomParticipant,
    _b: BombermanState,
    outcome: MatchOutcome,
    bombermanName: string,
    bombermanTier: string,
  ): void {
    // Disconnected real players still get a row — we just lose their IP and
    // sessionId. Bots have already been filtered out (socketId === null) by
    // the surrounding loop.
    const ctx = this.lookupAnalyticsContext(participant.playerId)
      ?? { ip: '', sessionId: '' };
    const counters = this.analyticsCounters.get(participant.playerId) ?? {
      chestsOpened: 0, kills: 0, bombsUsed: {}, turnsAlive: 0,
    };
    const profile = participant.profile;
    // Treasures earned this match: snapshot is only populated on escape.
    // Death and timeout both drop the carry, so report empty {}.
    const treasuresGained = outcome === 'escaped'
      ? (this.escapedTreasureSnapshots.get(participant.playerId) ?? {})
      : {};
    const stashTotal = Object.values(profile.treasures).reduce<number>((s, v) => s + (v ?? 0), 0);
    const bombStockpileTotal = Object.values(profile.bombStockpile ?? {})
      .reduce<number>((s, v) => s + (v ?? 0), 0);

    logMatchResult({
      ip: ctx.ip,
      sessionId: ctx.sessionId,
      matchId: this.config.id,
      profileId: participant.playerId,
      profileName: profile.name ?? '',
      bombermanName,
      bombermanTier,
      outcome,
      turnsAlive: counters.turnsAlive,
      kills: counters.kills,
      chestsOpened: counters.chestsOpened,
      spEarned: this.spEarnedSnapshots.get(participant.playerId) ?? 0,
      treasuresGainedJson: JSON.stringify(treasuresGained),
      bombsUsedJson: JSON.stringify(counters.bombsUsed),
      coinsAfter: profile.coins,
      stashTotalAfter: stashTotal,
    });
    logProfileSnapshot({
      ip: ctx.ip,
      sessionId: ctx.sessionId,
      profileId: participant.playerId,
      coins: profile.coins,
      treasuresJson: JSON.stringify(profile.treasures),
      bombStockpileTotal,
      ownedBombermenCount: profile.ownedBombermen.length,
      totalMatchesPlayed: profile.totalMatchesPlayed ?? 0,
    });
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
