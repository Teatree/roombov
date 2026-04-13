import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore } from '../ClientState.ts';
import { MapRenderer, preloadTiledMap } from '../systems/MapRenderer.ts';
import { CameraController } from '../systems/CameraController.ts';
import { FogRenderer } from '../systems/FogRenderer.ts';
import { BombRenderer } from '../systems/BombRenderer.ts';
import { BombermanSpriteSystem, deathAnimationDurationMs } from '../systems/BombermanSpriteSystem.ts';
import { ensureBombermanAnims, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { findPath, type PathTile } from '@shared/systems/Pathfinding.ts';
import type { MapData } from '@shared/types/map.ts';
import type { MatchState } from '@shared/types/match.ts';
import type { BombermanState } from '@shared/types/bomberman.ts';
import type { BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';

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
const SLOT_COUNT = 5;

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
  private mapData: MapData | null = null;
  private mapRenderer: MapRenderer | null = null;
  private fogRenderer: FogRenderer | null = null;
  private bombRenderer: BombRenderer | null = null;
  private cameraController: CameraController | null = null;
  private state: MatchState | null = null;
  private myPlayerId: string | null = null;
  private inputMode: InputMode = { kind: 'idle' };
  /** Which bomb slot is armed for throwing. Purely visual — movement continues
   *  until the player actually clicks a tile to throw at. */
  private selectedSlot: number | null = null;
  private lastPhase: string | null = null;
  private myDeathAt: number | null = null;
  private myKills = 0;
  private myKillerName: string | null = null;
  private tiledInfo: ReturnType<typeof preloadTiledMap> = null;
  /** Dedicated HUD camera that ignores world zoom/pan. */
  private hudCamera: Phaser.Cameras.Scene2D.Camera | null = null;

  // World-space display layers (draw order enforced by setDepth).
  // Depths:
  //   0   map (tilemap layers and tileset graphics)
  //   15  escape hatch sprites
  //   40  bombLayer (persistent bombs, throw arcs, fire, flare flames, fuse nums)
  //   50  fog of war overlay
  //   38  decalLayer (scorch marks, blood — below bombs/fire so fire renders on top)
  //   60  path line
  //   100 entitiesLayer (coin bags, pickups, bodies — pure rebuild-each-tick)
  //   105 bombermanLayer (persistent animated Bomberman sprites + their overlays)
  //   120 explosionLayer (shockwaves that must render through fog)
  //   150 highlights (aim/move targets)
  //   1000+ HUD
  private entitiesLayer!: Phaser.GameObjects.Container;
  private bombermanLayer!: Phaser.GameObjects.Container;
  private bombLayer!: Phaser.GameObjects.Container;
  private explosionLayer!: Phaser.GameObjects.Container;
  private decalLayer!: Phaser.GameObjects.Container;
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
  private hpText!: Phaser.GameObjects.Text;
  private coinsText!: Phaser.GameObjects.Text;
  private slotRects: Phaser.GameObjects.Rectangle[] = [];
  private slotLabelTexts: Phaser.GameObjects.Text[] = [];
  private slotCountTexts: Phaser.GameObjects.Text[] = [];
  private slotHighlights: Phaser.GameObjects.Graphics[] = [];
  private slotIcons: Phaser.GameObjects.Image[] = [];
  private errorText!: Phaser.GameObjects.Text;

  // Loot panel — appears above the bomb tray when standing on loot
  private lootPanelObjects: Phaser.GameObjects.GameObject[] = [];
  private lootPanelVisible = false;
  /** If set, the player clicked a loot bomb that doesn't fit — highlight it
   * and the next inventory-slot click will swap. */
  private lootPendingSwap: { sourceKind: 'chest' | 'body'; sourceId: string; bombType: import('@shared/types/bombs.ts').BombType; count: number } | null = null;

  // Escape hatch animated sprites
  private escapeSprites: Array<{
    x: number; y: number;
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open' | 'closing';
  }> = [];

  // Chest animated sprites (persistent, like escape hatches)
  private chestSprites: Array<{
    id: string; x: number; y: number; tier: 1 | 2;
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open' | 'closing';
    permanentlyOpened: boolean;
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

  // Blood trail decals (persistent, one per tile, tracked separately from explosion decals)
  private bloodDecals = new Set<string>();

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
    this.tiledInfo = preloadTiledMap(this, 'main_map');
    // Escape hatch: 288x32 sheet, 6 frames of 48x32
    this.load.spritesheet('escape_hatch', 'sprites/escape_hatch.png', {
      frameWidth: 48,
      frameHeight: 32,
    });
    // Chests: 64x32 sheets, 4 frames of 16x32 each
    this.load.spritesheet('chest_1', 'sprites/chest_1.png', { frameWidth: 16, frameHeight: 32 });
    this.load.spritesheet('chest_2', 'sprites/chest_2.png', { frameWidth: 16, frameHeight: 32 });
    // Doors: loaded as a plain image, frames added manually in create()
    this.load.image('double_doors', 'sprites/double_doors.png');
    // Bomb icons (safety fallback — normally loaded by BootScene)
    preloadBombIcons(this);
    // Bomberman sheets are normally loaded by BootScene, but this is a
    // safety fallback in case MatchScene is reached without Boot running.
    preloadBombermanSpritesheets(this);
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    const profile = ProfileStore.get();
    this.myPlayerId = profile?.id ?? null;
    console.log(`[MatchScene] create(): myPlayerId = ${this.myPlayerId}`);

    this.inputMode = { kind: 'idle' };
    this.lastPhase = null;
    this.myDeathAt = null;
    this.myKills = 0;
    this.myKillerName = null;
    this.escapeSprites = [];
    this.bloodDecals = new Set();
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
      for (const tier of [1, 2] as const) {
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

    // Explicit depth stack
    // Bomb layer is BELOW fog (depth 50) — placed bombs, throw arcs, fire
    // tiles, flare flames and fuse numbers all hide in fog of war.
    this.bombLayer = this.add.container(0, 0).setDepth(40);
    // Decals sit ABOVE fog so all players see scorch marks left by any
    // explosion (including through fog), but BELOW entities so Bombermen
    // stand on top of them.
    this.decalLayer = this.add.container(0, 0).setDepth(38);
    this.entitiesLayer = this.add.container(0, 0).setDepth(100);
    // Persistent Bomberman sprites + their overlays (HP pips, ring, aim shadow)
    this.bombermanLayer = this.add.container(0, 0).setDepth(105);
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
    this.hudCamera.ignore([this.bombLayer, this.decalLayer, this.explosionLayer, this.entitiesLayer, this.bombermanLayer, this.effectsLayer, this.highlightGraphics, this.pathGraphics]);

    this.buildHud();

    this.errorText = this.hud(this.add.text(this.scale.width / 2, this.scale.height / 2, '', {
      fontSize: '18px',
      color: '#ff4444',
      fontFamily: 'monospace',
      align: 'center',
      backgroundColor: '#1a0a0a',
      padding: { x: 24, y: 16 },
    }).setOrigin(0.5).setDepth(10000).setVisible(false));

    const socket = NetworkManager.getSocket();
    socket.on('match_state', (msg) => this.onMatchState(msg.state));
    socket.on('turn_result', (msg) => this.onTurnResult(msg.events));
    socket.on('match_end', (msg) => {
      // If we already transitioned (e.g. client-side death→results), ignore.
      if (this.myDeathAt !== null) return;
      // Delay so the player can see the Bomberman reaching the escape hatch
      // before the results screen appears. The walk animation takes 70% of
      // the transition phase; wait for the full transition to complete.
      const delay = BALANCE.match.transitionPhaseSeconds * 1000 + 500;
      this.time.delayedCall(delay, () => this.transitionToResults(msg));
    });

    // Only left-click triggers game actions. Middle/right are reserved for camera pan.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) this.onClick(pointer);
    });

    // Keyboard shortcuts 1-5 for the bomb slots
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ONE', () => this.onSlotClicked(0));
      kb.on('keydown-TWO', () => this.onSlotClicked(1));
      kb.on('keydown-THREE', () => this.onSlotClicked(2));
      kb.on('keydown-FOUR', () => this.onSlotClicked(3));
      kb.on('keydown-FIVE', () => this.onSlotClicked(4));
      kb.on('keydown-ESC', () => {
        this.inputMode = { kind: 'idle' };
        this.sendAction({ kind: 'idle' });
        this.rebuildEntities();
        this.renderHud();
      });
    }
  }

  shutdown(): void {
    const socket = NetworkManager.getSocket();
    socket.off('match_state');
    socket.off('match_end');
    socket.off('turn_result');
    this.mapRenderer?.destroy();
    this.mapRenderer = null;
    this.fogRenderer?.destroy();
    this.fogRenderer = null;
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
    for (const esc of this.escapeSprites) esc.sprite.destroy();
    this.escapeSprites = [];
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
    const ms = Math.max(0, this.state.phaseEndsAt - Date.now());
    this.timerText.setText(`${(ms / 1000).toFixed(1)}s`);
  }

  private async onMatchState(state: MatchState): Promise<void> {
    const firstFrame = this.state === null;
    const phaseBecameInput = state.phase === 'input' && this.lastPhase !== 'input';
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
          sprite.setDepth(15);
          sprite.setOrigin(0.5, 1);
          sprite.play('hatch_closed');
          if (this.hudCamera) this.hudCamera.ignore(sprite);
          this.escapeSprites.push({ x: esc.x, y: esc.y, sprite, state: 'closed' });
        }
        // Create chest sprites (persistent, same lifecycle as escape hatches)
        for (const cs of this.chestSprites) cs.sprite.destroy();
        this.chestSprites = [];
        if (state.chests) {
          for (const chest of state.chests) {
            const key = `chest_${chest.tier}` as 'chest_1' | 'chest_2';
            const sprite = this.add.sprite(
              chest.x * mapTs + mapTs / 2,
              chest.y * mapTs + mapTs,
              key,
            );
            sprite.setDepth(46); // below fog (50) so darkest fog hides them
            sprite.setOrigin(0.5, 1);
            const opened = chest.opened;
            sprite.play(opened ? `${key}_open` : `${key}_closed`);
            if (this.hudCamera) this.hudCamera.ignore(sprite);
            this.chestSprites.push({
              id: chest.id, x: chest.x, y: chest.y, tier: chest.tier,
              sprite, state: opened ? 'open' : 'closed',
              permanentlyOpened: opened,
            });
          }
        }

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
            sprite.setDepth(15);
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
        this.bombRenderer = new BombRenderer(this, this.bombLayer, this.explosionLayer, this.decalLayer, this.mapData.tileSize);
        this.bombermanSpriteSystem?.destroy();
        this.bombermanSpriteSystem = new BombermanSpriteSystem(this, this.bombermanLayer, this.mapData.tileSize);
        if (this.hudCamera) this.bombermanSpriteSystem.ignoreFromCamera(this.hudCamera);
        const bounds = this.mapRenderer.getWorldBounds();
        const ts = this.mapData.tileSize;
        const spawnMe = this.myBomberman();
        const startX = spawnMe ? spawnMe.x * ts + ts / 2 : bounds.width / 2;
        const startY = spawnMe ? spawnMe.y * ts + ts / 2 : bounds.height / 2;
        console.log(`[MatchScene] camera init: spawn=(${spawnMe?.x},${spawnMe?.y}) startPx=(${startX},${startY}) bounds=(${bounds.width},${bounds.height})`);
        this.cameraController = new CameraController(this, bounds.width, bounds.height, startX, startY);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MatchScene] map load failed:', err);
      this.errorText.setText(`MAP LOAD FAILED\n${msg}\n\nCheck browser console.`);
      this.errorText.setVisible(true);
      return;
    }

    this.errorText.setVisible(false);

    const me = this.myBomberman();

    // Smooth camera follow — update target to player's current tile center
    if (me && me.alive && this.cameraController && this.mapData) {
      const ts = this.mapData.tileSize;
      this.cameraController.setTarget(me.x * ts + ts / 2, me.y * ts + ts / 2);
    }

    // Feed flare light tiles into fog as external reveals (visible for everyone)
    if (this.fogRenderer) {
      this.fogRenderer.setExternalReveals(state.lightTiles);
      if (me) this.fogRenderer.update(me.x, me.y);
    }

    // Keep bomb/fire/light visuals in sync with the state
    this.bombRenderer?.syncBombs(state.bombs);
    this.bombRenderer?.syncFire(state.fireTiles);
    this.bombRenderer?.syncFlares(state.flares);

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

  private transitionToResults(msg?: { endReason: string; escapedPlayerIds: string[]; coinsEarned: Record<string, number> }): void {
    const me = this.state?.bombermen.find(b => b.playerId === this.myPlayerId);
    const escaped = msg?.escapedPlayerIds?.includes(this.myPlayerId ?? '') ?? false;
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
    const inventory: Array<{ name: string; count: number }> = [];
    if (me && escaped) {
      for (const slot of me.inventory.slots) {
        if (slot) {
          const def = BOMB_CATALOG[slot.type];
          inventory.push({ name: def.name, count: slot.count });
        }
      }
    }

    this.scene.start('ResultsScene', {
      outcome,
      coinsEarned: msg?.coinsEarned?.[this.myPlayerId ?? ''] ?? 0,
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

    // Drive Bomberman walk lerps + facing changes from `moved` events.
    // Each lerp lasts the full transition phase so the sprite physically
    // walks from old tile to new tile in sync with the resolution timer.
    // Group moved events by player — rush moves produce 2 events for one player.
    // Chain them over the first 70% of the transition so the walk completes
    // before the turn ends, making it clear whether a Bomberman escaped a blast.
    const moveDurationMs = BALANCE.match.transitionPhaseSeconds * 1000 * 0.7;
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
      const perMoveDuration = moveDurationMs / moves.length;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const delay = i * perMoveDuration;
        if (delay > 0) {
          this.time.delayedCall(delay, () => {
            this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
          });
        } else {
          this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
        }
      }
    }

    // Hurt animations on damage events
    for (const ev of events) {
      if (ev.kind !== 'damaged') continue;
      const playerId = ev.playerId as string;
      this.bombermanSpriteSystem?.applyHurtEvent(playerId);
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
      // Only show the throw arc + throw animation if the thrower is in LOS.
      // The arc duration is always recorded for explosion timing regardless.
      const throwerVisible = playerId === this.myPlayerId
        || this.fogRenderer?.isVisible(fromX, fromY);
      if (throwerVisible) {
        const { duration } = this.bombRenderer.spawnThrowArc(type, fromX, fromY, toX, toY);
        arcDurationByBombId.set(bombId, duration);
        this.bombermanSpriteSystem?.applyThrowEvent(playerId, fromX, fromY, toX, toY, duration);
      } else {
        // Still need the arc duration for explosion scheduling
        const duration = (BALANCE.match.transitionPhaseSeconds * 1000) / 2;
        arcDurationByBombId.set(bombId, duration);
      }
    }

    // Second pass: explosions. The visual burst starts at the halfway point
    // of the transition phase and runs until the end — animations are
    // stretched to fill the remaining window so the boom "fills in" the tail
    // of the turn. Decals only stamp after the burst finishes (end of turn).
    // For thrown bombs whose arc flight exceeds the halfway mark, the
    // explosion starts when the bomb lands instead, which may compress the
    // burst window.
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    // Explosions start at 30% of transition for a longer, more visible burst
    const halfTransitionMs = Math.round(transitionMs * 0.3);
    for (const ev of events) {
      if (ev.kind !== 'bomb_triggered') continue;
      const type = ev.type as BombType;
      const tiles = ev.tiles as Array<{ x: number; y: number }>;
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      const bombId = ev.bombId as string;
      const arcDelay = arcDurationByBombId.get(bombId) ?? 0;
      const startDelay = Math.max(arcDelay, halfTransitionMs);
      const animDuration = Math.max(100, transitionMs - startDelay);
      this.bombRenderer.spawnExplosion(type, centerX, centerY, tiles, startDelay, animDuration);
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
      const puffDuration = halfTransitionMs;
      // At the halfway point: snap sprite, play puffs at both ends
      this.time.delayedCall(halfTransitionMs, () => {
        // Snap the Bomberman sprite to the destination tile
        this.bombermanSpriteSystem?.applyTeleportEvent(playerId, toX, toY);
        // Puff effects at origin and destination (on decalLayer = below fog)
        this.bombRenderer?.spawnTeleportPuff(fromX, fromY, puffDuration, true);  // FROM: above fog (visible like explosions)
        this.bombRenderer?.spawnTeleportPuff(toX, toY, puffDuration, false);  // TO: below fog (hidden)
      });
      // Stamp decals after the puff finishes (at the end of the transition)
      this.time.delayedCall(halfTransitionMs + puffDuration, () => {
        this.bombRenderer?.stampTeleportDecal(fromX, fromY);
        this.bombRenderer?.stampTeleportDecal(toX, toY);
      });
    }

    // Door-opened events: trigger opening animation on matching door sprites
    for (const ev of events) {
      if (ev.kind !== 'door_opened') continue;
      const doorId = ev.doorId as number;
      const ds = this.doorSprites.find(d => d.id === doorId);
      if (ds && !ds.opened) {
        ds.opened = true;
        if (ds.state === 'closed') {
          const prefix = ds.orientation === 'horizontal' ? 'h' : 'v';
          ds.state = 'opening';
          ds.sprite.play(`door_${prefix}_opening`);
          ds.sprite.once('animationcomplete', () => {
            ds.state = 'open';
            ds.sprite.play(`door_${prefix}_open`);
          });
        }
      }
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

      this.time.delayedCall(deathDelay, () => {
        const deathMs = this.bombermanSpriteSystem?.applyDeathEvent(playerId, x, y) ?? deathAnimationDurationMs();
        this.bombRenderer?.emitBloodSplash(x, y);
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
        const txt = active ? '\u2191' : '!';  // ↑ or !
        const color = active ? '#44ff88' : '#ff4444';
        const indicator = this.add.text(wx, wy, txt, {
          fontSize: '20px', color, fontFamily: 'monospace', fontStyle: 'bold',
          stroke: '#000000', strokeThickness: 3,
        }).setOrigin(0.5).setDepth(150);
        if (this.hudCamera) this.hudCamera.ignore(indicator);
        this.tweens.add({
          targets: indicator,
          y: wy - ts * 1.5,
          alpha: 0,
          duration: 1200,
          ease: 'Cubic.easeOut',
          onComplete: () => indicator.destroy(),
        });
      }
    }

    // Fourth pass: coin collection visuals.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind === 'coin_collected') {
          const bm = this.state?.bombermen.find(b => b.playerId === ev.playerId as string);
          // Only show coin popup if the collecting player's tile is in LOS
          if (bm && (bm.playerId === this.myPlayerId || this.fogRenderer?.isVisible(bm.x, bm.y))) {
            this.spawnCoinPopup(bm.x * ts + ts / 2, bm.y * ts + ts / 2 - ts * 0.5, ev.amount as number);
          }
        }
        if (ev.kind === 'body_looted') {
          const bm = this.state?.bombermen.find(b => b.playerId === ev.playerId as string);
          const coins = ev.coins as number;
          if (bm && coins > 0 && (bm.playerId === this.myPlayerId || this.fogRenderer?.isVisible(bm.x, bm.y))) {
            this.spawnCoinPopup(bm.x * ts + ts / 2, bm.y * ts + ts / 2 - ts * 0.5, coins);
          }
        }
      }
    }
  }

  /** Floating "+N" coin text that rises and fades out. */
  private spawnCoinPopup(worldX: number, worldY: number, amount: number): void {
    const popup = this.add.text(worldX, worldY, `+${amount}¢`, {
      fontSize: '16px',
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      stroke: '#553300',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(500);

    this.tweens.add({
      targets: popup,
      y: worldY - 40,
      alpha: 0,
      duration: 1200,
      ease: 'Cubic.easeOut',
      onComplete: () => popup.destroy(),
    });
  }

  private myBomberman(): BombermanState | null {
    return this.state?.bombermen.find(b => b.playerId === this.myPlayerId) ?? null;
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

    // Dropped bodies — only visible if discovered by player
    for (const body of this.state.bodies) {
      if (!rtsVisible(`body_${body.id}`, body.x, body.y)) continue;
      const g = this.add.graphics();
      g.fillStyle(0x552222, 0.8);
      g.fillRect(body.x * ts + 4, body.y * ts + ts - 10, ts - 8, 6);
      this.entitiesLayer.add(g);
    }

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

    // Door state machine
    if (this.doorSprites.length > 0) this.updateDoors();

    // Blood trail decals — only created when their tile is currently visible
    // (RTS fog: blood that appears while area is dim stays hidden until revisited)
    for (const bt of this.state.bloodTiles) {
      const key = `blood_${bt.x},${bt.y}`;
      if (this.bloodDecals.has(key)) continue;
      if (!rtsVisible(key, bt.x, bt.y)) continue;
      this.bloodDecals.add(key);
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
      this.decalLayer.add(g);
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

    // Path line + staged-action highlight
    this.drawPath();
    this.drawHighlights();
  }

  /**
   * Escape hatch state machine.
   * - closed (default): frame 0, idle
   * - Any alive Bomberman within 1 tile → play opening → stay open
   * - Bomberman escapes on that tile → play closing → back to closed
   * - Bomberman walks away without escaping → play closing
   */
  private updateEscapeHatches(): void {
    if (!this.state) return;
    for (const esc of this.escapeSprites) {
      // Check if any alive non-escaped Bomberman is within Chebyshev distance 1
      const nearby = this.state.bombermen.some(b =>
        b.alive && !b.escaped &&
        Math.max(Math.abs(b.x - esc.x), Math.abs(b.y - esc.y)) <= 1,
      );
      // Check if someone just escaped ON this tile
      const justEscaped = this.state.bombermen.some(b =>
        b.escaped && b.x === esc.x && b.y === esc.y,
      );

      if (justEscaped && esc.state === 'open') {
        // Bomberman entered — close the hatch
        esc.state = 'closing';
        esc.sprite.play('hatch_closing');
        esc.sprite.once('animationcomplete', () => {
          esc.state = 'closed';
          esc.sprite.play('hatch_closed');
        });
      } else if (nearby && esc.state === 'closed') {
        // Someone is approaching — open the hatch
        esc.state = 'opening';
        esc.sprite.play('hatch_opening');
        esc.sprite.once('animationcomplete', () => {
          esc.state = 'open';
          esc.sprite.play('hatch_open');
        });
      } else if (!nearby && !justEscaped && esc.state === 'open') {
        // Everyone walked away — close it
        esc.state = 'closing';
        esc.sprite.play('hatch_closing');
        esc.sprite.once('animationcomplete', () => {
          esc.state = 'closed';
          esc.sprite.play('hatch_closed');
        });
      }
    }
  }

  /**
   * Chest animation state machine — same proximity pattern as escape hatches.
   * Once a chest is `opened` on the server, it stays permanently open.
   */
  private updateChests(): void {
    if (!this.state) return;
    for (const cs of this.chestSprites) {
      const key = `chest_${cs.tier}` as 'chest_1' | 'chest_2';

      // RTS fog: chest only visible if tile is in LOS or was previously discovered
      const entityId = `chest_${cs.id}`;
      const vis = this.fogRenderer?.isVisible(cs.x, cs.y);
      if (vis) {
        this.knownEntities.add(entityId);
        cs.sprite.setVisible(true);
      } else if (this.fogRenderer?.isDiscovered(cs.x, cs.y) && this.knownEntities.has(entityId)) {
        cs.sprite.setVisible(true);
        // In seen-dim: don't update animations (stale visual)
        continue;
      } else {
        cs.sprite.setVisible(false);
        continue;
      }

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
        if (cs.state === 'opening') continue; // let anim finish → becomes 'open'
        if (cs.state !== 'open') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        }
        continue;
      }

      // Proximity check: any alive, non-escaped Bomberman within Chebyshev ≤ 1
      const nearby = this.state.bombermen.some(b =>
        b.alive && !b.escaped &&
        Math.max(Math.abs(b.x - cs.x), Math.abs(b.y - cs.y)) <= 1,
      );

      if (nearby && cs.state === 'closed') {
        cs.state = 'opening';
        cs.sprite.play(`${key}_opening`);
        cs.sprite.once('animationcomplete', () => {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        });
      } else if (!nearby && cs.state === 'open') {
        cs.state = 'closing';
        cs.sprite.play(`${key}_closing`);
        cs.sprite.once('animationcomplete', () => {
          cs.state = 'closed';
          cs.sprite.play(`${key}_closed`);
        });
      }
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
          continue; // stale — don't update animation
        }
        ds.sprite.setVisible(false);
        continue;
      }

      // Sync server state
      const serverDoor = this.state.doors?.find(d => d.id === ds.id);
      if (serverDoor?.opened && !ds.opened) {
        ds.opened = true;
      }

      // Already open → stick on open frame
      if (ds.opened) {
        if (ds.state !== 'open' && ds.state !== 'opening') {
          ds.state = 'open';
          ds.sprite.play(`${animKey}_open`);
        }
        if (ds.state === 'opening') continue; // let anim finish
        if (ds.state !== 'open') {
          ds.state = 'open';
          ds.sprite.play(`${animKey}_open`);
        }
        continue;
      }

      // Proximity check: any alive Bomberman within Chebyshev ≤ 1 of any door tile
      const nearby = this.state.bombermen.some(b =>
        b.alive && !b.escaped &&
        ds.tiles.some(t => Math.max(Math.abs(b.x - t.x), Math.abs(b.y - t.y)) <= 1),
      );

      if (nearby && ds.state === 'closed') {
        ds.state = 'opening';
        ds.sprite.play(`${animKey}_opening`);
        ds.sprite.once('animationcomplete', () => {
          ds.state = 'open';
          ds.sprite.play(`${animKey}_open`);
        });
      }
      // No closing — doors never close once opened by proximity either
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

    if (this.inputMode.kind === 'aim' && this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
      this.highlightGraphics.lineStyle(3, 0xff4444, 1);
      this.highlightGraphics.strokeRect(
        this.inputMode.targetX * ts + 2,
        this.inputMode.targetY * ts + 2,
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
    NetworkManager.getSocket().emit('player_action', { action });
  }

  // --- HUD (rendered on a separate camera that never zooms/scrolls) ---

  private hudTrayX = 0;
  private hudTrayY = 0;
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

    this.hpText = this.hud(this.add.text(width - 220, 14, 'HP --', {
      fontSize: '16px', color: '#ff6666', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(1001));

    this.coinsText = this.hud(this.add.text(width - 100, 14, '0¢', {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(1001));

    // Bomb slot tray
    const trayWidth = SLOT_COUNT * SLOT_SIZE + (SLOT_COUNT - 1) * SLOT_GAP;
    const trayX = (width - trayWidth) / 2;
    const trayY = height - SLOT_SIZE - 16;
    this.hudTrayX = trayX;
    this.hudTrayY = trayY;

    const trayBg = this.add.graphics().setDepth(1000);
    trayBg.fillStyle(0x0a0a14, 0.85);
    trayBg.fillRoundedRect(trayX - 10, trayY - 10, trayWidth + 20, SLOT_SIZE + 20, 6);
    this.hud(trayBg);

    for (let i = 0; i < SLOT_COUNT; i++) {
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
  }

  /** Returns slot index [0..4] if (x,y) is on a bomb slot, -1 otherwise. */
  private hitTestHud(screenX: number, screenY: number): number {
    if (screenY < this.hudTrayY || screenY > this.hudTrayY + SLOT_SIZE) return -1;
    const rel = screenX - this.hudTrayX;
    if (rel < 0) return -1;
    const stride = SLOT_SIZE + SLOT_GAP;
    const idx = Math.floor(rel / stride);
    if (idx < 0 || idx >= SLOT_COUNT) return -1;
    const offset = rel - idx * stride;
    if (offset > SLOT_SIZE) return -1; // in the gap between slots
    return idx;
  }

  private renderHud(): void {
    if (!this.state) return;
    const me = this.myBomberman();

    const phaseLabel = this.state.phase === 'input' ? 'YOUR TURN'
      : this.state.phase === 'transition' ? 'RESOLVING...'
      : 'MATCH OVER';
    this.phaseText.setText(phaseLabel);
    this.phaseText.setColor(this.state.phase === 'input' ? '#44ff88'
      : this.state.phase === 'transition' ? '#ffcc44' : '#ff4444');

    const turnsLeft = BALANCE.match.turnLimit - this.state.turnNumber;
    this.turnText.setText(`Turn ${this.state.turnNumber} / ${BALANCE.match.turnLimit}`);
    this.turnText.setColor(turnsLeft <= BALANCE.match.turnsLeftWarning ? '#ff6644' : '#aaaaaa');

    if (me && me.alive) {
      this.hpText.setText(`HP ${me.hp}/${BALANCE.match.bombermanMaxHp}`);
      this.hpText.setColor('#ff6666');
      this.coinsText.setText(`${me.coins}¢`);
      this.renderBombSlots(me);
      this.renderLootPanel(me);
    } else {
      this.hpText.setText('DEAD');
      this.hpText.setColor('#666');
      this.hideLootPanel();
    }
  }

  private renderBombSlots(me: BombermanState): void {
    // Slot layout: 0 = Rock (infinite), 1..4 = custom inventory[0..3]
    for (let i = 0; i < SLOT_COUNT; i++) {
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

    // Loot swap shortcut: clicking an inventory slot while a loot swap is
    // pending triggers the swap instead of entering aim mode.
    if (this.lootPendingSwap && slotIndex >= 1 && slotIndex <= 4) {
      this.executeLootSwap(slotIndex);
      return;
    }

    // Slot 0 is Rock (always available), slots 1..4 map to inventory.slots[0..3]
    let hasBomb = false;
    if (slotIndex === 0) {
      hasBomb = true;
    } else {
      hasBomb = me.inventory.slots[slotIndex - 1] != null;
    }
    if (!hasBomb) return;

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
  }

  // --- Loot panel ---

  private lootPanelY = 0;

  private renderLootPanel(me: BombermanState): void {
    this.hideLootPanel();
    if (!this.state) return;

    // Find what's on the player's tile
    type LootSource = {
      kind: 'chest' | 'body';
      id: string;
      bombs: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number }>;
      label: string;
    };

    const sources: LootSource[] = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        sources.push({
          kind: 'chest',
          id: c.id,
          bombs: c.bombs.map(b => ({ type: b.type, count: b.count })),
          label: `CHEST (TIER ${c.tier})`,
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
    const panelWidth = SLOT_COUNT * SLOT_SIZE + (SLOT_COUNT - 1) * SLOT_GAP + 20;
    const panelX = (width - panelWidth) / 2;
    const panelY = this.hudTrayY - 100;
    this.lootPanelY = panelY;

    // Background
    const bg = this.hud(this.add.graphics().setDepth(1010));
    bg.fillStyle(0x112211, 0.92);
    bg.fillRoundedRect(panelX, panelY, panelWidth, 90, 6);
    bg.lineStyle(2, 0x44ff88, 0.9);
    bg.strokeRoundedRect(panelX, panelY, panelWidth, 90, 6);
    this.lootPanelObjects.push(bg);

    // Title
    const title = this.hud(this.add.text(width / 2, panelY + 12, sources[0].label, {
      fontSize: '11px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(1011));
    this.lootPanelObjects.push(title);

    // Flatten all lootable bombs across sources into 4 visual slots
    const lootSlots: Array<{ kind: 'chest' | 'body'; sourceId: string; type: import('@shared/types/bombs.ts').BombType; count: number }> = [];
    for (const src of sources) {
      for (const bomb of src.bombs) {
        lootSlots.push({ kind: src.kind, sourceId: src.id, type: bomb.type, count: bomb.count });
        if (lootSlots.length >= 4) break;
      }
      if (lootSlots.length >= 4) break;
    }

    const slotStartX = panelX + 10;
    const slotY = panelY + 30;
    const lootSlotSize = SLOT_SIZE;

    for (let i = 0; i < 4; i++) {
      const sx = slotStartX + i * (lootSlotSize + SLOT_GAP);
      const loot = lootSlots[i];

      const rect = this.hud(this.add.rectangle(sx, slotY, lootSlotSize, 50, 0x1a2a1e, 1)
        .setOrigin(0, 0)
        .setStrokeStyle(2, loot ? 0x44ff88 : 0x333355)
        .setDepth(1011));
      this.lootPanelObjects.push(rect);

      if (!loot) {
        const dash = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 25, '—', {
          fontSize: '12px', color: '#444', fontFamily: 'monospace',
        }).setOrigin(0.5).setDepth(1012));
        this.lootPanelObjects.push(dash);
        continue;
      }

      const isPending = this.lootPendingSwap?.sourceId === loot.sourceId && this.lootPendingSwap?.bombType === loot.type;

      // Bomb icon
      const lootIcon = this.hud(this.add.image(
        sx + lootSlotSize / 2, slotY + 22, 'bomb_icons', bombIconFrame(loot.type),
      ).setDisplaySize(28, 28).setDepth(1012));
      this.lootPanelObjects.push(lootIcon);

      const countText = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 42, `x${loot.count}`, {
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
  }

  private hideLootPanel(): void {
    for (const obj of this.lootPanelObjects) obj.destroy();
    this.lootPanelObjects = [];
    this.lootPanelVisible = false;
  }

  /** Hit-test the loot panel. Returns the loot slot index [0..3] or -1. */
  private hitTestLootPanel(screenX: number, screenY: number): number {
    if (!this.lootPanelVisible) return -1;
    const { width } = this.scale;
    const panelWidth = SLOT_COUNT * SLOT_SIZE + (SLOT_COUNT - 1) * SLOT_GAP + 20;
    const panelX = (width - panelWidth) / 2;
    const slotStartX = panelX + 10;
    const slotY = this.lootPanelY + 30;

    if (screenY < slotY || screenY > slotY + 50) return -1;
    const rel = screenX - slotStartX;
    if (rel < 0) return -1;
    const stride = SLOT_SIZE + SLOT_GAP;
    const idx = Math.floor(rel / stride);
    if (idx < 0 || idx >= 4) return -1;
    if (rel - idx * stride > SLOT_SIZE) return -1;
    return idx;
  }

  private onLootSlotClicked(lootIndex: number): void {
    if (!this.state) return;
    const me = this.myBomberman();
    if (!me) return;

    // Gather all available loot on this tile (same logic as renderLootPanel)
    const lootSlots: Array<{ kind: 'chest' | 'body'; sourceId: string; type: import('@shared/types/bombs.ts').BombType; count: number }> = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        for (const b of c.bombs) {
          lootSlots.push({ kind: 'chest', sourceId: c.id, type: b.type, count: b.count });
          if (lootSlots.length >= 4) break;
        }
        if (lootSlots.length >= 4) break;
      }
    }
    if (lootSlots.length < 4) {
      for (const b of this.state.bodies) {
        if (b.x === me.x && b.y === me.y) {
          for (const bb of b.bombs) {
            lootSlots.push({ kind: 'body', sourceId: b.id, type: bb.type, count: bb.count });
            if (lootSlots.length >= 4) break;
          }
        }
        if (lootSlots.length >= 4) break;
      }
    }

    const loot = lootSlots[lootIndex];
    if (!loot) return;

    // Try to find a compatible slot: empty, or same type with room
    const stackLimit = BALANCE.match.bombSlotStackLimit;
    let targetSlot = -1;

    // First: matching slot with room
    for (let i = 0; i < 4; i++) {
      const slot = me.inventory.slots[i];
      if (slot && slot.type === loot.type && slot.count < stackLimit) {
        targetSlot = i + 1; // network convention: 1..4
        break;
      }
    }
    // Second: empty slot
    if (targetSlot === -1) {
      for (let i = 0; i < 4; i++) {
        if (!me.inventory.slots[i]) {
          targetSlot = i + 1;
          break;
        }
      }
    }

    if (targetSlot !== -1) {
      // Direct pickup — compatible slot found
      this.lootPendingSwap = null;
      NetworkManager.getSocket().emit('loot_bomb', {
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
    NetworkManager.getSocket().emit('loot_bomb', {
      sourceKind: this.lootPendingSwap.sourceKind,
      sourceId: this.lootPendingSwap.sourceId,
      bombType: this.lootPendingSwap.bombType,
      targetSlotIndex: inventorySlotIndex,
    });
    this.lootPendingSwap = null;
    this.renderHud();
  }
}
