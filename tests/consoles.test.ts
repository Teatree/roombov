import { describe, expect, it } from 'vitest';
import { resolveTurn, type TurnEvent } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';
import { BALANCE } from '../src/shared/config/balance.ts';

// These tests exercise the Console system (TurnResolver step 9.45 + the
// escape gate in step 9.5). They assume HIDDEN_FEATURES.keys === true — the
// Console system replaces the Keys escape requirement while that flag is on.

/** Open floor map with a solid 2×2 console footprint at (5,5) and a second
 *  at (8,8), plus a hatch at (1,1). */
function consoleMap(size = 12): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  // Console footprints are solid, matching authored maps.
  for (const box of [{ x: 5, y: 5 }, { x: 8, y: 8 }]) {
    grid[box.y][box.x] = TileType.WALL;
    grid[box.y][box.x + 1] = TileType.WALL;
    grid[box.y + 1][box.x] = TileType.WALL;
    grid[box.y + 1][box.x + 1] = TileType.WALL;
  }
  return {
    id: 'test_consoles', name: 'test consoles', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [{ id: 0, x: 1, y: 1 }], chestZones: [], keySpawns: [],
    consoleSpots: [
      { x: 5, y: 5, w: 2, h: 2 },
      { x: 8, y: 8, w: 2, h: 2 },
    ],
  } as unknown as MapData;
}

function makeBomberman(
  playerId: string, x: number, y: number,
  opts: {
    assignedConsoles?: number[]; consolesUsed?: number[];
    idleAction?: 'attack' | 'heal' | 'disguise'; hp?: number; maxHp?: number;
  } = {},
): BombermanState {
  return {
    playerId,
    x, y,
    hp: opts.hp ?? 2,
    maxHp: opts.maxHp ?? 2,
    alive: true,
    escaped: false,
    facing: 'south',
    idleAction: opts.idleAction ?? 'heal',
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0,
    rushActive: false,
    statusEffects: [],
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    meleeTrapMode: false,
    idleStillTurns: 0,
    treasures: {},
    keys: 0,
    assignedConsoles: opts.assignedConsoles ?? [0, 1],
    consolesUsed: opts.consolesUsed ?? [],
    consoleIdleTurns: 0,
    consoleEngagedId: null,
  } as unknown as BombermanState;
}

function makeState(opts: {
  bombermen: BombermanState[];
  fireTiles?: { x: number; y: number; turnsRemaining: number }[];
  escapeTiles?: { x: number; y: number }[];
  /** Defaults past the activation delay so tests exercise live consoles;
   *  the delay-specific tests below override it. */
  turnNumber?: number;
}): MatchState {
  return {
    matchId: 'm-consoles',
    mapId: 'test_consoles',
    phase: 'input',
    turnNumber: opts.turnNumber ?? BALANCE.consoles.activationDelayTurns + 1,
    phaseEndsAt: 0,
    bombermen: opts.bombermen,
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: opts.fireTiles ?? [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles: opts.escapeTiles ?? [{ x: 1, y: 1 }],
    brokenHatches: [],
    keys: [],
  } as unknown as MatchState;
}

function idle(ids: string[]): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  for (const id of ids) m.set(id, { kind: 'idle' });
  return m;
}

function move(playerId: string, x: number, y: number): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  m.set(playerId, { kind: 'move', x, y });
  return m;
}

/** Resolve `count` consecutive idle turns, accumulating events. */
function idleTurns(state: MatchState, map: MapData, ids: string[], count: number):
  { state: MatchState; events: TurnEvent[] } {
  let cur = state;
  const all: TurnEvent[] = [];
  for (let i = 0; i < count; i++) {
    const r = resolveTurn(cur, idle(ids), map);
    cur = r.state;
    all.push(...r.events);
  }
  return { state: cur, events: all };
}

describe('Console system', () => {
  it('test_consoles_threeIdleTurnsAdjacent_completesConsole', () => {
    // Arrange — bomberman beside console 0's footprint (Chebyshev 1).
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    const state = makeState({ bombermen: [bm] });

    // Act — exactly the required number of idle turns.
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — console 0 used, counter reset, event carries the countdown.
    expect(after.state.bombermen[0].consolesUsed).toEqual([0]);
    expect(after.state.bombermen[0].consoleIdleTurns).toBe(0);
    const used = after.events.filter(e => e.kind === 'console_used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ playerId: 'p1', consoleId: 0, x: 5, y: 5 });
  });

  it('test_consoles_twoIdleTurns_doesNotComplete', () => {
    // Arrange
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    const state = makeState({ bombermen: [bm] });

    // Act — one turn short of the requirement.
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns - 1);

    // Assert — progress accrued but no completion.
    expect(after.state.bombermen[0].consolesUsed).toEqual([]);
    expect(after.state.bombermen[0].consoleIdleTurns).toBe(BALANCE.consoles.interactIdleTurns - 1);
  });

  it('test_consoles_moveWithinRange_resetsProgress', () => {
    // Arrange — idle two turns, then shuffle one tile (still within range).
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    let state = makeState({ bombermen: [bm] });
    state = idleTurns(state, map, ['p1'], 2).state;
    expect(state.bombermen[0].consoleIdleTurns).toBe(2);

    // Act — move to (4,6), still Chebyshev 1 of the footprint.
    state = resolveTurn(state, move('p1', 4, 6), map).state;

    // Assert — counter restarted; two more idles still don't complete.
    expect(state.bombermen[0].consoleIdleTurns).toBe(0);
    const after = idleTurns(state, map, ['p1'], 2);
    expect(after.state.bombermen[0].consolesUsed).toEqual([]);
  });

  it('test_consoles_damageDuringChannel_resetsProgress', () => {
    // Arrange — idle two turns, then take fire damage on the third.
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5, { hp: 3, maxHp: 3, idleAction: 'attack' });
    let state = makeState({ bombermen: [bm] });
    state = idleTurns(state, map, ['p1'], 2).state;

    // Act — fire tile under the bomberman damages them this turn.
    state.fireTiles.push({ x: 4, y: 5, turnsRemaining: 1 } as MatchState['fireTiles'][number]);
    const { state: next } = resolveTurn(state, idle(['p1']), map);

    // Assert — the hit restarts the channel.
    expect(next.bombermen[0].hp).toBeLessThan(3);
    expect(next.bombermen[0].consoleIdleTurns).toBe(0);
    expect(next.bombermen[0].consolesUsed).toEqual([]);
  });

  it('test_consoles_escapeBlocked_untilTrioDone_thenAllowed', () => {
    // Arrange — on the hatch with 2 of 3 required consoles done.
    const map = consoleMap();
    const blocked = makeBomberman('p1', 1, 1, {
      assignedConsoles: [0, 1], consolesUsed: [0],
    });
    let state = makeState({ bombermen: [blocked] });

    // Act / Assert — requirement is min(3, assigned=2) = 2; only 1 done.
    state = idleTurns(state, map, ['p1'], BALANCE.escapeHatches.idleTurnsRequired).state;
    expect(state.bombermen[0].escaped).toBe(false);

    // Complete the trio → the same wait now escapes.
    state.bombermen[0].consolesUsed = [0, 1];
    const after = idleTurns(state, map, ['p1'], BALANCE.escapeHatches.idleTurnsRequired);
    expect(after.state.bombermen[0].escaped).toBe(true);
    expect(after.events.filter(e => e.kind === 'escaped')).toHaveLength(1);
  });

  it('test_consoles_mapWithoutConsoles_escapeFree', () => {
    // Arrange — no assigned consoles (e.g. tutorial map): requirement
    // derives to min(3, 0) = 0 and the hatch only needs the idle wait.
    const map = consoleMap();
    const bm = makeBomberman('p1', 1, 1, { assignedConsoles: [] });
    const state = makeState({ bombermen: [bm] });

    // Act
    const after = idleTurns(state, map, ['p1'], BALANCE.escapeHatches.idleTurnsRequired);

    // Assert
    expect(after.state.bombermen[0].escaped).toBe(true);
  });

  it('test_consoles_idleActionSuppressed_whileEngaged', () => {
    // Arrange — hurt Heal-class bomberman channeling a console: the console
    // hourglass owns the idle streak, so no heal fires during the channel.
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5, { idleAction: 'heal', hp: 1, maxHp: 2 });
    const state = makeState({ bombermen: [bm] });

    // Act — exactly the console channel length (>= healIdleTurns).
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — console done, but no heal happened and no heal progress.
    expect(after.state.bombermen[0].consolesUsed).toEqual([0]);
    expect(after.state.bombermen[0].hp).toBe(1);
    expect(after.events.filter(e => e.kind === 'heal_applied')).toHaveLength(0);
    expect(after.state.bombermen[0].idleStillTurns).toBe(0);
  });

  it('test_consoles_perPlayer_sameSpotUsableByBoth', () => {
    // Arrange — two bombermen on opposite sides of console 0, both assigned.
    const map = consoleMap();
    const a = makeBomberman('p1', 4, 5, { idleAction: 'attack' });
    const b = makeBomberman('p2', 7, 5, { idleAction: 'attack' });
    const state = makeState({ bombermen: [a, b] });

    // Act — both channel simultaneously.
    const after = idleTurns(state, map, ['p1', 'p2'], BALANCE.consoles.interactIdleTurns);

    // Assert — trios are per-player: both completed the same spot.
    expect(after.state.bombermen[0].consolesUsed).toEqual([0]);
    expect(after.state.bombermen[1].consolesUsed).toEqual([0]);
    expect(after.events.filter(e => e.kind === 'console_used')).toHaveLength(2);
  });

  it('test_consoles_eventRemaining_countsDownRequirement', () => {
    // Arrange — trio of 2 (map has 2 spots); first completion → remaining 1.
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5, { assignedConsoles: [0, 1] });
    const state = makeState({ bombermen: [bm] });

    // Act
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — required = min(3, 2) = 2, one done → one remaining.
    const ev = after.events.find(e => e.kind === 'console_used');
    expect(ev).toBeDefined();
    expect((ev as { remaining: number }).remaining).toBe(1);
  });

  it('test_consoles_arrivalMoveTurn_doesNotCount', () => {
    // Arrange — bomberman one step outside channel range.
    const map = consoleMap();
    const bm = makeBomberman('p1', 3, 5, { idleAction: 'attack' });
    let state = makeState({ bombermen: [bm] });

    // Act — walk into range (move turn), then idle the full channel.
    state = resolveTurn(state, move('p1', 4, 5), map).state;
    expect(state.bombermen[0].consoleIdleTurns).toBe(0);
    const short = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns - 1);
    expect(short.state.bombermen[0].consolesUsed).toEqual([]);
    const done = idleTurns(short.state, map, ['p1'], 1);

    // Assert — completion lands exactly interactIdleTurns idles after arrival.
    expect(done.state.bombermen[0].consolesUsed).toEqual([0]);
  });

  it('test_consoles_completion_spawnsMiniFlareAtCenter', () => {
    // Arrange — bomberman beside console 0 (footprint 2×2 at (5,5)).
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    const state = makeState({ bombermen: [bm] });

    // Act — complete the channel.
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — a half-radius mini flare sits at the footprint center and the
    // surrounding area is lit immediately (same turn), not one turn later.
    const flare = after.state.flares.find(f => f.id.startsWith('console_flare_0_'));
    expect(flare).toBeDefined();
    expect(flare!.x).toBe(6);
    expect(flare!.y).toBe(6);
    expect(flare!.initialRadius).toBe(BALANCE.consoles.flareRadius);
    expect(flare!.mini).toBe(true);
    const lit = new Set(after.state.lightTiles.map(t => `${t.x},${t.y}`));
    const r = BALANCE.consoles.flareRadius;
    expect(lit.has(`${6 - r},${6 - r}`)).toBe(true);
    expect(lit.has(`${6 + r},${6 + r}`)).toBe(true);
  });

  it('test_consoles_beforeActivationDelay_noChannelProgress', () => {
    // Arrange — bomberman in channel range, but the match just started:
    // consoles are dark for the first activationDelayTurns turns.
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    const state = makeState({ bombermen: [bm], turnNumber: 1 });

    // Act — idle the full channel length while consoles are still dark.
    const after = idleTurns(state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — no engagement, no progress, nothing completed.
    expect(after.state.bombermen[0].consoleEngagedId).toBeNull();
    expect(after.state.bombermen[0].consoleIdleTurns).toBe(0);
    expect(after.state.bombermen[0].consolesUsed).toEqual([]);
    expect(after.events.find(e => e.kind === 'console_used')).toBeUndefined();
  });

  it('test_consoles_activationBoundary_channelStartsTurnAfterDelay', () => {
    // Arrange — in range on the last dark turn (turnNumber === delay).
    const map = consoleMap();
    const bm = makeBomberman('p1', 4, 5);
    const state = makeState({
      bombermen: [bm], turnNumber: BALANCE.consoles.activationDelayTurns,
    });

    // Act — one dark idle turn, then the full channel once powered.
    const dark = idleTurns(state, map, ['p1'], 1);
    expect(dark.state.bombermen[0].consoleIdleTurns).toBe(0);
    const done = idleTurns(dark.state, map, ['p1'], BALANCE.consoles.interactIdleTurns);

    // Assert — channel runs to completion starting on turn delay + 1.
    expect(done.state.bombermen[0].consolesUsed).toEqual([0]);
  });
});
