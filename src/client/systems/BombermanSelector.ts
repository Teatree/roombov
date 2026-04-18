/**
 * Reusable Bomberman selector strip — shows owned Bombermen as small cards
 * with their name, animated sprite, inventory summary (bomb icons), and an
 * EQUIP button. Used in the Bombs Shop and Lobby scenes.
 *
 * Call `create()` to build the visual, `destroy()` to tear it down, and
 * `rebuild()` when the profile changes (new equip, purchase, etc.).
 */

import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { createShopBombermanSprite, pickRandomUiAnimation } from './BombermanAnimations.ts';
import { bombIconFrame, createBombLabelOverlay } from './BombIcons.ts';
import type { OwnedBomberman } from '@shared/types/bomberman.ts';

const SELECTOR_CARD_W = 140;
const SELECTOR_CARD_H = 180;
const SELECTOR_GAP = 12;

export class BombermanSelector {
  private scene: Phaser.Scene;
  private containers: Phaser.GameObjects.Container[] = [];
  private y: number;
  private unsub: (() => void) | null = null;

  constructor(scene: Phaser.Scene, y: number) {
    this.scene = scene;
    this.y = y;
  }

  create(): void {
    this.unsub = ProfileStore.subscribe(() => this.rebuild());
    this.rebuild();
  }

  rebuild(): void {
    for (const c of this.containers) c.destroy();
    this.containers = [];

    const profile = ProfileStore.get();
    if (!profile || profile.ownedBombermen.length === 0) {
      const empty = this.scene.add.container(0, 0);
      empty.add(this.scene.add.text(
        this.scene.scale.width / 2, this.y,
        '(No Bombermen owned — visit the Bomberman Shop)',
        { fontSize: '12px', color: '#666', fontFamily: 'monospace' },
      ).setOrigin(0.5));
      this.containers.push(empty);
      return;
    }

    const { width } = this.scene.scale;
    const count = profile.ownedBombermen.length;
    const totalW = count * SELECTOR_CARD_W + (count - 1) * SELECTOR_GAP;
    const startX = (width - totalW) / 2 + SELECTOR_CARD_W / 2;

    // Section label
    const label = this.scene.add.container(0, 0);
    label.add(this.scene.add.text(width / 2, this.y - SELECTOR_CARD_H / 2 - 20,
      'YOUR BOMBERMEN', {
        fontSize: '13px', color: '#aaaaaa', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
    this.containers.push(label);

    for (let i = 0; i < count; i++) {
      const owned = profile.ownedBombermen[i];
      const isEquipped = owned.id === profile.equippedBombermanId;
      const x = startX + i * (SELECTOR_CARD_W + SELECTOR_GAP);
      const card = this.buildCard(x, this.y, owned, isEquipped);
      this.containers.push(card);
    }
  }

  private buildCard(x: number, y: number, owned: OwnedBomberman, isEquipped: boolean): Phaser.GameObjects.Container {
    const container = this.scene.add.container(x, y);

    // Background
    const bg = this.scene.add.graphics();
    bg.fillStyle(0x1a1a2e, 0.95);
    bg.fillRoundedRect(-SELECTOR_CARD_W / 2, -SELECTOR_CARD_H / 2, SELECTOR_CARD_W, SELECTOR_CARD_H, 6);
    bg.lineStyle(2, isEquipped ? 0x44ff88 : 0x333355, 1);
    bg.strokeRoundedRect(-SELECTOR_CARD_W / 2, -SELECTOR_CARD_H / 2, SELECTOR_CARD_W, SELECTOR_CARD_H, 6);
    container.add(bg);

    // Animated preview sprite. The equipped entry keeps its anim stable
    // (UiAnimLock); other roster entries re-roll a random animation per open.
    const anim = isEquipped ? UiAnimLock.get(owned.id) : pickRandomUiAnimation();
    const sprite = createShopBombermanSprite(this.scene, 0, -40, owned.tint, owned.character, anim, 0.6);
    container.add(sprite);

    // Name
    container.add(this.scene.add.text(0, -4, owned.name ?? '???', {
      fontSize: '10px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Inventory icons row
    const slots = owned.inventory.slots;
    const iconSize = 18;
    const iconGap = 4;
    const totalIconW = 4 * iconSize + 3 * iconGap;
    const iconStartX = -totalIconW / 2 + iconSize / 2;
    const iconY = 16;

    for (let si = 0; si < 4; si++) {
      const slot = slots[si];
      const ix = iconStartX + si * (iconSize + iconGap);
      if (slot) {
        const icon = this.scene.add.image(ix, iconY, 'bomb_icons', bombIconFrame(slot.type))
          .setDisplaySize(iconSize, iconSize);
        container.add(icon);
        const iconLabel = createBombLabelOverlay(this.scene, ix, iconY, slot.type, iconSize);
        if (iconLabel) container.add(iconLabel);
        container.add(this.scene.add.text(ix, iconY + 12, `${slot.count}`, {
          fontSize: '8px', color: '#ffd944', fontFamily: 'monospace',
        }).setOrigin(0.5, 0));
      } else {
        container.add(this.scene.add.text(ix, iconY, '—', {
          fontSize: '10px', color: '#444', fontFamily: 'monospace',
        }).setOrigin(0.5));
      }
    }

    // Equip button or "EQUIPPED" label
    if (isEquipped) {
      container.add(this.scene.add.text(0, SELECTOR_CARD_H / 2 - 16, 'EQUIPPED', {
        fontSize: '10px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
    } else {
      const btn = this.scene.add.text(0, SELECTOR_CARD_H / 2 - 16, '[ EQUIP ]', {
        fontSize: '10px', color: '#44aaff', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#222244', padding: { x: 6, y: 3 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setColor('#88ccff'));
      btn.on('pointerout', () => btn.setColor('#44aaff'));
      btn.on('pointerdown', () => {
        NetworkManager.track('equip_bomberman', 'profile');
        NetworkManager.getSocket().emit('equip_bomberman', { ownedId: owned.id });
      });
      container.add(btn);
    }

    return container;
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    for (const c of this.containers) c.destroy();
    this.containers = [];
  }
}
