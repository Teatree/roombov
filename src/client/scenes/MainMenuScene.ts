import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';
import { attachTierInfoBadge } from '../systems/TierInfoBadge.ts';
import { createIdleActionBadge } from '../systems/IdleActionBadge.ts';
import { bombIconFrame } from '../systems/BombIcons.ts';
import { effectiveMaxCustomSlots, effectiveStackSize, upgradeLevel } from '@shared/utils/bomberman-stats.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { NotificationBadge } from '../systems/NotificationBadge.ts';
import { FACTORY_IDS, projectedClaimable } from '@shared/types/factory.ts';
import { FACTORIES } from '@shared/config/factories.ts';
import { HIDDEN_FEATURES } from '@shared/config/features.ts';
import type { PlayerProfile } from '@shared/types/player-profile.ts';
import type { OwnedBomberman } from '@shared/types/bomberman.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { COL, CSS, FONT, STAT_HEX } from '../design/tokens.ts';
import { addTabLabel, drawDashedRect, drawNotchedPanel, linkAction, makePixelButton, type PixelButton } from '../util/pixelPanel.ts';

/** Design box this scene is authored against; scaled to fit smaller viewports.
 *  Kept at the established size so 720p+ desktop is an exact no-op. */
const DESIGN_W = 600;
const DESIGN_H = 740;

const PANEL_W = 560;
const HERO_TOP = 104;
const HERO_H = 214;
const PORTRAIT = 168;

/**
 * Entry point after Boot. Connects to the server, authenticates, and offers
 * navigation to the shops or to the lobby. All shop/lobby scenes return here.
 * Pixel Panel restyle (handoff §2): a hero "EQUIPPED" panel over an action
 * stack (gold PLAY, BOMBERMEN/BOMBS SHOP row, dashed TUTORIAL).
 */
export class MainMenuScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private coinsText!: Phaser.GameObjects.Text;
  private treasureList!: TreasureListWidget;
  private heroContainer!: Phaser.GameObjects.Container;
  private playBtn!: PixelButton;
  private bombermenBtn!: PixelButton;
  private unsubscribe: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private debugFeedback!: Phaser.GameObjects.Text;
  private factoryBadge: NotificationBadge | null = null;
  private factoryBadgeTimer: Phaser.Time.TimerEvent | null = null;
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'MainMenuScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadTreasureIcons(this);
  }

  create(): void {
    trackScreen(this, 'MainMenu');
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { width } = this.scale;
    const { layoutH } = designViewport(this, DESIGN_W, DESIGN_H);
    const cx = width / 2;

    this.cameras.main.setBackgroundColor(CSS.bg);

    // Title block (§1.2): Press Start title + hard pixel shadow, Silkscreen subtitle.
    this.add.text(cx, 46, 'ROOMBOV', {
      fontSize: '36px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5).setShadow(5, 5, CSS.stageFrame, 0, true, true);
    this.add.text(cx, 84, 'MAIN MENU', {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0.5).setLetterSpacing(4);

    // Wallet top-right (§1.8): coins in Press Start gold, treasures below.
    this.coinsText = this.add.text(width - 20, 22, '0', {
      fontSize: '16px', color: CSS.gold, fontFamily: FONT.press,
    }).setOrigin(1, 0.5);
    this.treasureList = new TreasureListWidget(this, {
      x: width - 20, y: 40, anchor: 'top-left', direction: 'horizontal',
      iconScale: 0.5, fontSize: 11, rowGap: 4, depth: 100,
    });

    // Hero panel rebuilt per-profile (handles EQUIPPED vs empty OPERATIVE state).
    this.heroContainer = this.add.container(0, 0);

    // --- Action stack ---
    this.playBtn = makePixelButton(this, {
      x: cx, y: 356, w: PANEL_W, h: 54, label: 'PLAY', variant: 'gold', fontPx: 20,
      onClick: () => this.scene.start('LobbyScene'),
    });

    const halfW = (PANEL_W - 16) / 2;
    this.bombermenBtn = makePixelButton(this, {
      x: cx - halfW / 2 - 8, y: 414, w: halfW, h: 46, label: 'BOMBERMEN', fontPx: 13,
      onClick: () => this.scene.start('BombermanShopScene'),
    });
    makePixelButton(this, {
      x: cx + halfW / 2 + 8, y: 414, w: halfW, h: 46, label: 'BOMBS SHOP', fontPx: 13,
      onClick: () => this.scene.start('BombsShopScene'),
    });

    let tutorialY = 470;
    // Factory entry only when the system is un-hidden (HIDDEN_FEATURES.factory).
    if (!HIDDEN_FEATURES.factory) {
      const factoryBtn = makePixelButton(this, {
        x: cx, y: 470, w: PANEL_W, h: 42, label: 'FACTORY', fontPx: 13,
        onClick: () => this.scene.start('FactoryScene'),
      });
      const bx = cx + PANEL_W / 2 - 6;
      const by = 470 - 42 / 2 + 6;
      this.factoryBadge = new NotificationBadge(this, bx, by);
      this.refreshFactoryBadge();
      this.factoryBadgeTimer = this.time.addEvent({
        delay: 5000, loop: true, callback: () => this.refreshFactoryBadge(),
      });
      void factoryBtn;
      tutorialY = 524;
    }

    // TUTORIAL — deliberately different (§2.2): dashed muted-blue border, no
    // notches, ?-glyph + label left, hint right. Full-width so it stays
    // discoverable but reads as "practice, not the real economy".
    this.buildTutorialButton(cx, tutorialY, PANEL_W, 46);

    // Footer: debug bottom-left (debug-red), status bottom-center (status-green).
    const debugBtn = this.add.text(20, layoutH - 56, '[ DEBUG: RESET PROFILE ]', {
      fontSize: '12px', color: CSS.debugRed, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    debugBtn.on('pointerover', () => debugBtn.setColor('#a9685c'));
    debugBtn.on('pointerout', () => debugBtn.setColor(CSS.debugRed));
    debugBtn.on('pointerdown', () => {
      this.debugFeedback.setText('Resetting...').setColor(CSS.gold);
      NetworkManager.track('debug_reset', 'profile');
      NetworkManager.getSocket().emit('debug_reset', { confirm: true });
    });
    this.debugFeedback = this.add.text(20, layoutH - 34, '', {
      fontSize: '11px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5);

    this.activity = new ActivityIndicator(this);

    this.statusText = this.add.text(cx, layoutH - 20, 'connecting…', {
      fontSize: '12px', color: CSS.statusGreen, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    const socket = NetworkManager.connect();
    if (socket.connected) this.statusText.setText(`connected · ${socket.id}`);
    socket.on('connect', () => {
      this.statusText.setText(`connected · ${socket.id}`).setColor(CSS.statusGreen);
    });
    socket.on('disconnect', () => {
      this.statusText.setText('disconnected').setColor(CSS.red);
    });

    this.unsubscribe = ProfileStore.subscribe(() => this.renderProfile());
    this.renderProfile();

    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.activity?.destroy();
    this.activity = null;
    this.factoryBadge?.destroy();
    this.factoryBadge = null;
    this.factoryBadgeTimer?.remove();
    this.factoryBadgeTimer = null;
    const socket = NetworkManager.getSocket();
    socket.off('connect');
    socket.off('disconnect');
  }

  private refreshFactoryBadge(): void {
    if (!this.factoryBadge) return;
    const profile = ProfileStore.get();
    this.factoryBadge.setCount(profile ? totalClaimable(profile) : 0);
  }

  private renderProfile(): void {
    const profile = ProfileStore.get();
    if (!profile) return;

    if (this.debugFeedback && this.debugFeedback.text === 'Resetting...') {
      this.debugFeedback.setText('Profile reset ✓').setColor(CSS.green);
      this.time.delayedCall(1500, () => this.debugFeedback.setText(''));
    }

    this.coinsText.setText(String(profile.coins));
    this.treasureList.setBundle(profile.treasures);
    this.treasureList.rightAlignTo(this.scale.width - 20);
    this.refreshFactoryBadge();

    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    this.heroContainer.removeAll(true);
    if (equipped) {
      this.buildHeroEquipped(equipped);
      this.playBtn.setEnabled(true);
      this.bombermenBtn.setVariant('neutral');
    } else {
      this.buildHeroEmpty();
      this.playBtn.setEnabled(false);
      // Gold focus shifts to hiring a Bomberman.
      this.bombermenBtn.setVariant('gold');
    }
  }

  /** The hero panel frame + EQUIPPED/OPERATIVE tab, drawn into heroContainer. */
  private heroFrame(tab: string): { left: number; right: number } {
    const left = this.scale.width / 2 - PANEL_W / 2;
    const g = this.add.graphics();
    drawNotchedPanel(g, left, HERO_TOP, PANEL_W, HERO_H, {
      fill: COL.panel, border: COL.border, borderWidth: 2, notch: 8,
    });
    this.heroContainer.add(g);
    const { label, bg } = addTabLabel(this, left, HERO_TOP, PANEL_W, tab, { side: 'left' });
    this.heroContainer.add(bg);
    this.heroContainer.add(label);
    return { left, right: left + PANEL_W };
  }

  /** Square portrait box with the figure overscaled to fill it (§1.6). */
  private portraitBox(
    cx: number, cy: number, size: number, bm: OwnedBomberman, silhouette = false,
  ): void {
    const g = this.add.graphics();
    if (silhouette) {
      drawNotchedPanel(g, cx - size / 2, cy - size / 2, size, size, { noFill: true, borderWidth: 0 });
      drawDashedRect(g, cx - size / 2, cy - size / 2, size, size, COL.borderHi, 2, 6, 5);
    } else {
      drawNotchedPanel(g, cx - size / 2, cy - size / 2, size, size, {
        fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 6,
      });
    }
    this.heroContainer.add(g);

    const scale = (size * 2.45) / (128 * 1.5);
    const sprite = createShopBombermanSprite(
      this, cx, cy - size * 0.056, bm.tint, bm.character,
      silhouette ? 'idle' : UiAnimLock.get(bm.id), scale,
    );
    if (silhouette) sprite.setTint(0x000000).setAlpha(0.3);
    // Clip the overscaled figure to the box.
    const mask = this.make.graphics({}, false);
    mask.fillStyle(0xffffff, 1);
    mask.fillRect(cx - size / 2, cy - size / 2, size, size);
    sprite.setMask(mask.createGeometryMask());
    this.heroContainer.add(sprite);
  }

  private buildHeroEquipped(bm: OwnedBomberman): void {
    const { left, right } = this.heroFrame('EQUIPPED');
    const portraitCx = left + 14 + PORTRAIT / 2;
    const portraitCy = HERO_TOP + HERO_H / 2;
    this.portraitBox(portraitCx, portraitCy, PORTRAIT, bm);

    const colX = left + 14 + PORTRAIT + 20;
    const colR = right - 14;
    let y = HERO_TOP + 22;

    // Name + level badge (badge popup opens downward here).
    this.heroContainer.add(this.add.text(colX, y, bm.name ?? '???', {
      fontSize: '18px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0, 0));
    const badgeHost = this.add.container(0, 0);
    this.heroContainer.add(badgeHost);
    attachTierInfoBadge(this, badgeHost, {
      x: colR - 18, y: y + 9, radius: 18,
      tier: bm.tier, level: upgradeLevel(bm), idleAction: bm.idleAction ?? 'attack',
      maxCustomSlots: effectiveMaxCustomSlots(bm), stackSize: effectiveStackSize(bm),
      name: bm.name, sp: bm.sp ?? 0, tooltipSide: 'below',
    });
    y += 36;

    // Class line: class name (class color) — behavior (faint).
    this.heroContainer.add(
      createIdleActionBadge(this, colX, y, bm.idleAction ?? 'attack', '13px').setOrigin(0, 0),
    );
    y += 26;

    // Three stat boxes (HP / CAP / STACK), color-coded.
    const stats: Array<[keyof typeof STAT_HEX, string, string]> = [
      ['hp', 'HP', String(BALANCE.match.bombermanMaxHp)],
      ['cap', 'CAP', String(effectiveMaxCustomSlots(bm))],
      ['stack', 'STACK', String(effectiveStackSize(bm))],
    ];
    const colW = colR - colX;
    const boxGap = 8;
    const boxW = (colW - boxGap * 2) / 3;
    const boxH = 46;
    for (let i = 0; i < stats.length; i++) {
      const [key, lbl, val] = stats[i];
      const bx = colX + i * (boxW + boxGap);
      const bg = this.add.graphics();
      drawNotchedPanel(bg, bx, y, boxW, boxH, { fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 5 });
      this.heroContainer.add(bg);
      this.heroContainer.add(this.add.text(bx + boxW / 2, y + 12, lbl, {
        fontSize: '11px', color: STAT_HEX[key], fontFamily: FONT.silk,
      }).setOrigin(0.5));
      this.heroContainer.add(this.add.text(bx + boxW / 2, y + 30, val, {
        fontSize: '15px', color: STAT_HEX[key], fontFamily: FONT.press,
      }).setOrigin(0.5));
    }
    y += boxH + 10;

    // Experience strip (§1.4): full-width panel2 bar, EXPERIENCE left / N SP right.
    const stripH = 24;
    const strip = this.add.graphics();
    drawNotchedPanel(strip, colX, y, colW, stripH, { fill: COL.panel2, border: COL.border, borderWidth: 1, notch: 4 });
    this.heroContainer.add(strip);
    this.heroContainer.add(this.add.text(colX + 8, y + stripH / 2, 'EXPERIENCE', {
      fontSize: '11px', color: CSS.faint, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setLetterSpacing(2));
    this.heroContainer.add(this.add.text(colX + colW - 8, y + stripH / 2, `${bm.sp ?? 0} SP`, {
      fontSize: '11px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(1, 0.5));
    y += stripH + 10;

    // Loadout row + ▸ UPGRADE link.
    this.heroContainer.add(this.add.text(colX, y + 6, 'LOADOUT', {
      fontSize: '11px', color: CSS.faint, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setLetterSpacing(2));
    const upgrade = linkAction(this, colR, y + 6, '▸ UPGRADE', () => this.scene.start('BombermanShopScene'), 12);
    upgrade.setOrigin(1, 0.5);
    this.heroContainer.add(upgrade);

    let ix = colX + 76;
    for (const slot of bm.inventory.slots) {
      if (!slot) continue;
      this.heroContainer.add(
        this.add.image(ix, y + 4, 'bomb_icons', bombIconFrame(slot.type)).setDisplaySize(26, 26),
      );
      this.heroContainer.add(this.add.text(ix, y + 20, String(slot.count), {
        fontSize: '9px', color: CSS.gold, fontFamily: FONT.silk,
      }).setOrigin(0.5, 0));
      ix += 36;
    }
  }

  private buildHeroEmpty(): void {
    const { left, right } = this.heroFrame('OPERATIVE');
    const portraitCx = left + 14 + PORTRAIT / 2;
    const portraitCy = HERO_TOP + HERO_H / 2;
    // Use any owned template purely for the sprite shape; fall back to char1.
    const ghost: OwnedBomberman = {
      character: 'char1', tint: 0xffffff,
    } as unknown as OwnedBomberman;
    this.portraitBox(portraitCx, portraitCy, PORTRAIT, ghost, true);

    const colX = left + 14 + PORTRAIT + 20;
    const colR = right - 14;
    let y = HERO_TOP + 28;
    this.heroContainer.add(this.add.text(colX, y, 'NO BOMBERMAN', {
      fontSize: '16px', color: CSS.dim, fontFamily: FONT.press,
    }).setOrigin(0, 0));
    y += 34;
    this.heroContainer.add(this.add.text(colX, y, 'Hire your first operative', {
      fontSize: '13px', color: CSS.dim, fontFamily: FONT.silk,
      wordWrap: { width: colR - colX },
    }).setOrigin(0, 0));
    y += 22;
    this.heroContainer.add(this.add.text(colX, y, 'to deploy into a match.', {
      fontSize: '13px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0, 0));
    y += 40;

    const hire = makePixelButton(this, {
      x: (colX + colR) / 2, y: y + 16, w: colR - colX, h: 44,
      label: 'HIRE A BOMBERMAN', variant: 'gold', fontPx: 12,
      onClick: () => this.scene.start('BombermanShopScene'),
    });
    this.heroContainer.add(hire.container);
  }

  private buildTutorialButton(cx: number, cy: number, w: number, h: number): void {
    const left = cx - w / 2;
    const top = cy - h / 2;
    const g = this.add.graphics();
    g.fillStyle(COL.panel2, 1);
    g.fillRect(left, top, w, h);
    drawDashedRect(g, left, top, w, h, COL.tutorialBlue, 2, 6, 4);
    const zone = this.add.zone(cx, cy, w, h).setInteractive({ useHandCursor: true });
    const q = this.add.text(left + 16, cy, '?', {
      fontSize: '18px', color: CSS.blue, fontFamily: FONT.press,
    }).setOrigin(0, 0.5);
    const lbl = this.add.text(left + 40, cy, 'TUTORIAL', {
      fontSize: '14px', color: CSS.blue, fontFamily: FONT.press,
    }).setOrigin(0, 0.5);
    const hint = this.add.text(left + w - 14, cy, 'offline practice match', {
      fontSize: '13px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(1, 0.5);
    const redraw = (hi: boolean) => {
      g.clear();
      g.fillStyle(COL.panel2, 1);
      g.fillRect(left, top, w, h);
      drawDashedRect(g, left, top, w, h, hi ? COL.blue : COL.tutorialBlue, 2, 6, 4);
    };
    zone.on('pointerover', () => { redraw(true); q.setColor('#9bd0ff'); lbl.setColor('#9bd0ff'); });
    zone.on('pointerout', () => { redraw(false); q.setColor(CSS.blue); lbl.setColor(CSS.blue); });
    zone.on('pointerdown', () => this.scene.start('MatchScene', { mode: 'tutorial' }));
    void hint;
  }
}

/** Sum of bombs claimable from every factory right now (projected forward). */
function totalClaimable(profile: PlayerProfile): number {
  const now = Date.now();
  let total = 0;
  for (const id of FACTORY_IDS) {
    total += projectedClaimable(profile.factories[id], FACTORIES[id].cycleDurationMs, now);
  }
  return total;
}
