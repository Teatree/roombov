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
import type { BetOutcome, Gambler, GamblerStreetState } from '@shared/types/gambler-street.ts';
import type { GamblerStreetBetResultMsg } from '@shared/types/messages.ts';

/**
 * Gambler portrait pool. Each gambler is deterministically assigned one of
 * these textures based on a hash of `gambler.id`, so a given gambler always
 * shows the same face for their lifetime. Tutorial guy stays in rotation
 * alongside the dedicated gambler portraits.
 */
const GAMBLER_PORTRAITS: ReadonlyArray<{ key: string; path: string }> = [
  { key: 'gambler_face_tutorial_guy', path: 'sprites/tutorial_guy.png' },
  { key: 'gambler_face_boss_richard', path: 'sprites/boss_Richard.png' },
  { key: 'gambler_face_sad_henry',    path: 'sprites/sad_Henry.png' },
  { key: 'gambler_face_angry_sal',    path: 'sprites/angry_Sal.png' },
];
const CONFETTI_TEX_KEY = 'gambler_confetti_particle';

const STALL_GAP = 16;
const STALL_BAND_TOP = 130;
const STALL_BAND_HEIGHT = 290;
const STALL_MAX_WIDTH = 240;

const DRAWER_GAP = 24;
const DRAWER_HEIGHT = 280;
const DRAWER_MARGIN_X = 80;

const REVEAL_AUTO_DISMISS_MS = 3000;
const REJECTION_AUTO_DISMISS_MS = 2000;

const STAGE_CROSSFADE_MS = 150;
const DRAWER_SLIDE_MS = 200;

const STALL_LEAVE_MS = 250;
const STALL_ARRIVE_MS = 280;
const STALL_REFLOW_MS = 300;

const POLL_INTERVAL_MS = 1000;
const POLL_SERVER_EVERY_N_TICKS = 2; // 2s server pings while on the scene

const LOW_TIME_THRESHOLD_MS = 10_000;
const THROB_PERIOD_MS = 600;
const WALKED_AWAY_GRACE_MS = 1000;

// Palette harvested from MainMenuScene / BombermanShopScene / BombsShopScene.
const COLORS = {
  cardBg: 0x1a1a2e,
  cardBorder: 0x333355,
  cardBorderHover: 0x556699,
  cardBorderSelected: 0x88aacc,
  awning: 0x442233,
  pin: 0x88aacc,

  drawerBg: 0x1a1a2e,
  drawerBorder: 0x556699,

  btnPrimary: 0x222244,
  btnPrimaryHover: 0x334466,
  btnDanger: 0x442233,
  btnDangerHover: 0x664455,
  btnDisabled: 0x222226,

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
  textTimerNormal: '#aaaaaa',
  textTimerLow: '#ff6644',

  lifespanFill: 0x88aacc,
  lifespanFillLow: 0xff6644,
  lifespanTrack: 0x2a2a44,
} as const;

type DrawerStage = 'bet' | 'hand' | 'reveal';

interface DrawerData {
  /** Identity of the gambler being interacted with. Stable across reorders. */
  gamblerId: string;
  /** Snapshot of the gambler at drawer-open time — used so the drawer keeps
   *  rendering coherent copy even if the gambler leaves the active list. */
  gamblerSnapshot: Gambler;
  stage: DrawerStage;
  tier: BetTier | null;
  pickedHand: 'left' | 'right' | null;
  outcome: BetOutcome | null;
  rejected: boolean;
  rejectionReason: string | null;
  /** True once the watched gambler is no longer present in state.gamblers.
   *  Buttons are disabled and the drawer auto-closes after WALKED_AWAY_GRACE_MS. */
  walkedAway: boolean;
}

interface StallView {
  gambler: Gambler;
  container: Phaser.GameObjects.Container;
  hitZone: Phaser.GameObjects.Zone;
  border: Phaser.GameObjects.Rectangle;
  pin: Phaser.GameObjects.Triangle;
  timeLeftLabel: Phaser.GameObjects.Text;
  timeLeftText: Phaser.GameObjects.Text;
  lifespanFill: Phaser.GameObjects.Rectangle;
  /** True once a leave-tween has been kicked off — view will be destroyed. */
  leaving: boolean;
}

/**
 * Gambler Street main scene — conveyor edition.
 *
 * The carousel is a horizontal row of 1–5 stalls. Gamblers expire on a
 * staggered schedule (left expires first); when one leaves the others shift
 * left and a fresh arrival slides in from the right after 2–6 seconds.
 *
 * Server-authoritative for state; client renders smooth transitions on diff.
 *
 * Drawer flow: bet → hand → reveal, in-scene drawer below the row. If the
 * watched gambler walks away (timer hits 0 server-side) the drawer disables
 * its buttons, shows a "walked away" message, and slides closed 1s later.
 */
export class GamblerStreetScene extends Phaser.Scene {
  private treasureList!: TreasureListWidget;
  private coinsText!: Phaser.GameObjects.Text;
  private subHeaderText!: Phaser.GameObjects.Text;

  private stallRow!: Phaser.GameObjects.Container;
  private stallViews: Map<string, StallView> = new Map();
  private layoutOrder: string[] = [];

  private drawer: Phaser.GameObjects.Container | null = null;
  private drawerData: DrawerData | null = null;
  private drawerBody: Phaser.GameObjects.Container | null = null;
  private drawerHeaderTitle: Phaser.GameObjects.Text | null = null;
  private drawerHeaderSubtitle: Phaser.GameObjects.Container | null = null;
  private autoDismissTimer: Phaser.Time.TimerEvent | null = null;
  private walkedAwayCloseTimer: Phaser.Time.TimerEvent | null = null;
  private confettiEmitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];

  private pollTimer: Phaser.Time.TimerEvent | null = null;
  private pollTickCount = 0;
  private unsubscribeStreet: (() => void) | null = null;
  private unsubscribeProfile: (() => void) | null = null;

  private viewport = { width: 0, height: 0 };
  private stallSize = { w: 0, h: 0 };
  private drawerY = 0;

  constructor() {
    super({ key: 'GamblerStreetScene' });
  }

  preload(): void {
    preloadTreasureIcons(this);
    for (const p of GAMBLER_PORTRAITS) {
      if (!this.textures.exists(p.key)) this.load.image(p.key, p.path);
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

    // Top bar
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
      'Gamblers come and go. Will fortune favour you tonight?',
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

    this.stallRow = this.add.container(0, 0);

    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.drawer) this.closeDrawer();
      else this.scene.start('MainMenuScene');
    });

    this.unsubscribeStreet = GamblerStreetStore.subscribe(() => this.renderStalls());
    this.unsubscribeProfile = ProfileStore.subscribe(() => this.renderProfileBits());
    this.renderProfileBits();

    NetworkManager.getSocket().emit('gambler_street_request', {});
    this.pollTimer = this.time.addEvent({
      delay: POLL_INTERVAL_MS, loop: true, callback: this.tickPoll, callbackScope: this,
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
    this.walkedAwayCloseTimer?.remove(false);
    this.walkedAwayCloseTimer = null;
    this.treasureList?.destroy();
    this.destroyDrawer();
    this.stallViews.clear();
    this.layoutOrder = [];
    // Do NOT socket.off('gambler_street_bet_result') — that would strip the
    // global store-sync handler. Pending once-handlers self-cancel via the
    // drawerData identity guard.
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Layout
  // ───────────────────────────────────────────────────────────────────────────

  private computeLayout(): void {
    const { width } = this.viewport;
    const slotCount = GAMBLER_STREET_GLOBAL.slotCount;
    const margin = 40;
    const usable = width - margin * 2;
    const stallW = Math.min(STALL_MAX_WIDTH, (usable - STALL_GAP * (slotCount - 1)) / slotCount);
    this.stallSize = { w: Math.floor(stallW), h: STALL_BAND_HEIGHT };
    this.drawerY = STALL_BAND_TOP + STALL_BAND_HEIGHT + DRAWER_GAP + DRAWER_HEIGHT / 2;
  }

  /** x of the stall's container origin for index `i` in a row of `count`. */
  private stallTargetX(i: number, count: number): number {
    const totalW = count * this.stallSize.w + Math.max(0, count - 1) * STALL_GAP;
    const startX = (this.viewport.width - totalW) / 2;
    return startX + i * (this.stallSize.w + STALL_GAP) + this.stallSize.w / 2;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Profile / coins / treasure refresh
  // ───────────────────────────────────────────────────────────────────────────

  private renderProfileBits(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`${profile.coins} coins`);
    this.treasureList.setBundle(profile.treasures);

    if (this.drawer && this.drawerData?.stage === 'bet') {
      this.renderDrawerBody();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Poll loop
  // ───────────────────────────────────────────────────────────────────────────

  private tickPoll = (): void => {
    this.pollTickCount = (this.pollTickCount + 1) % POLL_SERVER_EVERY_N_TICKS;
    if (this.pollTickCount === 0) {
      NetworkManager.getSocket().emit('gambler_street_request', {});
    }
    this.refreshTimers();
  };

  /** Per-second visual refresh: countdown text, throb effect, lifespan bar. */
  private refreshTimers(): void {
    const now = Date.now();
    for (const view of this.stallViews.values()) {
      if (view.leaving) continue;
      const remaining = Math.max(0, view.gambler.expiresAt - now);
      view.timeLeftText.setText(formatCountdown(remaining));

      const isLow = remaining <= LOW_TIME_THRESHOLD_MS && remaining > 0;
      if (isLow) {
        view.timeLeftText.setColor(COLORS.textTimerLow);
        view.timeLeftLabel.setColor(COLORS.textTimerLow);
        // Sine throb between 1.0 and 0.55
        const phase = (now % THROB_PERIOD_MS) / THROB_PERIOD_MS;
        const a = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase));
        view.timeLeftText.setAlpha(a);
        view.timeLeftLabel.setAlpha(a);
      } else {
        view.timeLeftText.setColor(COLORS.textTimerNormal);
        view.timeLeftLabel.setColor(COLORS.textTimerNormal);
        view.timeLeftText.setAlpha(1);
        view.timeLeftLabel.setAlpha(1);
      }

      // Lifespan bar
      const total = Math.max(1, view.gambler.expiresAt - view.gambler.createdAt);
      const ratio = Math.min(1, remaining / total);
      const fullW = this.stallSize.w - 24;
      view.lifespanFill.width = fullW * ratio;
      view.lifespanFill.fillColor = isLow ? COLORS.lifespanFillLow : COLORS.lifespanFill;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stall row — diff and animate from state.gamblers
  // ───────────────────────────────────────────────────────────────────────────

  private renderStalls(): void {
    const state = GamblerStreetStore.get();
    if (!state) {
      // First time render before state arrives — show a loading placeholder
      // exactly once. The placeholder is a single text in the stallRow.
      if (this.stallRow.list.length === 0) {
        const loading = this.add.text(this.viewport.width / 2, STALL_BAND_TOP + 100, 'Loading…', {
          fontSize: '16px', color: COLORS.textDim, fontFamily: 'monospace',
        }).setOrigin(0.5);
        this.stallRow.add(loading);
      }
      return;
    }

    // Strip any loading placeholder once real state arrives
    if (this.stallViews.size === 0 && this.stallRow.list.length > 0 && state.gamblers.length > 0) {
      this.stallRow.removeAll(true);
    }

    const nextIds = state.gamblers.map(g => g.id);

    // Removals: any current id no longer in nextIds → animate-out
    for (const [id, view] of this.stallViews) {
      if (!nextIds.includes(id) && !view.leaving) {
        this.animateStallLeaving(id);
      }
    }

    // Additions: any new id without a non-leaving view → create + animate-in
    for (let i = 0; i < state.gamblers.length; i++) {
      const g = state.gamblers[i];
      const existing = this.stallViews.get(g.id);
      if (!existing || existing.leaving) {
        this.createAndArriveStall(g, i, state.gamblers.length);
      }
    }

    // Reflow: tween x of all non-leaving stalls to new positions
    for (let i = 0; i < state.gamblers.length; i++) {
      const g = state.gamblers[i];
      const view = this.stallViews.get(g.id);
      if (!view || view.leaving) continue;
      // Update cached gambler in case server changed something (it shouldn't,
      // but the snapshot keeps the timer accurate after long offline aging).
      view.gambler = g;
      const targetX = this.stallTargetX(i, state.gamblers.length);
      if (Math.abs(view.container.x - targetX) > 1) {
        this.tweens.add({
          targets: view.container, x: targetX,
          duration: STALL_REFLOW_MS, ease: 'Quad.easeOut',
        });
      }
    }

    this.layoutOrder = nextIds.slice();

    this.applyStallStates();
    this.refreshTimers();
    this.updateDrawerForState(state);
  }

  private createAndArriveStall(g: Gambler, index: number, count: number): void {
    const startX = this.viewport.width + this.stallSize.w; // off-screen right
    const targetX = this.stallTargetX(index, count);
    const y = STALL_BAND_TOP + this.stallSize.h / 2;
    const view = this.buildStall(g, startX, y);
    this.stallViews.set(g.id, view);
    this.stallRow.add(view.container);

    view.container.setAlpha(0);
    this.tweens.add({
      targets: view.container,
      x: targetX,
      alpha: 1,
      duration: STALL_ARRIVE_MS,
      ease: 'Quad.easeOut',
    });
  }

  private animateStallLeaving(id: string): void {
    const view = this.stallViews.get(id);
    if (!view) return;
    view.leaving = true;
    view.hitZone.disableInteractive();
    this.tweens.add({
      targets: view.container,
      y: view.container.y - 70,
      alpha: 0,
      duration: STALL_LEAVE_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        view.container.destroy();
        this.stallViews.delete(id);
      },
    });
  }

  private buildStall(g: Gambler, x: number, y: number): StallView {
    const w = this.stallSize.w;
    const h = this.stallSize.h;
    const container = this.add.container(x, y);

    const bg = this.add.rectangle(0, 0, w, h, COLORS.cardBg, 1);
    container.add(bg);
    const border = this.add.rectangle(0, 0, w, h);
    border.setFillStyle(0x000000, 0).setStrokeStyle(2, COLORS.cardBorder, 1);
    container.add(border);

    // Awning
    const awningH = 8;
    const awning = this.add.rectangle(0, -h / 2 + awningH / 2, w - 4, awningH, COLORS.awning, 1);
    container.add(awning);

    // Avatar — tutorial_guy with per-id deterministic tint
    const avatarSize = Math.min(110, w - 32);
    const avatar = this.add.image(0, -h / 2 + awningH + 12 + avatarSize / 2, portraitForGamblerId(g.id));
    avatar.setDisplaySize(avatarSize, avatarSize);
    avatar.setTint(tintForGamblerId(g.id));
    container.add(avatar);

    // Name (single line, ellipsis on overflow)
    const nameY = avatar.y + avatarSize / 2 + 6;
    const name = this.add.text(0, nameY, ellipsize(g.name, Math.floor(w / 9)), {
      fontSize: '14px', color: COLORS.textPrimary, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(name);

    // Ask line: "wants {N} {treasureIcon}"
    const askY = nameY + 22;
    const askLabel = this.add.text(-w / 2 + 14, askY, `wants ${g.treasureAmount}`, {
      fontSize: '12px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    container.add(askLabel);
    const askIcon = this.add.image(askLabel.x + askLabel.width + 6, askY, TREASURE_TEXTURE_KEY, treasureIconFrame(g.treasureType));
    askIcon.setOrigin(0, 0.5).setDisplaySize(18, 18);
    container.add(askIcon);

    // Reward line: "win {N} coins" — coins bold yellow
    const rewardY = askY + 22;
    const rewardPrefix = this.add.text(-w / 2 + 14, rewardY, 'win ', {
      fontSize: '12px', color: COLORS.textSecondary, fontFamily: 'monospace',
    }).setOrigin(0, 0.5);
    container.add(rewardPrefix);
    const rewardCoins = this.add.text(rewardPrefix.x + rewardPrefix.width, rewardY, `${g.coinReward} coins`, {
      fontSize: '12px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    container.add(rewardCoins);

    // Time-left label + countdown
    const timeY = rewardY + 26;
    const timeLeftLabel = this.add.text(-w / 2 + 14, timeY, 'time left', {
      fontSize: '11px', color: COLORS.textTimerNormal, fontFamily: 'monospace',
    }).setOrigin(0, 0.5);
    container.add(timeLeftLabel);
    const timeLeftText = this.add.text(timeLeftLabel.x + timeLeftLabel.width + 6, timeY, '0:00', {
      fontSize: '14px', color: COLORS.textTimerNormal, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    container.add(timeLeftText);

    // Lifespan bar (bottom edge, decorative)
    const barY = h / 2 - 18;
    const barW = w - 24;
    const barTrack = this.add.rectangle(0, barY, barW, 4, COLORS.lifespanTrack, 1);
    container.add(barTrack);
    const lifespanFill = this.add.rectangle(-barW / 2, barY, barW, 4, COLORS.lifespanFill, 1).setOrigin(0, 0.5);
    container.add(lifespanFill);

    // Selected pin (hidden until selected)
    const pin = this.add.triangle(0, h / 2 + 8, 0, 0, 12, 0, 6, -8, COLORS.pin);
    pin.setVisible(false);
    container.add(pin);

    // Hit zone
    const hitZone = this.add.zone(0, 0, w, h);
    hitZone.setInteractive({ useHandCursor: true });
    hitZone.on('pointerdown', () => this.onStallClicked(g.id));
    hitZone.on('pointerover', () => this.onStallHover(g.id, true));
    hitZone.on('pointerout', () => this.onStallHover(g.id, false));
    container.add(hitZone);

    return {
      gambler: g,
      container,
      hitZone,
      border,
      pin,
      timeLeftLabel,
      timeLeftText,
      lifespanFill,
      leaving: false,
    };
  }

  /** Apply hover/selected/dimmed states to all stalls based on drawer state. */
  private applyStallStates(): void {
    const selectedId = this.drawerData?.gamblerId ?? null;
    const drawerLocked = this.drawerData ? this.drawerData.stage !== 'bet' || this.drawerData.walkedAway : false;

    for (const [id, view] of this.stallViews) {
      if (view.leaving) continue;
      const isSelected = id === selectedId;
      const isDimmed = selectedId !== null && !isSelected;

      view.container.setAlpha(isDimmed ? 0.55 : 1);
      view.pin.setVisible(isSelected);
      view.border.setStrokeStyle(2, isSelected ? COLORS.cardBorderSelected : COLORS.cardBorder, 1);

      if (drawerLocked) view.hitZone.disableInteractive();
      else view.hitZone.setInteractive({ useHandCursor: true });
    }
  }

  private onStallHover(id: string, over: boolean): void {
    const view = this.stallViews.get(id);
    if (!view || view.leaving) return;
    const selectedId = this.drawerData?.gamblerId ?? null;
    if (id === selectedId) return;
    view.border.setStrokeStyle(2, over ? COLORS.cardBorderHover : COLORS.cardBorder, 1);
  }

  private onStallClicked(id: string): void {
    if (this.drawerData) {
      if (this.drawerData.stage !== 'bet' || this.drawerData.walkedAway) return;
      if (this.drawerData.gamblerId === id) {
        this.closeDrawer();
        return;
      }
      this.retargetDrawer(id);
      return;
    }
    this.openDrawer(id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Drawer lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  private openDrawer(gamblerId: string): void {
    const state = GamblerStreetStore.get();
    if (!state) return;
    const gambler = state.gamblers.find(g => g.id === gamblerId);
    if (!gambler) return;

    this.drawerData = {
      gamblerId,
      gamblerSnapshot: gambler,
      stage: 'bet',
      tier: null,
      pickedHand: null,
      outcome: null,
      rejected: false,
      rejectionReason: null,
      walkedAway: false,
    };

    const drawerW = this.viewport.width - DRAWER_MARGIN_X * 2;
    const drawer = this.add.container(this.viewport.width / 2, this.drawerY);

    drawer.setAlpha(0);
    drawer.y = this.drawerY + 80;

    const bg = this.add.rectangle(0, 0, drawerW, DRAWER_HEIGHT, COLORS.drawerBg, 1)
      .setStrokeStyle(2, COLORS.drawerBorder, 1);
    drawer.add(bg);

    this.drawerHeaderTitle = this.add.text(-drawerW / 2 + 24, -DRAWER_HEIGHT / 2 + 24, '', {
      fontSize: '20px', color: COLORS.textPrimary, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    drawer.add(this.drawerHeaderTitle);

    this.drawerHeaderSubtitle = this.add.container(-drawerW / 2 + 24, -DRAWER_HEIGHT / 2 + 50);
    drawer.add(this.drawerHeaderSubtitle);

    const closeBtn = this.add.text(drawerW / 2 - 18, -DRAWER_HEIGHT / 2 + 12, '✕', {
      fontSize: '22px', color: COLORS.textMuted, fontFamily: 'monospace',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor(COLORS.textMuted));
    closeBtn.on('pointerdown', () => this.closeDrawer());
    drawer.add(closeBtn);

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

  private retargetDrawer(gamblerId: string): void {
    if (!this.drawerData) return;
    const state = GamblerStreetStore.get();
    if (!state) return;
    const gambler = state.gamblers.find(g => g.id === gamblerId);
    if (!gambler) return;

    this.drawerData.gamblerId = gamblerId;
    this.drawerData.gamblerSnapshot = gambler;
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
    this.walkedAwayCloseTimer?.remove(false);
    this.walkedAwayCloseTimer = null;

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

  /** Called whenever new state arrives — detects "watched gambler walked away".
   *
   * Only fires while the player still has a chance to bet (stages `bet` and
   * `hand` before the hand is committed). Once the player has clicked a hand
   * we hand control to the bet-result handler — the gambler is *expected* to
   * vanish from state at that point because the server removes them on bet.
   */
  private updateDrawerForState(state: GamblerStreetState): void {
    if (!this.drawerData) return;
    if (this.drawerData.walkedAway) return;
    // Reveal stage = a bet is in flight or already resolved. Server has likely
    // removed the gambler from state; let `pickHand`'s once-handler render the
    // outcome instead of falsely flagging "walked away".
    if (this.drawerData.stage === 'reveal') return;
    const exists = state.gamblers.some(g => g.id === this.drawerData!.gamblerId);
    if (exists) return;

    this.drawerData.walkedAway = true;
    this.applyStallStates();
    this.renderDrawerHeader();
    this.renderDrawerBody();
    this.walkedAwayCloseTimer?.remove(false);
    this.walkedAwayCloseTimer = this.time.delayedCall(WALKED_AWAY_GRACE_MS, () => this.closeDrawer());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Drawer rendering
  // ───────────────────────────────────────────────────────────────────────────

  private currentGambler(): Gambler | null {
    if (!this.drawerData) return null;
    const state = GamblerStreetStore.get();
    const live = state?.gamblers.find(g => g.id === this.drawerData!.gamblerId) ?? null;
    return live ?? this.drawerData.gamblerSnapshot;
  }

  private renderDrawerHeader(): void {
    const gambler = this.currentGambler();
    if (!gambler || !this.drawerHeaderTitle || !this.drawerHeaderSubtitle) return;
    const data = this.drawerData!;

    this.drawerHeaderTitle.setText(gambler.name);

    // Build the subtitle as a row of styled text + treasure icon segments
    this.drawerHeaderSubtitle.removeAll(true);
    const treasureName = TREASURE_DISPLAY_NAMES[gambler.treasureType];
    let subtitleX = 0;

    if (data.walkedAway) {
      const t = this.add.text(subtitleX, 0, `${gambler.name} walked away.`, {
        fontSize: '13px', color: COLORS.textLoss, fontFamily: 'monospace', fontStyle: 'italic',
      }).setOrigin(0, 0);
      this.drawerHeaderSubtitle.add(t);
      return;
    }

    if (data.tier) {
      const cost = gambler.treasureAmount * GAMBLER_STREET_GLOBAL.betTiers[data.tier].costMultiplier;
      const before = this.add.text(subtitleX, 0, `paid ${cost} `, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      subtitleX += before.width;
      this.drawerHeaderSubtitle.add(before);

      const icon = this.add.image(subtitleX, 8, TREASURE_TEXTURE_KEY, treasureIconFrame(gambler.treasureType));
      icon.setOrigin(0, 0.5).setDisplaySize(16, 16);
      subtitleX += 18;
      this.drawerHeaderSubtitle.add(icon);

      const after = this.add.text(subtitleX, 0, `${treasureName} — which hand has the coins?`, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      this.drawerHeaderSubtitle.add(after);
      return;
    }

    // Default subtitle: "wants 12 [icon] Chalice · pays 6 coins (bold yellow) on a win"
    const wantsLbl = this.add.text(subtitleX, 0, `wants ${gambler.treasureAmount} `, {
      fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
    }).setOrigin(0, 0);
    subtitleX += wantsLbl.width;
    this.drawerHeaderSubtitle.add(wantsLbl);

    const icon = this.add.image(subtitleX, 8, TREASURE_TEXTURE_KEY, treasureIconFrame(gambler.treasureType));
    icon.setOrigin(0, 0.5).setDisplaySize(16, 16);
    subtitleX += 18;
    this.drawerHeaderSubtitle.add(icon);

    const between = this.add.text(subtitleX, 0, `${treasureName} · pays `, {
      fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
    }).setOrigin(0, 0);
    subtitleX += between.width;
    this.drawerHeaderSubtitle.add(between);

    const coins = this.add.text(subtitleX, 0, `${gambler.coinReward} coins`, {
      fontSize: '13px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    subtitleX += coins.width;
    this.drawerHeaderSubtitle.add(coins);

    const tail = this.add.text(subtitleX, 0, ' on a win', {
      fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
    }).setOrigin(0, 0);
    this.drawerHeaderSubtitle.add(tail);
  }

  private renderDrawerBody(): void {
    if (!this.drawerBody || !this.drawerData) return;
    const body = this.drawerBody;
    const oldChildren = body.list.slice();

    const fresh = this.add.container(0, 0);
    fresh.setAlpha(0);
    body.add(fresh);

    if (this.drawerData.walkedAway) {
      this.buildWalkedAwayStage(fresh);
    } else if (this.drawerData.stage === 'bet') {
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

  private buildWalkedAwayStage(parent: Phaser.GameObjects.Container): void {
    const gambler = this.currentGambler();
    if (!gambler) return;
    const txt = this.add.text(0, 60,
      `${gambler.name} walked away before you placed a bet.`,
      {
        fontSize: '16px', color: COLORS.textLoss, fontFamily: 'monospace',
      }).setOrigin(0.5);
    parent.add(txt);

    const sub = this.add.text(0, 92, 'better luck next time, chum.', {
      fontSize: '12px', color: COLORS.textMuted, fontFamily: 'monospace', fontStyle: 'italic',
    }).setOrigin(0.5);
    parent.add(sub);
  }

  private buildBetStage(parent: Phaser.GameObjects.Container): void {
    const gambler = this.currentGambler();
    if (!gambler) return;
    const profile = ProfileStore.get();
    const owned = profile?.treasures[gambler.treasureType] ?? 0;

    const cheap = GAMBLER_STREET_GLOBAL.betTiers.cheap;
    const premium = GAMBLER_STREET_GLOBAL.betTiers.premium;
    const cheapCost = gambler.treasureAmount * cheap.costMultiplier;
    const premiumCost = gambler.treasureAmount * premium.costMultiplier;
    const canCheap = owned >= cheapCost;
    const canPremium = owned >= premiumCost;
    const treasureName = TREASURE_DISPLAY_NAMES[gambler.treasureType];

    const cardW = 320;
    const cardH = 170;
    const gap = 32;

    const cheapCard = this.buildBetCard(
      -cardW / 2 - gap / 2, 30,
      cardW, cardH,
      'Cheap',
      cheapCost, treasureName, gambler.treasureType,
      cheap.winChance, gambler.coinReward,
      '2–6s before the next gambler',
      canCheap, COLORS.btnPrimary, COLORS.btnPrimaryHover,
      () => this.pickTier('cheap'),
    );
    const premiumCard = this.buildBetCard(
      cardW / 2 + gap / 2, 30,
      cardW, cardH,
      'Premium',
      premiumCost, treasureName, gambler.treasureType,
      premium.winChance, gambler.coinReward,
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

    // Cost line: "{N} [icon] Treasure"
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

    const chanceText = this.add.text(0, 0, `${Math.round(winChance * 100)}% chance`, {
      fontSize: '16px', color: enabled ? COLORS.textPrimary : COLORS.textDisabled, fontFamily: 'monospace',
    }).setOrigin(0.5);
    c.add(chanceText);

    // "{N} coins on win" — coins bold yellow
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

    const handG = this.add.graphics();
    drawHand(handG, COLORS.textBlue);
    const handHolder = this.add.container(0, -10, [handG]);
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
      const txt = this.add.text(0, 60, 'Rolling…', {
        fontSize: '20px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0.5);
      parent.add(txt);
      return;
    }

    const outcome = data.outcome;
    const treasureName = TREASURE_DISPLAY_NAMES[outcome.treasureType];

    // Left: chosen hand opening with/without coin
    const handFrameW = 220;
    const handFrameH = 170;
    const handFrame = this.add.container(-handFrameW / 2 - 24, 30);
    const frameBg = this.add.rectangle(0, 0, handFrameW, handFrameH,
      outcome.won ? 0x113322 : 0x331a1a, 1)
      .setStrokeStyle(2, outcome.won ? 0x44ff88 : 0xff6644, 1);
    handFrame.add(frameBg);

    const handG = this.add.graphics();
    drawHand(handG, outcome.won ? COLORS.textWin : COLORS.textLoss);
    const handHolder = this.add.container(0, -10, [handG]);
    if (data.pickedHand === 'right') handHolder.setScale(-1, 1);
    handFrame.add(handHolder);

    if (outcome.won) {
      const coin = this.add.text(0, 35, String(outcome.coinsGained), {
        fontSize: '24px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      handFrame.add(coin);
      const coinLbl = this.add.text(0, 60, 'coins', {
        fontSize: '12px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      handFrame.add(coinLbl);
    }
    parent.add(handFrame);

    // Right: result text
    const textX = handFrameW / 2 + 24 - handFrameW / 2;
    const textContainer = this.add.container(textX, 30);
    const headline = outcome.won ? 'Fortune smiles!' : 'Empty hand';
    const headlineText = this.add.text(0, -10, headline, {
      fontSize: '24px', color: outcome.won ? COLORS.textWin : COLORS.textLoss,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    textContainer.add(headlineText);

    if (outcome.won) {
      // "the {correctHand} hand held the prize."
      const line1 = this.add.text(0, 22, `the ${outcome.correctHand} hand held the prize.`, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(line1);

      // "+{N} coins added to your purse." — coins bold yellow
      const plusText = this.add.text(0, 46, `+${outcome.coinsGained} coins`, {
        fontSize: '13px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0);
      textContainer.add(plusText);
      const tail = this.add.text(plusText.width, 46, ' added to your purse.', {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(tail);
    } else {
      // "the {correctHand} hand had the coins. you lost {N} [icon] {treasure}."
      const line1Prefix = this.add.text(0, 22, `the ${outcome.correctHand} hand had the `, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(line1Prefix);
      const line1Coins = this.add.text(line1Prefix.width, 22, 'coins', {
        fontSize: '13px', color: COLORS.textCoin, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0);
      textContainer.add(line1Coins);
      const line1Tail = this.add.text(line1Prefix.width + line1Coins.width, 22, '.', {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(line1Tail);

      // "you lost {N} [icon] Treasure"
      const line2Prefix = this.add.text(0, 46, `you lost ${outcome.treasurePaid} `, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(line2Prefix);
      const lossIcon = this.add.image(line2Prefix.width, 46 + 8, TREASURE_TEXTURE_KEY, treasureIconFrame(outcome.treasureType));
      lossIcon.setOrigin(0, 0.5).setDisplaySize(16, 16);
      textContainer.add(lossIcon);
      const line2Tail = this.add.text(line2Prefix.width + 18, 46, ` ${treasureName}.`, {
        fontSize: '13px', color: COLORS.textSecondary, fontFamily: 'monospace',
      }).setOrigin(0, 0);
      textContainer.add(line2Tail);
    }
    parent.add(textContainer);

    const doneBtn = this.add.text(0, 130, '[ DONE ]', {
      fontSize: '16px', color: COLORS.textBlue, fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#222244', padding: { x: 18, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    doneBtn.on('pointerover', () => doneBtn.setColor(COLORS.textBlueHover));
    doneBtn.on('pointerout', () => doneBtn.setColor(COLORS.textBlue));
    doneBtn.on('pointerdown', () => this.closeDrawer());
    parent.add(doneBtn);

    this.fireConfetti(outcome.won ? 'gold' : 'grey');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stage transitions
  // ───────────────────────────────────────────────────────────────────────────

  private pickTier(tier: BetTier): void {
    if (!this.drawerData || this.drawerData.stage !== 'bet' || this.drawerData.walkedAway) return;
    this.drawerData.tier = tier;
    this.drawerData.stage = 'hand';
    this.renderDrawerHeader();
    this.renderDrawerBody();
    this.applyStallStates();
  }

  private pickHand(hand: 'left' | 'right'): void {
    if (!this.drawerData || this.drawerData.stage !== 'hand' || this.drawerData.walkedAway) return;
    if (!this.drawerData.tier) return;

    // Resolve current slotIndex from the live state — the gambler may have
    // shifted left after another gambler expired between drawer-open and now.
    const state = GamblerStreetStore.get();
    const slotIndex = state?.gamblers.findIndex(g => g.id === this.drawerData!.gamblerId) ?? -1;
    if (slotIndex < 0) {
      // Gambler vanished between opening the drawer and clicking a hand —
      // shouldn't normally happen because walkedAway should have caught it,
      // but be defensive.
      this.drawerData.walkedAway = true;
      this.renderDrawerHeader();
      this.renderDrawerBody();
      this.walkedAwayCloseTimer?.remove(false);
      this.walkedAwayCloseTimer = this.time.delayedCall(WALKED_AWAY_GRACE_MS, () => this.closeDrawer());
      return;
    }

    const tier = this.drawerData.tier;
    this.drawerData.pickedHand = hand;
    this.drawerData.stage = 'reveal';

    const myData = this.drawerData;
    const socket = NetworkManager.getSocket();
    socket.once('gambler_street_bet_result', (msg: GamblerStreetBetResultMsg) => {
      if (this.drawerData !== myData) return;
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

    this.renderDrawerBody();
    this.applyStallStates();
  }

  private scheduleAutoDismiss(delay: number): void {
    this.autoDismissTimer?.remove(false);
    this.autoDismissTimer = this.time.delayedCall(delay, () => this.closeDrawer());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Confetti (scaled down to fit the drawer reveal frame)
  // ───────────────────────────────────────────────────────────────────────────

  private fireConfetti(palette: 'gold' | 'grey'): void {
    const colors = palette === 'gold'
      ? [0xffd944, 0xffaa44, 0xffe88a, 0xc4a566, 0xffe4a0, 0xff8844]
      : [0xaaaaaa, 0x888888, 0x666666, 0x555555, 0x444444];

    const drawerW = this.viewport.width - DRAWER_MARGIN_X * 2;
    const burstY = this.drawerY;
    const leftX = this.viewport.width / 2 - drawerW / 2;
    const rightX = this.viewport.width / 2 + drawerW / 2;
    const burstCount = 18;

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

function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

function ellipsize(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * Tint intensity for gambler avatars. The portrait artwork is now distinct
 * enough that we don't need a strong color cast to differentiate gamblers —
 * a faint tint reads as "personality" without overpowering the art.
 *   0.0 = no tint (pure white blend, portrait shows natural color)
 *   1.0 = full color tint (the original strength).
 */
const TINT_INTENSITY = 0.20;

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
  const full = hslToRgb(hue, sat, light);
  // Blend the rolled color toward white to soften the tint. At
  // TINT_INTENSITY=0.2 the result keeps just a hint of the unique color.
  const r = (full >> 16) & 0xff;
  const g = (full >> 8) & 0xff;
  const b = full & 0xff;
  const blend = (channel: number): number => Math.round(0xff * (1 - TINT_INTENSITY) + channel * TINT_INTENSITY);
  return (blend(r) << 16) | (blend(g) << 8) | blend(b);
}

/**
 * Pick a portrait texture key for a gambler deterministically from their id.
 * Uses a different hash mixer than `tintForGamblerId` so portrait + tint
 * vary independently — same id = same portrait + same tint forever.
 */
function portraitForGamblerId(id: string): string {
  let h = 0x9e3779b9 | 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x85ebca6b);
    h ^= h >>> 13;
  }
  const u = (h >>> 0);
  return GAMBLER_PORTRAITS[u % GAMBLER_PORTRAITS.length].key;
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
 * Draw a stylized hand silhouette with palm pointing up. Mirror by setting
 * `setScale(-1, 1)` on the parent container to flip into the right-hand pose.
 */
function drawHand(g: Phaser.GameObjects.Graphics, colorHex: string): void {
  const color = Phaser.Display.Color.HexStringToColor(colorHex).color;
  g.lineStyle(2, color, 1);
  g.fillStyle(color, 0.18);

  g.fillRoundedRect(-26, -20, 52, 64, 10);
  g.strokeRoundedRect(-26, -20, 52, 64, 10);

  for (let i = 0; i < 4; i++) {
    const x = -22 + i * 12;
    g.fillRoundedRect(x, -56, 9, 38, 4);
    g.strokeRoundedRect(x, -56, 9, 38, 4);
  }

  g.fillRoundedRect(-38, -8, 14, 32, 6);
  g.strokeRoundedRect(-38, -8, 14, 32, 6);

  g.lineStyle(2, color, 0.6);
  g.strokeRoundedRect(-18, 44, 36, 10, 4);
}
