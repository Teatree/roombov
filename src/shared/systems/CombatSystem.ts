import type { World } from '../ecs/World.ts';
import type { RoombaState, TurretState, Projectile } from '../types/entities.ts';
import type { TileType } from '../types/map.ts';
import { BALANCE } from '../config/balance.ts';
import { generateId } from '../ecs/Entity.ts';
import { hasLineOfSight } from './LineOfSight.ts';

const ROCKET_SPEED = 4; // progress per second (0→1 in 0.25s)
const EXPLOSION_DURATION = 0.4; // seconds

export class CombatSystem {
  private grid: TileType[][];

  constructor(grid: TileType[][]) {
    this.grid = grid;
  }

  update(world: World, dt: number): void {
    this.updateProjectiles(world, dt);
    this.updateTurrets(world, dt);
    this.updateRoombaAttacks(world, dt);
  }

  private updateProjectiles(world: World, dt: number): void {
    const ts = BALANCE.map.tileSize;

    for (let i = world.projectiles.length - 1; i >= 0; i--) {
      const p = world.projectiles[i];

      if (p.impacted) {
        // Explosion visual phase
        p.explosionTimer -= dt;
        if (p.explosionTimer <= 0) {
          world.projectiles.splice(i, 1);
        }
        continue;
      }

      // Advance rocket
      p.progress += ROCKET_SPEED * dt;

      if (p.progress >= 1) {
        // Impact — apply damage now
        p.impacted = true;
        p.progress = 1;
        p.explosionTimer = EXPLOSION_DURATION;

        if (p.source === 'turret') {
          const target = world.roombas.find(r => r.id === p.targetId && r.alive);
          if (target) {
            target.hp -= p.damage;
            world.emitEvent({
              type: 'roomba_damaged',
              roombaId: target.id,
              turretId: p.sourceId,
              damage: p.damage,
              hpRemaining: target.hp,
              tick: world.tick,
            });
            if (target.hp <= 0) {
              target.alive = false;
              world.emitEvent({
                type: 'roomba_destroyed',
                roombaId: target.id,
                turretId: p.sourceId,
                tick: world.tick,
              });
            }
          }
        } else {
          const target = world.turrets.find(t => t.id === p.targetId && t.alive);
          if (target) {
            target.hp -= p.damage;
            world.emitEvent({
              type: 'turret_damaged',
              turretId: target.id,
              roombaId: p.sourceId,
              damage: p.damage,
              hpRemaining: target.hp,
              tick: world.tick,
            });
            if (target.hp <= 0) {
              target.alive = false;
              target.deathTimer = 1.5;

              const goodieId = generateId();
              world.addGoodie({
                id: goodieId,
                x: target.x,
                y: target.y,
                collected: false,
                collectedBy: null,
                type: 'generic',
                stage: target.stage,
              });
              world.emitEvent({
                type: 'turret_destroyed',
                turretId: target.id,
                roombaId: p.sourceId,
                goodieDropped: goodieId,
                tick: world.tick,
              });
            }
          }
        }
      }
    }
  }

  private updateTurrets(world: World, dt: number): void {
    const ts = BALANCE.map.tileSize;

    for (const turret of world.getAliveTurrets()) {
      turret.attackCooldown = Math.max(0, turret.attackCooldown - dt);

      const target = this.findNearestRoombaWithLOS(turret, world, ts);
      if (!target) {
        turret.targetId = null;
        continue;
      }

      turret.targetId = target.id;
      turret.barrelAngle = Math.atan2(target.y - turret.y, target.x - turret.x);

      if (turret.attackCooldown <= 0) {
        turret.attackCooldown = 1 / turret.atkSpd;

        world.projectiles.push({
          fromX: turret.x,
          fromY: turret.y,
          toX: target.x,
          toY: target.y,
          progress: 0,
          speed: ROCKET_SPEED,
          color: 0xff4444,
          damage: turret.atk,
          targetId: target.id,
          source: 'turret',
          sourceId: turret.id,
          impacted: false,
          explosionTimer: 0,
        });
      }
    }
  }

  private updateRoombaAttacks(world: World, dt: number): void {
    const ts = BALANCE.map.tileSize;

    for (const roomba of world.getAliveRoombas()) {
      if (roomba.state !== 'attacking' && roomba.state !== 'ambushing') {
        roomba.targetId = null;
        continue;
      }

      roomba.attackCooldown = Math.max(0, roomba.attackCooldown - dt);

      const radiusPx = roomba.atkRad * ts;
      const nearestTurret = this.findNearestTurretWithLOS(roomba, world, radiusPx, ts);
      if (!nearestTurret) {
        roomba.targetId = null;
        continue;
      }

      roomba.targetId = nearestTurret.id;
      roomba.barrelAngle = Math.atan2(nearestTurret.y - roomba.y, nearestTurret.x - roomba.x);

      if (roomba.attackCooldown <= 0) {
        roomba.attackCooldown = 1 / roomba.atkSpd;

        world.projectiles.push({
          fromX: roomba.x,
          fromY: roomba.y,
          toX: nearestTurret.x,
          toY: nearestTurret.y,
          progress: 0,
          speed: ROCKET_SPEED,
          color: 0x44aaff,
          damage: roomba.atk,
          targetId: nearestTurret.id,
          source: 'roomba',
          sourceId: roomba.id,
          impacted: false,
          explosionTimer: 0,
        });
      }
    }
  }

  private findNearestRoombaWithLOS(turret: TurretState, world: World, ts: number): RoombaState | null {
    const radiusPx = turret.atkRad * ts;
    let nearest: RoombaState | null = null;
    let nearestDist = Infinity;

    for (const roomba of world.getAliveRoombas()) {
      const dx = roomba.x - turret.x;
      const dy = roomba.y - turret.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radiusPx && dist < nearestDist) {
        if (hasLineOfSight(turret.x, turret.y, roomba.x, roomba.y, this.grid, ts)) {
          nearest = roomba;
          nearestDist = dist;
        }
      }
    }
    return nearest;
  }

  private findNearestTurretWithLOS(roomba: RoombaState, world: World, radiusPx: number, ts: number): TurretState | null {
    let nearest: TurretState | null = null;
    let nearestDist = Infinity;

    for (const turret of world.getAliveTurrets()) {
      const dx = turret.x - roomba.x;
      const dy = turret.y - roomba.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radiusPx && dist < nearestDist) {
        if (hasLineOfSight(roomba.x, roomba.y, turret.x, turret.y, this.grid, ts)) {
          nearest = turret;
          nearestDist = dist;
        }
      }
    }
    return nearest;
  }
}
