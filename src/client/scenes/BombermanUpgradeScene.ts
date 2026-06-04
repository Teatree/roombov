/**
 * Bomberman Upgrade popup — modal overlay scene.
 *
 * Launched via `scene.launch('BombermanUpgradeScene', { ownedId })` from
 * any roster screen (clicking a Bomberman card). Dims the parent, displays
 * the hero (tier badge / name / sprite) and three stat rows (CAP, STACK,
 * HP) with affordability-tinted costs.
 *
 * Server-authoritative — every UPGRADE click fires `upgrade_bomberman` and
 * waits for the server to push a new `profile` snapshot that triggers
 * a full re-render. ESC, backdrop click, or × all close.
 *
 * Per UPGRADE_POP_UP_HANDOFF.md, with these overrides from the user's
 * verbal spec:
 *   - SP is per-Bomberman (read `owned.sp`, not `profile.sp`).
 *   - CAP track is max 2 tiers (not 3).
 *   - HP track only available when current is below the cap.
 */

import Phaser from 'phaser';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { ProfileStore } from '../ClientState.ts';
import { BALANCE } from '@shared/config/balance.ts';
import {
  ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets,
} from '../systems/BombermanAnimations.ts';
import { attachTierInfoBadge } from '../systems/TierInfoBadge.ts';
import {
  preloadTreasureIcons, TREASURE_TEXTURE_KEY, treasureIconFrame,
} from '../systems/TreasureIcons.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import {
  effectiveMaxCustomSlots, effectiveMaxHp, effectiveStackSize,
  isFullyUpgraded, tiersRemaining,
} from '@shared/utils/bomberman-stats.ts';
import type { OwnedBomberman, BombermanUpgradeState } from '@shared/types/bomberman.ts';

type UpgradeTrack = keyof BombermanUpgradeState; // 'cap' | 'stack' | 'hp'

const POPUP_W = 540;
const PAD = 22;
const ROW_H = 84;
const ROW_GAP = 12;
// Design box for the centered modal panel. Tallest panel (fully-maxed hero)
// is heroH(266) + (ROW_H+ROW_GAP)*3 - ROW_GAP + PAD*2 = 586px; 620/600 leaves a
// small margin and keeps desktop a no-op (panel + wallet fit a 720p viewport).
const DESIGN_W = 600;
const DESIGN_H = 620;
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

export class BombermanUpgradeScene extends Phaser.Scene {
  private ownedId: string | null = null;
  private container: Phaser.GameObjects.Container | null = null;
  private unsub: (() => void) | null = null;
  /** Top-right wallet — built in create() and updated on every rebuild.
   *  Lives OUTSIDE the popup container so it isn't destroyed/rebuilt with it. */
  private wallet: TreasureListWidget | null = null;
  private walletSpText: Phaser.GameObjects.Text | null = null;
  private walletCoinsText: Phaser.GameObjects.Text | null = null;
  /** Re-fit the camera when the viewport changes (orientation / window drag). */
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'BombermanUpgradeScene' });
  }

  init(data?: { ownedId?: string }): void {
    this.ownedId = data?.ownedId ?? null;
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadTreasureIcons(this);
  }

  create(): void {
    trackScreen(this, 'BombermanUpgrade');
    ensureBombermanAnims(this);
    this.events.once('shutdown', this.shutdown, this);

    // Backdrop click + ESC both close.
    const { width } = this.scale;
    const backdrop = this.add.rectangle(0, 0, width, this.scale.height, 0x000612, 0.78)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.close());
    this.input.keyboard?.on('keydown-ESC', () => this.close());

    // Top-right wallet: SP (per-bomberman) + coins + treasure list. Rendered
    // ABOVE the backdrop so the player can see their balances while picking
    // upgrades. Same TreasureListWidget used everywhere else for the gem row.
    this.walletSpText = this.add.text(width - 20, 14, '', {
      fontSize: '18px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(100);
    this.walletCoinsText = this.add.text(width - 20, 38, '', {
      fontSize: '16px', color: '#ffc83a', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(100);
    this.wallet = new TreasureListWidget(this, {
      x: width - 20,
      y: 62,
      anchor: 'top-left',
      direction: 'horizontal',
      iconScale: 0.5,
      fontSize: 12,
      rowGap: 4,
      depth: 100,
    });

    this.unsub = ProfileStore.subscribe(() => this.rebuild());
    this.rebuild();

    // Scale the centered panel to fit short/narrow viewports (no-op on
    // desktop). The backdrop stays sized to the live viewport so it always
    // covers the screen.
    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);

    void backdrop;
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.unsub?.();
    this.unsub = null;
    this.wallet?.destroy();
    this.wallet = null;
  }

  private close(): void {
    this.scene.stop();
  }

  private rebuild(): void {
    if (this.container) { this.container.destroy(); this.container = null; }
    const profile = ProfileStore.get();
    if (!profile || !this.ownedId) return;
    const owned = profile.ownedBombermen.find(b => b.id === this.ownedId);
    if (!owned) { this.close(); return; }

    // --- Top-right wallet (outside the panel) ---
    // SP is per-bomberman so it reflects the upgrade target, not a global.
    this.walletSpText?.setText(`SP ${owned.sp}`);
    this.walletCoinsText?.setText(`Coins: ${profile.coins}`);
    this.wallet?.setBundle(profile.treasures ?? {});
    const wr = this.wallet?.getRect();
    if (wr && wr.w > 0) this.wallet?.setX(this.scale.width - 20 - wr.w);

    const fullyMaxed = isFullyUpgraded(owned);
    // Hero block is taller now — bigger name + larger sprite zone.
    const heroH = 230 + (fullyMaxed ? 36 : 0);
    const panelH = heroH + (ROW_H + ROW_GAP) * 3 - ROW_GAP + PAD * 2;
    // Center the panel on the design box so the camera-fit (which centers on the
    // design box) keeps it centered on short viewports. `layoutW`/`layoutH` are
    // the live viewport on desktop (no-op) and the design dims when short.
    const { layoutW: width, layoutH: height } = designViewport(this, DESIGN_W, DESIGN_H);
    const cx = width / 2;
    const cy = height / 2;

    const c = this.add.container(cx, cy);
    this.container = c;

    // Panel chrome + click-eater.
    const bg = this.add.graphics();
    bg.fillStyle(BG, 1);
    bg.fillRoundedRect(-POPUP_W / 2, -panelH / 2, POPUP_W, panelH, 4);
    bg.lineStyle(2, BG_BORDER, 1);
    bg.strokeRoundedRect(-POPUP_W / 2, -panelH / 2, POPUP_W, panelH, 4);
    c.add(bg);
    const panelEater = this.add.zone(0, 0, POPUP_W, panelH).setInteractive();
    c.add(panelEater);

    // Close button (×) — bigger hit target + glyph.
    const closeBtn = this.add.text(POPUP_W / 2 - 24, -panelH / 2 + 10, '×', {
      fontSize: '24px', color: TEXT_DIM, fontFamily: 'monospace',
      backgroundColor: '#00000044', padding: { x: 9, y: 0 },
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor(TEXT_DEFAULT));
    closeBtn.on('pointerout', () => closeBtn.setColor(TEXT_DIM));
    closeBtn.on('pointerdown', () => this.close());
    c.add(closeBtn);

    // --- Hero block ---
    const heroTop = -panelH / 2 + PAD;
    const badgeContainer = this.add.container(0, 0);
    c.add(badgeContainer);
    attachTierInfoBadge(this, badgeContainer, {
      x: 0,
      y: heroTop + 20,
      tier: owned.tier,
      maxCustomSlots: effectiveMaxCustomSlots(owned),
      stackSize: effectiveStackSize(owned),
    });

    // Name — bumped to 28px.
    c.add(this.add.text(0, heroTop + 48, owned.name ?? '???', {
      fontSize: '28px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0));

    // Sprite — keep proportional scale, sits below the name.
    const sprite = createShopBombermanSprite(this, 0, heroTop + 150, owned.tint, owned.character, 'idle', 1.3);
    c.add(sprite);

    if (fullyMaxed) {
      const banner = this.add.text(0, heroTop + 220, 'FULLY UPGRADED', {
        fontSize: '14px', color: '#1a1208', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#ffc83a', padding: { x: 16, y: 6 },
      }).setOrigin(0.5, 0);
      c.add(banner);
    }

    // --- Stat rows ---
    const tracks: UpgradeTrack[] = ['cap', 'stack', 'hp'];
    let rowY = heroTop + heroH + 8;
    for (const track of tracks) {
      this.buildRow(c, owned, profile.coins, profile.treasures, track, rowY);
      rowY += ROW_H + ROW_GAP;
    }
    void height;
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
    const rowX = -POPUP_W / 2 + PAD;
    const rowW = POPUP_W - PAD * 2;
    const remaining = tiersRemaining(owned, track);
    const applied = owned.upgrades[track];
    const maxTiers = BALANCE.upgrades[track].maxTiers;
    const maxed = remaining === 0;

    // Row background + left accent
    const bg = this.add.graphics().setAlpha(maxed ? 0.78 : 1);
    bg.fillStyle(ROW_BG, 1);
    bg.fillRoundedRect(rowX, y, rowW, ROW_H, 3);
    bg.lineStyle(1, ROW_BORDER, 1);
    bg.strokeRoundedRect(rowX, y, rowW, ROW_H, 3);
    bg.fillStyle(color.fill, 1);
    bg.fillRect(rowX, y, 4, ROW_H);
    parent.add(bg);

    // Col 1: label + pips — bigger font for the label.
    parent.add(this.add.text(rowX + 14, y + 12, TRACK_LABEL[track], {
      fontSize: '18px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
    }));
    const pipsY = y + ROW_H - 18;
    for (let i = 0; i < maxTiers; i++) {
      const filled = i < applied;
      const pip = this.add.graphics();
      const pipX = rowX + 14 + i * 22;
      if (filled) {
        pip.fillStyle(color.fill, 1);
        pip.fillRoundedRect(pipX, pipsY, 18, 6, 1);
      } else {
        pip.lineStyle(1, ROW_BORDER, 1);
        pip.strokeRoundedRect(pipX, pipsY, 18, 6, 1);
      }
      parent.add(pip);
    }

    // Col 2: current → next (or just current, in stat color, if maxed).
    // Bumped to 36px; arrow to 22px.
    const col2x = rowX + 120;
    const currentValue = this.currentValueFor(track, owned);
    if (maxed) {
      parent.add(this.add.text(col2x + 80, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '36px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
    } else {
      const nextValue = currentValue + 1; // +1 per tier
      parent.add(this.add.text(col2x + 40, y + ROW_H / 2, `${currentValue}`, {
        fontSize: '36px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
      parent.add(this.add.text(col2x + 80, y + ROW_H / 2, '→', {
        fontSize: '22px', color: TEXT_DIM, fontFamily: 'monospace',
      }).setOrigin(0.5, 0.5));
      parent.add(this.add.text(col2x + 120, y + ROW_H / 2, `${nextValue}`, {
        fontSize: '36px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5));
    }

    // Col 3: cost + UPGRADE (always reads UPGRADE — affordable = gold, not
    // affordable = greyed out so the player knows it's the same action but
    // they don't have enough.)
    const COL3_W = 174;
    const col3x = rowX + rowW - COL3_W;
    if (maxed) {
      const badge = this.add.graphics();
      badge.lineStyle(1, color.fill, 1);
      badge.strokeRoundedRect(col3x, y + 16, COL3_W, ROW_H - 32, 2);
      parent.add(badge);
      parent.add(this.add.text(col3x + COL3_W / 2, y + ROW_H / 2, 'MAXED', {
        fontSize: '16px', color: color.text, fontFamily: 'monospace', fontStyle: 'bold',
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

    // Cost line (above the button). Each cost splits into [label][number]
    // so the static label stays its canonical color (SP blue, c yellow) and
    // only the AMOUNT flips red when the player can't afford it.
    const costY = y + 14;
    // "SP" label — always blue.
    parent.add(this.add.text(col3x + 4, costY, 'SP', {
      fontSize: '14px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0));
    // SP amount — blue if affordable, red if short.
    parent.add(this.add.text(col3x + 28, costY, `${tier.sp}`, {
      fontSize: '14px', color: spShort ? '#ff5a4a' : '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0));
    // Coin amount — yellow if affordable, red if short.
    parent.add(this.add.text(col3x + 64, costY, `${tier.coins}`, {
      fontSize: '14px', color: coinShort ? '#ff5a4a' : '#ffc83a', fontFamily: 'monospace',
    }).setOrigin(0, 0));
    // "c" suffix — always yellow.
    const coinNumW = `${tier.coins}`.length * 9;
    parent.add(this.add.text(col3x + 64 + coinNumW, costY, 'c', {
      fontSize: '14px', color: '#ffc83a', fontFamily: 'monospace',
    }).setOrigin(0, 0));
    // Treasure amount — white if enough, red if short. Icon trails as before.
    parent.add(this.add.text(col3x + 124, costY, `${tier.treasure}`, {
      fontSize: '14px', color: treasureShort ? '#ff5a4a' : TEXT_DEFAULT, fontFamily: 'monospace',
    }).setOrigin(0, 0));
    parent.add(this.add.image(col3x + 158, costY + 8, TREASURE_TEXTURE_KEY, treasureIconFrame(treasureType))
      .setDisplaySize(14, 14).setAlpha(treasureShort ? 0.5 : 1));

    // Button — taller + bigger label. Always says UPGRADE; unaffordable
    // state renders it disabled (grey fill, dim text) per user spec.
    const btnH = 26;
    const btnY = y + ROW_H - btnH - 8;
    const btnBg = this.add.graphics();
    if (affordable) {
      btnBg.fillStyle(GOLD, 1);
      btnBg.fillRoundedRect(col3x, btnY, COL3_W, btnH, 2);
      btnBg.lineStyle(1, GOLD, 1);
      btnBg.strokeRoundedRect(col3x, btnY, COL3_W, btnH, 2);
    } else {
      btnBg.fillStyle(0x2a2336, 1);
      btnBg.fillRoundedRect(col3x, btnY, COL3_W, btnH, 2);
      btnBg.lineStyle(1, ROW_BORDER, 1);
      btnBg.strokeRoundedRect(col3x, btnY, COL3_W, btnH, 2);
    }
    parent.add(btnBg);

    const labelColor = affordable ? '#1a1208' : TEXT_DIM;
    const btnText = this.add.text(col3x + COL3_W / 2, btnY + btnH / 2, 'UPGRADE', {
      fontSize: '14px', color: labelColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0.5);
    parent.add(btnText);

    if (affordable) {
      const hit = this.add.zone(col3x + COL3_W / 2, btnY + btnH / 2, COL3_W, btnH).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => {
        if (!this.ownedId) return;
        NetworkManager.track('upgrade_bomberman', 'profile');
        NetworkManager.getSocket().emit('upgrade_bomberman', { ownedId: this.ownedId, track });
      });
      parent.add(hit);
    }
  }

  private currentValueFor(track: UpgradeTrack, owned: OwnedBomberman): number {
    if (track === 'cap')   return effectiveMaxCustomSlots(owned);
    if (track === 'stack') return effectiveStackSize(owned);
    return effectiveMaxHp(owned);
  }
}
