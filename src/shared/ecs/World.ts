import type { RoombaState, TurretState, GoodieState, Projectile } from '../types/entities.ts';
import type { GameEvent } from '../types/game-state.ts';

export class World {
  roombas: RoombaState[] = [];
  turrets: TurretState[] = [];
  goodies: GoodieState[] = [];
  projectiles: Projectile[] = [];
  events: GameEvent[] = [];
  tick = 0;

  addRoomba(roomba: RoombaState): void {
    this.roombas.push(roomba);
  }

  addTurret(turret: TurretState): void {
    this.turrets.push(turret);
  }

  addGoodie(goodie: GoodieState): void {
    this.goodies.push(goodie);
  }

  emitEvent(event: GameEvent): void {
    this.events.push(event);
  }

  getAliveRoombas(): RoombaState[] {
    return this.roombas.filter(r => r.alive && !r.extracted);
  }

  getAliveTurrets(): TurretState[] {
    return this.turrets.filter(t => t.alive);
  }

  getUncollectedGoodies(): GoodieState[] {
    return this.goodies.filter(g => !g.collected);
  }
}
