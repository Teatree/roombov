/**
 * Factory Scene.
 *
 * A room with 4 factory machines. Each machine consumes Treasure to produce
 * one random Bomb on its own cycle (data-driven from FACTORIES config).
 *
 * Layout:
 *  - factory_bg.png is rendered scaled-to-fit, centered. It is 846×460 and
 *    serves as the canonical coordinate space for machine positions.
 *  - For each machine: a hit zone + three overlay images (highlight,
 *    working, working-highlight) at the same full-bg coordinates — only
 *    the relevant one is visible at any time.
 *  - When a factory has a queue length > 0, a small floating status panel
 *    sits above its machine showing current-cycle progress + claim count.
 *  - Clicking a machine opens a popup with BUY / Storage / Take All.
 *
 * Server is authoritative — every action (start, claim) goes through a
 * socket round-trip. Client polls `factory_request` on scene-create and
 * predicts cycle progress locally (cosmetic only; the next emitted profile
 * is always trusted over the local clock).
 */

import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { ProfileStore } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import {
  TREASURE_TEXTURE_KEY,
  treasureIconFrame,
  preloadTreasureIcons,
} from '../systems/TreasureIcons.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { FACTORIES, type FactoryConfig } from '@shared/config/factories.ts';
import { FACTORY_IDS, type FactoryId, type FactoryState } from '@shared/types/factory.ts';
import type { BombType } from '@shared/types/bombs.ts';
import type { TreasureType } from '@shared/config/treasures.ts';

const BG_KEY = 'factory_bg';
const BOMB_SURPRISE_KEY = 'bomb_surprise';

/**
 * Centroid + bounding box of each machine, expressed in the 846×460
 * **design reference space** (a low-res preview of the bg used while
 * authoring). The actual `factory_bg.png` asset may be exported at a higher
 * resolution; at runtime we convert from this reference space to bg-native
 * pixels using `refScaleX / refScaleY` (= textureSize / BG_W,H).
 *
 * The per-machine overlay sprites (highlight / working / working_highlight)
 * are likewise authored in this same 846×460 reference space and get the
 * same ref-scale applied so they overlay the displayed bg 1:1.
 */
const MACHINE_CENTERS: Record<FactoryId, { x: number; y: number; w: number; h: number }> = {
  1: { x: 263, y: 246, w: 97, h: 106 },
  2: { x: 352, y: 250, w: 80, h: 88 },
  3: { x: 474, y: 249, w: 90, h: 98 },
  4: { x: 574, y: 258, w: 96, h: 89 },
};

const BG_W = 846;
const BG_H = 460;

interface MachineNodes {
  highlight: Phaser.GameObjects.Image;
  working: Phaser.GameObjects.Image;
  workingHighlight: Phaser.GameObjects.Image;
  hitZone: Phaser.GameObjects.Zone;
  /**
   * Status group layout (single row, contents at y=0 of group):
   *   [treasure cell ×N] [progress bar] [target bomb]
   *
   * `statusGroup` is positioned so the panel bottom sits `PANEL_GAP_PX`
   * above the machine. Inside it:
   *   - statusPanel: background rect at (0,0)
   *   - statusTreasures: container of icon+count cells, dynamically rebuilt
   *   - statusBarBg / statusBar: progress bar at the row center
   *   - statusTarget: target bomb image at the row's right end
   *   - statusBadge: claim-count dot overflowing the top-right corner
   */
  statusGroup: Phaser.GameObjects.Container;
  statusPanel: Phaser.GameObjects.Rectangle;
  statusBar: Phaser.GameObjects.Rectangle;
  statusBarBg: Phaser.GameObjects.Rectangle;
  statusBadge: Phaser.GameObjects.Container;
  statusBadgeText: Phaser.GameObjects.Text;
  statusTreasures: Phaser.GameObjects.Container;
  statusTarget: Phaser.GameObjects.Image;
  /**
   * Standalone "ready to claim" dot shown when the factory has no active
   * production but has finished bombs sitting in storage. Replaces the full
   * shortcut in that state — sits closer to the machine, no panel.
   */
  notifDot: Phaser.GameObjects.Container;
  notifDotText: Phaser.GameObjects.Text;
}

/**
 * Status panel geometry. All sizes in screen pixels — the panel does NOT
 * scale with the bg (HUD-like, always legible). PANEL_GAP_PX is the empty
 * space between panel bottom and the machine top.
 */
const PANEL_GAP_PX = 40;
const PANEL_PAD = 8;
const TREASURE_CELL = 22;
const TREASURE_GAP = 2;
const BAR_W = 60;
const BAR_H = 10;
const TARGET_SIZE = 24;
const SECTION_GAP = 8;
const PANEL_H = TREASURE_CELL + 2 * PANEL_PAD;  // 38

/**
 * Panel width is dynamic per-factory: one treasure cell per cost entry plus
 * a fixed bar + target slot. Each factory's panel is sized once at build
 * time from its FACTORIES[id].cost shape.
 */
function panelWidthFor(cfg: FactoryConfig): number {
  const n = Math.max(1, Object.keys(cfg.cost).length);
  return 2 * PANEL_PAD
    + n * TREASURE_CELL + (n - 1) * TREASURE_GAP
    + SECTION_GAP + BAR_W + SECTION_GAP + TARGET_SIZE;
}

/**
 * Stable references to every persistent element of the popup. The popup is
 * built once in `openPopup`; `renderPopup` only mutates properties (text,
 * fill, width, visibility) on these refs — it never destroys/recreates them.
 *
 * Why: Phaser's input plugin loses the cursor-over state for the frame in
 * which an interactive Game Object is destroyed, causing the cursor to
 * flicker between pointer and default when a 10 Hz tick wipes/rebuilds the
 * popup contents under the mouse.
 *
 * Two exceptions where we *do* rebuild on demand (not every tick):
 *   - queue dots (rebuilt when `pendingCount` changes)
 *   - storage slots (rebuilt when `storageSig` changes)
 * These changes are server-driven and rare, so the brief rebuild is OK.
 */
interface PopupNodes {
  container: Phaser.GameObjects.Container;
  overlay: Phaser.GameObjects.Rectangle;
  panelBg: Phaser.GameObjects.Rectangle;
  panelBorder: Phaser.GameObjects.Rectangle;
  panelTopAccent: Phaser.GameObjects.Rectangle;
  // Header
  closeBg: Phaser.GameObjects.Rectangle;
  closeText: Phaser.GameObjects.Text;
  // Commission section
  commissionBg: Phaser.GameObjects.Rectangle;
  commissionEdge: Phaser.GameObjects.Rectangle;
  commissionLabel: Phaser.GameObjects.Text;
  costChipItems: Array<{ icon: Phaser.GameObjects.Image; text: Phaser.GameObjects.Text; type: TreasureType; n: number }>;
  // Queue section
  queueStatusText: Phaser.GameObjects.Text;
  queueBox: Phaser.GameObjects.Container;
  progressBarFill: Phaser.GameObjects.Rectangle;
  progressTimeText: Phaser.GameObjects.Text;
  progressPosText: Phaser.GameObjects.Text;
  queueDotsContainer: Phaser.GameObjects.Container;
  queueDashG: Phaser.GameObjects.Graphics;
  lastPendingCount: number;
  // Storage section
  storageReadyText: Phaser.GameObjects.Text;
  takeAllBg: Phaser.GameObjects.Rectangle;
  takeAllText: Phaser.GameObjects.Text;
  storageGridBg: Phaser.GameObjects.Rectangle;
  storageSlotsContainer: Phaser.GameObjects.Container;
  storageDashG: Phaser.GameObjects.Graphics;
  lastStorageSig: string;
  // State refs (factoryId/cfg cached so update handlers don't need to look them up)
  factoryId: FactoryId;
  cfg: FactoryConfig;
}

/**
 * Section layout. Y values are offsets from the TOP edge of the panel
 * (panel uses origin (0.5, 0) so y=0 is its top). Everything above the
 * Queue section is at a FIXED y — only Queue and Storage grow downward
 * as content changes, so sections above never shift.
 */
const LAYOUT = {
  HEADER_H: 40,
  DESC_Y: 40,
  DESC_H: 30,
  SCHEM_Y: 86,         // DESC bottom (70) + 16 top pad
  BLUEPRINT_H: 110,
  COMMISSION_Y: 212,   // SCHEM_Y + BLUEPRINT_H + 4 schem bottom pad + 12 commission top pad
  COMMISSION_H: 84,
  QUEUE_Y: 312,        // COMMISSION_Y + COMMISSION_H + 16 section gap
  QUEUE_HEADER_H: 22,
  QUEUE_BOX_H: 60,
  QUEUE_BOTTOM_PAD: 12,
  STORAGE_HEADER_H: 40,    // TAKE ALL button is ~26 tall; leaves ~8 px gap before grid
  STORAGE_GRID_PAD: 8,
  STORAGE_BOTTOM_PAD: 14,
} as const;

/**
 * Color palette + dimensions for the popup. Frozen to keep them addressable
 * from helpers without re-declaring scopes. Names mirror the design spec.
 */
const POPUP = {
  W: 440,
  PAD_X: 14,
  // chrome
  BG: 0x1a2530,
  BORDER: 0x324658,
  ACCENT: 0x4ade80,
  HEADER_DIVIDER: 0x2a3a48,
  // text
  TEXT_BRIGHT: '#e2e8f0',
  TEXT_MID: '#cbd5e1',
  TEXT_DIM: '#94a3b8',
  TEXT_GREEN: '#4ade80',
  TEXT_BLUEPRINT_LABEL: '#5ab4ed',
  TEXT_BLUEPRINT_BOMB: '#cbe9ff',
  // section panels
  SECTION_BG: 0x0e1820,
  SECTION_BG_DARKER: 0x0a1218,
  DESC_BG: 0x16212c,
  // commission button (light yellow)
  CBTN_BG: 0xfef3c7,
  CBTN_BG_HOVER: 0xfff8da,
  CBTN_BG_DOWN: 0xfde68a,
  CBTN_BORDER: 0xeab308,
  CBTN_BORDER_DARK: 0xa16207,
  CBTN_TEXT: '#0f172a',
  CBTN_BG_DISABLED: 0x475569,
  CBTN_TEXT_DISABLED: '#94a3b8',
  // cost chip
  CHIP_BG: 0xf1f5f9,
  CHIP_BORDER: 0x94a3b8,
  CHIP_TEXT: '#0f172a',
  CHIP_TEXT_DEFICIT: '#ef4444',
  // blueprint
  BLUEPRINT_BG: 0x0a3252,
  BLUEPRINT_BORDER: 0x1e4d75,
  BLUEPRINT_GRID: 0x38bdf8,
  // storage
  SLOT_BG: 0x1a2530,
  SLOT_BG_EMPTY: 0x0a1218,
  SLOT_EMPTY_BORDER: 0x2a3a48,
} as const;

const BLUEPRINT_KEY = 'factory_blueprint_180x110';
const MINI_BLUEPRINT_KEY = 'factory_blueprint_36x36';

/** Commission button height. Shared by openPopup, renderPopup, and
 * computePanelHeight so the panel chrome grows with the button when this
 * value changes. */
const COMMISSION_H_PX = 84;

export class FactoryScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Image;
  private bgLeft = 0;
  private bgTop = 0;
  /** Screen-pixels per bg-native-pixel. */
  private bgScale = 1;
  /** bg-native-pixels per design-reference-pixel. */
  private refScaleX = 1;
  private refScaleY = 1;
  private machines = new Map<FactoryId, MachineNodes>();
  private hoverId: FactoryId | null = null;
  private popup: PopupNodes | null = null;
  private popupFactoryId: FactoryId | null = null;
  private wallet: TreasureListWidget | null = null;
  private toastText!: Phaser.GameObjects.Text;
  private titleText!: Phaser.GameObjects.Text;
  private backBtn!: Phaser.GameObjects.Text;
  private unsubProfile: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private tick: Phaser.Time.TimerEvent | null = null;
  private serverNowOffset = 0; // server-now - client-now, ms

  constructor() {
    super('FactoryScene');
  }

  preload(): void {
    if (!this.textures.exists(BG_KEY)) {
      this.load.image(BG_KEY, 'sprites/factory_bg.png');
    }
    for (const id of FACTORY_IDS) {
      this.load.image(`factory_${id}_highlight`, `sprites/factory_${id}_highlight.png`);
      this.load.image(`factory_${id}_working`, `sprites/factory_${id}_working.png`);
      this.load.image(`factory_${id}_working_highlight`, `sprites/factory_${id}_working_highlight.png`);
    }
    if (!this.textures.exists(BOMB_SURPRISE_KEY)) {
      this.load.image(BOMB_SURPRISE_KEY, 'sprites/bomb_suprise.png');
    }
    preloadTreasureIcons(this);
    preloadBombIcons(this);
  }

  create(): void {
    trackScreen(this, 'Factory');
    this.events.once('shutdown', this.shutdown, this);
    this.cameras.main.setBackgroundColor('#0c0c14');

    const { width, height } = this.scale;

    // Background uses **cover** semantics: scaled to fill the entire viewport
    // (preserving aspect, cropping overflow). Anchored at viewport center so
    // the crop is balanced on whichever axis overflows. Title and back button
    // sit on top.
    this.bg = this.add.image(width / 2, height / 2, BG_KEY).setOrigin(0.5, 0.5);
    this.applyLayout(width, height);

    // Title + back button sit on top of the (now-fullscreen) bg.
    this.titleText = this.add.text(width / 2, 24, 'FACTORY', {
      fontSize: '28px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(100);

    // Wallet — always visible (not popup-scoped). Standardised horizontal
    // layout shared with MainMenu and BombsShop; right-aligned via setX in
    // renderAll() after the bundle is known. Depth 1002 so it sits above
    // the production popup which uses ~1000.
    this.wallet = new TreasureListWidget(this, {
      x: width - 20,
      y: 20,
      anchor: 'top-left',
      direction: 'horizontal',
      iconScale: 0.5,
      fontSize: 11,
      rowGap: 4,
      depth: 1002,
    });

    this.backBtn = this.add.text(20, height - 30, '[ < BACK ]', {
      fontSize: '16px', color: '#888', fontFamily: 'monospace',
      stroke: '#000', strokeThickness: 3,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true }).setDepth(100);
    this.backBtn.on('pointerover', () => this.backBtn.setColor('#cccccc'));
    this.backBtn.on('pointerout', () => this.backBtn.setColor('#888888'));
    this.backBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.popup) {
        this.closePopup();
      } else {
        this.scene.start('MainMenuScene');
      }
    });

    this.toastText = this.add.text(width / 2, height - 60, '', {
      fontSize: '14px', color: '#44ff88', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(10000);

    this.activity = new ActivityIndicator(this);

    for (const id of FACTORY_IDS) this.buildMachine(id);

    // Re-fit the layout whenever the viewport changes (window resize, devtools
    // toggle, etc). Without this the bg + machines stay locked at the size we
    // captured on scene-create.
    this.scale.on('resize', this.onResize, this);

    const socket = NetworkManager.connect();
    socket.on('factory_result', (msg) => {
      if (!msg.ok) {
        this.toastText.setColor('#ff4444').setText(msg.reason ?? 'failed');
      } else {
        this.toastText.setColor('#44ff88').setText(msg.action === 'start' ? 'Production started' : 'Claimed');
      }
      this.time.delayedCall(1500, () => this.toastText.setText(''));
    });
    NetworkManager.track('factory_request', 'profile');
    socket.emit('factory_request', {} as never);

    this.unsubProfile = ProfileStore.subscribe(() => this.renderAll());
    this.renderAll();

    // 10 fps progress redraw — enough for a smooth bar update on
    // multi-minute cycles without burning frames.
    this.tick = this.time.addEvent({ delay: 100, loop: true, callback: () => this.renderAll() });
  }

  shutdown(): void {
    this.unsubProfile?.();
    this.unsubProfile = null;
    this.tick?.remove();
    this.tick = null;
    this.activity?.destroy();
    this.activity = null;
    this.wallet?.destroy();
    this.wallet = null;
    this.machines.clear();
    this.scale.off('resize', this.onResize, this);
    NetworkManager.getSocket().off('factory_result');
  }

  // --- layout ---

  /**
   * Compute bg display + ref-scale for the current viewport. Re-runnable on
   * resize.
   *
   * **Cover semantics**: bg fills the entire viewport (no black bars).
   * Whichever axis is "short" gets exactly filled; the other axis overflows
   * the canvas and gets cropped. Anchored at viewport center so the crop is
   * balanced.
   *
   * Both overlay sprites AND hit zones derive their scale + position from
   * (bgScale, refScale*, bgLeft, bgTop) — so they always move and resize
   * with the bg, no matter how it gets cropped.
   */
  private applyLayout(width: number, height: number): void {
    const texW = this.bg.width;
    const texH = this.bg.height;
    this.bgScale = Math.max(width / texW, height / texH);
    this.bg.setPosition(width / 2, height / 2);
    this.bg.setScale(this.bgScale);
    // bgLeft/bgTop = upper-left of the bg in screen coords (may be negative
    // when the bg overflows the canvas on that axis).
    this.bgLeft = width / 2 - (texW * this.bgScale) / 2;
    this.bgTop = height / 2 - (texH * this.bgScale) / 2;
    this.refScaleX = texW / BG_W;
    this.refScaleY = texH / BG_H;
  }

  private onResize(gameSize: Phaser.Structs.Size): void {
    const w = gameSize.width;
    const h = gameSize.height;
    this.applyLayout(w, h);
    this.titleText?.setPosition(w / 2, 24);
    this.backBtn?.setPosition(20, h - 30);
    this.toastText?.setPosition(w / 2, h - 60);
    for (const id of FACTORY_IDS) {
      const nodes = this.machines.get(id);
      if (nodes) this.layoutMachine(id, nodes);
    }
    this.renderAll();
  }

  // --- machines ---

  /**
   * Convert (x, y) in 846×460 design-reference space to screen coords. Bakes
   * in both the design→bg-native scale and the bg→screen scale.
   */
  private bgPoint(nx: number, ny: number): { x: number; y: number } {
    return {
      x: this.bgLeft + nx * this.refScaleX * this.bgScale,
      y: this.bgTop + ny * this.refScaleY * this.bgScale -3,
    };
  }

  /**
   * (Re-)position every node of a single machine for the current bg layout.
   * Called from buildMachine and from onResize.
   */
  private layoutMachine(id: FactoryId, nodes: MachineNodes): void {
    const center = MACHINE_CENTERS[id];
    const screen = this.bgPoint(center.x, center.y);
    // Overlay sprites are authored in the 846×460 design space too, so the
    // visible-pixel scale is bgScale × refScale (matches the bg's display).
    // refScaleX/Y may differ slightly (asset aspect ≠ design aspect); using
    // both keeps overlays in lock-step with whatever distortion the bg has.
    const scaleX = this.bgScale * this.refScaleX * 0.51;
    const scaleY = this.bgScale * this.refScaleY * 0.49;

    for (const img of [nodes.highlight, nodes.working, nodes.workingHighlight]) {
      img.setPosition(screen.x, screen.y);
      img.setOrigin(0.5, 0.5);
      img.setScale(scaleX, scaleY);
    }

    const hitW = center.w * scaleX;
    const hitH = center.h * scaleY;
    nodes.hitZone.setPosition(screen.x, screen.y);
    // Zone.setSize() also updates the input.hitArea width/height when no
    // custom hit area was supplied, so the click target stays in sync.
    nodes.hitZone.setSize(hitW, hitH);

    // Status group sits PANEL_GAP_PX above the machine's top edge; the panel
    // is centered around its own origin, so anchor at (machine_top - gap - half).
    nodes.statusGroup.setPosition(
      screen.x,
      screen.y - hitH / 2 - PANEL_GAP_PX - PANEL_H / 2,
    );

    // Standalone ready-dot sits just outside the machine's top-right corner —
    // intentionally closer than the full shortcut so it reads as a small,
    // unobtrusive nudge rather than a HUD element.
    nodes.notifDot.setPosition(
      screen.x + hitW / 2 + 4,
      screen.y - hitH / 2 - 4,
    );
  }

  private buildMachine(id: FactoryId): void {
    const highlight = this.add.image(0, 0, `factory_${id}_highlight`).setVisible(false);
    const working = this.add.image(0, 0, `factory_${id}_working`).setVisible(false);
    const workingHighlight = this.add.image(0, 0, `factory_${id}_working_highlight`).setVisible(false);

    const hit = this.add.zone(0, 0, 10, 10).setOrigin(0.5, 0.5);
    hit.setInteractive({ useHandCursor: true });
    hit.on('pointerover', () => { this.hoverId = id; this.renderAll(); });
    hit.on('pointerout', () => { if (this.hoverId === id) this.hoverId = null; this.renderAll(); });
    hit.on('pointerdown', () => this.openPopup(id));

    // Floating status group anchored above the machine. Contents are a single
    // horizontal row centered at y=0 of the group; panel is drawn with
    // origin (0.5, 0.5), so its center is at (0, 0). Width is per-factory.
    const cfg = FACTORIES[id];
    const panelW = panelWidthFor(cfg);
    const costCount = Math.max(1, Object.keys(cfg.cost).length);

    const statusGroup = this.add.container(0, 0);
    statusGroup.setVisible(false);

    const statusPanel = this.add.rectangle(0, 0, panelW, PANEL_H, 0x141420, 0.95)
      .setOrigin(0.5, 0.5).setStrokeStyle(1, 0x4a4a6a);
    statusGroup.add(statusPanel);

    // Treasures cell strip — populated by renderAll. Anchor at the row's left.
    const treasuresLeft = -panelW / 2 + PANEL_PAD;
    const treasures = this.add.container(treasuresLeft, 0);
    statusGroup.add(treasures);

    // Progress bar — placed right after the dynamic-width treasures section.
    const treasuresW = costCount * TREASURE_CELL + (costCount - 1) * TREASURE_GAP;
    const barLeft = treasuresLeft + treasuresW + SECTION_GAP;
    const statusBarBg = this.add.rectangle(barLeft, 0, BAR_W, BAR_H, 0x0a0a14, 1)
      .setOrigin(0, 0.5).setStrokeStyle(1, 0x4a4a6a);
    const statusBar = this.add.rectangle(barLeft + 1, 0, 0, BAR_H - 2, 0x44ff88, 1)
      .setOrigin(0, 0.5);
    statusGroup.add(statusBarBg);
    statusGroup.add(statusBar);

    // Target bomb at the row's right end.
    const targetX = barLeft + BAR_W + SECTION_GAP + TARGET_SIZE / 2;
    const statusTarget = this.add.image(targetX, 0, BOMB_SURPRISE_KEY)
      .setDisplaySize(TARGET_SIZE, TARGET_SIZE).setOrigin(0.5, 0.5);
    statusGroup.add(statusTarget);

    // Claim-count badge in upper-right of the panel (overflows above).
    // Only shown when a cycle is still running AND storage > 0.
    const badge = this.add.container(panelW / 2 - 6, -PANEL_H / 2);
    const badgeBg = this.add.circle(0, 0, 10, 0xff4444).setStrokeStyle(2, 0x000000);
    const badgeText = this.add.text(0, 0, '0', {
      fontSize: '11px', color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    badge.add(badgeBg);
    badge.add(badgeText);
    badge.setVisible(false);
    statusGroup.add(badge);

    // Standalone "ready" dot: shown when storage > 0 AND no active cycle
    // (factory finished, waiting on claim). Sits at the machine corner.
    const notifDot = this.add.container(0, 0).setDepth(50).setVisible(false);
    const notifBg = this.add.circle(0, 0, 11, 0xff4444).setStrokeStyle(2, 0x000000);
    const notifText = this.add.text(0, 0, '0', {
      fontSize: '11px', color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    notifDot.add([notifBg, notifText]);

    statusGroup.setDepth(50);
    highlight.setDepth(2);
    working.setDepth(2);
    workingHighlight.setDepth(3);

    const nodes: MachineNodes = {
      highlight, working, workingHighlight, hitZone: hit,
      statusGroup, statusPanel, statusBar, statusBarBg,
      statusBadge: badge, statusBadgeText: badgeText,
      statusTreasures: treasures, statusTarget,
      notifDot, notifDotText: notifText,
    };
    this.machines.set(id, nodes);
    this.layoutMachine(id, nodes);
  }

  // --- render ---

  private renderAll(): void {
    const profile = ProfileStore.get();
    if (!profile) return;

    // Wallet — kept in sync with the persistent stash. Horizontal layout
    // extends rightward; right-align by computing width and shifting X.
    if (this.wallet) {
      this.wallet.setBundle(profile.treasures);
      // Flush right — align by real rendered extent (see rightAlignTo).
      this.wallet.rightAlignTo(this.scale.width - 20);
    }

    // Defensive: older profiles loaded by a hot-reloaded server may not yet
    // have the factories field. Treat as all-empty until the next refresh.
    const factories = profile.factories ?? null;
    const nowMs = Date.now() + this.serverNowOffset;

    for (const id of FACTORY_IDS) {
      const nodes = this.machines.get(id)!;
      const state = factories?.[id] ?? { firstCycleStartedAt: null, queueLength: 0, storage: [] as BombType[] };
      const cfg = FACTORIES[id];
      const isWorking = state.queueLength > 0 && state.firstCycleStartedAt != null;
      const isHover = this.hoverId === id;

      nodes.working.setVisible(isWorking && !isHover);
      nodes.workingHighlight.setVisible(isWorking && isHover);
      nodes.highlight.setVisible(!isWorking && isHover);

      // Two display states:
      //   - producing → full shortcut (progress bar etc), with badge if any
      //     bombs are already sitting in storage.
      //   - done (queue empty) but storage > 0 → standalone ready-dot only.
      const claimable = state.storage.length;
      const showStandaloneDot = !isWorking && claimable > 0;
      nodes.statusGroup.setVisible(isWorking);
      nodes.notifDot.setVisible(showStandaloneDot);
      if (showStandaloneDot) {
        nodes.notifDotText.setText(claimable > 99 ? '99+' : String(claimable));
      }

      // Progress bar — fills inside the bar bg, minus 1px inset on each side.
      const progress = isWorking ? clamp01(currentCycleProgress(state, cfg, nowMs)) : 0;
      const barMax = BAR_W - 2;
      nodes.statusBar.width = barMax * progress;
      nodes.statusBar.setFillStyle(progress >= 0.999 ? 0xffd944 : 0x44ff88);

      // Treasures-committed: one square cell per cost type, dynamic count.
      // Each cell = dark tile + icon centered + small count text overlaid
      // at the cell's bottom-right.
      nodes.statusTreasures.removeAll(true);
      const remaining = state.queueLength;
      const costEntries = Object.entries(cfg.cost) as Array<[TreasureType, number]>;
      for (let i = 0; i < costEntries.length; i++) {
        const [type, perCycle] = costEntries[i];
        const committed = remaining * (perCycle ?? 0);
        const cellX = i * (TREASURE_CELL + TREASURE_GAP) + TREASURE_CELL / 2;
        const tile = this.add.rectangle(cellX, 0, TREASURE_CELL, TREASURE_CELL, 0x0a0a14, 1)
          .setStrokeStyle(1, 0x3a3a5a).setOrigin(0.5, 0.5);
        const icon = this.add.image(cellX, -1, TREASURE_TEXTURE_KEY, treasureIconFrame(type))
          .setDisplaySize(16, 16).setOrigin(0.5);
        const count = this.add.text(cellX + TREASURE_CELL / 2 - 1, TREASURE_CELL / 2 - 1,
          displayCount(committed), {
            fontSize: '9px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
            stroke: '#000', strokeThickness: 2,
          }).setOrigin(1, 1);
        nodes.statusTreasures.add(tile);
        nodes.statusTreasures.add(icon);
        nodes.statusTreasures.add(count);
      }

      // Target bomb dims when idle, full when working.
      nodes.statusTarget.setAlpha(isWorking ? 1 : 0.4);

      // In-panel claim badge: only meaningful while the shortcut is visible
      // (i.e. a cycle is still running) and storage already has bombs.
      nodes.statusBadge.setVisible(isWorking && claimable > 0);
      nodes.statusBadgeText.setText(claimable > 99 ? '99+' : String(claimable));
    }

    if (this.popup && this.popupFactoryId != null) this.renderPopup();
  }

  // --- popup ---

  /**
   * Open the production popup for `id`. All elements are created once here
   * with stable refs stored on `this.popup`. `renderPopup` mutates props
   * (text, fill, width, visibility) on those refs — no destroy/recreate
   * under the cursor, which would make hover flicker.
   *
   * The popup is TOP-anchored: panel origin (0.5, 0), all section Y values
   * are fixed offsets from the top (via LAYOUT constants). When the queue
   * box appears or storage grows, only the storage section + panel bottom
   * extend downward; sections above never move.
   */
  private openPopup(id: FactoryId): void {
    if (this.popup) this.closePopup();
    this.popupFactoryId = id;

    ensureBlueprintTextures(this);
    const cfg = FACTORIES[id];

    const { width, height } = this.scale;

    // Backdrop. Overlay is interactive — its pointerdown handler closes the
    // popup unless the click landed inside the panel bounds. (Phaser sorts
    // hit-tests by each GO's own depth, not the parent container's; panelBg
    // can't reliably "absorb" clicks above the overlay, so we test bounds
    // in the overlay handler instead.)
    const overlay = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.6)
      .setInteractive().setDepth(1000);
    overlay.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.popup) return;
      const m = this.popup.container.getWorldTransformMatrix();
      const local = m.applyInverse(pointer.x, pointer.y);
      // Popup is top-anchored: y ranges from 0 (top) to panelH (bottom).
      const inside = Math.abs(local.x) <= POPUP.W / 2 && local.y >= 0 && local.y <= this.popup.panelBg.height;
      if (!inside) this.closePopup();
    });

    const profile0 = ProfileStore.get();
    const state0 = ensureClientFactoryState(profile0?.factories?.[id]);
    const panelH = computePanelHeight(state0);
    const containerY = popupTopY(height, panelH);
    const container = this.add.container(width / 2, containerY).setDepth(1001);

    // --- Panel chrome (origin 0.5, 0 = top-center anchored) ---
    const panelBg = this.add.rectangle(0, 0, POPUP.W, panelH, POPUP.BG, 1).setOrigin(0.5, 0);
    const panelBorder = this.add.rectangle(0, 0, POPUP.W, panelH).setOrigin(0.5, 0)
      .setStrokeStyle(1, POPUP.BORDER).setFillStyle();
    const panelTopAccent = this.add.rectangle(0, 0, POPUP.W, 3, POPUP.ACCENT, 1).setOrigin(0.5, 0);
    container.add([panelBg, panelBorder, panelTopAccent]);

    // --- Header (chip + name + close button) ---
    const headerCenterY = LAYOUT.HEADER_H / 2;
    container.add(this.add.rectangle(0, LAYOUT.HEADER_H, POPUP.W, 1, POPUP.HEADER_DIVIDER, 1).setOrigin(0.5, 1));

    const chipX = -POPUP.W / 2 + POPUP.PAD_X;
    const chipLabel = this.add.text(7, 0, `FACTORY ${id}`, {
      fontSize: '11px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    const chipBg = this.add.rectangle(0, 0, chipLabel.width + 14, 20, POPUP.SECTION_BG, 1)
      .setStrokeStyle(1, POPUP.BORDER).setOrigin(0, 0.5);
    container.add(this.add.container(chipX, headerCenterY, [chipBg, chipLabel]));

    container.add(this.add.text(chipX + chipBg.width + 10, headerCenterY, cfg.name, {
      fontSize: '15px', color: POPUP.TEXT_BRIGHT, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5));

    // Close button. Bg is origin (0,0) at (-12, -12) inside the closeBtn
    // container so the X glyph sits at the visual center, AND auto hit-area
    // (0, 0, 24, 24) aligns 1:1 with the rendered rect (Phaser passes
    // hit-test local coords relative to rendered top-left, not origin).
    const closeX = POPUP.W / 2 - POPUP.PAD_X - 12;
    const closeBg = this.add.rectangle(-12, -12, 24, 24, 0x000000, 0.01).setOrigin(0, 0)
      .setStrokeStyle(1, POPUP.BORDER).setInteractive({ useHandCursor: true });
    const closeText = this.add.text(0, 0, 'X', {
      fontSize: '13px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(this.add.container(closeX, headerCenterY, [closeBg, closeText]));
    closeBg.on('pointerover', () => { closeBg.setStrokeStyle(1, POPUP.ACCENT); closeText.setColor('#ffffff'); });
    closeBg.on('pointerout', () => { closeBg.setStrokeStyle(1, POPUP.BORDER); closeText.setColor(POPUP.TEXT_DIM); });
    closeBg.on('pointerdown', () => this.closePopup());

    // --- Description (italic banner) ---
    container.add(this.add.rectangle(0, LAYOUT.DESC_Y, POPUP.W, LAYOUT.DESC_H, POPUP.DESC_BG, 1).setOrigin(0.5, 0));
    container.add(this.add.text(0, LAYOUT.DESC_Y + LAYOUT.DESC_H / 2, cfg.description, {
      fontSize: '12px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'italic',
    }).setOrigin(0.5));
    container.add(this.add.rectangle(0, LAYOUT.DESC_Y + LAYOUT.DESC_H, POPUP.W, 1, POPUP.HEADER_DIVIDER, 1).setOrigin(0.5, 1));

    // --- Schematic ---
    const blueprint = this.add.image(0, LAYOUT.SCHEM_Y, BLUEPRINT_KEY).setOrigin(0.5, 0);
    container.add(blueprint);
    container.add(this.add.image(0, LAYOUT.SCHEM_Y + LAYOUT.BLUEPRINT_H / 2, BOMB_SURPRISE_KEY)
      .setDisplaySize(56, 56).setOrigin(0.5));
    container.add(this.add.text(-blueprint.displayWidth / 2 + 6, LAYOUT.SCHEM_Y + 4,
      `SCHEMATIC · ${String(id).padStart(2, '0')}`, {
        fontSize: '9px', color: POPUP.TEXT_BLUEPRINT_LABEL, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0));

    // --- Commission row (button + cycle indicator) ---
    const CYCLE_W = 92;
    const COMMISSION_GAP = 10;
    const commissionBtnW = POPUP.W - POPUP.PAD_X * 2 - CYCLE_W - COMMISSION_GAP;
    const commissionLeftX = -POPUP.W / 2 + POPUP.PAD_X;
    const commissionBg = this.add.rectangle(commissionLeftX, LAYOUT.COMMISSION_Y, commissionBtnW, LAYOUT.COMMISSION_H, POPUP.CBTN_BG, 1)
      .setOrigin(0, 0).setStrokeStyle(1, POPUP.CBTN_BORDER).setInteractive({ useHandCursor: true });
    const commissionEdge = this.add.rectangle(commissionLeftX, LAYOUT.COMMISSION_Y + LAYOUT.COMMISSION_H - 3, commissionBtnW, 3, POPUP.CBTN_BORDER_DARK, 1).setOrigin(0, 0);
    const commissionLabel = this.add.text(commissionLeftX + commissionBtnW / 2, LAYOUT.COMMISSION_Y + 16, 'COMMISSION +1', {
      fontSize: '22px', color: POPUP.CBTN_TEXT, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0);
    container.add([commissionBg, commissionEdge, commissionLabel]);

    // Commission button input handlers — installed once, capture canAfford
    // by reading a closure-mutable flag updated each render. No remove/re-add
    // per tick (that was a source of pointer-state flicker).
    let canAffordRef = true;
    let pressed = false;
    commissionBg.on('pointerover', () => commissionBg.setFillStyle(canAffordRef ? POPUP.CBTN_BG_HOVER : POPUP.CBTN_BG_DISABLED, 1));
    commissionBg.on('pointerout', () => { pressed = false; commissionBg.setFillStyle(canAffordRef ? POPUP.CBTN_BG : POPUP.CBTN_BG_DISABLED, 1); });
    commissionBg.on('pointerdown', () => { if (canAffordRef) { pressed = true; commissionBg.setFillStyle(POPUP.CBTN_BG_DOWN, 1); } });
    commissionBg.on('pointerup', () => {
      commissionBg.setFillStyle(canAffordRef ? POPUP.CBTN_BG_HOVER : POPUP.CBTN_BG_DISABLED, 1);
      if (canAffordRef && pressed) {
        NetworkManager.track('factory_start', 'factory_result');
        NetworkManager.getSocket().emit('factory_start', { factoryId: id });
      }
      pressed = false;
    });
    // Stash on the bg so renderPopup can update it.
    (commissionBg as unknown as { __setCanAfford?: (v: boolean) => void }).__setCanAfford = (v: boolean) => { canAffordRef = v; };

    // Cost chip items: one icon+text pair per cost entry. Created up-front,
    // positioned once, text/color updated in renderPopup without recreation.
    const costEntries = Object.entries(cfg.cost) as Array<[TreasureType, number]>;
    const chipIconSize = 18;
    const chipGap = 10;
    const chipItemFont = { fontSize: '16px', color: POPUP.CHIP_TEXT, fontFamily: 'monospace', fontStyle: 'bold' as const };
    const costChipItems: PopupNodes['costChipItems'] = [];
    let totalW = 0;
    for (const [t, n] of costEntries) {
      const icon = this.add.image(0, 0, TREASURE_TEXTURE_KEY, treasureIconFrame(t)).setDisplaySize(chipIconSize, chipIconSize);
      const text = this.add.text(0, 0, `x${n}`, { ...chipItemFont }).setOrigin(0, 0.5);
      container.add([icon, text]);
      totalW += chipIconSize + 4 + text.width;
      costChipItems.push({ icon, text, type: t, n: n ?? 0 });
    }
    if (costChipItems.length > 1) totalW += chipGap * (costChipItems.length - 1);
    const chipCenterY = LAYOUT.COMMISSION_Y + LAYOUT.COMMISSION_H - 18;
    const chipCenterX = commissionLeftX + commissionBtnW / 2;
    let cursor = chipCenterX - totalW / 2;
    for (const it of costChipItems) {
      it.icon.setPosition(cursor + chipIconSize / 2, chipCenterY).setOrigin(0.5);
      cursor += chipIconSize + 4;
      it.text.setPosition(cursor, chipCenterY);
      cursor += it.text.width + chipGap;
    }

    // Cycle indicator.
    const cycleX = commissionLeftX + commissionBtnW + COMMISSION_GAP;
    container.add(this.add.rectangle(cycleX, LAYOUT.COMMISSION_Y, CYCLE_W, LAYOUT.COMMISSION_H, POPUP.SECTION_BG, 1)
      .setOrigin(0, 0).setStrokeStyle(1, POPUP.BORDER));
    container.add(this.add.text(cycleX + CYCLE_W / 2, LAYOUT.COMMISSION_Y + 8, 'CYCLE', {
      fontSize: '11px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0));
    container.add(this.add.text(cycleX + CYCLE_W / 2, LAYOUT.COMMISSION_Y + 22, fmtCycleTime(cfg.cycleDurationMs), {
      fontSize: '20px', color: POPUP.TEXT_GREEN, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0));
    container.add(this.add.text(cycleX + CYCLE_W / 2, LAYOUT.COMMISSION_Y + 46, 'per bomb', {
      fontSize: '10px', color: POPUP.TEXT_DIM, fontFamily: 'monospace',
    }).setOrigin(0.5, 0));

    // --- Queue section ---
    const queueLeftX = -POPUP.W / 2 + POPUP.PAD_X;
    const queueRightX = POPUP.W / 2 - POPUP.PAD_X;
    const queueW = queueRightX - queueLeftX;

    // Header row (always visible).
    container.add(this.add.text(queueLeftX, LAYOUT.QUEUE_Y, '▸ PRODUCTION QUEUE', {
      fontSize: '11px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0));
    const queueStatusText = this.add.text(queueRightX, LAYOUT.QUEUE_Y, '0 / 0 done', {
      fontSize: '11px', color: POPUP.TEXT_GREEN, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0);
    container.add(queueStatusText);

    // Queue box (toggled visible). All children created up-front.
    const queueBox = this.add.container(0, LAYOUT.QUEUE_Y + LAYOUT.QUEUE_HEADER_H);
    queueBox.setVisible(false);
    container.add(queueBox);
    const boxBg = this.add.rectangle(queueLeftX, 0, queueW, LAYOUT.QUEUE_BOX_H, POPUP.SECTION_BG, 1)
      .setOrigin(0, 0).setStrokeStyle(1, POPUP.BORDER);
    const miniSize = 36;
    const miniX = queueLeftX + 10;
    const miniY = (LAYOUT.QUEUE_BOX_H - miniSize) / 2;
    const miniBg = this.add.image(miniX, miniY, MINI_BLUEPRINT_KEY).setOrigin(0, 0);
    const miniBomb = this.add.image(miniX + miniSize / 2, miniY + miniSize / 2, BOMB_SURPRISE_KEY)
      .setDisplaySize(22, 22).setOrigin(0.5);
    // Progress bar — width recalculated each render based on pending count.
    // Created at full possible width; both bg and fill get resized in renderPopup.
    const progLeft = miniX + miniSize + 10;
    const barH = 8;
    const barY = LAYOUT.QUEUE_BOX_H / 2 - 10;
    const progressBarBg = this.add.rectangle(progLeft, barY, 40, barH, POPUP.SECTION_BG_DARKER, 1)
      .setOrigin(0, 0).setStrokeStyle(1, 0x1e2c38);
    const progressBarFill = this.add.rectangle(progLeft + 1, barY + 1, 0, barH - 2, POPUP.ACCENT, 1).setOrigin(0, 0);
    const subY = barY + barH + 5;
    const progressTimeText = this.add.text(progLeft, subY, '--', {
      fontSize: '11px', color: POPUP.TEXT_MID, fontFamily: 'monospace',
    }).setOrigin(0, 0);
    const progressPosText = this.add.text(progLeft + 40, subY, '--', {
      fontSize: '11px', color: POPUP.TEXT_DIM, fontFamily: 'monospace',
    }).setOrigin(1, 0);
    const queueDotsContainer = this.add.container(0, 0);
    const queueDashG = this.add.graphics();
    queueBox.add([boxBg, miniBg, miniBomb, progressBarBg, progressBarFill, progressTimeText, progressPosText, queueDotsContainer, queueDashG]);
    // Save bg + bar refs for resize-in-place; we don't need to track bg/bar separately since
    // only fill width changes per tick.

    // --- Storage section ---
    // Section header (label + ready count + TAKE ALL).
    const storageY0 = LAYOUT.QUEUE_Y + LAYOUT.QUEUE_HEADER_H + LAYOUT.QUEUE_BOTTOM_PAD; // idle baseline
    const storageHeaderContainer = this.add.container(0, 0);
    container.add(storageHeaderContainer);
    const storageLabel = this.add.text(queueLeftX, 0, '▸ STORAGE', {
      fontSize: '11px', color: POPUP.TEXT_DIM, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    const storageReadyText = this.add.text(queueLeftX + 75, 0, ' · 0 ready', {
      fontSize: '11px', color: POPUP.TEXT_GREEN, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0);
    storageHeaderContainer.add([storageLabel, storageReadyText]);

    const takeAllText = this.add.text(0, 0, 'TAKE ALL', {
      fontSize: '11px', color: POPUP.TEXT_MID, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    const takeBgW = takeAllText.width + 20;
    const takeBgH = takeAllText.height + 10;
    const takeAllBg = this.add.rectangle(0, 0, takeBgW, takeBgH, 0x000000, 0.01)
      .setOrigin(0, 0).setStrokeStyle(1, POPUP.CBTN_BORDER_DARK).setInteractive({ useHandCursor: true });
    takeAllText.setPosition(takeBgW / 2, takeBgH / 2);
    storageHeaderContainer.add(this.add.container(queueRightX - takeBgW, 6, [takeAllBg, takeAllText]));
    takeAllBg.on('pointerover', () => {
      const enabled = takeAllText.style.color === POPUP.TEXT_MID || takeAllText.style.color === '#ffffff';
      if (enabled) { takeAllBg.setStrokeStyle(1, POPUP.ACCENT); takeAllText.setColor('#ffffff'); }
    });
    takeAllBg.on('pointerout', () => {
      const enabled = takeAllText.style.color === POPUP.TEXT_MID || takeAllText.style.color === '#ffffff';
      if (enabled) { takeAllBg.setStrokeStyle(1, POPUP.CBTN_BORDER_DARK); takeAllText.setColor(POPUP.TEXT_MID); }
    });
    takeAllBg.on('pointerdown', () => {
      // Only fire if storage non-empty (text color is the proxy for "enabled").
      if (takeAllText.style.color !== '#475569') {
        NetworkManager.track('factory_claim', 'factory_result');
        NetworkManager.getSocket().emit('factory_claim', { factoryId: id });
      }
    });

    // Storage grid bg + slots container. The grid bg + slots are repositioned/
    // rebuilt only when the storage signature changes — see renderStorage().
    const storageGridBg = this.add.rectangle(queueLeftX, 0, POPUP.W - POPUP.PAD_X * 2, 0, POPUP.SECTION_BG, 1)
      .setOrigin(0, 0).setStrokeStyle(1, POPUP.BORDER);
    const storageSlotsContainer = this.add.container(0, 0);
    const storageDashG = this.add.graphics();
    container.add([storageGridBg, storageSlotsContainer, storageDashG]);

    storageHeaderContainer.setPosition(0, storageY0);
    storageGridBg.setPosition(queueLeftX, storageY0 + LAYOUT.STORAGE_HEADER_H);

    this.popup = {
      container, overlay, panelBg, panelBorder, panelTopAccent,
      closeBg, closeText,
      commissionBg, commissionEdge, commissionLabel, costChipItems,
      queueStatusText, queueBox,
      progressBarFill, progressTimeText, progressPosText,
      queueDotsContainer, queueDashG, lastPendingCount: -1,
      storageReadyText, takeAllBg, takeAllText,
      storageGridBg, storageSlotsContainer, storageDashG, lastStorageSig: '',
      factoryId: id, cfg,
    };
    // Store the storage header container so renderPopup can reposition it.
    (this.popup as unknown as { _storageHeader: Phaser.GameObjects.Container })._storageHeader = storageHeaderContainer;
    // Store progress bar bg so we can resize it when pending count changes
    // (different number of queue dots → bar width changes).
    (this.popup as unknown as { _progressBarBg: Phaser.GameObjects.Rectangle })._progressBarBg = progressBarBg;

    // Wallet is owned by the scene (created in create(), updated in
    // renderAll()); the popup intentionally doesn't touch it so it stays
    // visible whether or not the popup is open.

    this.renderPopup();
  }

  /**
   * Mutate the popup's stable refs based on the latest factory state.
   * Never destroys/recreates interactive elements (which would flicker the
   * cursor). Rebuilds queue dots / storage slots only when their signatures
   * change (rare, state-driven, not per-tick).
   */
  private renderPopup(): void {
    if (!this.popup || this.popupFactoryId == null) return;
    const popup = this.popup;
    const profile = ProfileStore.get();
    if (!profile) return;
    const state = ensureClientFactoryState(profile.factories?.[popup.factoryId]);
    const cfg = popup.cfg;

    // Wallet refresh is handled by renderAll() — removed from here.

    // --- Cost chip: update text colors based on what the player can afford ---
    const wallet = profile.treasures;
    let canAfford = true;
    for (const item of popup.costChipItems) {
      const hasEnough = (wallet[item.type] ?? 0) >= item.n;
      item.text.setColor(hasEnough ? POPUP.CHIP_TEXT : POPUP.CHIP_TEXT_DEFICIT);
      if (!hasEnough) canAfford = false;
    }

    // --- Commission button enabled visual ---
    popup.commissionBg.setFillStyle(canAfford ? POPUP.CBTN_BG : POPUP.CBTN_BG_DISABLED, 1);
    popup.commissionLabel.setColor(canAfford ? POPUP.CBTN_TEXT : POPUP.CBTN_TEXT_DISABLED);
    (popup.commissionBg as unknown as { __setCanAfford?: (v: boolean) => void }).__setCanAfford?.(canAfford);

    // --- Queue section ---
    popup.queueStatusText.setText(`${state.sessionDone} / ${state.sessionTotal} done`);
    const remaining = state.queueLength;
    const isWorking = remaining > 0 && state.firstCycleStartedAt != null;
    popup.queueBox.setVisible(isWorking);

    if (isWorking) {
      const pending = remaining - 1;
      const queueLeftX = -POPUP.W / 2 + POPUP.PAD_X;
      const queueRightX = POPUP.W / 2 - POPUP.PAD_X;
      const dotSize = 22;
      const dotGap = 4;
      const dotsW = pending > 0 ? pending * dotSize + (pending - 1) * dotGap : 0;
      const dotsRight = queueRightX - 10;
      const dotsLeft = dotsRight - dotsW;

      // Resize progress bar to fit the remaining space.
      const miniX = queueLeftX + 10;
      const miniSize = 36;
      const progLeft = miniX + miniSize + 10;
      const progRight = pending > 0 ? dotsLeft - 10 : dotsRight;
      const progW = Math.max(40, progRight - progLeft);
      const progBarBg = (popup as unknown as { _progressBarBg: Phaser.GameObjects.Rectangle })._progressBarBg;
      if (progBarBg.width !== progW) progBarBg.setSize(progW, progBarBg.height);
      popup.progressPosText.setPosition(progLeft + progW, popup.progressPosText.y);

      const progress = clamp01(currentCycleProgress(state, cfg, Date.now() + this.serverNowOffset));
      const fillW = Math.max(0, (progW - 2) * progress);
      popup.progressBarFill.setSize(fillW, popup.progressBarFill.height);

      const remainMs = Math.max(0, cfg.cycleDurationMs - cfg.cycleDurationMs * progress);
      popup.progressTimeText.setText(fmtRemain(remainMs));
      popup.progressPosText.setText(`bomb ${state.sessionDone + 1} of ${state.sessionTotal}`);

      // Queue dots: only rebuild when pending count changes.
      if (pending !== popup.lastPendingCount) {
        popup.queueDotsContainer.removeAll(true);
        popup.queueDashG.clear();
        const dotsY = (LAYOUT.QUEUE_BOX_H - dotSize) / 2;
        for (let i = 0; i < pending; i++) {
          const dx = dotsLeft + i * (dotSize + dotGap);
          drawDashedRect(popup.queueDashG, dx, dotsY, dotSize, dotSize, 3, 2, POPUP.ACCENT, 0.33);
          popup.queueDotsContainer.add(this.add.text(dx + dotSize / 2, dotsY + dotSize / 2, '?', {
            fontSize: '12px', color: POPUP.TEXT_GREEN, fontFamily: 'monospace', fontStyle: 'bold',
          }).setOrigin(0.5));
        }
        popup.lastPendingCount = pending;
      }
    } else if (popup.lastPendingCount !== 0) {
      popup.queueDotsContainer.removeAll(true);
      popup.queueDashG.clear();
      popup.lastPendingCount = 0;
    }

    // --- Storage section position (depends on isWorking) ---
    const storageHeaderY = LAYOUT.QUEUE_Y + LAYOUT.QUEUE_HEADER_H + (isWorking ? LAYOUT.QUEUE_BOX_H : 0) + LAYOUT.QUEUE_BOTTOM_PAD;
    const storageGridY = storageHeaderY + LAYOUT.STORAGE_HEADER_H;
    (popup as unknown as { _storageHeader: Phaser.GameObjects.Container })._storageHeader.setPosition(0, storageHeaderY);

    // --- Storage section content ---
    const counts = aggregateStorage(state.storage);
    const totalCount = state.storage.length;
    popup.storageReadyText.setText(` · ${totalCount} ready`);

    const canTake = totalCount > 0;
    popup.takeAllText.setColor(canTake ? POPUP.TEXT_MID : '#475569');
    popup.takeAllBg.setStrokeStyle(1, canTake ? POPUP.CBTN_BORDER_DARK : POPUP.HEADER_DIVIDER);

    // Storage grid layout.
    const sig = counts.map(c => `${c.bombType}:${c.count}`).join(',');
    const cols = 6;
    const gap = 6;
    const gridPad = LAYOUT.STORAGE_GRID_PAD;
    const slotsToShow = Math.max(cols, Math.ceil(counts.length / cols) * cols);
    const innerW = POPUP.W - POPUP.PAD_X * 2 - gridPad * 2;
    const slotSize = Math.floor((innerW - (cols - 1) * gap) / cols);
    const rows = Math.ceil(slotsToShow / cols);
    const gridH = gridPad * 2 + rows * slotSize + (rows - 1) * gap;

    // Move grid bg, slots container, and dash graphics together. Slots use
    // LOCAL coords inside `storageSlotsContainer` (and `storageDashG`),
    // anchored at the same origin — so a single setPosition pair moves the
    // whole grid + its contents in lockstep when the queue grows/shrinks.
    const gridLeftX = -POPUP.W / 2 + POPUP.PAD_X;
    const slotsOriginX = gridLeftX + gridPad;
    const slotsOriginY = storageGridY + gridPad;
    popup.storageGridBg.setPosition(gridLeftX, storageGridY);
    popup.storageGridBg.setSize(POPUP.W - POPUP.PAD_X * 2, gridH);
    popup.storageSlotsContainer.setPosition(slotsOriginX, slotsOriginY);
    popup.storageDashG.setPosition(slotsOriginX, slotsOriginY);

    // Rebuild slot children only when the storage signature changes.
    if (sig !== popup.lastStorageSig) {
      popup.storageSlotsContainer.removeAll(true);
      popup.storageDashG.clear();
      const factoryId = popup.factoryId;
      for (let i = 0; i < slotsToShow; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const sx = col * (slotSize + gap);   // local to slotsContainer / dashG
        const sy = row * (slotSize + gap);
        const entry = counts[i];
        if (entry) {
          const slotBg = this.add.rectangle(sx, sy, slotSize, slotSize, POPUP.SLOT_BG, 1)
            .setOrigin(0, 0).setStrokeStyle(1, POPUP.BORDER).setInteractive({ useHandCursor: true });
          const bombIcon = this.add.image(sx + slotSize / 2, sy + slotSize / 2, 'bomb_icons', bombIconFrame(entry.bombType))
            .setDisplaySize(Math.min(28, slotSize - 10), Math.min(28, slotSize - 10)).setOrigin(0.5);
          const countText = this.add.text(sx + slotSize - 3, sy + slotSize - 2, `x${entry.count}`, {
            fontSize: '11px', color: POPUP.TEXT_GREEN, fontFamily: 'monospace', fontStyle: 'bold',
          }).setOrigin(1, 1);
          popup.storageSlotsContainer.add([slotBg, bombIcon, countText]);
          slotBg.on('pointerover', () => slotBg.setStrokeStyle(1, POPUP.ACCENT));
          slotBg.on('pointerout', () => slotBg.setStrokeStyle(1, POPUP.BORDER));
          slotBg.on('pointerdown', () => {
            const liveState = ensureClientFactoryState(ProfileStore.get()?.factories?.[factoryId]);
            const idx = liveState.storage.findIndex(b => b === entry.bombType);
            if (idx >= 0) {
              NetworkManager.track('factory_claim', 'factory_result');
              NetworkManager.getSocket().emit('factory_claim', { factoryId, index: idx });
            }
          });
        } else {
          popup.storageSlotsContainer.add(this.add.rectangle(sx, sy, slotSize, slotSize, POPUP.SLOT_BG_EMPTY, 1).setOrigin(0, 0));
          drawDashedRect(popup.storageDashG, sx, sy, slotSize, slotSize, 3, 2, POPUP.SLOT_EMPTY_BORDER, 1);
        }
      }
      popup.lastStorageSig = sig;
    }

    // --- Panel chrome: only the height grows downward. Container top is
    // anchored ONCE at openPopup and never moves on resize, so sections
    // above queue (header, description, schematic, commission) stay put.
    const panelH = storageGridY + gridH + LAYOUT.STORAGE_BOTTOM_PAD;
    if (popup.panelBg.height !== panelH) {
      popup.panelBg.setSize(POPUP.W, panelH);
      popup.panelBorder.setSize(POPUP.W, panelH);
    }
  }

  private closePopup(): void {
    if (!this.popup) return;
    this.popup.container.destroy();
    this.popup.overlay.destroy();
    this.popup = null;
    this.popupFactoryId = null;
  }
}

// --- helpers ---

function currentCycleProgress(state: FactoryState, cfg: FactoryConfig, nowMs: number): number {
  if (state.firstCycleStartedAt == null || state.queueLength <= 0) return 0;
  const elapsed = nowMs - state.firstCycleStartedAt;
  const within = elapsed % cfg.cycleDurationMs;
  return within / cfg.cycleDurationMs;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function displayCount(n: number): string {
  if (n <= 0) return '0';
  return n > 999 ? '999+' : String(n);
}

function displayShort(type: TreasureType): string {
  // Single-letter mnemonic for the tight BUY button label.
  switch (type) {
    case 'mushrooms': return '🍄';
    case 'coffee': return '☕';
    case 'grapes': return '🍇';
    case 'lanterns': return '🏮';
    default: return type[0].toUpperCase();
  }
}

function fmtMs(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

/** Cycle indicator format: "5:00" / "10:00" — minutes and zero-padded seconds. */
function fmtCycleTime(ms: number): string {
  const totalS = Math.round(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Live remaining-time label: "3m 26s" or "47s". Clock-icon-free, the spec
 * draws the icon in HTML; we keep it text-only since we don't have an icon
 * font in Phaser. */
function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

/** Aggregate storage list into {bombType, count} entries, ordered by first
 * appearance in storage so newer types push to the right. */
function aggregateStorage(storage: BombType[]): { bombType: BombType; count: number }[] {
  const order: BombType[] = [];
  const counts = new Map<BombType, number>();
  for (const b of storage) {
    if (!counts.has(b)) order.push(b);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return order.map(b => ({ bombType: b, count: counts.get(b)! }));
}

/** Defensive default for old profiles that pre-date the sessionDone fields. */
function emptyClientFactoryState(): FactoryState {
  return { firstCycleStartedAt: null, queueLength: 0, storage: [], sessionDone: 0, sessionTotal: 0 };
}

/** Backfill missing fields on a factory state from older server shapes. The
 * server migrates on read, but a dev server running against pre-migration
 * profile JSON (or transmitted profiles that pre-date the new fields) won't
 * have them — so we defensively coalesce client-side too. */
function ensureClientFactoryState(s: Partial<FactoryState> | undefined): FactoryState {
  if (!s) return emptyClientFactoryState();
  const queueLength = typeof s.queueLength === 'number' ? s.queueLength : 0;
  const sessionDone = typeof s.sessionDone === 'number' ? s.sessionDone : 0;
  const rawSessionTotal = typeof s.sessionTotal === 'number' ? s.sessionTotal : 0;
  // Mirror the server's migration fallback so a queued-but-untracked legacy
  // profile reads as `bomb 1 of {queueLength}` rather than `bomb 1 of 0`.
  const sessionTotal = rawSessionTotal > 0
    ? Math.max(rawSessionTotal, sessionDone)
    : Math.max(sessionDone, queueLength);
  return {
    firstCycleStartedAt: typeof s.firstCycleStartedAt === 'number' ? s.firstCycleStartedAt : null,
    queueLength,
    storage: Array.isArray(s.storage) ? s.storage : [],
    sessionDone,
    sessionTotal,
  };
}

/** Total height of the popup panel in pixels. All sections above queue have
 * fixed Y positions (LAYOUT constants); only queue + storage grow downward,
 * so the panel height = (storage grid bottom) + bottom pad. */
function computePanelHeight(state: FactoryState): number {
  const isWorking = state.queueLength > 0 && state.firstCycleStartedAt != null;
  const storageHeaderY = LAYOUT.QUEUE_Y + LAYOUT.QUEUE_HEADER_H + (isWorking ? LAYOUT.QUEUE_BOX_H : 0) + LAYOUT.QUEUE_BOTTOM_PAD;
  const storageGridY = storageHeaderY + LAYOUT.STORAGE_HEADER_H;

  const cols = 6;
  const gap = 6;
  const gridPad = LAYOUT.STORAGE_GRID_PAD;
  const innerW = POPUP.W - POPUP.PAD_X * 2 - gridPad * 2;
  const slotSize = Math.floor((innerW - (cols - 1) * gap) / cols);
  const counts = aggregateStorage(state.storage);
  const slotsToShow = Math.max(cols, Math.ceil(counts.length / cols) * cols);
  const rows = Math.ceil(slotsToShow / cols);
  const gridH = gridPad * 2 + rows * slotSize + (rows - 1) * gap;

  return storageGridY + gridH + LAYOUT.STORAGE_BOTTOM_PAD;
}

/** Top Y for the popup container. Vertically centers when the panel fits,
 * but never above 40 px from the screen top — so a tall panel anchors near
 * the top instead of overflowing the viewport. */
function popupTopY(viewportH: number, panelH: number): number {
  return Math.max(40, viewportH / 2 - panelH / 2);
}

/** Build the blueprint textures once per scene (cached on the texture
 * manager). Solid cyan-tinted bg + faint grid lines + 1px border. */
function ensureBlueprintTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists(BLUEPRINT_KEY)) {
    paintBlueprint(scene, BLUEPRINT_KEY, 180, 110, 14);
  }
  if (!scene.textures.exists(MINI_BLUEPRINT_KEY)) {
    paintBlueprint(scene, MINI_BLUEPRINT_KEY, 36, 36, 8);
  }
}

function paintBlueprint(scene: Phaser.Scene, key: string, w: number, h: number, gridSize: number): void {
  const g = scene.add.graphics();
  g.fillStyle(POPUP.BLUEPRINT_BG, 1).fillRect(0, 0, w, h);
  g.lineStyle(1, POPUP.BLUEPRINT_GRID, 0.18);
  for (let x = gridSize; x < w; x += gridSize) g.lineBetween(x, 0, x, h);
  for (let y = gridSize; y < h; y += gridSize) g.lineBetween(0, y, w, y);
  g.lineStyle(1, POPUP.BLUEPRINT_BORDER, 1).strokeRect(0, 0, w, h);
  g.generateTexture(key, w, h);
  g.destroy();
}

/** Draw a dashed-border rectangle into a Graphics object. Used for the empty
 * storage slots and the pending-queue placeholder dots. Drawn into a shared
 * Graphics so we only allocate one per render call. */
function drawDashedRect(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, w: number, h: number,
  dash: number, gap: number,
  color: number, alpha: number,
): void {
  g.lineStyle(1, color, alpha);
  const step = dash + gap;
  // Horizontal edges.
  for (let i = 0; i < w; i += step) {
    const len = Math.min(dash, w - i);
    g.lineBetween(x + i, y, x + i + len, y);
    g.lineBetween(x + i, y + h, x + i + len, y + h);
  }
  // Vertical edges.
  for (let i = 0; i < h; i += step) {
    const len = Math.min(dash, h - i);
    g.lineBetween(x, y + i, x, y + i + len);
    g.lineBetween(x + w, y + i, x + w, y + i + len);
  }
}

