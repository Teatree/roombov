import Phaser from 'phaser';
import { MapRenderer } from '../systems/MapRenderer.ts';
import { CameraController } from '../systems/CameraController.ts';
import { FogOfWarRenderer } from '../systems/FogOfWarRenderer.ts';
import { EntityRenderer } from '../systems/EntityRenderer.ts';
import { FogOfWarSystem } from '@shared/systems/FogOfWarSystem.ts';
import { PathfindingSystem } from '@shared/systems/PathfindingSystem.ts';
import { MovementSystem } from '@shared/systems/MovementSystem.ts';
import { BehaviorSystem } from '@shared/systems/BehaviorSystem.ts';
import { CombatSystem } from '@shared/systems/CombatSystem.ts';
import { InventorySystem } from '@shared/systems/InventorySystem.ts';
import { World } from '@shared/ecs/World.ts';
import { generateId } from '@shared/ecs/Entity.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { ExpeditionStore } from '@shared/ExpeditionStore.ts';
import type { ExpeditionData } from '@shared/types/expedition.ts';
import type { BehaviorNode } from '@shared/types/nodes.ts';
import type { RoombaState, TurretState, GoodieState } from '@shared/types/entities.ts';

export class ExecutionScene extends Phaser.Scene {
  private mapRenderer!: MapRenderer;
  private cameraController!: CameraController;
  private fogRenderer!: FogOfWarRenderer;
  private fogSystem!: FogOfWarSystem;
  private entityRenderer!: EntityRenderer;

  private world!: World;
  private movementSystem!: MovementSystem;
  private behaviorSystem!: BehaviorSystem;
  private combatSystem!: CombatSystem;
  private inventorySystem!: InventorySystem;

  private expedition!: ExpeditionData;
  private nodes!: BehaviorNode[];
  private timeRemaining = BALANCE.expedition.execTimeSeconds;
  private tickAccumulator = 0;
  private ended = false;
  private deathAnimTimer = 0;
  private deathAnimActive = false;

  // HUD elements
  private timerText!: Phaser.GameObjects.Text;
  private stageText!: Phaser.GameObjects.Text;
  private hpText!: Phaser.GameObjects.Text;
  private hpBar!: Phaser.GameObjects.Graphics;
  private lootText!: Phaser.GameObjects.Text;
  private totalLootText!: Phaser.GameObjects.Text;
  private stateText!: Phaser.GameObjects.Text;
  private eventLog!: Phaser.GameObjects.Text;
  private logLines: string[] = [];

  constructor() {
    super({ key: 'ExecutionScene' });
  }

  init(): void {
    this.expedition = ExpeditionStore.get()!;
    this.nodes = ExpeditionStore.getNodes();
    this.timeRemaining = BALANCE.expedition.execTimeSeconds;
    this.tickAccumulator = 0;
    this.ended = false;
    this.deathAnimActive = false;
    this.deathAnimTimer = 0;
    this.logLines = [];
    this.initWorld();
  }

  private initWorld(): void {
    const { expedition, nodes } = this;
    const mapData = expedition.mapData;

    this.world = new World();

    // Fog (carry over from planning)
    this.fogSystem = new FogOfWarSystem(mapData.width, mapData.height);
    if (expedition.fogGrid) {
      this.fogSystem.setGrid(expedition.fogGrid);
    }

    // Find nearest assigned exit to last node
    const lastPoint = nodes.length > 0
      ? nodes[nodes.length - 1]
      : mapData.spawns.find(s => s.id === expedition.assignedSpawnId)!;
    const nearestExit = this.findNearestExit(lastPoint.x, lastPoint.y);

    // Pathfinding
    const pathfinding = new PathfindingSystem(mapData);

    // Systems
    this.movementSystem = new MovementSystem();
    this.behaviorSystem = new BehaviorSystem(pathfinding, nodes, mapData.grid, nearestExit ? { x: nearestExit.x, y: nearestExit.y } : undefined);
    this.combatSystem = new CombatSystem(mapData.grid);
    this.inventorySystem = new InventorySystem();

    // Create roomba at spawn
    const spawn = mapData.spawns.find(s => s.id === expedition.assignedSpawnId)!;
    const ts = BALANCE.map.tileSize;
    const roomba: RoombaState = {
      id: generateId(),
      x: (spawn.x + 0.5) * ts,
      y: (spawn.y + 0.5) * ts,
      hp: BALANCE.roomba.hp,
      maxHp: BALANCE.roomba.hp,
      atk: BALANCE.roomba.atk,
      atkSpd: BALANCE.roomba.atkSpd,
      atkRad: BALANCE.roomba.atkRad,
      spd: BALANCE.roomba.spd,
      inventorySlots: BALANCE.roomba.inventorySlots,
      inventory: [],
      currentNodeIndex: 0,
      state: 'idle',
      alive: true,
      extracted: false,
      path: [],
      pathIndex: 0,
      attackCooldown: 0,
      targetId: null,
      barrelAngle: 0,
      deathTimer: 0,
      stopTimer: 0,
      pickupTimer: 0,
      pickupTargetId: null,
      previousState: null,
    };
    this.world.addRoomba(roomba);

    // Turrets — use expedition's fixed positions, skip killed ones
    for (const tp of expedition.turretPositions) {
      const key = `${tp.x},${tp.y}`;
      if (expedition.killedTurrets[key]) continue;

      const turret: TurretState = {
        id: generateId(),
        x: (tp.x + 0.5) * ts,
        y: (tp.y + 0.5) * ts,
        hp: BALANCE.turret.hp,
        maxHp: BALANCE.turret.hp,
        atk: BALANCE.turret.atk,
        atkSpd: BALANCE.turret.atkSpd,
        atkRad: BALANCE.turret.atkRad,
        alive: true,
        targetId: null,
        attackCooldown: 0,
        barrelAngle: 0,
        stage: 1,
        deathTimer: 0,
      };
      this.world.addTurret(turret);
    }

    // Goodies — use expedition's fixed positions + dropped goodies, skip collected
    const allGoodies = [...expedition.goodiePositions, ...expedition.droppedGoodies];
    for (const gp of allGoodies) {
      const key = `${gp.x},${gp.y}`;
      if (expedition.collectedGoodies[key]) continue;
      const goodie: GoodieState = {
        id: generateId(),
        x: (gp.x + 0.5) * ts,
        y: (gp.y + 0.5) * ts,
        collected: false,
        collectedBy: null,
        type: 'generic',
        stage: 1,
      };
      this.world.addGoodie(goodie);
    }
  }

  private findNearestExit(x: number, y: number) {
    const exits = this.expedition.assignedExits;
    if (exits.length === 0) return null;
    let nearest = exits[0];
    let nearestDist = Infinity;
    for (const exit of exits) {
      const dx = exit.x - x;
      const dy = exit.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearest = exit;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  create(): void {
    const mapData = this.expedition.mapData;

    this.mapRenderer = new MapRenderer(this, mapData);
    this.mapRenderer.renderSpawn(this, this.expedition.assignedSpawnId);
    this.mapRenderer.renderAssignedExits(this, this.expedition.assignedExits);

    this.fogRenderer = new FogOfWarRenderer(this, mapData, this.fogSystem);
    this.entityRenderer = new EntityRenderer(this);

    const bounds = this.mapRenderer.getWorldBounds();
    this.cameraController = new CameraController(this, bounds.width, bounds.height);

    const roomba = this.world.roombas[0];
    if (roomba) {
      this.cameras.main.centerOn(roomba.x, roomba.y);
    }

    this.createHUD();

    this.addLogLine(`Stage ${this.expedition.currentStage} started`);
  }

  private createHUD(): void {
    const sw = this.scale.width;
    const stage = this.expedition.currentStage;
    const totalStages = this.expedition.totalStages;

    // Top-center: timer
    this.timerText = this.add.text(sw / 2, 10, '', {
      fontSize: '32px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#000000cc', padding: { x: 20, y: 8 },
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

    // Top-right: stage indicator
    this.stageText = this.add.text(sw - 10, 10, `STAGE ${stage}/${totalStages}`, {
      fontSize: '16px', color: '#ff8844', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 },
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(100);

    // Stage dots below
    for (let i = 1; i <= totalStages; i++) {
      const dotColor = i < stage ? '#666688' : i === stage ? '#ff8844' : '#333344';
      const dotChar = i <= stage ? '\u25CF' : '\u25CB'; // ● or ○
      this.add.text(sw - 10 - (totalStages - i) * 20, 40, dotChar, {
        fontSize: '14px', color: dotColor, fontFamily: 'monospace',
      }).setOrigin(1, 0).setScrollFactor(0).setDepth(100);
    }

    // Top-left: roomba stats
    const panelX = 10;
    const panelY = 10;

    this.add.text(panelX, panelY, 'ROOMBA', {
      fontSize: '12px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#000000aa', padding: { x: 6, y: 2 },
    }).setScrollFactor(0).setDepth(100);

    this.hpText = this.add.text(panelX, panelY + 20, '', {
      fontSize: '16px', color: '#44ff88', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 2 },
    }).setScrollFactor(0).setDepth(100);

    this.hpBar = this.add.graphics().setScrollFactor(0).setDepth(100);

    this.lootText = this.add.text(panelX, panelY + 60, '', {
      fontSize: '16px', color: '#ffdd44', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 2 },
    }).setScrollFactor(0).setDepth(100);

    this.totalLootText = this.add.text(panelX, panelY + 82, `Total: ${this.expedition.totalGoodiesCollected}`, {
      fontSize: '12px', color: '#aa9933', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 2 },
    }).setScrollFactor(0).setDepth(100);

    this.stateText = this.add.text(panelX, panelY + 102, '', {
      fontSize: '12px', color: '#aaaaaa', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 2 },
    }).setScrollFactor(0).setDepth(100);

    // Bottom-left: event log
    this.eventLog = this.add.text(10, this.scale.height - 150, '', {
      fontSize: '11px', color: '#aaaaaa', fontFamily: 'monospace',
      backgroundColor: '#00000088', padding: { x: 6, y: 4 },
      wordWrap: { width: 350 }, lineSpacing: 2,
    }).setScrollFactor(0).setDepth(100);
  }

  update(_time: number, delta: number): void {
    if (this.ended) return;

    const dt = delta / 1000;

    // Death animation
    if (this.deathAnimActive) {
      this.deathAnimTimer -= dt;
      this.fogRenderer.update();
      this.entityRenderer.render(
        this.world.roombas, this.world.turrets, this.world.goodies,
        this.world.projectiles, (tx, ty) => this.fogSystem.isRevealed(tx, ty),
      );
      this.updateHUD();
      if (this.deathAnimTimer <= 0) {
        this.endStage(false, false);
      }
      return;
    }

    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.endStage(false, false);
      return;
    }

    // Fixed timestep simulation
    this.tickAccumulator += delta;
    const tickMs = BALANCE.simulation.tickDuration;
    while (this.tickAccumulator >= tickMs) {
      this.tickAccumulator -= tickMs;
      this.simulationTick(tickMs / 1000);
    }

    // Check end conditions
    const aliveRoombas = this.world.getAliveRoombas();
    if (aliveRoombas.length === 0 && !this.deathAnimActive) {
      const extracted = this.world.roombas.filter(r => r.extracted);
      if (extracted.length > 0) {
        // Extracted successfully — bank goodies and end stage
        const goodiesThisRun = extracted.reduce((sum, r) => sum + r.inventory.length, 0);
        this.expedition.totalGoodiesCollected += goodiesThisRun;
        this.expedition.roombasExtracted++;
        this.addLogLine(`Extracted with ${goodiesThisRun} goodies!`);
        this.endStage(true, true);
      } else {
        // Roomba died — start death animation
        this.deathAnimActive = true;
        this.deathAnimTimer = 3;
        const deadRoomba = this.world.roombas[0];
        if (deadRoomba) deadRoomba.deathTimer = 3;
        this.expedition.roombasLost++;
        this.addLogLine('Roomba destroyed!');
      }
      return;
    }

    // Check extraction
    for (const roomba of aliveRoombas) {
      if (roomba.state === 'extracting') {
        const tileX = Math.floor(roomba.x / BALANCE.map.tileSize);
        const tileY = Math.floor(roomba.y / BALANCE.map.tileSize);
        const atExit = this.expedition.assignedExits.some(e => e.x === tileX && e.y === tileY);
        if (atExit && roomba.pathIndex >= roomba.path.length) {
          roomba.extracted = true;
          const exitPoint = this.expedition.assignedExits.find(e => e.x === tileX && e.y === tileY)!;
          this.world.emitEvent({
            type: 'roomba_extracted', roombaId: roomba.id, exitId: exitPoint.id,
            goodieCount: roomba.inventory.length, tick: this.world.tick,
          });
        }
      }
    }

    // Render
    this.fogRenderer.update();
    this.entityRenderer.render(
      this.world.roombas, this.world.turrets, this.world.goodies,
      this.world.projectiles, (tx, ty) => this.fogSystem.isRevealed(tx, ty),
    );

    this.updateHUD();

    while (this.world.events.length > 0) {
      const event = this.world.events.shift()!;
      this.processEvent(event);
    }
    this.eventLog.setText(this.logLines.slice(-8).join('\n'));
  }

  private updateHUD(): void {
    const mins = Math.floor(Math.max(0, this.timeRemaining) / 60);
    const secs = Math.floor(Math.max(0, this.timeRemaining) % 60);
    const timerColor = this.timeRemaining <= 30 ? '#ff4444' : '#ffffff';
    this.timerText.setText(`${mins}:${secs.toString().padStart(2, '0')}`);
    this.timerText.setColor(timerColor);

    const r = this.world.roombas[0];
    if (r && (r.alive || r.deathTimer > 0)) {
      const hp = Math.max(0, Math.ceil(r.hp));
      this.hpText.setText(`HP: ${hp} / ${r.maxHp}`);
      this.hpText.setColor(hp <= 3 ? '#ff4444' : hp <= 6 ? '#ffaa44' : '#44ff88');

      this.hpBar.clear();
      const ratio = Math.max(0, r.hp / r.maxHp);
      this.hpBar.fillStyle(0x333333, 0.8);
      this.hpBar.fillRect(16, 52, 140, 6);
      const barColor = ratio <= 0.3 ? 0xff4444 : ratio <= 0.6 ? 0xffaa44 : 0x44ff88;
      this.hpBar.fillStyle(barColor, 1);
      this.hpBar.fillRect(16, 52, 140 * ratio, 6);

      this.lootText.setText(`Loot: ${r.inventory.length} / ${r.inventorySlots}`);
      this.totalLootText.setText(`Total: ${this.expedition.totalGoodiesCollected}`);

      const stateLabel = STATE_LABELS[r.state] ?? r.state;
      this.stateText.setText(r.alive ? `State: ${stateLabel}` : 'State: Destroyed');
    } else {
      this.hpText.setText('HP: DEAD');
      this.hpText.setColor('#ff4444');
      this.hpBar.clear();
      this.lootText.setText('Loot: --');
      this.stateText.setText('State: Destroyed');
    }
  }

  private simulationTick(dt: number): void {
    this.world.tick++;
    this.behaviorSystem.update(this.world, dt);
    this.movementSystem.update(this.world, dt);

    for (const roomba of this.world.getAliveRoombas()) {
      const tileX = Math.floor(roomba.x / BALANCE.map.tileSize);
      const tileY = Math.floor(roomba.y / BALANCE.map.tileSize);
      const revealed = this.fogSystem.reveal(tileX, tileY, BALANCE.roomba.fogRevealRadius);
      if (revealed.length > 0) this.fogRenderer.markDirty();
    }

    this.combatSystem.update(this.world, dt);
    this.inventorySystem.update(this.world, dt);
  }

  private processEvent(event: import('@shared/types/game-state.ts').GameEvent): void {
    switch (event.type) {
      case 'roomba_damaged':
        this.addLogLine(`Roomba hit! -${event.damage} HP (${Math.max(0, Math.ceil(event.hpRemaining))} left)`);
        break;
      case 'turret_damaged':
        this.addLogLine(`Turret hit! -${event.damage} HP (${Math.max(0, Math.ceil(event.hpRemaining))} left)`);
        break;
      case 'turret_destroyed':
        this.addLogLine('Turret destroyed! Goodie dropped.');
        break;
      case 'goodie_collected':
        this.addLogLine('Goodie collected!');
        break;
      case 'node_reached':
        this.addLogLine(`Reached node #${event.nodeId + 1}`);
        break;
      case 'roomba_extracted':
        this.addLogLine(`Extracted with ${event.goodieCount} goodies!`);
        break;
    }
  }

  private addLogLine(msg: string): void {
    this.logLines.push(msg);
    if (this.logLines.length > 20) this.logLines.shift();
  }

  private endStage(roombaExtracted: boolean, _success: boolean): void {
    if (this.ended) return;
    this.ended = true;

    this.expedition.fogGrid = this.fogSystem.getGrid();

    const ts = BALANCE.map.tileSize;

    // Drop goodies from dead (non-extracted) roombas onto the ground
    for (const roomba of this.world.roombas) {
      if (!roomba.alive && !roomba.extracted && roomba.inventory.length > 0) {
        const dropTileX = Math.floor(roomba.x / ts);
        const dropTileY = Math.floor(roomba.y / ts);
        for (let i = 0; i < roomba.inventory.length; i++) {
          // Scatter goodies near death position
          const ox = i % 3 - 1;
          const oy = Math.floor(i / 3) - 1;
          const gx = dropTileX + ox;
          const gy = dropTileY + oy;
          this.expedition.droppedGoodies.push({ x: gx, y: gy });
          // Mark as discovered so they show on the planning map
          this.expedition.discoveredGoodies[`${gx},${gy}`] = true;
        }
        roomba.inventory = [];
      }
    }

    // Record killed turrets, collected goodies, discoveries
    for (const turret of this.world.turrets) {
      const tileX = Math.floor(turret.x / ts);
      const tileY = Math.floor(turret.y / ts);
      const key = `${tileX},${tileY}`;
      if (this.fogSystem.isRevealed(tileX, tileY)) {
        this.expedition.discoveredTurrets[key] = true;
      }
      if (!turret.alive) {
        this.expedition.killedTurrets[key] = true;
      }
    }

    for (const goodie of this.world.goodies) {
      const tileX = Math.floor(goodie.x / ts);
      const tileY = Math.floor(goodie.y / ts);
      const key = `${tileX},${tileY}`;
      if (this.fogSystem.isRevealed(tileX, tileY)) {
        this.expedition.discoveredGoodies[key] = true;
      }
      if (goodie.collected) {
        this.expedition.collectedGoodies[key] = true;
      }
    }

    const stage = this.expedition.currentStage;
    const totalStages = this.expedition.totalStages;

    if (stage < totalStages) {
      this.expedition.currentStage++;
      ExpeditionStore.set(this.expedition);
      this.scene.start('PlanningScene');
    } else {
      ExpeditionStore.clear();
      this.scene.start('ResultsScene', {
        totalGoodiesCollected: this.expedition.totalGoodiesCollected,
        roombasExtracted: this.expedition.roombasExtracted,
        roombasLost: this.expedition.roombasLost,
        stagesCompleted: totalStages,
      });
    }
  }
}

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle', moving: 'Moving', searching: 'Searching',
  attacking: 'Attacking', avoiding: 'Evading', rushing: 'Rushing',
  ambushing: 'Ambushing', extracting: 'Extracting', picking_up: 'Picking Up',
};
