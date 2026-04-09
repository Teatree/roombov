import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore } from '../ClientState.ts';
import { MapRenderer, preloadTiledMap } from '../systems/MapRenderer.ts';
import { CameraController } from '../systems/CameraController.ts';
import { drawBomberman } from '../systems/BombermanRenderer.ts';
import { FogRenderer } from '../systems/FogRenderer.ts';
import { BombRenderer } from '../systems/BombRenderer.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { findPath, type PathTile } from '@shared/systems/Pathfinding.ts';
import type { MapData } from '@shared/types/map.ts';
import type { MatchState } from '@shared/types/match.ts';
import type { BombermanState } from '@shared/types/bomberman.ts';
import type { BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { BALANCE } from '@shared/config/balance.ts';

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
  private state: MatchState | null = null;
  private myPlayerId: string | null = null;
  private inputMode: InputMode = { kind: 'idle' };
  private lastPhase: string | null = null;
  private myDeathAt: number | null = null;
  private tiledInfo: ReturnType<typeof preloadTiledMap> = null;
  /** Dedicated HUD camera that ignores world zoom/pan. */
  private hudCamera: Phaser.Cameras.Scene2D.Camera | null = null;

  // World-space display layers (draw order enforced by setDepth)
  // Depths: map=0, fog=50, path=60, bombs=80, entities=100, highlights=150, HUD=1000
  private entitiesLayer!: Phaser.GameObjects.Container;
  private bombLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private highlightGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;

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
  private errorText!: Phaser.GameObjects.Text;

  // Loot panel — appears above the bomb tray when standing on loot
  private lootPanelObjects: Phaser.GameObjects.GameObject[] = [];
  private lootPanelVisible = false;
  /** If set, the player clicked a loot bomb that doesn't fit — highlight it
   * and the next inventory-slot click will swap. */
  private lootPendingSwap: { sourceKind: 'collectible' | 'body'; sourceId: string; bombType: import('@shared/types/bombs.ts').BombType; count: number } | null = null;

  constructor() {
    super({ key: 'MatchScene' });
  }

  preload(): void {
    // Pre-queue Tiled assets so they're ready by create(). If main_map
    // doesn't have a .tmj in public/maps/ this returns null and we fall
    // back to procedural rendering.
    this.tiledInfo = preloadTiledMap(this, 'main_map');
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    const profile = ProfileStore.get();
    this.myPlayerId = profile?.id ?? null;
    console.log(`[MatchScene] create(): myPlayerId = ${this.myPlayerId}`);

    this.inputMode = { kind: 'idle' };
    this.lastPhase = null;
    this.myDeathAt = null;

    // Explicit depth stack
    this.bombLayer = this.add.container(0, 0).setDepth(80);
    this.entitiesLayer = this.add.container(0, 0).setDepth(100);
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
    this.hudCamera.ignore([this.bombLayer, this.entitiesLayer, this.effectsLayer, this.highlightGraphics, this.pathGraphics]);

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
      this.transitionToResults(msg);
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
    this.state = null;
    this.slotRects = [];
    this.slotLabelTexts = [];
    this.slotCountTexts = [];
    this.slotHighlights = [];
    this.hudObjects = [];
    if (this.hudCamera) {
      this.cameras.remove(this.hudCamera);
      this.hudCamera = null;
    }
    this.input.keyboard?.removeAllListeners();
  }

  update(): void {
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
        this.mapRenderer.renderEscapeTiles(this, this.mapData.escapeTiles);
        // Tell the HUD camera to ignore everything the map renderer created
        if (this.hudCamera) {
          this.mapRenderer.ignoreFromCamera(this.hudCamera);
        }
        this.fogRenderer?.destroy();
        this.fogRenderer = new FogRenderer(this, this.mapData, BALANCE.match.losRadius, 50);
        if (this.hudCamera) this.fogRenderer.ignoreFromCamera(this.hudCamera);
        this.bombRenderer?.destroy();
        this.bombRenderer = new BombRenderer(this, this.bombLayer, this.mapData.tileSize);
        const bounds = this.mapRenderer.getWorldBounds();
        new CameraController(this, bounds.width, bounds.height);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MatchScene] map load failed:', err);
      this.errorText.setText(`MAP LOAD FAILED\n${msg}\n\nCheck browser console.`);
      this.errorText.setVisible(true);
      return;
    }

    this.errorText.setVisible(false);

    // Update fog from my bomberman's current position
    const me = this.myBomberman();
    if (me && this.fogRenderer) {
      this.fogRenderer.update(me.x, me.y);
    }

    // Keep bomb/fire/light visuals in sync with the state
    this.bombRenderer?.syncBombs(state.bombs);
    this.bombRenderer?.syncFire(state.fireTiles);
    this.bombRenderer?.syncLight(state.lightTiles);

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
        // Pop the next waypoint if we already reached it (i.e. a turn passed
        // since we staged this move).
        if (this.inputMode.path.length > 0) {
          const next = this.inputMode.path[0];
          if (next.x === me.x && next.y === me.y) this.inputMode.path.shift();
        }
        if (this.inputMode.path.length === 0) {
          this.inputMode = { kind: 'idle' };
          this.sendAction({ kind: 'idle' });
          return;
        }
        const target = this.inputMode.path[0];
        this.sendAction({ kind: 'move', x: target.x, y: target.y });
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
    this.scene.start('ResultsScene', {
      winnerId: null,
      coinsEarned: msg?.coinsEarned?.[this.myPlayerId ?? ''] ?? 0,
      escaped: msg?.escapedPlayerIds?.includes(this.myPlayerId ?? '') ?? false,
      survived: me?.alive ?? false,
      turnsPlayed: this.state?.turnNumber ?? 0,
    });
  }

  /** One-shot visuals from the server's authoritative turn resolution. */
  private onTurnResult(events: Array<{ kind: string; [k: string]: unknown }>): void {
    if (!this.bombRenderer) return;

    // First pass: spawn arcs for every throw this turn and record the bomb
    // ids so we can time-shift their matching explosions.
    const arcDurationByBombId = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind !== 'throw') continue;
      const type = ev.type as BombType;
      const bombId = ev.bombId as string;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.x as number;
      const toY = ev.y as number;
      const { duration } = this.bombRenderer.spawnThrowArc(type, fromX, fromY, toX, toY);
      arcDurationByBombId.set(bombId, duration);
    }

    // Second pass: explosions. For fuse-0 bombs thrown AND triggered this
    // turn, delay the shockwave by the arc duration so it lands correctly.
    // For fuse-1+ bombs triggered this turn (thrown last turn), no delay.
    for (const ev of events) {
      if (ev.kind !== 'bomb_triggered') continue;
      const type = ev.type as BombType;
      const tiles = ev.tiles as Array<{ x: number; y: number }>;
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      const bombId = ev.bombId as string;
      const delay = arcDurationByBombId.get(bombId) ?? 0;
      if (delay > 0) {
        this.time.delayedCall(delay, () => this.bombRenderer?.spawnExplosion(type, centerX, centerY, tiles));
      } else {
        this.bombRenderer.spawnExplosion(type, centerX, centerY, tiles);
      }
    }

    // Third pass: deaths.
    for (const ev of events) {
      if (ev.kind !== 'died') continue;
      const playerId = ev.playerId as string;
      const x = ev.x as number;
      const y = ev.y as number;
      this.bombRenderer.spawnDeathAnimation(x, y);
      if (playerId === this.myPlayerId) {
        this.myDeathAt = Date.now();
        // Clear all input — dead players can't act
        this.inputMode = { kind: 'idle' };
        this.lootPendingSwap = null;
        // 2 seconds after death animation finishes → Results screen
        this.time.delayedCall(2000, () => {
          this.transitionToResults();
        });
      }
    }

    // Fourth pass: coin collection visuals.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind === 'coin_collected') {
          const me = this.state?.bombermen.find(b => b.playerId === ev.playerId as string);
          if (me) this.spawnCoinPopup(me.x * ts + ts / 2, me.y * ts + ts / 2 - ts * 0.5, ev.amount as number);
        }
        if (ev.kind === 'body_looted') {
          const me = this.state?.bombermen.find(b => b.playerId === ev.playerId as string);
          const coins = ev.coins as number;
          if (me && coins > 0) this.spawnCoinPopup(me.x * ts + ts / 2, me.y * ts + ts / 2 - ts * 0.5, coins);
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

    // Fog filters: enemies/pickups hidden outside LOS. `seeTile` is loose
    // (true for discovered tiles) for coin/bomb pickups so the map feels
    // fair. Only Bombermen strictly require `isVisible`.
    const seeNow = (x: number, y: number): boolean => this.fogRenderer?.isVisible(x, y) ?? true;
    const seeEver = (x: number, y: number): boolean => this.fogRenderer?.isDiscovered(x, y) ?? true;

    // Coin bags (visible if the tile has ever been seen)
    for (const bag of this.state.coinBags) {
      if (!seeEver(bag.x, bag.y)) continue;
      const g = this.add.graphics();
      g.fillStyle(0xffd944, 1);
      g.fillCircle(bag.x * ts + ts / 2, bag.y * ts + ts / 2, ts * 0.35);
      g.lineStyle(2, 0x886600, 1);
      g.strokeCircle(bag.x * ts + ts / 2, bag.y * ts + ts / 2, ts * 0.35);
      this.entitiesLayer.add(g);
      const t = this.add.text(bag.x * ts + ts / 2, bag.y * ts + ts / 2, '$', {
        fontSize: '14px', color: '#332200', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      this.entitiesLayer.add(t);
    }

    // Collectible bombs
    for (const pickup of this.state.collectibleBombs) {
      if (!seeEver(pickup.x, pickup.y)) continue;
      const g = this.add.graphics();
      g.fillStyle(0x333344, 1);
      g.fillCircle(pickup.x * ts + ts / 2, pickup.y * ts + ts / 2, ts * 0.3);
      g.lineStyle(2, 0xaaaaff, 1);
      g.strokeCircle(pickup.x * ts + ts / 2, pickup.y * ts + ts / 2, ts * 0.3);
      this.entitiesLayer.add(g);
    }

    // Dropped bodies
    for (const body of this.state.bodies) {
      if (!seeEver(body.x, body.y)) continue;
      const g = this.add.graphics();
      g.fillStyle(0x552222, 0.8);
      g.fillRect(body.x * ts + 4, body.y * ts + ts - 10, ts - 8, 6);
      this.entitiesLayer.add(g);
    }

    // Bombermen — enemies require strict visibility, self is always shown
    for (const b of this.state.bombermen) {
      if (!b.alive) continue;
      const isMe = b.playerId === this.myPlayerId;
      if (!isMe && !seeNow(b.x, b.y)) continue;

      if (isMe) {
        const ring = this.add.graphics();
        ring.lineStyle(2, 0xffcc44, 0.9);
        ring.strokeCircle(b.x * ts + ts / 2, b.y * ts + ts / 2, ts * 0.55);
        this.entitiesLayer.add(ring);
      }

      const g = this.add.graphics();
      drawBomberman(g, b.colors, b.x * ts + ts / 2, b.y * ts + ts / 2 + 4, ts * 0.9);
      this.entitiesLayer.add(g);

      const pipY = b.y * ts - 2;
      for (let i = 0; i < BALANCE.match.bombermanMaxHp; i++) {
        const p = this.add.graphics();
        p.fillStyle(i < b.hp ? 0xff4444 : 0x333333, 1);
        p.fillRect(b.x * ts + 4 + i * 8, pipY, 6, 4);
        this.entitiesLayer.add(p);
      }

      if (b.escaped) {
        const t = this.add.text(b.x * ts + ts / 2, b.y * ts - 8, 'ESCAPED', {
          fontSize: '10px', color: '#44ff88', fontFamily: 'monospace',
        }).setOrigin(0.5);
        this.entitiesLayer.add(t);
      }
    }

    // Path line + staged-action highlight
    this.drawPath();
    this.drawHighlights();
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

    // Dashed-ish line: alternating colors per segment for legibility
    this.pathGraphics.lineStyle(3, 0x44aaff, 0.9);
    this.pathGraphics.beginPath();
    this.pathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.pathGraphics.lineTo(points[i].x, points[i].y);
    this.pathGraphics.strokePath();

    // Waypoint markers
    for (let i = 0; i < this.inputMode.path.length; i++) {
      const p = this.inputMode.path[i];
      const cx = p.x * ts + ts / 2;
      const cy = p.y * ts + ts / 2;
      this.pathGraphics.fillStyle(i === 0 ? 0xffcc44 : 0x44aaff, 0.9);
      this.pathGraphics.fillCircle(cx, cy, i === 0 ? 6 : 4);
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

    // Click on self = cancel any staged action
    if (tx === me.x && ty === me.y) {
      this.inputMode = { kind: 'idle' };
      this.flushStagedAction();
      this.rebuildEntities();
      this.renderHud();
      return;
    }

    // Aim mode: click = set throw target
    if (this.inputMode.kind === 'aim') {
      this.inputMode = {
        kind: 'aim',
        slotIndex: this.inputMode.slotIndex,
        targetX: tx,
        targetY: ty,
      };
      this.flushStagedAction();
      this.rebuildEntities();
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

  private sendAction(action: { kind: 'idle' } | { kind: 'move'; x: number; y: number } | { kind: 'throw'; slotIndex: number; x: number; y: number }): void {
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

      const label = this.add.text(sx + SLOT_SIZE / 2, trayY + 12, '—', {
        fontSize: '10px', color: '#555', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0).setDepth(1002);
      this.slotLabelTexts.push(this.hud(label));

      const countTxt = this.add.text(sx + SLOT_SIZE / 2, trayY + SLOT_SIZE - 12, '', {
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
      let label = '—';
      let sub = '';
      let color = '#555';

      if (i === 0) {
        label = 'Rock';
        sub = '∞';
        color = '#ccaa88';
      } else {
        const slot = me.inventory.slots[i - 1];
        if (slot) {
          label = BOMB_CATALOG[slot.type].name;
          sub = `x${slot.count}`;
          color = '#ffffff';
        }
      }

      this.slotLabelTexts[i].setText(`${i + 1}. ${label}`).setColor(color);
      this.slotCountTexts[i].setText(sub);

      // Highlight selected slot
      const isSelected = this.inputMode.kind === 'aim' && this.inputMode.slotIndex === i;
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

    // Slot 0 is Rock (always available), slots 1..4 map to inventory.slots[0..3]
    let hasBomb = false;
    if (slotIndex === 0) {
      hasBomb = true;
    } else {
      hasBomb = me.inventory.slots[slotIndex - 1] != null;
    }
    if (!hasBomb) return;

    // Clicking same slot again cancels the aim
    if (this.inputMode.kind === 'aim' && this.inputMode.slotIndex === slotIndex) {
      this.inputMode = { kind: 'idle' };
    } else {
      const prevTarget = this.inputMode.kind === 'aim'
        ? { x: this.inputMode.targetX, y: this.inputMode.targetY }
        : { x: null, y: null };
      this.inputMode = { kind: 'aim', slotIndex, targetX: prevTarget.x, targetY: prevTarget.y };
    }

    // If a pending loot swap is active, clicking an inventory slot (1..4)
    // triggers the swap instead of entering aim mode.
    if (this.lootPendingSwap && slotIndex >= 1 && slotIndex <= 4) {
      this.executeLootSwap(slotIndex);
      return;
    }

    this.lootPendingSwap = null;
    this.flushStagedAction();
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
      kind: 'collectible' | 'body';
      id: string;
      bombs: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number }>;
      label: string;
    };

    const sources: LootSource[] = [];
    for (const p of this.state.collectibleBombs) {
      if (p.x === me.x && p.y === me.y) {
        sources.push({
          kind: 'collectible',
          id: p.id,
          bombs: [{ type: p.type, count: p.count }],
          label: 'COLLECTIBLE BOMB',
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
    const lootSlots: Array<{ kind: 'collectible' | 'body'; sourceId: string; type: import('@shared/types/bombs.ts').BombType; count: number }> = [];
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
      const name = BOMB_CATALOG[loot.type].name;
      const nameText = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 12, name, {
        fontSize: '9px', color: isPending ? '#ffcc44' : '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0).setDepth(1012));
      this.lootPanelObjects.push(nameText);

      const countText = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + 38, `x${loot.count}`, {
        fontSize: '12px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
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
    const lootSlots: Array<{ kind: 'collectible' | 'body'; sourceId: string; type: import('@shared/types/bombs.ts').BombType; count: number }> = [];
    for (const p of this.state.collectibleBombs) {
      if (p.x === me.x && p.y === me.y) {
        lootSlots.push({ kind: 'collectible', sourceId: p.id, type: p.type, count: p.count });
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
