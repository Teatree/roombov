import type { RoombaState, TurretState, GoodieState } from './entities.ts';

export enum Phase {
  PLANNING = 'planning',
  EXECUTION = 'execution',
  RESULTS = 'results',
}

export enum FogTile {
  HIDDEN = 0,
  REVEALED = 1,
}

export interface StageState {
  stageNumber: number;
  phase: Phase;
  timeRemaining: number;
  roombas: RoombaState[];
  turrets: TurretState[];
  goodies: GoodieState[];
  fogGrid: FogTile[][];
  events: GameEvent[];
}

export interface ExpeditionState {
  mapId: string;
  currentStage: number;
  stages: StageState[];
  totalGoodiesCollected: number;
  totalRoombasLost: number;
}

export type GameEvent =
  | { type: 'roomba_damaged'; roombaId: string; turretId: string; damage: number; hpRemaining: number; tick: number }
  | { type: 'turret_damaged'; turretId: string; roombaId: string; damage: number; hpRemaining: number; tick: number }
  | { type: 'turret_destroyed'; turretId: string; roombaId: string; goodieDropped: string; tick: number }
  | { type: 'roomba_destroyed'; roombaId: string; turretId: string; tick: number }
  | { type: 'goodie_collected'; goodieId: string; roombaId: string; tick: number }
  | { type: 'roomba_extracted'; roombaId: string; exitId: number; goodieCount: number; tick: number }
  | { type: 'fog_revealed'; x: number; y: number; radius: number; tick: number }
  | { type: 'node_reached'; roombaId: string; nodeId: number; tick: number };
