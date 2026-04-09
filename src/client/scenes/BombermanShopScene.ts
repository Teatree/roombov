import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { BombermanShopStore, ProfileStore } from '../ClientState.ts';
import { drawBomberman } from '../systems/BombermanRenderer.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import type { BombermanTemplate } from '@shared/types/bomberman.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';

const CARD_WIDTH = 180;
const CARD_HEIGHT = 320;
const CARD_GAP = 20;
const OWNED_CARD_WIDTH = 120;
const OWNED_CARD_HEIGHT = 140;
const OWNED_CARD_GAP = 14;

/**
 * Bomberman Shop carousel — shows the current 10-minute cycle of 5
 * Bombermen (2 free, 2 paid, 1 expensive) and lets the player buy them.
 * Owned Bombermen show an [EQUIP] button instead.
 */
export class BombermanShopScene extends Phaser.Scene {
  private cardContainers: Phaser.GameObjects.Container[] = [];
  private ownedContainers: Phaser.GameObjects.Container[] = [];
  private coinsText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private rosterText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private unsubShop: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;

  constructor() {
    super({ key: 'BombermanShopScene' });
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    const { width, height } = this.scale;

    this.add.text(width / 2, 40, 'BOMBERMAN SHOP', {
      fontSize: '32px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.coinsText = this.add.text(width - 20, 30, '', {
      fontSize: '20px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0);

    this.rosterText = this.add.text(20, 30, '', {
      fontSize: '14px', color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0, 0);

    this.timerText = this.add.text(width / 2, 80, 'New cycle in --:--', {
      fontSize: '14px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.toastText = this.add.text(width / 2, height - 60, '', {
      fontSize: '16px', color: '#44ff88', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Back button
    const backBtn = this.add.text(20, height - 30, '[ < BACK ]', {
      fontSize: '16px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#cccccc'));
    backBtn.on('pointerout', () => backBtn.setColor('#888888'));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    this.activity = new ActivityIndicator(this);

    const socket = NetworkManager.connect();
    NetworkManager.track('bomberman_shop_request', 'bomberman_shop_cycle');
    socket.emit('bomberman_shop_request');
    socket.on('shop_result', (msg) => {
      this.toastText.setColor(msg.ok ? '#44ff88' : '#ff4444');
      this.toastText.setText(msg.message ?? msg.reason ?? '');
      this.time.delayedCall(2500, () => this.toastText.setText(''));
    });

    this.unsubProfile = ProfileStore.subscribe(() => {
      this.renderHeader();
      this.rebuildCards();
      this.rebuildOwned();
    });
    this.unsubShop = BombermanShopStore.subscribe(() => this.rebuildCards());

    this.renderHeader();
    this.rebuildCards();
    this.rebuildOwned();
  }

  update(): void {
    const cycle = BombermanShopStore.get();
    if (!cycle) return;
    const msLeft = Math.max(0, cycle.endsAt - Date.now());
    const min = Math.floor(msLeft / 60000);
    const sec = Math.floor((msLeft % 60000) / 1000).toString().padStart(2, '0');
    this.timerText.setText(`New cycle in ${min}:${sec}`);

    // If cycle expired, auto-request the next one so we don't sit on stale data
    if (msLeft === 0) {
      NetworkManager.getSocket().emit('bomberman_shop_request');
    }
  }

  shutdown(): void {
    this.unsubProfile?.();
    this.unsubShop?.();
    this.unsubProfile = null;
    this.unsubShop = null;
    this.activity?.destroy();
    this.activity = null;
    for (const c of this.cardContainers) c.destroy();
    for (const c of this.ownedContainers) c.destroy();
    this.cardContainers = [];
    this.ownedContainers = [];
    const socket = NetworkManager.getSocket();
    socket.off('shop_result');
  }

  private renderHeader(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`Coins: ${profile.coins}`);
    this.rosterText.setText(`Roster: ${profile.ownedBombermen.length}/5`);
  }

  private rebuildCards(): void {
    for (const c of this.cardContainers) c.destroy();
    this.cardContainers = [];

    const cycle = BombermanShopStore.get();
    if (!cycle) return;

    const { width } = this.scale;
    const count = cycle.bombermen.length;
    const totalW = count * CARD_WIDTH + (count - 1) * CARD_GAP;
    const startX = (width - totalW) / 2 + CARD_WIDTH / 2;
    const cardY = 280;

    for (let i = 0; i < count; i++) {
      const container = this.createCard(startX + i * (CARD_WIDTH + CARD_GAP), cardY, cycle.bombermen[i]);
      this.cardContainers.push(container);
    }
  }

  private rebuildOwned(): void {
    for (const c of this.ownedContainers) c.destroy();
    this.ownedContainers = [];

    const profile = ProfileStore.get();
    if (!profile) return;

    const { width, height } = this.scale;
    const rosterY = height - 120;

    // Section label
    const label = this.add.container(0, 0);
    label.add(this.add.text(width / 2, rosterY - OWNED_CARD_HEIGHT / 2 - 24, 'YOUR ROSTER', {
      fontSize: '14px', color: '#aaaaaa', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));
    this.ownedContainers.push(label);

    if (profile.ownedBombermen.length === 0) {
      const empty = this.add.container(0, 0);
      empty.add(this.add.text(width / 2, rosterY, '(no Bombermen owned yet)', {
        fontSize: '12px', color: '#666', fontFamily: 'monospace',
      }).setOrigin(0.5));
      this.ownedContainers.push(empty);
      return;
    }

    const count = profile.ownedBombermen.length;
    const totalW = count * OWNED_CARD_WIDTH + (count - 1) * OWNED_CARD_GAP;
    const startX = (width - totalW) / 2 + OWNED_CARD_WIDTH / 2;

    for (let i = 0; i < count; i++) {
      const owned = profile.ownedBombermen[i];
      const isEquipped = owned.id === profile.equippedBombermanId;
      const x = startX + i * (OWNED_CARD_WIDTH + OWNED_CARD_GAP);
      const container = this.add.container(x, rosterY);

      const bg = this.add.graphics();
      bg.fillStyle(0x1a1a2e, 0.95);
      bg.fillRoundedRect(-OWNED_CARD_WIDTH / 2, -OWNED_CARD_HEIGHT / 2, OWNED_CARD_WIDTH, OWNED_CARD_HEIGHT, 8);
      bg.lineStyle(2, isEquipped ? 0x44ff88 : 0x333355, 1);
      bg.strokeRoundedRect(-OWNED_CARD_WIDTH / 2, -OWNED_CARD_HEIGHT / 2, OWNED_CARD_WIDTH, OWNED_CARD_HEIGHT, 8);
      container.add(bg);

      const charG = this.add.graphics();
      drawBomberman(charG, owned.colors, 0, -15, 60);
      container.add(charG);

      if (isEquipped) {
        container.add(this.add.text(0, OWNED_CARD_HEIGHT / 2 - 18, 'EQUIPPED', {
          fontSize: '11px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5));
      } else {
        const btn = this.add.text(0, OWNED_CARD_HEIGHT / 2 - 18, '[ EQUIP ]', {
          fontSize: '11px', color: '#44aaff', fontFamily: 'monospace', fontStyle: 'bold',
          backgroundColor: '#222244', padding: { x: 8, y: 4 },
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        btn.on('pointerover', () => btn.setColor('#88ccff'));
        btn.on('pointerout', () => btn.setColor('#44aaff'));
        btn.on('pointerdown', () => {
          NetworkManager.track('equip_bomberman', 'profile');
          NetworkManager.getSocket().emit('equip_bomberman', { ownedId: owned.id });
        });
        container.add(btn);
      }

      this.ownedContainers.push(container);
    }
  }

  private createCard(x: number, y: number, template: BombermanTemplate): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const profile = ProfileStore.get();

    // Background tint hints tier
    const tierColor = template.tier === 'free' ? 0x224422
      : template.tier === 'paid' ? 0x222244
      : 0x442233;

    const bg = this.add.graphics();
    bg.fillStyle(tierColor, 0.9);
    bg.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 10);
    bg.lineStyle(2, 0x555577, 1);
    bg.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 10);
    container.add(bg);

    // Tier badge
    const tierLabel = template.tier === 'free' ? 'FREE'
      : template.tier === 'paid' ? 'PAID'
      : 'EXPENSIVE';
    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 14, tierLabel, {
      fontSize: '12px', color: '#bbbbbb', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Character
    const charG = this.add.graphics();
    drawBomberman(charG, template.colors, 0, -40, 90);
    container.add(charG);

    // Bomb loadout summary
    const slotLines: string[] = [];
    for (const slot of template.inventory.slots) {
      if (!slot) { slotLines.push('- empty'); continue; }
      const name = BOMB_CATALOG[slot.type].name;
      slotLines.push(`- ${name} x${slot.count}`);
    }
    container.add(this.add.text(0, 60, slotLines.join('\n'), {
      fontSize: '10px', color: '#cccccc', fontFamily: 'monospace', align: 'center', lineSpacing: 2,
    }).setOrigin(0.5));

    // Price
    const priceLabel = template.price === 0 ? 'FREE' : `${template.price} coins`;
    container.add(this.add.text(0, CARD_HEIGHT / 2 - 62, priceLabel, {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Buy button — if the player already owns a Bomberman purchased from this
    // exact template (within the current cycle), show OWNED instead of BUY.
    const alreadyOwned = profile?.ownedBombermen.some(b => b.sourceTemplateId === template.id) ?? false;
    const canAfford = profile ? profile.coins >= template.price : false;
    const rosterFull = profile ? profile.ownedBombermen.length >= 5 : true;

    if (alreadyOwned) {
      container.add(this.add.text(0, CARD_HEIGHT / 2 - 28, 'OWNED', {
        fontSize: '14px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#113322', padding: { x: 12, y: 6 },
      }).setOrigin(0.5));
    } else {
      const enabled = canAfford && !rosterFull;
      const btnColor = enabled ? '#44aaff' : '#555566';
      const btn = this.add.text(0, CARD_HEIGHT / 2 - 28, '[ BUY ]', {
        fontSize: '14px', color: btnColor, fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#111122', padding: { x: 12, y: 6 },
      }).setOrigin(0.5);

      if (enabled) {
        btn.setInteractive({ useHandCursor: true });
        btn.on('pointerover', () => btn.setColor('#88ccff'));
        btn.on('pointerout', () => btn.setColor('#44aaff'));
        btn.on('pointerdown', () => {
          NetworkManager.track('buy_bomberman', 'profile');
          NetworkManager.getSocket().emit('buy_bomberman', { templateId: template.id });
        });
      }
      container.add(btn);
    }

    return container;
  }
}
