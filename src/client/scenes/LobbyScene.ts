import Phaser from 'phaser';
import { ExpeditionScheduler, generateExpeditionEntities } from '@shared/ExpeditionManager.ts';
import { ExpeditionStore } from '@shared/ExpeditionStore.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { BALANCE } from '@shared/config/balance.ts';
import type { ExpeditionConfig, ExpeditionListing } from '@shared/types/expedition.ts';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 320;
const CARD_GAP = 24;

export class LobbyScene extends Phaser.Scene {
  private scheduler!: ExpeditionScheduler;
  private joinedExpeditionId: string | null = null;
  private cardContainers: Phaser.GameObjects.Container[] = [];
  private transitioning = false;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create(): void {
    ExpeditionStore.clearAll();
    this.scheduler = new ExpeditionScheduler();
    this.joinedExpeditionId = null;
    this.transitioning = false;
    this.cardContainers = [];

    const { width, height } = this.scale;

    // Title
    this.add.text(width / 2, 40, 'ROOMBOV', {
      fontSize: '48px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, 90, 'Choose an Expedition', {
      fontSize: '18px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Render initial cards
    this.rebuildCards();
  }

  update(_time: number, _delta: number): void {
    if (this.transitioning) return;

    const started = this.scheduler.tick();

    // Update card contents
    const listings = this.scheduler.getListings();
    for (let i = 0; i < this.cardContainers.length && i < listings.length; i++) {
      this.updateCardContent(this.cardContainers[i], listings[i]);
    }

    // An expedition started
    if (started) {
      if (this.joinedExpeditionId === started.id) {
        this.launchExpedition(started);
      } else {
        // Rebuild cards (the departed one is gone, a new one appeared)
        this.rebuildCards();
      }
    }

    // Check if joined expedition timer ran out (backup check)
    if (this.joinedExpeditionId) {
      const joined = listings.find(l => l.config.id === this.joinedExpeditionId);
      if (joined && joined.countdown <= 0) {
        this.launchExpedition(joined.config);
      }
    }
  }

  private rebuildCards(): void {
    // Destroy old cards
    for (const c of this.cardContainers) c.destroy();
    this.cardContainers = [];

    const listings = this.scheduler.getListings();
    const { width, height } = this.scale;
    const totalWidth = listings.length * CARD_WIDTH + (listings.length - 1) * CARD_GAP;
    const startX = (width - totalWidth) / 2 + CARD_WIDTH / 2;
    const cardY = height / 2 + 20;

    for (let i = 0; i < listings.length; i++) {
      const x = startX + i * (CARD_WIDTH + CARD_GAP);
      const container = this.createCard(x, cardY, listings[i]);
      this.cardContainers.push(container);
    }
  }

  private createCard(x: number, y: number, listing: ExpeditionListing): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const cfg = listing.config;
    const isJoined = this.joinedExpeditionId === cfg.id;

    // Card background
    const bg = this.add.graphics();
    const borderColor = isJoined ? 0x44ff88 : 0x333355;
    bg.fillStyle(0x1a1a2e, 0.95);
    bg.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    bg.lineStyle(2, borderColor, 1);
    bg.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    container.add(bg);

    // Map name
    const nameText = this.add.text(0, -CARD_HEIGHT / 2 + 20, cfg.mapName, {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(nameText);

    // Risk stars
    const riskLabel = this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 50, `Risk:   ${stars(cfg.risk)}`, {
      fontSize: '14px', color: '#ff6644', fontFamily: 'monospace',
    });
    container.add(riskLabel);

    // Reward stars
    const rewardLabel = this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 74, `Reward: ${stars(cfg.reward)}`, {
      fontSize: '14px', color: '#ffdd44', fontFamily: 'monospace',
    });
    container.add(rewardLabel);

    // Stages
    const stagesLabel = this.add.text(-CARD_WIDTH / 2 + 16, -CARD_HEIGHT / 2 + 98, `Stages: ${cfg.stages}`, {
      fontSize: '14px', color: '#88ccff', fontFamily: 'monospace',
    });
    container.add(stagesLabel);

    // Players
    const playersText = this.add.text(0, -CARD_HEIGHT / 2 + 132, `Players: ${listing.playerCount}/${cfg.maxPlayers}`, {
      fontSize: '13px', color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0.5);
    container.add(playersText);
    container.setData('playersText', playersText);

    // Countdown
    const countdownText = this.add.text(0, -CARD_HEIGHT / 2 + 170, '', {
      fontSize: '28px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(countdownText);
    container.setData('countdownText', countdownText);

    // Join / Waiting button
    if (isJoined) {
      const waitText = this.add.text(0, CARD_HEIGHT / 2 - 40, 'JOINED - WAITING...', {
        fontSize: '13px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      container.add(waitText);
    } else if (this.joinedExpeditionId === null) {
      const joinBtn = this.add.text(0, CARD_HEIGHT / 2 - 40, '[ JOIN ]', {
        fontSize: '18px', color: '#44aaff', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#222244',
        padding: { x: 24, y: 8 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });

      joinBtn.on('pointerover', () => joinBtn.setColor('#88ccff'));
      joinBtn.on('pointerout', () => joinBtn.setColor('#44aaff'));
      joinBtn.on('pointerdown', () => {
        this.joinExpedition(cfg.id);
      });
      container.add(joinBtn);
    }

    container.setData('configId', cfg.id);
    return container;
  }

  private updateCardContent(container: Phaser.GameObjects.Container, listing: ExpeditionListing): void {
    const countdownText = container.getData('countdownText') as Phaser.GameObjects.Text;
    const playersText = container.getData('playersText') as Phaser.GameObjects.Text;
    if (!countdownText || !playersText) return;

    const secs = Math.ceil(listing.countdown);
    countdownText.setText(`${secs}s`);

    if (secs <= 5) {
      countdownText.setColor('#ff4444');
    } else if (secs <= 15) {
      countdownText.setColor('#ffcc44');
    } else {
      countdownText.setColor('#ffffff');
    }

    playersText.setText(`Players: ${listing.playerCount}/${listing.config.maxPlayers}`);
  }

  private joinExpedition(expeditionId: string): void {
    const config = this.scheduler.joinExpedition(expeditionId);
    if (!config) return;
    this.joinedExpeditionId = expeditionId;
    this.rebuildCards();
  }

  private async launchExpedition(config: ExpeditionConfig): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;

    // Show loading text
    const { width, height } = this.scale;
    const loadingText = this.add.text(width / 2, height - 40, 'Loading map...', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5);

    try {
      // Async map load
      const mapData = await loadMapById(config.mapId);

      // Pick random spawn
      const spawnIndex = Math.floor(Math.random() * mapData.spawns.length);
      const assignedSpawnId = mapData.spawns[spawnIndex].id;

      // Deterministic entity placement from seed
      const { turretPositions, goodiePositions } = generateExpeditionEntities(config, mapData, assignedSpawnId);

      // Pick initial exits
      const shuffledExits = [...mapData.exits].sort(() => Math.random() - 0.5);
      const assignedExits = shuffledExits.slice(0, 3);

      // Create expedition data and store it
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
