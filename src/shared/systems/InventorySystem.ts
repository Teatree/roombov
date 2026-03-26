import type { World } from '../ecs/World.ts';
import { BALANCE } from '../config/balance.ts';

const PICKUP_DURATION = 1; // seconds

export class InventorySystem {
  update(world: World, dt: number): void {
    for (const roomba of world.getAliveRoombas()) {
      // Handle active pickup
      if (roomba.state === 'picking_up') {
        roomba.pickupTimer -= dt;
        if (roomba.pickupTimer <= 0) {
          this.completePickup(roomba, world);
        }
        continue;
      }

      if (roomba.inventory.length >= roomba.inventorySlots) continue;

      // Only pick up in move/search/searching states
      const canPickup = roomba.state === 'moving' || roomba.state === 'searching';
      if (!canPickup) continue;

      // Find nearest goodie within 1 tile
      for (const goodie of world.getUncollectedGoodies()) {
        const dx = goodie.x - roomba.x;
        const dy = goodie.y - roomba.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= BALANCE.map.tileSize) {
          // Start pickup — pause roomba for 1 second
          roomba.previousState = roomba.state;
          roomba.state = 'picking_up';
          roomba.pickupTimer = PICKUP_DURATION;
          roomba.pickupTargetId = goodie.id;
          break;
        }
      }
    }
  }

  private completePickup(roomba: import('../types/entities.ts').RoombaState, world: World): void {
    const goodie = world.goodies.find(g => g.id === roomba.pickupTargetId && !g.collected);

    if (goodie && roomba.inventory.length < roomba.inventorySlots) {
      goodie.collected = true;
      goodie.collectedBy = roomba.id;
      roomba.inventory.push({ id: goodie.id, type: goodie.type });

      world.emitEvent({
        type: 'goodie_collected',
        goodieId: goodie.id,
        roombaId: roomba.id,
        tick: world.tick,
      });
    }

    // Restore previous state
    roomba.state = roomba.previousState ?? 'moving';
    roomba.pickupTargetId = null;
    roomba.previousState = null;
  }
}
