import type { ExpeditionListing } from './expedition.ts';

// --- Lobby Phase ---

export interface JoinMsg {
  expeditionId: string;
}

export interface JoinedMsg {
  expeditionId: string;
  spawnId: number;
  assignedExitIndices: number[];
}

// --- Planning Phase ---

export interface ReadyMsg {
  configId: string;
}

// --- Execution Phase ---

export interface PositionMsg {
  x: number;
  y: number;
  state: string;
  hp: number;
  barrelAngle: number;
}

export interface PlayerPositions {
  [socketId: string]: {
    x: number;
    y: number;
    state: string;
    hp: number;
    barrelAngle: number;
  };
}

export interface TurretKilledMsg {
  key: string;
}

export interface TurretKilledBroadcast {
  key: string;
  killedBy: string;
}

export interface GoodieCollectedMsg {
  key: string;
}

export interface GoodieCollectedBroadcast {
  key: string;
  collectedBy: string;
}

export interface GoodieRejectedMsg {
  key: string;
}

export interface StageDoneMsg {
  extracted: boolean;
  goodiesCollected: number;
}

export interface StageResultMsg {
  nextStage?: number;
  expeditionOver?: boolean;
}

// --- Server → Client event map (for typed listeners) ---

export interface ServerToClientEvents {
  listings: (listings: ExpeditionListing[]) => void;
  joined: (msg: JoinedMsg) => void;
  expedition_start: (msg: { configId: string }) => void;
  all_ready: (msg: Record<string, never>) => void;
  players: (positions: PlayerPositions) => void;
  turret_killed: (msg: TurretKilledBroadcast) => void;
  goodie_collected: (msg: GoodieCollectedBroadcast) => void;
  goodie_rejected: (msg: GoodieRejectedMsg) => void;
  stage_result: (msg: StageResultMsg) => void;
}

export interface ClientToServerEvents {
  join: (msg: JoinMsg) => void;
  ready: (msg: ReadyMsg) => void;
  position: (msg: PositionMsg) => void;
  turret_killed: (msg: TurretKilledMsg) => void;
  goodie_collected: (msg: GoodieCollectedMsg) => void;
  stage_done: (msg: StageDoneMsg) => void;
}
