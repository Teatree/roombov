export enum NodeType {
  MOVE_SEARCH = 'move_search',
  MOVE_ATTACK = 'move_attack',
  MOVE_AVOID = 'move_avoid',
  MOVE_RUSH = 'move_rush',
  STOP_SEARCH = 'stop_search',
  STOP_AMBUSH = 'stop_ambush',
}

export interface BehaviorNode {
  id: number;
  type: NodeType;
  x: number;
  y: number;
  order: number;
}

export interface ExpeditionPlan {
  roombaId: string;
  spawnId: number;
  nodes: BehaviorNode[];
}
