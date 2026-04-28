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
import type { GamblerSlot, GamblerStreetState } from '@shared/types/gambler-street.ts';

const TUTORIAL_GUY_KEY = 'gambler_face_default';
const TUTORIAL_GUY_PATH = 'sprites/tutorial_guy.png';

const CARD_WIDTH = 720;
const CARD_HEIGHT = 140;
const CARD_GAP = 16;

// Palette aligned with BombsShop / MainMenu chrome. Cheap/premium bet buttons
// keep distinct hues because the cool/warm split conveys gameplay risk; both
// sit in the same dark-navy family as shop buttons so they read as one UI.
const COLORS = {
  cardBg: 0x1a1a2e,
  cardBorder: 0x556699,
  cardBorderHover: 0x88aacc,
  cardCooldown: 0x141420,
  cardCooldownBorder: 0x333355,
  faceTint: 0xb8a890,
  textPrimary: '#ffffff',
  textSecondary: '#888888',
  textDim: '#666666',
  textAmount: '#ffd944',
  textTimer: '#aaaaaa',
  textTimerLow: '#ff6644',
  cheapBtn: 0x223844,
  cheapBtnHover: 0x335566,
  premiumBtn: 0x442233,
  premiumBtnHover: 0x664455,
  btnBorder: 0x000000,
} as const;

/**
 * Gambler Street main scene.
 *
 * Vertical list of 5 cards, each either an active gambler or an empty slot
 * counting down. Polls the server every second so countdown timers and
 * incoming gamblers stay live. The "Which hand?" reveal uses the parallel
 * GamblerStreetPopupScene so input below is blocked until it closes.
 */
export class GamblerStreetScene extends Phaser.Scene {
  private treasureList!: TreasureListWidget;
  private cardsContainer!: Phaser.GameObjects.Container;
  private cardsMask: Phaser.Display.Masks.GeometryMask | null = null;
  private cardsMaskGraphics: Phaser.GameObjects.Graphics | null = null;
  private listTop = 0;
  private listViewportH = 0;
  private contentH = 0;
  private scrollOffset = 0;
  private titleText!: Phaser.GameObjects.Text;
  private coinsText!: Phaser.GameObjects.Text;
  private pollTimer: Phaser.Time.TimerEvent | null = null;
  private unsubscribeStreet: (() => void) | null = null;
  private unsubscribeProfile: (() => void) | null = null;
  /** Pending bet — recorded when player clicks 50/75 button so we know what
   * to send when the popup resolves. */
  private pendingBet: { slotIndex: number; tier: BetTier } | null = null;

  constructor() {
    super({ key: 'GamblerStreetScene' });
  }

  preload(): void {
    preloadTreasureIcons(this);
    if (!this.textures.exists(TUTORIAL_GUY_KEY)) {
      this.load.image(TUTORIAL_GUY_KEY, TUTORIAL_GUY_PATH);
    }
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    this.events.on('gambler_bet_resolved', this.onBetResolvedFromPopup, this);
    this.events.on('gambler_bet_cancelled', this.onBetCancelled, this);

    const { width, height } = this.scale;

    this.titleText = this.add.text(width / 2, 40, 'GAMBLER STREET', {
      fontSize: '32px',
      color: '#e0e0e0',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.coinsText = this.add.text(20, 20, '', {
      fontSize: '20px',
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    });

    this.treasureList = new TreasureListWidget(this, {
      x: width - 20,
      y: 20,
      anchor: 'top-right',
      iconScale: 1.0,
      fontSize: 16,
    });

    // List anchor: just below the header. Cards stack DOWN from this point.
    // Reserve a strip at the bottom for the back button.
    this.listTop = 100;
    this.listViewportH = Math.max(200, height - this.listTop - 60);

    // Container holding the gambler cards. Anchored at the top of the
    // visible list area; cards added below it. Container.y is shifted on
    // wheel-scroll to translate the list within the masked viewport.
    this.cardsContainer = this.add.container(width / 2, this.listTop);

    // Geometry mask so cards that scroll out of the viewport are clipped
    // instead of bleeding into the title / back button areas.
    this.cardsMaskGraphics = this.make.graphics({ x: 0, y: 0 });
    this.cardsMaskGraphics.fillStyle(0xffffff);
    this.cardsMaskGraphics.fillRect(0, this.listTop, width, this.listViewportH);
    this.cardsMask = this.cardsMaskGraphics.createGeometryMask();
    this.cardsContainer.setMask(this.cardsMask);

    // Mouse wheel → scroll the list. Clamps so you can't scroll past either end.
    this.input.on('wheel', (
      _pointer: Phaser.Input.Pointer,
      _objs: Phaser.GameObjects.GameObject[],
      _dx: number,
      dy: number,
    ) => {
      const maxScroll = Math.max(0, this.contentH - this.listViewportH);
      this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + dy));
      this.cardsContainer.y = this.listTop - this.scrollOffset;
    });

    // Back button — lower-left, matches BombsShop / BombermanShop / Lobby.
    const backBtn = this.add.text(20, height - 30, '[ < BACK ]', {
      fontSize: '16px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#cccccc'));
    backBtn.on('pointerout', () => backBtn.setColor('#888888'));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    // Esc → Main Menu (matches the shop scenes' behavior).
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));

    // Subscribe to stores
    this.unsubscribeStreet = GamblerStreetStore.subscribe(() => this.renderCards());
    this.unsubscribeProfile = ProfileStore.subscribe(() => this.renderProfileBits());
    this.renderProfileBits();

    // Initial fetch + poll loop for live countdown updates.
    NetworkManager.getSocket().emit('gambler_street_request', {});
    this.pollTimer = this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: this.tickPoll,
      callbackScope: this,
    });

    // Render now in case the store already has data from a previous visit.
    this.renderCards();
  }

  shutdown(): void {
    this.events.off('gambler_bet_resolved', this.onBetResolvedFromPopup, this);
    this.events.off('gambler_bet_cancelled', this.onBetCancelled, this);
    this.input.off('wheel');
    this.unsubscribeStreet?.();
    this.unsubscribeProfile?.();
    this.unsubscribeStreet = null;
    this.unsubscribeProfile = null;
    this.pollTimer?.remove(false);
    this.pollTimer = null;
    this.treasureList?.destroy();
    this.cardsMask?.destroy();
    this.cardsMaskGraphics?.destroy();
    this.cardsMask = null;
    this.cardsMaskGraphics = null;
    this.pendingBet = null;
    const socket = NetworkManager.getSocket();
    socket.off('gambler_street_bet_result');
  }

  private tickPoll = (): void => {
    // Repaint timers off the same state — server doesn't need to be hit every
    // second, but we do want to refresh slot cooldowns/lifespans on screen.
    // We only ping the server every 5 seconds; otherwise we just re-render
    // local timers from the cached state.
    const state = GamblerStreetStore.get();
    const now = Date.now();
    // Server ping every 5 ticks (5s) to capture state transitions.
    if (!state || (now - (state.lastTickedAt ?? 0)) > 4000) {
      NetworkManager.getSocket().emit('gambler_street_request', {});
    }
    this.refreshTimersOnly();
  };

  private renderProfileBits(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`COINS: ${profile.coins}`);
    this.treasureList.setBundle(profile.treasures);
  }

  private renderCards(): void {
    this.cardsContainer.removeAll(true);
    const state = GamblerStreetStore.get();
    if (!state) {
      const loading = this.add.text(0, 20, 'Loading...', {
        fontSize: '16px', color: COLORS.textDim, fontFamily: 'monospace',
      }).setOrigin(0.5, 0);
      this.cardsContainer.add(loading);
      this.contentH = 0;
      return;
    }
    const profile = ProfileStore.get();
    const treasures = profile?.treasures ?? {};

    // Layout: stacked downward from the top of the container. The container
    // sits at (width/2, listTop) so cards at y=CARD_HEIGHT/2 land flush
    // with the top edge of the visible area.
    const slots = state.slots;
    let y = CARD_HEIGHT / 2;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const card = this.buildCard(slot, i, treasures);
      card.y = y;
      this.cardsContainer.add(card);
      y += CARD_HEIGHT + CARD_GAP;
    }
    this.contentH = slots.length * CARD_HEIGHT + (slots.length - 1) * CARD_GAP;

    // Re-clamp scroll if the content shrank.
    const maxScroll = Math.max(0, this.contentH - this.listViewportH);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    this.cardsContainer.y = this.listTop - this.scrollOffset;
  }

  /** Re-renders only the live countdown timers without rebuilding cards. */
  private refreshTimersOnly(): void {
    const state = GamblerStreetStore.get();
    if (!state) return;
    const now = Date.now();
    this.cardsContainer.iterate((child: Phaser.GameObjects.GameObject) => {
      if (!('getData' in child)) return null;
      const c = child as Phaser.GameObjects.Container;
      const idx = c.getData('slotIndex') as number | undefined;
      if (typeof idx !== 'number') return null;
      const slot = state.slots[idx];
      if (!slot) return null;
      const timerText = c.getData('timerText') as Phaser.GameObjects.Text | undefined;
      if (!timerText) return null;
      timerText.setText(formatTimer(slot, now));
      timerText.setColor(timerColor(slot, now));
      return null;
    });
  }

  private buildCard(
    slot: GamblerSlot,
    index: number,
    treasures: Partial<Record<TreasureType, number>>,
  ): Phaser.GameObjects.Container {
    const card = this.add.container(0, 0);
    card.setData('slotIndex', index);

    const isCooldown = slot.kind === 'cooldown';
    const bgColor = isCooldown ? COLORS.cardCooldown : COLORS.cardBg;
    const borderColor = isCooldown ? COLORS.cardCooldownBorder : COLORS.cardBorder;

    const bg = this.add.rectangle(0, 0, CARD_WIDTH, CARD_HEIGHT, bgColor, 1);
    bg.setStrokeStyle(2, borderColor, 1);
    card.add(bg);

    if (slot.kind === 'cooldown') {
      const txt = this.add.text(0, -8, 'NEW GAMBLER ARRIVES', {
        fontSize: '16px',
        color: COLORS.textSecondary,
        fontFamily: 'monospace',
      }).setOrigin(0.5);
      const timer = this.add.text(0, 18, formatTimer(slot, Date.now()), {
        fontSize: '22px',
        color: timerColor(slot, Date.now()),
        fontFamily: 'monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5);
      card.add(txt);
      card.add(timer);
      card.setData('timerText', timer);
      return card;
    }

    const g = slot.gambler;

    // Face on the left
    const facePadding = 16;
    const faceSize = CARD_HEIGHT - facePadding * 2;
    const faceX = -CARD_WIDTH / 2 + facePadding + faceSize / 2;
    const face = this.add.image(faceX, 0, TUTORIAL_GUY_KEY);
    face.setDisplaySize(faceSize, faceSize);
    face.setTint(COLORS.faceTint);
    card.add(face);

    // Name
    const nameX = faceX + faceSize / 2 + 18;
    const name = this.add.text(nameX, -CARD_HEIGHT / 2 + 14, g.name, {
      fontSize: '22px',
      color: COLORS.textPrimary,
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0, 0);
    card.add(name);

    // Treasure ask line: "WANTS  [icon] N FishName"
    const askY = -CARD_HEIGHT / 2 + 56;
    const wantsLabel = this.add.text(nameX, askY + 4, 'WANTS', {
      fontSize: '13px',
      color: COLORS.textDim,
      fontFamily: 'monospace',
    }).setOrigin(0, 0);
    card.add(wantsLabel);

    const askIcon = this.add.image(nameX + 64, askY + 12, TREASURE_TEXTURE_KEY, treasureIconFrame(g.treasureType));
    askIcon.setDisplaySize(24, 24);
    card.add(askIcon);

    const askText = this.add.text(
      nameX + 84, askY,
      `${g.treasureAmount} ${TREASURE_DISPLAY_NAMES[g.treasureType]}`,
      {
        fontSize: '18px',
        color: COLORS.textAmount,
        fontFamily: 'monospace',
        fontStyle: 'bold',
      },
    ).setOrigin(0, 0);
    card.add(askText);

    // Reward line
    const rewardY = askY + 32;
    const rewardLabel = this.add.text(nameX, rewardY, `OFFERS ${g.coinReward} COINS`, {
      fontSize: '14px',
      color: COLORS.textSecondary,
      fontFamily: 'monospace',
    }).setOrigin(0, 0);
    card.add(rewardLabel);

    // Lifespan timer (top-right of card)
    const timer = this.add.text(CARD_WIDTH / 2 - 12, -CARD_HEIGHT / 2 + 10, formatTimer(slot, Date.now()), {
      fontSize: '14px',
      color: timerColor(slot, Date.now()),
      fontFamily: 'monospace',
    }).setOrigin(1, 0);
    card.add(timer);
    card.setData('timerText', timer);

    // Bet buttons on the right
    const cheap = GAMBLER_STREET_GLOBAL.betTiers.cheap;
    const premium = GAMBLER_STREET_GLOBAL.betTiers.premium;
    const cheapCost = g.treasureAmount * cheap.costMultiplier;
    const premiumCost = g.treasureAmount * premium.costMultiplier;

    const btnRightEdge = CARD_WIDTH / 2 - 16;
    const btnW = 160;
    const btnH = 40;
    const btnY = 18;

    const owned = treasures[g.treasureType] ?? 0;
    const canCheap = owned >= cheapCost;
    const canPremium = owned >= premiumCost;

    const cheapBtn = this.makeBetButton(
      btnRightEdge - btnW * 2 - 12, btnY, btnW, btnH,
      `${Math.round(cheap.winChance * 100)}% — ${cheapCost}`,
      COLORS.cheapBtn, COLORS.cheapBtnHover,
      canCheap,
      () => this.requestBet(index, 'cheap'),
    );
    const premiumBtn = this.makeBetButton(
      btnRightEdge - btnW, btnY, btnW, btnH,
      `${Math.round(premium.winChance * 100)}% — ${premiumCost}`,
      COLORS.premiumBtn, COLORS.premiumBtnHover,
      canPremium,
      () => this.requestBet(index, 'premium'),
    );
    card.add(cheapBtn);
    card.add(premiumBtn);

    return card;
  }

  private makeBetButton(
    x: number, y: number, w: number, h: number,
    label: string,
    bgColor: number, hoverColor: number,
    enabled: boolean,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x + w / 2, y);
    const baseColor = enabled ? bgColor : 0x222226;
    const bg = this.add.rectangle(0, 0, w, h, baseColor, 1)
      .setStrokeStyle(1, 0x000000, 0.9);
    c.add(bg);
    const txt = this.add.text(0, 0, label, {
      fontSize: '16px',
      color: enabled ? '#ffffff' : '#555566',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    c.add(txt);
    if (!enabled) return c;

    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(hoverColor, 1));
    bg.on('pointerout', () => bg.setFillStyle(bgColor, 1));
    bg.on('pointerdown', () => {
      bg.setFillStyle(bgColor, 1);
      onClick();
    });
    return c;
  }

  private requestBet(slotIndex: number, tier: BetTier): void {
    if (this.pendingBet) return; // popup already up
    this.pendingBet = { slotIndex, tier };
    this.scene.launch('GamblerStreetPopupScene', { tier });
    this.scene.bringToTop('GamblerStreetPopupScene');
  }

  /** Called by the popup when the player picks a hand. We send the bet to the
   * server here. The popup waits for our reply and animates accordingly. */
  private onBetResolvedFromPopup = (data: { pickedHand: 'left' | 'right' }) => {
    if (!this.pendingBet) return;
    const { slotIndex, tier } = this.pendingBet;
    const socket = NetworkManager.getSocket();

    socket.once('gambler_street_bet_result', (msg) => {
      this.pendingBet = null;
      // Forward to popup so it shows the win/lose animation.
      this.scene.get('GamblerStreetPopupScene').events.emit('gambler_bet_response', msg);
      // Also rebuild cards to reflect the cooldown that replaced this slot.
      this.renderCards();
    });
    socket.emit('gambler_street_bet', {
      slotIndex,
      tier,
      pickedHand: data.pickedHand,
    });
  };

  /** Popup closed without picking — just clear the pending bet. */
  private onBetCancelled = () => {
    this.pendingBet = null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for timers
// ─────────────────────────────────────────────────────────────────────────────

function formatTimer(slot: GamblerSlot, now: number): string {
  const target = slot.kind === 'gambler' ? slot.gambler.expiresAt : slot.readyAt;
  const remaining = Math.max(0, target - now);
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

function timerColor(slot: GamblerSlot, now: number): string {
  if (slot.kind !== 'gambler') return '#888888';
  const remaining = slot.gambler.expiresAt - now;
  if (remaining < 30_000) return COLORS.textTimerLow;
  if (remaining < 60_000) return '#ffaa44';
  return COLORS.textTimer;
}
