import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore } from '../ClientState.ts';
import { MapRenderer } from '../systems/MapRenderer.ts';
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
  /** Set when the player's own Bomberman dies, so match_end knows to delay. */
  private myDeathAt: number | null = null;

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

  constructor() {
    super({ key: 'MatchScene' });
  }

  create(): void {
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

    this.buildHud();

    this.errorText = this.add.text(this.scale.width / 2, this.scale.height / 2, '', {
      fontSize: '18px',
      color: '#ff4444',
      fontFamily: 'monospace',
      align: 'center',
      backgroundColor: '#1a0a0a',
      padding: { x: 24, y: 16 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(10000).setVisible(false);

    const socket = NetworkManager.getSocket();
    socket.on('match_state', (msg) => this.onMatchState(msg.state));
    socket.on('turn_result', (msg) => this.onTurnResult(msg.events));
    socket.on('match_end', (msg) => {
      const transition = (): void => {
        const me = this.state?.bombermen.find(b => b.playerId === this.myPlayerId);
        const coinsEarned = msg.coinsEarned[this.myPlayerId ?? ''] ?? 0;
        this.scene.start('ResultsScene', {
          winnerId: msg.endReason === 'last_standing'
            ? (this.state?.bombermen.find(b => b.alive)?.playerId ?? null)
            : null,
          coinsEarned,
          escaped: msg.escapedPlayerIds.includes(this.myPlayerId ?? ''),
          survived: me?.alive ?? false,
          turnsPlayed: this.state?.turnNumber ?? 0,
        });
      };

      // If our Bomberman died this turn, hold on the match screen for 3s
      // so the death animation + final explosion can play out. `myDeathAt`
      // is set by the `died` turn event.
      if (this.myDeathAt !== null) {
        const elapsed = Date.now() - this.myDeathAt;
        const remaining = Math.max(0, 3000 - elapsed);
        this.time.delayedCall(remaining, transition);
      } else {
        transition();
      }
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.onClick(pointer));

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
        this.mapRenderer = new MapRenderer(this, this.mapData, 0);
        this.mapRenderer.renderEscapeTiles(this, this.mapData.escapeTiles);
        this.fogRenderer?.destroy();
        this.fogRenderer = new FogRenderer(this, this.mapData, BALANCE.match.losRadius, 50);
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

    // Third pass: deaths. Play the toppling animation on every bomberman
    // that died this turn and remember our own death so match_end knows
    // to hold the match scene open for the 3s minimum.
    for (const ev of events) {
      if (ev.kind !== 'died') continue;
      const playerId = ev.playerId as string;
      const x = ev.x as number;
      const y = ev.y as number;
      this.bombRenderer.spawnDeathAnimation(x, y);
      if (playerId === this.myPlayerId) {
        this.myDeathAt = Date.now();
      }
    }
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

    // HUD slots always intercept first (screen-space hit test).
    const hudSlot = this.hitTestHud(pointer.x, pointer.y);
    if (hudSlot >= 0) {
      this.onSlotClicked(hudSlot);
      return;
    }

    // World-space tile click. Staging is allowed regardless of phase —
    // flushStagedAction() is what decides when to actually send.
    const ts = this.mapData.tileSize;
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const tx = Math.floor(worldPoint.x / ts);
    const ty = Math.floor(worldPoint.y / ts);

    if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) return;

    const me = this.myBomberman();
    if (!me || !me.alive || me.escaped) return;

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

  // --- HUD (screen-space root objects, scrollFactor 0) ---

  private hudTrayX = 0;
  private hudTrayY = 0;

  private buildHud(): void {
    const { width, height } = this.scale;

    // Top bar
    const topBg = this.add.graphics().setScrollFactor(0).setDepth(1000);
    topBg.fillStyle(0x0a0a14, 0.85);
    topBg.fillRect(0, 0, width, 48);

    this.phaseText = this.add.text(20, 14, 'Phase', {
      fontSize: '16px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(1001);

    this.timerText = this.add.text(180, 14, '0.0s', {
      fontSize: '18px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(1001);

    this.turnText = this.add.text(width / 2, 14, 'Turn 0 / 50', {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1001);

    this.hpText = this.add.text(width - 220, 14, 'HP --', {
      fontSize: '16px', color: '#ff6666', fontFamily: 'monospace', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(1001);

    this.coinsText = this.add.text(width - 100, 14, '0¢', {
      fontSize: '16px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(1001);

    // Bomb slot tray
    const trayWidth = SLOT_COUNT * SLOT_SIZE + (SLOT_COUNT - 1) * SLOT_GAP;
    const trayX = (width - trayWidth) / 2;
    const trayY = height - SLOT_SIZE - 16;
    this.hudTrayX = trayX;
    this.hudTrayY = trayY;

    const trayBg = this.add.graphics().setScrollFactor(0).setDepth(1000);
    trayBg.fillStyle(0x0a0a14, 0.85);
    trayBg.fillRoundedRect(trayX - 10, trayY - 10, trayWidth + 20, SLOT_SIZE + 20, 6);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const sx = trayX + i * (SLOT_SIZE + SLOT_GAP);

      // Filled rectangle — actual visible slot
      const rect = this.add.rectangle(sx, trayY, SLOT_SIZE, SLOT_SIZE, 0x1a1a2e, 1)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x444466)
        .setScrollFactor(0)
        .setDepth(1001);
      this.slotRects.push(rect);

      const label = this.add.text(sx + SLOT_SIZE / 2, trayY + 12, '—', {
        fontSize: '10px', color: '#555', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1002);
      this.slotLabelTexts.push(label);

      const countTxt = this.add.text(sx + SLOT_SIZE / 2, trayY + SLOT_SIZE - 12, '', {
        fontSize: '14px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(1002);
      this.slotCountTexts.push(countTxt);

      const highlight = this.add.graphics().setScrollFactor(0).setDepth(1003);
      this.slotHighlights.push(highlight);
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

    if (me) {
      this.hpText.setText(`HP ${me.hp}/${BALANCE.match.bombermanMaxHp}`);
      this.hpText.setColor('#ff6666');
      this.coinsText.setText(`${me.coins}¢`);
      this.renderBombSlots(me);
    } else {
      this.hpText.setText('DEAD');
      this.hpText.setColor('#666');
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

    this.flushStagedAction();
    this.rebuildEntities();
    this.renderHud();
  }
}
