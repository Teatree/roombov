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
import { effectiveMaxCustomSlots, effectiveMaxHp, effectiveStackSize, upgradeLevel } from '@shared/utils/bomberman-stats.ts';
import { createIdleActionBadge } from '../systems/IdleActionBadge.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { COL, CSS, FONT } from '../design/tokens.ts';
import {
  addTabLabel, drawNotchedPanel, drawDashedRect, notchedPoints,
} from '../util/pixelPanel.ts';

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
    this.cameras.main.setBackgroundColor(CSS.bg);
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { width } = this.scale;
    // Lay out against the design box; `layoutW`/`layoutH` keep edge-anchored
    // elements on the box edges so the camera can scale the whole thing to fit
    // short/narrow viewports (no-op on desktop).
    const { layoutW, layoutH } = designViewport(this, DESIGN_W, DESIGN_H);

    this.add.text(width / 2, 30, 'BOMBS SHOP', {
      fontSize: '26px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5).setShadow(5, 5, CSS.stageFrame, 0, true, true);

    // Coins + treasure wallet — both depth-bumped so they always render on top
    // of the panels (the wallet would otherwise overlap the stockpile column).
    this.coinsText = this.add.text(layoutW - 20, 14, '', {
      fontSize: '18px', color: CSS.gold, fontFamily: FONT.press,
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
      fontSize: '14px', color: CSS.green, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    const backBtn = this.add.text(20, layoutH - 30, '[ < BACK ]', {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor(CSS.text));
    backBtn.on('pointerout', () => backBtn.setColor(CSS.dim));
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
      this.toastText.setColor(msg.ok ? CSS.green : CSS.red);
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
    this.coinsText.setText(`${profile.coins}c`);
    this.treasureList?.setBundle(profile.treasures ?? {});
    // Flush right against the design box's right edge (`layoutW`, the edge the
    // camera scales) — align by the real rendered extent so short counts don't
    // leave a trailing gap (see rightAlignTo).
    const { layoutW } = designViewport(this, DESIGN_W, DESIGN_H);
    this.treasureList?.rightAlignTo(layoutW - 20);
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
    drawNotchedPanel(bg, x, y, w, h, {
      fill: COL.panel, border: COL.border, borderWidth: 2, notch: 8,
    });
    container.add(bg);

    // Tab label rides the top border (replaces the old header bar + title).
    const { label, bg: tabBg } = addTabLabel(this, x, y, w, title, {
      side: 'center', color: CSS.dim, panelFill: COL.panel, fontPx: 14,
    });
    container.add([tabBg, label]);

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
    drawNotchedPanel(bg, x, y, w, h, {
      fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 5,
    });
    parent.add(bg);

    // Hover zone — added FIRST after bg, so buttons added later are on top.
    const hoverZone = this.add.zone(x, y, w, h).setOrigin(0, 0);
    hoverZone.setInteractive({ useHandCursor: false });
    this.wireHover(hoverZone, entry);
    parent.add(hoverZone);

    // Content (non-interactive). Compact layout to fit 5 rows in the panel
    // without scrolling on standard window heights.
    const bombIcon = this.add.image(x + w / 2, y + 18, 'bomb_icons', bombIconFrame(entry.type))
      .setDisplaySize(28, 28).setAlpha(tileAlpha);
    parent.add(bombIcon);

    parent.add(this.add.text(x + w / 2, y + 36, entry.name, {
      fontSize: '9px', color: CSS.text, fontFamily: FONT.silk,
      align: 'center', wordWrap: { width: w - 6 },
    }).setOrigin(0.5, 0).setAlpha(tileAlpha));

    // Secondary treasure cost (only while the treasure economy is live) sits
    // just above the button as a small centered row. The coin price now lives
    // INSIDE the BUY button (clearer than a separate price line).
    if (entry.treasureCost) {
      const treasureY = y + h - 30;
      const treasureLabel = this.add.text(0, 0, `${entry.treasureCost.amount}`, {
        fontSize: '11px', color: treasureShort ? CSS.red : CSS.text,
        fontFamily: FONT.press,
      }).setOrigin(0, 0.5);
      const treasureIcon = this.add.image(0, 0, TREASURE_TEXTURE_KEY, treasureIconFrame(entry.treasureCost.type))
        .setDisplaySize(12, 12).setOrigin(0, 0.5);
      const rowGap = 3;
      const totalRowW = treasureLabel.width + rowGap + 12;
      let rowX = x + (w - totalRowW) / 2;
      treasureLabel.setPosition(rowX, treasureY);
      rowX += treasureLabel.width + rowGap;
      treasureIcon.setPosition(rowX, treasureY);
      parent.add(treasureLabel);
      parent.add(treasureIcon);
    }

    // BUY button on top — wins clicks AND fires hover to keep tooltip visible.
    // Price is rendered inside the button. Gold notched chip when affordable;
    // dim faint chip otherwise.
    const buyLabel = `BUY  ${entry.price}c`;
    const btnW = w - 8;
    const btnH = 20;
    const btnCy = y + h - 13;
    const btnX = x + w / 2 - btnW / 2;
    const btnG = this.add.graphics();
    if (affordable) {
      parent.add(btnG);
      const btn = this.add.text(x + w / 2, btnCy, buyLabel, {
        fontSize: '9px', color: CSS.goldText, fontFamily: FONT.press,
      }).setOrigin(0.5);
      parent.add(btn);
      // Full-chip hit zone. A Text's hit area is only its glyph box, so the
      // chip's margins weren't hoverable/clickable — the zone covers the whole
      // button. Origin (0,0) so the input-local rect lines up with the chip.
      const hit = this.add.zone(btnX, btnCy - btnH / 2, btnW, btnH)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true });
      // Hover lightens the border; press sinks the whole chip 2px (matches
      // makePixelButton). Redrawn here rather than once so it can react.
      let hover = false;
      let pressed = false;
      const drawBtn = () => {
        btnG.clear();
        const off = pressed ? 2 : 0;
        drawNotchedPanel(btnG, btnX, btnCy - btnH / 2 + off, btnW, btnH, {
          fill: COL.gold, border: hover && !pressed ? 0xffffff : COL.goldEdge,
          borderWidth: 2, notch: 4,
        });
        btn.setY(btnCy + off);
      };
      drawBtn();
      hit.on('pointerover', () => { hover = true; drawBtn(); });
      hit.on('pointerout', () => { hover = false; pressed = false; drawBtn(); });
      hit.on('pointerup', () => { pressed = false; drawBtn(); });
      hit.on('pointerdown', () => {
        pressed = true; drawBtn();
        NetworkManager.track('buy_bomb', 'profile');
        NetworkManager.getSocket().emit('buy_bomb', { type: entry.type, quantity: 1 });
        // Fly from the bomb icon's actual on-screen position (its world
        // transform), not the tile-local coords — the catalog lives inside a
        // scrolled/offset container, so passing local coords launched it from
        // the upper-left corner of the scene.
        const m = bombIcon.getWorldTransformMatrix();
        this.flyBombToStockpile(entry.type, m.tx, m.ty);
      });
      this.wireHover(hit, entry);
      parent.add(hit);
    } else {
      btnG.setAlpha(0.55);
      drawNotchedPanel(btnG, btnX, btnCy - btnH / 2, btnW, btnH, {
        fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 4,
      });
      parent.add(btnG);
      parent.add(this.add.text(x + w / 2, btnCy, buyLabel, {
        fontSize: '9px', color: CSS.faint, fontFamily: FONT.press,
      }).setOrigin(0.5).setAlpha(0.55));
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
        fontSize: '11px', color: CSS.faint, fontFamily: FONT.silk,
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
          fontSize: '10px', color: CSS.green, fontFamily: FONT.silk, align: 'center',
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
    drawNotchedPanel(bg, x, y, w, h, {
      fill: COL.panel2, border: isSelected ? COL.green : COL.border,
      borderWidth: 2, notch: 5,
    });
    parent.add(bg);

    // Click+hover zone added BEFORE content so... wait no, we need it as the
    // top-most interactive thing here because it's the click handler. There
    // are no nested buttons. Add it last so it's on top.
    parent.add(this.add.image(x + w / 2, y + 20, 'bomb_icons', bombIconFrame(entry.type))
      .setDisplaySize(28, 28));
    parent.add(this.add.text(x + w / 2, y + h - 10, entry.name, {
      fontSize: '9px', color: CSS.text, fontFamily: FONT.silk,
      align: 'center', wordWrap: { width: w - 6 },
    }).setOrigin(0.5));

    // Stock count badge top-right — green fill, dark count for legibility.
    const badgeBg = this.add.graphics();
    badgeBg.fillStyle(COL.green, 1);
    badgeBg.fillRect(x + w - 22, y + 3, 20, 12);
    parent.add(badgeBg);
    parent.add(this.add.text(x + w - 12, y + 9, `${count}`, {
      fontSize: '9px', color: CSS.goldText, fontFamily: FONT.press,
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
        fontSize: '11px', color: CSS.faint, fontFamily: FONT.silk, align: 'center',
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
      level: upgradeLevel(equipped),
      idleAction: equipped.idleAction ?? 'attack',
      maxCustomSlots: effSlots,
      stackSize: effStack,
      hp: effectiveMaxHp(equipped),
      name: equipped.name,
      sp: equipped.sp ?? 0,
      tooltipSide: 'left',
    });
    container.add(previewContainer);

    const textX = 92;
    container.add(this.add.text(textX, 10, equipped.name ?? 'Bomberman', {
      fontSize: '16px', color: CSS.text, fontFamily: FONT.press,
    }));
    const totalCarried = (equipped.inventory?.slots ?? [])
      .reduce((acc: number, s) => acc + (s?.count ?? 0), 0);
    const totalCapacity = effSlots * effStack;
    container.add(this.add.text(textX, 32, `LV ${upgradeLevel(equipped)} · ${totalCarried}/${totalCapacity} carried`, {
      fontSize: '10px', color: CSS.dim, fontFamily: FONT.silk,
    }));

    const meterY = 50;
    const meterW = Math.min(w - textX - 12, 200);
    const meterH = 5;
    const fillRatio = totalCapacity > 0 ? Math.min(1, totalCarried / totalCapacity) : 0;
    const meterFull = totalCapacity > 0 && totalCarried >= totalCapacity;
    const meter = this.add.graphics();
    meter.fillStyle(COL.panel2, 1);
    meter.fillRect(textX, meterY, meterW, meterH);
    if (fillRatio > 0) {
      meter.fillStyle(meterFull ? COL.green : COL.gold, 1);
      meter.fillRect(textX, meterY, Math.max(2, meterW * fillRatio), meterH);
    }
    container.add(meter);

    // Class label (Ambusher / Healster / Disguiser), tucked under the meter.
    container.add(createIdleActionBadge(this, textX, 60, equipped.idleAction ?? 'attack', '10px')
      .setOrigin(0, 0));

    const divider = this.add.graphics();
    divider.lineStyle(1, COL.border, 1);
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
      drawDashedRect(bg, innerX, y, innerW, h, COL.border, 2, 6, 4);
    } else {
      drawNotchedPanel(bg, innerX, y, innerW, h, {
        fill: COL.panel2, border: COL.border, borderWidth: 2, notch: 5,
      });
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
      fontSize: '8px', color: CSS.faint, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5));

    if (slot && (slot.count > 0 || isRock)) {
      const iconX = innerX + 48;
      parent.add(this.add.image(iconX, y + h / 2, 'bomb_icons', bombIconFrame(slot.type))
        .setDisplaySize(22, 22));

      const nameX = iconX + 18;
      const name = entry?.name ?? slot.type;
      parent.add(this.add.text(nameX, y + h / 2 - 5, name, {
        fontSize: '10px', color: isRock ? CSS.dim : CSS.text,
        fontFamily: FONT.silk,
      }).setOrigin(0, 0.5));

      if (isRock) {
        parent.add(this.add.text(nameX, y + h / 2 + 7, 'infinite (fallback)', {
          fontSize: '8px', color: CSS.faint, fontFamily: FONT.silk,
        }).setOrigin(0, 0.5));
      } else {
        const fillRatio = slot.count / stackLimit;
        const meterW = Math.min(48, innerW - (nameX - innerX) - 80);
        if (meterW > 8) {
          const fillFull = slot.count >= stackLimit;
          const meter = this.add.graphics();
          meter.fillStyle(COL.panel, 1);
          meter.fillRect(nameX, y + h / 2 + 5, meterW, 3);
          meter.fillStyle(fillFull ? COL.green : COL.gold, 1);
          meter.fillRect(nameX, y + h / 2 + 5, Math.max(2, meterW * fillRatio), 3);
          parent.add(meter);
        }
      }

      // Right side: the "count/cap" readout sits just LEFT of a proper notched
      // UNEQUIP button anchored to the row's right edge. (Previously the count
      // and the UNEQUIP label overlapped, so "2/5" read as "2/ UNEQUIP".)
      if (isRock) {
        parent.add(this.add.text(innerX + innerW - 14, y + h / 2, '∞', {
          fontSize: '10px', color: CSS.gold, fontFamily: FONT.press,
        }).setOrigin(0.5, 0.5));
      } else {
        const useIconBtn = colW < UNEQUIP_ICON_BREAKPOINT;
        const uneqW = useIconBtn ? 22 : 64;
        const uneqH = 20;
        const uneqRight = innerX + innerW - 4;
        const uneqCx = uneqRight - uneqW / 2;
        const uneqCy = y + h / 2;
        const bombType = slot.type;

        // Count "2/5" right-aligned, with an 8px gap before the button.
        const countColor = slot.count >= stackLimit ? CSS.green : CSS.gold;
        parent.add(this.add.text(uneqRight - uneqW - 8, y + h / 2, `${slot.count}/${stackLimit}`, {
          fontSize: '10px', color: countColor, fontFamily: FONT.press,
        }).setOrigin(1, 0.5));

        // Notched red button with hover/press feedback (matches the BUY chip).
        const ug = this.add.graphics();
        parent.add(ug);
        const label = this.add.text(uneqCx, uneqCy, useIconBtn ? '×' : 'UNEQUIP', {
          fontSize: useIconBtn ? '14px' : '8px', color: CSS.red,
          fontFamily: useIconBtn ? FONT.press : FONT.silk,
        }).setOrigin(0.5);
        parent.add(label);
        let hover = false;
        let pressed = false;
        const drawUneq = () => {
          ug.clear();
          const off = pressed ? 2 : 0;
          drawNotchedPanel(ug, uneqCx - uneqW / 2, uneqCy - uneqH / 2 + off, uneqW, uneqH, {
            fill: COL.panel2, border: hover && !pressed ? COL.red : COL.border,
            borderWidth: 2, notch: 3,
          });
          label.setY(uneqCy + off);
        };
        drawUneq();
        // Full-button hit zone — added last so it wins clicks over the equip
        // zone inserted below it.
        const hit = this.add.zone(uneqCx - uneqW / 2, uneqCy - uneqH / 2, uneqW, uneqH)
          .setOrigin(0, 0).setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => { hover = true; drawUneq(); });
        hit.on('pointerout', () => { hover = false; pressed = false; drawUneq(); });
        hit.on('pointerup', () => { pressed = false; drawUneq(); });
        hit.on('pointerdown', () => {
          pressed = true; drawUneq();
          NetworkManager.track('unequip_bomb', 'profile');
          NetworkManager.getSocket().emit('unequip_bomb', { slotIndex: slotIdx });
          // Fly from the button's screen-space center — reads as "the equipped
          // bomb moves to storage."
          const m = hit.getWorldTransformMatrix();
          this.flyBombToStockpile(bombType, m.tx, m.ty);
        });
        if (entry) this.wireHover(hit, entry);
        parent.add(hit);
      }
    } else {
      parent.add(this.add.text(innerX + 48, y + h / 2, 'empty', {
        fontSize: '10px', color: CSS.faint, fontFamily: FONT.silk,
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
        // Empty slot — toggle a blue (swap-target) border on hover to signal
        // "click here to drop the selected bomb." No tooltip (no bomb yet).
        click.on('pointerover', () => {
          highlight.clear();
          highlight.lineStyle(2, COL.blue, 1);
          highlight.strokePoints(notchedPoints(innerX, y, innerW, h, 5), true);
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
        ref.border.lineStyle(2, COL.green, 1);
        ref.border.strokePoints(
          notchedPoints(ref.bounds.x, ref.bounds.y, ref.bounds.w, ref.bounds.h, 5), true,
        );
      }
    }
  }
}
