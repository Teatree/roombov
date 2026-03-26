import type { World } from '../ecs/World.ts';
import type { RoombaState, GoodieState } from '../types/entities.ts';
import type { BehaviorNode } from '../types/nodes.ts';
import type { Point } from './PathfindingSystem.ts';
import type { TileType } from '../types/map.ts';
import { NodeType } from '../types/nodes.ts';
import { BALANCE } from '../config/balance.ts';
import { PathfindingSystem } from './PathfindingSystem.ts';
import { hasLineOfSight } from './LineOfSight.ts';

const SEARCH_DETOUR_RADIUS = 3; // tiles
const STOP_SEARCH_DURATION = 5; // seconds
const STOP_AMBUSH_DURATION = 8; // seconds

export class BehaviorSystem {
  private pathfinding: PathfindingSystem;
  private behaviorNodes: BehaviorNode[];
  private exitPoint: Point | null = null;
  private grid: TileType[][];
  private stoppedAtNode: Record<number, boolean> = {};

  constructor(pathfinding: PathfindingSystem, nodes: BehaviorNode[], grid: TileType[][], exitPoint?: Point) {
    this.pathfinding = pathfinding;
    this.behaviorNodes = nodes;
    this.grid = grid;
    this.exitPoint = exitPoint ?? null;
  }

  update(world: World, dt: number): void {
    for (const roomba of world.getAliveRoombas()) {
      this.processRoomba(roomba, world, dt);
    }
  }

  private processRoomba(roomba: RoombaState, world: World, dt: number): void {
    // Currently picking up a goodie — wait for pickup timer
    if (roomba.state === 'picking_up') return;

    // Move & Attack: stop and fight if enemy in range
    if (roomba.state === 'attacking' && this.hasEnemyInRange(roomba, world)) {
      return;
    }

    // Stop & Search: searching around the node for goodies
    if (roomba.state === 'searching' && roomba.stopTimer > 0) {
      roomba.stopTimer -= dt;
      if (roomba.stopTimer <= 0) {
        // Done searching — move to next node
        this.advanceFromStop(roomba, world);
      } else {
        // Navigate to nearby goodies during search
        this.searchForNearbyGoodies(roomba, world);
      }
      return;
    }

    // Stop & Ambush: waiting at position for enemies
    if (roomba.state === 'ambushing' && roomba.stopTimer > 0) {
      roomba.stopTimer -= dt;
      if (roomba.stopTimer <= 0) {
        this.advanceFromStop(roomba, world);
      }
      // Ambush attacks are handled by CombatSystem (state === 'ambushing')
      return;
    }

    // If roomba has a path and hasn't finished it, keep moving
    if (roomba.path.length > 0 && roomba.pathIndex < roomba.path.length) {
      return;
    }

    // Path is done or empty — decide what to do next
    if (roomba.currentNodeIndex < this.behaviorNodes.length) {
      const currentNode = this.behaviorNodes[roomba.currentNodeIndex];
      const roombaTileX = Math.floor(roomba.x / BALANCE.map.tileSize);
      const roombaTileY = Math.floor(roomba.y / BALANCE.map.tileSize);

      if (roombaTileX === currentNode.x && roombaTileY === currentNode.y) {
        world.emitEvent({
          type: 'node_reached',
          roombaId: roomba.id,
          nodeId: currentNode.id,
          tick: world.tick,
        });

        // Handle stop behaviors — trigger once at the node
        if (!this.stoppedAtNode[currentNode.id]) {
          if (currentNode.type === NodeType.STOP_SEARCH) {
            this.stoppedAtNode[currentNode.id] = true;
            roomba.state = 'searching';
            roomba.stopTimer = STOP_SEARCH_DURATION;
            return;
          }
          if (currentNode.type === NodeType.STOP_AMBUSH) {
            this.stoppedAtNode[currentNode.id] = true;
            roomba.state = 'ambushing';
            roomba.stopTimer = STOP_AMBUSH_DURATION;
            return;
          }
        }

        roomba.currentNodeIndex++;
      }

      this.navigateToNextTarget(roomba, world);
    } else {
      if (this.exitPoint && roomba.state !== 'extracting') {
        roomba.state = 'extracting';
        this.navigateToPoint(roomba, this.exitPoint);
      }
    }
  }

  private advanceFromStop(roomba: RoombaState, world: World): void {
    roomba.currentNodeIndex++;
    roomba.stopTimer = 0;
    this.navigateToNextTarget(roomba, world);
  }

  /** During Stop & Search, find the nearest uncollected goodie within reveal radius and path to it */
  private searchForNearbyGoodies(roomba: RoombaState, world: World): void {
    // Only redirect if not already pathing to something
    if (roomba.path.length > 0 && roomba.pathIndex < roomba.path.length) return;
    if (roomba.inventory.length >= roomba.inventorySlots) return;

    const ts = BALANCE.map.tileSize;
    const revealRadius = BALANCE.roomba.fogRevealRadius;
    const rx = Math.floor(roomba.x / ts);
    const ry = Math.floor(roomba.y / ts);

    let nearest: GoodieState | null = null;
    let nearestDist = Infinity;

    for (const goodie of world.getUncollectedGoodies()) {
      const gx = Math.floor(goodie.x / ts);
      const gy = Math.floor(goodie.y / ts);
      const dx = Math.abs(gx - rx);
      const dy = Math.abs(gy - ry);
      if (dx <= revealRadius && dy <= revealRadius) {
        const dist = dx + dy;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = goodie;
        }
      }
    }

    if (nearest) {
      const gx = Math.floor(nearest.x / ts);
      const gy = Math.floor(nearest.y / ts);
      this.navigateToPoint(roomba, { x: gx, y: gy });
    }
  }

  private hasEnemyInRange(roomba: RoombaState, world: World): boolean {
    const radiusPx = roomba.atkRad * BALANCE.map.tileSize;
    const ts = BALANCE.map.tileSize;
    for (const turret of world.getAliveTurrets()) {
      const dx = turret.x - roomba.x;
      const dy = turret.y - roomba.y;
      if (Math.sqrt(dx * dx + dy * dy) <= radiusPx) {
        if (hasLineOfSight(roomba.x, roomba.y, turret.x, turret.y, this.grid, ts)) {
          return true;
        }
      }
    }
    return false;
  }

  private navigateToNextTarget(roomba: RoombaState, world: World): void {
    if (roomba.currentNodeIndex >= this.behaviorNodes.length) {
      if (this.exitPoint) {
        roomba.state = 'extracting';
        this.navigateToPoint(roomba, this.exitPoint);
      } else {
        roomba.state = 'idle';
      }
      return;
    }

    const targetNode = this.behaviorNodes[roomba.currentNodeIndex];
    this.applyNodeBehavior(roomba, targetNode);

    if (targetNode.type === NodeType.MOVE_SEARCH) {
      this.navigateWithGoodieDetour(roomba, { x: targetNode.x, y: targetNode.y }, world);
    } else {
      this.navigateToPoint(roomba, { x: targetNode.x, y: targetNode.y });
    }
  }

  private applyNodeBehavior(roomba: RoombaState, node: BehaviorNode): void {
    switch (node.type) {
      case NodeType.MOVE_ATTACK:
        roomba.state = 'attacking';
        roomba.atk = BALANCE.roomba.atk * BALANCE.nodeBonuses.moveAttack.atkMultiplier;
        roomba.spd = BALANCE.roomba.spd;
        break;
      case NodeType.MOVE_AVOID:
        roomba.state = 'avoiding';
        roomba.spd = BALANCE.roomba.spd * BALANCE.nodeBonuses.moveAvoid.spdMultiplier;
        roomba.atk = BALANCE.roomba.atk;
        break;
      case NodeType.MOVE_RUSH:
        roomba.state = 'rushing';
        roomba.spd = BALANCE.roomba.spd * BALANCE.nodeBonuses.moveRush.spdMultiplier;
        roomba.atk = BALANCE.roomba.atk;
        break;
      case NodeType.MOVE_SEARCH:
        roomba.state = 'moving';
        roomba.spd = BALANCE.roomba.spd;
        roomba.atk = BALANCE.roomba.atk;
        break;
      case NodeType.STOP_SEARCH:
      case NodeType.STOP_AMBUSH:
        roomba.state = 'moving';
        roomba.spd = BALANCE.roomba.spd;
        break;
    }
  }

  private navigateWithGoodieDetour(roomba: RoombaState, target: Point, world: World): void {
    if (roomba.inventory.length >= roomba.inventorySlots) {
      this.navigateToPoint(roomba, target);
      return;
    }

    const fromTileX = Math.floor(roomba.x / BALANCE.map.tileSize);
    const fromTileY = Math.floor(roomba.y / BALANCE.map.tileSize);
    const basePath = this.pathfinding.findPath({ x: fromTileX, y: fromTileY }, target);
    if (basePath.length === 0) return;

    const ts = BALANCE.map.tileSize;
    const nearbyGoodies = this.findGoodiesNearPath(basePath, target, world, ts);

    if (nearbyGoodies.length === 0) {
      roomba.path = basePath;
      roomba.pathIndex = 0;
      return;
    }

    const sorted = this.sortGoodiesByPathOrder(nearbyGoodies, basePath, ts);
    const waypoints: Point[] = [];
    let current: Point = { x: fromTileX, y: fromTileY };

    for (const goodie of sorted) {
      const gTile: Point = { x: Math.floor(goodie.x / ts), y: Math.floor(goodie.y / ts) };
      const segment = this.pathfinding.findPath(current, gTile);
      if (segment.length > 0) {
        const start = waypoints.length > 0 && segment[0].x === waypoints[waypoints.length - 1].x
          && segment[0].y === waypoints[waypoints.length - 1].y ? 1 : 0;
        for (let i = start; i < segment.length; i++) waypoints.push(segment[i]);
        current = gTile;
      }
    }

    const finalSeg = this.pathfinding.findPath(current, target);
    if (finalSeg.length > 0) {
      const start = waypoints.length > 0 && finalSeg[0].x === waypoints[waypoints.length - 1].x
        && finalSeg[0].y === waypoints[waypoints.length - 1].y ? 1 : 0;
      for (let i = start; i < finalSeg.length; i++) waypoints.push(finalSeg[i]);
    }

    roomba.path = waypoints.length > 0 ? waypoints : basePath;
    roomba.pathIndex = 0;
  }

  private findGoodiesNearPath(path: Point[], target: Point, world: World, ts: number): GoodieState[] {
    const result: GoodieState[] = [];
    const added = new Set<string>();

    for (const goodie of world.getUncollectedGoodies()) {
      const gx = Math.floor(goodie.x / ts);
      const gy = Math.floor(goodie.y / ts);
      const key = `${gx},${gy}`;
      if (added.has(key)) continue;

      let near = false;
      for (const p of path) {
        if (Math.abs(gx - p.x) <= SEARCH_DETOUR_RADIUS && Math.abs(gy - p.y) <= SEARCH_DETOUR_RADIUS) {
          near = true;
          break;
        }
      }
      if (!near && Math.abs(gx - target.x) <= SEARCH_DETOUR_RADIUS && Math.abs(gy - target.y) <= SEARCH_DETOUR_RADIUS) {
        near = true;
      }

      if (near) { result.push(goodie); added.add(key); }
    }
    return result;
  }

  private sortGoodiesByPathOrder(goodies: GoodieState[], path: Point[], ts: number): GoodieState[] {
    return [...goodies].sort((a, b) => {
      return this.closestPathIndex(Math.floor(a.x / ts), Math.floor(a.y / ts), path)
        - this.closestPathIndex(Math.floor(b.x / ts), Math.floor(b.y / ts), path);
    });
  }

  private closestPathIndex(tx: number, ty: number, path: Point[]): number {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < path.length; i++) {
      const d = (path[i].x - tx) ** 2 + (path[i].y - ty) ** 2;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  private navigateToPoint(roomba: RoombaState, target: Point): void {
    const fromTileX = Math.floor(roomba.x / BALANCE.map.tileSize);
    const fromTileY = Math.floor(roomba.y / BALANCE.map.tileSize);
    const path = this.pathfinding.findPath({ x: fromTileX, y: fromTileY }, target);
    if (path.length > 0) {
      roomba.path = path;
      roomba.pathIndex = 0;
    }
  }
}
