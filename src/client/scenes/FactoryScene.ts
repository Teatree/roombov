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

/** Max width = 3 treasures + bar + target + padding. Fixed for visual consistency. */
const MAX_TREASURES = 3;
const PANEL_W = 2 * PANEL_PAD
  + MAX_TREASURES * TREASURE_CELL + (MAX_TREASURES - 1) * TREASURE_GAP
  + SECTION_GAP + BAR_W + SECTION_GAP + TARGET_SIZE;  // 184

interface PopupNodes {
  container: Phaser.GameObjects.Container;
  overlay: Phaser.GameObjects.Rectangle;
}

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
    // origin (0.5, 0.5), so its center is at (0, 0).
    const statusGroup = this.add.container(0, 0);
    statusGroup.setVisible(false);

    const statusPanel = this.add.rectangle(0, 0, PANEL_W, PANEL_H, 0x141420, 0.95)
      .setOrigin(0.5, 0.5).setStrokeStyle(1, 0x4a4a6a);
    statusGroup.add(statusPanel);

    // Treasures cell strip — populated by renderAll. Anchor at the row's left.
    const treasuresLeft = -PANEL_W / 2 + PANEL_PAD;
    const treasures = this.add.container(treasuresLeft, 0);
    statusGroup.add(treasures);

    // Progress bar — after the (fixed-width) treasures section, at row center.
    const treasuresW = MAX_TREASURES * TREASURE_CELL + (MAX_TREASURES - 1) * TREASURE_GAP;
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
    const badge = this.add.container(PANEL_W / 2 - 6, -PANEL_H / 2);
    const badgeBg = this.add.circle(0, 0, 10, 0xff4444).setStrokeStyle(2, 0x000000);
    const badgeText = this.add.text(0, 0, '0', {
      fontSize: '11px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    badge.add(badgeBg);
    badge.add(badgeText);
    badge.setVisible(false);
    statusGroup.add(badge);

    statusGroup.setDepth(50);
    highlight.setDepth(2);
    working.setDepth(2);
    workingHighlight.setDepth(3);

    const nodes: MachineNodes = {
      highlight, working, workingHighlight, hitZone: hit,
      statusGroup, statusPanel, statusBar, statusBarBg,
      statusBadge: badge, statusBadgeText: badgeText,
      statusTreasures: treasures, statusTarget,
    };
    this.machines.set(id, nodes);
    this.layoutMachine(id, nodes);
  }

  // --- render ---

  private renderAll(): void {
    const profile = ProfileStore.get();
    if (!profile) return;
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

      // Status panel only visible when machine is producing.
      nodes.statusGroup.setVisible(isWorking || state.storage.length > 0);

      // Progress bar — fills inside the bar bg, minus 1px inset on each side.
      const progress = isWorking ? clamp01(currentCycleProgress(state, cfg, nowMs)) : 0;
      const barMax = BAR_W - 2;
      nodes.statusBar.width = barMax * progress;
      nodes.statusBar.setFillStyle(progress >= 0.999 ? 0xffd944 : 0x44ff88);

      // Treasures-committed: single row of square cells (one per cost type,
      // up to MAX_TREASURES). Each cell = dark tile + icon centered + small
      // count text overlaid at the cell's bottom-right.
      nodes.statusTreasures.removeAll(true);
      const remaining = state.queueLength;
      const costEntries = (Object.entries(cfg.cost) as Array<[TreasureType, number]>)
        .slice(0, MAX_TREASURES);
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

      // Claim badge
      const claimable = state.storage.length;
      nodes.statusBadge.setVisible(claimable > 0);
      nodes.statusBadgeText.setText(claimable > 99 ? '99+' : String(claimable));
    }

    if (this.popup && this.popupFactoryId != null) this.renderPopup();
  }

  // --- popup ---

  private openPopup(id: FactoryId): void {
    if (this.popup) this.closePopup();
    this.popupFactoryId = id;

    const { width, height } = this.scale;
    const overlay = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55)
      .setInteractive().setDepth(1000);
    overlay.on('pointerdown', () => this.closePopup());

    const container = this.add.container(width / 2, height / 2).setDepth(1001);

    const panelW = 480;
    const cfg = FACTORIES[id];
    const costEntries = Object.entries(cfg.cost) as Array<[TreasureType, number]>;
    const baseH = 480;
    const panelH = baseH + Math.max(0, (costEntries.length - 1) * 4);

    const panelBg = this.add.rectangle(0, 0, panelW, panelH, 0x222238, 0.98)
      .setStrokeStyle(2, 0x4a4a6a);
    container.add(panelBg);

    // Header
    const header = this.add.text(0, -panelH / 2 + 28, cfg.name, {
      fontSize: '22px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(header);

    // Close X — text button with hover + press feedback.
    const closeBtn = this.add.text(panelW / 2 - 18, -panelH / 2 + 18, 'X', {
      fontSize: '20px', color: '#ff8844', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffcc99').setScale(1.15));
    closeBtn.on('pointerout', () => closeBtn.setColor('#ff8844').setScale(1));
    closeBtn.on('pointerdown', () => closeBtn.setColor('#cc6622').setScale(0.92));
    closeBtn.on('pointerup', () => { closeBtn.setColor('#ffcc99').setScale(1.15); this.closePopup(); });
    container.add(closeBtn);

    // Wallet preview at top-right (re-uses TreasureListWidget for consistency)
    if (this.wallet) { this.wallet.destroy(); this.wallet = null; }
    const profile = ProfileStore.get();
    const walletAnchor = container.getWorldTransformMatrix().transformPoint(panelW / 2 - 48, -panelH / 2 + 56);
    this.wallet = new TreasureListWidget(this, {
      x: walletAnchor.x, y: walletAnchor.y,
      anchor: 'top-right',
      iconScale: 0.5,
      fontSize: 11,
      depth: 1002,
    });
    if (profile) this.wallet.setBundleStatic(profile.treasures);

    // Bomb image (random surprise) — centered just below header.
    const bombImg = this.add.image(0, -panelH / 2 + 130, BOMB_SURPRISE_KEY).setDisplaySize(80, 80);
    container.add(bombImg);

    // BUY button — interactive only when affordable; full hover/press feedback.
    const canAfford = profile && costEntries.every(([t, n]) => (profile.treasures[t] ?? 0) >= (n ?? 0));
    const buyBg = this.add.rectangle(0, -panelH / 2 + 200, 200, 36, canAfford ? 0x2a553a : 0x333344, 1)
      .setStrokeStyle(2, canAfford ? 0x44ff88 : 0x555566);
    const buyLabel = this.add.text(0, -panelH / 2 + 200,
      `BUY  (${costEntries.map(([t, n]) => `${displayShort(t)} ×${n}`).join(', ')})`,
      {
        fontSize: '13px', color: canAfford ? '#44ff88' : '#888899',
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
    container.add(buyBg);
    container.add(buyLabel);
    if (canAfford) {
      this.bindRectButton(buyBg, buyLabel, {
        idle: 0x2a553a, hover: 0x3a7050, down: 0x1f4030,
        idleStroke: 0x44ff88, hoverStroke: 0x88ffaa, downStroke: 0x2a8855,
      }, () => {
        NetworkManager.track('factory_start', 'factory_result');
        NetworkManager.getSocket().emit('factory_start', { factoryId: id });
      });
    }

    // Progress section — dynamic, re-renders on tick.
    // Body left blank here; renderPopup fills it.
    this.popup = { container, overlay };
    this.renderPopup();
  }

  private renderPopup(): void {
    if (!this.popup || this.popupFactoryId == null) return;
    const id = this.popupFactoryId;
    const cfg = FACTORIES[id];
    const profile = ProfileStore.get();
    if (!profile) return;
    const state = profile.factories?.[id] ?? { firstCycleStartedAt: null, queueLength: 0, storage: [] as BombType[] };

    // Keep the popup wallet in sync with the latest treasure bundle. Without
    // this, a successful BUY leaves the top-right wallet showing pre-buy counts
    // until the popup is closed and reopened.
    this.wallet?.setBundleStatic(profile.treasures);

    // Drop and re-add the dynamic body each tick. Header/buy/etc stay in
    // place (they were added to `container` directly); we wipe and rebuild
    // anything with the `_dyn` flag via the dynLayer container.
    const dyn = (this.popup.container as Phaser.GameObjects.Container & { _dyn?: Phaser.GameObjects.Container });
    dyn._dyn?.destroy();
    const layer = this.add.container(0, 0);
    dyn._dyn = layer;
    this.popup.container.add(layer);

    const panelW = 480;
    const costEntries = Object.entries(cfg.cost) as Array<[TreasureType, number]>;

    // Progress section
    const progY = 60;
    const remaining = state.queueLength;
    const isWorking = remaining > 0 && state.firstCycleStartedAt != null;
    const progress = isWorking ? clamp01(currentCycleProgress(state, cfg, Date.now() + this.serverNowOffset)) : 0;

    // Left: stacked treasure rows (one per cost-treasure-type)
    const leftX = -panelW / 2 + 24;
    for (let i = 0; i < costEntries.length; i++) {
      const [type, perCycle] = costEntries[i];
      const total = remaining * (perCycle ?? 0);
      const rowY = progY + (i - (costEntries.length - 1) / 2) * 22;
      const icon = this.add.image(leftX + 12, rowY, TREASURE_TEXTURE_KEY, treasureIconFrame(type))
        .setDisplaySize(22, 22);
      const txt = this.add.text(leftX + 28, rowY, displayCount(total), {
        fontSize: '14px', color: total > 0 ? '#ffd944' : '#666',
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      layer.add(icon);
      layer.add(txt);
    }

    // Center: progress bar
    const barX = leftX + 90;
    const barW = panelW - 90 - 80 - 60;
    const barBg = this.add.rectangle(barX, progY, barW, 18, 0x111122, 1).setOrigin(0, 0.5).setStrokeStyle(1, 0x4a4a6a);
    const bar = this.add.rectangle(barX + 1, progY, (barW - 2) * progress, 14, isWorking ? 0x44ff88 : 0x333344, 1).setOrigin(0, 0.5);
    layer.add(barBg);
    layer.add(bar);

    // Time label under bar
    const cycleMs = cfg.cycleDurationMs;
    const remainMs = isWorking ? Math.max(0, cycleMs - (cycleMs * progress)) : cycleMs;
    layer.add(this.add.text(barX + barW / 2, progY + 16, isWorking ? `next: ${fmtMs(remainMs)}` : `cycle: ${fmtMs(cycleMs)}`, {
      fontSize: '10px', color: '#aaa', fontFamily: 'monospace',
    }).setOrigin(0.5));

    // Right: target bomb (?)
    const targetX = barX + barW + 30;
    const targetIcon = this.add.image(targetX, progY, BOMB_SURPRISE_KEY).setDisplaySize(36, 36).setAlpha(isWorking ? 1 : 0.35);
    layer.add(targetIcon);

    // Storage section
    const storageTop = progY + 70;
    const storageW = panelW - 60;
    const storageH = 100;
    const storagePanel = this.add.rectangle(0, storageTop + storageH / 2, storageW, storageH, 0x161628, 0.9)
      .setStrokeStyle(1, 0x3a3a5a);
    layer.add(storagePanel);

    const storageLabel = this.add.text(0, storageTop - 14, `STORAGE  (${state.storage.length})`, {
      fontSize: '12px', color: '#aaa', fontFamily: 'monospace',
    }).setOrigin(0.5);
    layer.add(storageLabel);

    if (state.storage.length === 0) {
      layer.add(this.add.text(0, storageTop + storageH / 2, '(empty)', {
        fontSize: '12px', color: '#555', fontFamily: 'monospace',
      }).setOrigin(0.5));
    } else {
      const iconSize = 28;
      const iconGap = 6;
      const startX = -storageW / 2 + 12;
      const startY = storageTop + 18;
      for (let i = 0; i < state.storage.length; i++) {
        const col = i % 12;
        const row = Math.floor(i / 12);
        const ix = startX + col * (iconSize + iconGap) + iconSize / 2;
        const iy = startY + row * (iconSize + iconGap) + iconSize / 2;
        const bombType = state.storage[i] as BombType;
        const icon = this.add.image(ix, iy, 'bomb_icons', bombIconFrame(bombType)).setDisplaySize(iconSize, iconSize);
        icon.setInteractive({ useHandCursor: true });
        icon.on('pointerover', () => icon.setTint(0x88ccff));
        icon.on('pointerout', () => icon.clearTint());
        icon.on('pointerdown', () => {
          NetworkManager.track('factory_claim', 'factory_result');
          NetworkManager.getSocket().emit('factory_claim', { factoryId: id, index: i });
        });
        layer.add(icon);
      }
    }

    // Take All button — same feedback pattern as BUY.
    const takeAllY = storageTop + storageH + 28;
    const canTake = state.storage.length > 0;
    const takeBg = this.add.rectangle(0, takeAllY, 200, 32, canTake ? 0x2a553a : 0x333344, 1)
      .setStrokeStyle(2, canTake ? 0x44ff88 : 0x555566);
    const takeLabel = this.add.text(0, takeAllY, canTake ? `TAKE ALL  (×${state.storage.length})` : 'TAKE ALL', {
      fontSize: '13px', color: canTake ? '#44ff88' : '#888899',
      fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    layer.add(takeBg);
    layer.add(takeLabel);
    if (canTake) {
      this.bindRectButton(takeBg, takeLabel, {
        idle: 0x2a553a, hover: 0x3a7050, down: 0x1f4030,
        idleStroke: 0x44ff88, hoverStroke: 0x88ffaa, downStroke: 0x2a8855,
      }, () => {
        NetworkManager.track('factory_claim', 'factory_result');
        NetworkManager.getSocket().emit('factory_claim', { factoryId: id });
      });
    }
  }

  /**
   * Wire a rect+label pair as an interactive button with idle/hover/press
   * visual states (fill colour, stroke colour, subtle scale on press).
   * Click fires on pointerup so a press can be cancelled by dragging out.
   */
  private bindRectButton(
    bg: Phaser.GameObjects.Rectangle,
    label: Phaser.GameObjects.Text,
    palette: {
      idle: number; hover: number; down: number;
      idleStroke: number; hoverStroke: number; downStroke: number;
    },
    onClick: () => void,
  ): void {
    let pressed = false;
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => {
      bg.setFillStyle(palette.hover);
      bg.setStrokeStyle(2, palette.hoverStroke);
    });
    bg.on('pointerout', () => {
      pressed = false;
      bg.setFillStyle(palette.idle);
      bg.setStrokeStyle(2, palette.idleStroke);
      bg.setScale(1);
      label.setScale(1);
    });
    bg.on('pointerdown', () => {
      pressed = true;
      bg.setFillStyle(palette.down);
      bg.setStrokeStyle(2, palette.downStroke);
      bg.setScale(0.97);
      label.setScale(0.97);
    });
    bg.on('pointerup', () => {
      bg.setFillStyle(palette.hover);
      bg.setStrokeStyle(2, palette.hoverStroke);
      bg.setScale(1);
      label.setScale(1);
      if (pressed) onClick();
      pressed = false;
    });
  }

  private closePopup(): void {
    if (!this.popup) return;
    this.popup.container.destroy();
    this.popup.overlay.destroy();
    this.popup = null;
    this.popupFactoryId = null;
    this.wallet?.destroy();
    this.wallet = null;
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
