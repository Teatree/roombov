import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction, Chest, BombInstance } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';
import { BALANCE } from '../src/shared/config/balance.ts';

/** Open 10×10 floor map. Returns a MapData with a hatch tile at (5,5). */
function openMap(): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < 10; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < 10; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 't', name: 't', width: 10, height: 10, tileSize: 16,
    grid, spawns: [], escapeTiles: [{ id: 0, x: 5, y: 5 }],
    chestZones: [], keySpawns: [],
  };
}

function makeBm(playerId: string, x: number, y: number, opts: Partial<BombermanState> = {}): BombermanState {
  return {
    playerId,
    isBot: false,
    bombermanId: playerId,
    colors: { shirt: 0, pants: 0, hair: 0 },
    tint: 0xffffff,
    character: 'char1',
    x, y,
    hp: 2,
    alive: true,
    treasures: {},
    coins: 0,
    keys: 0,
    maxCustomSlots: 4,
    stackSize: 6,
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0,
    escaped: false,
    rushCooldown: 0,
    rushActive: false,
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    statusEffects: [],
    meleeTrapMode: false,
    sp: 0,
    ...opts,
  } as BombermanState;
}

function makeState(bombermen: BombermanState[], chests: Chest[] = [], bombs: BombInstance[] = []): MatchState {
  return {
    matchId: 'm', mapId: 't',
    phase: 'input', turnNumber: 1, phaseEndsAt: 0,
    bombermen, chests, doors: [], bodies: [], bombs,
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles: [{ x: 5, y: 5 }],
    brokenHatches: [],
    keys: [],
  };
}

function moveTo(playerId: string, x: number, y: number): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  m.set(playerId, { kind: 'move', x, y });
  return m;
}

describe('SP earning', () => {
  it('test_chestOpen_firstStepGrantsSp', () => {
    const bm = makeBm('p1', 0, 0);
    const chest: Chest = {
      id: 'c1', tier: 1, x: 1, y: 0,
      treasures: { mushrooms: 1 }, coins: 0, keys: 0,
      bombs: [], opened: false,
    };
    const state = makeState([bm], [chest]);

    const result = resolveTurn(state, moveTo('p1', 1, 0), openMap());

    const next = result.state.bombermen.find(b => b.playerId === 'p1')!;
    expect(next.sp).toBe(BALANCE.upgrades.sp.perChestOpen);
    expect(result.state.chests[0].opened).toBe(true);
  });

  it('test_chestOpen_secondStepDoesNotGrantSpAgain', () => {
    const bm = makeBm('p2', 0, 0);
    const chest: Chest = {
      id: 'c1', tier: 1, x: 1, y: 0,
      treasures: {}, coins: 0, keys: 0, bombs: [], opened: true,
    };
    const state = makeState([bm], [chest]);

    const result = resolveTurn(state, moveTo('p2', 1, 0), openMap());

    const next = result.state.bombermen.find(b => b.playerId === 'p2')!;
    expect(next.sp).toBe(0);
  });

  it('test_survival_grantsSpEveryNTurns', () => {
    const bm = makeBm('p3', 0, 0);
    const state = makeState([bm]);
    // Resolver awards survival SP when state.turnNumber % perSurvivalTurns === 0.
    // perSurvivalTurns = 5 (default). Set turn = 5 to fire the milestone.
    state.turnNumber = 5;

    const result = resolveTurn(state, new Map(), openMap());

    const next = result.state.bombermen.find(b => b.playerId === 'p3')!;
    expect(next.sp).toBe(1);
  });

  it('test_survival_noSpOnNonMilestoneTurn', () => {
    const bm = makeBm('p4', 0, 0);
    const state = makeState([bm]);
    state.turnNumber = 4;

    const result = resolveTurn(state, new Map(), openMap());

    const next = result.state.bombermen.find(b => b.playerId === 'p4')!;
    expect(next.sp).toBe(0);
  });

  it('test_kill_attackerEarnsPlayerKillSp', () => {
    // Cheapest kill path: place a fire tile on the victim and let the
    // resolver's fire-damage step record the lastDamagedBy attribution.
    const attacker = makeBm('att', 0, 0);
    const victim = makeBm('vic', 1, 1, { hp: 1 });
    const state = makeState([attacker, victim]);
    state.fireTiles.push({
      x: 1, y: 1,
      turnsRemaining: 1,
      ownerId: 'att',
      kind: 'molotov',
    } as never);

    const result = resolveTurn(state, new Map(), openMap());

    expect(result.state.bombermen.find(b => b.playerId === 'vic')!.alive).toBe(false);
    const next = result.state.bombermen.find(b => b.playerId === 'att')!;
    expect(next.sp).toBe(BALANCE.upgrades.sp.perPlayerKill);
  });
});
