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
  private spText!: Phaser.GameObjects.Text;
  private wallet: TreasureListWidget | null = null;
  private walletRightEdge = 0;
  private toastText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private unsubShop: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;
  private upgradePanel: BombermanUpgradePanel | null = null;
  /** Card-row centre X for the right (shop) column — set in create(). */
  private rightCardsCx = 0;
  /** Cached cycleId of the most recent render — used to detect cycle rollover
   *  so we can sequence "fly old off" → "roll new in". */
  private renderedCycleId: string | null = null;
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'BombermanShopScene' });
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
    const { layoutH } = designViewport(this, DESIGN_W, DESIGN_H);

    // Horizontal content is laid out symmetric around the live viewport centre
    // (see header comment). The column block spans [centreX-CONTENT_W/2, +].
    const centerX = this.scale.width / 2;
    const blockLeft = centerX - CONTENT_W / 2;
    const panelX = blockLeft;                       // left (Upgrade) column
    const rightColLeft = blockLeft + LEFT_W + COL_GAP;
    this.rightCardsCx = rightColLeft + RIGHT_W / 2; // shop cards centre

    // Screen title — the screen is the "Bomberman" hub (its two sections are
    // the SHOP and UPGRADE, headered consistently below).
    this.add.text(centerX, 22, 'BOMBERMAN', {
      fontSize: '26px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    // Consistent section headers over each column.
    const sectionHeaderStyle = {
      fontSize: '20px', color: '#cfd6e6', fontFamily: 'monospace', fontStyle: 'bold' as const,
    };
    this.add.text(panelX + LEFT_W / 2, 62, 'UPGRADE', sectionHeaderStyle).setOrigin(0.5, 0);
    this.add.text(this.rightCardsCx, 62, 'SHOP', sectionHeaderStyle).setOrigin(0.5, 0);

    // --- Left column: Upgrade panel ---
    this.upgradePanel = new BombermanUpgradePanel(this, { x: panelX, y: COLUMNS_TOP, width: LEFT_W });
    this.upgradePanel.create();

    // --- Currency row (top-right): coins + SP + treasure, all of which the
    //     shop/upgrades spend. SP is the equipped Bomberman's. ---
    const rightEdge = rightColLeft + RIGHT_W;
    this.walletRightEdge = rightEdge;
    this.coinsText = this.add.text(rightEdge, 8, '', {
      fontSize: '18px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0);
    this.spText = this.add.text(rightEdge, 30, '', {
      fontSize: '16px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0);
    this.wallet = new TreasureListWidget(this, {
      x: rightEdge, y: 52, anchor: 'top-left', direction: 'horizontal',
      iconScale: 0.5, fontSize: 12, rowGap: 4, depth: 10,
    });

    // Cycle timer — now BELOW the card listings (cards bottom ≈ 480).
    this.timerText = this.add.text(this.rightCardsCx, 500, 'New cycle in --:--', {
      fontSize: '14px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5, 0);

    this.toastText = this.add.text(centerX, layoutH - 58, '', {
      fontSize: '16px', color: '#44ff88', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Back button
    const backBtn = this.add.text(20, layoutH - 30, '[ < BACK ]', {
      fontSize: '16px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#cccccc'));
    backBtn.on('pointerout', () => backBtn.setColor('#888888'));
    backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));

    this.activity = new ActivityIndicator(this);

    const socket = NetworkManager.connect();
    NetworkManager.track('bomberman_shop_request', 'bomberman_shop_cycle');
    socket.emit('bomberman_shop_request');
    socket.on('shop_result', (msg) => {
      this.toastText.setColor(msg.ok ? '#44ff88' : '#ff4444');
      this.toastText.setText(msg.message ?? msg.reason ?? '');
      this.time.delayedCall(2500, () => this.toastText.setText(''));
    });

    this.unsubProfile = ProfileStore.subscribe(() => {
      this.renderHeader();
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
    this.timerText.setText(`New cycle in ${min}:${sec}`);

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
    this.coinsText.setText(`Coins: ${profile.coins}`);
    // SP is per-Bomberman — show the equipped one's (the Upgrade panel target).
    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    this.spText.setText(`SP ${equipped?.sp ?? 0}`);
    this.wallet?.setBundle(profile.treasures ?? {});
    this.wallet?.rightAlignTo(this.walletRightEdge);
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

    // Background tint hints tier
    const tierColor = template.tier === 'free' ? 0x224422
      : template.tier === 'paid' ? 0x222244
      : 0x442233;

    const bg = this.add.graphics();
    bg.fillStyle(tierColor, 0.9);
    bg.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 10);
    bg.lineStyle(2, 0x555577, 1);
    bg.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 10);
    container.add(bg);

    // Tier badge
    const tierLabel = template.tier === 'free' ? 'CHEAP'
      : template.tier === 'paid' ? 'PAID'
      : 'EXPENSIVE';
    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 14, tierLabel, {
      fontSize: '12px', color: '#bbbbbb', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Name
    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 30, template.name, {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Idle Action "class" badge under the name.
    container.add(createIdleActionBadge(this, 0, -CARD_HEIGHT / 2 + 42, template.idleAction ?? 'attack', '10px'));

    // Character sprite
    const anim = pickRandomUiAnimation();
    const charSprite = createShopBombermanSprite(this, 0, -82, template.tint, template.character, anim, 1.0);
    container.add(charSprite);

    // Tier info badge — top-right of the card. Hover reveals stat tooltip.
    attachTierInfoBadge(this, container, {
      x: 64, y: -CARD_HEIGHT / 2 + 14,
      tier: template.tier,
      maxCustomSlots: template.maxCustomSlots,
      stackSize: template.stackSize,
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
        container.add(this.add.text(0, rowY, '— empty', {
          fontSize: '11px', color: '#666', fontFamily: 'monospace',
        }).setOrigin(0.5));
      } else {
        const name = BOMB_CATALOG[slot.type].name;
        const slotIcon = this.add.image(-CARD_WIDTH / 2 + 18, rowY, 'bomb_icons', bombIconFrame(slot.type))
          .setDisplaySize(iconSize, iconSize);
        container.add(slotIcon);
        const nameText = this.add.text(-CARD_WIDTH / 2 + 32, rowY, name, {
          fontSize: '11px', color: '#cccccc', fontFamily: 'monospace',
        }).setOrigin(0, 0.5);
        container.add(nameText);
        container.add(this.add.text(CARD_WIDTH / 2 - 14, rowY, `×${slot.count}`, {
          fontSize: '12px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(1, 0.5));
      }
    }

    // Price
    const priceLabel = template.price === 0 ? 'FREE' : `${template.price} coins`;
    container.add(this.add.text(0, CARD_HEIGHT / 2 - 42, priceLabel, {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    const canAfford = profile ? profile.coins >= template.price : false;
    const rosterFull = profile ? profile.ownedBombermen.length >= 5 : true;
    const enabled = canAfford && !rosterFull;
    const btnColor = enabled ? '#44aaff' : '#555566';
    const btn = this.add.text(0, CARD_HEIGHT / 2 - 18, '[ BUY ]', {
      fontSize: '14px', color: btnColor, fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#111122', padding: { x: 12, y: 6 },
    }).setOrigin(0.5);

    if (enabled) {
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setColor('#88ccff'));
      btn.on('pointerout', () => btn.setColor('#44aaff'));
      btn.on('pointerdown', () => {
        NetworkManager.track('buy_bomberman', 'profile');
        NetworkManager.getSocket().emit('buy_bomberman', { templateId: template.id });
      });
    }
    container.add(btn);

    return container;
  }
}
