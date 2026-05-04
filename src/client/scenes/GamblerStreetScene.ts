import Phaser from 'phaser';
import { GamblerStreetStore, ProfileStore } from '../ClientState.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons, treasureIconFrame, TREASURE_TEXTURE_KEY } from '../systems/TreasureIcons.ts';
import { NetworkManager } from '../NetworkManager.ts';
import {
  GAMBLER_STREET_GLOBAL,
  type BetTier,
} from '@shared/config/gambler-street.ts';
import {
  TREASURE_DISPLAY_NAMES,
  type TreasureType,
} from '@shared/config/treasures.ts';
import type { BetOutcome, GamblerSlot } from '@shared/types/gambler-street.ts';
import type { GamblerStreetBetResultMsg } from '@shared/types/messages.ts';

const TUTORIAL_GUY_KEY = 'gambler_face_default';
const TUTORIAL_GUY_PATH = 'sprites/tutorial_guy.png';
const CONFETTI_TEX_KEY = 'gambler_confetti_particle';

const STALL_GAP = 16;
const STALL_BAND_TOP = 130;
const STALL_BAND_HEIGHT = 270;
const STALL_MAX_WIDTH = 240;

const DRAWER_GAP = 24;
const DRAWER_HEIGHT = 280;
const DRAWER_MARGIN_X = 80;

const REVEAL_AUTO_DISMISS_MS = 3000;
const REJECTION_AUTO_DISMISS_MS = 2000;

const STAGE_CROSSFADE_MS = 150;
const DRAWER_SLIDE_MS = 200;

// Palette is harvested from MainMenuScene / BombermanShopScene / BombsShopScene
// so the chrome reads as the same UI family. No new tokens introduced.
const COLORS = {
  // Stalls / drawer surface
  cardBg: 0x1a1a2e,
  cardBorder: 0x333355,
  cardBorderHover: 0x556699,
  cardBorderSelected: 0x88aacc,
  cardCooldownBg: 0x141420,
  cardCooldownBorder: 0x2a2a44,
  awning: 0x442233,
  pin: 0x88aacc,

  // Drawer
  drawerBg: 0x1a1a2e,
  drawerBorder: 0x556699,
  scrim: 0x000000,

  // Buttons (matched to MainMenu/BombermanShop primary action button)
  btnPrimary: 0x222244,
  btnPrimaryHover: 0x334466,
  btnDanger: 0x442233,
  btnDangerHover: 0x664455,
  btnDisabled: 0x222226,

  // Text
  textTitle: '#e0e0e0',
  textPrimary: '#ffffff',
  textSecondary: '#aaaaaa',
  textMuted: '#888888',
  textDim: '#666666',
  textCoin: '#ffd944',
  textWin: '#44ff88',
  textLoss: '#ff6644',
  textBlue: '#44aaff',
  textBlueHover: '#88ccff',
  textDisabled: '#555566',

  // Lifespan bar
  lifespanFill: 0x88aacc,
  lifespanFillLow: 0xff6644,
  lifespanTrack: 0x2a2a44,
} as const;

type DrawerStage = 'bet' | 'hand' | 'reveal';

interface DrawerData {
  slotIndex: number;
  stage: DrawerStage;
  tier: BetTier | null;
  pickedHand: 'left' | 'right' | null;
  outcome: BetOutcome | null;
  rejected: boolean;
  rejectionReason: string | null;
}

interface StallView {
  container: Phaser.GameObjects.Container;
  hitZone: Phaser.GameObjects.Zone | null;
  border: Phaser.GameObjects.Rectangle;
  pin: Phaser.GameObjects.Triangle | null;
  lifespanFill: Phaser.GameObjects.Rectangle | null;
  lifespanCreatedAt: number;
  lifespanExpiresAt: number;
  cooldownText: Phaser.GameObjects.Text | null;
  cooldownReadyAt: number;
}

/**
 * Gambler Street main scene.
 *
 * Five stalls in a horizontal row. Clicking an active stall opens an
 * in-scene drawer below the row that runs through bet → hand → reveal,
 * then slides closed and is destroyed. The drawer replaces the old
 * GamblerStreetPopupScene; nothing else uses parallel scene chrome here.
 *
 * Server protocol is unchanged from the previous design:
 *   C→S `gambler_street_bet { slotIndex, tier, pickedHand }`
 *   S→C `gambler_street_bet_result { ok, outcome, state, reason }`
 */
export class GamblerStreetScene extends Phaser.Scene {
  private treasureList!: TreasureListWidget;
  private coinsText!: Phaser.GameObjects.Text;
  private subHeaderText!: Phaser.GameObjects.Text;

  private stallRow!: Phaser.GameObjects.Container;
  private stallViews: StallView[] = [];

  private drawer: Phaser.GameObjects.Container | null = null;
  private drawerData: DrawerData | null = null;
  private drawerBody: Phaser.GameObjects.Container | null = null;
  private drawerHeaderTitle: Phaser.GameObjects.Text | null = null;
  private drawerHeaderSubtitle: Phaser.GameObjects.Text | null = null;
  private autoDismissTimer: Phaser.Time.TimerEvent | null = null;
  private confettiEmitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];

  private pollTimer: Phaser.Time.TimerEvent | null = null;
  private unsubscribeStreet: (() => void) | null = null;
  private unsubscribeProfile: (() => void) | null = null;

  /** Cached layout — recomputed on resize. */
  private viewport = { width: 0, height: 0 };
  private stallSize = { w: 0, h: 0 };
  private drawerY = 0;

  constructor() {
    super({ key: 'GamblerStreetScene' });
  }

  preload(): void {
    preloadTreasureIcons(this);
    if (!this.textures.exists(TUTORIAL_GUY_KEY)) {
      this.load.image(TUTORIAL_GUY_KEY, TUTORIAL_GUY_PATH);
    }
    if (!this.textures.exists(CONFETTI_TEX_KEY)) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 8, 8);
      g.generateTexture(CONFETTI_TEX_KEY, 8, 8);
      g.destroy();
    }
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);

    const { width, height } = this.scale;
    this.viewport = { width, height };

    // Top bar — back-button left, title + sub-header center, coins + treasure right.
    const backBtn = this.add.text(20, 30, '[ < BACK ]', {
      fontSize: '16px', color: COLORS.textMuted, fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#cccccc'));
    backBtn.on('pointerout', () => backBtn.setColor(COLORS.textMuted));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    this.add.text(width / 2, 40, 'GAMBLER STREET', {
      fontSize: '32px', color: COLORS.textTitle, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.subHeaderText = this.add.text(
      width / 2, 75,
      'Five gamblers waiting. Will fortune favour you tonight?',
      {
        fontSize: '14px', color: COLORS.textMuted, fontFamily: 'monospace', fontStyle: 'italic',
      },
    ).setOrigin(0.5);

    this.coinsText = this.add.text(width / 2, 102, '', {
      fontSize: '20px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.treasureList = new TreasureListWidget(this, {
      x: width - 20, y: 20, anchor: 'top-right', iconScale: 1.0, fontSize: 16,
    });

    // Stall row container — built once, contents rebuilt on store changes.
    this.stallRow = this.add.container(0, 0);

    // Esc key — close drawer if open, else back to main menu.
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.drawer) this.closeDrawer();
      else this.scene.start('MainMenuScene');
    });

    // Subscribe to stores
    this.unsubscribeStreet = GamblerStreetStore.subscribe(() => this.renderStalls());
    this.unsubscribeProfile = ProfileStore.subscribe(() => this.renderProfileBits());
    this.renderProfileBits();

    NetworkManager.getSocket().emit('gambler_street_request', {});
    this.pollTimer = this.time.addEvent({
      delay: 1000, loop: true, callback: this.tickPoll, callbackScope: this,
    });

    this.computeLayout();
    this.renderStalls();
  }

  shutdown(): void {
    this.input.keyboard?.removeAllListeners('keydown-ESC');
    this.unsubscribeStreet?.();
    this.unsubscribeProfile?.();
    this.unsubscribeStreet = null;
    this.unsubscribeProfile = null;
    this.pollTimer?.remove(false);
    this.pollTimer = null;
    this.autoDismissTimer?.remove(false);
    this.autoDismissTimer = null;
    this.treasureList?.destroy();
    this.destroyDrawer();
    this.stallViews = [];
    // NOTE: do NOT `socket.off('gambler_street_bet_result')` here — that would
    // strip the global store-sync handler in NetworkManager.ts. Pending
    // once-handlers carry a reference to drawerData and self-cancel via the
    // `this.drawerData !== myData` guard if the drawer is gone.
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Layout
  // ───────────────────────────────────────────────────────────────────────────

  private computeLayout(): void {
    const { width } = this.viewport;
    const slotCount = GAMBLER_STREET_GLOBAL.slotCount;
    // Reserve some side margin and divide remaining width across the slots.
    const margin = 40;
    const usable = width - margin * 2;
    const stallW = Math.min(STALL_MAX_WIDTH, (usable - STALL_GAP * (slotCount - 1)) / slotCount);
    this.stallSize = { w: Math.floor(stallW), h: STALL_BAND_HEIGHT };
    this.drawerY = STALL_BAND_TOP + STALL_BAND_HEIGHT + DRAWER_GAP + DRAWER_HEIGHT / 2;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Profile / coins / treasure refresh
  // ───────────────────────────────────────────────────────────────────────────

  private renderProfileBits(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`${profile.coins} coins`);
    this.treasureList.setBundle(profile.treasures);

    // Disabled-state of bet-tier cards depends on owned treasure — refresh
    // drawer body if it's currently in `bet` stage.
    if (this.drawer && this.drawerData?.stage === 'bet') {
      this.renderDrawerBody();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Poll loop
  // ───────────────────────────────────────────────────────────────────────────

  private tickPoll = (): void => {
    const state = GamblerStreetStore.get();
    const now = Date.now();
    if (!state || (now - (state.lastTickedAt ?? 0)) > 4000) {
      NetworkManager.getSocket().emit('gambler_street_request', {});
    }
    this.refreshTimers();
  };

  /** Refresh lifespan bars + cooldown countdown text without rebuilding. */
  private refreshTimers(): void {
    const now = Date.now();
    for (const view of this.stallViews) {
      if (view.lifespanFill) {
        const total = Math.max(1, view.lifespanExpiresAt - view.lifespanCreatedAt);
        const remaining = Math.max(0, view.lifespanExpiresAt - now);
        const ratio = Math.min(1, remaining / total);
        const fullW = this.stallSize.w - 24;
        view.lifespanFill.width = fullW * ratio;
        view.lifespanFill.fillColor = ratio < 0.15 ? COLORS.lifespanFillLow : COLORS.lifespanFill;
      }
      if (view.cooldownText) {
        view.cooldownText.setText(formatCountdown(view.cooldownReadyAt - now));
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stall row
  // ───────────────────────────────────────────────────────────────────────────

  private renderStalls(): void {
    this.stallRow.removeAll(true);
    this.stallViews = [];

    const state = GamblerStreetStore.get();
    if (!state) {
      const loading = this.add.text(this.viewport.width / 2, STALL_BAND_TOP + 80, 'Loading…', {
        fontSize: '16px', color: COLORS.textDim, fontFamily: 'monospace',
      }).setOrigin(0.5);
      this.stallRow.add(loading);
      return;
    }

    const { width } = this.viewport;
    const { w: stallW } = this.stallSize;
    const slotCount = state.slots.length;
    const totalW = slotCount * stallW + (slotCount - 1) * STALL_GAP;
    const startX = (width - totalW) / 2;

    for (let i = 0; i < slotCount; i++) {
      const slot = state.slots[i];
      const x = startX + i * (stallW + STALL_GAP);
      const view = this.buildStall(x, STALL_BAND_TOP, slot, i);
      this.stallViews.push(view);
      this.stallRow.add(view.container);
    }

    this.applyStallStates();
    this.refreshTimers();
  }

  private buildStall(x: number, y: number, slot: GamblerSlot, index: number): StallView {
    const w = this.stallSize.w;
    const h = this.stallSize.h;
    const container = this.add.container(x + w / 2, y + h / 2);

    const isActive = slot.kind === 'gambler';
    const bg = this.add.rectangle(0, 0, w, h, isActive ? COLORS.cardBg : COLORS.cardCooldownBg, 1);
    container.add(bg);
    const border = this.add.rectangle(0, 0, w, h);
    border.setFillStyle(0x000000, 0).setStrokeStyle(2, isActive ? COLORS.cardBorder : COLORS.cardCooldownBorder, 1);
    container.add(border);

    let pin: Phaser.GameObjects.Triangle | null = null;
    let lifespanFill: Phaser.GameObjects.Rectangle | null = null;
    let cooldownText: Phaser.GameObjects.Text | null = null;
    let lifespanCreatedAt = 0;
    let lifespanExpiresAt = 0;
    let cooldownReadyAt = 0;

    if (slot.kind === 'gambler') {
      const g = slot.gambler;

      // Awning strip across the top
      const awningH = 8;
      const awning = this.add.rectangle(0, -h / 2 + awningH / 2, w - 4, awningH, COLORS.awning, 1);
      container.add(awning);

      // Avatar — tutorial_guy with per-id deterministic tint
      const avatarSize = Math.min(120, w - 32);
      const avatar = this.add.image(0, -h / 2 + awningH + 12 + avatarSize / 2, TUTORIAL_GUY_KEY);
      avatar.setDisplaySize(avatarSize, avatarSize);
      avatar.setTint(tintForGamblerId(g.id));
      container.add(avatar);

      // Name (single line, ellipsis on overflow)
      const nameY = avatar.y + avatarSize / 2 + 8;
      const name = this.add.text(0, nameY, ellipsize(g.name, Math.floor(w / 9)), {
        fontSize: '14px', color: COLORS.textPrimary, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      container.add(name);

      // Ask line: "wants {N} {treasureIcon}"
      const askY = nameY + 24;
      const askLabel = this.add.text(-w / 2 + 14, askY, `wants ${g.treasureAmount}`, {
        fontSize: '12px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      container.add(askLabel);
      const askIcon = this.add.image(askLabel.x + askLabel.width + 6, askY, TREASURE_TEXTURE_KEY, treasureIconFrame(g.treasureType));
      askIcon.setOrigin(0, 0.5).setDisplaySize(18, 18);
      container.add(askIcon);

      // Reward line: "win {N} coins"
      const rewardY = askY + 22;
      const reward = this.add.text(-w / 2 + 14, rewardY, `win ${g.coinReward} coins`, {
        fontSize: '12px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0.5);
      container.add(reward);

      // Lifespan bar (bottom edge)
      const barY = h / 2 - 14;
      const barW = w - 24;
      const barTrack = this.add.rectangle(0, barY, barW, 4, COLORS.lifespanTrack, 1);
      container.add(barTrack);
      lifespanFill = this.add.rectangle(-barW / 2, barY, barW, 4, COLORS.lifespanFill, 1).setOrigin(0, 0.5);
      container.add(lifespanFill);
      lifespanCreatedAt = g.createdAt;
      lifespanExpiresAt = g.expiresAt;

      // Selected pin (hidden until applyStallStates)
      pin = this.add.triangle(0, h / 2 + 8, 0, 0, 12, 0, 6, -8, COLORS.pin);
      pin.setVisible(false);
      container.add(pin);
    } else {
      // Cooldown stall: hourglass + "next gambler in mm:ss"
      const hg = this.add.graphics();
      drawHourglass(hg, COLORS.textMuted);
      hg.setPosition(0, -22);
      container.add(hg);

      const lbl = this.add.text(0, 30, 'next gambler in', {
        fontSize: '12px', color: COLORS.textMuted, fontFamily: 'monospace',
      }).setOrigin(0.5);
      container.add(lbl);
      cooldownText = this.add.text(0, 52, formatCountdown(slot.readyAt - Date.now()), {
        fontSize: '20px', color: COLORS.textSecondary, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      container.add(cooldownText);
      cooldownReadyAt = slot.readyAt;
    }

    // Hit zone — only added for active stalls (cooldowns aren't clickable)
    let hitZone: Phaser.GameObjects.Zone | null = null;
    if (isActive) {
      hitZone = this.add.zone(0, 0, w, h);
      hitZone.setInteractive({ useHandCursor: true });
      hitZone.on('pointerdown', () => this.onStallClicked(index));
      hitZone.on('pointerover', () => this.onStallHover(index, true));
      hitZone.on('pointerout', () => this.onStallHover(index, false));
      container.add(hitZone);
    }

    return {
      container,
      hitZone,
      border,
      pin,
      lifespanFill,
      lifespanCreatedAt,
      lifespanExpiresAt,
      cooldownText,
      cooldownReadyAt,
    };
  }

  /** Apply hover/selected/dimmed states to all stalls based on drawer state. */
  private applyStallStates(): void {
    const selectedIdx = this.drawerData?.slotIndex ?? null;
    const drawerLocked = this.drawerData ? this.drawerData.stage !== 'bet' : false;

    for (let i = 0; i < this.stallViews.length; i++) {
      const view = this.stallViews[i];
      const isSelected = i === selectedIdx;
      const isDimmed = selectedIdx !== null && !isSelected;

      view.container.setAlpha(isDimmed ? 0.55 : 1);
      view.pin?.setVisible(isSelected);
      if (isSelected) {
        view.border.setStrokeStyle(2, COLORS.cardBorderSelected, 1);
      } else if (view.hitZone) {
        view.border.setStrokeStyle(2, COLORS.cardBorder, 1);
      } else {
        view.border.setStrokeStyle(2, COLORS.cardCooldownBorder, 1);
      }

      // Stalls become non-interactive once the drawer is locked past bet stage.
      // They still render dimmed, just don't react to clicks.
      if (view.hitZone) {
        if (drawerLocked) view.hitZone.disableInteractive();
        else view.hitZone.setInteractive({ useHandCursor: true });
      }
    }
  }

  private onStallHover(index: number, over: boolean): void {
    const view = this.stallViews[index];
    if (!view) return;
    const selectedIdx = this.drawerData?.slotIndex ?? null;
    if (index === selectedIdx) return; // selected style wins
    view.border.setStrokeStyle(2, over ? COLORS.cardBorderHover : COLORS.cardBorder, 1);
  }

  private onStallClicked(index: number): void {
    if (this.drawerData) {
      // Drawer is open
      if (this.drawerData.stage !== 'bet') return; // locked past bet stage
      if (this.drawerData.slotIndex === index) {
        // Click selected stall = close
        this.closeDrawer();
        return;
      }
      // Different stall in bet stage = retarget
      this.retargetDrawer(index);
      return;
    }
    this.openDrawer(index);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Drawer lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  private openDrawer(slotIndex: number): void {
    const state = GamblerStreetStore.get();
    if (!state) return;
    const slot = state.slots[slotIndex];
    if (!slot || slot.kind !== 'gambler') return;

    this.drawerData = {
      slotIndex,
      stage: 'bet',
      tier: null,
      pickedHand: null,
      outcome: null,
      rejected: false,
      rejectionReason: null,
    };

    const drawerW = this.viewport.width - DRAWER_MARGIN_X * 2;
    const drawer = this.add.container(this.viewport.width / 2, this.drawerY);

    // Slide-in: start below the screen and tween into place
    drawer.setAlpha(0);
    drawer.y = this.drawerY + 80;

    const bg = this.add.rectangle(0, 0, drawerW, DRAWER_HEIGHT, COLORS.drawerBg, 1)
      .setStrokeStyle(2, COLORS.drawerBorder, 1);
    drawer.add(bg);

    // Header (gambler name + sub-line + close button)
    this.drawerHeaderTitle = this.add.text(-drawerW / 2 + 24, -DRAWER_HEIGHT / 2 + 24, '', {
      fontSize: '20px', color: COLORS.textPrimary, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    drawer.add(this.drawerHeaderTitle);

    this.drawerHeaderSubtitle = this.add.text(-drawerW / 2 + 24, -DRAWER_HEIGHT / 2 + 50, '', {
      fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
    }).setOrigin(0, 0);
    drawer.add(this.drawerHeaderSubtitle);

    const closeBtn = this.add.text(drawerW / 2 - 18, -DRAWER_HEIGHT / 2 + 12, '✕', {
      fontSize: '22px', color: COLORS.textMuted, fontFamily: 'monospace',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor(COLORS.textMuted));
    closeBtn.on('pointerdown', () => this.closeDrawer());
    drawer.add(closeBtn);

    // Body container — holds stage-specific content. Crossfaded between stages.
    this.drawerBody = this.add.container(0, 14);
    drawer.add(this.drawerBody);

    this.drawer = drawer;

    this.tweens.add({
      targets: drawer, y: this.drawerY, alpha: 1,
      duration: DRAWER_SLIDE_MS, ease: 'Quad.easeOut',
    });

    this.renderDrawerHeader();
    this.renderDrawerBody();
    this.applyStallStates();
  }

  private retargetDrawer(slotIndex: number): void {
    if (!this.drawerData) return;
    const state = GamblerStreetStore.get();
    if (!state) return;
    const slot = state.slots[slotIndex];
    if (!slot || slot.kind !== 'gambler') return;

    this.drawerData.slotIndex = slotIndex;
    this.drawerData.tier = null;
    this.drawerData.pickedHand = null;
    this.renderDrawerHeader();
    this.renderDrawerBody();
    this.applyStallStates();
  }

  private closeDrawer(): void {
    if (!this.drawer) return;
    const drawer = this.drawer;
    this.drawer = null;
    this.drawerData = null;
    this.autoDismissTimer?.remove(false);
    this.autoDismissTimer = null;

    // Pending bet-result once-handlers self-cancel via their drawerData
    // identity guard — see `pickHand`. Removing all listeners here would
    // clobber the global store-sync handler in NetworkManager.ts.

    // Clean up any active confetti
    for (const e of this.confettiEmitters) e.destroy();
    this.confettiEmitters = [];

    this.tweens.add({
      targets: drawer,
      y: drawer.y + 80,
      alpha: 0,
      duration: DRAWER_SLIDE_MS,
      ease: 'Quad.easeIn',
      onComplete: () => drawer.destroy(),
    });

    this.applyStallStates();
  }

  /** Hard destroy — used in shutdown(). No animation. */
  private destroyDrawer(): void {
    if (this.drawer) {
      this.drawer.destroy();
      this.drawer = null;
    }
    this.drawerData = null;
    this.drawerBody = null;
    this.drawerHeaderTitle = null;
    this.drawerHeaderSubtitle = null;
    for (const e of this.confettiEmitters) e.destroy();
    this.confettiEmitters = [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Drawer rendering
  // ───────────────────────────────────────────────────────────────────────────

  private currentGamblerSlot(): GamblerSlot & { kind: 'gambler' } | null {
    const data = this.drawerData;
    const state = GamblerStreetStore.get();
    if (!data || !state) return null;
    const slot = state.slots[data.slotIndex];
    if (!slot || slot.kind !== 'gambler') return null;
    return slot;
  }

  private renderDrawerHeader(): void {
    const slot = this.currentGamblerSlot();
    if (!slot || !this.drawerHeaderTitle || !this.drawerHeaderSubtitle) return;
    const g = slot.gambler;

    this.drawerHeaderTitle.setText(g.name);
    const treasureName = TREASURE_DISPLAY_NAMES[g.treasureType];
    const baseSubtitle = `wants ${g.treasureAmount} ${treasureName} · pays ${g.coinReward} coins on a win`;
    if (this.drawerData?.tier) {
      const cost = this.drawerData.tier === 'cheap'
        ? g.treasureAmount * GAMBLER_STREET_GLOBAL.betTiers.cheap.costMultiplier
        : g.treasureAmount * GAMBLER_STREET_GLOBAL.betTiers.premium.costMultiplier;
      this.drawerHeaderSubtitle.setText(
        `paid ${cost} ${treasureName} — which hand has the coins?`,
      );
    } else {
      this.drawerHeaderSubtitle.setText(baseSubtitle);
    }
  }

  private renderDrawerBody(): void {
    if (!this.drawerBody || !this.drawerData) return;
    const body = this.drawerBody;
    const oldChildren = body.list.slice();

    // Build new content first, then crossfade
    const fresh = this.add.container(0, 0);
    fresh.setAlpha(0);
    body.add(fresh);

    if (this.drawerData.stage === 'bet') {
      this.buildBetStage(fresh);
    } else if (this.drawerData.stage === 'hand') {
      this.buildHandStage(fresh);
    } else {
      this.buildRevealStage(fresh);
    }

    if (oldChildren.length === 0) {
      fresh.setAlpha(1);
      return;
    }

    // Crossfade
    this.tweens.add({
      targets: fresh, alpha: 1,
      duration: STAGE_CROSSFADE_MS, ease: 'Linear',
    });
    this.tweens.add({
      targets: oldChildren, alpha: 0,
      duration: STAGE_CROSSFADE_MS, ease: 'Linear',
      onComplete: () => {
        for (const c of oldChildren) c.destroy();
      },
    });
  }

  private buildBetStage(parent: Phaser.GameObjects.Container): void {
    const slot = this.currentGamblerSlot();
    if (!slot) return;
    const g = slot.gambler;
    const profile = ProfileStore.get();
    const owned = profile?.treasures[g.treasureType] ?? 0;

    const cheap = GAMBLER_STREET_GLOBAL.betTiers.cheap;
    const premium = GAMBLER_STREET_GLOBAL.betTiers.premium;
    const cheapCost = g.treasureAmount * cheap.costMultiplier;
    const premiumCost = g.treasureAmount * premium.costMultiplier;
    const canCheap = owned >= cheapCost;
    const canPremium = owned >= premiumCost;
    const treasureName = TREASURE_DISPLAY_NAMES[g.treasureType];

    const cardW = 320;
    const cardH = 170;
    const gap = 32;

    const cheapCard = this.buildBetCard(
      -cardW / 2 - gap / 2, 30,
      cardW, cardH,
      'Cheap',
      cheapCost, treasureName, g.treasureType,
      cheap.winChance, g.coinReward,
      '2 min cooldown after',
      canCheap, COLORS.btnPrimary, COLORS.btnPrimaryHover,
      () => this.pickTier('cheap'),
    );
    const premiumCard = this.buildBetCard(
      cardW / 2 + gap / 2, 30,
      cardW, cardH,
      'Premium',
      premiumCost, treasureName, g.treasureType,
      premium.winChance, g.coinReward,
      'safer odds, same prize',
      canPremium, COLORS.btnDanger, COLORS.btnDangerHover,
      () => this.pickTier('premium'),
    );
    parent.add([cheapCard, premiumCard]);

    if (!canCheap && !canPremium) {
      const help = this.add.text(0, 138, `Not enough ${treasureName}. Come back with more loot.`, {
        fontSize: '12px', color: COLORS.textDim, fontFamily: 'monospace', fontStyle: 'italic',
      }).setOrigin(0.5);
      parent.add(help);
    }
  }

  private buildBetCard(
    x: number, y: number, w: number, h: number,
    tierLabel: string,
    cost: number, treasureName: string, treasureType: TreasureType,
    winChance: number, coinReward: number,
    footerHint: string,
    enabled: boolean,
    bgColor: number, hoverColor: number,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const fill = enabled ? bgColor : COLORS.btnDisabled;
    const bg = this.add.rectangle(0, 0, w, h, fill, 1)
      .setStrokeStyle(1, COLORS.cardBorder, 1);
    c.add(bg);

    const tier = this.add.text(0, -h / 2 + 18, tierLabel.toUpperCase(), {
      fontSize: '13px', color: enabled ? COLORS.textSecondary : COLORS.textDisabled,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    c.add(tier);

    // Cost line: "{N} {icon}"
    const costText = this.add.text(-12, -h / 2 + 50, String(cost), {
      fontSize: '28px', color: enabled ? COLORS.textCoin : COLORS.textDisabled,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    c.add(costText);
    const costIcon = this.add.image(0, -h / 2 + 50, TREASURE_TEXTURE_KEY, treasureIconFrame(treasureType));
    costIcon.setOrigin(0, 0.5).setDisplaySize(28, 28);
    if (!enabled) costIcon.setAlpha(0.4);
    c.add(costIcon);
    const costLabel = this.add.text(34, -h / 2 + 50, treasureName, {
      fontSize: '14px', color: enabled ? COLORS.textSecondary : COLORS.textDisabled, fontFamily: 'monospace',
    }).setOrigin(0, 0.5);
    c.add(costLabel);

    // Win chance line
    const chanceText = this.add.text(0, 0, `${Math.round(winChance * 100)}% chance`, {
      fontSize: '16px', color: enabled ? COLORS.textPrimary : COLORS.textDisabled, fontFamily: 'monospace',
    }).setOrigin(0.5);
    c.add(chanceText);

    // Reward + footer
    const reward = this.add.text(0, h / 2 - 38, `${coinReward} coins on win`, {
      fontSize: '13px', color: enabled ? COLORS.textCoin : COLORS.textDisabled,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    c.add(reward);
    const footer = this.add.text(0, h / 2 - 18, footerHint, {
      fontSize: '11px', color: enabled ? COLORS.textMuted : COLORS.textDisabled,
      fontFamily: 'monospace', fontStyle: 'italic',
    }).setOrigin(0.5);
    c.add(footer);

    if (enabled) {
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => bg.setFillStyle(hoverColor, 1));
      bg.on('pointerout', () => bg.setFillStyle(bgColor, 1));
      bg.on('pointerdown', () => {
        bg.setFillStyle(bgColor, 1);
        onClick();
      });
    }
    return c;
  }

  private buildHandStage(parent: Phaser.GameObjects.Container): void {
    const slot = this.currentGamblerSlot();
    if (!slot) return;

    const handsY = 30;
    const handGap = 220;
    const left = this.buildHandPicker(-handGap / 2, handsY, 'left', false);
    const right = this.buildHandPicker(handGap / 2, handsY, 'right', true);
    parent.add([left, right]);

    const prompt = this.add.text(0, 132, 'Pick a hand.', {
      fontSize: '14px', color: COLORS.textSecondary, fontFamily: 'monospace', fontStyle: 'italic',
    }).setOrigin(0.5);
    parent.add(prompt);
  }

  private buildHandPicker(
    x: number, y: number,
    hand: 'left' | 'right',
    mirror: boolean,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const w = 160;
    const h = 170;
    const bg = this.add.rectangle(0, 0, w, h, COLORS.btnPrimary, 1)
      .setStrokeStyle(1, COLORS.cardBorder, 1);
    c.add(bg);

    const hand_g = this.add.graphics();
    drawHand(hand_g, COLORS.textBlue);
    const handHolder = this.add.container(0, -10, [hand_g]);
    if (mirror) handHolder.setScale(-1, 1);
    c.add(handHolder);

    const label = this.add.text(0, h / 2 - 22, hand.toUpperCase(), {
      fontSize: '18px', color: COLORS.textBlue, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    c.add(label);

    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => {
      bg.setFillStyle(COLORS.btnPrimaryHover, 1);
      label.setColor(COLORS.textBlueHover);
    });
    bg.on('pointerout', () => {
      bg.setFillStyle(COLORS.btnPrimary, 1);
      label.setColor(COLORS.textBlue);
    });
    bg.on('pointerdown', () => {
      bg.setFillStyle(COLORS.btnPrimary, 1);
      this.pickHand(hand);
    });

    return c;
  }

  private buildRevealStage(parent: Phaser.GameObjects.Container): void {
    const data = this.drawerData;
    if (!data) return;

    if (data.rejected) {
      const txt = this.add.text(0, 60, data.rejectionReason ?? 'They walked away.', {
        fontSize: '20px', color: COLORS.textLoss, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      parent.add(txt);
      return;
    }

    if (!data.outcome) {
      // Shouldn't happen, but guard anyway
      const txt = this.add.text(0, 60, 'Rolling…', {
        fontSize: '20px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0.5);
      parent.add(txt);
      return;
    }

    const outcome = data.outcome;
    const slot = this.currentGamblerSlot();
    const treasureName = slot ? TREASURE_DISPLAY_NAMES[outcome.treasureType] : '';

    // Left: chosen hand opening with/without coin
    const handFrameW = 220;
    const handFrameH = 170;
    const handFrame = this.add.container(-handFrameW / 2 - 24, 30);
    const frameBg = this.add.rectangle(0, 0, handFrameW, handFrameH,
      outcome.won ? 0x113322 : 0x331a1a, 1)
      .setStrokeStyle(2, outcome.won ? 0x44ff88 : 0xff6644, 1);
    handFrame.add(frameBg);

    const hand_g = this.add.graphics();
    drawHand(hand_g, outcome.won ? COLORS.textWin : COLORS.textLoss);
    const handHolder = this.add.container(0, -10, [hand_g]);
    if (data.pickedHand === 'right') handHolder.setScale(-1, 1);
    handFrame.add(handHolder);

    if (outcome.won) {
      const coin = this.add.text(0, 35, String(outcome.coinsGained), {
        fontSize: '24px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      handFrame.add(coin);
      const coinLbl = this.add.text(0, 60, 'coins', {
        fontSize: '12px', color: COLORS.textCoin, fontFamily: 'monospace',
      }).setOrigin(0.5);
      handFrame.add(coinLbl);
    }
    parent.add(handFrame);

    // Right: result text — anchored to the same vertical center as the hand frame
    const textX = handFrameW / 2 + 24 - handFrameW / 2;
    const textContainer = this.add.container(textX, 30);
    const headline = outcome.won ? 'Fortune smiles!' : 'Empty hand';
    const headlineText = this.add.text(0, -10, headline, {
      fontSize: '24px', color: outcome.won ? COLORS.textWin : COLORS.textLoss,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    textContainer.add(headlineText);

    const bodyCopy = outcome.won
      ? `the ${outcome.correctHand} hand held the prize.\n+${outcome.coinsGained} coins added to your purse.`
      : `the prize was in the ${outcome.correctHand} hand.\nyou lost ${outcome.treasurePaid} ${treasureName}.`;
    const bodyText = this.add.text(0, 26, bodyCopy, {
      fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      lineSpacing: 4, wordWrap: { width: 280 },
    }).setOrigin(0, 0);
    textContainer.add(bodyText);
    parent.add(textContainer);

    // Done button
    const doneBtn = this.add.text(0, 130, '[ DONE ]', {
      fontSize: '16px', color: COLORS.textBlue, fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#222244', padding: { x: 18, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    doneBtn.on('pointerover', () => doneBtn.setColor(COLORS.textBlueHover));
    doneBtn.on('pointerout', () => doneBtn.setColor(COLORS.textBlue));
    doneBtn.on('pointerdown', () => this.closeDrawer());
    parent.add(doneBtn);

    // Confetti — scaled down to fit the drawer reveal frame (D2)
    this.fireConfetti(outcome.won ? 'gold' : 'grey');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stage transitions
  // ───────────────────────────────────────────────────────────────────────────

  private pickTier(tier: BetTier): void {
    if (!this.drawerData || this.drawerData.stage !== 'bet') return;
    this.drawerData.tier = tier;
    this.drawerData.stage = 'hand';
    this.renderDrawerHeader();
    this.renderDrawerBody();
    this.applyStallStates();
  }

  private pickHand(hand: 'left' | 'right'): void {
    if (!this.drawerData || this.drawerData.stage !== 'hand') return;
    if (!this.drawerData.tier) return;
    const slotIndex = this.drawerData.slotIndex;
    const tier = this.drawerData.tier;

    this.drawerData.pickedHand = hand;
    this.drawerData.stage = 'reveal';

    // Capture the current drawer-data reference so the response handler can
    // detect a stale callback (drawer cancelled, or a new drawer opened) and
    // no-op cleanly. The global store-sync handler in NetworkManager.ts still
    // updates state independently of this one.
    const myData = this.drawerData;
    const socket = NetworkManager.getSocket();
    socket.once('gambler_street_bet_result', (msg: GamblerStreetBetResultMsg) => {
      if (this.drawerData !== myData) return; // drawer closed or replaced
      if (msg.ok && msg.outcome) {
        myData.outcome = msg.outcome;
      } else {
        myData.rejected = true;
        myData.rejectionReason = msg.reason ?? 'They walked away.';
      }
      this.renderDrawerBody();
      this.scheduleAutoDismiss(myData.rejected
        ? REJECTION_AUTO_DISMISS_MS
        : REVEAL_AUTO_DISMISS_MS);
    });
    NetworkManager.track('gambler_street_bet', 'gambler_street_bet_result');
    socket.emit('gambler_street_bet', { slotIndex, tier, pickedHand: hand });

    // Show "Rolling…" until the response arrives
    this.renderDrawerBody();
    this.applyStallStates();
  }

  private scheduleAutoDismiss(delay: number): void {
    this.autoDismissTimer?.remove(false);
    this.autoDismissTimer = this.time.delayedCall(delay, () => this.closeDrawer());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Confetti (scaled down from the popup version per D2)
  // ───────────────────────────────────────────────────────────────────────────

  private fireConfetti(palette: 'gold' | 'grey'): void {
    const colors = palette === 'gold'
      ? [0xffd944, 0xffaa44, 0xffe88a, 0xc4a566, 0xffe4a0, 0xff8844]
      : [0xaaaaaa, 0x888888, 0x666666, 0x555555, 0x444444];

    // Bursts originate from the drawer's left/right edges
    const drawerW = this.viewport.width - DRAWER_MARGIN_X * 2;
    const burstY = this.drawerY;
    const leftX = this.viewport.width / 2 - drawerW / 2;
    const rightX = this.viewport.width / 2 + drawerW / 2;
    const burstCount = 18; // half the popup version

    const baseConfig = {
      lifespan: 1200,
      gravityY: 700,
      scale: { start: 1.0, end: 0.4 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 1, end: 0 },
      speed: { min: 220, max: 440 },
      quantity: 1,
      frequency: -1,
      tint: { onEmit: () => Phaser.Math.RND.pick(colors) },
      emitting: false,
    } as const;

    const left = this.add.particles(leftX, burstY, CONFETTI_TEX_KEY, {
      ...baseConfig, angle: { min: -100, max: -45 },
    });
    const right = this.add.particles(rightX, burstY, CONFETTI_TEX_KEY, {
      ...baseConfig, angle: { min: -135, max: -80 },
    });

    left.explode(burstCount);
    right.explode(burstCount);
    this.confettiEmitters.push(left, right);

    this.time.delayedCall(1600, () => {
      left.destroy();
      right.destroy();
      this.confettiEmitters = this.confettiEmitters.filter(e => e !== left && e !== right);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — pure functions
// ─────────────────────────────────────────────────────────────────────────────

/** Format a remaining-ms value as MM:SS. Negative values render as 0:00. */
function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/** Truncate to `maxChars`, appending `…`. */
function ellipsize(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * Deterministic per-id tint for tutorial_guy. Same vivid pastel range used by
 * BombermanShopService.rollBomberman: high saturation, high lightness so the
 * sprite reads as a character against the dark stall background. Hue + sat +
 * lightness all derived from a stable FNV-1a hash of the id so the same
 * gambler always gets the same color.
 */
function tintForGamblerId(id: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const u = h >>> 0;
  const hue = (u % 360);
  const sat = 0.55 + ((u >>> 8) & 0xff) / 255 * 0.30;
  const light = 0.62 + ((u >>> 16) & 0xff) / 255 * 0.18;
  return hslToRgb(hue, sat, light);
}

function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

/**
 * Draw a stylized hourglass into the supplied Graphics object, anchored at
 * (0, 0) with the timer roughly 28×40. Used for cooldown stalls — no sprite
 * asset for this exists in `public/sprites/`.
 */
function drawHourglass(g: Phaser.GameObjects.Graphics, colorHex: string): void {
  const color = Phaser.Display.Color.HexStringToColor(colorHex).color;
  g.lineStyle(2, color, 1);
  // Outline
  g.strokeRect(-14, -20, 28, 4); // top cap
  g.strokeRect(-14, 16, 28, 4);  // bottom cap
  g.beginPath();
  g.moveTo(-12, -16);
  g.lineTo(12, -16);
  g.lineTo(-12, 16);
  g.lineTo(12, 16);
  g.lineTo(-12, -16);
  g.strokePath();
  // Sand (top half — partial fill)
  g.fillStyle(color, 0.6);
  g.beginPath();
  g.moveTo(-10, -14);
  g.lineTo(10, -14);
  g.lineTo(2, -2);
  g.lineTo(-2, -2);
  g.closePath();
  g.fillPath();
  // Sand falling
  g.fillRect(-1, -2, 2, 6);
  // Sand (bottom heap)
  g.beginPath();
  g.moveTo(-8, 14);
  g.lineTo(8, 14);
  g.lineTo(2, 8);
  g.lineTo(-2, 8);
  g.closePath();
  g.fillPath();
}

/**
 * Draw a stylized hand silhouette into the supplied Graphics object, palm
 * pointing up. Origin at (0, 0); palm centred horizontally and roughly the
 * vertical centre. Mirror by setting `setScale(-1, 1)` on the parent
 * container — this draws the "left" hand orientation.
 */
function drawHand(g: Phaser.GameObjects.Graphics, colorHex: string): void {
  const color = Phaser.Display.Color.HexStringToColor(colorHex).color;
  g.lineStyle(2, color, 1);
  g.fillStyle(color, 0.18);

  // Palm
  g.fillRoundedRect(-26, -20, 52, 64, 10);
  g.strokeRoundedRect(-26, -20, 52, 64, 10);

  // Four fingers (top of palm)
  for (let i = 0; i < 4; i++) {
    const x = -22 + i * 12;
    g.fillRoundedRect(x, -56, 9, 38, 4);
    g.strokeRoundedRect(x, -56, 9, 38, 4);
  }

  // Thumb (left side) — drawing the "left hand" view
  g.fillRoundedRect(-38, -8, 14, 32, 6);
  g.strokeRoundedRect(-38, -8, 14, 32, 6);

  // Wrist hint
  g.lineStyle(2, color, 0.6);
  g.strokeRoundedRect(-18, 44, 36, 10, 4);
}
