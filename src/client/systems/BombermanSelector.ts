/**
 * Reusable Bomberman selector strip — shows owned Bombermen as small cards
 * with their name, animated sprite, inventory summary (bomb icons), tier
 * info badge, and an EQUIP button. Used in the Bombs Shop and Lobby scenes.
 *
 * Call `create()` to build the visual, `destroy()` to tear it down, and
 * `rebuild()` when the profile changes (new equip, purchase, etc.).
 */

import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { createShopBombermanSprite, pickRandomUiAnimation } from './BombermanAnimations.ts';
import { bombIconFrame } from './BombIcons.ts';
import type { OwnedBomberman } from '@shared/types/bomberman.ts';
import { attachTierInfoBadge } from './TierInfoBadge.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { tiersRemaining, isFullyUpgraded, effectiveMaxCustomSlots, effectiveStackSize } from '@shared/utils/bomberman-stats.ts';

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
      // Breadcrumb pip — subtle non-red dot when any of the three upgrade
      // tracks has an affordable next tier for this Bomberman. Suppressed
      // entirely when nothing is affordable so the pip remains a meaningful
      // signal rather than constant clutter.
      if (this.cardHasAffordableUpgrade(owned, profile.coins, profile.treasures)) {
        const pip = this.scene.add.graphics();
        pip.fillStyle(0x44ff88, 1);
        pip.fillCircle(SELECTOR_CARD_W / 2 - 8, -SELECTOR_CARD_H / 2 + 8, 4);
        pip.lineStyle(1, 0x0a3a18, 1);
        pip.strokeCircle(SELECTOR_CARD_W / 2 - 8, -SELECTOR_CARD_H / 2 + 8, 4);
        card.add(pip);
      }
      this.containers.push(card);
    }
  }

  /** True if any of the three upgrade tracks has a tier the player can
   *  afford right now (SP + coins + treasure). Drives the breadcrumb pip. */
  private cardHasAffordableUpgrade(
    owned: OwnedBomberman,
    coins: number,
    treasures: Partial<Record<string, number>>,
  ): boolean {
    for (const track of ['cap', 'stack', 'hp'] as const) {
      if (tiersRemaining(owned, track) <= 0) continue;
      const applied = owned.upgrades?.[track] ?? 0;
      const tier = BALANCE.upgrades[track].tiers[applied];
      if (!tier) continue;
      if ((owned.sp ?? 0) < tier.sp) continue;
      if (coins < tier.coins) continue;
      const treasureType = BALANCE.upgrades[track].treasure;
      if ((treasures[treasureType] ?? 0) < tier.treasure) continue;
      return true;
    }
    return false;
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

    // Card-wide hit target — click opens the Upgrade popup. Added before
    // child interactives (EQUIP / loadout) so those win clicks when over
    // them. Phaser's topOnly=true sends pointerover to whichever interactive
    // is topmost under the cursor — the gold outline therefore appears
    // ONLY when the pointer is over the "bare" card area, not over EQUIP
    // or the loadout button.
    const cardHover = this.scene.add.graphics();
    container.add(cardHover);
    const cardZone = this.scene.add.zone(0, 0, SELECTOR_CARD_W, SELECTOR_CARD_H)
      .setInteractive({ useHandCursor: true });
    cardZone.on('pointerover', () => {
      cardHover.clear();
      cardHover.lineStyle(2, 0xffd944, 1);
      cardHover.strokeRoundedRect(-SELECTOR_CARD_W / 2 + 1, -SELECTOR_CARD_H / 2 + 1,
        SELECTOR_CARD_W - 2, SELECTOR_CARD_H - 2, 6);
    });
    cardZone.on('pointerout', () => cardHover.clear());
    cardZone.on('pointerdown', () => {
      // Don't open the Upgrade popup if the card is fully maxed —
      // there's nothing actionable. Click is a no-op in that case.
      if (isFullyUpgraded(owned)) return;
      this.scene.scene.launch('BombermanUpgradeScene', { ownedId: owned.id });
    });
    container.add(cardZone);

    // Animated preview sprite. The equipped entry keeps its anim stable
    // (UiAnimLock); other roster entries re-roll a random animation per open.
    const anim = isEquipped ? UiAnimLock.get(owned.id) : pickRandomUiAnimation();
    const sprite = createShopBombermanSprite(this.scene, 0, -40, owned.tint, owned.character, anim, 0.6);
    container.add(sprite);

    // Tier info badge — Roman numeral circle, top-right of the card. Hover
    // reveals the stat tooltip (HP / Slots / Stack Size).
    attachTierInfoBadge(this.scene, container, {
      x: SELECTOR_CARD_W / 2 - 14,
      y: -SELECTOR_CARD_H / 2 + 14,
      tier: owned.tier,
      maxCustomSlots: effectiveMaxCustomSlots(owned),
      stackSize: effectiveStackSize(owned),
    });

    // Name
    container.add(this.scene.add.text(0, -4, owned.name ?? '???', {
      fontSize: '10px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Inventory icons row — variable count based on the bomberman's slots.
    const slots = owned.inventory.slots;
    const slotCount = effectiveMaxCustomSlots(owned);
    // Auto-shrink icon size for higher-tier loadouts so 6 icons still fit
    // inside the 140-wide card. Sizes chosen to stay readable.
    const iconSize = slotCount >= 6 ? 16 : slotCount >= 5 ? 18 : 20;
    const iconGap = 4;
    const totalIconW = slotCount * iconSize + Math.max(0, slotCount - 1) * iconGap;
    const iconStartX = -totalIconW / 2 + iconSize / 2;
    const iconY = 16;
    // Loadout-as-button: the icons row is a single hit target. Hover shows
    // a gold outline. Click jumps to the Bombs Shop with this bomberman as
    // the active one (auto-equips first if it isn't already).
    const loadoutPadX = 6;
    const loadoutPadY = 14;
    const loadoutLeft = iconStartX - iconSize / 2 - loadoutPadX;
    const loadoutTop = iconY - iconSize / 2 - 2;
    const loadoutWidth = totalIconW + loadoutPadX * 2;
    const loadoutHeight = iconSize + loadoutPadY;
    const loadoutHover = this.scene.add.graphics();
    container.add(loadoutHover);

    for (let si = 0; si < slotCount; si++) {
      const slot = slots[si];
      const ix = iconStartX + si * (iconSize + iconGap);
      if (slot) {
        const icon = this.scene.add.image(ix, iconY, 'bomb_icons', bombIconFrame(slot.type))
          .setDisplaySize(iconSize, iconSize);
        container.add(icon);
        container.add(this.scene.add.text(ix, iconY + iconSize / 2 + 4, `${slot.count}`, {
          fontSize: '8px', color: '#ffd944', fontFamily: 'monospace',
        }).setOrigin(0.5, 0));
      } else {
        container.add(this.scene.add.text(ix, iconY, '—', {
          fontSize: '10px', color: '#444', fontFamily: 'monospace',
        }).setOrigin(0.5));
      }
    }

    // Click target on top so it wins over the icons. Skip when we're
    // already inside the Bombs Shop — would just reopen the same scene.
    const sceneKey = this.scene.scene.key;
    if (sceneKey !== 'BombsShopScene') {
      const zone = this.scene.add.zone(
        loadoutLeft + loadoutWidth / 2,
        loadoutTop + loadoutHeight / 2,
        loadoutWidth,
        loadoutHeight,
      ).setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => {
        loadoutHover.clear();
        loadoutHover.lineStyle(2, 0xffd944, 1);
        loadoutHover.strokeRoundedRect(loadoutLeft, loadoutTop, loadoutWidth, loadoutHeight, 4);
      });
      zone.on('pointerout', () => loadoutHover.clear());
      zone.on('pointerdown', () => {
        if (!isEquipped) {
          NetworkManager.track('equip_bomberman', 'profile');
          NetworkManager.getSocket().emit('equip_bomberman', { ownedId: owned.id });
        }
        this.scene.scene.start('BombsShopScene', { backScene: sceneKey });
      });
      container.add(zone);
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
