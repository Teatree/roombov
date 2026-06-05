/**
 * Bomberman Upgrade panel — embeddable (non-modal) version of the old
 * BombermanUpgradeScene popup.
 *
 * Renders the upgrade UI (hero + CAP/STACK/HP tracks with affordability-tinted
 * costs) into a fixed rect inside another scene. Always targets the player's
 * currently-equipped Bomberman; re-renders whenever the profile changes (equip
 * swap or a server upgrade response). Server-authoritative — every UPGRADE
 * click fires `upgrade_bomberman` and waits for the pushed `profile` snapshot.
 *
 * Used by BombermanShopScene's left column (the popup was removed). Lay it out
 * with `{ x, y, width }`; it draws downward from `y`.
 */

import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore } from '../ClientState.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { createShopBombermanSprite } from './BombermanAnimations.ts';
import { attachTierInfoBadge } from './TierInfoBadge.ts';
import { TREASURE_TEXTURE_KEY, treasureIconFrame } from './TreasureIcons.ts';
import {
  effectiveMaxCustomSlots, effectiveMaxHp, effectiveStackSize, tiersRemaining,
} from '@shared/utils/bomberman-stats.ts';
import type { OwnedBomberman, BombermanUpgradeState } from '@shared/types/bomberman.ts';

type UpgradeTrack = keyof BombermanUpgradeState; // 'cap' | 'stack' | 'hp'

const PAD = 16;
const ROW_H = 70;
const ROW_GAP = 6;
/** Vertical space above the stat rows: the hero block (badge/name/sprite).
 *  The "UPGRADE" section header + SP/treasure wallet live in the host scene's
 *  shared header now, not in this panel. */
const HERO_BLOCK = 126;
const TRACK_COLORS: Record<UpgradeTrack, { fill: number; text: string }> = {
  cap:   { fill: 0x5db5ff, text: '#5db5ff' },
  stack: { fill: 0x44dd88, text: '#44dd88' },
  hp:    { fill: 0xff5a4a, text: '#ff5a4a' },
};
const TRACK_LABEL: Record<UpgradeTrack, string> = { cap: 'CAP', stack: 'STACK', hp: 'HP' };
const BG = 0x221b35;
const BG_BORDER = 0x5b4a7d;
const ROW_BG = 0x1e1730;
const ROW_BORDER = 0x4a3a6e;
const TEXT_DEFAULT = '#e2e8f0';
const TEXT_DIM = '#9a8eb0';
const GOLD = 0xffc83a;

export interface UpgradePanelOptions {
  /** Top-left corner of the panel (screen/world space of the host scene). */
  x: number;
  y: number;
  /** Panel width. Height is content-driven (header + hero + 3 rows). */
  width: number;
}

export class BombermanUpgradePanel {
  private scene: Phaser.Scene;
  private opts: UpgradePanelOptions;
  /** Persistent chrome (background + header), built once. */
  private chrome: Phaser.GameObjects.Container | null = null;
  /** Per-render content (hero + rows), rebuilt on every profile change. */
  private content: Phaser.GameObjects.Container | null = null;
  private unsub: (() => void) | null = null;

  constructor(scene: Phaser.Scene, opts: UpgradePanelOptions) {
    this.scene = scene;
    this.opts = opts;
  }

  /** Full content height (so the host can place things below it). */
  get height(): number {
    return HERO_BLOCK + (ROW_H + ROW_GAP) * 3 - ROW_GAP + PAD * 2;
  }

  create(): void {
    const { x, y, width } = this.opts;
    const h = this.height;

    const chrome = this.scene.add.container(x, y);
    this.chrome = chrome;

    const bg = this.scene.add.graphics();
    bg.fillStyle(BG, 1);
    bg.fillRoundedRect(0, 0, width, h, 6);
    bg.lineStyle(2, BG_BORDER, 1);
    bg.strokeRoundedRect(0, 0, width, h, 6);
    chrome.add(bg);

    this.unsub = ProfileStore.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (this.content) { this.content.destroy(); this.content = null; }
    const { x, y, width } = this.opts;
    const profile = ProfileStore.get();
    const owned = profile?.ownedBombermen.find(b => b.id === profile.equippedBombermanId) ?? null;

    const c = this.scene.add.container(x, y);
    this.content = c;

    if (!owned) {
      c.add(this.scene.add.text(width / 2, this.height / 2, 'Equip a Bomberman\nto upgrade it', {
        fontSize: '14px', color: TEXT_DIM, fontFamily: 'monospace', align: 'center',
      }).setOrigin(0.5));
      return;
    }

    // --- Hero block (badge + name + sprite) ---
    const heroTop = 20;
    const badgeContainer = this.scene.add.container(0, 0);
    c.add(badgeContainer);
    attachTierInfoBadge(this.scene, badgeContainer, {
      x: width / 2,
      y: heroTop,
      tier: owned.tier,
      maxCustomSlots: effectiveMaxCustomSlots(owned),
      stackSize: effectiveStackSize(owned),
    });

    c.add(this.scene.add.text(width / 2, heroTop + 18, owned.name ?? '???', {
      fontSize: '20px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0));

    const sprite = createShopBombermanSprite(this.scene, width / 2, heroTop + 84, owned.tint, owned.character, 'idle', 0.8);
    c.add(sprite);

    // --- Stat rows ---
    const tracks: UpgradeTrack[] = ['cap', 'stack', 'hp'];
    let rowY = HERO_BLOCK + PAD;
    for (const track of tracks) {
      this.buildRow(c, owned, profile!.coins, profile!.treasures, track, rowY);
      rowY += ROW_H + ROW_GAP;
    }
  }

  private buildRow(
    parent: Phaser.GameObjects.Container,
    owned: OwnedBomberman,
    coins: number,
    treasures: Partial<Record<string, number>>,
    track: UpgradeTrack,
    y: number,
  ): void {
    const color = TRACK_COLORS[track];
    const rowX = PAD;
    const rowW = this.opts.width - PAD * 2;
    const remaining = tiersRemaining(owned, track);
    const applied = owned.upgrades[track];
    const maxTiers = BALANCE.upgrades[track].maxTiers;
    const maxed = remaining === 0;

    // Row background + left accent.
    const bg = this.scene.add.graphics().setAlpha(maxed ? 0.78 : 1);
    bg.fillStyle(ROW_BG, 1);
    bg.fillRoundedRect(rowX, y, rowW, ROW_H, 3);
    bg.lineStyle(1, ROW_BORDER, 1);
    bg.strokeRoundedRect(rowX, y, rowW, ROW_H, 3);
    bg.fillStyle(color.fill, 1);
    bg.fillRect(rowX, y, 4, ROW_H);
    parent.add(bg);

    // Col 1: label + pips.
    parent.add(this.scene.add.text(rowX + 12, y + 8, TRACK_LABEL[track], {
      fontSize: '16px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
    }));
    const pipsY = y + ROW_H - 14;
    for (let i = 0; i < maxTiers; i++) {
      const filled = i < applied;
      const pip = this.scene.add.graphics();
      const pipX = rowX + 12 + i * 20;
      if (filled) {
        pip.fillStyle(color.fill, 1);
        pip.fillRoundedRect(pipX, pipsY, 16, 6, 1);
      } else {
        pip.lineStyle(1, ROW_BORDER, 1);
        pip.strokeRoundedRect(pipX, pipsY, 16, 6, 1);
      }
      parent.add(pip);
    }

    // Col 2: current → next (or just current, if maxed).
    const col2x = rowX + 96;
    const currentValue = this.currentValueFor(track, owned);
    if (maxed) {
      parent.add(this.scene.add.text(col2x + 60, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '30px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
    } else {
      const nextValue = currentValue + 1;
      parent.add(this.scene.add.text(col2x + 26, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '28px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
      parent.add(this.scene.add.text(col2x + 56, y + ROW_H / 2, '→', {
        fontSize: '18px', color: TEXT_DIM, fontFamily: 'monospace',
      }).setOrigin(0.5, 0.5));
      parent.add(this.scene.add.text(col2x + 86, y + ROW_H / 2, `${nextValue}`, {
        fontSize: '28px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
    }

    // Col 3: cost + UPGRADE button (or MAXED badge).
    const COL3_W = 150;
    const col3x = rowX + rowW - COL3_W;
    if (maxed) {
      const badge = this.scene.add.graphics();
      badge.lineStyle(1, color.fill, 1);
      badge.strokeRoundedRect(col3x, y + 14, COL3_W, ROW_H - 28, 2);
      parent.add(badge);
      parent.add(this.scene.add.text(col3x + COL3_W / 2, y + ROW_H / 2, 'MAXED', {
        fontSize: '15px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
      return;
    }

    const tier = BALANCE.upgrades[track].tiers[applied];
    const treasureType = BALANCE.upgrades[track].treasure;
    const treasureHave = (treasures[treasureType] ?? 0) as number;
    const spShort = owned.sp < tier.sp;
    const coinShort = coins < tier.coins;
    const treasureShort = treasureHave < tier.treasure;
    const affordable = !spShort && !coinShort && !treasureShort;

    // Cost line — label stays canonical color; only the AMOUNT flips red.
    const costY = y + 12;
    parent.add(this.scene.add.text(col3x + 2, costY, 'SP', {
      fontSize: '13px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0));
    parent.add(this.scene.add.text(col3x + 24, costY, `${tier.sp}`, {
      fontSize: '13px', color: spShort ? '#ff5a4a' : '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0));
    parent.add(this.scene.add.text(col3x + 56, costY, `${tier.coins}`, {
      fontSize: '13px', color: coinShort ? '#ff5a4a' : '#ffc83a', fontFamily: 'monospace',
    }).setOrigin(0, 0));
    const coinNumW = `${tier.coins}`.length * 8;
    parent.add(this.scene.add.text(col3x + 56 + coinNumW, costY, 'c', {
      fontSize: '13px', color: '#ffc83a', fontFamily: 'monospace',
    }).setOrigin(0, 0));
    parent.add(this.scene.add.text(col3x + 108, costY, `${tier.treasure}`, {
      fontSize: '13px', color: treasureShort ? '#ff5a4a' : TEXT_DEFAULT, fontFamily: 'monospace',
    }).setOrigin(0, 0));
    parent.add(this.scene.add.image(col3x + 138, costY + 7, TREASURE_TEXTURE_KEY, treasureIconFrame(treasureType))
      .setDisplaySize(13, 13).setAlpha(treasureShort ? 0.5 : 1));

    // Button.
    const btnH = 24;
    const btnY = y + ROW_H - btnH - 7;
    const btnBg = this.scene.add.graphics();
    if (affordable) {
      btnBg.fillStyle(GOLD, 1);
      btnBg.fillRoundedRect(col3x, btnY, COL3_W, btnH, 2);
    } else {
      btnBg.fillStyle(0x2a2336, 1);
      btnBg.fillRoundedRect(col3x, btnY, COL3_W, btnH, 2);
      btnBg.lineStyle(1, ROW_BORDER, 1);
      btnBg.strokeRoundedRect(col3x, btnY, COL3_W, btnH, 2);
    }
    parent.add(btnBg);

    parent.add(this.scene.add.text(col3x + COL3_W / 2, btnY + btnH / 2, 'UPGRADE', {
      fontSize: '13px', color: affordable ? '#1a1208' : TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0.5));

    if (affordable) {
      const hit = this.scene.add.zone(col3x + COL3_W / 2, btnY + btnH / 2, COL3_W, btnH).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => {
        NetworkManager.track('upgrade_bomberman', 'profile');
        NetworkManager.getSocket().emit('upgrade_bomberman', { ownedId: owned.id, track });
      });
      parent.add(hit);
    }
  }

  private currentValueFor(track: UpgradeTrack, owned: OwnedBomberman): number {
    if (track === 'cap')   return effectiveMaxCustomSlots(owned);
    if (track === 'stack') return effectiveStackSize(owned);
    return effectiveMaxHp(owned);
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.content?.destroy();
    this.content = null;
    this.chrome?.destroy();
    this.chrome = null;
  }
}
