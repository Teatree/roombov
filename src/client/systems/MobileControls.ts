import Phaser from 'phaser';

/**
 * Mobile in-match touch controls.
 *
 * Replaces the PC click-to-act model (which MatchScene skips on touch devices)
 * with a drag-and-hold scheme designed for fingers:
 *
 *   - **Drag from a button.** The bottom-right [MOVE] / [ATTACK] buttons are
 *     drag handles: press one and, *in the same gesture*, drag out onto the
 *     map. The selector/indicator sticks to the finger; releasing commits the
 *     action (a brief confirm flash plays on the tile). There is no separate
 *     confirm/cancel step — lifting the finger *is* the commit. Releasing
 *     without dragging onto the map cancels.
 *       · MOVE drags the green path selector (BFS path to the finger tile).
 *       · ATTACK drags the same ghost AoE + dotted trajectory the PC build
 *         shows, throwing whichever tray slot is currently armed.
 *
 *   - **Urgent move (press-and-hold a tile).** Pressing and holding a finger
 *     on a map tile for ~0.5s commits a move there. A radial hourglass fills
 *     under the finger to telegraph the commit. Because a one-finger press on
 *     the map is also how panning starts, we disambiguate by movement: if the
 *     finger travels beyond a (forgiving) tolerance before the hold completes
 *     it becomes a camera pan instead, and the hourglass is dropped.
 *
 *   - **Camera.** One-finger drag on empty map pans; two-finger pinch zooms.
 *
 * All gameplay/state mutation is delegated to MatchScene through `MobileHooks`
 * so this class stays a pure input+presentation layer.
 */

/** The bundle of scene operations MobileControls needs (see MatchScene.buildMobileHooks). */
export interface MobileHooks {
  /** Local bomberman can act (alive, not escaped, not stunned). */
  canAct(): boolean;
  /** Local bomberman's tile, or null before first state. */
  playerTile(): { x: number; y: number } | null;
  tileSize(): number;
  mapSize(): { w: number; h: number };
  /** BFS path from the player to (tx,ty); empty if unreachable. */
  computePath(tx: number, ty: number): { x: number; y: number }[];
  /** Snap a raw tile to the armed bomb's valid throw target. */
  snapThrow(tx: number, ty: number): { x: number; y: number };
  worldCamera(): Phaser.Cameras.Scene2D.Camera;
  /** Tag a world-space object so only the main camera (not the HUD camera) draws it. */
  tagWorldObject(obj: Phaser.GameObjects.GameObject): void;
  /** Drop the follow-camera so manual pan/zoom sticks. */
  beginManualCamera(): void;
  /** Route a tap to the bomb tray / loot panel. True if it hit one. */
  tryHandleHudTap(x: number, y: number): boolean;
  /** Cancel any staged action (stop walking while the player re-decides). */
  haltStaged(): void;
  /** Arm the selected bomb for the live ghost/trajectory preview. */
  beginAttackAim(): void;
  /** Clear the aiming preview (disarm). */
  endAim(): void;
  /** Set the tile the ghost/trajectory preview points at (null clears). */
  setAimTile(tile: { x: number; y: number } | null): void;
  /** Commit a move along the given path. */
  commitMove(path: { x: number; y: number }[]): void;
  /** Commit a throw at the given (already-snapped) target tile. */
  commitAttack(tile: { x: number; y: number }): void;
}

/** What the active single-finger gesture is doing. */
type DragRole = 'none' | 'btnMove' | 'btnAttack' | 'urgent' | 'pan' | 'pinch' | 'ui';
/** Drives selector/preview rendering; derived from the button drag. */
type SelectState = 'idle' | 'move' | 'attack';
type BtnKind = 'move' | 'attack';

// Roughly half the original button footprint per design feedback; height kept
// at 42 so it stays a comfortable touch target.
const BTN_W = 82;
const BTN_H = 42;
const BTN_GAP = 10;
const BTN_MARGIN = 16;

// Urgent-move tuning.
const URGENT_HOLD_MS = 500;        // hold this long to commit a move
const URGENT_MOVE_TOLERANCE = 22;  // finger travel (px) allowed before it's a pan
const HOURGLASS_R = 46;            // radius — sized to read around a fingertip
// A drag from a button must travel this far to count as "dragged onto the map"
// (so a stray tap on the button doesn't commit a move to the player's own tile).
const BTN_DRAG_THRESHOLD = 20;
const FLASH_MS = 260;              // commit confirmation flash duration

interface Btn {
  kind: BtnKind;
  container: Phaser.GameObjects.Container;
  bounds: Phaser.Geom.Rectangle;
}

interface PointerInfo { x: number; y: number; }

export class MobileControls {
  private scene: Phaser.Scene;
  private hooks: MobileHooks;

  private state: SelectState = 'idle';

  // --- buttons (HUD space) ---
  private buttons: Btn[] = [];

  // --- selector + preview (world space) ---
  private selectorGfx: Phaser.GameObjects.Graphics;
  private previewGfx: Phaser.GameObjects.Graphics;
  /** Commit confirmation flash (world space). */
  private flashGfx: Phaser.GameObjects.Graphics;
  private flash: { x: number; y: number; start: number; kind: SelectState } | null = null;
  /** Urgent-move hourglass (HUD space — two graphics to respect Phaser's
   *  "don't mix strokeCircle with path ops on one Graphics" gotcha). */
  private hourglassGfx: Phaser.GameObjects.Graphics;
  private hourglassArc: Phaser.GameObjects.Graphics;

  /** Raw tile under the finger (move destination / attack aim before snap). */
  private dragTile: { x: number; y: number } = { x: 0, y: 0 };
  /** Snapped throw target while attacking (= dragTile for move). */
  private attackTarget: { x: number; y: number } = { x: 0, y: 0 };
  private previewPath: { x: number; y: number }[] = [];
  private previewValid = false;
  /** True once a button drag has travelled far enough to count as on-map. */
  private movedOntoMap = false;

  // --- touch gesture tracking ---
  private pointers = new Map<number, PointerInfo>();
  private dragRole: DragRole = 'none';
  private panStart = { scrollX: 0, scrollY: 0, px: 0, py: 0 };
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  /** Down position + time for the active single-finger gesture. */
  private downX = 0;
  private downY = 0;
  private downTime = 0;

  constructor(scene: Phaser.Scene, hooks: MobileHooks) {
    this.scene = scene;
    this.hooks = hooks;

    // World-space selector + move-preview path + commit flash. Main camera only.
    this.previewGfx = scene.add.graphics().setDepth(60);
    this.selectorGfx = scene.add.graphics().setDepth(70);
    this.flashGfx = scene.add.graphics().setDepth(72);
    hooks.tagWorldObject(this.previewGfx);
    hooks.tagWorldObject(this.selectorGfx);
    hooks.tagWorldObject(this.flashGfx);
    this.previewGfx.setVisible(false);
    this.selectorGfx.setVisible(false);

    // Hourglass lives in HUD space (over the finger). Main camera must ignore it.
    this.hourglassGfx = scene.add.graphics().setDepth(2100).setVisible(false);
    this.hourglassArc = scene.add.graphics().setDepth(2101).setVisible(false);
    scene.cameras.main.ignore(this.hourglassGfx);
    scene.cameras.main.ignore(this.hourglassArc);

    this.createButtons();
    this.layout();

    scene.input.on('pointerdown', this.onPointerDown, this);
    scene.input.on('pointermove', this.onPointerMove, this);
    scene.input.on('pointerup', this.onPointerUp, this);
    scene.input.on('pointerupoutside', this.onPointerUp, this);
    scene.input.on('wheel', this.onWheel, this);
  }

  // ============================================================
  // Buttons
  // ============================================================

  private createButtons(): void {
    const defs: Array<{ kind: BtnKind; label: string; fill: number; stroke: number }> = [
      { kind: 'move',   label: 'MOVE',   fill: 0x1d3a5f, stroke: 0x4aa3ff },
      { kind: 'attack', label: 'ATTACK', fill: 0x5f1d1d, stroke: 0xff5a4a },
    ];
    for (const d of defs) {
      const container = this.scene.add.container(0, 0).setDepth(2000);
      const bg = this.scene.add.graphics();
      bg.fillStyle(d.fill, 0.92);
      bg.fillRoundedRect(0, 0, BTN_W, BTN_H, 8);
      bg.lineStyle(2, d.stroke, 1);
      bg.strokeRoundedRect(0, 0, BTN_W, BTN_H, 8);
      const label = this.scene.add.text(BTN_W / 2, BTN_H / 2, d.label, {
        fontSize: '15px',
        color: '#ffffff',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5);
      container.add([bg, label]);
      // HUD-only: main camera must not draw it (it lives in screen space).
      this.scene.cameras.main.ignore(container);
      this.buttons.push({
        kind: d.kind,
        container,
        bounds: new Phaser.Geom.Rectangle(0, 0, BTN_W, BTN_H),
      });
    }
  }

  /** (Re)position the buttons in the bottom-right corner. */
  layout(): void {
    const { width, height } = this.scene.scale;
    const rightX = width - BTN_MARGIN;
    const y = height - BTN_MARGIN - BTN_H;
    const leftX = rightX - 2 * BTN_W - BTN_GAP; // MOVE (left slot)
    const rgtX = rightX - BTN_W;                // ATTACK (right slot)

    const place = (kind: BtnKind, x: number) => {
      const b = this.buttons.find(bt => bt.kind === kind);
      if (!b) return;
      b.container.setPosition(x, y);
      b.bounds.setTo(x, y, BTN_W, BTN_H);
    };
    place('move', leftX);
    place('attack', rgtX);

    this.refreshButtonVisibility();
  }

  private refreshButtonVisibility(): void {
    const visible = this.hooks.canAct();
    for (const b of this.buttons) b.container.setVisible(visible);
  }

  private hitButton(x: number, y: number): BtnKind | null {
    for (const b of this.buttons) {
      if (!b.container.visible) continue;
      if (b.bounds.contains(x, y)) return b.kind;
    }
    return null;
  }

  // ============================================================
  // Selection state (driven by an in-progress button drag)
  // ============================================================

  private enterState(s: SelectState): void {
    if (!this.hooks.canAct()) return;
    const pt = this.hooks.playerTile();
    if (!pt) return;
    // Stop any in-progress walk so the player isn't moving while re-deciding.
    this.hooks.haltStaged();
    this.state = s;
    this.movedOntoMap = false;
    this.dragTile = { x: pt.x, y: pt.y };
    this.attackTarget = { x: pt.x, y: pt.y };
    if (s === 'attack') this.hooks.beginAttackAim();
    this.selectorGfx.setVisible(true);
    this.previewGfx.setVisible(s === 'move');
    this.updatePreview();
  }

  /** Commit the in-progress button drag (move/attack) and flash. */
  private commitDrag(): void {
    if (this.state === 'move') {
      if (this.previewValid && this.previewPath.length > 0) {
        this.spawnFlash(this.dragTile, 'move');
        this.hooks.commitMove(this.previewPath);
      }
    } else if (this.state === 'attack') {
      this.spawnFlash(this.attackTarget, 'attack');
      this.hooks.commitAttack(this.attackTarget);
    }
    this.exitToIdle(false);
  }

  /** Leave the button-drag selection. `aborted` true = nothing committed. */
  private exitToIdle(aborted: boolean): void {
    if (this.state === 'attack' && aborted) this.hooks.endAim();
    this.state = 'idle';
    this.movedOntoMap = false;
    this.selectorGfx.setVisible(false).clear();
    this.previewGfx.setVisible(false).clear();
    this.previewPath = [];
  }

  private updatePreview(): void {
    if (this.state === 'move') {
      this.previewPath = this.hooks.computePath(this.dragTile.x, this.dragTile.y);
      this.previewValid = this.previewPath.length > 0;
    } else if (this.state === 'attack') {
      this.attackTarget = this.hooks.snapThrow(this.dragTile.x, this.dragTile.y);
      this.hooks.setAimTile(this.attackTarget);
    }
    this.drawSelector();
    this.drawPreviewPath();
  }

  // ============================================================
  // Pointer / gesture handling
  // ============================================================

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    this.pointers.set(pointer.id, { x: pointer.x, y: pointer.y });

    // Second finger down → start pinch-zoom, abandoning any single-finger drag.
    if (this.pointers.size >= 2) {
      this.cancelUrgent();
      this.beginPinch();
      return;
    }

    this.downX = pointer.x;
    this.downY = pointer.y;
    this.downTime = Date.now();

    // 1. Buttons → begin a drag-from-button gesture.
    const btn = this.hitButton(pointer.x, pointer.y);
    if (btn) {
      this.dragRole = btn === 'move' ? 'btnMove' : 'btnAttack';
      this.enterState(btn === 'move' ? 'move' : 'attack');
      return;
    }

    // 2. Bomb tray / loot panel taps (handled by the scene).
    if (this.hooks.tryHandleHudTap(pointer.x, pointer.y)) { this.dragRole = 'ui'; return; }

    // 3. Otherwise this is a one-finger map press: ambiguous between an urgent
    //    move (hold still) and a pan (drag). Start in 'urgent' and let movement
    //    promote it to a pan. Capture pan origin now so the promotion is seamless.
    this.dragRole = 'urgent';
    const cam = this.hooks.worldCamera();
    this.panStart = { scrollX: cam.scrollX, scrollY: cam.scrollY, px: pointer.x, py: pointer.y };
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.pointers.has(pointer.id)) {
      this.pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    }

    if (this.dragRole === 'pinch' && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }

    if (this.dragRole === 'btnMove' || this.dragRole === 'btnAttack') {
      this.moveSelectorToPointer(pointer);
      if (Phaser.Math.Distance.Between(this.downX, this.downY, pointer.x, pointer.y) > BTN_DRAG_THRESHOLD) {
        this.movedOntoMap = true;
      }
      return;
    }

    if (this.dragRole === 'urgent') {
      // Forgiving: small jitter keeps the hold alive; real travel → pan.
      if (Phaser.Math.Distance.Between(this.downX, this.downY, pointer.x, pointer.y) > URGENT_MOVE_TOLERANCE) {
        this.cancelUrgent();
        this.dragRole = 'pan';
        this.hooks.beginManualCamera();
      } else {
        return;
      }
    }

    if (this.dragRole === 'pan') {
      const cam = this.hooks.worldCamera();
      cam.scrollX = this.panStart.scrollX - (pointer.x - this.panStart.px) / cam.zoom;
      cam.scrollY = this.panStart.scrollY - (pointer.y - this.panStart.py) / cam.zoom;
    }
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    const role = this.dragRole;
    this.pointers.delete(pointer.id);

    if (role === 'btnMove' || role === 'btnAttack') {
      // Lifting the finger is the commit — but only if it was actually dragged
      // onto the map (a stray tap on the button cancels instead).
      if (this.movedOntoMap) this.commitDrag();
      else this.exitToIdle(true);
    } else if (role === 'urgent') {
      // Released before the hold completed → a tap, which does nothing.
      this.cancelUrgent();
    }

    // End the current gesture; require a fresh touch to start the next one so
    // lifting one finger of a pinch doesn't snap into a pan.
    if (this.pointers.size === 0) this.dragRole = 'none';
    else if (role === 'pinch') this.dragRole = 'none';
  }

  private onWheel(_p: Phaser.Input.Pointer, _objs: unknown[], _dx: number, dy: number): void {
    // Trackpad / mouse-wheel zoom (useful when testing with ?mobile=1 on desktop).
    const cam = this.hooks.worldCamera();
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 4));
    this.hooks.beginManualCamera();
  }

  private beginPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    this.dragRole = 'pinch';
    this.pinchStartDist = Phaser.Math.Distance.Between(pts[0].x, pts[0].y, pts[1].x, pts[1].y) || 1;
    this.pinchStartZoom = this.hooks.worldCamera().zoom;
    this.hooks.beginManualCamera();
  }

  private updatePinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const dist = Phaser.Math.Distance.Between(pts[0].x, pts[0].y, pts[1].x, pts[1].y) || 1;
    const cam = this.hooks.worldCamera();
    cam.setZoom(Phaser.Math.Clamp(this.pinchStartZoom * (dist / this.pinchStartDist), 0.5, 4));
  }

  // ============================================================
  // Urgent move (press-and-hold a tile)
  // ============================================================

  /** Tile currently under the original press point (camera may not have moved). */
  private tileUnderDown(): { x: number; y: number } | null {
    const cam = this.hooks.worldCamera();
    const ts = this.hooks.tileSize();
    const { w, h } = this.hooks.mapSize();
    if (w <= 0 || h <= 0) return null;
    const world = cam.getWorldPoint(this.downX, this.downY);
    return {
      x: Phaser.Math.Clamp(Math.floor(world.x / ts), 0, w - 1),
      y: Phaser.Math.Clamp(Math.floor(world.y / ts), 0, h - 1),
    };
  }

  private completeUrgent(): void {
    const tile = this.tileUnderDown();
    this.cancelUrgent();
    this.dragRole = 'none';
    if (!tile || !this.hooks.canAct()) return;
    const path = this.hooks.computePath(tile.x, tile.y);
    if (path.length === 0) return; // unreachable — silently ignore
    this.hooks.haltStaged();
    this.spawnFlash(tile, 'move');
    this.hooks.commitMove(path);
  }

  private cancelUrgent(): void {
    this.hourglassGfx.setVisible(false).clear();
    this.hourglassArc.setVisible(false).clear();
  }

  private drawHourglass(progress: number): void {
    const g = this.hourglassGfx;
    const a = this.hourglassArc;
    const cx = this.downX;
    const cy = this.downY;
    const R = HOURGLASS_R;
    const done = progress >= 1;
    const col = done ? 0x66ffaa : 0x44ff88;

    // Backing disc + outline ring (circle ops on their own Graphics).
    g.clear();
    g.setVisible(true);
    g.fillStyle(0x06140c, 0.4);
    g.fillCircle(cx, cy, R);
    g.lineStyle(3, col, 0.85);
    g.strokeCircle(cx, cy, R);

    // Progress pie (path ops on a separate Graphics — see gotcha note).
    a.clear();
    a.setVisible(true);
    a.fillStyle(col, 0.45);
    a.beginPath();
    a.moveTo(cx, cy);
    a.arc(cx, cy, R - 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Phaser.Math.Clamp(progress, 0, 1), false);
    a.closePath();
    a.fillPath();
  }

  // ============================================================
  // Selector helpers
  // ============================================================

  private moveSelectorToPointer(pointer: Phaser.Input.Pointer): void {
    const cam = this.hooks.worldCamera();
    const ts = this.hooks.tileSize();
    const world = pointer.positionToCamera(cam) as Phaser.Math.Vector2;
    const { w, h } = this.hooks.mapSize();
    const tx = Phaser.Math.Clamp(Math.floor(world.x / ts), 0, Math.max(0, w - 1));
    const ty = Phaser.Math.Clamp(Math.floor(world.y / ts), 0, Math.max(0, h - 1));
    if (tx === this.dragTile.x && ty === this.dragTile.y) return;
    this.dragTile = { x: tx, y: ty };
    this.updatePreview();
  }

  private drawSelector(): void {
    const g = this.selectorGfx;
    g.clear();
    if (this.state === 'idle') return;
    const ts = this.hooks.tileSize();
    const tile = this.state === 'attack' ? this.attackTarget : this.dragTile;
    const px = tile.x * ts;
    const py = tile.y * ts;
    const valid = this.state === 'move' ? this.previewValid : true;
    const color = this.state === 'attack' ? 0xffaa33 : (valid ? 0x44ff88 : 0xff5555);
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);

    g.fillStyle(color, 0.12 + 0.10 * pulse);
    g.fillRect(px, py, ts, ts);
    g.lineStyle(3, color, 0.9);
    g.strokeRect(px + 1.5, py + 1.5, ts - 3, ts - 3);
    // Corner ticks for a "grab handle" read.
    const c = ts * 0.28;
    g.lineStyle(4, color, 1);
    g.lineBetween(px, py, px + c, py); g.lineBetween(px, py, px, py + c);
    g.lineBetween(px + ts, py, px + ts - c, py); g.lineBetween(px + ts, py, px + ts, py + c);
    g.lineBetween(px, py + ts, px + c, py + ts); g.lineBetween(px, py + ts, px, py + ts - c);
    g.lineBetween(px + ts, py + ts, px + ts - c, py + ts); g.lineBetween(px + ts, py + ts, px + ts, py + ts - c);
  }

  private drawPreviewPath(): void {
    const g = this.previewGfx;
    g.clear();
    if (this.state !== 'move' || this.previewPath.length === 0) return;
    const ts = this.hooks.tileSize();
    const pt = this.hooks.playerTile();
    if (!pt) return;
    g.lineStyle(4, 0x44ff88, 0.5);
    g.beginPath();
    g.moveTo(pt.x * ts + ts / 2, pt.y * ts + ts / 2);
    for (const t of this.previewPath) g.lineTo(t.x * ts + ts / 2, t.y * ts + ts / 2);
    g.strokePath();
    g.fillStyle(0x44ff88, 0.85);
    const dotR = Math.max(2, ts * 0.08);
    for (const t of this.previewPath) g.fillCircle(t.x * ts + ts / 2, t.y * ts + ts / 2, dotR);
  }

  /** Spawn a brief expanding-ring confirmation on the committed tile. */
  private spawnFlash(tile: { x: number; y: number }, kind: SelectState): void {
    const ts = this.hooks.tileSize();
    this.flash = { x: tile.x * ts + ts / 2, y: tile.y * ts + ts / 2, start: Date.now(), kind };
  }

  private drawFlash(): void {
    const g = this.flashGfx;
    g.clear();
    if (!this.flash) return;
    const t = (Date.now() - this.flash.start) / FLASH_MS;
    if (t >= 1) { this.flash = null; return; }
    const ts = this.hooks.tileSize();
    const color = this.flash.kind === 'attack' ? 0xffcc44 : 0x66ffaa;
    const r = ts * (0.5 + 0.7 * t);
    g.lineStyle(Math.max(2, 5 * (1 - t)), color, 1 - t);
    g.strokeRect(this.flash.x - r, this.flash.y - r, r * 2, r * 2);
  }

  // ============================================================
  // Per-frame
  // ============================================================

  update(): void {
    // Bail out of any gesture if the player can no longer act (died / stunned).
    if (!this.hooks.canAct() && (this.state !== 'idle' || this.dragRole === 'urgent')) {
      if (this.state !== 'idle') this.exitToIdle(true);
      this.cancelUrgent();
      if (this.dragRole === 'btnMove' || this.dragRole === 'btnAttack' || this.dragRole === 'urgent') {
        this.dragRole = 'none';
      }
    }
    this.refreshButtonVisibility();

    // Urgent-move hold: tick the hourglass; commit when it fills.
    if (this.dragRole === 'urgent') {
      const progress = (Date.now() - this.downTime) / URGENT_HOLD_MS;
      this.drawHourglass(progress);
      if (progress >= 1) this.completeUrgent();
    }

    // Button drag: keep the aim asserted (the scene's ghost/trajectory reads it
    // each frame) and animate the selector pulse.
    if (this.state !== 'idle') {
      if (this.state === 'attack') this.hooks.setAimTile(this.attackTarget);
      this.drawSelector();
    }

    this.drawFlash();
  }

  destroy(): void {
    this.scene.input.off('pointerdown', this.onPointerDown, this);
    this.scene.input.off('pointermove', this.onPointerMove, this);
    this.scene.input.off('pointerup', this.onPointerUp, this);
    this.scene.input.off('pointerupoutside', this.onPointerUp, this);
    this.scene.input.off('wheel', this.onWheel, this);
    this.selectorGfx.destroy();
    this.previewGfx.destroy();
    this.flashGfx.destroy();
    this.hourglassGfx.destroy();
    this.hourglassArc.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.buttons = [];
    this.pointers.clear();
  }
}
