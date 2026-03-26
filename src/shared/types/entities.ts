export type RoombaActionState =
  | 'idle'
  | 'moving'
  | 'searching'
  | 'attacking'
  | 'avoiding'
  | 'rushing'
  | 'ambushing'
  | 'extracting'
  | 'picking_up';

export interface GoodieItem {
  id: string;
  type: string;
}

export interface RoombaState {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  atk: number;
  atkSpd: number;
  atkRad: number;
  spd: number;
  inventorySlots: number;
  inventory: GoodieItem[];
  currentNodeIndex: number;
  state: RoombaActionState;
  alive: boolean;
  extracted: boolean;
  path: { x: number; y: number }[];
  pathIndex: number;
  attackCooldown: number;
  targetId: string | null;
  barrelAngle: number;
  deathTimer: number;
  stopTimer: number;
  pickupTimer: number;
  pickupTargetId: string | null;
  previousState: RoombaActionState | null;
}

export interface Projectile {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  progress: number;
  speed: number;
  color: number;
  /** Damage to apply on impact */
  damage: number;
  /** Entity ID of the target (roomba or turret) */
  targetId: string;
  /** Who fired: 'turret' or 'roomba' */
  source: 'turret' | 'roomba';
  /** ID of the shooter (for event attribution) */
  sourceId: string;
  /** Set to true after impact has been processed */
  impacted: boolean;
  /** Timer for explosion visual after impact (seconds) */
  explosionTimer: number;
}

export interface TurretState {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  atk: number;
  atkSpd: number;
  atkRad: number;
  alive: boolean;
  targetId: string | null;
  attackCooldown: number;
  barrelAngle: number;
  stage: number;
  deathTimer: number;
}

export interface GoodieState {
  id: string;
  x: number;
  y: number;
  collected: boolean;
  collectedBy: string | null;
  type: string;
  stage: number;
}
