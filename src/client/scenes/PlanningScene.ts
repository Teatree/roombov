import Phaser from 'phaser';
import { MapRenderer } from '../systems/MapRenderer.ts';
import { CameraController } from '../systems/CameraController.ts';
import { FogOfWarRenderer } from '../systems/FogOfWarRenderer.ts';
import { FogOfWarSystem } from '@shared/systems/FogOfWarSystem.ts';
import { ExpeditionStore } from '@shared/ExpeditionStore.ts';
import { BALANCE } from '@shared/config/balance.ts';
import type { MapData, ExitPoint } from '@shared/types/map.ts';
import type { BehaviorNode } from '@shared/types/nodes.ts';
import type { ExpeditionData } from '@shared/types/expedition.ts';
import { NodeType } from '@shared/types/nodes.ts';

const UI_PANEL_WIDTH = 220;
const ASSIGNED_EXIT_COUNT = 3;

export class PlanningScene extends Phaser.Scene {
  private mapRenderer!: MapRenderer;
  private cameraController!: CameraController;
  private fogRenderer!: FogOfWarRenderer;
  private fogSystem!: FogOfWarSystem;
  private mapData!: MapData;

  private expedition!: ExpeditionData;
  private nodes: BehaviorNode[] = [];
  private selectedNodeType: NodeType = NodeType.MOVE_SEARCH;
  private nodeGraphics!: Phaser.GameObjects.Graphics;

  private prepTimer = BALANCE.expedition.prepTimeSeconds;
  private prepTimerText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private hudText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'PlanningScene' });
  }

  create(): void {
    this.nodes = [];
    this.selectedNodeType = NodeType.MOVE_SEARCH;
    this.prepTimer = BALANCE.expedition.prepTimeSeconds;

    // Expedition MUST exist in the store (created by LobbyScene)
    const existing = ExpeditionStore.get();
    if (!existing) {
      this.scene.start('LobbyScene');
      return;
    }
    this.expedition = existing;
    this.mapData = this.expedition.mapData;

    // Re-roll exits for this stage
    this.expedition.assignedExits = this.pickRandomExits(this.mapData.exits, ASSIGNED_EXIT_COUNT);

    // Render map
    this.mapRenderer = new MapRenderer(this, this.mapData);
    this.mapRenderer.renderSpawn(this, this.expedition.assignedSpawnId);
    this.mapRenderer.renderAssignedExits(this, this.expedition.assignedExits);

    // Fog of war — carry over from previous stage or start fresh
    this.fogSystem = new FogOfWarSystem(this.mapData.width, this.mapData.height);
    if (this.expedition.fogGrid) {
      this.fogSystem.setGrid(this.expedition.fogGrid);
    }
    this.fogRenderer = new FogOfWarRenderer(this, this.mapData, this.fogSystem);

    const spawn = this.mapData.spawns.find(s => s.id === this.expedition.assignedSpawnId)!;
    this.fogSystem.reveal(spawn.x, spawn.y, BALANCE.roomba.fogRevealRadius);

    for (const exit of this.expedition.assignedExits) {
      this.fogSystem.reveal(exit.x, exit.y, 2);
    }
    this.fogRenderer.markDirty();
    this.fogRenderer.update();

    this.renderDiscoveredItems();

    this.nodeGraphics = this.add.graphics();
    this.nodeGraphics.setDepth(20);

    const bounds = this.mapRenderer.getWorldBounds();
    this.cameraController = new CameraController(this, bounds.width, bounds.height);
    const ts = this.mapData.tileSize;
    this.cameras.main.centerOn((spawn.x + 0.5) * ts, (spawn.y + 0.5) * ts);

    this.createUI();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.handleLeftClick(pointer);
      }
    });

    const nodeTypes = Object.values(NodeType);
    this.input.keyboard!.on('keydown', (event: KeyboardEvent) => {
      const idx = parseInt(event.key) - 1;
      if (idx >= 0 && idx < nodeTypes.length) {
        this.selectedNodeType = nodeTypes[idx];
        this.refreshNodeTypeButtons();
      }
    });
  }

  private renderDiscoveredItems(): void {
    const ts = this.mapData.tileSize;
    const g = this.add.graphics().setDepth(12);
    const exp = this.expedition;

    for (const key of Object.keys(exp.discoveredTurrets)) {
      const [tx, ty] = key.split(',').map(Number);
      const cx = (tx + 0.5) * ts;
      const cy = (ty + 0.5) * ts;

      if (exp.killedTurrets[key]) {
        const s = ts / 2.5;
        g.fillStyle(0x221111, 0.6);
        g.fillCircle(cx, cy, s * 1.2);
        g.fillStyle(0x442222, 0.5);
        g.fillCircle(cx, cy, s * 0.7);
        g.lineStyle(1, 0x663333, 0.5);
        g.strokeCircle(cx, cy, s * 0.7);
        this.add.text(cx, cy, '\u2716', {
          fontSize: '12px', color: '#884444', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(13).setAlpha(0.7);
      } else {
        const s = ts / 2.5;
        g.fillStyle(0xcc3333, 0.15);
        g.fillCircle(cx, cy, BALANCE.turret.atkRad * ts);
        g.lineStyle(1, 0xff4444, 0.2);
        g.strokeCircle(cx, cy, BALANCE.turret.atkRad * ts);
        g.fillStyle(0x882222, 0.5);
        g.fillCircle(cx, cy, s);
        g.lineStyle(2, 0xcc3333, 0.6);
        g.strokeCircle(cx, cy, s);
        this.add.text(cx, cy, 'T', {
          fontSize: '12px', color: '#ff4444', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(13).setAlpha(0.6);
      }
    }

    for (const key of Object.keys(exp.discoveredGoodies)) {
      if (exp.collectedGoodies[key]) continue;
      const [tx, ty] = key.split(',').map(Number);
      const cx = (tx + 0.5) * ts;
      const cy = (ty + 0.5) * ts;
      const r = ts / 3;
      g.fillStyle(0xffdd44, 0.5);
      g.fillTriangle(cx, cy - r, cx + r * 0.7, cy, cx, cy + r);
      g.fillTriangle(cx, cy - r, cx - r * 0.7, cy, cx, cy + r);
      g.lineStyle(1.5, 0xffaa00, 0.5);
      g.lineBetween(cx, cy - r, cx + r * 0.7, cy);
      g.lineBetween(cx + r * 0.7, cy, cx, cy + r);
      g.lineBetween(cx, cy + r, cx - r * 0.7, cy);
      g.lineBetween(cx - r * 0.7, cy, cx, cy - r);
    }
  }

  private pickRandomExits(exits: ExitPoint[], count: number): ExitPoint[] {
    const shuffled = [...exits].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  update(_time: number, delta: number): void {
    this.prepTimer -= delta / 1000;
    if (this.prepTimer <= 0) {
      if (this.nodes.length === 0) {
        this.skipStage();
        return;
      }
      this.launchExecution();
      return;
    }

    const secs = Math.ceil(this.prepTimer);
    const urgentColor = secs <= 5 ? '#ff4444' : '#ffffff';
    this.prepTimerText.setText(`PREP TIME: ${secs}s`);
    this.prepTimerText.setColor(urgentColor);
  }

  private handleLeftClick(pointer: Phaser.Input.Pointer): void {
    if (pointer.x < UI_PANEL_WIDTH) return;

    const worldX = pointer.worldX;
    const worldY = pointer.worldY;
    const tileX = Math.floor(worldX / this.mapData.tileSize);
    const tileY = Math.floor(worldY / this.mapData.tileSize);

    if (tileX < 0 || tileX >= this.mapData.width || tileY < 0 || tileY >= this.mapData.height) return;
    if (this.nodes.length >= BALANCE.expedition.maxNodes) return;

    const tile = this.mapData.grid[tileY]?.[tileX];
    if (tile === undefined || tile === 1) return;

    const node: BehaviorNode = {
      id: this.nodes.length,
      type: this.selectedNodeType,
      x: tileX,
      y: tileY,
      order: this.nodes.length,
    };
    this.nodes.push(node);
    this.renderNodes();
    this.updateStatusText();
  }

  private renderNodes(): void {
    this.children.list
      .filter(c => c instanceof Phaser.GameObjects.Text && c.getData('nodeLabel'))
      .forEach(c => c.destroy());

    this.nodeGraphics.clear();
    const ts = this.mapData.tileSize;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const cx = node.x * ts + ts / 2;
      const cy = node.y * ts + ts / 2;
      const color = NODE_COLORS[node.type];
      const icon = NODE_ICONS[node.type];

      if (i === 0) {
        const spawn = this.mapData.spawns.find(s => s.id === this.expedition.assignedSpawnId)!;
        this.nodeGraphics.lineStyle(2, 0x44aaff, 0.5);
        this.nodeGraphics.lineBetween(spawn.x * ts + ts / 2, spawn.y * ts + ts / 2, cx, cy);
      } else {
        const prev = this.nodes[i - 1];
        this.nodeGraphics.lineStyle(2, color, 0.5);
        this.nodeGraphics.lineBetween(prev.x * ts + ts / 2, prev.y * ts + ts / 2, cx, cy);
      }

      this.drawNodeShape(this.nodeGraphics, cx, cy, ts, node.type, color);

      const label = this.add.text(cx, cy, `${i + 1}${icon}`, {
        fontSize: '11px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(21);
      label.setData('nodeLabel', true);
    }
  }

  private drawNodeShape(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ts: number, type: NodeType, color: number): void {
    const r = ts / 3;
    switch (type) {
      case NodeType.MOVE_SEARCH:
        g.fillStyle(color, 0.8); g.fillCircle(cx, cy, r);
        g.lineStyle(2, 0xffffff, 0.9); g.strokeCircle(cx, cy, r); break;
      case NodeType.MOVE_ATTACK:
        g.fillStyle(color, 0.8);
        g.fillTriangle(cx, cy - r, cx + r, cy, cx, cy + r);
        g.fillTriangle(cx, cy - r, cx - r, cy, cx, cy + r);
        g.lineStyle(2, 0xffffff, 0.9);
        g.lineBetween(cx, cy - r, cx + r, cy); g.lineBetween(cx + r, cy, cx, cy + r);
        g.lineBetween(cx, cy + r, cx - r, cy); g.lineBetween(cx - r, cy, cx, cy - r); break;
      case NodeType.MOVE_AVOID:
        g.fillStyle(color, 0.8); g.fillCircle(cx, cy, r);
        g.lineStyle(2, 0xffffff, 0.9); g.strokeCircle(cx, cy, r);
        g.lineStyle(1, 0xffffff, 0.4); g.strokeCircle(cx, cy, r * 0.6); break;
      case NodeType.MOVE_RUSH:
        g.fillStyle(color, 0.8); g.fillTriangle(cx - r, cy - r, cx + r, cy, cx - r, cy + r);
        g.lineStyle(2, 0xffffff, 0.9);
        g.lineBetween(cx - r, cy - r, cx + r, cy); g.lineBetween(cx + r, cy, cx - r, cy + r);
        g.lineBetween(cx - r, cy + r, cx - r, cy - r); break;
      case NodeType.STOP_SEARCH:
        g.fillStyle(color, 0.8); g.fillRect(cx - r, cy - r, r * 2, r * 2);
        g.lineStyle(2, 0xffffff, 0.9); g.strokeRect(cx - r, cy - r, r * 2, r * 2); break;
      case NodeType.STOP_AMBUSH:
        g.fillStyle(color, 0.8); g.fillCircle(cx, cy, r);
        g.lineStyle(2, 0xffffff, 0.9); g.strokeCircle(cx, cy, r);
        g.lineStyle(2, 0xffffff, 0.6);
        g.lineBetween(cx - r * 0.7, cy, cx + r * 0.7, cy);
        g.lineBetween(cx, cy - r * 0.7, cx, cy + r * 0.7); break;
    }
  }

  private createUI(): void {
    const totalStages = this.expedition.totalStages;
    const panelBg = this.add.graphics().setScrollFactor(0).setDepth(99);
    panelBg.fillStyle(0x111122, 0.92);
    panelBg.fillRect(0, 0, UI_PANEL_WIDTH, this.scale.height);

    this.prepTimerText = this.add.text(this.scale.width / 2, 12, '', {
      fontSize: '28px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#000000cc', padding: { x: 16, y: 8 },
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

    this.statusText = this.add.text(10, 10, '', {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100);
    this.updateStatusText();

    const totalLoot = this.expedition.totalGoodiesCollected;
    this.hudText = this.add.text(10, 35, `HP: ${BALANCE.roomba.hp}/${BALANCE.roomba.hp}  |  Total Loot: ${totalLoot}`, {
      fontSize: '13px', color: '#88ccff', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100);

    // Stage dots
    const stageY = 55;
    const stage = this.expedition.currentStage;
    for (let i = 1; i <= totalStages; i++) {
      const color = i === stage ? '#44ff88' : i < stage ? '#666688' : '#333344';
      const label = i === stage ? `[S${i}]` : `S${i}`;
      this.add.text(10 + (i - 1) * 40, stageY, label, {
        fontSize: '11px', color, fontFamily: 'monospace', fontStyle: i === stage ? 'bold' : 'normal',
      }).setScrollFactor(0).setDepth(100);
    }

    const nodeTypes = Object.values(NodeType);
    const startY = 80;
    nodeTypes.forEach((type, i) => {
      const label = `${i + 1} ${NODE_ICONS[type]} ${NODE_LABELS[type]}`;
      const color = NODE_COLORS[type];
      const btn = this.add.text(10, startY + i * 32, label, {
        fontSize: '13px',
        color: type === this.selectedNodeType ? '#ffffff' : '#888888',
        fontFamily: 'monospace',
        backgroundColor: type === this.selectedNodeType
          ? `#${color.toString(16).padStart(6, '0')}66` : '#222233',
        padding: { x: 6, y: 5 }, fixedWidth: UI_PANEL_WIDTH - 20,
      }).setScrollFactor(0).setDepth(100).setInteractive({ useHandCursor: true }).setData('nodeType', type);
      btn.on('pointerdown', () => {
        this.selectedNodeType = type;
        this.refreshNodeTypeButtons();
      });
    });

    const undoY = startY + nodeTypes.length * 32 + 8;
    const undoBtn = this.add.text(10, undoY, '[ UNDO ]', {
      fontSize: '13px', color: '#ff6666', fontFamily: 'monospace',
      backgroundColor: '#222233', padding: { x: 6, y: 4 },
    }).setScrollFactor(0).setDepth(100).setInteractive({ useHandCursor: true });
    undoBtn.on('pointerdown', () => {
      if (this.nodes.length > 0) { this.nodes.pop(); this.renderNodes(); this.updateStatusText(); }
    });

    const readyBtn = this.add.text(10, undoY + 35, '[ READY ]', {
      fontSize: '16px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#222233', padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(100).setInteractive({ useHandCursor: true });
    readyBtn.on('pointerdown', () => { this.launchExecution(); });

    const legendY = undoY + 80;
    this.add.text(10, legendY, '--- LEGEND ---', {
      fontSize: '11px', color: '#666688', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100);

    const legendItems = [
      { icon: 'S', color: '#44aaff', label: 'Your Spawn' },
      { icon: 'E', color: '#44ff88', label: 'Exit' },
      { icon: '\u25A0', color: '#cc3333', label: 'Enemy Turret' },
      { icon: '\u2B24', color: '#ffdd44', label: 'Goodie' },
      { icon: '\u2588', color: '#4a4a5e', label: 'Wall' },
      { icon: '\u2592', color: '#5a4a3e', label: 'Furniture' },
      { icon: '\u2591', color: '#3a5a4e', label: 'Door' },
    ];
    legendItems.forEach((item, i) => {
      this.add.text(10, legendY + 18 + i * 16, item.icon, {
        fontSize: '12px', color: item.color, fontFamily: 'monospace',
      }).setScrollFactor(0).setDepth(100);
      this.add.text(28, legendY + 18 + i * 16, item.label, {
        fontSize: '11px', color: '#aaaaaa', fontFamily: 'monospace',
      }).setScrollFactor(0).setDepth(100);
    });

    this.add.text(10, this.scale.height - 24, 'Click: place node | Right-drag: pan | Scroll: zoom', {
      fontSize: '10px', color: '#555566', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100);
  }

  private launchExecution(): void {
    if (this.nodes.length === 0) return;
    this.expedition.fogGrid = this.fogSystem.getGrid();
    ExpeditionStore.set(this.expedition);
    ExpeditionStore.setNodes(this.nodes);
    this.scene.start('ExecutionScene');
  }

  private skipStage(): void {
    this.expedition.fogGrid = this.fogSystem.getGrid();
    this.expedition.roombasLost++;
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

  private refreshNodeTypeButtons(): void {
    this.children.list
      .filter(c => c instanceof Phaser.GameObjects.Text && c.getData('nodeType'))
      .forEach(c => {
        const text = c as Phaser.GameObjects.Text;
        const type = text.getData('nodeType') as NodeType;
        const color = NODE_COLORS[type];
        if (type === this.selectedNodeType) {
          text.setColor('#ffffff');
          text.setBackgroundColor(`#${color.toString(16).padStart(6, '0')}66`);
        } else {
          text.setColor('#888888');
          text.setBackgroundColor('#222233');
        }
      });
  }

  private updateStatusText(): void {
    const stage = this.expedition.currentStage;
    const totalStages = this.expedition.totalStages;
    this.statusText.setText(`Stage ${stage}/${totalStages}  |  Nodes: ${this.nodes.length}/${BALANCE.expedition.maxNodes}`);
  }
}

const NODE_COLORS: Record<NodeType, number> = {
  [NodeType.MOVE_SEARCH]: 0xffcc44, [NodeType.MOVE_ATTACK]: 0xff4444,
  [NodeType.MOVE_AVOID]: 0x44ccff, [NodeType.MOVE_RUSH]: 0xff8844,
  [NodeType.STOP_SEARCH]: 0xaaff44, [NodeType.STOP_AMBUSH]: 0xcc44ff,
};
const NODE_LABELS: Record<NodeType, string> = {
  [NodeType.MOVE_SEARCH]: 'Move & Search', [NodeType.MOVE_ATTACK]: 'Move & Attack',
  [NodeType.MOVE_AVOID]: 'Move & Avoid', [NodeType.MOVE_RUSH]: 'Move & Rush',
  [NodeType.STOP_SEARCH]: 'Stop & Search', [NodeType.STOP_AMBUSH]: 'Stop & Ambush',
};
const NODE_ICONS: Record<NodeType, string> = {
  [NodeType.MOVE_SEARCH]: '\u25CB', [NodeType.MOVE_ATTACK]: '\u25C7',
  [NodeType.MOVE_AVOID]: '\u25CE', [NodeType.MOVE_RUSH]: '\u25B7',
  [NodeType.STOP_SEARCH]: '\u25A1', [NodeType.STOP_AMBUSH]: '\u2295',
};
