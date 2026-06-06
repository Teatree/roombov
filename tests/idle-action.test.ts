import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState, IdleAction } from '../src/shared/types/bomberman.ts';
import { BALANCE } from '../src/shared/config/balance.ts';

/** All-floor map of the given size. */
function floorMap(size = 10): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_idle', name: 'test idle', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [], chestZones: [],
  };
}

function makeBomberman(
  id: string, x: number, y: number,
  opts: { idleAction?: IdleAction; hp?: number; maxHp?: number; keys?: number } = {},
): BombermanState {
  return {
    playerId: id, isBot: false, bombermanId: 'bm', name: id,
    colors: { shirt: 0, pants: 0, hair: 0 }, tint: 0xffffff, character: 'char1',
    idleAction: opts.idleAction ?? 'attack',
    x, y,
    hp: opts.hp ?? 2, maxHp: opts.maxHp ?? 2, alive: true,
    treasures: {}, coins: 0, keys: opts.keys ?? 0,
    maxCustomSlots: 4, stackSize: 6,
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0, escaped: false, rushCooldown: 0, rushActive: false,
    teleportedThisTurn: false, onHatchIdleTurns: 0, statusEffects: [],
    meleeTrapMode: false, idleStillTurns: 0, sp: 0,
  };
}

function makeState(
  bombermen: BombermanState[],
  opts: { escapeTiles?: { x: number; y: number }[]; fireTiles?: MatchState['fireTiles'] } = {},
): MatchState {
  return {
    matchId: 'm-idle',
    mapId: 'test_idle',
    phase: 'input',
    turnNumber: 1,
    phaseEndsAt: 0,
    bombermen,
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: opts.fireTiles ?? [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles: opts.escapeTiles ?? [],
    brokenHatches: [],
    keys: [],
  };
}

function idle(ids: string[]): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  for (const id of ids) m.set(id, { kind: 'idle' });
  return m;
}

/** Idle the given bomberman N consecutive turns; returns the final state + last events. */
function idleTurns(state: MatchState, map: MapData, id: string, n: number) {
  let s = state;
  let events: ReturnType<typeof resolveTurn>['events'] = [];
  for (let i = 0; i < n; i++) {
    const r = resolveTurn(s, idle([id]), map);
    s = r.state;
    events = r.events;
  }
  return { state: s, events };
}

describe('Idle Action — Heal on Idle', () => {
  it('test_healOnIdle_threeIdleTurnsWhenHurt_restoresOneHp', () => {
    // Arrange — hurt heal-class bomberman (1/2 HP) standing on open floor.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 1, maxHp: 2 });
    const state = makeState([bm]);

    // Act — two idle turns: progress accrues but no heal yet.
    const two = idleTurns(state, map, 'p1', 2);
    expect(two.state.bombermen[0].hp).toBe(1);
    expect(two.state.bombermen[0].idleStillTurns).toBe(2);

    // Act — third idle turn fires the heal.
    const three = resolveTurn(two.state, idle(['p1']), map);

    // Assert — +1 HP, counter reset, heal event emitted.
    expect(three.state.bombermen[0].hp).toBe(2);
    expect(three.state.bombermen[0].idleStillTurns).toBe(0);
    expect(three.events.filter(e => e.kind === 'heal_applied')).toHaveLength(1);
  });

  it('test_healOnIdle_atFullHp_neverStartsHealing', () => {
    // Arrange — full-HP heal-class bomberman.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 2, maxHp: 2 });
    const state = makeState([bm]);

    // Act — idle well past the heal threshold.
    const after = idleTurns(state, map, 'p1', BALANCE.idleActions.healIdleTurns + 2);

    // Assert — no progress accrues and HP stays capped.
    expect(after.state.bombermen[0].hp).toBe(2);
    expect(after.state.bombermen[0].idleStillTurns).toBe(0);
  });

  it('test_healOnIdle_neverHealsCapAboveMaxHp', () => {
    // Arrange — hurt bomberman with maxHp 2 idling long enough for two heals.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 1, maxHp: 2 });
    const state = makeState([bm]);

    // Act — idle for two full heal cycles' worth of turns.
    const after = idleTurns(state, map, 'p1', BALANCE.idleActions.healIdleTurns * 2 + 1);

    // Assert — clamped at maxHp.
    expect(after.state.bombermen[0].hp).toBe(2);
  });

  it('test_healOnIdle_onEscapeHatch_doesNotHeal', () => {
    // Arrange — hurt heal-class bomberman parked on a hatch (no keys → no escape).
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 1, maxHp: 2, keys: 0 });
    const state = makeState([bm], { escapeTiles: [{ x: 4, y: 4 }] });

    // Act — idle past the heal threshold while standing on the hatch.
    const after = idleTurns(state, map, 'p1', BALANCE.idleActions.healIdleTurns + 1);

    // Assert — healing never starts on a hatch tile.
    expect(after.state.bombermen[0].hp).toBe(1);
    expect(after.state.bombermen[0].escaped).toBe(false);
  });

  it('test_healOnIdle_resetsProgressOnMove', () => {
    // Arrange — hurt heal-class bomberman.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 1, maxHp: 2 });
    const state = makeState([bm]);

    // Act — idle twice, then move one tile.
    const two = idleTurns(state, map, 'p1', 2);
    expect(two.state.bombermen[0].idleStillTurns).toBe(2);
    const moved = resolveTurn(two.state, new Map([['p1', { kind: 'move', x: 5, y: 4 }]]), map);

    // Assert — counter reset, no heal.
    expect(moved.state.bombermen[0].idleStillTurns).toBe(0);
    expect(moved.state.bombermen[0].hp).toBe(1);
  });

  it('test_healOnIdle_resetsProgressOnDamage', () => {
    // Arrange — hurt heal-class bomberman sitting on a fire tile (1 dmg/turn).
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'heal', hp: 2, maxHp: 2 });
    const state = makeState([bm], {
      fireTiles: [{ x: 4, y: 4, turnsRemaining: 5, ownerId: 'env' }],
    });

    // Act — one idle turn while burning.
    const after = resolveTurn(state, idle(['p1']), map);

    // Assert — took fire damage and the heal counter stays at 0.
    expect(after.state.bombermen[0].hp).toBe(1);
    expect(after.state.bombermen[0].idleStillTurns).toBe(0);
  });
});

describe('Idle Action — Disguise on Idle', () => {
  it('test_disguiseOnIdle_reachingThreshold_disguisesIntoObject', () => {
    // Arrange — disguise-class bomberman on open floor.
    const map = floorMap();
    const threshold = BALANCE.idleActions.disguiseIdleTurns;
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'disguise' });
    const state = makeState([bm]);

    // Act — idle one turn short of the threshold: not yet disguised.
    const before = idleTurns(state, map, 'p1', threshold - 1);
    expect(before.state.bombermen[0].disguiseFrame).toBeUndefined();

    // Act — the threshold-th idle turn: disguise kicks in.
    const at = resolveTurn(before.state, idle(['p1']), map);

    // Assert — a valid disguise frame is set and the event fired.
    const frame = at.state.bombermen[0].disguiseFrame;
    expect(frame).toBeDefined();
    expect(frame).toBeGreaterThanOrEqual(0);
    expect(frame!).toBeLessThan(BALANCE.idleActions.disguiseObjectCount);
    expect(at.events.filter(e => e.kind === 'disguise_applied')).toHaveLength(1);
  });

  it('test_disguiseOnIdle_disguiseFrameIsDeterministicUnderFixedSeed', () => {
    // Arrange — identical matchId/turn/player produce identical disguise frames.
    const map = floorMap();
    const run = () => {
      const bm = makeBomberman('p1', 4, 4, { idleAction: 'disguise' });
      const state = makeState([bm]);
      return idleTurns(state, map, 'p1', BALANCE.idleActions.disguiseIdleTurns).state.bombermen[0].disguiseFrame;
    };

    // Act + Assert — two independent runs match.
    expect(run()).toBe(run());
  });

  it('test_disguiseOnIdle_dropsDisguiseOnMove', () => {
    // Arrange — bomberman that has fully disguised.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'disguise' });
    const state = makeState([bm]);
    const disguised = idleTurns(state, map, 'p1', BALANCE.idleActions.disguiseIdleTurns);
    expect(disguised.state.bombermen[0].disguiseFrame).toBeDefined();

    // Act — move off the spot.
    const moved = resolveTurn(disguised.state, new Map([['p1', { kind: 'move', x: 5, y: 4 }]]), map);

    // Assert — disguise dropped + removal event.
    expect(moved.state.bombermen[0].disguiseFrame).toBeUndefined();
    expect(moved.events.filter(e => e.kind === 'disguise_removed')).toHaveLength(1);
  });

  it('test_disguiseOnIdle_dropsDisguiseOnDamage', () => {
    // Arrange — disguised bomberman, then a fire tile appears under them.
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4, { idleAction: 'disguise', hp: 2, maxHp: 2 });
    const state = makeState([bm]);
    const disguised = idleTurns(state, map, 'p1', BALANCE.idleActions.disguiseIdleTurns);
    expect(disguised.state.bombermen[0].disguiseFrame).toBeDefined();

    const burning: MatchState = {
      ...disguised.state,
      fireTiles: [{ x: 4, y: 4, turnsRemaining: 5, ownerId: 'env' }],
    };

    // Act — idle while taking fire damage.
    const after = resolveTurn(burning, idle(['p1']), map);

    // Assert — damage dropped the disguise and reset progress.
    expect(after.state.bombermen[0].hp).toBe(1);
    expect(after.state.bombermen[0].disguiseFrame).toBeUndefined();
  });
});

describe('Idle Action — Attack class + defaults', () => {
  it('test_attackOnIdle_entersMeleeTrapMode_healDisguiseDoNot', () => {
    // Arrange — one of each class idling far apart on open floor.
    const map = floorMap();
    const atk = makeBomberman('atk', 1, 1, { idleAction: 'attack' });
    const heal = makeBomberman('heal', 5, 5, { idleAction: 'heal', hp: 1, maxHp: 2 });
    const dis = makeBomberman('dis', 8, 8, { idleAction: 'disguise' });
    const state = makeState([atk, heal, dis]);

    // Act — one idle turn for everyone.
    const after = resolveTurn(state, idle(['atk', 'heal', 'dis']), map);

    // Assert — only the attack class arms a melee trap.
    const byId = Object.fromEntries(after.state.bombermen.map(b => [b.playerId, b]));
    expect(byId.atk.meleeTrapMode).toBe(true);
    expect(byId.heal.meleeTrapMode).toBe(false);
    expect(byId.dis.meleeTrapMode).toBe(false);
  });

  it('test_idleAction_missingClass_defaultsToAttackBehavior', () => {
    // Arrange — a lean bomberman with no idleAction (legacy/partial state).
    const map = floorMap();
    const bm = makeBomberman('p1', 4, 4);
    delete (bm as Partial<BombermanState>).idleAction;
    const state = makeState([bm]);

    // Act — one idle turn.
    const after = resolveTurn(state, idle(['p1']), map);

    // Assert — normalized to Attack: arms a melee trap, never disguises.
    expect(after.state.bombermen[0].idleAction).toBe('attack');
    expect(after.state.bombermen[0].meleeTrapMode).toBe(true);
    expect(after.state.bombermen[0].disguiseFrame).toBeUndefined();
  });
});
