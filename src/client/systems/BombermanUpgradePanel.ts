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
import { HIDDEN_FEATURES } from '@shared/config/features.ts';
import { createShopBombermanSprite } from './BombermanAnimations.ts';
import { attachTierInfoBadge } from './TierInfoBadge.ts';
import { createIdleActionBadge } from './IdleActionBadge.ts';
import { TREASURE_TEXTURE_KEY, treasureIconFrame } from './TreasureIcons.ts';
import {
  effectiveMaxCustomSlots, effectiveMaxHp, effectiveStackSize, tiersRemaining, upgradeLevel,
} from '@shared/utils/bomberman-stats.ts';
import type { OwnedBomberman, BombermanUpgradeState } from '@shared/types/bomberman.ts';
import { COL, CSS, FONT, STAT_COL, STAT_HEX } from '../design/tokens.ts';
import { drawNotchedPanel, makePixelButton } from '../util/pixelPanel.ts';

// Track keys (cap|stack|hp) map 1:1 onto the stat color keys, so STAT_HEX /
// STAT_COL (HP=red, CAP=blue, STACK=green) are indexed directly by track.
type UpgradeTrack = keyof BombermanUpgradeState; // 'cap' | 'stack' | 'hp'

const PAD = 16;
const ROW_H = 70;
const ROW_GAP = 6;
/** Vertical space above the stat rows: the hero block (badge/name/sprite).
 *  The "UPGRADE" section header + SP/treasure wallet live in the host scene's
 *  shared header now, not in this panel. */
const HERO_BLOCK = 126;
const TRACK_LABEL: Record<UpgradeTrack, string> = { cap: 'CAP', stack: 'STACK', hp: 'HP' };

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

  /**
   * Slide the whole panel in from `dx` px to the left while fading up. Used by
   * the Bomberman Shop to reveal the upgrade column on the player's first
   * purchase. Call right after `create()`.
   */
  animateInFromLeft(dx: number, ms: number): void {
    for (const c of [this.chrome, this.content]) {
      if (!c) continue;
      const restX = c.x;
      c.x = restX - dx;
      c.setAlpha(0);
      this.scene.tweens.add({ targets: c, x: restX, alpha: 1, duration: ms, ease: 'Quad.easeOut' });
    }
  }

  create(): void {
    const { x, y, width } = this.opts;
    const h = this.height;

    const chrome = this.scene.add.container(x, y);
    this.chrome = chrome;

    const bg = this.scene.add.graphics();
    drawNotchedPanel(bg, 0, 0, width, h, {
      fill: COL.panel, border: COL.borderHi, borderWidth: 2, notch: 8,
    });
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
      c.add(this.scene.add.text(width / 2, this.height / 2, 'EQUIP A BOMBERMAN\nTO UPGRADE IT', {
        fontSize: '13px', color: CSS.dim, fontFamily: FONT.silk, align: 'center',
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
      level: upgradeLevel(owned),
      idleAction: owned.idleAction ?? 'attack',
      maxCustomSlots: effectiveMaxCustomSlots(owned),
      stackSize: effectiveStackSize(owned),
      name: owned.name,
      sp: owned.sp ?? 0,
    });

    c.add(this.scene.add.text(width / 2, heroTop + 18, owned.name ?? '???', {
      fontSize: '18px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5, 0));

    c.add(createIdleActionBadge(this.scene, width / 2, heroTop + 42, owned.idleAction ?? 'attack'));

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
    const statHex = STAT_HEX[track];
    const statCol = STAT_COL[track];
    const rowX = PAD;
    const rowW = this.opts.width - PAD * 2;
    const remaining = tiersRemaining(owned, track);
    const applied = owned.upgrades[track];
    const maxTiers = BALANCE.upgrades[track].maxTiers;
    const maxed = remaining === 0;

    // Row = panel2 notched row + a 4px left accent bar in the track's stat color.
    const bg = this.scene.add.graphics().setAlpha(maxed ? 0.78 : 1);
    drawNotchedPanel(bg, rowX, y, rowW, ROW_H, {
      fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 5,
    });
    bg.fillStyle(statCol, 1);
    bg.fillRect(rowX, y + 4, 4, ROW_H - 8);
    parent.add(bg);

    // Col 1: label + pips (both in the track's stat color).
    parent.add(this.scene.add.text(rowX + 12, y + 8, TRACK_LABEL[track], {
      fontSize: '14px', color: statHex, fontFamily: FONT.press,
    }));
    const pipsY = y + ROW_H - 14;
    for (let i = 0; i < maxTiers; i++) {
      const filled = i < applied;
      const pip = this.scene.add.graphics();
      const pipX = rowX + 12 + i * 20;
      if (filled) {
        pip.fillStyle(statCol, 1);
        pip.fillRect(pipX, pipsY, 16, 6);
      } else {
        pip.lineStyle(1, statCol, 1);
        pip.strokeRect(pipX, pipsY, 16, 6);
      }
      parent.add(pip);
    }

    // Col 2: current → next (or just current, if maxed).
    const col2x = rowX + 96;
    const currentValue = this.currentValueFor(track, owned);
    if (maxed) {
      parent.add(this.scene.add.text(col2x + 60, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '24px', color: statHex, fontFamily: FONT.press,
      }).setOrigin(0.5, 0.5));
    } else {
      const nextValue = currentValue + 1;
      parent.add(this.scene.add.text(col2x + 26, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '22px', color: CSS.text, fontFamily: FONT.press,
      }).setOrigin(0.5, 0.5));
      parent.add(this.scene.add.text(col2x + 56, y + ROW_H / 2, '>', {
        fontSize: '16px', color: CSS.dim, fontFamily: FONT.press,
      }).setOrigin(0.5, 0.5));
      parent.add(this.scene.add.text(col2x + 86, y + ROW_H / 2, `${nextValue}`, {
        fontSize: '22px', color: statHex, fontFamily: FONT.press,
      }).setOrigin(0.5, 0.5));
    }

    // Col 3: cost + UPGRADE button (or MAXED badge with the track-color border).
    const COL3_W = 150;
    const col3x = rowX + rowW - COL3_W;
    if (maxed) {
      const badge = this.scene.add.graphics();
      badge.lineStyle(2, statCol, 1);
      badge.strokeRect(col3x, y + 14, COL3_W, ROW_H - 28);
      parent.add(badge);
      parent.add(this.scene.add.text(col3x + COL3_W / 2, y + ROW_H / 2, 'MAXED', {
        fontSize: '13px', color: statHex, fontFamily: FONT.press,
      }).setOrigin(0.5, 0.5));
      return;
    }

    const tier = BALANCE.upgrades[track].tiers[applied];
    const treasureType = BALANCE.upgrades[track].treasure;
    const treasureHave = (treasures[treasureType] ?? 0) as number;
    const spShort = owned.sp < tier.sp;
    const coinShort = coins < tier.coins;
    const treasureShort = !HIDDEN_FEATURES.treasures && treasureHave < tier.treasure;
    const affordable = !spShort && !coinShort && !treasureShort;

    // Cost line — per-currency: SP n (blue, experience) / n c (gold). The
    // lacking currency's AMOUNT flips red. Chained left-to-right by measured
    // width so the Press Start glyphs never overlap.
    const costY = y + 12;
    let cx = col3x + 2;
    const addCost = (text: string, color: string, gap: number): void => {
      const t = this.scene.add.text(cx, costY, text, {
        fontSize: '12px', color, fontFamily: FONT.press,
      }).setOrigin(0, 0);
      parent.add(t);
      cx += t.width + gap;
    };
    addCost('SP', CSS.blue, 5);
    addCost(`${tier.sp}`, spShort ? CSS.red : CSS.blue, 10);
    addCost(`${tier.coins}`, coinShort ? CSS.red : CSS.gold, 3);
    addCost('C', CSS.gold, 8);
    if (!HIDDEN_FEATURES.treasures) {
      addCost(`${tier.treasure}`, treasureShort ? CSS.red : CSS.text, 4);
      parent.add(this.scene.add.image(cx, costY + 7, TREASURE_TEXTURE_KEY, treasureIconFrame(treasureType))
        .setDisplaySize(13, 13).setAlpha(treasureShort ? 0.5 : 1));
    }

    // UPGRADE button — gold pixel button when affordable, neutral/disabled
    // otherwise.
    const btnH = 26;
    const btnY = y + ROW_H - btnH - 7 + btnH / 2;
    const btn = makePixelButton(this.scene, {
      x: col3x + COL3_W / 2, y: btnY, w: COL3_W, h: btnH,
      label: 'UPGRADE', variant: affordable ? 'gold' : 'neutral',
      fontPx: 12, notch: 4, enabled: affordable,
      onClick: () => {
        NetworkManager.track('upgrade_bomberman', 'profile');
        NetworkManager.getSocket().emit('upgrade_bomberman', { ownedId: owned.id, track });
      },
    });
    parent.add(btn.container);
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
