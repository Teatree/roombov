import type { FogTile } from './game-state.ts';
import type { MapData, ExitPoint } from './map.ts';

export type KeyMap = Record<string, boolean>;

export interface SpawnedEntity {
  x: number;
  y: number;
}

// --- Expedition Config (immutable, generated at lobby time) ---

export interface ExpeditionConfig {
  id: string;
  mapId: string;
  mapName: string;
  risk: 1 | 2 | 3 | 4 | 5;
  reward: 1 | 2 | 3 | 4 | 5;
  stages: number;
  turretCountRange: [number, number];
  goodieCountRange: [number, number];
  maxPlayers: number;
  /** Unix ms when this expedition starts */
  startTime: number;
  /** Seed for deterministic entity placement */
  seed: number;
}

export interface ExpeditionListing {
  config: ExpeditionConfig;
  playerCount: number;
  countdown: number;
}

// --- Expedition Runtime State (mutable, per-player during gameplay) ---

export interface ExpeditionData {
  configId: string;
  totalStages: number;
  mapData: MapData;
  assignedSpawnId: number;
  currentStage: number;
  totalGoodiesCollected: number;
  roombasLost: number;
  roombasExtracted: number;
  fogGrid: FogTile[][] | null;
  assignedExits: ExitPoint[];
  turretPositions: SpawnedEntity[];
  goodiePositions: SpawnedEntity[];
  killedTurrets: KeyMap;
  collectedGoodies: KeyMap;
  discoveredTurrets: KeyMap;
  discoveredGoodies: KeyMap;
  droppedGoodies: SpawnedEntity[];
}
