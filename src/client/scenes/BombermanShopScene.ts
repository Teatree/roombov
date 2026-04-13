import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { BombermanShopStore, ProfileStore } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import type { BombermanTemplate } from '@shared/types/bomberman.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';

const CARD_WIDTH = 180;
const CARD_HEIGHT = 400;
const CARD_GAP = 20;

/**
 * Bomberman Shop carousel — shows the current 10-minute cycle of 5
 * Bombermen (2 free, 2 paid, 1 expensive) and lets the player buy them.
 * Owned Bombermen show an [EQUIP] button instead.
 */
export class BombermanShopScene extends Phaser.Scene {
  private cardContainers: Phaser.GameObjects.Container[] = [];
  private coinsText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private rosterText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private unsubShop: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;

  constructor() {
    super({ key: 'BombermanShopScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
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

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));

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
    });
    this.unsubShop = BombermanShopStore.subscribe(() => this.rebuildCards());

    // Consistent Bomberman selector at the bottom (same component as Bombs Shop / Lobby)
    this.selector = new BombermanSelector(this, height - 130);
    this.selector.create();

    this.renderHeader();
    this.rebuildCards();
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
    this.cardContainers = [];
    this.selector?.destroy();
    this.selector = null;
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
    const cardY = 310;

    for (let i = 0; i < count; i++) {
      const container = this.createCard(startX + i * (CARD_WIDTH + CARD_GAP), cardY, cycle.bombermen[i]);
      this.cardContainers.push(container);
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

    // Name
    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 30, template.name, {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Character — animated sprite playing walk-down cycle, tinted with the
    // template's vivid tint. Scale tuned to fit the 180x320 card.
    const charSprite = createShopBombermanSprite(this, 0, -30, template.tint, 1.1);
    container.add(charSprite);

    // Bomb loadout summary with icons
    const loadoutStartY = 55;
    for (let si = 0; si < template.inventory.slots.length; si++) {
      const slot = template.inventory.slots[si];
      const rowY = loadoutStartY + si * 18;
      if (!slot) {
        container.add(this.add.text(0, rowY, '- empty', {
          fontSize: '10px', color: '#666', fontFamily: 'monospace',
        }).setOrigin(0.5));
      } else {
        const name = BOMB_CATALOG[slot.type].name;
        const slotIcon = this.add.image(-40, rowY, 'bomb_icons', bombIconFrame(slot.type))
          .setDisplaySize(14, 14);
        container.add(slotIcon);
        container.add(this.add.text(-28, rowY, `${name} x${slot.count}`, {
          fontSize: '10px', color: '#cccccc', fontFamily: 'monospace',
        }).setOrigin(0, 0.5));
      }
    }

    // Price
    const priceLabel = template.price === 0 ? 'FREE' : `${template.price} coins`;
    container.add(this.add.text(0, CARD_HEIGHT / 2 - 42, priceLabel, {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Buy button — if the player already owns a Bomberman purchased from this
    // exact template (within the current cycle), show OWNED instead of BUY.
    const alreadyOwned = profile?.ownedBombermen.some(b => b.sourceTemplateId === template.id) ?? false;
    const canAfford = profile ? profile.coins >= template.price : false;
    const rosterFull = profile ? profile.ownedBombermen.length >= 5 : true;

    if (alreadyOwned) {
      container.add(this.add.text(0, CARD_HEIGHT / 2 - 18, 'OWNED', {
        fontSize: '14px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#113322', padding: { x: 12, y: 6 },
      }).setOrigin(0.5));
    } else {
      const enabled = canAfford && !rosterFull;
      const btnColor = enabled ? '#44aaff' : '#555566';
      const btn = this.add.text(0, CARD_HEIGHT / 2 - 18, '[ BUY ]', {
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
