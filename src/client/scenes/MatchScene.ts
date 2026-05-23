import Phaser from 'phaser';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import type { MatchBackend } from '../backends/MatchBackend.ts';
import { SocketMatchBackend } from '../backends/SocketMatchBackend.ts';
import { TutorialMatchBackend, TUTORIAL_PLAYER_ID } from '../backends/TutorialMatchBackend.ts';
import type { TutorialOverlayScene } from './TutorialOverlayScene.ts';
import type { TooltipScene } from './TooltipScene.ts';
import type { TooltipKey } from '../tooltip/tooltipData.ts';
import { MapRenderer, preloadTiledMap } from '../systems/MapRenderer.ts';
import { FogRenderer } from '../systems/FogRenderer.ts';
import { BombRenderer, decalDecayAlpha } from '../systems/BombRenderer.ts';
import { BombermanSpriteSystem, deathAnimationDurationMs } from '../systems/BombermanSpriteSystem.ts';
const SWORD_FADE_MS = BombermanSpriteSystem.SWORD_FADE_MS;
import { ensureBombermanAnims, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { findPath, type PathTile } from '@shared/systems/Pathfinding.ts';
import type { MapData } from '@shared/types/map.ts';
import type { MatchState } from '@shared/types/match.ts';
import type { BombermanState } from '@shared/types/bomberman.ts';
import { defaultStatsForTier } from '@shared/config/bomberman-tiers.ts';
import type { BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { preloadTreasureIcons, TREASURE_TEXTURE_KEY, treasureIconFrame } from '../systems/TreasureIcons.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { ShieldRenderer } from '../systems/ShieldRenderer.ts';
import {
  type TreasureType,
  type TreasureBundle,
  TREASURE_TYPES,
  TREASURE_DISPLAY_NAMES,
  hasAnyTreasure,
} from '@shared/config/treasures.ts';
import type { MatchEndMsg } from '@shared/types/messages.ts';

/**
 * Click targeting mode.
 *   - idle: nothing staged
 *   - pathing: the user clicked a floor tile; we computed a BFS path and
 *     will auto-send one move action per turn until the path is consumed
 *   - aim: a bomb slot is selected; the next floor click stages a throw
 */
type InputMode =
  | { kind: 'idle' }
  | { kind: 'pathing'; path: PathTile[] }
  | { kind: 'aim'; slotIndex: number; targetX: number | null; targetY: number | null };

const SLOT_SIZE = 64;
const SLOT_GAP = 8;
// Slot count is per-Bomberman now (tier-driven). Use `localTotalSlotCount`
// in instance methods. The `_LOCAL_FALLBACK_*` constants below are used
// before the local Bomberman is known (e.g., scene init, before first state).
const FREE_TIER_DEFAULT = defaultStatsForTier('free');
const LOCAL_FALLBACK_CUSTOM_SLOTS = FREE_TIER_DEFAULT.maxCustomSlots;
const LOCAL_FALLBACK_TOTAL_SLOTS = 1 + LOCAL_FALLBACK_CUSTOM_SLOTS;
const LOCAL_FALLBACK_STACK_SIZE = FREE_TIER_DEFAULT.stackSize;

/**
 * Active match scene.
 *
 * Server is authoritative — we receive MatchState snapshots and render them.
 * Clicks on floor tiles compute a BFS path that the client walks one tile
 * per turn. Clicks on bomb slots (bottom HUD) switch into aim mode; a
 * subsequent tile click stages a throw. Clicking self cancels any staged
 * action.
 */
export class MatchScene extends Phaser.Scene {
  /** Source of authoritative match events. Swapped to TutorialMatchBackend
   *  in tutorial mode; everything else (rendering, input, HUD) is identical. */
  private backend: MatchBackend | null = null;
  /** 'network' drives a real server match. 'tutorial' runs a scripted
   *  single-player scenario via the TutorialMatchBackend. */
  private mode: 'network' | 'tutorial' = 'network';
  private mapData: MapData | null = null;
  private mapRenderer: MapRenderer | null = null;
  private fogRenderer: FogRenderer | null = null;
  private shieldRenderer: ShieldRenderer | null = null;
  private shieldLayer!: Phaser.GameObjects.Container;
  private shieldShardLayer!: Phaser.GameObjects.Container;
  private bombRenderer: BombRenderer | null = null;
  private state: MatchState | null = null;
  private myPlayerId: string | null = null;
  private inputMode: InputMode = { kind: 'idle' };
  /** Which bomb slot is armed for throwing. Purely visual — movement continues
   *  until the player actually clicks a tile to throw at. */
  private selectedSlot: number | null = null;
  private lastPhase: string | null = null;
  /** Set on the first middle/right mouse click of a match. Once true, the
   *  per-frame `centerOn` in update() stops running so the player can pan
   *  freely. Resets to false in create() for each new match. */
  private cameraManualOverride = false;
  /** Tutorial-only: when true, the per-frame centerOn() in update() is
   *  skipped entirely so scripted `panCamera` destinations actually stick.
   *  The tutorial director toggles this via `setCameraLocked`. Without
   *  this flag, the default follow-player behavior snaps the camera back
   *  on the next frame and the tutorial's "cinematic" pans never land. */
  private cameraTutorialLocked = false;
  private cameraDragging = false;
  /** Suppresses the browser right-click menu so right-drag pan works. Stored
   *  as a field so shutdown() can remove the listener by reference. */
  private preventContext = (e: Event): void => { e.preventDefault(); };
  private cameraDragStartX = 0;
  private cameraDragStartY = 0;
  private cameraScrollStartX = 0;
  private cameraScrollStartY = 0;
  /** Authoritative matchId this scene is bound to (from LobbyScene). Any
   *  `match_state` broadcast with a different matchId is ignored — guards
   *  against stale socket.io room subscriptions from a previous match. */
  private myMatchId: string | null = null;
  private myDeathAt: number | null = null;
  /** Wall-clock time at which the local player's escape event fired.
   *  Set when the `escaped` TurnEvent arrives for this player. Used to
   *  (a) avoid double-transitioning when `match_end` eventually arrives and
   *  (b) drive the delayed jump to the Results screen without waiting for
   *  the room-wide `match_end` broadcast, which only fires once everyone
   *  else is also out. */
  private myEscapeAt: number | null = null;
  /** Treasures snapshot captured from the local player's `escaped` event.
   *  The server drains `bm.treasures` on escape (to avoid double-credit at
   *  finalize), so by the time `transitionToResults` reads `me.treasures`
   *  it's already empty. Snapshotting here preserves the haul for the
   *  Results screen. */
  private myEscapeTreasures: TreasureBundle | null = null;
  /** Running tally of treasures the LOCAL player has picked up this match.
   *  Accumulated client-side from every `treasures_collected` / `body_looted`
   *  event that names the local player. Used as the bulletproof fallback for
   *  the Results screen — independent of any server snapshot, network
   *  ordering, or `match_end` payload. */
  private myTreasureTally: TreasureBundle = {};
  private myKills = 0;
  private myKillerName: string | null = null;
  private tiledInfo: ReturnType<typeof preloadTiledMap> = null;
  /** Dedicated HUD camera that ignores world zoom/pan. */
  private hudCamera: Phaser.Cameras.Scene2D.Camera | null = null;

  // World-space display layers (draw order enforced by setDepth).
  // Spec: top → bottom render order is
  //   Explosion Burst > Bomberman (alive) > Bombs > Corpse > Blood >
  //     Ender Pearl Decal > Scorch Decal > Chests > Doors/Hatches > Map
  // Depths:
  //   0   map (tilemap layers and tileset graphics)
  //   10  doors + escape hatch sprites
  //   15  chests
  //   20  scorchDecalLayer (explosion/burn scorch marks)
  //   22  pearlDecalLayer (ender pearl teleport decals)
  //   25  bloodDecalLayer (blood splatter)
  //   28  corpseLayer (dead Bomberman sprites)
  //   35  bombLayer (persistent bombs, throw arcs, fire, flare flames, fuse nums)
  //   50  fog of war overlay
  //   60  path line
  //   100 bombermanLayer (alive Bomberman sprites + overlays)
  //   105 entitiesLayer (coin bags, pickups, bodies — pure rebuild-each-tick)
  //   120 explosionLayer (shockwaves + ender pearl FROM puff, always through fog)
  //   150 highlights (aim/move targets)
  //   1000+ HUD
  private entitiesLayer!: Phaser.GameObjects.Container;
  private bombermanLayer!: Phaser.GameObjects.Container;
  private corpseLayer!: Phaser.GameObjects.Container;
  private bombLayer!: Phaser.GameObjects.Container;
  private explosionLayer!: Phaser.GameObjects.Container;
  private scorchDecalLayer!: Phaser.GameObjects.Container;
  private pearlDecalLayer!: Phaser.GameObjects.Container;
  private bloodDecalLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private highlightGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;
  private bombermanSpriteSystem: BombermanSpriteSystem | null = null;

  // HUD — each element is created as a scene root object with
  // setScrollFactor(0) so Phaser's native input system handles hit-testing.
  // Avoids the container+scrollFactor interaction bug that previously
  // prevented bomb slot clicks from registering.
  private timerText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  /** Tiny red label shown just right of the turn counter while the local
   *  player is standing on a broken (already-used) escape hatch. */
  private brokenHatchText: Phaser.GameObjects.Text | null = null;
  private hpText!: Phaser.GameObjects.Text;
  private treasureList!: TreasureListWidget;
  /** Top-right HUD coin counter (NEW_META §2). Always visible regardless
   *  of amount, pinned above the treasure list. */
  private coinHudIcon: Phaser.GameObjects.Graphics | null = null;
  private coinHudText: Phaser.GameObjects.Text | null = null;
  /** Running tally of coins the local player has picked up this match.
   *  Client-authoritative for the Results screen — same pattern as
   *  myTreasureTally. */
  private myCoinTally = 0;
  private slotRects: Phaser.GameObjects.Rectangle[] = [];
  private slotLabelTexts: Phaser.GameObjects.Text[] = [];
  private slotCountTexts: Phaser.GameObjects.Text[] = [];
  private slotHighlights: Phaser.GameObjects.Graphics[] = [];
  private slotIcons: Phaser.GameObjects.Image[] = [];
  /** Semi-transparent gray overlay covering the bomb tray + STUNNED banner
   *  shown while the local bomberman has the stunned status effect. */
  private stunHudOverlay: Phaser.GameObjects.Graphics | null = null;
  private stunHudLabel: Phaser.GameObjects.Text | null = null;
  /** Small sword icon shown on the left of the bomb tray while the local
   *  bomberman is in Melee Trap Mode. Disappears instantly on exit. */
  private meleeHudIcon: Phaser.GameObjects.Image | null = null;
  private errorText!: Phaser.GameObjects.Text;
  // UAV indicator (top HUD) + "UAV is Revealing the whole area" banner.
  // Hidden in tutorial matches. Throbs when the next UAV is <=3 turns away.
  private uavText: Phaser.GameObjects.Text | null = null;
  private uavPulseTween: Phaser.Tweens.Tween | null = null;
  private uavBannerText: Phaser.GameObjects.Text | null = null;
  private uavBannerTimer: Phaser.Time.TimerEvent | null = null;

  // Loot panel — appears above the bomb tray when standing on loot
  private lootPanelObjects: Phaser.GameObjects.GameObject[] = [];
  private lootPanelVisible = false;
  /** If set, the player clicked a loot bomb that doesn't fit — highlight it
   * and the next inventory-slot click will swap. */
  private lootPendingSwap: { sourceKind: 'chest' | 'body'; sourceId: string; bombType: import('@shared/types/bombs.ts').BombType; count: number } | null = null;

  // ---- Keys ----
  /** One sprite per key currently rendered, keyed by "x,y". */
  private keySprites = new Map<string, Phaser.GameObjects.Image>();
  /** Per-client fog-of-war memory: was a key on this tile the last time we
   *  saw it? Updated only when the tile is in current LOS, so a key that
   *  disappears out of LOS remains visible on this client until we look
   *  back. Resets each match (cleared in shutdown / on scene init). */
  private keyMemory = new Map<string, boolean>();
  /** Small key icon used in the HUD counter widget. */
  private keysHudIcon: Phaser.GameObjects.Image | null = null;
  /** "N/3" text shown next to the HUD key icon. */
  private keysHudText: Phaser.GameObjects.Text | null = null;

  // Escape hatch animated sprites
  // States:
  //   intact   — default closed-hatch frame, animated spritesheet still bound
  //   opening  — playing hatch_opening (triggered by a local 'escaped' event
  //              for this hatch with LOS on the tile at the moment of escape)
  //   closing  — playing hatch_closing (chained after opening completes)
  //   broken   — final state; texture swapped to escape_hatch_broken (static)
  //
  // `memoryBroken` is the per-client "last known" broken state for fog-of-war:
  // updated only when this client has LOS on the hatch. Once true, the broken
  // texture stays even when the tile is in seen-dim fog.
  private escapeSprites: Array<{
    x: number; y: number;
    sprite: Phaser.GameObjects.Sprite;
    state: 'intact' | 'opening' | 'closing' | 'broken';
    memoryBroken: boolean;
  }> = [];

  /** One badge per escape tile — lock icon + "N/3" text floating above the
   *  hatch. Visible only while the local bomberman is on or Chebyshev-adjacent
   *  to that hatch, the hatch is not broken, and keys < cap. */
  private lockBadges: Array<{
    x: number; y: number;
    container: Phaser.GameObjects.Container;
    text: Phaser.GameObjects.Text;
  }> = [];

  /** Yoyo pulse tween running on the HUD key icon while the local player
   *  stands on a short-of-keys hatch. Stopped (and nulled) when the condition
   *  clears. */
  private keyHudPulseTween: Phaser.Tweens.Tween | null = null;

  /** "Ready to escape" floating banner above the local player's head. Lazy
   *  created on first show; toggled via setVisible. */
  private escapeBanner: Phaser.GameObjects.Container | null = null;
  /** Yoyo pulse on the escape banner; paused/resumed alongside visibility. */
  private escapeBannerPulseTween: Phaser.Tweens.Tween | null = null;
  /** Circular progress ring drawn around the local player while ready-to-escape;
   *  fills clockwise over the input phase. */
  private escapeRing: Phaser.GameObjects.Graphics | null = null;

  // Chest animated sprites (persistent, like escape hatches)
  private chestSprites: Array<{
    id: string; x: number; y: number; tier: 1 | 2 | 3;
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open' | 'closing';
    permanentlyOpened: boolean;
    /** Whether the chest tile was in LoS on the previous updateChests tick.
     *  Used so opening / closing animations skip their wind-up on the frame
     *  we regain LoS — you just see the chest in whatever state it should
     *  be in, same rule as doors. */
    wasVisible: boolean;
  }> = [];

  // Door animated sprites
  private doorSprites: Array<{
    id: number;
    tiles: Array<{ x: number; y: number }>;
    orientation: 'horizontal' | 'vertical';
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open';
    opened: boolean;
  }> = [];

  // Blood trail decals (persistent, one per tile, tracked separately from
  // explosion decals). Map so we can iterate for the per-turn decal-decay pass.
  private bloodDecals = new Map<string, Phaser.GameObjects.Graphics>();

  /**
   * Tile under the cursor in world tile coords, updated by the pointermove
   * handler. Null when the cursor is off the map or outside the viewport.
   * Drives the red throw-target preview reticle (see drawHighlights()).
   */
  private hoveredTileX: number | null = null;
  private hoveredTileY: number | null = null;

  /**
   * RTS-style fog: tracks which entities/decals the player has "discovered"
   * by having them in LOS at least once. Objects in seen-dim areas are only
   * rendered if they're in this set. New objects that appear while the area
   * is in seen-dim stay hidden until the player revisits.
   */
  private knownEntities = new Set<string>();

  constructor() {
    super({ key: 'MatchScene' });
  }

  preload(): void {
    const mapIdForPreload = this.mode === 'tutorial' ? 'tutorial_map' : 'main_map';
    this.tiledInfo = preloadTiledMap(this, mapIdForPreload);
    // Escape hatch: 288x32 sheet, 6 frames of 48x32
    this.load.spritesheet('escape_hatch', 'sprites/escape_hatch.png', {
      frameWidth: 48,
      frameHeight: 32,
    });
    // Broken hatch: 288x32 spritesheet, same layout as escape_hatch — we use
    // frame 0 only, as a 1:1 replacement for the closed-hatch frame.
    this.load.spritesheet('escape_hatch_broken', 'sprites/escape_hatch_broken.png', {
      frameWidth: 48,
      frameHeight: 32,
    });
    // Key collectible — single static image, stretched to fit a full tile.
    this.load.image('key', 'sprites/key.png');
    // Chests: 64x32 sheets, 4 frames of 16x32 each
    this.load.spritesheet('chest_1', 'sprites/chest_1.png', { frameWidth: 16, frameHeight: 32 });
    this.load.spritesheet('chest_2', 'sprites/chest_2.png', { frameWidth: 16, frameHeight: 32 });
    this.load.spritesheet('chest_3', 'sprites/chest_3.png', { frameWidth: 16, frameHeight: 32 });
    // Doors: loaded as a plain image, frames added manually in create()
    this.load.image('double_doors', 'sprites/double_doors.png');
    // Sword icon — Melee Trap Mode indicator (HUD + above-head overlay).
    this.load.image('sword_icon', 'sprites/sword_icon.png');
    // Bomb icons (safety fallback — normally loaded by BootScene)
    preloadBombIcons(this);
    preloadTreasureIcons(this);
    // Bomberman sheets are normally loaded by BootScene, but this is a
    // safety fallback in case MatchScene is reached without Boot running.
    preloadBombermanSpritesheets(this);
  }

  init(data: { matchId?: string | null; mode?: 'network' | 'tutorial' } | undefined): void {
    this.myMatchId = data?.matchId ?? null;
    this.mode = data?.mode ?? 'network';
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    if (this.mode === 'tutorial') {
      // Tutorial is single-player with a fabricated player id — skip the
      // profile lookup and the post-match UI-anim-lock clear.
      this.myPlayerId = TUTORIAL_PLAYER_ID;
      console.log(`[MatchScene] create(): tutorial mode, myPlayerId = ${this.myPlayerId}`);
    } else {
      const profile = ProfileStore.get();
      this.myPlayerId = profile?.id ?? null;
      console.log(`[MatchScene] create(): myPlayerId = ${this.myPlayerId}, matchId = ${this.myMatchId}`);

      // "The selected Bomberman's UI animation cycles, but only after you play a
      // match with him." Clearing the lock now means the next post-match UI
      // render (menu, shops, selector) picks a fresh random idle/idle3/walk.
      if (profile?.equippedBombermanId) {
        UiAnimLock.clear(profile.equippedBombermanId);
      }
    }

    this.inputMode = { kind: 'idle' };
    this.lastPhase = null;
    this.cameraManualOverride = false;
    // Tutorial scripts toggle this via setCameraLocked; reset on every scene
    // entry so a second run doesn't start camera-locked from a stale flag.
    this.cameraTutorialLocked = false;
    this.cameraDragging = false;
    this.myDeathAt = null;
    this.myEscapeAt = null;
    this.myEscapeTreasures = null;
    this.myTreasureTally = {};
    this.myCoinTally = 0;
    this.myKills = 0;
    this.myKillerName = null;
    this.escapeSprites = [];
    this.keySprites = new Map();
    this.keyMemory = new Map();
    this.bloodDecals = new Map();
    this.knownEntities = new Set();
    if (!this.anims.exists('hatch_closed')) {
      this.anims.create({
        key: 'hatch_closed',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 0 }),
        repeat: -1,
      });
      this.anims.create({
        key: 'hatch_opening',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 5 }),
        frameRate: 10,
        repeat: 0,
      });
      this.anims.create({
        key: 'hatch_open',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 5 }),
        repeat: -1,
      });
      this.anims.create({
        key: 'hatch_closing',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 0 }),
        frameRate: 10,
        repeat: 0,
      });
    }

    // Chest animations (same pattern as escape hatches)
    if (!this.anims.exists('chest_1_closed')) {
      for (const tier of [1, 2, 3] as const) {
        const key = `chest_${tier}`;
        this.anims.create({ key: `${key}_closed`,  frames: this.anims.generateFrameNumbers(key, { start: 0, end: 0 }), repeat: -1 });
        this.anims.create({ key: `${key}_opening`, frames: this.anims.generateFrameNumbers(key, { start: 0, end: 3 }), frameRate: 8, repeat: 0 });
        this.anims.create({ key: `${key}_open`,    frames: this.anims.generateFrameNumbers(key, { start: 3, end: 3 }), repeat: -1 });
        this.anims.create({ key: `${key}_closing`, frames: this.anims.generateFrameNumbers(key, { start: 3, end: 0 }), frameRate: 8, repeat: 0 });
      }
    }

    // Door animations — manually define frames from the non-uniform spritesheet
    if (!this.anims.exists('door_h_closed')) {
      const tex = this.textures.get('double_doors');
      // Horizontal open-up: 6 frames of 64×32 at y=0
      for (let i = 0; i < 6; i++) tex.add(`h_${i}`, 0, i * 64, 0, 64, 32);
      // Vertical open-right: 6 frames of 32×64 at y=80
      for (let i = 0; i < 6; i++) tex.add(`v_${i}`, 0, i * 32, 80, 32, 64);

      const hFrames = Array.from({ length: 6 }, (_, i) => ({ key: 'double_doors', frame: `h_${i}` }));
      this.anims.create({ key: 'door_h_closed',  frames: [hFrames[0]], repeat: -1 });
      this.anims.create({ key: 'door_h_opening', frames: hFrames, frameRate: 4, repeat: 0 });
      this.anims.create({ key: 'door_h_open',    frames: [hFrames[5]], repeat: -1 });

      const vFrames = Array.from({ length: 6 }, (_, i) => ({ key: 'double_doors', frame: `v_${i}` }));
      this.anims.create({ key: 'door_v_closed',  frames: [vFrames[0]], repeat: -1 });
      this.anims.create({ key: 'door_v_opening', frames: vFrames, frameRate: 4, repeat: 0 });
      this.anims.create({ key: 'door_v_open',    frames: [vFrames[5]], repeat: -1 });
    }

    // Bomberman animations (idempotent — first scene to call this wins).
    ensureBombermanAnims(this);

    // Paint the viewport black behind everything. Anything outside the map
    // rect (including camera pan padding and spots the fog doesn't cover)
    // renders as solid black instead of the game's default dark-blue canvas.
    this.cameras.main.setBackgroundColor('#000000');

    // Explicit depth stack — see class-level comment for the full spec.
    // Decals are split into 3 containers so blood > pearl > scorch ordering is enforced.
    this.scorchDecalLayer = this.add.container(0, 0).setDepth(20);
    this.pearlDecalLayer = this.add.container(0, 0).setDepth(22);
    // Shield Wall shards: persistent floor decals from shattered Shield Bombs.
    this.shieldShardLayer = this.add.container(0, 0).setDepth(23);
    this.bloodDecalLayer = this.add.container(0, 0).setDepth(25);
    // Corpses get their own layer so bombs (depth 35) render on top of them per spec.
    this.corpseLayer = this.add.container(0, 0).setDepth(28);
    // Active Shield Walls render between corpses and bombs — they're solid
    // tile-level obstacles.
    this.shieldLayer = this.add.container(0, 0).setDepth(32);
    // Bombs render above corpses/decals, below fog.
    this.bombLayer = this.add.container(0, 0).setDepth(35);
    // Alive Bombermen render above fog — managed visibility via setVisible.
    this.bombermanLayer = this.add.container(0, 0).setDepth(100);
    this.entitiesLayer = this.add.container(0, 0).setDepth(105);
    // Explosion layer is ABOVE fog — shockwaves always visible.
    this.explosionLayer = this.add.container(0, 0).setDepth(120);
    this.effectsLayer = this.add.container(0, 0).setDepth(150);
    this.highlightGraphics = this.add.graphics().setDepth(150);
    this.effectsLayer.add(this.highlightGraphics);
    this.pathGraphics = this.add.graphics().setDepth(60);

    // HUD uses a second camera that never zooms/scrolls. It ignores all world
    // containers so it only draws HUD objects. The main camera ignores HUD objects
    // so it only draws the world.
    this.hudCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, 'hud');
    this.hudCamera.setScroll(0, 0);
    // Tell the HUD camera to ignore all world-space containers
    this.hudCamera.ignore([
      this.bombLayer, this.scorchDecalLayer, this.pearlDecalLayer, this.bloodDecalLayer,
      this.corpseLayer, this.explosionLayer, this.entitiesLayer, this.bombermanLayer,
      this.effectsLayer, this.highlightGraphics, this.pathGraphics,
      this.shieldLayer, this.shieldShardLayer,
    ]);

    this.buildHud();

    this.errorText = this.hud(this.add.text(this.scale.width / 2, this.scale.height / 2, '', {
      fontSize: '18px',
      color: '#ff4444',
      fontFamily: 'monospace',
      align: 'center',
      backgroundColor: '#1a0a0a',
      padding: { x: 24, y: 16 },
    }).setOrigin(0.5).setDepth(10000).setVisible(false));

    // Construct the authoritative-events backend. In network mode this wraps
    // the shared socket; in tutorial mode it's a local scripted resolver.
    // MatchScene's rendering/input code is backend-agnostic from here on.
    this.backend = this.mode === 'tutorial'
      ? this.buildTutorialBackend()
      : new SocketMatchBackend();
    this.backend.onMatchState((state) => this.onMatchState(state));
    this.backend.onTurnResult((events) => this.onTurnResult(events));
    this.backend.onMatchEnd((msg) => {
      // If we already transitioned client-side (death or local escape), ignore.
      if (this.myDeathAt !== null || this.myEscapeAt !== null) return;
      // Delay so the player can see the Bomberman reaching the escape hatch
      // before the results screen appears. The walk animation takes 70% of
      // the transition phase; wait for the full transition to complete.
      const delay = BALANCE.match.transitionPhaseSeconds * 1000 + 500;
      this.time.delayedCall(delay, () => this.transitionToResults(msg));
    });
    this.backend.start();

    // Tutorial-only overlay. Renders dialogue, highlights, pause, etc.
    // above MatchScene's HUD camera. Receives a scene ref so it can query
    // HUD rects and drive camera pans on the main camera.
    //
    // Defensive: explicitly stop any lingering instance from a previous
    // tutorial run before launching. Without this, a second tutorial entry
    // can hit a Phaser state where the overlay's init/create don't re-run,
    // leaving the director un-attached and the player frozen on Beat 0.
    if (this.mode === 'tutorial') {
      if (this.scene.isActive('TutorialOverlayScene') || this.scene.isSleeping('TutorialOverlayScene')) {
        this.scene.stop('TutorialOverlayScene');
      }
      this.scene.launch('TutorialOverlayScene', { matchScene: this, backend: this.backend });
    }

    // Hover tooltip overlay — runs in both network and tutorial mode.
    if (!this.scene.isActive('TooltipScene')) this.scene.launch('TooltipScene');

    // Left-click = game actions. Middle/right = manual camera pan: first
    // press also flips `cameraManualOverride` on, which disables the
    // per-frame auto-centering in update() for the rest of the match.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.onClick(pointer);
        return;
      }
      if (pointer.middleButtonDown() || pointer.rightButtonDown()) {
        // First manual pan of the match — drop the camera bounds. With tight
        // bounds set to the map rect, Phaser clamps scrollX/scrollY to zero
        // whenever the map is smaller than the viewport at the current zoom
        // (so panning only worked on whichever axis the map actually overflowed).
        // Removing bounds gives free pan in both axes — outside the map you
        // just see the black backdrop, which is expected in manual mode.
        if (!this.cameraManualOverride) {
          this.cameras.main.removeBounds();
        }
        this.cameraManualOverride = true;
        this.cameraDragging = true;
        this.cameraDragStartX = pointer.x;
        this.cameraDragStartY = pointer.y;
        this.cameraScrollStartX = this.cameras.main.scrollX;
        this.cameraScrollStartY = this.cameras.main.scrollY;
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      // Track hovered tile for the red throw-target reticle. Runs on every
      // pointermove regardless of drag state so the reticle keeps tracking
      // while the player moves the mouse.
      if (this.mapData) {
        const ts = this.mapData.tileSize;
        const wp = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
        const tx = Math.floor(wp.x / ts);
        const ty = Math.floor(wp.y / ts);
        if (tx >= 0 && ty >= 0 && tx < this.mapData.width && ty < this.mapData.height) {
          this.hoveredTileX = tx;
          this.hoveredTileY = ty;
        } else {
          this.hoveredTileX = null;
          this.hoveredTileY = null;
        }
      }
      this.refreshTooltip(pointer.x, pointer.y);
      if (!this.cameraDragging) return;
      const dx = pointer.x - this.cameraDragStartX;
      const dy = pointer.y - this.cameraDragStartY;
      const zoom = this.cameras.main.zoom;
      this.cameras.main.scrollX = this.cameraScrollStartX - dx / zoom;
      this.cameras.main.scrollY = this.cameraScrollStartY - dy / zoom;
    });

    this.input.on('pointerup', () => { this.cameraDragging = false; });
    this.input.on('gameout', () => this.getTooltipScene()?.setKey(null));

    // Suppress the browser context menu so right-drag works cleanly.
    this.game.canvas.addEventListener('contextmenu', this.preventContext);

    // Scroll-wheel zoom — clamped 0.5×–4×.
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _objs: unknown[], _dx: number, dy: number) => {
      const next = Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 4);
      this.cameras.main.setZoom(next);
    });

    // Keyboard shortcuts for the bomb slots — bound up to the hard upper
    // bound of slot count (Rock + MAX_INVENTORY_SLOT_COUNT custom = 7).
    // `onSlotClicked` no-ops on indices that don't exist for the current
    // Bomberman, so it's safe to wire all of them unconditionally.
    const kb = this.input.keyboard;
    if (kb) {
      const digitKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'];
      for (let i = 0; i < digitKeys.length; i++) {
        kb.on(`keydown-${digitKeys[i]}`, () => this.onSlotClicked(i));
      }
      kb.on('keydown-ESC', () => {
        this.inputMode = { kind: 'idle' };
        this.sendAction({ kind: 'idle' });
        this.rebuildEntities();
        this.renderHud();
      });
    }
  }

  shutdown(): void {
    this.game.canvas.removeEventListener('contextmenu', this.preventContext);
    this.backend?.destroy();
    this.backend = null;
    // Stop the parallel tutorial overlay scene, if it was launched.
    if (this.mode === 'tutorial' && this.scene.isActive('TutorialOverlayScene')) {
      this.scene.stop('TutorialOverlayScene');
    }
    if (this.scene.isActive('TooltipScene')) this.scene.stop('TooltipScene');
    this.mapRenderer?.destroy();
    this.mapRenderer = null;
    this.fogRenderer?.destroy();
    this.fogRenderer = null;
    this.shieldRenderer?.destroy();
    this.shieldRenderer = null;
    this.bombRenderer?.destroy();
    this.bombRenderer = null;
    this.bombermanSpriteSystem?.destroy();
    this.bombermanSpriteSystem = null;
    this.state = null;
    this.slotRects = [];
    this.slotLabelTexts = [];
    this.slotCountTexts = [];
    this.slotHighlights = [];
    this.slotIcons = [];
    this.hudTrayBg = null;
    this.stunHudOverlay = null;
    this.stunHudLabel = null;
    this.meleeHudIcon = null;
    this.uavText = null;
    this.brokenHatchText = null;
    this.uavPulseTween?.stop();
    this.uavPulseTween?.remove();
    this.uavPulseTween = null;
    this.uavBannerText?.destroy();
    this.uavBannerText = null;
    this.uavBannerTimer?.remove();
    this.uavBannerTimer = null;
    this.lastBuiltSlotCount = -1;
    for (const esc of this.escapeSprites) esc.sprite.destroy();
    this.escapeSprites = [];
    for (const b of this.lockBadges) b.container.destroy();
    this.lockBadges = [];
    this.keyHudPulseTween?.stop();
    this.keyHudPulseTween?.remove();
    this.keyHudPulseTween = null;
    this.escapeBannerPulseTween?.stop();
    this.escapeBannerPulseTween?.remove();
    this.escapeBannerPulseTween = null;
    this.escapeBanner?.destroy();
    this.escapeBanner = null;
    this.escapeRing?.destroy();
    this.escapeRing = null;
    for (const s of this.keySprites.values()) s.destroy();
    this.keySprites = new Map();
    this.keyMemory = new Map();
    this.keysHudIcon = null;
    this.keysHudText = null;
    this.hudObjects = [];
    if (this.hudCamera) {
      this.cameras.remove(this.hudCamera);
      this.hudCamera = null;
    }
    this.input.keyboard?.removeAllListeners();
  }

  update(time: number, delta: number): void {
    // Drive Tiled animated tile clock
    this.mapRenderer?.tick(delta);
    // Drive Bomberman walk lerps + overlay positions
    this.bombermanSpriteSystem?.tick(time);

    if (!this.state) return;

    // Update ready-to-escape feedback (banner above head + progress ring)
    this.updateEscapeReadyIndicator();

    // Camera follow: snap to the local player's tile center every frame.
    // Skips if the player has escaped (sprite is gone) so the last framing
    // holds through the 500ms delay before the Results transition. Also
    // skips once the player has manually panned (middle/right click) —
    // from that point on they're in control until the match ends.
    if (this.mapData && !this.cameraManualOverride && !this.cameraTutorialLocked) {
      const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
      if (me && !me.escaped) {
        const ts = this.mapData.tileSize;
        this.cameras.main.centerOn(me.x * ts + ts / 2, me.y * ts + ts / 2);
      }
    }

    const ms = Math.max(0, this.state.phaseEndsAt - Date.now());
    this.timerText.setText(`${(ms / 1000).toFixed(1)}s`);

    // Keep the HUD HP number in sync with the sprite system's delayed
    // HP — tick() swaps displayedHp once the post-damage delay ends, and
    // the text here follows along without waiting for a match_state.
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (me && me.alive) {
      const displayedHp = this.bombermanSpriteSystem?.getDisplayedHp(me.playerId) ?? me.hp;
      this.hpText.setText(`HP ${displayedHp}/${BALANCE.match.bombermanMaxHp}`);
    }
  }

  private async onMatchState(state: MatchState): Promise<void> {
    // Defense-in-depth against stale socket.io room subscriptions. If the
    // server forgets to unsubscribe us from a previous match, its state
    // broadcasts would otherwise land here and fight with the real match.
    if (this.myMatchId && state.matchId !== this.myMatchId) {
      console.warn(`[MatchScene] ignoring stale match_state from ${state.matchId} (bound to ${this.myMatchId})`);
      return;
    }
    const firstFrame = this.state === null;
    const phaseBecameInput = state.phase === 'input' && this.lastPhase !== 'input';
    // Snapshot the outgoing flare light set before swapping state — the fog
    // update below unions it with the incoming set so tiles that ARE losing
    // illumination this turn stay lit through the transition animations
    // (explosions, decals, blood) and only dim after those have played out.
    const prevLightTiles = this.state?.lightTiles ?? [];
    this.state = state;

    try {
      if (firstFrame || !this.mapData || this.mapData.id !== state.mapId) {
        console.log(`[MatchScene] loading map '${state.mapId}'`);
        this.mapData = await loadMapById(state.mapId);
        console.log(`[MatchScene] map loaded: ${this.mapData.width}x${this.mapData.height}`);
        this.mapRenderer?.destroy();
        this.mapRenderer = new MapRenderer(this, this.mapData, 0, this.tiledInfo);
        // Create one animated hatch sprite per escape tile. The sprite is
        // rendered at native 48x32 pixel size and centered on the escape
        // tile's world position. No setDisplaySize() — let the art render
        // at its native resolution so pixels stay crisp.
        for (const spr of this.escapeSprites) spr.sprite.destroy();
        this.escapeSprites = [];
        for (const b of this.lockBadges) b.container.destroy();
        this.lockBadges = [];
        const mapTs = this.mapData.tileSize;
        for (const esc of this.mapData.escapeTiles) {
          // Anchor: horizontally centered, bottom of sprite aligned to bottom
          // of the escape tile. The 48x32 sprite splits into a 3x2 grid of
          // 16x16 cells, and the middle-bottom cell is the one that should
          // sit ON the escape tile.
          const sprite = this.add.sprite(
            esc.x * mapTs + mapTs / 2,
            esc.y * mapTs + mapTs,
            'escape_hatch',
          );
          sprite.setDepth(10);
          sprite.setOrigin(0.5, 1);
          sprite.play('hatch_closed');
          if (this.hudCamera) this.hudCamera.ignore(sprite);
          this.escapeSprites.push({ x: esc.x, y: esc.y, sprite, state: 'intact', memoryBroken: false });

          // Lock badge — floats above the hatch. Hidden by default; renderHud
          // toggles visibility based on local-player adjacency + key shortfall.
          // Uses the same key sprite used everywhere else for consistency.
          const badgeCx = esc.x * mapTs + mapTs / 2;
          const badgeCy = esc.y * mapTs - 14;
          const badge = this.add.container(badgeCx, badgeCy).setDepth(120).setVisible(false);
          const bg = this.add.graphics();
          bg.fillStyle(0x0a0a14, 0.85);
          bg.fillRoundedRect(-15, -8, 30, 15, 3);
          bg.lineStyle(1, 0xff5555, 1);
          bg.strokeRoundedRect(-15, -8, 30, 15, 3);
          const keyIcon = this.add.image(-7, 0, 'key').setDisplaySize(9, 9);
          const txt = this.add.text(2, 0, '0/3', {
            fontSize: '6px', color: '#ff8888', fontFamily: 'Arial, sans-serif', fontStyle: 'bold',
            stroke: '#000000', strokeThickness: 1,
          }).setOrigin(0, 0.5);
          badge.add([bg, keyIcon, txt]);
          if (this.hudCamera) this.hudCamera.ignore(badge);
          this.lockBadges.push({ x: esc.x, y: esc.y, container: badge, text: txt });
        }
        // Initial chest-sprite build — subsequent syncs happen below on every
        // state update so tutorial-spawned chests also get sprites.
        for (const cs of this.chestSprites) cs.sprite.destroy();
        this.chestSprites = [];
        this.syncChestSprites(state, mapTs);

        // Create door sprites
        for (const ds of this.doorSprites) ds.sprite.destroy();
        this.doorSprites = [];
        if (state.doors) {
          for (const door of state.doors) {
            const prefix = door.orientation === 'horizontal' ? 'h' : 'v';
            const animKey = `door_${prefix}`;
            const tiles = door.tiles;
            let sx: number, sy: number;
            if (door.orientation === 'horizontal') {
              // Center between the 2 tiles, bottom-aligned
              sx = tiles[0].x * mapTs + mapTs;
              sy = tiles[0].y * mapTs + mapTs;
            } else {
              // Vertical door: center of the tile column, bottom of lowest tile + 1 tile
              // The sprite is 32×64 (4 tiles tall) but the door is only 3 tiles.
              // Anchor at bottom-center, position at the bottom edge of the lowest tile.
              sx = tiles[0].x * mapTs + mapTs / 2;
              sy = (tiles[tiles.length - 1].y + 1) * mapTs + mapTs;
            }
            const sprite = this.add.sprite(sx, sy, 'double_doors', `${prefix}_0`);
            sprite.setDepth(10);
            sprite.setOrigin(0.5, 1);
            sprite.play(door.opened ? `${animKey}_open` : `${animKey}_closed`);
            if (this.hudCamera) this.hudCamera.ignore(sprite);
            this.doorSprites.push({
              id: door.id, tiles: door.tiles, orientation: door.orientation,
              sprite, state: door.opened ? 'open' : 'closed', opened: door.opened,
            });
          }
        }

        // Tell the HUD camera to ignore everything the map renderer created
        if (this.hudCamera) {
          this.mapRenderer.ignoreFromCamera(this.hudCamera);
        }
        this.fogRenderer?.destroy();
        this.fogRenderer = new FogRenderer(this, this.mapData, BALANCE.match.losRadius, 50);
        if (this.hudCamera) this.fogRenderer.ignoreFromCamera(this.hudCamera);
        this.bombRenderer?.destroy();
        this.bombRenderer = new BombRenderer(this, this.bombLayer, this.explosionLayer, this.scorchDecalLayer, this.pearlDecalLayer, this.mapData.tileSize);
        this.shieldRenderer?.destroy();
        this.shieldRenderer = new ShieldRenderer({
          scene: this,
          wallLayer: this.shieldLayer,
          vfxLayer: this.explosionLayer,
          decalLayer: this.shieldShardLayer,
          hudCamera: this.hudCamera,
          tileSize: this.mapData.tileSize,
        });
        this.bombermanSpriteSystem?.destroy();
        this.bombermanSpriteSystem = new BombermanSpriteSystem(this, this.bombermanLayer, this.corpseLayer, this.mapData.tileSize);
        if (this.hudCamera) this.bombermanSpriteSystem.ignoreFromCamera(this.hudCamera);
        const bounds = this.mapRenderer.getWorldBounds();
        const ts = this.mapData.tileSize;
        const spawnMe = this.myBomberman();
        const startX = spawnMe ? spawnMe.x * ts + ts / 2 : bounds.width / 2;
        const startY = spawnMe ? spawnMe.y * ts + ts / 2 : bounds.height / 2;
        console.log(`[MatchScene] camera init: spawn=(${spawnMe?.x},${spawnMe?.y}) startPx=(${startX},${startY}) bounds=(${bounds.width},${bounds.height})`);
        // Tight bounds (no padding), fixed zoom, snap to spawn. Per-frame
        // follow happens in update() — see cameraFollowPlayer().
        const cam = this.cameras.main;
        cam.setBounds(0, 0, bounds.width, bounds.height);
        cam.setZoom(2.5);
        cam.centerOn(startX, startY);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MatchScene] map load failed:', err);
      this.errorText.setText(`MAP LOAD FAILED\n${msg}\n\nCheck browser console.`);
      this.errorText.setVisible(true);
      return;
    }

    this.errorText.setVisible(false);

    // Sync chest sprites to state every update, not just on the first frame.
    // Tutorial's `spawnChest` mutateState pushes chests into the state after
    // the initial map load — without this we'd never create sprites for them.
    if (this.mapData) {
      this.syncChestSprites(state, this.mapData.tileSize);
    }

    const me = this.myBomberman();

    // Feed flare light tiles into fog as external reveals (visible for everyone).
    // Two-phase update:
    //   1. Push the UNION of previous + new lightTiles immediately. Tiles
    //      being added (a flare just landed) light up right away; tiles
    //      being removed (a flare shrank or expired) stay lit through the
    //      transition so the turn's explosions/decals/blood don't render
    //      on a dimmed fog.
    //   2. At the end of the transition phase, collapse to just the new
    //      set — the tiles that actually lost illumination now darken.
    if (this.fogRenderer) {
      const unionKeys = new Set<string>();
      const unionTiles: Array<{ x: number; y: number }> = [];
      const pushUnique = (t: { x: number; y: number }): void => {
        const k = `${t.x},${t.y}`;
        if (!unionKeys.has(k)) { unionKeys.add(k); unionTiles.push({ x: t.x, y: t.y }); }
      };
      for (const t of prevLightTiles) pushUnique(t);
      for (const t of state.lightTiles) pushUnique(t);
      this.fogRenderer.setExternalReveals(unionTiles);
      // Closed-door tiles block LOS the same as walls.
      const closedDoorTiles: Array<{ x: number; y: number }> = [];
      for (const d of state.doors ?? []) {
        if (d.opened) continue;
        for (const t of d.tiles) closedDoorTiles.push({ x: t.x, y: t.y });
      }
      this.fogRenderer.setClosedDoorTiles(closedDoorTiles);
      // Active Shield Walls also block LoS like solid walls.
      const shieldWallTiles: Array<{ x: number; y: number }> = [];
      for (const w of state.shieldWalls ?? []) {
        for (const t of w.tiles) shieldWallTiles.push({ x: t.x, y: t.y });
      }
      this.fogRenderer.setShieldWallTiles(shieldWallTiles);
      // Suppress LoS when the local bomberman is inside any smoke cloud —
      // per design, the smoked player only sees their own tile plus the
      // seen-dim map they already discovered. Also hoists bomb graphics
      // above the fog so the smoked player can still see bombs clearly.
      const meInSmoke = !!me && (state.smokeClouds ?? []).some(c =>
        c.tiles.some(t => t.x === me.x && t.y === me.y),
      );
      this.fogRenderer.setLosSuppressed(meInSmoke);
      this.bombRenderer?.setSmokeMode(meInSmoke);
      if (me) this.fogRenderer.update(me.x, me.y);

      const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
      this.time.delayedCall(transitionMs, () => {
        if (!this.fogRenderer || this.state !== state) return;
        this.fogRenderer.setExternalReveals(state.lightTiles);
        const myNow = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
        if (myNow) {
          const meInSmokeNow = (state.smokeClouds ?? []).some(c =>
            c.tiles.some(t => t.x === myNow.x && t.y === myNow.y),
          );
          this.fogRenderer.setLosSuppressed(meInSmokeNow);
          this.bombRenderer?.setSmokeMode(meInSmokeNow);
          this.fogRenderer.update(myNow.x, myNow.y);
        }
      });
    }

    // Keep bomb/fire/light visuals in sync with the state
    this.bombRenderer?.syncBombs(state.bombs);
    this.bombRenderer?.syncFire(state.fireTiles, state.turnNumber);
    this.bombRenderer?.syncFlares(state.flares);
    this.bombRenderer?.syncSmokeClouds(state.smokeClouds ?? []);
    this.bombRenderer?.syncMines(state.mines ?? []);

    // Decal decay pass — recompute alpha for every existing decal and blood
    // splat based on the current turn number. See BALANCE.decalDecay.
    this.bombRenderer?.applyDecalDecay(state.turnNumber);
    this.applyBloodDecalDecay(state.turnNumber);

    // Sync persistent Bomberman sprites (creates/destroys + updates HP/aim)
    this.bombermanSpriteSystem?.syncFromState(
      state,
      this.myPlayerId,
      this.selectedSlot !== null || this.inputMode.kind === 'aim',
      (x, y) => this.fogRenderer?.isVisible(x, y) ?? true,
      // RTS fog for corpses: discover on LOS, persist in seen-dim
      (playerId, x, y) => {
        const key = `corpse_${playerId}`;
        if (this.fogRenderer?.isVisible(x, y)) {
          this.knownEntities.add(key);
          return true;
        }
        return this.knownEntities.has(key) && (this.fogRenderer?.isDiscovered(x, y) ?? false);
      },
    );

    // Flush any staged action at the start of every new input phase.
    // This is how the "queue during transition" flexibility works: click
    // stages input locally, the send is deferred until we're back in input.
    if (phaseBecameInput) {
      this.flushStagedAction();
    }
    // After the transition resolves, a staged throw has been consumed — drop
    // aim mode so the next input phase doesn't re-throw from the same slot.
    if (state.phase === 'transition' && this.inputMode.kind === 'aim') {
      this.inputMode = { kind: 'idle' };
    }
    // Note: selectedSlot is NOT cleared on transition — it persists until the
    // player either throws (onClick clears it) or toggles it off (same key).

    this.lastPhase = state.phase;
    this.rebuildEntities();
    this.renderHud();
  }

  /**
   * Send the server an action matching our current staged inputMode.
   * No-op if we're not in the input phase (server would ignore it anyway);
   * onMatchState calls this again when the next input phase begins.
   */
  private flushStagedAction(): void {
    if (!this.state || this.state.phase !== 'input') return;
    const me = this.myBomberman();
    if (!me) return;

    switch (this.inputMode.kind) {
      case 'idle':
        this.sendAction({ kind: 'idle' });
        return;

      case 'pathing': {
        // Pop waypoints we've already reached (may be 1 or 2 if rush was active)
        while (this.inputMode.path.length > 0 &&
               this.inputMode.path[0].x === me.x && this.inputMode.path[0].y === me.y) {
          this.inputMode.path.shift();
        }
        if (this.inputMode.path.length === 0) {
          this.inputMode = { kind: 'idle' };
          this.sendAction({ kind: 'idle' });
          return;
        }
        // Rush: send both the first and second waypoints so the server
        // processes two sequential 1-tile moves in a single turn.
        const rushActive = me.rushActive ?? false;
        const first = this.inputMode.path[0];
        if (rushActive && this.inputMode.path.length >= 2) {
          const second = this.inputMode.path[1];
          this.inputMode.path.shift(); // pop the first waypoint (will be consumed this turn)
          this.sendAction({ kind: 'move', x: first.x, y: first.y, rushX: second.x, rushY: second.y });
        } else {
          this.sendAction({ kind: 'move', x: first.x, y: first.y });
        }
        return;
      }

      case 'aim':
        if (this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
          this.sendAction({
            kind: 'throw',
            slotIndex: this.inputMode.slotIndex,
            x: this.inputMode.targetX,
            y: this.inputMode.targetY,
          });
        }
        return;
    }
  }

  private transitionToResults(msg?: MatchEndMsg): void {
    const me = this.state?.bombermen.find(b => b.playerId === this.myPlayerId);
    // Prefer the authoritative escape list from match_end when available;
    // fall back to the per-player flag on state for the client-side-exit
    // path (local escape triggers Results before match_end arrives).
    const escaped = msg?.escapedPlayerIds?.includes(this.myPlayerId ?? '') ?? (me?.escaped ?? false);
    const alive = me?.alive ?? false;
    const endReason = msg?.endReason ?? (alive ? 'all_escaped' : 'all_dead');

    // Determine outcome
    let outcome: 'escaped' | 'died' | 'lost' = 'died';
    if (escaped) {
      outcome = 'escaped';
    } else if (endReason === 'turn_limit' && alive) {
      outcome = 'lost';
    }

    // Collect inventory summary for escaped players
    const inventory: Array<{ type: BombType; name: string; count: number }> = [];
    if (me && escaped) {
      for (const slot of me.inventory.slots) {
        if (slot) {
          const def = BOMB_CATALOG[slot.type];
          inventory.push({ type: slot.type, name: def.name, count: slot.count });
        }
      }
    }

    // Treasure source priority — first non-empty wins. The client-side tally
    // is the primary source because we accumulate it from `treasures_collected`
    // / `body_looted` events as they arrive, so it cannot be lost to any
    // server-side drain or message ordering issue:
    //  1. `myTreasureTally` — what we actually saw the player pick up.
    //  2. `match_end` payload — server's authoritative bundle.
    //  3. `myEscapeTreasures` — snapshot from the `escaped` event payload.
    //  4. `me.treasures` — current state (only valid when nothing has drained,
    //     e.g. tutorial backend).
    const fromMatchEnd = msg?.treasuresEarned?.[this.myPlayerId ?? ''];
    const myTreasures: TreasureBundle =
      (hasAnyTreasure(this.myTreasureTally) ? { ...this.myTreasureTally } : null)
      ?? (fromMatchEnd && hasAnyTreasure(fromMatchEnd) ? { ...fromMatchEnd } : null)
      ?? (this.myEscapeTreasures && hasAnyTreasure(this.myEscapeTreasures) ? { ...this.myEscapeTreasures } : null)
      ?? (me?.treasures ? { ...me.treasures } : {});

    this.scene.start('ResultsScene', {
      outcome,
      treasuresEarned: myTreasures,
      turnsPlayed: this.state?.turnNumber ?? 0,
      inventory,
      kills: this.myKills,
      killerName: this.myKillerName,
      myBombermanName: me ? (this.state?.bombermen.find(b => b.playerId === this.myPlayerId) as any)?.name ?? null : null,
    });
  }

  /** One-shot visuals from the server's authoritative turn resolution. */
  private onTurnResult(events: Array<{ kind: string; [k: string]: unknown }>): void {
    if (!this.bombRenderer) return;

    // UAV banner + flash burst. Per uav_fired event, play the same per-tile
    // flareFlash burst a player-thrown flare produces on detonation at every
    // UAV flare's center tile. The persistent flame on each tile is then
    // drawn by syncFlares once the new state arrives.
    for (const ev of events) {
      if (ev.kind !== 'uav_fired') continue;
      this.showUavBanner();
      const tiles = (ev.tiles as Array<{ x: number; y: number }>) ?? [];
      const flashMs = Math.round(BALANCE.match.transitionPhaseSeconds * 1000 * 0.5);
      for (const t of tiles) {
        this.bombRenderer.flareFlash({ x: t.x, y: t.y }, flashMs);
      }
    }

    // Drive Bomberman walk lerps + facing changes from `moved` events.
    // Each lerp lasts the full transition phase so the sprite physically
    // walks from old tile to new tile in sync with the resolution timer.
    // Group moved events by player — rush moves produce 2 events for one player.
    // Walks are Beat 1 ("Action Perform") of the 3-beat resolve phase — they
    // finish at the 1/3 mark, just before explosions/teleports/smoke (Beat 2,
    // "Action Result") kick in.
    // Bombermen who exited Melee Trap this turn: their walk/throw visuals
    // are held back by the sword-fade duration so the fade-out plays
    // cleanly before the sprite starts moving (per the spec).
    const meleeExiters = new Set<string>();
    for (const ev of events) {
      if (ev.kind === 'melee_trap_changed' && ev.active === false) {
        meleeExiters.add(ev.playerId as string);
      }
    }
    // Three-beat resolve timings. Beat 1 is fixed (walks + throws must
    // complete within it); Beats 2 and 3 are allowed to linger past their
    // nominal slot as long as they start on time.
    const transitionMsTotal = BALANCE.match.transitionPhaseSeconds * 1000;
    const BEAT1_END_MS = Math.round(transitionMsTotal / 3);
    const BEAT3_START_MS = Math.round((transitionMsTotal * 2) / 3);
    const moveDurationMs = BEAT1_END_MS;
    const movesByPlayer = new Map<string, Array<{ fromX: number; fromY: number; toX: number; toY: number }>>();
    for (const ev of events) {
      if (ev.kind !== 'moved') continue;
      const pid = ev.playerId as string;
      if (!movesByPlayer.has(pid)) movesByPlayer.set(pid, []);
      movesByPlayer.get(pid)!.push({
        fromX: ev.fromX as number, fromY: ev.fromY as number,
        toX: ev.toX as number, toY: ev.toY as number,
      });
    }
    for (const [playerId, moves] of movesByPlayer) {
      const exitHold = meleeExiters.has(playerId) ? SWORD_FADE_MS : 0;
      const perMoveDuration = moveDurationMs / moves.length;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const delay = exitHold + i * perMoveDuration;
        if (delay > 0) {
          this.time.delayedCall(delay, () => {
            this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
          });
        } else {
          this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
        }
      }
    }

    // Collect every player id that will have its TakeDamage / Die anim
    // driven this turn so we only play it ONCE per victim. Bomb damage
    // + melee damage landing on the same bomberman in the same turn
    // should drop HP by 2 but only play the hurt animation once (design
    // spec). Melee wins precedence — it has its own timed Attack3 → hurt
    // sequence that we don't want to step on.
    const hurtQueued = new Set<string>();

    // Melee Trap counter-attacks first.
    for (const ev of events) {
      if (ev.kind !== 'melee_attack') continue;
      const attackerId = ev.attackerId as string;
      const victimId = ev.victimId as string;
      const killed = ev.killed as boolean;
      const intermediate = ev.intermediate as { x: number; y: number } | undefined;
      if (hurtQueued.has(victimId)) continue; // victim already queued
      hurtQueued.add(victimId);
      if (intermediate) {
        // Trigger Attack3 at the walk midpoint so it looks like the strike
        // intercepts the rushing victim. Walk takes half the transition;
        // halfway through walk == 25% of transition.
        const delay = Math.round((BALANCE.match.transitionPhaseSeconds * 1000) * 0.25);
        this.time.delayedCall(delay, () => {
          this.bombermanSpriteSystem?.applyMeleeAttack(attackerId, victimId, killed);
        });
      } else {
        // Walk-end or mutual trigger — fire Attack3 after the walk lerp
        // completes (50% of transition) for step-in, or immediately for
        // mutual melee (victim isn't moving).
        const delay = Math.round((BALANCE.match.transitionPhaseSeconds * 1000) * 0.5);
        this.time.delayedCall(delay, () => {
          this.bombermanSpriteSystem?.applyMeleeAttack(attackerId, victimId, killed);
        });
      }
    }

    // Hurt animations on damage events — Beat 3 ("Action Reaction"). Fires
    // 2/3 of the way through the transition so the victim visibly reacts
    // AFTER the explosion (beat 2) connects, not at the start of the turn.
    //   - hpRemaining > 0: play Hurt.
    //   - hpRemaining === 0: skip — the death animation (also in beat 3,
    //     scheduled below) covers the lethal blow per design ("just die
    //     animation if 1 hp").
    // Skipped for any victim already queued (melee victim, or a previous
    // damage event in the same turn).
    for (const ev of events) {
      if (ev.kind !== 'damaged') continue;
      const playerId = ev.playerId as string;
      if (hurtQueued.has(playerId)) continue;
      hurtQueued.add(playerId);
      const hpRemaining = ev.hpRemaining as number;
      if (hpRemaining <= 0) continue; // death anim covers lethal hits
      this.time.delayedCall(BEAT3_START_MS, () => {
        this.bombermanSpriteSystem?.applyHurtEvent(playerId);
      });
    }

    // First pass: spawn arcs for every throw this turn and record the bomb
    // ids so we can time-shift their matching explosions.
    const arcDurationByBombId = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind !== 'throw') continue;
      const playerId = ev.playerId as string;
      const type = ev.type as BombType;
      const bombId = ev.bombId as string;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.x as number;
      const toY = ev.y as number;
      // Arc always renders, but per-frame LOS-clipped: the bomb sprite
      // hides on any frame whose current tile is outside LOS, so a throw
      // from the fog visibly emerges when it enters the player's sight.
      // The thrower's throw *animation*, however, still only plays if the
      // thrower is in LOS — no point animating a sprite in darkness.
      const throwerVisible = playerId === this.myPlayerId
        || this.fogRenderer?.isVisible(fromX, fromY);
      const fog = this.fogRenderer;
      const los = fog ? (tx: number, ty: number) => fog.isVisible(tx, ty) : undefined;
      const exitHold = meleeExiters.has(playerId) ? SWORD_FADE_MS : 0;
      if (exitHold > 0) {
        // Delay the throw arc + throw animation so the melee-trap sword
        // fade clearly plays before the bomberman unwinds into the throw.
        // Arc duration matches the Beat 1 window (1/3 of the transition).
        const duration = BEAT1_END_MS;
        const totalFlightMs = duration + exitHold;
        arcDurationByBombId.set(bombId, totalFlightMs);
        // Hold the landed-bomb sprite until the full exit-hold + arc finishes
        // (onTurnResult runs before the new state is applied, so syncBombs
        // will honor this marker when it sees the new BombInstance).
        this.bombRenderer?.markPendingThrow(bombId, totalFlightMs);
        this.time.delayedCall(exitHold, () => {
          this.bombRenderer?.spawnThrowArc(type, fromX, fromY, toX, toY, los);
          if (throwerVisible) {
            this.bombermanSpriteSystem?.applyThrowEvent(playerId, fromX, fromY, toX, toY, duration);
          }
        });
      } else {
        const { duration } = this.bombRenderer.spawnThrowArc(type, fromX, fromY, toX, toY, los);
        arcDurationByBombId.set(bombId, duration);
        this.bombRenderer?.markPendingThrow(bombId, duration);
        if (throwerVisible) {
          this.bombermanSpriteSystem?.applyThrowEvent(playerId, fromX, fromY, toX, toY, duration);
        }
      }
    }

    // Second pass: explosions. Beat 2 ("Action Result") — starts at the 1/3
    // mark when walks + throws have completed. Explosions are allowed to
    // linger past the end of the transition; they are not clipped by the
    // turn boundary. For thrown bombs whose arc exceeds the beat 1 window
    // (e.g. a melee-exiter whose arc is offset by SWORD_FADE_MS), the
    // explosion starts when the bomb lands instead.
    const transitionMs = transitionMsTotal;
    const explosionStartMs = BEAT1_END_MS;
    // Burst lasts ~70% of a transition — with a 1/3 start, it ends around
    // the end of the transition (slight linger).
    const burstDurationMs = Math.round(transitionMs * 0.7);
    // Pre-collect cluster mine positions from this turn's mine_placed
    // events so we can animate bombs flying out of the cluster cylinder
    // toward each mine landing site.
    const clusterMinesByOwner = new Map<string, Array<{ x: number; y: number }>>();
    for (const ev of events) {
      if (ev.kind !== 'mine_placed') continue;
      if (ev.mineKind !== 'cluster') continue;
      const ownerId = ev.ownerId as string;
      if (!clusterMinesByOwner.has(ownerId)) clusterMinesByOwner.set(ownerId, []);
      clusterMinesByOwner.get(ownerId)!.push({ x: ev.x as number, y: ev.y as number });
    }

    for (const ev of events) {
      if (ev.kind !== 'bomb_triggered') continue;
      const type = ev.type as BombType;
      const tiles = ev.tiles as Array<{ x: number; y: number }>;
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      const bombId = ev.bombId as string;
      const arcDelay = arcDurationByBombId.get(bombId) ?? 0;
      const startDelay = Math.max(arcDelay, explosionStartMs);
      if (type === 'cluster_bomb') {
        // Route cluster impact through the dedicated cylinder+scatter
        // animation. Look up the mine positions placed this turn by the
        // throwing player. The throw event carried ownerId via playerId.
        const throwEv = events.find(e => e.kind === 'throw' && e.bombId === bombId);
        const ownerId = (throwEv?.playerId as string | undefined) ?? '';
        const mines = clusterMinesByOwner.get(ownerId) ?? [];
        this.bombRenderer.spawnClusterCylinder(centerX, centerY, mines, startDelay);
        continue;
      }
      this.bombRenderer.spawnExplosion(type, centerX, centerY, tiles, startDelay, burstDurationMs, this.state?.turnNumber ?? 0);
    }

    // Mine triggers render as explosions too. Cluster mines get a plus-r1
    // fire boom + scorch decal (same as a contact bomb). Motion detector
    // mines are handled via flare spawn server-side (flame appears via
    // syncFlares), but we also draw a small flash + whitish decal at the
    // trigger tile so the player sees the mine "popped".
    for (const ev of events) {
      if (ev.kind !== 'mine_triggered') continue;
      const mineKind = ev.mineKind as 'motion_detector' | 'cluster';
      const tiles = (ev.tiles as Array<{ x: number; y: number }>) ?? [];
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      if (mineKind === 'cluster') {
        // Reuse contact bomb's explosion + decal path.
        this.bombRenderer.spawnExplosion(
          'contact', centerX, centerY, tiles,
          explosionStartMs, burstDurationMs, this.state?.turnNumber ?? 0,
        );
      } else {
        // Motion detector: single flash + whitish decal at mine tile.
        this.bombRenderer.spawnExplosion(
          'flare', centerX, centerY, [{ x: centerX, y: centerY }],
          explosionStartMs, burstDurationMs, this.state?.turnNumber ?? 0,
        );
        // Small "flare cartridge fires upward" particle effect — orange
        // streak shoots up from the mine tile to sell the trigger.
        this.time.delayedCall(explosionStartMs, () => {
          this.bombRenderer?.spawnMotionDetectorLaunch(centerX, centerY);
        });
      }
    }

    // Teleport pass: Ender Pearl teleports the thrower at the halfway point
    // of the transition (when the pearl visually arrives). Puff effects play
    // at origin and destination, decals stamp after the puff completes.
    for (const ev of events) {
      if (ev.kind !== 'teleport') continue;
      const playerId = ev.playerId as string;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.toX as number;
      const toY = ev.toY as number;
      const puffDuration = explosionStartMs;
      // At the halfway point: snap sprite, play puffs at both ends
      this.time.delayedCall(explosionStartMs, () => {
        // Snap the Bomberman sprite to the destination tile
        this.bombermanSpriteSystem?.applyTeleportEvent(playerId, toX, toY);
        // Puff effects at origin and destination (TO puff on pearlDecalLayer = RTS-fog gated)
        this.bombRenderer?.spawnTeleportPuff(fromX, fromY, puffDuration, true);  // FROM: above fog (visible like explosions)
        this.bombRenderer?.spawnTeleportPuff(toX, toY, puffDuration, false, this.fogRenderer?.isVisible(toX, toY) ?? false);  // TO: suppressed entirely when destination is fogged
      });
      // Stamp decals after the puff finishes (at the end of the transition)
      const teleportSpawnTurn = this.state?.turnNumber ?? 0;
      this.time.delayedCall(explosionStartMs + puffDuration, () => {
        // Decals are stamped late in the transition (post-puff) — by then, fog
        // may have re-fallen. Pass current LOS so the decal is born hidden
        // when fogged, avoiding a one-frame flash before updatePearlDecalVisibility.
        this.bombRenderer?.stampTeleportDecal(fromX, fromY, teleportSpawnTurn, this.fogRenderer?.isVisible(fromX, fromY) ?? false);
        this.bombRenderer?.stampTeleportDecal(toX, toY, teleportSpawnTurn, this.fogRenderer?.isVisible(toX, toY) ?? false);
      });
    }

    // Shield Bomb pass: push vfx + wall spawn + wall break.
    //   shield_pushed: yellow puff at origin/destination + light-gray decal,
    //                  parallels the Ender Pearl teleport flow.
    //   shield_wall_spawned: slam-in animation per tile (handled in syncWalls
    //                  too, so we only need to play the bomberman-snap if a
    //                  bomberman was pushed AS the wall formed — already
    //                  handled by the shield_pushed branch below).
    //   shield_wall_broken: visual fade-out (state already drained the wall).
    for (const ev of events) {
      if (ev.kind === 'shield_pushed') {
        const fromX = ev.fromX as number;
        const fromY = ev.fromY as number;
        const toX = ev.toX as number;
        const toY = ev.toY as number;
        const puffDuration = explosionStartMs;
        const playerId = (ev as { playerId?: string }).playerId;
        this.time.delayedCall(explosionStartMs, () => {
          if (playerId) {
            this.bombermanSpriteSystem?.applyTeleportEvent(playerId, toX, toY);
          }
          this.shieldRenderer?.spawnPushPuff(fromX, fromY, puffDuration);
          this.shieldRenderer?.spawnPushPuff(toX, toY, puffDuration);
        });
        this.time.delayedCall(explosionStartMs + puffDuration, () => {
          this.shieldRenderer?.stampPushDecal(fromX, fromY);
          this.shieldRenderer?.stampPushDecal(toX, toY);
        });
      } else if (ev.kind === 'shield_wall_broken') {
        const wallId = ev.wallId as string;
        const tiles = ev.tiles as Array<{ x: number; y: number }>;
        const shardIds = (ev as { shardIds?: string[] }).shardIds ?? [];
        this.shieldRenderer?.breakWall(wallId, tiles, shardIds);
      }
      // shield_wall_spawned: handled by syncWalls() called every state tick.
    }

    // Door-opened events: Beat 3 ("Action Reaction"). Deferred to the 2/3
    // mark so a door opened BY an explosion visibly reacts to the blast
    // rather than animating at turn start. Proximity-triggered opens (a
    // bomberman walking up to the door in beat 1) also play here — visually
    // the door opens a moment after the bomberman arrives, which still
    // reads naturally.
    //
    // Gate the animation on current LoS — if ANY of the door's tiles is in
    // the local player's LoS at event time we play it; otherwise snap
    // straight to `open` so the animation doesn't leak through seen-dim
    // fog and reveal enemy positions. Next time the player gets LoS they
    // just see an already-open door.
    for (const ev of events) {
      if (ev.kind !== 'door_opened') continue;
      const doorId = ev.doorId as number;
      const ds = this.doorSprites.find(d => d.id === doorId);
      if (!ds || ds.opened) continue;
      ds.opened = true;
      if (ds.state !== 'closed') continue;
      this.time.delayedCall(BEAT3_START_MS, () => {
        if (ds.state !== 'closed') return;
        const prefix = ds.orientation === 'horizontal' ? 'h' : 'v';
        const inLoS = ds.tiles.some(t => this.fogRenderer?.isVisible(t.x, t.y));
        if (inLoS) {
          ds.state = 'opening';
          ds.sprite.play(`door_${prefix}_opening`);
          ds.sprite.once('animationcomplete', () => {
            ds.state = 'open';
            ds.sprite.play(`door_${prefix}_open`);
          });
        } else {
          ds.state = 'open';
          ds.sprite.play(`door_${prefix}_open`);
        }
      });
    }

    // Melee-killed victims: collect their IDs so we skip the generic death
    // animation replay below (applyMeleeAttack already triggered the death
    // anim at the Attack3 connect point). We still run the death-side-
    // effects (blood splash, kill tracking, results transition).
    const meleeKilled = new Set<string>();
    for (const ev of events) {
      if (ev.kind === 'melee_attack' && ev.killed) meleeKilled.add(ev.victimId as string);
    }

    // Third pass: deaths — delayed so the explosion/bomb effect plays out first.
    // The death animation starts after the explosion visual completes (near
    // the end of the transition), not at the start of the turn.
    const deathDelay = Math.round(transitionMs * 0.85);
    for (const ev of events) {
      if (ev.kind !== 'died') continue;
      const playerId = ev.playerId as string;
      const x = ev.x as number;
      const y = ev.y as number;
      const killerId = (ev.killerId as string | null) ?? null;

      // Track kills: if I killed someone
      if (killerId === this.myPlayerId && playerId !== this.myPlayerId) {
        this.myKills++;
      }
      // Track killer: if someone killed me
      if (playerId === this.myPlayerId && killerId) {
        const killerBm = this.state?.bombermen.find(b => b.playerId === killerId);
        this.myKillerName = (killerBm as any)?.name ?? killerId;
      }

      const isMeleeKill = meleeKilled.has(playerId);
      this.time.delayedCall(deathDelay, () => {
        const deathMs = isMeleeKill
          ? deathAnimationDurationMs()
          : (this.bombermanSpriteSystem?.applyDeathEvent(playerId, x, y) ?? deathAnimationDurationMs());
        // Death-time blood splash removed by request — only the hurt-trail
        // puddles (state.bloodTiles) remain.
        if (playerId === this.myPlayerId) {
          this.myDeathAt = Date.now();
          this.inputMode = { kind: 'idle' };
          this.lootPendingSwap = null;
          this.time.delayedCall(deathMs + 2000, () => {
            this.transitionToResults();
          });
        }
      });
    }

    // Per-hatch escape animation. Plays opening → closing → swap-to-broken,
    // but only if this client has LOS on the hatch tile at the moment the
    // event arrives. Clients without LOS (including those who only have the
    // tile under seen-dim fog) skip the animation entirely and never update
    // their memory — they'll see the broken state silently next time they
    // regain LOS via updateEscapeHatches(). Idempotent against the resolver's
    // habit of re-emitting `escaped` for already-escaped players every turn.
    if (this.fogRenderer) {
      for (const ev of events) {
        if (ev.kind !== 'escaped') continue;
        const e = ev as { hatchX?: number; hatchY?: number };
        if (typeof e.hatchX !== 'number' || typeof e.hatchY !== 'number') continue;
        const esc = this.escapeSprites.find(s => s.x === e.hatchX && s.y === e.hatchY);
        if (!esc) continue;
        if (esc.memoryBroken) continue;
        if (esc.state !== 'intact') continue;
        if (!this.fogRenderer.isVisible(e.hatchX, e.hatchY)) continue;
        esc.state = 'opening';
        esc.sprite.play('hatch_opening');
        esc.sprite.once('animationcomplete', () => {
          esc.state = 'closing';
          esc.sprite.play('hatch_closing');
          esc.sprite.once('animationcomplete', () => {
            esc.state = 'broken';
            esc.memoryBroken = true;
            esc.sprite.anims.stop();
            esc.sprite.setTexture('escape_hatch_broken');
          });
        });
      }
    }

    // Key pickup — flying icon over the picker (only for the local player)
    // to mirror the treasure popup pattern. Keys for other players don't
    // show a popup; they update the world sprite via the next state sync.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'key_pickup') continue;
        const e = ev as unknown as { playerId: string; x: number; y: number };
        if (e.playerId !== this.myPlayerId) continue;
        const bm = this.state?.bombermen.find(b => b.playerId === e.playerId);
        if (!bm) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        this.spawnKeyPopup(baseX, baseY);
      }
    }

    // Local escape — jump to Results without waiting for match_end.
    // The server only broadcasts match_end once ALL players are dead or
    // escaped; in a multi-player match we need to exit the scene on our own
    // escape. Mirrors the death-exit pattern above (delayed call so the
    // walk-to-hatch animation finishes before the transition).
    for (const ev of events) {
      if (ev.kind !== 'escaped') continue;
      if ((ev.playerId as string) !== this.myPlayerId) continue;
      if (this.myEscapeAt !== null || this.myDeathAt !== null) break;
      this.myEscapeAt = Date.now();
      this.myEscapeTreasures = { ...((ev as { treasures?: TreasureBundle }).treasures ?? {}) };
      this.inputMode = { kind: 'idle' };
      this.lootPendingSwap = null;
      const escapeDelay = BALANCE.match.transitionPhaseSeconds * 1000 + 500;
      this.time.delayedCall(escapeDelay, () => this.transitionToResults());
      break;
    }

    // Rush changed indicators
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'rush_changed') continue;
        const bm = this.state?.bombermen.find(b => b.playerId === (ev.playerId as string));
        if (!bm) continue;
        // Only show for the local player's Bomberman
        if (bm.playerId !== this.myPlayerId) continue;
        const wx = bm.x * ts + ts / 2 + ts * 0.6;
        const wy = bm.y * ts + ts / 2 - ts * 1.5;
        const active = ev.active as boolean;
        if (active) {
          const indicator = this.add.text(wx, wy, '\u2191', {
            fontSize: '20px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
            stroke: '#000000', strokeThickness: 3,
          }).setOrigin(0.5).setDepth(150);
          if (this.hudCamera) this.hudCamera.ignore(indicator);
          this.tweens.add({
            targets: indicator, y: wy - ts * 1.5, alpha: 0,
            duration: 1200, ease: 'Cubic.easeOut',
            onComplete: () => indicator.destroy(),
          });
        } else {
          this.spawnExclamation(wx, wy, '#ff4444');
        }
      }
    }

    // Coin pickup visuals (NEW_META §2). Flying "+N coin" popup mirroring
    // treasure pickup, plus tally accumulation for the Results fallback.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'coins_picked_up') continue;
        const playerId = ev.playerId as string;
        const amount = ev.amount as number;
        if (playerId === this.myPlayerId) this.myCoinTally += amount;
        const bm = this.state?.bombermen.find(b => b.playerId === playerId);
        if (!bm) continue;
        if (bm.playerId !== this.myPlayerId) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        this.spawnCoinPopup(baseX, baseY, amount);
      }
    }

    // Fourth pass: treasure collection visuals. Stagger per type so the
    // player can read each pickup separately (icon + "+N").
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        let bundle: TreasureBundle | null = null;
        let playerId: string | null = null;
        if (ev.kind === 'treasures_collected') {
          bundle = ev.treasures as TreasureBundle;
          playerId = ev.playerId as string;
        } else if (ev.kind === 'body_looted') {
          bundle = ev.treasures as TreasureBundle;
          playerId = ev.playerId as string;
        }
        if (!bundle || !playerId) continue;
        // Accumulate into the local-player tally. This is the bulletproof
        // source for the Results screen — we own these numbers client-side
        // and never lose them to a server-side drain.
        if (playerId === this.myPlayerId) {
          for (const t of TREASURE_TYPES) {
            const n = bundle[t] ?? 0;
            if (n > 0) this.myTreasureTally[t] = (this.myTreasureTally[t] ?? 0) + n;
          }
        }
        const bm = this.state?.bombermen.find(b => b.playerId === playerId);
        if (!bm) continue;
        if (bm.playerId !== this.myPlayerId) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        let stagger = 0;
        for (const t of TREASURE_TYPES) {
          const amount = bundle[t] ?? 0;
          if (amount > 0) {
            this.spawnTreasurePopup(baseX, baseY, t, amount, stagger);
            stagger += 220;
          }
        }
      }
    }
  }

  /** Floating "+N [coin]" popup mirroring the treasure pickup VFX.
   *  Coin icon drawn inline as Graphics (mirrors tooltip 'coin' shape). */
  private spawnCoinPopup(worldX: number, worldY: number, amount: number): void {
    const POPUP_ICON = 22;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0);
    const r = POPUP_ICON / 2;
    const iconY = -8;
    const icon = this.add.graphics();
    icon.fillStyle(0xffd944, 1);
    icon.fillCircle(0, iconY, r);
    icon.fillStyle(0xc09020, 1);
    icon.fillCircle(0, iconY, r * 0.7);
    icon.fillStyle(0xffd944, 1);
    icon.fillRect(-r * 0.1, iconY - r * 0.45, r * 0.2, r * 0.9);
    const text = this.add.text(0, 12, `+${amount}`, {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 0.5);
    c.add(icon);
    c.add(text);
    if (this.hudCamera) this.hudCamera.ignore(c);
    this.tweens.add({ targets: c, alpha: 1, duration: 120 });
    this.tweens.add({
      targets: c,
      y: worldY - 40,
      alpha: 0,
      duration: 1200,
      delay: 120,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });
  }

  /** Beefier "+KEY" popup — bigger icon, distinct cyan/teal text and longer
   *  hang time so it isn't lost in the swarm of coin/treasure popups at the
   *  same tile. Also spawns a flying-to-HUD icon that triggers the HUD key
   *  counter pulse on arrival. */
  private spawnKeyPopup(worldX: number, worldY: number): void {
    const POPUP_ICON = 36;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0).setScale(0.6);
    const icon = this.add.image(0, -10, 'key').setDisplaySize(POPUP_ICON, POPUP_ICON);
    const text = this.add.text(0, 16, '+KEY', {
      fontSize: '20px', color: '#88ddff', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000022', strokeThickness: 4,
    }).setOrigin(0.5, 0.5);
    c.add([icon, text]);
    if (this.hudCamera) this.hudCamera.ignore(c);
    // Punch in, then rise + fade. Longer hang than the treasure popup so the
    // key reads as a distinct event.
    this.tweens.add({ targets: c, alpha: 1, scale: 1, duration: 160, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: c,
      y: worldY - 56,
      alpha: 0,
      duration: 1800,
      delay: 200,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });

    // Flying icon: arcs from the pickup tile up to the HUD key counter, then
    // triggers the HUD pulse on arrival. Snapshotted endpoint — slight drift
    // is fine if the world camera moves during the ~700ms flight.
    this.spawnKeyFlightToHud(worldX, worldY);
  }

  /** Arc a small key icon from a world position to the HUD key counter,
   *  pulse the counter on arrival. Uses a quadratic Bezier so it visibly
   *  travels along a curve rather than a straight line. */
  private spawnKeyFlightToHud(worldX: number, worldY: number): void {
    if (!this.keysHudIcon) return;
    const cam = this.cameras.main;
    const target = cam.getWorldPoint(this.keysHudIcon.x, this.keysHudIcon.y);
    const start = new Phaser.Math.Vector2(worldX, worldY - 16);
    const end = new Phaser.Math.Vector2(target.x, target.y);
    const midX = (start.x + end.x) / 2;
    const midY = Math.min(start.y, end.y) - 80;
    const curve = new Phaser.Curves.QuadraticBezier(
      start,
      new Phaser.Math.Vector2(midX, midY),
      end,
    );
    const icon = this.add.image(start.x, start.y, 'key').setDisplaySize(24, 24).setDepth(600);
    if (this.hudCamera) this.hudCamera.ignore(icon);
    const t = { p: 0 };
    const point = new Phaser.Math.Vector2();
    this.tweens.add({
      targets: t,
      p: 1,
      duration: 700,
      ease: 'Cubic.easeIn',
      onUpdate: () => {
        curve.getPoint(t.p, point);
        icon.setPosition(point.x, point.y);
      },
      onComplete: () => {
        icon.destroy();
        this.pulseKeyHud();
      },
    });
  }

  /** Briefly scale the HUD key icon + count text up and back. Fires when a
   *  flying-to-HUD icon arrives, so the eye is drawn to the counter at the
   *  exact moment the number bumps. */
  private pulseKeyHud(): void {
    // Skip while the standing-on-short-hatch pulse is running so we don't
    // stack tweens on the same target (they'd fight over the scale value).
    if (this.keyHudPulseTween) return;
    if (!this.keysHudIcon || !this.keysHudText) return;
    this.tweens.add({
      targets: [this.keysHudIcon, this.keysHudText],
      scale: 1.6,
      duration: 140,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

  /** Per-frame driver for the ready-to-escape feedback: a compact banner
   *  above the local player's head + a clockwise-filling progress ring at
   *  their feet. Visible only during the input phase, on an unbroken hatch,
   *  with keys >= cap. Lazily creates the GameObjects on first show. */
  private updateEscapeReadyIndicator(): void {
    if (!this.state || !this.mapData) {
      this.setEscapeIndicatorVisible(false);
      return;
    }
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (!me || !me.alive || me.escaped) {
      this.setEscapeIndicatorVisible(false);
      return;
    }
    const onHatch = this.state.escapeTiles.some(t => t.x === me.x && t.y === me.y);
    const onBroken = this.state.brokenHatches.some(t => t.x === me.x && t.y === me.y);
    const cap = BALANCE.keys.requiredPerHatch;
    const heldKeys = me.keys ?? 0;
    const ready = onHatch && !onBroken && heldKeys >= cap && this.state.phase === 'input';
    if (!ready) {
      this.setEscapeIndicatorVisible(false);
      return;
    }

    this.ensureEscapeIndicator();
    const ts = this.mapData.tileSize;
    const cx = me.x * ts + ts / 2;
    const cy = me.y * ts + ts / 2;
    this.escapeBanner!.setPosition(cx, cy - ts * 0.9);

    // Ring fill: progress through the input phase. phaseEndsAt is wall-clock
    // ms; inputPhaseSeconds drives the assumed duration.
    const phaseDuration = BALANCE.match.inputPhaseSeconds * 1000;
    const remaining = Math.max(0, this.state.phaseEndsAt - Date.now());
    const progress = Math.max(0, Math.min(1, 1 - remaining / phaseDuration));
    const g = this.escapeRing!;
    g.clear();
    const radius = ts * 0.55;
    // Faint backing ring so the partially-filled arc still reads as a circle.
    g.lineStyle(2, 0x224422, 0.55);
    g.strokeCircle(cx, cy, radius);
    if (progress > 0) {
      g.lineStyle(3, 0x44ff88, 1);
      g.beginPath();
      const start = -Math.PI / 2;
      g.arc(cx, cy, radius, start, start + progress * Math.PI * 2, false);
      g.strokePath();
    }
  }

  /** Lazy-create the escape banner + ring (hidden). Idempotent. */
  private ensureEscapeIndicator(): void {
    if (this.escapeBanner) return;
    // Compact pill: 44×10, dark green fill + thin green outline.
    const c = this.add.container(0, 0).setDepth(180);
    const bg = this.add.graphics();
    bg.fillStyle(0x0a3a18, 0.85);
    bg.fillRoundedRect(-22, -5, 44, 10, 2);
    bg.lineStyle(1, 0x44ff88, 1);
    bg.strokeRoundedRect(-22, -5, 44, 10, 2);
    const txt = this.add.text(0, 0, 'STAY TO ESCAPE', {
      fontSize: '4px', color: '#88ffaa', fontFamily: 'Arial, sans-serif', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 1,
    }).setOrigin(0.5, 0.5);
    c.add([bg, txt]);
    if (this.hudCamera) this.hudCamera.ignore(c);
    this.escapeBanner = c;
    this.escapeBannerPulseTween = this.tweens.add({
      targets: c,
      scale: 1.08,
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    const ring = this.add.graphics().setDepth(15);
    if (this.hudCamera) this.hudCamera.ignore(ring);
    this.escapeRing = ring;
  }

  /** Toggle visibility for the escape indicator pair, pausing/resuming the
   *  banner pulse to keep it from running invisibly. */
  private setEscapeIndicatorVisible(visible: boolean): void {
    if (this.escapeBanner) {
      this.escapeBanner.setVisible(visible);
      if (visible) this.escapeBannerPulseTween?.resume();
      else this.escapeBannerPulseTween?.pause();
    }
    if (this.escapeRing) {
      this.escapeRing.setVisible(visible);
      if (!visible) this.escapeRing.clear();
    }
  }

  /** Floating "+N [icon]" treasure popup that rises and fades out. Staggered
   *  by `delayMs` so multi-type pickups appear in sequence. The icon and the
   *  "+N" text render in a single tight container centered over the
   *  Bomberman so the player sees ONE popup, not a "left icon" + "right
   *  number" pair. */
  private spawnTreasurePopup(worldX: number, worldY: number, type: TreasureType, amount: number, delayMs: number): void {
    const POPUP_ICON = 22;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0);
    const icon = this.add.image(0, -8, TREASURE_TEXTURE_KEY, treasureIconFrame(type))
      .setDisplaySize(POPUP_ICON, POPUP_ICON);
    const text = this.add.text(0, 12, `+${amount}`, {
      fontSize: '16px',
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5, 0.5);
    c.add(icon);
    c.add(text);
    if (this.hudCamera) this.hudCamera.ignore(c);

    this.tweens.add({
      targets: c,
      alpha: 1,
      duration: 120,
      delay: delayMs,
    });
    this.tweens.add({
      targets: c,
      y: worldY - 40,
      alpha: 0,
      duration: 1200,
      delay: delayMs + 120,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });
  }

  private myBomberman(): BombermanState | null {
    return this.state?.bombermen.find(b => b.playerId === this.myPlayerId) ?? null;
  }

  /** Custom slot count for the local player (tier-driven). Falls back to the
   *  Free-tier default before the local Bomberman is known. */
  private localCustomSlotCount(): number {
    return this.myBomberman()?.maxCustomSlots ?? LOCAL_FALLBACK_CUSTOM_SLOTS;
  }

  /** Total HUD slot count (Rock + custom) for the local player. */
  private localTotalSlotCount(): number {
    return 1 + this.localCustomSlotCount();
  }

  /** Per-slot stack cap for the local player. */
  private localStackSize(): number {
    return this.myBomberman()?.stackSize ?? LOCAL_FALLBACK_STACK_SIZE;
  }

  /**
   * Apply the decal-decay alpha curve to every blood decal. Call on each
   * turn boundary; pairs with BombRenderer.applyDecalDecay which handles
   * scorch + pearl decals. See BALANCE.decalDecay in balance.ts.
   */
  private applyBloodDecalDecay(currentTurn: number): void {
    for (const g of this.bloodDecals.values()) {
      const spawnTurn = g.getData('spawnTurn') as number | undefined;
      const baseAlpha = g.getData('baseAlpha') as number | undefined;
      if (spawnTurn === undefined || baseAlpha === undefined) continue;
      const age = Math.max(0, currentTurn - spawnTurn);
      if (age <= BALANCE.decalDecay.fullTurns) continue;
      g.setAlpha(baseAlpha * decalDecayAlpha(age));
    }
  }

  private rebuildEntities(): void {
    this.entitiesLayer.removeAll(true);
    if (!this.state || !this.mapData) return;
    const ts = this.mapData.tileSize;

    // RTS-style fog filter: objects are only shown if the player has actively
    // seen them in LOS. Objects in seen-dim (previously visited but not
    // currently visible) only show if they were already discovered by the
    // player. New objects that appear while the area is dim stay hidden
    // until the player revisits.
    const rtsVisible = (entityId: string, x: number, y: number): boolean => {
      if (this.fogRenderer?.isVisible(x, y)) {
        this.knownEntities.add(entityId);
        return true;
      }
      if (this.fogRenderer?.isDiscovered(x, y) && this.knownEntities.has(entityId)) {
        return true; // stale — last-known state
      }
      return false;
    };

    // Chests are rendered as persistent animated sprites (see chestSprites +
    // updateChests), not rebuilt each frame like bodies.

    // Sync chest open state from server → local sprite permanence
    this.updateChests();

    // Sync Shield Walls + shards from server state, then apply per-tile fog
    // visibility. Walls are LoS-gated; shards are persistent (always visible
    // once revealed — handled inside the renderer).
    if (this.shieldRenderer && this.state) {
      this.shieldRenderer.syncWalls(this.state.shieldWalls ?? []);
      this.shieldRenderer.syncShards(this.state.shieldShards ?? []);
      this.shieldRenderer.applyFogVisibility(
        // Walls: LoS-only (smoke does NOT reveal walls per spec).
        (x, y) => this.fogRenderer?.isVisible(x, y) ?? false,
        // Shards: discovered (LoS now OR previously seen) — same rule as
        // bomb scorch decals. Tiles never spotted stay hidden.
        (x, y) => this.fogRenderer?.isDiscovered(x, y) ?? false,
      );
    }

    // Dropped bodies no longer need a separate indicator — the corpse sprite
    // in corpseLayer already communicates "something is here to loot". The
    // loot panel surfaces the contents when the local player stands on one.

    // Bombermen are no longer drawn here — BombermanSpriteSystem owns the
    // persistent animated sprites, HP pips, self-ring and aim shadow. They
    // live in bombermanLayer and are positioned by the per-frame `tick` based
    // on lerp state from the most recent `moved` event.

    // Sync the local player's aim shadow visibility to the sprite system —
    // covers click-driven aim toggles since rebuildEntities runs after every
    // input action.
    if (this.myPlayerId) {
      this.bombermanSpriteSystem?.setAimActive(this.myPlayerId, this.selectedSlot !== null || this.inputMode.kind === 'aim');
    }

    // Escape hatch state machine — runs only if you've wired up sprites
    if (this.escapeSprites.length > 0) this.updateEscapeHatches();

    // Key sprite reconcile with per-client fog memory.
    this.updateKeys();

    // Door state machine
    if (this.doorSprites.length > 0) this.updateDoors();

    // Blood trail decals — only created when their tile is currently visible
    // (RTS fog: blood that appears while area is dim stays hidden until revisited)
    for (const bt of this.state.bloodTiles) {
      const key = `blood_${bt.x},${bt.y}`;
      if (this.bloodDecals.has(key)) continue;
      if (!rtsVisible(key, bt.x, bt.y)) continue;
      const g = this.add.graphics();
      const cx = bt.x * ts + ts / 2;
      const cy = bt.y * ts + ts / 2;
      // Larger blood splatters
      g.fillStyle(0x881111, 0.75);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.3, cy + (Math.random() - 0.5) * ts * 0.3, ts * 0.25);
      g.fillStyle(0x660808, 0.65);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.4, cy + (Math.random() - 0.5) * ts * 0.4, ts * 0.18);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.35, cy + (Math.random() - 0.5) * ts * 0.35, ts * 0.12);
      g.fillStyle(0x440505, 0.5);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.2, cy + (Math.random() - 0.5) * ts * 0.2, ts * 0.08);
      // Tag for decal decay — see BALANCE.decalDecay in balance.ts.
      g.setData('spawnTurn', this.state.turnNumber);
      g.setData('baseAlpha', 1.0);
      this.bloodDecalLayer.add(g);
      this.bloodDecals.set(key, g);
    }

    // Strict LOS gate for blood splats: lesser fog (0.55 alpha) doesn't hide
    // depth-25 graphics on its own, so hide them explicitly when not in LOS.
    // Reappear on re-entry. Per "never show over fog of war" rule.
    for (const [key, g] of this.bloodDecals) {
      const coords = key.slice(6).split(',');
      const bx = Number(coords[0]);
      const by = Number(coords[1]);
      g.setVisible(this.fogRenderer?.isVisible(bx, by) ?? true);
    }

    // Explosion decals: only visible if tile is currently in LOS (RTS fog)
    this.bombRenderer?.updateDecalVisibility((x, y) => {
      const key = `decal_${x},${y}`;
      if (this.fogRenderer?.isVisible(x, y)) {
        this.knownEntities.add(key);
        return true;
      }
      return this.knownEntities.has(key) && (this.fogRenderer?.isDiscovered(x, y) ?? false);
    });

    // Pearl decals: stricter rule than scorch — visible only while currently
    // in LOS. No seen-dim persistence (would bleed through lesser fog).
    this.bombRenderer?.updatePearlDecalVisibility((x, y) => this.fogRenderer?.isVisible(x, y) ?? false);

    // Path line + staged-action highlight
    this.drawPath();
    this.drawHighlights();
  }

  /**
   * Escape hatch state machine — memory-aware, fog-of-war respecting.
   *
   * The opening/closing animations are triggered exclusively by the local
   * 'escaped' event handler in resolveTurnEvents — never by passive bomberman
   * proximity. This update method only handles the lazy "snap to broken on
   * LOS re-acquire" case: if our local memory still says intact but we just
   * regained LOS on a hatch that is authoritatively broken, swap the texture
   * silently (no animation — we missed the moment of escape).
   *
   * If the tile is currently outside LOS, this method does nothing — the
   * sprite continues to render whatever its last-known state was (intact or
   * broken), which is exactly the fog-of-war memory the spec requires.
   */
  private updateEscapeHatches(): void {
    if (!this.state || !this.fogRenderer) return;
    for (const esc of this.escapeSprites) {
      // Don't interrupt in-flight animations.
      if (esc.state === 'opening' || esc.state === 'closing') continue;
      const visibleNow = this.fogRenderer.isVisible(esc.x, esc.y);
      if (!visibleNow) continue;
      const authBroken = this.state.brokenHatches.some(t => t.x === esc.x && t.y === esc.y);
      if (authBroken && !esc.memoryBroken) {
        // LOS re-acquired after a missed escape: snap to broken, no animation.
        esc.state = 'broken';
        esc.memoryBroken = true;
        esc.sprite.anims.stop();
        esc.sprite.setTexture('escape_hatch_broken', 0);
      }
    }
  }

  /**
   * Reconcile key sprites with per-client fog-of-war memory.
   *
   * For tiles currently in LOS: trust the authoritative state — if a key is
   * there, render it (and remember); if not, hide and remember "gone".
   *
   * For tiles outside LOS: render based on memory only. A key the player
   * once saw stays visible to them until they look back (and either confirm
   * it's still there or notice it was picked up). This matches the spec
   * scenario from docs/keys-system.md §9.
   */
  private updateKeys(): void {
    if (!this.state || !this.mapData || !this.fogRenderer) return;
    const ts = this.mapData.tileSize;
    const fog = this.fogRenderer;

    // Build a quick set of authoritative key positions for fast lookup.
    const authKeys = new Set<string>();
    for (const k of this.state.keys) authKeys.add(`${k.x},${k.y}`);

    // Update memory from current LOS — for each key, if its tile is in LOS,
    // memory says "present"; for tiles in LOS that USED to have a key but
    // no longer do, mark memory as "gone".
    // We iterate the union of authoritative keys + remembered tiles so we
    // catch the "I had it remembered, now I see it's gone" transition.
    const tilesToCheck = new Set<string>();
    for (const key of authKeys) tilesToCheck.add(key);
    for (const key of this.keyMemory.keys()) tilesToCheck.add(key);

    for (const tileKey of tilesToCheck) {
      const [xs, ys] = tileKey.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (fog.isVisible(x, y)) {
        this.keyMemory.set(tileKey, authKeys.has(tileKey));
      }
      // Outside LOS: leave memory untouched.
    }

    // Reconcile sprites: each memory entry with present=true gets a sprite.
    // Entries with present=false get their sprite (if any) destroyed.
    for (const [tileKey, present] of this.keyMemory) {
      const existing = this.keySprites.get(tileKey);
      if (present) {
        if (!existing) {
          const [xs, ys] = tileKey.split(',');
          const x = Number(xs);
          const y = Number(ys);
          const img = this.add.image(x * ts + ts / 2, y * ts + ts / 2, 'key')
            .setDisplaySize(ts, ts)
            .setDepth(15);
          if (this.hudCamera) this.hudCamera.ignore(img);
          this.keySprites.set(tileKey, img);
        }
      } else if (existing) {
        existing.destroy();
        this.keySprites.delete(tileKey);
      }
    }
  }

  /**
   * Sync `chestSprites` to the latest `state.chests`. Creates sprites for
   * newly-added chests and destroys sprites for chests that disappeared.
   * Called both on first map load (during handleMatchState's firstFrame
   * block) and on every subsequent state update so the tutorial's
   * spawnChest mutations render correctly.
   */
  private syncChestSprites(state: MatchState, mapTs: number): void {
    const stateChests = state.chests ?? [];

    // Remove sprites whose chest is no longer in state.
    const liveIds = new Set(stateChests.map(c => c.id));
    for (let i = this.chestSprites.length - 1; i >= 0; i--) {
      if (!liveIds.has(this.chestSprites[i].id)) {
        this.chestSprites[i].sprite.destroy();
        this.chestSprites.splice(i, 1);
      }
    }

    // Add sprites for new chests.
    const existingIds = new Set(this.chestSprites.map(cs => cs.id));
    for (const chest of stateChests) {
      if (existingIds.has(chest.id)) continue;
      const key = `chest_${chest.tier}` as 'chest_1' | 'chest_2' | 'chest_3';
      const sprite = this.add.sprite(
        chest.x * mapTs + mapTs / 2,
        chest.y * mapTs + mapTs,
        key,
      );
      sprite.setDepth(15);
      sprite.setOrigin(0.5, 1);
      const opened = chest.opened;
      sprite.play(opened ? `${key}_open` : `${key}_closed`);
      if (this.hudCamera) this.hudCamera.ignore(sprite);
      this.chestSprites.push({
        id: chest.id, x: chest.x, y: chest.y, tier: chest.tier,
        sprite, state: opened ? 'open' : 'closed',
        permanentlyOpened: opened,
        wasVisible: false,
      });
    }
  }

  /**
   * Spawn a floating "!" over a world-space point. Used by the rush-broken
   * indicator and by the tutorial's scripted enemy-reveal highlight.
   */
  spawnExclamation(worldX: number, worldY: number, color: string = '#ff4444'): void {
    const indicator = this.add.text(worldX, worldY, '!', {
      fontSize: '20px', color, fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(150);
    if (this.hudCamera) this.hudCamera.ignore(indicator);
    const ts = this.mapData?.tileSize ?? 32;
    this.tweens.add({
      targets: indicator,
      y: worldY - ts * 1.5,
      alpha: 0,
      duration: 1200,
      ease: 'Cubic.easeOut',
      onComplete: () => indicator.destroy(),
    });
  }

  /**
   * Chest animation state machine — same proximity pattern as escape hatches.
   * Once a chest is `opened` on the server, it stays permanently open.
   */
  private updateChests(): void {
    if (!this.state) return;
    for (const cs of this.chestSprites) {
      const key = `chest_${cs.tier}` as 'chest_1' | 'chest_2' | 'chest_3';

      // RTS fog: chest only visible if tile is in LOS or was previously discovered
      const entityId = `chest_${cs.id}`;
      const vis = this.fogRenderer?.isVisible(cs.x, cs.y) ?? false;
      if (vis) {
        this.knownEntities.add(entityId);
        cs.sprite.setVisible(true);
      } else if (this.fogRenderer?.isDiscovered(cs.x, cs.y) && this.knownEntities.has(entityId)) {
        cs.sprite.setVisible(true);
        // In seen-dim: snap any in-progress transition to its rest frame so
        // the user doesn't see the tail end of opening/closing animations.
        if (cs.state === 'opening') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        } else if (cs.state === 'closing') {
          cs.state = 'closed';
          cs.sprite.play(`${key}_closed`);
        }
        cs.wasVisible = false;
        continue;
      } else {
        cs.sprite.setVisible(false);
        cs.wasVisible = false;
        continue;
      }

      // Doors rule applied to chests too: if the player is gaining LoS on
      // this tile THIS frame, skip any wind-up animation. The chest just
      // snaps to whatever state matches the world (server-opened or a
      // bomberman currently adjacent). Prevents enemies walking adjacent
      // in the dim from "revealing themselves" via a chest anim the moment
      // the player reveals the tile.
      const justRevealed = !cs.wasVisible;

      // Sync server opened state → permanent
      const serverChest = this.state.chests.find(c => c.id === cs.id);
      if (serverChest?.opened && !cs.permanentlyOpened) {
        cs.permanentlyOpened = true;
        if (cs.state !== 'open' && cs.state !== 'opening') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        }
      }

      // Permanently opened chests skip proximity logic
      if (cs.permanentlyOpened) {
        if (cs.state === 'opening') { cs.wasVisible = vis; continue; }
        if (cs.state !== 'open') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        }
        cs.wasVisible = vis;
        continue;
      }

      // Proximity check: any alive, non-escaped Bomberman within Chebyshev ≤ 1
      const nearby = this.state.bombermen.some(b =>
        b.alive && !b.escaped &&
        Math.max(Math.abs(b.x - cs.x), Math.abs(b.y - cs.y)) <= 1,
      );

      if (nearby && cs.state === 'closed') {
        if (justRevealed) {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        } else {
          cs.state = 'opening';
          cs.sprite.play(`${key}_opening`);
          cs.sprite.once('animationcomplete', () => {
            cs.state = 'open';
            cs.sprite.play(`${key}_open`);
          });
        }
      } else if (!nearby && cs.state === 'open') {
        if (justRevealed) {
          cs.state = 'closed';
          cs.sprite.play(`${key}_closed`);
        } else {
          cs.state = 'closing';
          cs.sprite.play(`${key}_closing`);
          cs.sprite.once('animationcomplete', () => {
            cs.state = 'closed';
            cs.sprite.play(`${key}_closed`);
          });
        }
      }

      cs.wasVisible = vis;
    }
  }

  /**
   * Door animation state machine. Doors open on proximity (Chebyshev ≤ 1 of
   * any door tile) and stay open permanently. Also syncs server opened state.
   */
  private updateDoors(): void {
    if (!this.state) return;
    for (const ds of this.doorSprites) {
      const prefix = ds.orientation === 'horizontal' ? 'h' : 'v';
      const animKey = `door_${prefix}`;

      // RTS fog: door visible if ANY of its tiles are in LOS or previously discovered
      const entityId = `door_${ds.id}`;
      const anyVisible = ds.tiles.some(t => this.fogRenderer?.isVisible(t.x, t.y));
      if (anyVisible) {
        this.knownEntities.add(entityId);
        ds.sprite.setVisible(true);
      } else {
        const anyDiscovered = ds.tiles.some(t => this.fogRenderer?.isDiscovered(t.x, t.y));
        if (anyDiscovered && this.knownEntities.has(entityId)) {
          ds.sprite.setVisible(true);
          // In seen-dim: snap any in-progress opening animation to its final
          // rest frame. Phaser keeps playing frame-by-frame once play() is
          // called, so a door mid-open when the player walks away would keep
          // animating visibly through the dim fog without this.
          if (ds.state === 'opening') {
            ds.state = 'open';
            ds.sprite.play(`${animKey}_open`);
          }
          continue;
        }
        ds.sprite.setVisible(false);
        continue;
      }

      // Sync server state
      const serverDoor = this.state.doors?.find(d => d.id === ds.id);
      if (serverDoor?.opened && !ds.opened) {
        ds.opened = true;
      }

      // Server is authoritative: `ds.opened` is synced from the server's
      // `door.opened` flag above. If the door is open, stick on the open
      // frame; otherwise it stays closed. The opening animation is driven
      // from the `door_opened` event handler in onTurnResult (Beat 3), so
      // we don't fire animations from here — previous client-side proximity
      // rule was removed when the resolver became the single source of
      // truth for door-open conditions.
      if (ds.opened && ds.state !== 'open' && ds.state !== 'opening') {
        ds.state = 'open';
        ds.sprite.play(`${animKey}_open`);
      }
    }
  }

  private drawPath(): void {
    this.pathGraphics.clear();
    if (this.inputMode.kind !== 'pathing' || !this.mapData) return;
    const me = this.myBomberman();
    if (!me) return;
    const ts = this.mapData.tileSize;

    const points: Phaser.Math.Vector2[] = [];
    points.push(new Phaser.Math.Vector2(me.x * ts + ts / 2, me.y * ts + ts / 2));
    for (const p of this.inputMode.path) {
      points.push(new Phaser.Math.Vector2(p.x * ts + ts / 2, p.y * ts + ts / 2));
    }

    // Thin path line
    this.pathGraphics.lineStyle(1.5, 0x44aaff, 0.5);
    this.pathGraphics.beginPath();
    this.pathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.pathGraphics.lineTo(points[i].x, points[i].y);
    this.pathGraphics.strokePath();

    // Waypoint markers — appearance depends on match phase:
    //   Input phase: ALL points are changeable (hollow cyan) — player can still re-click
    //   Resolution phase: first point is LOCKED (solid yellow + ring), rest are queued (cyan)
    const isResolution = this.state?.phase === 'transition';
    for (let i = 0; i < this.inputMode.path.length; i++) {
      const p = this.inputMode.path[i];
      const cx = p.x * ts + ts / 2;
      const cy = p.y * ts + ts / 2;
      if (i === 0 && isResolution) {
        // Locked — solid yellow dot with ring (can't change during resolution)
        this.pathGraphics.fillStyle(0xffcc44, 0.95);
        this.pathGraphics.fillCircle(cx, cy, 3);
        this.pathGraphics.lineStyle(1.5, 0xffcc44, 0.6);
        this.pathGraphics.strokeCircle(cx, cy, 6);
      } else {
        // Changeable (input phase) or queued future step — hollow cyan
        this.pathGraphics.lineStyle(1, 0x44aaff, 0.4);
        this.pathGraphics.strokeCircle(cx, cy, 3);
      }
    }
  }

  private drawHighlights(): void {
    this.highlightGraphics.clear();
    if (!this.mapData) return;
    const ts = this.mapData.tileSize;

    // Committed throw target (aim mode) — rendered while the action is
    // queued and during the transition phase.
    if (this.inputMode.kind === 'aim' && this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
      this.highlightGraphics.lineStyle(3, 0xff4444, 1);
      this.highlightGraphics.strokeRect(
        this.inputMode.targetX * ts + 2,
        this.inputMode.targetY * ts + 2,
        ts - 4, ts - 4,
      );
      return;
    }

    // Hover preview — while a bomb slot is armed and no aim is committed
    // yet, show a red reticle on the tile under the cursor so the player
    // can see where their throw will land before they click.
    if (this.selectedSlot !== null
        && this.hoveredTileX !== null && this.hoveredTileY !== null) {
      this.highlightGraphics.lineStyle(3, 0xff4444, 0.85);
      this.highlightGraphics.strokeRect(
        this.hoveredTileX * ts + 2,
        this.hoveredTileY * ts + 2,
        ts - 4, ts - 4,
      );
    }
  }

  private onClick(pointer: Phaser.Input.Pointer): void {
    if (!this.state) return;
    if (!this.mapData) return;

    // Dead players can't interact with anything
    const me = this.myBomberman();
    if (!me || !me.alive) return;
    // Stun gate: ignore clicks while stunned — the server would reject them
    // anyway. HUD renders a lock icon to make the state visible.
    if ((me.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)) return;


    // Loot panel intercepts first (it sits above the bomb tray).
    const lootSlot = this.hitTestLootPanel(pointer.x, pointer.y);
    if (lootSlot >= 0) {
      this.onLootSlotClicked(lootSlot);
      return;
    }

    // HUD bomb slots
    const hudSlot = this.hitTestHud(pointer.x, pointer.y);
    if (hudSlot >= 0) {
      this.onSlotClicked(hudSlot);
      return;
    }

    // World-space tile click
    const ts = this.mapData.tileSize;
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const tx = Math.floor(worldPoint.x / ts);
    const ty = Math.floor(worldPoint.y / ts);

    if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) return;
    if (me.escaped) return;

    // Tutorial: when a walk-target highlight is posted (circle on a specific
    // tile), only clicks on that tile or on self are honored — every other
    // tile is ignored. This stops dialogue-dismiss clicks and stray map
    // clicks from BFS-walking the player off the scripted path, and lets a
    // single click on the highlighted tile both dismiss the active dialogue
    // and fire the real gameplay action (e.g. wait-one-turn on the escape
    // hatch). When no walk target is posted we fall back to the general
    // "block gameplay clicks while a dialogue/pause is up" rule so those
    // beats still can't leak phantom actions.
    if (this.mode === 'tutorial') {
      const overlay = this.scene.get('TutorialOverlayScene') as TutorialOverlayScene | undefined;
      const walkTarget = overlay?.getActiveWalkTargetTile?.(ts) ?? null;
      const isSelf = tx === me.x && ty === me.y;
      if (walkTarget) {
        const onTarget = tx === walkTarget.x && ty === walkTarget.y;
        if (!onTarget && !isSelf) return;
      } else if (overlay?.isBlockingInput?.()) {
        return;
      }
    }

    // Click on self = cancel any staged action (armed slot stays)
    if (tx === me.x && ty === me.y) {
      this.inputMode = { kind: 'idle' };
      this.flushStagedAction();
      this.rebuildEntities();
      this.renderHud();
      return;
    }

    // Armed slot: click = throw at this tile (stops movement, goes idle after)
    if (this.selectedSlot !== null) {
      const slotIdx = this.selectedSlot;
      const selectedType: BombType = slotIdx === 0 ? 'rock'
        : (me.inventory.slots[slotIdx - 1]?.type ?? 'rock');
      const isFlare = selectedType === 'flare';
      const tileIsWall = this.mapData.grid[ty]?.[tx] !== 0;
      const tileUnseen = this.fogRenderer?.isUnseen(tx, ty) ?? false;

      // If the target is a known wall (discovered + blocked), only flares
      // can be thrown there. Unseen tiles always allow throws (player can't
      // see whether it's a wall — the bomb just fizzles server-side).
      if (tileIsWall && !tileUnseen && !isFlare) {
        console.log(`[click] can't throw ${selectedType} at revealed wall (${tx},${ty})`);
        return;
      }

      // Stage the throw via aim mode (flushStagedAction handles sending +
      // the input-phase gate so throws queued during transition are deferred).
      this.inputMode = {
        kind: 'aim',
        slotIndex: slotIdx,
        targetX: tx,
        targetY: ty,
      };
      this.selectedSlot = null;
      this.flushStagedAction();
      this.rebuildEntities();
      this.renderHud();
      return;
    }

    // Otherwise: compute BFS path and stage the first move
    const path = findPath(me.x, me.y, tx, ty, this.mapData);
    if (path.length === 0) {
      console.log(`[click] no path to (${tx},${ty})`);
      return;
    }
    this.inputMode = { kind: 'pathing', path };
    this.flushStagedAction();
    this.rebuildEntities();
  }

  private sendAction(action: { kind: 'idle' } | { kind: 'move'; x: number; y: number; rushX?: number; rushY?: number } | { kind: 'throw'; slotIndex: number; x: number; y: number }): void {
    this.backend?.sendAction(action);
  }

  /** Exposed to TutorialOverlayScene so its camera pans can target the world camera. */
  getMainCamera(): Phaser.Cameras.Scene2D.Camera {
    return this.cameras.main;
  }

  /** Exposed to the tutorial: freeze or unfreeze the follow-player camera.
   *  While locked, `update()` skips centerOn, so scripted panCamera targets
   *  stay put instead of snapping back to the player on the next frame. */
  setTutorialCameraLocked(locked: boolean): void {
    this.cameraTutorialLocked = locked;
  }

  // ============================================================
  // Tooltip
  // ============================================================

  private getTooltipScene(): TooltipScene | null {
    const sc = this.scene.get('TooltipScene') as TooltipScene | null;
    return sc && this.scene.isActive('TooltipScene') ? sc : null;
  }

  /**
   * Recompute the hover-tooltip key from the current pointer screen position
   * and dispatch to TooltipScene. Cheap to call every pointermove — the
   * scene does its own debouncing.
   */
  private refreshTooltip(screenX: number, screenY: number): void {
    const tip = this.getTooltipScene();
    if (!tip) return;
    tip.setKey(this.computeTooltipKey(screenX, screenY));
  }

  /**
   * Inspect HUD rects and the hovered world tile and decide which tooltip
   * (if any) to show. Returns null when nothing meaningful is under the cursor.
   */
  private computeTooltipKey(screenX: number, screenY: number): TooltipKey | null {
    const me = this.myBomberman();
    const W = this.scale.width;

    // ---- HUD hit tests (top bar + bomb tray) ----
    if (screenY >= 0 && screenY <= 48) {
      // phase indicator + timer (left)
      if (screenX >= 12 && screenX <= 290) return { kind: 'turnsTicks' };
      // turn counter (centered around W/2)
      if (Math.abs(screenX - W / 2) <= 100) return { kind: 'turnLimit' };
      // hp (shifted left to make room for coins+treasures column)
      if (screenX >= W - 300 && screenX <= W - 200) return { kind: 'hp' };
      // treasure list + coin row (top-right column)
      if (screenX >= W - 130 && screenX <= W - 5) return { kind: 'treasureList' };
    }

    const hudSlot = this.hitTestHud(screenX, screenY);
    if (hudSlot >= 0) {
      if (hudSlot === 0) return { kind: 'bombSlot', bombType: 'rock' };
      const slot = me?.inventory.slots[hudSlot - 1];
      if (!slot) return null; // empty slot — no tooltip
      return { kind: 'bombSlot', bombType: slot.type };
    }

    // Loot panel item (when standing on a chest/body)
    const lootIdx = this.hitTestLootPanel(screenX, screenY);
    if (lootIdx >= 0 && me) {
      const lootType = this.lootSlotBombType(me, lootIdx);
      if (lootType) return { kind: 'lootBomb', bombType: lootType };
    }

    // ---- World tile ----
    if (!this.mapData || !this.state) return null;
    const ts = this.mapData.tileSize;
    const wp = this.cameras.main.getWorldPoint(screenX, screenY);
    const tx = Math.floor(wp.x / ts);
    const ty = Math.floor(wp.y / ts);
    if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) return null;

    // If a bomb slot is armed (selectedSlot) and we're hovering a tile,
    // produce a contextual targeting tooltip rather than the world-tile one.
    if (this.selectedSlot !== null) {
      const bt: BombType = this.selectedSlot === 0
        ? 'rock'
        : (me?.inventory.slots[this.selectedSlot - 1]?.type ?? 'rock');
      switch (bt) {
        case 'ender_pearl': return { kind: 'targetTeleport' };
        case 'fart_escape': return { kind: 'targetSmoke' };
        case 'flare':       return { kind: 'targetFlare' };
        default:            return { kind: 'targetThrow', bombType: bt };
      }
    }

    // Fog: if the tile is entirely undiscovered, suggest exploring.
    const fog = this.fogRenderer;
    if (fog && !fog.isVisible(tx, ty) && !fog.isDiscovered(tx, ty)) {
      return { kind: 'tileFog' };
    }

    // Floor key — checked before fog gates so hovering over a key in LOS
    // (or one remembered from a prior visit) shows the right hint.
    if (this.keyMemory.get(`${tx},${ty}`) === true) {
      return { kind: 'tileKey' };
    }

    // Escape hatch — broken hatches use a separate key so the tooltip
    // reflects the "single-use" state with a darker icon and warning text.
    // We honor the per-client memory (escapeSprites[].memoryBroken) rather
    // than the authoritative state, so a player who never observed the
    // escape still sees the intact tooltip until they regain LOS.
    for (const e of this.mapData.escapeTiles) {
      if (e.x === tx && e.y === ty) {
        const spr = this.escapeSprites.find(s => s.x === tx && s.y === ty);
        const broken = !!spr?.memoryBroken;
        if (broken) return { kind: 'tileHatchBroken' };
        const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
        const held = me?.keys ?? 0;
        return { kind: 'tileHatch', held, required: BALANCE.keys.requiredPerHatch };
      }
    }
    // Chest
    for (const c of this.state.chests) {
      if (c.x === tx && c.y === ty) return { kind: 'tileChest' };
    }
    // Body
    for (const b of this.state.bodies) {
      if (b.x === tx && b.y === ty) return { kind: 'tileBody' };
    }
    // Door
    for (const d of this.state.doors) {
      for (const t of d.tiles) {
        if (t.x === tx && t.y === ty) return { kind: 'tileDoor' };
      }
    }

    const tile = this.mapData.grid[ty]?.[tx];
    const walkable = tile === 0; // TileType.FLOOR
    if (!walkable) return { kind: 'tileObstacle' };

    // Decals: count which kinds of marks are on this floor tile.
    const key = `${tx},${ty}`;
    const hasBlood = this.bloodDecals.has(key);
    const hasExplosion = this.bombRenderer?.scorchKeys.has(key) ?? false;
    const hasPearl = this.bombRenderer?.pearlKeys.has(key) ?? false;
    const decalCount = (hasBlood ? 1 : 0) + (hasExplosion ? 1 : 0) + (hasPearl ? 1 : 0);
    if (decalCount >= 2) return { kind: 'tileWalkableMess' };
    if (hasPearl)        return { kind: 'tileWalkablePearl' };
    if (hasBlood)        return { kind: 'tileWalkableBlood' };
    if (hasExplosion)    return { kind: 'tileWalkableExplosion' };
    return { kind: 'tileWalkable' };
  }

  /**
   * Resolve a symbolic HighlightTarget into a screen-space rect. Called by
   * the overlay every frame while a highlight is active — keep the math
   * tight and don't allocate.
   *
   * Approximate rects for Phase 4 — exact positions are tuned in Phase 12
   * by reading the actual HUD widget bounds (hudObjects[]).
   */
  getHudRect(target: { kind: string; index?: number; bombType?: BombType }): { x: number; y: number; w: number; h: number; space: 'hud' } | null {
    const W = this.scale.width;
    const H = this.scale.height;
    switch (target.kind) {
      case 'phaseIndicator':
        return { x: 12, y: 12, w: 150, h: 28, space: 'hud' };
      case 'timer':
        return { x: 170, y: 12, w: 120, h: 28, space: 'hud' };
      case 'hp':
        return { x: W - 300, y: 12, w: 100, h: 28, space: 'hud' };
      case 'treasureList': {
        const r = this.treasureList?.getRect();
        if (r && r.h > 0) return { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, space: 'hud' };
        // Empty list: highlight the anchor area so the tutorial dialogue
        // still has somewhere to point at on first encounter. Includes the
        // coin row that sits above the treasure list.
        return { x: W - 130, y: 8, w: 125, h: 60, space: 'hud' };
      }
      case 'bombTray': {
        // 5 slots of SLOT_SIZE (64) + 4 gaps of SLOT_GAP (8), bottom-centered.
        const totalW = this.localTotalSlotCount() * SLOT_SIZE + (this.localTotalSlotCount() - 1) * SLOT_GAP;
        return { x: (W - totalW) / 2, y: H - SLOT_SIZE - 16, w: totalW, h: SLOT_SIZE, space: 'hud' };
      }
      case 'slot': {
        const i = target.index ?? 0;
        const totalW = this.localTotalSlotCount() * SLOT_SIZE + (this.localTotalSlotCount() - 1) * SLOT_GAP;
        const trayX = (W - totalW) / 2;
        return {
          x: trayX + i * (SLOT_SIZE + SLOT_GAP),
          y: H - SLOT_SIZE - 16,
          w: SLOT_SIZE,
          h: SLOT_SIZE,
          space: 'hud',
        };
      }
      case 'lootPanel':
        // Approximate — real position is centered above the tray.
        return { x: (W - 320) / 2, y: H - SLOT_SIZE - 140, w: 320, h: 110, space: 'hud' };
      case 'lootItem':
        return target.bombType ? this.getLootItemRect(target.bombType) : null;
      default:
        return null;
    }
  }

  /**
   * Rect of the specific loot-panel icon for the given bomb type, or null
   * if the loot panel isn't visible or the type isn't shown. Used by the
   * tutorial to highlight a single item (e.g. "click the Flare") instead
   * of the whole panel.
   */
  private getLootItemRect(bombType: BombType): { x: number; y: number; w: number; h: number; space: 'hud' } | null {
    if (!this.lootPanelVisible || !this.state) return null;
    const me = this.myBomberman();
    if (!me) return null;

    // Rebuild the same flattened order used by renderLootPanel so indices
    // line up with the visible icons.
    const lootSlots: Array<{ type: BombType }> = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        for (const b of c.bombs) {
          lootSlots.push({ type: b.type });
          if (lootSlots.length >= this.localCustomSlotCount()) break;
        }
      }
      if (lootSlots.length >= this.localCustomSlotCount()) break;
    }
    if (lootSlots.length < this.localCustomSlotCount()) {
      for (const b of this.state.bodies) {
        if (b.x === me.x && b.y === me.y) {
          for (const bb of b.bombs) {
            lootSlots.push({ type: bb.type });
            if (lootSlots.length >= this.localCustomSlotCount()) break;
          }
        }
        if (lootSlots.length >= this.localCustomSlotCount()) break;
      }
    }

    const idx = lootSlots.findIndex(s => s.type === bombType);
    if (idx < 0) return null;

    const W = this.scale.width;
    const panelWidth = this.localTotalSlotCount() * SLOT_SIZE + (this.localTotalSlotCount() - 1) * SLOT_GAP + 20;
    const panelX = (W - panelWidth) / 2;
    const slotStartX = panelX + 10;
    return {
      x: slotStartX + idx * (SLOT_SIZE + SLOT_GAP),
      y: this.lootPanelY + 30,
      w: SLOT_SIZE,
      h: 50,
      space: 'hud',
    };
  }

  /**
   * Constructs the TutorialMatchBackend. Kept as a method so `create()` stays
   * clean. Called only when `mode === 'tutorial'`.
   */
  private buildTutorialBackend(): MatchBackend {
    return new TutorialMatchBackend();
  }

  // --- HUD (rendered on a separate camera that never zooms/scrolls) ---

  private hudTrayX = 0;
  private hudTrayY = 0;
  private hudTrayBg: Phaser.GameObjects.Graphics | null = null;
  /** Slot count we last built the tray for. When the local Bomberman's
   *  `maxCustomSlots` arrives or changes (re-equip mid-scene, late state
   *  arrival), we rebuild the tray to match. */
  private lastBuiltSlotCount = -1;
  private hudObjects: Phaser.GameObjects.GameObject[] = [];

  /** Tag an object as HUD-only: visible on hudCamera, hidden from main cam. */
  private hud<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    if (this.hudCamera) {
      this.cameras.main.ignore(obj);
    }
    this.hudObjects.push(obj);
    return obj;
  }

  private buildHud(): void {
    const { width, height } = this.scale;

    // Top bar
    const topBg = this.add.graphics().setDepth(1000);
    topBg.fillStyle(0x0a0a14, 0.85);
    topBg.fillRect(0, 0, width, 48);
    this.hud(topBg);

    this.phaseText = this.hud(this.add.text(20, 14, 'Phase', {
      fontSize: '16px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(1001));

    this.timerText = this.hud(this.add.text(180, 14, '0.0s', {
      fontSize: '18px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(1001));

    this.turnText = this.hud(this.add.text(width / 2, 14, 'Turn 0 / 50', {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0.5, 0).setDepth(1001));

    // Broken-hatch warning, anchored just to the right of the turn counter.
    // Visible only while the local bomberman is standing on a broken hatch.
    this.brokenHatchText = this.hud(this.add.text(width / 2 + 90, 16, 'This Hatch is Broken, you won’t be able to Escape from it', {
      fontSize: '11px', color: '#ff4040', fontFamily: 'monospace',
    }).setOrigin(0, 0).setDepth(1001).setVisible(false));

    // UAV indicator — sits just below the turn counter at the top-center.
    // Throbs when the next UAV is <=3 turns away; hidden in tutorial matches.
    this.uavText = this.hud(this.add.text(width / 2, 30, '', {
      fontSize: '13px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(1001).setVisible(false));

    // HP / Keys are pushed leftward (NEW_META: top-right reserves space for
    // the coin row + treasure list column).
    this.hpText = this.hud(this.add.text(width - 290, 14, 'HP --', {
      fontSize: '16px', color: '#ff6666', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(1001));

    // Coin row (NEW_META §2) — pinned at the top of the top-right column,
    // always visible regardless of amount. Drawn as a graphics circle to
    // mirror the tooltip 'coin' shape (no extra texture asset needed).
    const COIN_ICON_SIZE = 28;
    const COIN_ROW_Y = 14;
    const coinIcon = this.add.graphics().setDepth(1001);
    {
      const r = COIN_ICON_SIZE / 2;
      const cx = -r;
      const cy = r;
      coinIcon.fillStyle(0xffd944, 1);
      coinIcon.fillCircle(cx, cy, r);
      coinIcon.fillStyle(0xc09020, 1);
      coinIcon.fillCircle(cx, cy, r * 0.7);
      coinIcon.fillStyle(0xffd944, 1);
      coinIcon.fillRect(cx - r * 0.1, cy - r * 0.45, r * 0.2, r * 0.9);
      coinIcon.setPosition(width - 20, COIN_ROW_Y);
    }
    this.coinHudIcon = this.hud(coinIcon);
    this.coinHudText = this.hud(this.add.text(
      width - 20 - COIN_ICON_SIZE - 6,
      COIN_ROW_Y + COIN_ICON_SIZE / 2,
      'x0',
      {
        fontSize: '16px',
        color: '#ffd944',
        fontFamily: 'monospace',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3,
      },
    ).setOrigin(1, 0.5).setDepth(1001));

    // Treasure list — vertical, top-right, fills as the player picks up
    // treasures during the match. Anchored below the coin row.
    this.treasureList = new TreasureListWidget(this, {
      x: width - 20,
      y: COIN_ROW_Y + COIN_ICON_SIZE + 6,
      anchor: 'top-right',
      iconScale: 1.0,
      fontSize: 16,
      depth: 1001,
      pulseOnCount: true,
    });

    // Keys counter — small icon + "N/3" text, sits just left of the
    // coin row + TreasureListWidget column. Its own column, per docs/keys-system.md §9.
    const KEY_ICON = 22;
    this.keysHudIcon = this.hud(this.add.image(width - 160, 14 + KEY_ICON / 2, 'key')
      .setOrigin(0.5, 0.5)
      .setDisplaySize(KEY_ICON, KEY_ICON)
      .setDepth(1001));
    this.keysHudText = this.hud(this.add.text(width - 146, 14 + KEY_ICON / 2, `0/${BALANCE.keys.requiredPerHatch}`, {
      fontSize: '14px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0, 0.5).setDepth(1001));

    // Slot tray is built lazily — at this point the local Bomberman state
    // hasn't arrived yet so we don't know `maxCustomSlots`. `renderHud`
    // calls `rebuildSlotTrayIfNeeded()` once state is in.

    // Exit Tutorial button — only visible in tutorial mode. Matches the
    // monospace "[ < BACK ]" style used as the back button on other scenes.
    if (this.mode === 'tutorial') {
      const exitBtn = this.add.text(20, height - 30, '[ EXIT TUTORIAL ]', {
        fontSize: '16px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0, 0.5).setDepth(1001).setInteractive({ useHandCursor: true });
      exitBtn.on('pointerover', () => exitBtn.setColor('#cccccc'));
      exitBtn.on('pointerout', () => exitBtn.setColor('#888888'));
      exitBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));
      this.hud(exitBtn);
    }
  }

  /**
   * Build (or rebuild) the bomb slot tray to match the local Bomberman's
   * `maxCustomSlots`. Idempotent — only does work when the count changes.
   * The tray BG, stun overlay, melee icon, and all per-slot rects/icons/
   * labels are recreated together because they're all sized off the count.
   */
  private rebuildSlotTrayIfNeeded(): void {
    const count = this.localTotalSlotCount();
    if (count === this.lastBuiltSlotCount) return;

    // Tear down any prior tray bits.
    this.hudTrayBg?.destroy();
    this.hudTrayBg = null;
    this.stunHudOverlay?.destroy();
    this.stunHudOverlay = null;
    this.stunHudLabel?.destroy();
    this.stunHudLabel = null;
    this.meleeHudIcon?.destroy();
    this.meleeHudIcon = null;
    for (const r of this.slotRects) r.destroy();
    for (const t of this.slotLabelTexts) t.destroy();
    for (const i of this.slotIcons) i.destroy();
    for (const t of this.slotCountTexts) t.destroy();
    for (const g of this.slotHighlights) g.destroy();
    this.slotRects = [];
    this.slotLabelTexts = [];
    this.slotIcons = [];
    this.slotCountTexts = [];
    this.slotHighlights = [];

    const { width, height } = this.scale;
    const trayWidth = count * SLOT_SIZE + (count - 1) * SLOT_GAP;
    const trayX = (width - trayWidth) / 2;
    const trayY = height - SLOT_SIZE - 16;
    this.hudTrayX = trayX;
    this.hudTrayY = trayY;

    const trayBg = this.add.graphics().setDepth(1000);
    trayBg.fillStyle(0x0a0a14, 0.85);
    trayBg.fillRoundedRect(trayX - 10, trayY - 10, trayWidth + 20, SLOT_SIZE + 20, 6);
    this.hudTrayBg = this.hud(trayBg);

    // Stun HUD overlay — drawn on top of the tray + all slots, hidden by
    // default. renderHud toggles visibility based on the local bomberman's
    // status effects. Depth > slot depths (1001–1003) so it fully obscures
    // interactive elements behind it.
    const stunOverlay = this.add.graphics().setDepth(1050).setVisible(false);
    stunOverlay.fillStyle(0x223355, 0.7);
    stunOverlay.fillRoundedRect(trayX - 10, trayY - 10, trayWidth + 20, SLOT_SIZE + 20, 6);
    stunOverlay.lineStyle(3, 0x88ccff, 0.9);
    stunOverlay.strokeRoundedRect(trayX - 10, trayY - 10, trayWidth + 20, SLOT_SIZE + 20, 6);
    this.stunHudOverlay = this.hud(stunOverlay);

    const stunLabel = this.add.text(
      trayX + trayWidth / 2, trayY + SLOT_SIZE / 2,
      'STUNNED',
      {
        fontSize: '24px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
        stroke: '#000022', strokeThickness: 5,
      },
    ).setOrigin(0.5).setDepth(1051).setVisible(false);
    this.stunHudLabel = this.hud(stunLabel);

    // Melee Trap Mode indicator — small sword icon to the left of the tray.
    const meleeIcon = this.add.image(
      trayX - 18, trayY + SLOT_SIZE / 2, 'sword_icon',
    ).setOrigin(1, 0.5).setDepth(1002).setVisible(false).setDisplaySize(32, 32);
    this.meleeHudIcon = this.hud(meleeIcon);

    for (let i = 0; i < count; i++) {
      const sx = trayX + i * (SLOT_SIZE + SLOT_GAP);

      const rect = this.add.rectangle(sx, trayY, SLOT_SIZE, SLOT_SIZE, 0x1a1a2e, 1)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x444466)
        .setDepth(1001);
      this.slotRects.push(this.hud(rect));

      // Keyboard shortcut key badge — white bg, black text, bottom-left
      const label = this.add.text(sx + 4, trayY + SLOT_SIZE - 4, `${i + 1}`, {
        fontSize: '12px', color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#ffffff', padding: { x: 3, y: 1 },
      }).setOrigin(0, 1).setDepth(1003);
      this.slotLabelTexts.push(this.hud(label));

      // Bomb icon image centered in the slot
      const icon = this.add.image(sx + SLOT_SIZE / 2, trayY + SLOT_SIZE / 2, 'bomb_icons', 0)
        .setDisplaySize(SLOT_SIZE - 16, SLOT_SIZE - 16)
        .setDepth(1001)
        .setVisible(false);
      this.slotIcons.push(this.hud(icon));

      const countTxt = this.add.text(sx + SLOT_SIZE / 2, trayY + SLOT_SIZE - 4, '', {
        fontSize: '14px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 1).setDepth(1002);
      this.slotCountTexts.push(this.hud(countTxt));

      const highlight = this.add.graphics().setDepth(1003);
      this.slotHighlights.push(this.hud(highlight));
    }

    this.lastBuiltSlotCount = count;
  }

  /** Returns slot index [0..4] if (x,y) is on a bomb slot, -1 otherwise. */
  private hitTestHud(screenX: number, screenY: number): number {
    if (screenY < this.hudTrayY || screenY > this.hudTrayY + SLOT_SIZE) return -1;
    const rel = screenX - this.hudTrayX;
    if (rel < 0) return -1;
    const stride = SLOT_SIZE + SLOT_GAP;
    const idx = Math.floor(rel / stride);
    if (idx < 0 || idx >= this.localTotalSlotCount()) return -1;
    const offset = rel - idx * stride;
    if (offset > SLOT_SIZE) return -1; // in the gap between slots
    return idx;
  }

  private renderHud(): void {
    if (!this.state) return;
    const me = this.myBomberman();
    // Build (or rebuild) the slot tray now that we know the local Bomberman's
    // `maxCustomSlots`. Idempotent — only does work on count change.
    this.rebuildSlotTrayIfNeeded();

    const phaseLabel = this.state.phase === 'input' ? 'YOUR TURN'
      : this.state.phase === 'transition' ? 'RESOLVING...'
      : 'MATCH OVER';
    this.phaseText.setText(phaseLabel);
    this.phaseText.setColor(this.state.phase === 'input' ? '#44ff88'
      : this.state.phase === 'transition' ? '#ffcc44' : '#ff4444');

    const turnsLeft = BALANCE.match.turnLimit - this.state.turnNumber;
    this.turnText.setText(`Turn ${this.state.turnNumber} / ${BALANCE.match.turnLimit}`);
    this.turnText.setColor(turnsLeft <= BALANCE.match.turnsLeftWarning ? '#ff6644' : '#aaaaaa');

    // Hatch warning text: broken (precedence) or needs-keys. Visible only
    // while the local player is alive, not escaped, and standing on a
    // hatch tile.
    const meForHatch = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    const aliveLocal = !!meForHatch && meForHatch.alive && !meForHatch.escaped;
    const onHatch = aliveLocal &&
      this.state.escapeTiles.some(t => t.x === meForHatch.x && t.y === meForHatch.y);
    const onBroken = onHatch &&
      this.state.brokenHatches.some(t => t.x === meForHatch.x && t.y === meForHatch.y);
    const cap = BALANCE.keys.requiredPerHatch;
    const heldKeys = meForHatch?.keys ?? 0;
    const onShortHatch = onHatch && !onBroken && heldKeys < cap;

    if (this.brokenHatchText) {
      if (onBroken) {
        this.brokenHatchText.setText('This Hatch is Broken, you won’t be able to Escape from it');
        this.brokenHatchText.setVisible(true);
      } else if (onShortHatch) {
        this.brokenHatchText.setText(`Keys ${heldKeys}/${cap} — loot chests for more`);
        this.brokenHatchText.setVisible(true);
      } else {
        this.brokenHatchText.setVisible(false);
      }
    }

    // Lock badges — show on hatches the local bomberman is on or
    // Chebyshev-adjacent to, when keys < cap and that hatch is not broken.
    for (const badge of this.lockBadges) {
      const broken = this.state.brokenHatches.some(t => t.x === badge.x && t.y === badge.y);
      const near = aliveLocal &&
        Math.max(Math.abs(meForHatch.x - badge.x), Math.abs(meForHatch.y - badge.y)) <= 1;
      const show = near && !broken && heldKeys < cap;
      badge.container.setVisible(show);
      if (show) badge.text.setText(`${heldKeys}/${cap}`);
    }

    // Keys counter: count text, color, and pulse. Three states:
    //   - on a short hatch  → red + pulse (you need keys NOW)
    //   - at cap            → green steady (you can escape)
    //   - otherwise         → default yellow
    if (this.keysHudText && this.keysHudIcon) {
      this.keysHudText.setText(`${heldKeys}/${cap}`);
      const atCap = heldKeys >= cap;
      if (onShortHatch) {
        this.keysHudText.setColor('#ff5555');
        this.keysHudIcon.setTint(0xff8888);
        if (!this.keyHudPulseTween) {
          this.keyHudPulseTween = this.tweens.add({
            targets: [this.keysHudIcon, this.keysHudText],
            scale: 1.25,
            duration: 380,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          });
        }
      } else {
        if (this.keyHudPulseTween) {
          this.keyHudPulseTween.stop();
          this.keyHudPulseTween.remove();
          this.keyHudPulseTween = null;
          this.keysHudIcon.setScale(1);
          this.keysHudText.setScale(1);
        }
        if (atCap) {
          this.keysHudText.setColor('#44ff88');
          this.keysHudIcon.setTint(0x88ff88);
        } else {
          this.keysHudText.setColor('#ffd944');
          this.keysHudIcon.clearTint();
        }
      }
    }

    // UAV countdown + throb starting 3 turns out. Hidden in tutorial matches
    // and whenever no UAV is scheduled.
    const nextFire = this.state.uavNextFireTurn;
    if (this.state.isTutorial || nextFire === undefined) {
      this.uavText?.setVisible(false);
      this.stopUavPulse();
    } else {
      const turnsUntil = nextFire - this.state.turnNumber;
      this.uavText?.setText(`✈ UAV: ${nextFire}`);
      this.uavText?.setVisible(true);
      if (turnsUntil <= 3 && turnsUntil > 0) this.startUavPulse();
      else this.stopUavPulse();
    }

    if (me && me.alive) {
      // Use the sprite system's *displayed* HP so the number tracks the
      // pip bar's delayed post-animation update instead of dropping
      // instantly at the start of the transition.
      const displayedHp = this.bombermanSpriteSystem?.getDisplayedHp(me.playerId) ?? me.hp;
      this.hpText.setText(`HP ${displayedHp}/${BALANCE.match.bombermanMaxHp}`);
      this.hpText.setColor('#ff6666');
      this.treasureList.setBundle(me.treasures);
      if (this.coinHudText) this.coinHudText.setText(`x${me.coins ?? 0}`);
      this.renderBombSlots(me);
      this.renderLootPanel(me);
    } else {
      this.hpText.setText('DEAD');
      this.hpText.setColor('#666');
      this.hideLootPanel();
    }

    // Stun HUD lock: grayed overlay + STUNNED banner over the bomb tray
    // when the local bomberman has an active stunned status effect.
    const stunned = !!me && me.alive && (me.statusEffects ?? []).some(
      s => s.kind === 'stunned' && s.turnsRemaining > 0,
    );
    this.stunHudOverlay?.setVisible(stunned);
    this.stunHudLabel?.setVisible(stunned);

    // Melee Trap Mode HUD sword icon: shown to the left of the tray
    // while the local bomberman is trapped and crouching.
    const meleeTrap = !!me && me.alive && !!me.meleeTrapMode;
    this.meleeHudIcon?.setVisible(meleeTrap);
  }

  private startUavPulse(): void {
    if (this.uavPulseTween || !this.uavText) return;
    this.uavPulseTween = this.tweens.add({
      targets: this.uavText,
      scale: 1.2,
      duration: 350,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private stopUavPulse(): void {
    if (!this.uavPulseTween) return;
    this.uavPulseTween.stop();
    this.uavPulseTween.remove();
    this.uavPulseTween = null;
    this.uavText?.setScale(1);
  }

  private showUavBanner(): void {
    if (this.uavBannerText) { this.uavBannerText.destroy(); this.uavBannerText = null; }
    this.uavBannerTimer?.remove();
    const { width, height } = this.scale;
    this.uavBannerText = this.hud(this.add.text(width / 2, height / 2 - 60,
      'UAV is Revealing the whole area',
      {
        fontSize: '24px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
        stroke: '#000022', strokeThickness: 5,
      }).setOrigin(0.5).setDepth(10000));
    this.uavBannerTimer = this.time.delayedCall(3000, () => {
      this.uavBannerText?.destroy();
      this.uavBannerText = null;
    });
  }

  private renderBombSlots(me: BombermanState): void {
    // Slot layout: 0 = Rock (infinite), 1..maxCustomSlots = custom inventory[0..N-1]
    for (let i = 0; i < this.localTotalSlotCount(); i++) {
      let sub = '';
      let bombType: import('@shared/types/bombs.ts').BombType | null = null;

      if (i === 0) {
        bombType = 'rock';
        sub = '∞';
      } else {
        const slot = me.inventory.slots[i - 1];
        if (slot) {
          bombType = slot.type;
          sub = `x${slot.count}`;
        }
      }

      // Show bomb icon or hide if empty slot
      const icon = this.slotIcons[i];
      if (icon) {
        if (bombType) {
          icon.setFrame(bombIconFrame(bombType));
          icon.setVisible(true);
        } else {
          icon.setVisible(false);
        }
      }
      // Key badge always shows the number; dim it when slot is empty
      this.slotLabelTexts[i].setAlpha(bombType ? 1 : 0.3);
      this.slotCountTexts[i].setText(sub);

      // Highlight selected slot (armed for throwing, or staged throw in aim mode)
      const isSelected = this.selectedSlot === i
        || (this.inputMode.kind === 'aim' && this.inputMode.slotIndex === i);
      const hl = this.slotHighlights[i];
      hl.clear();
      if (isSelected) {
        hl.lineStyle(3, 0xff4444, 1);
        hl.strokeRoundedRect(this.hudTrayX + i * (SLOT_SIZE + SLOT_GAP), this.hudTrayY, SLOT_SIZE, SLOT_SIZE, 4);
      }
    }
  }

  private onSlotClicked(slotIndex: number): void {
    // Staging is phase-independent; flushStagedAction() gates the send.
    if (!this.state) return;
    const me = this.myBomberman();
    if (!me || !me.alive || me.escaped) return;
    // Stun gate: server will reject any action from a stunned bomberman,
    // so just ignore clicks client-side for clean UX (no feedback needed).
    if ((me.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)) return;

    // Loot swap shortcut: clicking an inventory slot while a loot swap is
    // pending triggers the swap instead of entering aim mode.
    if (this.lootPendingSwap && slotIndex >= 1 && slotIndex <= this.localCustomSlotCount()) {
      this.executeLootSwap(slotIndex);
      return;
    }

    // Slot 0 is Rock (always available), slots 1..maxCustomSlots map to inventory.slots[0..N-1]
    let hasBomb = false;
    if (slotIndex === 0) {
      hasBomb = true;
    } else {
      hasBomb = me.inventory.slots[slotIndex - 1] != null;
    }
    if (!hasBomb) return;

    // Backend gate: the tutorial director can block slot selection
    // persistently (setBlockSlotSelection) or wait for a specific slot
    // (selectBomb expectation). Live matches always return true.
    if (this.backend && !this.backend.onSlotSelected(slotIndex)) return;

    // Toggle the armed slot. Movement continues uninterrupted — the player
    // only commits to a throw when they click a target tile.
    if (this.selectedSlot === slotIndex) {
      this.selectedSlot = null;
    } else {
      this.selectedSlot = slotIndex;
    }

    this.lootPendingSwap = null;
    this.rebuildEntities();
    this.renderHud();
    // Slot toggle changes the contextual tooltip (e.g. "Throw at this tile" /
    // "Teleport to this tile"). Re-derive from the current pointer so the
    // tooltip updates immediately, even if the user used a 1-5 hotkey.
    const p = this.input.activePointer;
    this.refreshTooltip(p.x, p.y);
  }

  // --- Loot panel ---

  private lootPanelY = 0;

  private renderLootPanel(me: BombermanState): void {
    this.hideLootPanel();
    if (!this.state) return;

    // Find what's on the player's tile. Each source carries its own slot
    // count: chests are always 5 (`CHEST_LOOT_SLOT_COUNT`), bodies match the
    // deceased's `maxCustomSlots`. The looting UI renders one row per source
    // sized accordingly — the player's HUD slot tray remains the only thing
    // sized off the local Bomberman's stats.
    type LootSourceRow = {
      kind: 'chest' | 'body';
      id: string;
      bombs: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number }>;
      label: string;
      slotCount: number;
    };

    const CHEST_LOOT_SLOT_COUNT = 5;
    const sources: LootSourceRow[] = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        sources.push({
          kind: 'chest',
          id: c.id,
          bombs: c.bombs.map(b => ({ type: b.type, count: b.count })),
          label: `CHEST (TIER ${c.tier})`,
          slotCount: CHEST_LOOT_SLOT_COUNT,
        });
      }
    }
    for (const b of this.state.bodies) {
      if (b.x === me.x && b.y === me.y && b.bombs.length > 0) {
        sources.push({
          kind: 'body',
          id: b.id,
          bombs: b.bombs.map(bb => ({ type: bb.type, count: bb.count })),
          label: 'BODY LOOT',
          slotCount: b.maxCustomSlots,
        });
      }
    }

    if (sources.length === 0) {
      this.lootPanelVisible = false;
      this.lootPendingSwap = null;
      return;
    }
    this.lootPanelVisible = true;

    const { width } = this.scale;
    const lootSlotSize = SLOT_SIZE;
    const rowH = 70;
    const rowGap = 8;
    const headerH = 26;

    // Panel sized by the widest row. Each row's width = slotCount * SLOT_SIZE
    // + (slotCount - 1) * SLOT_GAP + 20 padding.
    let widestRow = 0;
    for (const src of sources) {
      const w = src.slotCount * lootSlotSize + Math.max(0, src.slotCount - 1) * SLOT_GAP + 20;
      if (w > widestRow) widestRow = w;
    }
    const panelWidth = widestRow;
    const panelHeight = headerH + sources.length * rowH + Math.max(0, sources.length - 1) * rowGap + 12;

    const panelX = (width - panelWidth) / 2;
    const panelY = this.hudTrayY - panelHeight - 10;
    this.lootPanelY = panelY;

    // Background
    const bg = this.hud(this.add.graphics().setDepth(1010));
    bg.fillStyle(0x112211, 0.92);
    bg.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 6);
    bg.lineStyle(2, 0x44ff88, 0.9);
    bg.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 6);
    this.lootPanelObjects.push(bg);

    // Render each source as its own slot row. Index `i` here is the row;
    // the absolute slot index across all rows is what the click handlers
    // use (reconstructed in the same order in `tryLootSlotAt`).
    let cursorY = panelY + 8;
    for (const src of sources) {
      const rowTitle = this.hud(this.add.text(panelX + 12, cursorY, src.label, {
        fontSize: '11px', color: src.kind === 'chest' ? '#44ff88' : '#ffaa66',
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0).setDepth(1011));
      this.lootPanelObjects.push(rowTitle);
      cursorY += 18;

      const rowWidth = src.slotCount * lootSlotSize + Math.max(0, src.slotCount - 1) * SLOT_GAP;
      const slotStartX = panelX + (panelWidth - rowWidth) / 2;
      const slotY = cursorY;

      for (let i = 0; i < src.slotCount; i++) {
        const sx = slotStartX + i * (lootSlotSize + SLOT_GAP);
        const bomb = src.bombs[i];

        const rect = this.hud(this.add.rectangle(sx, slotY, lootSlotSize, 50, 0x1a2a1e, 1)
          .setOrigin(0, 0)
          .setStrokeStyle(2, bomb ? (src.kind === 'chest' ? 0x44ff88 : 0xffaa66) : 0x333355)
          .setDepth(1011));
        this.lootPanelObjects.push(rect);

        if (!bomb) {
          const dash = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 25, '—', {
            fontSize: '12px', color: '#444', fontFamily: 'monospace',
          }).setOrigin(0.5).setDepth(1012));
          this.lootPanelObjects.push(dash);
          continue;
        }

        const isPending = this.lootPendingSwap?.sourceId === src.id && this.lootPendingSwap?.bombType === bomb.type;

        const lootIcon = this.hud(this.add.image(
          sx + lootSlotSize / 2, slotY + 22, 'bomb_icons', bombIconFrame(bomb.type),
        ).setDisplaySize(28, 28).setDepth(1012));
        this.lootPanelObjects.push(lootIcon);

        const countText = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 42, `x${bomb.count}`, {
          fontSize: '12px', color: isPending ? '#ffcc44' : '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5, 1).setDepth(1012));
        this.lootPanelObjects.push(countText);

        if (isPending) {
          const hlGfx = this.hud(this.add.graphics().setDepth(1013));
          hlGfx.lineStyle(3, 0xffcc44, 1);
          hlGfx.strokeRoundedRect(sx, slotY, lootSlotSize, 50, 4);
          this.lootPanelObjects.push(hlGfx);
        }
      }

      cursorY += 50 + rowGap;
    }
  }

  private hideLootPanel(): void {
    for (const obj of this.lootPanelObjects) obj.destroy();
    this.lootPanelObjects = [];
    this.lootPanelVisible = false;
  }

  /**
   * Build the same per-source-row layout used by `renderLootPanel`. Returns
   * a flat array where each row's slots are appended in order: chests (5
   * slots each), then bodies (deceased.maxCustomSlots slots each). Empty
   * slots are represented as `null`. The flat index in this array maps 1:1
   * to the visual click target produced by `renderLootPanel`.
   */
  private lootRowsFlat(me: BombermanState): Array<{
    kind: 'chest' | 'body';
    sourceId: string;
    type: import('@shared/types/bombs.ts').BombType;
    count: number;
  } | null> {
    const CHEST_LOOT_SLOT_COUNT = 5;
    const flat: Array<{
      kind: 'chest' | 'body';
      sourceId: string;
      type: import('@shared/types/bombs.ts').BombType;
      count: number;
    } | null> = [];
    if (!this.state) return flat;
    for (const c of this.state.chests) {
      if (c.x !== me.x || c.y !== me.y || c.bombs.length === 0) continue;
      for (let i = 0; i < CHEST_LOOT_SLOT_COUNT; i++) {
        const b = c.bombs[i];
        flat.push(b ? { kind: 'chest', sourceId: c.id, type: b.type, count: b.count } : null);
      }
    }
    for (const body of this.state.bodies) {
      if (body.x !== me.x || body.y !== me.y || body.bombs.length === 0) continue;
      for (let i = 0; i < body.maxCustomSlots; i++) {
        const b = body.bombs[i];
        flat.push(b ? { kind: 'body', sourceId: body.id, type: b.type, count: b.count } : null);
      }
    }
    return flat;
  }

  /** Bomb type at a given loot panel index. */
  private lootSlotBombType(me: BombermanState, lootIndex: number): BombType | null {
    return this.lootRowsFlat(me)[lootIndex]?.type ?? null;
  }

  /** Hit-test the loot panel. Returns the flat loot slot index or -1. */
  private hitTestLootPanel(screenX: number, screenY: number): number {
    if (!this.lootPanelVisible || !this.state) return -1;
    const me = this.myBomberman();
    if (!me) return -1;

    // Reconstruct the same row layout `renderLootPanel` produced. Each row
    // is `headerH=18` of label + 50 of slot rect + spacing.
    type Row = {
      kind: 'chest' | 'body';
      slotCount: number;
      flatStart: number;
    };
    const CHEST_LOOT_SLOT_COUNT = 5;
    const rows: Row[] = [];
    let flatCursor = 0;
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        rows.push({ kind: 'chest', slotCount: CHEST_LOOT_SLOT_COUNT, flatStart: flatCursor });
        flatCursor += CHEST_LOOT_SLOT_COUNT;
      }
    }
    for (const body of this.state.bodies) {
      if (body.x === me.x && body.y === me.y && body.bombs.length > 0) {
        rows.push({ kind: 'body', slotCount: body.maxCustomSlots, flatStart: flatCursor });
        flatCursor += body.maxCustomSlots;
      }
    }
    if (rows.length === 0) return -1;

    const { width } = this.scale;
    const lootSlotSize = SLOT_SIZE;
    const rowGap = 8;

    let widestRow = 0;
    for (const r of rows) {
      const w = r.slotCount * lootSlotSize + Math.max(0, r.slotCount - 1) * SLOT_GAP + 20;
      if (w > widestRow) widestRow = w;
    }
    const panelWidth = widestRow;
    const panelX = (width - panelWidth) / 2;

    // Mirror render: each row is title (18px) + slots (50px) + rowGap.
    let cursorY = this.lootPanelY + 8;
    for (const row of rows) {
      cursorY += 18; // label height
      const slotYTop = cursorY;
      const slotYBot = cursorY + 50;
      if (screenY >= slotYTop && screenY <= slotYBot) {
        const rowWidth = row.slotCount * lootSlotSize + Math.max(0, row.slotCount - 1) * SLOT_GAP;
        const slotStartX = panelX + (panelWidth - rowWidth) / 2;
        const rel = screenX - slotStartX;
        if (rel < 0) return -1;
        const stride = lootSlotSize + SLOT_GAP;
        const idx = Math.floor(rel / stride);
        if (idx < 0 || idx >= row.slotCount) return -1;
        if (rel - idx * stride > lootSlotSize) return -1;
        return row.flatStart + idx;
      }
      cursorY += 50 + rowGap;
    }
    return -1;
  }

  private onLootSlotClicked(lootIndex: number): void {
    if (!this.state) return;
    const me = this.myBomberman();
    if (!me) return;

    // Use the same flat-row layout as the render path.
    const lootSlots = this.lootRowsFlat(me);

    const loot = lootSlots[lootIndex];
    if (!loot) return;

    // Try to find a compatible slot: empty, or same type with room
    const stackLimit = this.localStackSize();
    let targetSlot = -1;

    // First: matching slot with room
    for (let i = 0; i < this.localCustomSlotCount(); i++) {
      const slot = me.inventory.slots[i];
      if (slot && slot.type === loot.type && slot.count < stackLimit) {
        targetSlot = i + 1; // network convention: 1..maxCustomSlots
        break;
      }
    }
    // Second: empty slot
    if (targetSlot === -1) {
      for (let i = 0; i < this.localCustomSlotCount(); i++) {
        if (!me.inventory.slots[i]) {
          targetSlot = i + 1;
          break;
        }
      }
    }

    if (targetSlot !== -1) {
      // Direct pickup — compatible slot found
      this.lootPendingSwap = null;
      this.backend?.sendLoot({
        sourceKind: loot.kind,
        sourceId: loot.sourceId,
        bombType: loot.type,
        targetSlotIndex: targetSlot,
      });
    } else {
      // No compatible slot — highlight this loot bomb. Next click on an
      // inventory slot (1..4) will swap.
      this.lootPendingSwap = {
        sourceKind: loot.kind,
        sourceId: loot.sourceId,
        bombType: loot.type,
        count: loot.count,
      };
      this.renderHud();
    }
  }

  private executeLootSwap(inventorySlotIndex: number): void {
    if (!this.lootPendingSwap) return;
    this.backend?.sendLoot({
      sourceKind: this.lootPendingSwap.sourceKind,
      sourceId: this.lootPendingSwap.sourceId,
      bombType: this.lootPendingSwap.bombType,
      targetSlotIndex: inventorySlotIndex,
    });
    this.lootPendingSwap = null;
    this.renderHud();
  }
}
