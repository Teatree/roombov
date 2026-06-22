import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { BombermanShopStore, ProfileStore } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets, pickRandomUiAnimation } from '../systems/BombermanAnimations.ts';
import type { BombermanTemplate } from '@shared/types/bomberman.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';
import { attachTierInfoBadge } from '../systems/TierInfoBadge.ts';
import { createIdleActionBadge } from '../systems/IdleActionBadge.ts';
import { BombermanUpgradePanel } from '../systems/BombermanUpgradePanel.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';
import { NetworkManager as NM } from '../NetworkManager.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { COL, CSS, FONT } from '../design/tokens.ts';
import { drawNotchedPanel, makePixelButton } from '../util/pixelPanel.ts';

// Two-column layout (2026-06-06): left ~40% = the inline Upgrade panel (the old
// popup, now embedded; targets the equipped Bomberman), right ~60% = the shop
// (3 offered cards + header). The owned-Bomberman selector strip spans the
// bottom; equipping there updates the Upgrade panel.
//
// Design box for the fit-to-viewport responsive scaling. Horizontal content is
// laid out symmetric around the LIVE viewport centre (the camera-fit centres on
// vw/2 horizontally and only uses DESIGN_H for the zoom), so the column block
// width (CONTENT_W) is what must fit. DESIGN_W ≈ CONTENT_W + margins.
const DESIGN_W = 1280;
const DESIGN_H = 760;

// Column block (world units), symmetric around the live viewport centre.
const LEFT_W = 470;          // Upgrade panel width
const RIGHT_W = 680;         // Shop column width (holds 3 cards + margins)
const COL_GAP = 30;
const CONTENT_W = LEFT_W + COL_GAP + RIGHT_W; // 1180
const COLUMNS_TOP = 100;     // y where the two columns start

const CARD_WIDTH = 200;
const CARD_HEIGHT = 380;
const CARD_GAP = 20;

const ROLL_IN_MS = 280;
const ROLL_OUT_MS = 260;
const REFLOW_MS = 280;
const ROLL_IN_STAGGER_MS = 70;

interface CardView {
  templateId: string;
  container: Phaser.GameObjects.Container;
  /** True once a fly-off tween has been kicked off — view will be destroyed. */
  leaving: boolean;
}

/**
 * Bomberman Shop carousel — per-player edition.
 *
 * Each player has their own 2-minute cycle, persisted on `profile.bombermanShop`.
 * Cards roll in from the right when the scene opens, fly off when bought (the
 * bought-template-id is filtered from the visible row), and the whole batch
 * flies off + new batch rolls in when the cycle ends.
 *
 * Diff-rendering: `renderCards()` compares the current views (keyed by
 * template id) against the latest store cycle and animates additions,
 * removals, and reorders.
 */
export class BombermanShopScene extends Phaser.Scene {
  private cardViews: Map<string, CardView> = new Map();
  private cardOrder: string[] = [];
  private coinsText!: Phaser.GameObjects.Text;
  private wallet: TreasureListWidget | null = null;
  private walletRightEdge = 0;
  private toastText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private unsubShop: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;
  private upgradePanel: BombermanUpgradePanel | null = null;
  /** Whether the left Upgrade column is present. False until the player owns a
   *  Bomberman; flips to true (with a slide-in animation) on the first buy. */
  private twoColumn = false;
  /** Left (Upgrade) column origin X and right (shop) column origin X. */
  private panelX = 0;
  private rightColLeft = 0;
  private shopHeader!: Phaser.GameObjects.Text;
  private upgradeHeader: Phaser.GameObjects.Text | null = null;
  /** Card-row centre X for the right (shop) column — set in create(). */
  private rightCardsCx = 0;
  /** Cached cycleId of the most recent render — used to detect cycle rollover
   *  so we can sequence "fly old off" → "roll new in". */
  private renderedCycleId: string | null = null;
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  /** Scene to return to on Back/Esc. Set via init data so the Lobby (and any
   *  other caller) can route the back button to itself. */
  private backScene: string = 'MainMenuScene';

  constructor() {
    super({ key: 'BombermanShopScene' });
  }

  init(data?: { backScene?: string }): void {
    this.backScene = data?.backScene ?? 'MainMenuScene';
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
    preloadTreasureIcons(this);
  }

  create(): void {
    trackScreen(this, 'BombermanShop');
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { layoutW, layoutH } = designViewport(this, DESIGN_W, DESIGN_H);

    this.cameras.main.setBackgroundColor(CSS.bg);

    // Layout adapts to ownership: with no Bombermen owned there's nothing to
    // upgrade, so the left column is omitted and the shop is centred on screen.
    // The first purchase expands to the two-column layout (see maybeExpandLayout).
    const centerX = this.scale.width / 2;
    const ownedCount = ProfileStore.get()?.ownedBombermen.length ?? 0;
    this.twoColumn = ownedCount > 0;

    const a = this.computeAnchors(this.twoColumn);
    this.panelX = a.panelX;
    this.rightColLeft = a.rightColLeft;
    this.rightCardsCx = a.rightCardsCx;
    // Wallet lives in the screen's upper-right (design-box edge), matching the
    // Bombs Shop. The design-box edge is fixed regardless of layout, so it never
    // jumps when the two-column layout expands on the first purchase.
    const rightEdge = layoutW - 20;
    this.walletRightEdge = rightEdge;

    // Screen title — the screen is the "Bomberman" hub (its two sections are
    // the SHOP and UPGRADE, headered consistently below).
    this.add.text(centerX, 22, 'BOMBERMAN', {
      fontSize: '26px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5, 0).setShadow(5, 5, CSS.stageFrame, 0, true, true);

    // Consistent section headers over each column. UPGRADE only exists in the
    // two-column layout.
    const sectionHeaderStyle = {
      fontSize: '18px', color: CSS.text, fontFamily: FONT.press,
    };
    if (this.twoColumn) {
      this.upgradeHeader = this.add.text(this.panelX + LEFT_W / 2, 62, 'UPGRADE', sectionHeaderStyle).setOrigin(0.5, 0);
    }
    this.shopHeader = this.add.text(this.rightCardsCx, 62, 'SHOP', sectionHeaderStyle).setOrigin(0.5, 0);

    // --- Left column: Upgrade panel (only when something is owned) ---
    if (this.twoColumn) {
      this.upgradePanel = new BombermanUpgradePanel(this, { x: this.panelX, y: COLUMNS_TOP, width: LEFT_W });
      this.upgradePanel.create();
    }

    // --- Wallet (top-right): coins + treasure, standardized to match the Bombs
    //     Shop. SP is the equipped Bomberman's EXPERIENCE — it is shown in the
    //     Upgrade panel (where it is spent), never in the wallet area. ---
    this.coinsText = this.add.text(rightEdge, 14, '', {
      fontSize: '18px', color: CSS.gold, fontFamily: FONT.press,
    }).setOrigin(1, 0).setDepth(100);
    this.wallet = new TreasureListWidget(this, {
      x: rightEdge, y: 42, anchor: 'top-left', direction: 'horizontal',
      iconScale: 0.5, fontSize: 12, rowGap: 4, depth: 10,
    });

    // Cycle timer — now BELOW the card listings (cards bottom ≈ 480).
    this.timerText = this.add.text(this.rightCardsCx, 500, 'NEW CYCLE IN --:--', {
      fontSize: '12px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0.5, 0).setLetterSpacing(1);

    this.toastText = this.add.text(centerX, layoutH - 58, '', {
      fontSize: '14px', color: CSS.green, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    // Back button — labelled MENU when it returns to the Main Menu, BACK when
    // some other screen (e.g. the Lobby) routed here, matching the Bombs Shop.
    const backLabel = this.backScene === 'MainMenuScene' ? '[ < MENU ]' : '[ < BACK ]';
    const backBtn = this.add.text(20, layoutH - 30, backLabel, {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor(CSS.text));
    backBtn.on('pointerout', () => backBtn.setColor(CSS.dim));
    backBtn.on('pointerdown', () => this.scene.start(this.backScene));

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start(this.backScene));

    this.activity = new ActivityIndicator(this);

    const socket = NetworkManager.connect();
    NetworkManager.track('bomberman_shop_request', 'bomberman_shop_cycle');
    socket.emit('bomberman_shop_request');
    socket.on('shop_result', (msg) => {
      this.toastText.setColor(msg.ok ? CSS.green : CSS.red);
      this.toastText.setText(msg.message ?? msg.reason ?? '');
      this.time.delayedCall(2500, () => this.toastText.setText(''));
    });

    this.unsubProfile = ProfileStore.subscribe(() => {
      this.renderHeader();
      this.maybeExpandLayout();
    });
    this.unsubShop = BombermanShopStore.subscribe(() => this.renderCards());

    // Owned-Bomberman selector at the bottom. Clicking a card EQUIPS it here so
    // the left Upgrade panel retargets to it (the panel always shows the
    // equipped Bomberman). The EQUIP button still works too.
    this.selector = new BombermanSelector(this, layoutH - 130, {
      onCardClick: (ownedId: string) => {
        NM.track('equip_bomberman', 'profile');
        NM.getSocket().emit('equip_bomberman', { ownedId });
      },
    });
    this.selector.create();

    this.renderHeader();
    this.renderCards();

    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);
  }

  update(): void {
    const cycle = BombermanShopStore.get();
    if (!cycle) return;
    const msLeft = Math.max(0, cycle.endsAt - Date.now());
    const min = Math.floor(msLeft / 60000);
    const sec = Math.floor((msLeft % 60000) / 1000).toString().padStart(2, '0');
    this.timerText.setText(`NEW CYCLE IN ${min}:${sec}`);

    // Cycle expired locally — request the next one. Server will tick forward
    // and respond with a fresh cycle, which the diff-renderer will animate
    // (old fly off, new roll in).
    if (msLeft === 0 && cycle.cycleId === this.renderedCycleId) {
      NetworkManager.getSocket().emit('bomberman_shop_request');
    }
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.unsubProfile?.();
    this.unsubShop?.();
    this.unsubProfile = null;
    this.unsubShop = null;
    this.activity?.destroy();
    this.activity = null;
    for (const view of this.cardViews.values()) view.container.destroy();
    this.cardViews.clear();
    this.cardOrder = [];
    this.selector?.destroy();
    this.selector = null;
    this.upgradePanel?.destroy();
    this.upgradePanel = null;
    this.wallet?.destroy();
    this.wallet = null;
    const socket = NetworkManager.getSocket();
    socket.off('shop_result');
  }

  private renderHeader(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`${profile.coins}c`);
    this.wallet?.setBundle(profile.treasures ?? {});
    this.wallet?.rightAlignTo(this.walletRightEdge);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Adaptive layout — shop centred until the first Bomberman is owned
  // ───────────────────────────────────────────────────────────────────────────

  /** Column anchor X's for the two layouts. `twoColumn` = upgrade panel on the
   *  left + shop on the right; otherwise the shop is centred on screen. */
  private computeAnchors(twoColumn: boolean): { panelX: number; rightColLeft: number; rightCardsCx: number; rightEdge: number } {
    const centerX = this.scale.width / 2;
    const blockLeft = centerX - CONTENT_W / 2;
    const panelX = blockLeft;
    if (twoColumn) {
      const rightColLeft = blockLeft + LEFT_W + COL_GAP;
      return { panelX, rightColLeft, rightCardsCx: rightColLeft + RIGHT_W / 2, rightEdge: rightColLeft + RIGHT_W };
    }
    const rightColLeft = centerX - RIGHT_W / 2;
    return { panelX, rightColLeft, rightCardsCx: centerX, rightEdge: rightColLeft + RIGHT_W };
  }

  /** On the player's first purchase (owned 0 → 1) expand from the centred-shop
   *  layout to the two-column layout: the shop slides right and the Upgrade
   *  column rides in from the left. No-op once already two-column. */
  private maybeExpandLayout(): void {
    if (this.twoColumn) return;
    const count = ProfileStore.get()?.ownedBombermen.length ?? 0;
    if (count <= 0) return;
    this.twoColumn = true;

    const a = this.computeAnchors(true);
    this.panelX = a.panelX;
    this.rightColLeft = a.rightColLeft;
    this.rightCardsCx = a.rightCardsCx;

    // Slide the shop column (header + timer + cards) to the right.
    this.tweens.add({ targets: this.shopHeader, x: this.rightCardsCx, duration: REFLOW_MS, ease: 'Quad.easeOut' });
    this.tweens.add({ targets: this.timerText, x: this.rightCardsCx, duration: REFLOW_MS, ease: 'Quad.easeOut' });
    this.renderCards(); // reflow surviving cards toward the new centre

    // Fade the UPGRADE header in over its column.
    const sectionHeaderStyle = {
      fontSize: '18px', color: CSS.text, fontFamily: FONT.press,
    };
    this.upgradeHeader = this.add.text(this.panelX + LEFT_W / 2, 62, 'UPGRADE', sectionHeaderStyle)
      .setOrigin(0.5, 0).setAlpha(0);
    this.tweens.add({ targets: this.upgradeHeader, alpha: 1, duration: REFLOW_MS });

    // Build + slide in the Upgrade panel on the next tick: it subscribes to
    // ProfileStore, and creating it while we're inside a ProfileStore
    // notification could re-enter this callback / reset the slide.
    this.time.delayedCall(0, () => {
      if (this.upgradePanel) return;
      this.upgradePanel = new BombermanUpgradePanel(this, { x: this.panelX, y: COLUMNS_TOP, width: LEFT_W });
      this.upgradePanel.create();
      this.upgradePanel.animateInFromLeft(140, REFLOW_MS);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Card row — diff and animate from the cycle store
  // ───────────────────────────────────────────────────────────────────────────

  private renderCards(): void {
    const cycle = BombermanShopStore.get();
    if (!cycle) return;

    // Filter visible templates: exclude ones already bought this cycle. The
    // server tracks `boughtTemplateIds`; the client renders only the
    // remaining ones.
    const visible = cycle.bombermen.filter(b => !cycle.boughtTemplateIds.includes(b.id));
    const nextIds = visible.map(b => b.id);

    // Cycle rollover: when the cycleId changes, treat ALL existing cards as
    // "leaving" so the old batch flies off, then the new batch rolls in.
    const isRollover = this.renderedCycleId !== null && this.renderedCycleId !== cycle.cycleId;
    if (isRollover) {
      for (const id of this.cardOrder) {
        if (!this.cardViews.get(id)?.leaving) this.animateCardLeaving(id);
      }
    }

    // Removals: views that are no longer in the visible list (mid-cycle
    // purchase). Animate them out unless we already started the rollover
    // animation above.
    for (const [id, view] of this.cardViews) {
      if (view.leaving) continue;
      if (!nextIds.includes(id)) this.animateCardLeaving(id);
    }

    // Additions: build any visible template that doesn't have a non-leaving
    // view yet. Stagger the roll-in so they cascade left-to-right.
    let addedIndex = 0;
    for (let i = 0; i < visible.length; i++) {
      const t = visible[i];
      const existing = this.cardViews.get(t.id);
      if (existing && !existing.leaving) continue;
      const delay = (isRollover ? ROLL_OUT_MS : 0) + addedIndex * ROLL_IN_STAGGER_MS;
      this.createAndArriveCard(t, i, visible.length, delay);
      addedIndex++;
    }

    // Reflow: reposition surviving cards to their new index.
    for (let i = 0; i < visible.length; i++) {
      const t = visible[i];
      const view = this.cardViews.get(t.id);
      if (!view || view.leaving) continue;
      const targetX = this.cardTargetX(i, visible.length);
      if (Math.abs(view.container.x - targetX) > 1) {
        this.tweens.add({
          targets: view.container, x: targetX,
          duration: REFLOW_MS, ease: 'Quad.easeOut',
        });
      }
    }

    this.cardOrder = nextIds.slice();
    this.renderedCycleId = cycle.cycleId;
  }

  private cardTargetX(i: number, count: number): number {
    // Centre the row within the right (shop) column, not the whole screen.
    const totalW = count * CARD_WIDTH + Math.max(0, count - 1) * CARD_GAP;
    const startX = this.rightCardsCx - totalW / 2;
    return startX + i * (CARD_WIDTH + CARD_GAP) + CARD_WIDTH / 2;
  }

  private createAndArriveCard(template: BombermanTemplate, index: number, count: number, delay: number): void {
    // Card row top-anchored under the shop header; bottom (cardY + 190 = 480)
    // clears the bottom selector strip.
    const cardY = 290;
    const startX = this.scale.width + CARD_WIDTH; // off-screen right
    const targetX = this.cardTargetX(index, count);

    const container = this.createCard(startX, cardY, template);
    container.setAlpha(0);

    const view: CardView = {
      templateId: template.id,
      container,
      leaving: false,
    };
    this.cardViews.set(template.id, view);

    this.tweens.add({
      targets: container,
      x: targetX,
      alpha: 1,
      duration: ROLL_IN_MS,
      ease: 'Quad.easeOut',
      delay,
    });
  }

  private animateCardLeaving(id: string): void {
    const view = this.cardViews.get(id);
    if (!view || view.leaving) return;
    view.leaving = true;
    // Disable any interactive children on the leaving card so half-flown
    // cards don't accept clicks.
    view.container.list.forEach((c) => {
      const obj = c as Phaser.GameObjects.GameObject & { input?: { enabled: boolean } };
      if (obj.input) obj.disableInteractive?.();
    });
    this.tweens.add({
      targets: view.container,
      y: view.container.y - 80,
      alpha: 0,
      duration: ROLL_OUT_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        view.container.destroy();
        this.cardViews.delete(id);
      },
    });
  }

  private createCard(x: number, y: number, template: BombermanTemplate): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const profile = ProfileStore.get();

    const isFree = template.price === 0;

    // Card frame — notched panel. Identity now comes from the level badge +
    // class color, not a tier label. FREE cards take a green border.
    const bg = this.add.graphics();
    drawNotchedPanel(bg, -CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, {
      fill: COL.panel, border: isFree ? COL.green : COL.border, borderWidth: 2, notch: 8,
    });
    container.add(bg);

    // Name (Press Start).
    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 24, template.name, {
      fontSize: '13px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5));

    // Idle Action "class" badge under the name (renders in its class color).
    container.add(createIdleActionBadge(this, 0, -CARD_HEIGHT / 2 + 42, template.idleAction ?? 'attack', '10px'));

    // Character sprite
    const anim = pickRandomUiAnimation();
    const charSprite = createShopBombermanSprite(this, 0, -82, template.tint, template.character, anim, 1.0);
    container.add(charSprite);

    // Level badge — top-right of the card. Hover reveals the stat tooltip.
    attachTierInfoBadge(this, container, {
      x: 64, y: -CARD_HEIGHT / 2 + 14,
      tier: template.tier,
      level: 1, // shop templates are always level 1 (no upgrades yet)
      idleAction: template.idleAction ?? 'attack',
      maxCustomSlots: template.maxCustomSlots,
      stackSize: template.stackSize,
      name: template.name,
      tooltipSide: 'below',
    });

    // Bomb loadout list — variable count, custom slots only.
    const loadoutStartY = -10;
    const rowH = 22;
    const iconSize = 18;
    const loadoutSlots = template.inventory.slots;
    for (let si = 0; si < template.maxCustomSlots; si++) {
      const slot = loadoutSlots[si];
      const rowY = loadoutStartY + si * rowH;
      if (!slot) {
        container.add(this.add.text(0, rowY, '— EMPTY', {
          fontSize: '11px', color: CSS.faint, fontFamily: FONT.silk,
        }).setOrigin(0.5));
      } else {
        const name = BOMB_CATALOG[slot.type].name;
        const slotIcon = this.add.image(-CARD_WIDTH / 2 + 18, rowY, 'bomb_icons', bombIconFrame(slot.type))
          .setDisplaySize(iconSize, iconSize);
        container.add(slotIcon);
        const nameText = this.add.text(-CARD_WIDTH / 2 + 32, rowY, name, {
          fontSize: '11px', color: CSS.dim, fontFamily: FONT.silk,
        }).setOrigin(0, 0.5);
        // Truncate long names so they never collide with the right-aligned count.
        const maxNameW = CARD_WIDTH - 64;
        let trimmed = name;
        while (trimmed.length > 1 && nameText.width > maxNameW) {
          trimmed = trimmed.slice(0, -1);
          nameText.setText(`${trimmed}…`);
        }
        container.add(nameText);
        container.add(this.add.text(CARD_WIDTH / 2 - 14, rowY, `${slot.count}`, {
          fontSize: '12px', color: CSS.gold, fontFamily: FONT.press,
        }).setOrigin(1, 0.5));
      }
    }

    // Price — FREE in green, otherwise gold.
    const priceLabel = isFree ? 'FREE' : `${template.price} C`;
    container.add(this.add.text(0, CARD_HEIGHT / 2 - 50, priceLabel, {
      fontSize: '15px', color: isFree ? CSS.green : CSS.gold, fontFamily: FONT.press,
    }).setOrigin(0.5));

    const canAfford = profile ? profile.coins >= template.price : false;
    const rosterFull = profile ? profile.ownedBombermen.length >= 5 : true;
    const enabled = canAfford && !rosterFull;
    const buy = makePixelButton(this, {
      x: 0, y: CARD_HEIGHT / 2 - 24, w: CARD_WIDTH - 28, h: 30,
      label: 'BUY', variant: 'gold', fontPx: 13, enabled,
      onClick: () => {
        NetworkManager.track('buy_bomberman', 'profile');
        NetworkManager.getSocket().emit('buy_bomberman', { templateId: template.id });
      },
    });
    container.add(buy.container);

    return container;
  }
}
