import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { generateExpeditionEntities } from '@shared/ExpeditionManager.ts';
import { ExpeditionStore } from '@shared/ExpeditionStore.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { BALANCE } from '@shared/config/balance.ts';
import type { ExpeditionConfig, ExpeditionListing } from '@shared/types/expedition.ts';
import type { JoinedMsg, StageResultMsg } from '@shared/types/messages.ts';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 320;
const CARD_GAP = 24;

export class LobbyScene extends Phaser.Scene {
  private listings: ExpeditionListing[] = [];
  private joinedExpeditionId: string | null = null;
  private joinedConfig: ExpeditionConfig | null = null;
  private joinedSpawnId = 0;
  private joinedExitIndices: number[] = [];
  private cardContainers: Phaser.GameObjects.Container[] = [];
  private transitioning = false;
  private connectionText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create(): void {
    ExpeditionStore.clearAll();
    this.joinedExpeditionId = null;
    this.joinedConfig = null;
    this.transitioning = false;
    this.cardContainers = [];
    this.listings = [];

    const { width, height } = this.scale;

    this.add.text(width / 2, 40, 'ROOMBOV', {
      fontSize: '48px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, 90, 'Choose an Expedition', {
      fontSize: '18px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.connectionText = this.add.text(width / 2, height - 20, 'Connecting...', {
      fontSize: '12px', color: '#666666', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Connect to server
    const socket = NetworkManager.connect();

    // Receive expedition listings from server
    socket.on('listings', (listings) => {
      this.listings = listings;
      this.rebuildCards();
    });

    // Server confirmed our join
    socket.on('joined', (msg: JoinedMsg) => {
      this.joinedExpeditionId = msg.expeditionId;
      this.joinedSpawnId = msg.spawnId;
      this.joinedExitIndices = msg.assignedExitIndices;
      // Find the config from current listings
      const listing = this.listings.find(l => l.config.id === msg.expeditionId);
      if (listing) this.joinedConfig = listing.config;
      this.rebuildCards();
    });

    // Server says expedition is starting
    socket.on('expedition_start', (msg) => {
      if (this.joinedExpeditionId === msg.configId && this.joinedConfig) {
        this.launchExpedition(this.joinedConfig);
      }
    });

    socket.on('connect', () => {
      this.connectionText.setText(`Connected: ${socket.id}`);
      this.connectionText.setColor('#44ff88');
    });

    socket.on('disconnect', () => {
      this.connectionText.setText('Disconnected — reconnecting...');
      this.connectionText.setColor('#ff4444');
    });
  }

  shutdown(): void {
    // Remove listeners when leaving this scene to avoid duplicates
    const socket = NetworkManager.getSocket();
    socket.off('listings');
    socket.off('joined');
    socket.off('expedition_start');
  }

  update(): void {
    // Cards are rebuilt reactively when `listings` event fires
  }

  private rebuildCards(): void {
    for (const c of this.cardContainers) c.destroy();
    this.cardContainers = [];

    const { width, height } = this.scale;
    const count = this.listings.length;
    if (count === 0) return;

    const totalWidth = count * CARD_WIDTH + (count - 1) * CARD_GAP;
    const startX = (width - totalWidth) / 2 + CARD_WIDTH / 2;
    const cardY = height / 2 + 20;

    for (let i = 0; i < count; i++) {
      const x = startX + i * (CARD_WIDTH + CARD_GAP);
      const container = this.createCard(x, cardY, this.listings[i]);
      this.cardContainers.push(container);
    }
  }

  private createCard(x: number, y: number, listing: ExpeditionListing): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const cfg = listing.config;
    const isJoined = this.joinedExpeditionId === cfg.id;

    const bg = this.add.graphics();
    const borderColor = isJoined ? 0x44ff88 : 0x333355;
    bg.fillStyle(0x1a1a2e, 0.95);
    bg.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    bg.lineStyle(2, borderColor, 1);
    bg.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    container.add(bg);

    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 20, cfg.mapName, {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.add(this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 50, `Risk:   ${stars(cfg.risk)}`, {
      fontSize: '14px', color: '#ff6644', fontFamily: 'monospace',
    }));

    container.add(this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 74, `Reward: ${stars(cfg.reward)}`, {
      fontSize: '14px', color: '#ffdd44', fontFamily: 'monospace',
    }));

    container.add(this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 98, `Stages: ${cfg.stages}`, {
      fontSize: '14px', color: '#88ccff', fontFamily: 'monospace',
    }));

    const playersText = this.add.text(0, -CARD_HEIGHT / 2 + 132, `Players: ${listing.playerCount}/${cfg.maxPlayers}`, {
      fontSize: '13px', color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0.5);
    container.add(playersText);

    const secs = Math.ceil(listing.countdown);
    const countdownColor = secs <= 5 ? '#ff4444' : secs <= 15 ? '#ffcc44' : '#ffffff';
    const countdownText = this.add.text(0, -CARD_HEIGHT / 2 + 170, `${secs}s`, {
      fontSize: '28px', color: countdownColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(countdownText);

    if (isJoined) {
      container.add(this.add.text(0, CARD_HEIGHT / 2 - 40, 'JOINED - WAITING...', {
        fontSize: '13px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
    } else if (this.joinedExpeditionId === null) {
      const joinBtn = this.add.text(0, CARD_HEIGHT / 2 - 40, '[ JOIN ]', {
        fontSize: '18px', color: '#44aaff', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#222244', padding: { x: 24, y: 8 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });

      joinBtn.on('pointerover', () => joinBtn.setColor('#88ccff'));
      joinBtn.on('pointerout', () => joinBtn.setColor('#44aaff'));
      joinBtn.on('pointerdown', () => {
        NetworkManager.getSocket().emit('join', { expeditionId: cfg.id });
      });
      container.add(joinBtn);
    }

    return container;
  }

  private async launchExpedition(config: ExpeditionConfig): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;

    const { width, height } = this.scale;
    const loadingText = this.add.text(width / 2, height - 60, 'Loading map...', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5);

    try {
      const mapData = await loadMapById(config.mapId);

      // Use server-assigned spawn (clamped to available spawns)
      const assignedSpawnId = mapData.spawns[this.joinedSpawnId % mapData.spawns.length].id;

      // Deterministic entity placement from seed
      const { turretPositions, goodiePositions } = generateExpeditionEntities(config, mapData, assignedSpawnId);

      // Resolve exit indices to actual ExitPoints
      const assignedExits = this.joinedExitIndices.map(idx => mapData.exits[idx % mapData.exits.length]);

      const expeditionData = {
        configId: config.id,
        totalStages: config.stages,
        mapData,
        assignedSpawnId,
        currentStage: 1,
        totalGoodiesCollected: 0,
        roombasLost: 0,
        roombasExtracted: 0,
        fogGrid: null,
        assignedExits,
        turretPositions,
        goodiePositions,
        droppedGoodies: [],
        killedTurrets: {} as Record<string, boolean>,
        collectedGoodies: {} as Record<string, boolean>,
        discoveredTurrets: {} as Record<string, boolean>,
        discoveredGoodies: {} as Record<string, boolean>,
      };

      ExpeditionStore.set(expeditionData);
      ExpeditionStore.setActive(config.id);

      this.scene.start('PlanningScene');
    } catch (err) {
      loadingText.setText(`Error: ${err}`);
      this.transitioning = false;
    }
  }
}

function stars(count: number, max = 5): string {
  return '\u2605'.repeat(count) + '\u2606'.repeat(max - count);
}
