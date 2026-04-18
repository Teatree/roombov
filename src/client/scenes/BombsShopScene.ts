import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';
import type { BombType } from '@shared/types/bombs.ts';
import type { BombsCatalogEntry } from '@shared/types/messages.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';

/**
 * Bombs Shop scene.
 *
 * Three columns:
 *  - Catalog (left)    — buy bombs for coins; adds to stockpile
 *  - Stockpile (mid)   — bombs you own but have not equipped. Click one to
 *                         select; then click an equip slot to place it.
 *  - Equipped (right)  — the equipped Bomberman and its 4 custom slots
 *                         + the fixed infinite Rock slot. Click a slot to
 *                         either equip the selected stockpile bomb or
 *                         unequip its current contents.
 */
export class BombsShopScene extends Phaser.Scene {
  private catalog: BombsCatalogEntry[] = [];
  private selectedStockpile: BombType | null = null;
  private containers: Phaser.GameObjects.Container[] = [];
  private coinsText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;

  constructor() {
    super({ key: 'BombsShopScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { width, height } = this.scale;

    this.add.text(width / 2, 40, 'BOMBS SHOP', {
      fontSize: '32px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.coinsText = this.add.text(width - 20, 30, '', {
      fontSize: '20px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0);

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

    // Bomberman selector at the bottom — switch equipped Bomberman from here
    const { height: sceneH } = this.scale;
    this.selector = new BombermanSelector(this, sceneH - 130);
    this.selector.create();

    const socket = NetworkManager.connect();
    NetworkManager.track('bombs_shop_request', 'bombs_catalog');
    socket.emit('bombs_shop_request');
    socket.on('bombs_catalog', (msg) => {
      this.catalog = msg.catalog;
      this.rebuild();
    });
    socket.on('shop_result', (msg) => {
      this.toastText.setColor(msg.ok ? '#44ff88' : '#ff4444');
      this.toastText.setText(msg.message ?? msg.reason ?? '');
      this.time.delayedCall(2000, () => this.toastText.setText(''));
    });

    this.unsubProfile = ProfileStore.subscribe(() => {
      this.renderCoins();
      this.rebuild();
    });

    this.renderCoins();
    this.rebuild();
  }

  shutdown(): void {
    this.unsubProfile?.();
    this.unsubProfile = null;
    this.activity?.destroy();
    this.activity = null;
    this.selector?.destroy();
    this.selector = null;
    for (const c of this.containers) c.destroy();
    this.containers = [];
    const socket = NetworkManager.getSocket();
    socket.off('bombs_catalog');
    socket.off('shop_result');
  }

  private renderCoins(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`Coins: ${profile.coins}`);
  }

  private rebuild(): void {
    for (const c of this.containers) c.destroy();
    this.containers = [];

    const profile = ProfileStore.get();
    if (!profile || this.catalog.length === 0) return;

    const { width } = this.scale;
    const colWidth = Math.min(380, (width - 80) / 3);
    const col1X = 40;
    const col2X = col1X + colWidth + 20;
    const col3X = col2X + colWidth + 20;
    const topY = 100;

    // --- Column 1: Catalog ---
    const catalogCol = this.add.container(0, 0);
    catalogCol.add(this.add.text(col1X + colWidth / 2, topY, 'CATALOG', {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    for (let i = 0; i < this.catalog.length; i++) {
      const entry = this.catalog[i];
      const y = topY + 30 + i * 44;
      const canAfford = profile.coins >= entry.price;

      const rowBg = this.add.graphics();
      rowBg.fillStyle(0x1a1a2e, 0.8);
      rowBg.fillRoundedRect(col1X, y, colWidth, 38, 4);
      rowBg.lineStyle(1, 0x333355, 1);
      rowBg.strokeRoundedRect(col1X, y, colWidth, 38, 4);
      catalogCol.add(rowBg);

      const icon = this.add.image(col1X + 22, y + 19, 'bomb_icons', bombIconFrame(entry.type))
        .setDisplaySize(28, 28);
      catalogCol.add(icon);

      catalogCol.add(this.add.text(col1X + 42, y + 8, entry.name, {
        fontSize: '13px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }));
      catalogCol.add(this.add.text(col1X + 42, y + 22, entry.description, {
        fontSize: '9px', color: '#888888', fontFamily: 'monospace',
        wordWrap: { width: colWidth - 100 },
      }));

      const btn = this.add.text(col1X + colWidth - 10, y + 19, `${entry.price}c  BUY`, {
        fontSize: '11px', color: canAfford ? '#ffd944' : '#555566',
        fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#222244', padding: { x: 6, y: 3 },
      }).setOrigin(1, 0.5);
      if (canAfford) {
        btn.setInteractive({ useHandCursor: true });
        btn.on('pointerdown', () => {
          NetworkManager.track('buy_bomb', 'profile');
          NetworkManager.getSocket().emit('buy_bomb', { type: entry.type, quantity: 1 });
        });
      }
      catalogCol.add(btn);
    }
    this.containers.push(catalogCol);

    // --- Column 2: Stockpile ---
    const stockCol = this.add.container(0, 0);
    stockCol.add(this.add.text(col2X + colWidth / 2, topY, 'STOCKPILE', {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    const stockpile = profile.bombStockpile ?? {};
    const stockEntries = Object.entries(stockpile).filter(([, c]) => (c ?? 0) > 0) as [BombType, number][];
    console.log('[BombsShopScene] rebuild: coins=', profile.coins, 'stockpile=', stockpile, 'entries=', stockEntries.length);
    if (stockEntries.length === 0) {
      stockCol.add(this.add.text(col2X + colWidth / 2, topY + 60, '(empty — buy some bombs)', {
        fontSize: '12px', color: '#666', fontFamily: 'monospace',
      }).setOrigin(0.5));
    } else {
      for (let i = 0; i < stockEntries.length; i++) {
        const [type, count] = stockEntries[i];
        const entry = this.catalog.find(c => c.type === type);
        const name = entry?.name ?? type;
        const y = topY + 30 + i * 40;

        const isSelected = this.selectedStockpile === type;
        const bg = this.add.graphics();
        bg.fillStyle(isSelected ? 0x334477 : 0x1a1a2e, 0.9);
        bg.fillRoundedRect(col2X, y, colWidth, 34, 4);
        bg.lineStyle(isSelected ? 2 : 1, isSelected ? 0x44ff88 : 0x333355, 1);
        bg.strokeRoundedRect(col2X, y, colWidth, 34, 4);
        stockCol.add(bg);

        const sIcon = this.add.image(col2X + 22, y + 17, 'bomb_icons', bombIconFrame(type))
          .setDisplaySize(24, 24);
        stockCol.add(sIcon);
        const label = this.add.text(col2X + 40, y + 17, `${name}  x${count}`, {
          fontSize: '13px', color: '#ffffff', fontFamily: 'monospace',
        }).setOrigin(0, 0.5);
        stockCol.add(label);

        // The whole row is clickable to select
        const hit = this.add.zone(col2X, y, colWidth, 34).setOrigin(0, 0);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => {
          this.selectedStockpile = this.selectedStockpile === type ? null : type;
          this.rebuild();
        });
        stockCol.add(hit);
      }
    }

    if (this.selectedStockpile) {
      stockCol.add(this.add.text(col2X + colWidth / 2, topY + 30 + stockEntries.length * 40 + 16,
        'Click a slot to equip →', {
          fontSize: '11px', color: '#44ff88', fontFamily: 'monospace',
        }).setOrigin(0.5));
    }

    this.containers.push(stockCol);

    // --- Column 3: Equipped Bomberman + slots ---
    const eqCol = this.add.container(0, 0);
    eqCol.add(this.add.text(col3X + colWidth / 2, topY, 'EQUIPPED', {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (!equipped) {
      eqCol.add(this.add.text(col3X + colWidth / 2, topY + 80, 'No Bomberman equipped.\nBuy one first.', {
        fontSize: '12px', color: '#666', fontFamily: 'monospace', align: 'center',
      }).setOrigin(0.5));
    } else {
      // Equipped Bomberman preview. Character variant is persistent on the
      // owned Bomberman; animation is stable-until-match via UiAnimLock.
      const preview = createShopBombermanSprite(
        this, col3X + colWidth / 2, topY + 80,
        equipped.tint, equipped.character, UiAnimLock.get(equipped.id), 1,
      );
      eqCol.add(preview);

      // Slot rows: 4 custom slots + 1 fixed Rock slot
      const slotsStartY = topY + 150;
      const slotH = 44;

      for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
        const slot = equipped.inventory.slots[slotIdx];
        const y = slotsStartY + slotIdx * (slotH + 6);

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillRoundedRect(col3X, y, colWidth, slotH, 4);
        bg.lineStyle(1, 0x333355, 1);
        bg.strokeRoundedRect(col3X, y, colWidth, slotH, 4);
        eqCol.add(bg);

        if (slot) {
          const entry = this.catalog.find(c => c.type === slot.type);
          const name = entry?.name ?? slot.type;
          const eqIcon = this.add.image(col3X + 26, y + slotH / 2, 'bomb_icons', bombIconFrame(slot.type))
            .setDisplaySize(28, 28);
          eqCol.add(eqIcon);
          eqCol.add(this.add.text(col3X + 46, y + 10, `SLOT ${slotIdx + 1}: ${name}`, {
            fontSize: '12px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
          }));
          eqCol.add(this.add.text(col3X + 10, y + 26, `x${slot.count} / ${BALANCE.match.bombSlotStackLimit}`, {
            fontSize: '11px', color: '#888888', fontFamily: 'monospace',
          }));

          const unBtn = this.add.text(col3X + colWidth - 10, y + slotH / 2, '[ UNEQUIP ]', {
            fontSize: '10px', color: '#ff8844', fontFamily: 'monospace',
            backgroundColor: '#221a2e', padding: { x: 6, y: 3 },
          }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
          unBtn.on('pointerdown', () => {
            NetworkManager.track('unequip_bomb', 'profile');
            NetworkManager.getSocket().emit('unequip_bomb', { slotIndex: slotIdx });
          });
          eqCol.add(unBtn);
        } else {
          eqCol.add(this.add.text(col3X + 10, y + slotH / 2, `SLOT ${slotIdx + 1}: empty`, {
            fontSize: '12px', color: '#666', fontFamily: 'monospace',
          }).setOrigin(0, 0.5));
        }

        // Whole slot is clickable for equip when a stockpile bomb is selected
        if (this.selectedStockpile) {
          const selected = this.selectedStockpile;
          const hit = this.add.zone(col3X, y, colWidth, slotH).setOrigin(0, 0);
          hit.setInteractive({ useHandCursor: true });
          hit.on('pointerdown', () => {
            NetworkManager.track('equip_bomb', 'profile');
            NetworkManager.getSocket().emit('equip_bomb', {
              type: selected,
              slotIndex: slotIdx,
              quantity: BALANCE.match.bombSlotStackLimit,
            });
          });
          eqCol.add(hit);
        }
      }

      // Fixed Rock slot (slot 5)
      const rockY = slotsStartY + 4 * (slotH + 6);
      const rockBg = this.add.graphics();
      rockBg.fillStyle(0x2a2a1e, 0.9);
      rockBg.fillRoundedRect(col3X, rockY, colWidth, slotH, 4);
      rockBg.lineStyle(1, 0x554433, 1);
      rockBg.strokeRoundedRect(col3X, rockY, colWidth, slotH, 4);
      eqCol.add(rockBg);
      const rockIcon = this.add.image(col3X + 26, rockY + slotH / 2, 'bomb_icons', bombIconFrame('rock'))
        .setDisplaySize(28, 28);
      eqCol.add(rockIcon);
      eqCol.add(this.add.text(col3X + 46, rockY + 10, 'SLOT 5: Rock', {
        fontSize: '12px', color: '#ccaa88', fontFamily: 'monospace', fontStyle: 'bold',
      }));
      eqCol.add(this.add.text(col3X + 46, rockY + 26, 'infinite (fallback)', {
        fontSize: '11px', color: '#776655', fontFamily: 'monospace',
      }));
    }

    this.containers.push(eqCol);
  }
}
