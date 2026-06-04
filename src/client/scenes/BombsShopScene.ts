import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons, TREASURE_TEXTURE_KEY, treasureIconFrame } from '../systems/TreasureIcons.ts';
import type { BombType } from '@shared/types/bombs.ts';
import type { BombsCatalogEntry } from '@shared/types/messages.ts';
import type { PlayerProfile } from '@shared/types/player-profile.ts';
import { attachTierInfoBadge } from '../systems/TierInfoBadge.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { BombShopTooltip } from '../systems/BombShopTooltip.ts';
import { effectiveMaxCustomSlots, effectiveStackSize } from '@shared/utils/bomberman-stats.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';

/** Design box this three-panel shop is authored against; the main camera scales
 *  it down to fit short/narrow viewports (no-op on desktop). DESIGN_W (780) is
 *  the minimum width that keeps all three panels comfortable — the BOMBERMAN
 *  mid panel stays above the UNEQUIP_ICON_BREAKPOINT (260px). DESIGN_H (720) is
 *  the minimum comfortable height: title (y≈30) + body panels (top 72, bottom
 *  at height-250) + the BombermanSelector card region; at 720 the panels get a
 *  usable ~398px body, and any viewport at least this tall/wide is an exact
 *  no-op so desktop layout is unchanged. Short landscape phones (~390px tall)
 *  trip the height condition and scale. */
const DESIGN_W = 780;
const DESIGN_H = 720;

/**
 * Bombs Shop scene — three-column layout (CATALOG / BOMBERMAN / STOCKPILE).
 *
 * Each tile's children are added in this order so input + hover work right:
 *   1. background graphic (non-interactive)
 *   2. hover zone (interactive — receives pointerover/pointerout only)
 *   3. content (icons, labels, etc — non-interactive)
 *   4. buttons / click zones (interactive — on top so they win clicks)
 *
 * Phaser's default `topOnly=true` input mode means the topmost interactive
 * GameObject under the cursor wins the event. With this order, buttons get
 * clicks; the hover zone receives pointerover/out when nothing else covers it.
 * Pointer transitions between hover zone and buttons would normally cause
 * tooltip flicker — `BombShopTooltip` debounces hide() with a 60ms grace
 * window to smooth those transitions.
 */

const CATALOG_TILE_H = 80;
const CATALOG_GRID_COLS = 3;
const STOCKPILE_GRID_COLS = 3;
const STOCKPILE_TILE_H = 68;
const PANEL_BG = 0x1a1a2e;
const PANEL_BORDER = 0x333355;
const PANEL_HEADER_BG = 0x222244;
const COIN_GOLD = '#ffd944';
const WARN_RED = '#ff4444';
const TEXT_DEFAULT = '#ffffff';
const TEXT_DIM = '#888888';
const TEXT_HEADER = '#aaaaaa';
const HIGHLIGHT_GOLD = 0xffd944;
const SLOT_BG = 0x1a1a2e;
const ROCK_BORDER = 0x554433;
const COL_GAP = 16;
const OUTER_PAD = 24;
/** Below this column width, UNEQUIP collapses to an `×` icon button. */
const UNEQUIP_ICON_BREAKPOINT = 260;

interface SlotRowRefs {
  slotIdx: number;
  bombType: BombType | null;
  border: Phaser.GameObjects.Graphics;
  /** Bounds in LOCAL coords (inside the bomberman column's container). */
  bounds: { x: number; y: number; w: number; h: number };
}

interface ScrollableColumn {
  inner: Phaser.GameObjects.Container;
  maskShape: Phaser.GameObjects.Graphics;
  /** Viewport rect in scene coords — used by the wheel handler to test cursor location. */
  viewport: { x: number; y: number; w: number; h: number };
  /** Total content height; used to clamp scroll position. */
  contentH: number;
}

export class BombsShopScene extends Phaser.Scene {
  private catalog: BombsCatalogEntry[] = [];
  private selectedStockpile: BombType | null = null;
  private hoveredBombType: BombType | null = null;
  private containers: Phaser.GameObjects.Container[] = [];
  private maskShapes: Phaser.GameObjects.Graphics[] = [];
  private scrollables: ScrollableColumn[] = [];
  private slotRowRefs: SlotRowRefs[] = [];
  /** Bomberman column container — slot highlight bounds are in its local space. */
  private bombermanContainer: Phaser.GameObjects.Container | null = null;
  /** Stockpile panel screen rect — fly-to target for buy/unequip. */
  private stockpileRect: { x: number; y: number; w: number; h: number } | null = null;
  private coinsText!: Phaser.GameObjects.Text;
  private treasureList: TreasureListWidget | null = null;
  private toastText!: Phaser.GameObjects.Text;
  private tooltip: BombShopTooltip | null = null;
  private unsubProfile: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;
  private pointerMoveHandler: ((p: Phaser.Input.Pointer) => void) | null = null;
  private wheelHandler:
    | ((p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => void)
    | null = null;

  /** Scene to return to on Back/Esc. Set per-launch via init data; defaults
   *  to the Main Menu when launched without context. */
  private backScene: string = 'MainMenuScene';

  /** Re-fit the camera when the viewport changes (orientation / window drag). */
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'BombsShopScene' });
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
    trackScreen(this, 'BombsShop');
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { width } = this.scale;
    // Lay out against the design box; `layoutW`/`layoutH` keep edge-anchored
    // elements on the box edges so the camera can scale the whole thing to fit
    // short/narrow viewports (no-op on desktop).
    const { layoutW, layoutH } = designViewport(this, DESIGN_W, DESIGN_H);

    this.add.text(width / 2, 30, 'BOMBS SHOP', {
      fontSize: '26px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    // Coins + treasure wallet — both depth-bumped so they always render on top
    // of the panels (the wallet would otherwise overlap the stockpile column).
    this.coinsText = this.add.text(layoutW - 20, 14, '', {
      fontSize: '18px', color: COIN_GOLD, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(100);

    // Horizontal layout so a stash with many types stays on a single row.
    // Position is right-aligned via setX in renderWallet() after we know
    // the rect width (horizontal layout always extends rightward from anchor,
    // so we compute the width up-front and shift X to right-align).
    this.treasureList = new TreasureListWidget(this, {
      x: layoutW - 20,
      y: 42,
      anchor: 'top-left',
      direction: 'horizontal',
      iconScale: 0.5,
      fontSize: 11,
      rowGap: 4,
      depth: 100,
    });

    this.toastText = this.add.text(width / 2, layoutH - 30, '', {
      fontSize: '14px', color: '#44ff88', fontFamily: 'monospace',
    }).setOrigin(0.5);

    const backBtn = this.add.text(20, layoutH - 30, '[ < BACK ]', {
      fontSize: '14px', color: TEXT_DIM, fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#cccccc'));
    backBtn.on('pointerout', () => backBtn.setColor(TEXT_DIM));
    backBtn.on('pointerdown', () => this.scene.start(this.backScene));

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start(this.backScene));

    this.activity = new ActivityIndicator(this);

    this.selector = new BombermanSelector(this, layoutH - 130);
    this.selector.create();

    this.tooltip = new BombShopTooltip(this);
    this.pointerMoveHandler = (p: Phaser.Input.Pointer) => {
      this.tooltip?.move(p.x, p.y);
    };
    this.input.on('pointermove', this.pointerMoveHandler);

    // Wheel handler routes scroll to whichever column is under the cursor.
    this.wheelHandler = (p, _o, _dx, dy) => {
      for (const s of this.scrollables) {
        const { x, y, w, h } = s.viewport;
        if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) continue;
        const min = Math.min(0, h - s.contentH);
        const next = Phaser.Math.Clamp(s.inner.y - dy * 0.6, s.viewport.y + min, s.viewport.y);
        s.inner.y = next;
      }
    };
    this.input.on('wheel', this.wheelHandler);

    const socket = NetworkManager.connect();
    NetworkManager.track('bombs_shop_request', 'bombs_catalog');
    socket.emit('bombs_shop_request');
    socket.on('bombs_catalog', (msg) => {
      this.catalog = msg.catalog;
      this.rebuild();
    });
    socket.on('shop_result', (msg) => {
      this.toastText.setColor(msg.ok ? '#44ff88' : '#ff4444');
      this.toastText.setText(msg.message ?? msg.reason ?? '');
      this.time.delayedCall(2000, () => this.toastText.setText(''));
    });

    this.unsubProfile = ProfileStore.subscribe(() => {
      this.renderWallet();
      this.rebuild();
    });

    this.renderWallet();
    this.rebuild();

    // Scale the whole shop to fit short/narrow viewports (no-op on desktop).
    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.unsubProfile?.();
    this.unsubProfile = null;
    this.activity?.destroy();
    this.activity = null;
    this.selector?.destroy();
    this.selector = null;
    this.tooltip?.destroy();
    this.tooltip = null;
    this.treasureList?.destroy();
    this.treasureList = null;
    if (this.pointerMoveHandler) {
      this.input.off('pointermove', this.pointerMoveHandler);
      this.pointerMoveHandler = null;
    }
    if (this.wheelHandler) {
      this.input.off('wheel', this.wheelHandler);
      this.wheelHandler = null;
    }
    this.destroyBody();
    const socket = NetworkManager.getSocket();
    socket.off('bombs_catalog');
    socket.off('shop_result');
  }

  private destroyBody(): void {
    for (const c of this.containers) c.destroy();
    this.containers = [];
    for (const m of this.maskShapes) m.destroy();
    this.maskShapes = [];
    this.scrollables = [];
    this.slotRowRefs = [];
    this.bombermanContainer = null;
  }

  private renderWallet(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
    this.coinsText.setText(`Coins: ${profile.coins}`);
    this.treasureList?.setBundle(profile.treasures ?? {});
    // Horizontal layout extends rightward from anchor — right-align by computing
    // the rendered width and shifting X to (rightEdge - width). Use the design
    // box's right edge (`layoutW`) so the wallet sits on the same edge the
    // camera scales, matching the coins/treasure anchors set in create().
    const { layoutW } = designViewport(this, DESIGN_W, DESIGN_H);
    const rect = this.treasureList?.getRect();
    if (rect && rect.w > 0) {
      this.treasureList?.setX(layoutW - 20 - rect.w);
    }
  }

  private rebuild(): void {
    this.destroyBody();
    this.hoveredBombType = null;

    const profile = ProfileStore.get();
    if (!profile || this.catalog.length === 0) return;

    const { width } = this.scale;
    // Column widths follow the live viewport width (centered content); the
    // vertical extent follows the design box height so panels and the selector
    // keep their spacing when the camera scales a short viewport.
    const { layoutH } = designViewport(this, DESIGN_W, DESIGN_H);
    // Hard cutoff: BombermanSelector is anchored at (layoutH - 130) with a 180px
    // tall card centered there, so the YOUR BOMBERMEN label sits at layoutH - 240.
    // Stop the panels 10px above that to guarantee no overlap.
    const bodyTop = 72;
    const bodyBottom = layoutH - 250;
    const bodyH = bodyBottom - bodyTop;

    const availW = width - OUTER_PAD * 2 - COL_GAP * 2;
    const unit = availW / 3.2;
    const colWLeft = unit;
    const colWMid = unit * 1.2;
    const colWRight = unit;
    const colXLeft = OUTER_PAD;
    const colXMid = colXLeft + colWLeft + COL_GAP;
    const colXRight = colXMid + colWMid + COL_GAP;

    this.buildPanel('CATALOG', colXLeft, bodyTop, colWLeft, bodyH, (innerY, innerH) =>
      this.buildCatalogColumn(colXLeft, innerY, colWLeft, innerH, profile));
    this.buildPanel('BOMBERMAN', colXMid, bodyTop, colWMid, bodyH, (innerY, innerH) =>
      this.buildBombermanColumn(colXMid, innerY, colWMid, innerH, profile));
    this.buildPanel('STOCKPILE', colXRight, bodyTop, colWRight, bodyH, (innerY, innerH) =>
      this.buildStockpileColumn(colXRight, innerY, colWRight, innerH, profile));
    this.stockpileRect = { x: colXRight, y: bodyTop, w: colWRight, h: bodyH };
  }

  /** Tween a temporary bomb icon from `(fromX, fromY)` to the stockpile
   *  panel's center. Cosmetic only — the actual server round-trip drives
   *  the profile update which triggers the rebuild. */
  private flyBombToStockpile(bombType: BombType, fromX: number, fromY: number): void {
    if (!this.stockpileRect) return;
    const targetX = this.stockpileRect.x + this.stockpileRect.w / 2;
    const targetY = this.stockpileRect.y + this.stockpileRect.h / 4;
    const icon = this.add.image(fromX, fromY, 'bomb_icons', bombIconFrame(bombType))
      .setDisplaySize(28, 28).setDepth(2000);
    this.tweens.add({
      targets: icon,
      x: targetX,
      y: targetY,
      scale: 0.4,
      alpha: 0.2,
      duration: 380,
      ease: 'Quad.easeIn',
      onComplete: () => icon.destroy(),
    });
  }

  private buildPanel(
    title: string,
    x: number, y: number, w: number, h: number,
    fillBody: (innerY: number, innerH: number) => void,
  ): void {
    const headerH = 24;
    const container = this.add.container(0, 0);
    const bg = this.add.graphics();
    bg.fillStyle(PANEL_BG, 0.85);
    bg.fillRoundedRect(x, y, w, h, 6);
    bg.lineStyle(1, PANEL_BORDER, 1);
    bg.strokeRoundedRect(x, y, w, h, 6);
    container.add(bg);

    const header = this.add.graphics();
    header.fillStyle(PANEL_HEADER_BG, 1);
    header.fillRoundedRect(x, y, w, headerH, 6);
    header.fillRect(x, y + headerH - 6, w, 6);
    container.add(header);
    container.add(this.add.text(x + w / 2, y + headerH / 2, title, {
      fontSize: '12px', color: TEXT_HEADER, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    this.containers.push(container);
    fillBody(y + headerH + 6, h - headerH - 12);
  }

  // -----------------------------------------------------------------------
  // CATALOG column — scrollable 3-col grid
  // -----------------------------------------------------------------------

  private buildCatalogColumn(
    x: number, y: number, w: number, h: number,
    profile: PlayerProfile,
  ): void {
    const cellGap = 6;
    const innerPad = 6;
    const tileW = (w - cellGap * (CATALOG_GRID_COLS - 1) - innerPad * 2) / CATALOG_GRID_COLS;

    const inner = this.add.container(x, y);
    const rows = Math.ceil(this.catalog.length / CATALOG_GRID_COLS);
    const contentH = rows * (CATALOG_TILE_H + cellGap) - cellGap + 4;

    for (let i = 0; i < this.catalog.length; i++) {
      const entry = this.catalog[i];
      const col = i % CATALOG_GRID_COLS;
      const row = Math.floor(i / CATALOG_GRID_COLS);
      const tileX = innerPad + col * (tileW + cellGap);
      const tileY = row * (CATALOG_TILE_H + cellGap);
      this.buildCatalogTile(inner, entry, profile, tileX, tileY, tileW, CATALOG_TILE_H);
    }

    this.applyScrollMask(inner, { x, y, w, h }, contentH);
    this.containers.push(inner);
  }

  private buildCatalogTile(
    parent: Phaser.GameObjects.Container,
    entry: BombsCatalogEntry,
    profile: PlayerProfile,
    x: number, y: number, w: number, h: number,
  ): void {
    const coinsShort = profile.coins < entry.price;
    const treasureShort = entry.treasureCost
      ? (profile.treasures[entry.treasureCost.type] ?? 0) < entry.treasureCost.amount
      : false;
    const affordable = !coinsShort && !treasureShort;
    const tileAlpha = affordable ? 1 : 0.65;

    const bg = this.add.graphics().setAlpha(tileAlpha);
    bg.fillStyle(0x222238, 0.95);
    bg.fillRoundedRect(x, y, w, h, 4);
    bg.lineStyle(1, PANEL_BORDER, 1);
    bg.strokeRoundedRect(x, y, w, h, 4);
    parent.add(bg);

    // Hover zone — added FIRST after bg, so buttons added later are on top.
    const hoverZone = this.add.zone(x, y, w, h).setOrigin(0, 0);
    hoverZone.setInteractive({ useHandCursor: false });
    this.wireHover(hoverZone, entry);
    parent.add(hoverZone);

    // Content (non-interactive). Compact layout to fit 5 rows in the panel
    // without scrolling on standard window heights.
    parent.add(this.add.image(x + w / 2, y + 18, 'bomb_icons', bombIconFrame(entry.type))
      .setDisplaySize(28, 28).setAlpha(tileAlpha));

    parent.add(this.add.text(x + w / 2, y + 36, entry.name, {
      fontSize: '9px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
      align: 'center', wordWrap: { width: w - 6 },
    }).setOrigin(0.5, 0).setAlpha(tileAlpha));

    // Price row (centered)
    const priceY = y + h - 24;
    const coinsLabel = this.add.text(0, 0, `${entry.price}c`, {
      fontSize: '11px', color: coinsShort ? WARN_RED : COIN_GOLD,
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);

    let treasureLabel: Phaser.GameObjects.Text | null = null;
    let treasureIcon: Phaser.GameObjects.Image | null = null;
    if (entry.treasureCost) {
      treasureLabel = this.add.text(0, 0, `${entry.treasureCost.amount}`, {
        fontSize: '11px', color: treasureShort ? WARN_RED : TEXT_DEFAULT,
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      treasureIcon = this.add.image(0, 0, TREASURE_TEXTURE_KEY, treasureIconFrame(entry.treasureCost.type))
        .setDisplaySize(12, 12).setOrigin(0, 0.5);
    }
    const rowGap = 3;
    const totalRowW =
      coinsLabel.width +
      (treasureLabel ? 8 + treasureLabel.width + rowGap + 12 : 0);
    let rowX = x + (w - totalRowW) / 2;
    coinsLabel.setPosition(rowX, priceY);
    rowX += coinsLabel.width + 8;
    if (treasureLabel && treasureIcon) {
      treasureLabel.setPosition(rowX, priceY);
      rowX += treasureLabel.width + rowGap;
      treasureIcon.setPosition(rowX, priceY);
    }
    parent.add(coinsLabel);
    if (treasureLabel) parent.add(treasureLabel);
    if (treasureIcon) parent.add(treasureIcon);

    // BUY button on top — wins clicks AND fires hover to keep tooltip visible.
    const btnY = y + h - 9;
    if (affordable) {
      const btn = this.add.text(x + w / 2, btnY, 'BUY', {
        fontSize: '10px', color: COIN_GOLD, fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#332a44', padding: { x: 8, y: 1 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        NetworkManager.track('buy_bomb', 'profile');
        NetworkManager.getSocket().emit('buy_bomb', { type: entry.type, quantity: 1 });
        this.flyBombToStockpile(entry.type, x + w / 2, btnY);
      });
      this.wireHover(btn, entry);
      parent.add(btn);
    } else {
      parent.add(this.add.text(x + w / 2, btnY, '—', {
        fontSize: '11px', color: '#555566', fontFamily: 'monospace',
      }).setOrigin(0.5));
    }
  }

  // -----------------------------------------------------------------------
  // STOCKPILE column — scrollable 3-col grid
  // -----------------------------------------------------------------------

  private buildStockpileColumn(
    x: number, y: number, w: number, h: number,
    profile: PlayerProfile,
  ): void {
    const stockpile = profile.bombStockpile ?? {};
    const stockEntries = Object.entries(stockpile).filter(([, c]) => (c ?? 0) > 0) as [BombType, number][];

    const cellGap = 6;
    const innerPad = 6;
    const tileW = (w - cellGap * (STOCKPILE_GRID_COLS - 1) - innerPad * 2) / STOCKPILE_GRID_COLS;

    const inner = this.add.container(x, y);

    if (stockEntries.length === 0) {
      inner.add(this.add.text(w / 2, 28, '(empty — buy some bombs)', {
        fontSize: '11px', color: '#666', fontFamily: 'monospace',
      }).setOrigin(0.5));
      this.applyScrollMask(inner, { x, y, w, h }, 60);
      this.containers.push(inner);
      return;
    }

    let contentH = 0;
    for (let i = 0; i < stockEntries.length; i++) {
      const [type, count] = stockEntries[i];
      const entry = this.catalog.find(c => c.type === type);
      if (!entry) continue;
      const col = i % STOCKPILE_GRID_COLS;
      const row = Math.floor(i / STOCKPILE_GRID_COLS);
      const tx = innerPad + col * (tileW + cellGap);
      const ty = row * (STOCKPILE_TILE_H + cellGap);
      this.buildStockpileTile(inner, entry, count, tx, ty, tileW, STOCKPILE_TILE_H);
      contentH = ty + STOCKPILE_TILE_H + 4;
    }

    if (this.selectedStockpile) {
      const sel = this.catalog.find(c => c.type === this.selectedStockpile);
      const selName = sel?.name ?? this.selectedStockpile;
      inner.add(this.add.text(w / 2, contentH + 6,
        `Selected: ${selName}\nPick a slot to equip`, {
          fontSize: '10px', color: '#44ff88', fontFamily: 'monospace', align: 'center',
        }).setOrigin(0.5, 0));
      contentH += 36;
    }

    this.applyScrollMask(inner, { x, y, w, h }, contentH);
    this.containers.push(inner);
  }

  private buildStockpileTile(
    parent: Phaser.GameObjects.Container,
    entry: BombsCatalogEntry,
    count: number,
    x: number, y: number, w: number, h: number,
  ): void {
    const isSelected = this.selectedStockpile === entry.type;

    const bg = this.add.graphics();
    bg.fillStyle(isSelected ? 0x334477 : 0x222238, 0.95);
    bg.fillRoundedRect(x, y, w, h, 4);
    bg.lineStyle(isSelected ? 2 : 1, isSelected ? HIGHLIGHT_GOLD : PANEL_BORDER, 1);
    bg.strokeRoundedRect(x, y, w, h, 4);
    parent.add(bg);

    // Click+hover zone added BEFORE content so... wait no, we need it as the
    // top-most interactive thing here because it's the click handler. There
    // are no nested buttons. Add it last so it's on top.
    parent.add(this.add.image(x + w / 2, y + 20, 'bomb_icons', bombIconFrame(entry.type))
      .setDisplaySize(28, 28));
    parent.add(this.add.text(x + w / 2, y + h - 10, entry.name, {
      fontSize: '9px', color: TEXT_DEFAULT, fontFamily: 'monospace',
      align: 'center', wordWrap: { width: w - 6 },
    }).setOrigin(0.5));

    // Stock badge top-right
    const badgeBg = this.add.graphics();
    badgeBg.fillStyle(0x227744, 1);
    badgeBg.fillRoundedRect(x + w - 22, y + 3, 20, 12, 3);
    parent.add(badgeBg);
    parent.add(this.add.text(x + w - 12, y + 9, `${count}`, {
      fontSize: '9px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Click+hover surface on top
    const click = this.add.zone(x, y, w, h).setOrigin(0, 0);
    click.setInteractive({ useHandCursor: true });
    click.on('pointerdown', () => {
      this.handleStockpileClick(entry.type);
    });
    this.wireHover(click, entry);
    parent.add(click);
  }

  /**
   * Stockpile tile click. Two behaviours:
   *  - If the bomb is already equipped in any slot that still has room,
   *    auto-stack into that slot (top up to the stack limit). Skips the
   *    "select then click slot" dance.
   *  - Otherwise, toggle stockpile selection so the player can pick which
   *    empty slot to fill.
   */
  private handleStockpileClick(type: BombType): void {
    const profile = ProfileStore.get();
    const equipped = profile?.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (equipped) {
      const stackLimit = effectiveStackSize(equipped);
      const slots = equipped.inventory.slots;
      const slotCount = effectiveMaxCustomSlots(equipped);
      for (let i = 0; i < slotCount; i++) {
        const slot = slots[i];
        if (slot && slot.type === type && slot.count < stackLimit) {
          NetworkManager.track('equip_bomb', 'profile');
          NetworkManager.getSocket().emit('equip_bomb', {
            type,
            slotIndex: i,
            quantity: stackLimit,
          });
          // Clear any stale selection — the auto-stack equip "consumes" the click.
          if (this.selectedStockpile === type) this.selectedStockpile = null;
          return;
        }
      }
    }
    this.selectedStockpile = this.selectedStockpile === type ? null : type;
    this.rebuild();
  }

  // -----------------------------------------------------------------------
  // BOMBERMAN column (portrait header + slot rows) — static (not scrollable)
  // -----------------------------------------------------------------------

  private buildBombermanColumn(
    x: number, y: number, w: number, _h: number,
    profile: PlayerProfile,
  ): void {
    const container = this.add.container(x, y);
    this.bombermanContainer = container;

    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (!equipped) {
      container.add(this.add.text(w / 2, 40, 'No Bomberman equipped.\nBuy one first.', {
        fontSize: '11px', color: '#666', fontFamily: 'monospace', align: 'center',
      }).setOrigin(0.5));
      this.containers.push(container);
      return;
    }

    // --- Portrait header ---
    const headerH = 78;
    const portraitCX = 44;
    const portraitCY = headerH / 2;
    const previewContainer = this.add.container(portraitCX, portraitCY);
    const preview = createShopBombermanSprite(
      this, 0, 0,
      equipped.tint, equipped.character, UiAnimLock.get(equipped.id), 1.0,
    );
    previewContainer.add(preview);
    const effSlots = effectiveMaxCustomSlots(equipped);
    const effStack = effectiveStackSize(equipped);
    attachTierInfoBadge(this, previewContainer, {
      x: 30, y: -28,
      tier: equipped.tier,
      maxCustomSlots: effSlots,
      stackSize: effStack,
      tooltipSide: 'left',
    });
    container.add(previewContainer);

    const textX = 92;
    container.add(this.add.text(textX, 10, equipped.name ?? 'Bomberman', {
      fontSize: '16px', color: TEXT_DEFAULT, fontFamily: 'monospace', fontStyle: 'bold',
    }));
    const totalCarried = (equipped.inventory?.slots ?? [])
      .reduce((acc: number, s) => acc + (s?.count ?? 0), 0);
    const totalCapacity = effSlots * effStack;
    container.add(this.add.text(textX, 32, `Tier ${equipped.tier} · ${totalCarried}/${totalCapacity} carried`, {
      fontSize: '10px', color: TEXT_DIM, fontFamily: 'monospace',
    }));

    const meterY = 50;
    const meterW = Math.min(w - textX - 12, 200);
    const meterH = 5;
    const fillRatio = totalCapacity > 0 ? Math.min(1, totalCarried / totalCapacity) : 0;
    const meter = this.add.graphics();
    meter.fillStyle(0x222244, 1);
    meter.fillRoundedRect(textX, meterY, meterW, meterH, 2);
    if (fillRatio > 0) {
      meter.fillStyle(0x44dd88, 1);
      meter.fillRoundedRect(textX, meterY, Math.max(2, meterW * fillRatio), meterH, 2);
    }
    container.add(meter);

    const divider = this.add.graphics();
    divider.lineStyle(1, PANEL_BORDER, 0.6);
    divider.beginPath();
    divider.moveTo(8, headerH);
    divider.lineTo(w - 8, headerH);
    divider.strokePath();
    container.add(divider);

    // --- Slot rows ---
    const slotsStartY = headerH + 8;
    const totalRows = effSlots + 1;
    const slotH = totalRows >= 7 ? 28 : totalRows >= 6 ? 32 : 36;
    const slotGap = 3;
    const stackLimit = effStack;

    for (let slotIdx = 0; slotIdx < effSlots; slotIdx++) {
      const slot = equipped.inventory.slots[slotIdx];
      const rowY = slotsStartY + slotIdx * (slotH + slotGap);
      this.buildSlotRow(container, w, rowY, slotH, slotIdx, slot, stackLimit, false);
    }

    const rockY = slotsStartY + effSlots * (slotH + slotGap);
    this.buildSlotRow(container, w, rockY, slotH, effSlots,
      { type: 'rock' as BombType, count: 0 }, stackLimit, true);

    this.containers.push(container);
  }

  private buildSlotRow(
    parent: Phaser.GameObjects.Container,
    colW: number, y: number, h: number,
    slotIdx: number,
    slot: { type: BombType; count: number } | null,
    stackLimit: number,
    isRock: boolean,
  ): void {
    const padX = 8;
    const innerW = colW - padX * 2;
    const innerX = padX;

    const bg = this.add.graphics();
    if (isRock) {
      bg.lineStyle(1, ROCK_BORDER, 1);
      this.strokeDashedRoundedRect(bg, innerX, y, innerW, h, 4, 4, 3);
    } else {
      bg.fillStyle(SLOT_BG, 0.9);
      bg.fillRoundedRect(innerX, y, innerW, h, 4);
      bg.lineStyle(1, PANEL_BORDER, 1);
      bg.strokeRoundedRect(innerX, y, innerW, h, 4);
    }
    parent.add(bg);

    // Border overlay for hover highlight — drawn separately so we can re-stroke
    // it without redrawing the base bg.
    const highlight = this.add.graphics();
    parent.add(highlight);
    this.slotRowRefs.push({
      slotIdx,
      bombType: slot?.type ?? null,
      border: highlight,
      bounds: { x: innerX, y, w: innerW, h },
    });

    // Hover zone — added FIRST so click zones layered later win pointerdown.
    const entry = slot ? this.catalog.find(c => c.type === slot.type) : null;
    if (entry) {
      const hover = this.add.zone(innerX, y, innerW, h).setOrigin(0, 0);
      hover.setInteractive({ useHandCursor: false });
      this.wireHover(hover, entry);
      parent.add(hover);
    }

    // Content
    parent.add(this.add.text(innerX + 4, y + h / 2, `SLOT ${slotIdx + 1}`, {
      fontSize: '8px', color: TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5));

    if (slot && (slot.count > 0 || isRock)) {
      const iconX = innerX + 48;
      parent.add(this.add.image(iconX, y + h / 2, 'bomb_icons', bombIconFrame(slot.type))
        .setDisplaySize(22, 22));

      const nameX = iconX + 18;
      const name = entry?.name ?? slot.type;
      parent.add(this.add.text(nameX, y + h / 2 - 5, name, {
        fontSize: '10px', color: isRock ? '#ccaa88' : TEXT_DEFAULT,
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0.5));

      if (isRock) {
        parent.add(this.add.text(nameX, y + h / 2 + 7, 'infinite (fallback)', {
          fontSize: '8px', color: '#776655', fontFamily: 'monospace',
        }).setOrigin(0, 0.5));
      } else {
        const fillRatio = slot.count / stackLimit;
        const meterW = Math.min(48, innerW - (nameX - innerX) - 80);
        if (meterW > 8) {
          const fillFull = slot.count >= stackLimit;
          const meter = this.add.graphics();
          meter.fillStyle(0x222244, 1);
          meter.fillRect(nameX, y + h / 2 + 5, meterW, 3);
          meter.fillStyle(fillFull ? 0x44dd88 : HIGHLIGHT_GOLD, 1);
          meter.fillRect(nameX, y + h / 2 + 5, Math.max(2, meterW * fillRatio), 3);
          parent.add(meter);
        }
      }

      const countText = isRock ? '∞' : `${slot.count}/${stackLimit}`;
      const countColor = !isRock && slot.count >= stackLimit ? '#44dd88' : TEXT_DEFAULT;
      const countX = innerX + innerW - (isRock ? 14 : 56);
      parent.add(this.add.text(countX, y + h / 2, countText, {
        fontSize: '10px', color: countColor, fontFamily: 'monospace',
      }).setOrigin(0.5, 0.5));

      // UNEQUIP button on top of hover zone — wins clicks.
      if (!isRock) {
        const useIconBtn = colW < UNEQUIP_ICON_BREAKPOINT;
        const btnX = innerX + innerW - 4;
        const btn = useIconBtn
          ? this.add.text(btnX, y + h / 2, '×', {
              fontSize: '14px', color: '#ff8844', fontFamily: 'monospace', fontStyle: 'bold',
              backgroundColor: '#221a2e', padding: { x: 4, y: 0 },
            }).setOrigin(1, 0.5)
          : this.add.text(btnX, y + h / 2, 'UNEQUIP', {
              fontSize: '8px', color: '#ff8844', fontFamily: 'monospace',
              backgroundColor: '#221a2e', padding: { x: 5, y: 2 },
            }).setOrigin(1, 0.5);
        btn.setInteractive({ useHandCursor: true });
        const bombType = slot.type;
        btn.on('pointerdown', () => {
          NetworkManager.track('unequip_bomb', 'profile');
          NetworkManager.getSocket().emit('unequip_bomb', { slotIndex: slotIdx });
          // Fly from the slot's screen-space center, not the small × button —
          // it reads better as "the equipped bomb moves to storage."
          const m = btn.getWorldTransformMatrix();
          this.flyBombToStockpile(bombType, m.tx, m.ty);
        });
        if (entry) this.wireHover(btn, entry);
        parent.add(btn);
      }
    } else {
      parent.add(this.add.text(innerX + 48, y + h / 2, 'empty', {
        fontSize: '10px', color: '#666', fontFamily: 'monospace',
      }).setOrigin(0, 0.5));
    }

    // Equip click zone — only when stockpile has a selection. Skipped for the
    // Rock slot (out of equip range server-side). Inserted just below the
    // UNEQUIP button so the button still wins clicks in its sub-area.
    if (this.selectedStockpile && !isRock) {
      const selected = this.selectedStockpile;
      const click = this.add.zone(innerX, y, innerW, h).setOrigin(0, 0);
      click.setInteractive({ useHandCursor: true });
      click.on('pointerdown', () => {
        NetworkManager.track('equip_bomb', 'profile');
        NetworkManager.getSocket().emit('equip_bomb', {
          type: selected,
          slotIndex: slotIdx,
          quantity: stackLimit,
        });
      });
      if (entry) {
        // Filled slot — full hover (tooltip + cross-column highlight).
        this.wireHover(click, entry);
      } else {
        // Empty slot — just toggle gold border on hover to signal "click here
        // to drop the selected bomb." No tooltip (no bomb to describe yet).
        click.on('pointerover', () => {
          highlight.clear();
          highlight.lineStyle(2, HIGHLIGHT_GOLD, 1);
          highlight.strokeRoundedRect(innerX, y, innerW, h, 4);
        });
        click.on('pointerout', () => {
          highlight.clear();
        });
      }
      parent.addAt(click, Math.max(0, parent.length - 1));
    }
  }

  // -----------------------------------------------------------------------
  // Scroll-mask helper
  // -----------------------------------------------------------------------

  private applyScrollMask(
    inner: Phaser.GameObjects.Container,
    viewport: { x: number; y: number; w: number; h: number },
    contentH: number,
  ): void {
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
    const mask = maskShape.createGeometryMask();
    inner.setMask(mask);
    this.maskShapes.push(maskShape);
    this.scrollables.push({ inner, maskShape, viewport, contentH });
  }

  // -----------------------------------------------------------------------
  // Hover plumbing
  // -----------------------------------------------------------------------

  /**
   * Wire pointerover / pointerout on an interactive GameObject so it pushes
   * a tooltip + cross-column highlight for the given bomb. Both the hover
   * zone underneath and the buttons on top use this so transitions between
   * them feel continuous (the tooltip's 60ms hide grace absorbs the gap).
   */
  private wireHover(target: Phaser.GameObjects.GameObject, entry: BombsCatalogEntry): void {
    target.on('pointerover', (p: Phaser.Input.Pointer) => {
      this.tooltip?.show(entry);
      this.tooltip?.move(p.x, p.y);
      this.setHoveredBomb(entry.type);
    });
    target.on('pointerout', () => {
      this.tooltip?.hide();
      this.setHoveredBomb(null);
    });
  }

  private setHoveredBomb(type: BombType | null): void {
    if (this.hoveredBombType === type) return;
    this.hoveredBombType = type;
    // Slot row bounds are in the bomberman container's LOCAL space — re-draw
    // border graphic (which is also a child of that container) in local coords.
    for (const ref of this.slotRowRefs) {
      ref.border.clear();
      if (type !== null && ref.bombType === type) {
        ref.border.lineStyle(2, HIGHLIGHT_GOLD, 1);
        ref.border.strokeRoundedRect(ref.bounds.x, ref.bounds.y, ref.bounds.w, ref.bounds.h, 4);
      }
    }
  }

  private strokeDashedRoundedRect(
    g: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number,
    _radius: number, dashLen: number, gapLen: number,
  ): void {
    const step = dashLen + gapLen;
    for (let i = x; i < x + w; i += step) {
      const end = Math.min(i + dashLen, x + w);
      g.beginPath(); g.moveTo(i, y); g.lineTo(end, y); g.strokePath();
    }
    for (let i = x; i < x + w; i += step) {
      const end = Math.min(i + dashLen, x + w);
      g.beginPath(); g.moveTo(i, y + h); g.lineTo(end, y + h); g.strokePath();
    }
    for (let i = y; i < y + h; i += step) {
      const end = Math.min(i + dashLen, y + h);
      g.beginPath(); g.moveTo(x, i); g.lineTo(x, end); g.strokePath();
    }
    for (let i = y; i < y + h; i += step) {
      const end = Math.min(i + dashLen, y + h);
      g.beginPath(); g.moveTo(x + w, i); g.lineTo(x + w, end); g.strokePath();
    }
  }
}
