import type { World } from '../ecs/World.ts';
import { BALANCE } from '../config/balance.ts';

export class MovementSystem {
  update(world: World, dt: number): void {
    for (const roomba of world.getAliveRoombas()) {
      if (roomba.state === 'idle' || roomba.path.length === 0) continue;
      if (roomba.pathIndex >= roomba.path.length) continue;

      // Stop moving while engaged or picking up
      if (roomba.state === 'attacking' && roomba.targetId !== null) continue;
      if (roomba.state === 'picking_up') continue;

      this.moveAlongPath(roomba, dt);
    }
  }

  private moveAlongPath(roomba: import('../types/entities.ts').RoombaState, dt: number): void {
    const target = roomba.path[roomba.pathIndex];
    const targetPx = (target.x + 0.5) * BALANCE.map.tileSize;
    const targetPy = (target.y + 0.5) * BALANCE.map.tileSize;

    const dx = targetPx - roomba.x;
    const dy = targetPy - roomba.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const speed = roomba.spd * BALANCE.map.tileSize * dt;

    if (dist <= speed) {
      roomba.x = targetPx;
      roomba.y = targetPy;
      roomba.pathIndex++;
    } else {
      roomba.x += (dx / dist) * speed;
      roomba.y += (dy / dist) * speed;
    }
  }
}
