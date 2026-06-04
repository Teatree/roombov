import Phaser from 'phaser';

/**
 * Mobile in-match touch controls.
 *
 * Replaces the PC click-to-act model (which MatchScene skips on touch devices)
 * with an explicit, commit-based scheme designed for fingers:
 *
 *   - Bottom-right buttons: [MOVE] [ATTACK]. Tapping one enters a *selection*
 *     state and swaps the pair for [✗ CANCEL] [✓ CONFIRM].
 *   - A tile-snapping selector spawns on the player's tile. The player drags it
 *     around the map; CONFIRM commits the action, CANCEL aborts and restores
 *     the Move/Attack buttons.
 *   - MOVE selection auto-generates the walk path to the selector (reusing the
 *     server-authoritative BFS via hooks.computePath).
 *   - ATTACK selection drives the same ghost area-of-effect + dotted trajectory
 *     the PC build shows, by feeding the snapped target tile back to the scene
 *     (hooks.beginAttackAim + setAimTile).
 *
 * Camera is fully player-controlled at all times: one-finger drag on empty map
 * pans, two-finger pinch zooms, and a drag that begins on the selector moves
 * the selector instead of panning.
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

type SelectState = 'idle' | 'move' | 'attack';
type BtnKind = 'move' | 'attack' | 'confirm' | 'cancel';

const BTN_W = 134;
const BTN_H = 62;
const BTN_GAP = 14;
const BTN_MARGIN = 24;

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
  /** Raw tile under the finger (move destination / attack aim before snap). */
  private dragTile: { x: number; y: number } = { x: 0, y: 0 };
  /** Snapped throw target while attacking (= dragTile for move). */
  private attackTarget: { x: number; y: number } = { x: 0, y: 0 };
  private previewPath: { x: number; y: number }[] = [];
  private previewValid = false;

  // --- touch gesture tracking ---
  private pointers = new Map<number, PointerInfo>();
  private dragRole: 'none' | 'pan' | 'selector' | 'pinch' | 'ui' = 'none';
  private panStart = { scrollX: 0, scrollY: 0, px: 0, py: 0 };
  private pinchStartDist = 0;
  private pinchStartZoom = 1;

  constructor(scene: Phaser.Scene, hooks: MobileHooks) {
    this.scene = scene;
    this.hooks = hooks;

    // World-space selector + move-preview path. Drawn by the main camera only.
    this.previewGfx = scene.add.graphics().setDepth(60);
    this.selectorGfx = scene.add.graphics().setDepth(70);
    hooks.tagWorldObject(this.previewGfx);
    hooks.tagWorldObject(this.selectorGfx);
    this.previewGfx.setVisible(false);
    this.selectorGfx.setVisible(false);

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
      { kind: 'move',    label: 'MOVE',   fill: 0x1d3a5f, stroke: 0x4aa3ff },
      { kind: 'attack',  label: 'ATTACK', fill: 0x5f1d1d, stroke: 0xff5a4a },
      { kind: 'cancel',  label: '✗',      fill: 0x5f1d1d, stroke: 0xff5a4a },
      { kind: 'confirm', label: '✓',      fill: 0x1d5f2e, stroke: 0x4aff84 },
    ];
    for (const d of defs) {
      const container = this.scene.add.container(0, 0).setDepth(2000);
      const bg = this.scene.add.graphics();
      bg.fillStyle(d.fill, 0.92);
      bg.fillRoundedRect(0, 0, BTN_W, BTN_H, 12);
      bg.lineStyle(3, d.stroke, 1);
      bg.strokeRoundedRect(0, 0, BTN_W, BTN_H, 12);
      const isGlyph = d.label === '✓' || d.label === '✗';
      const label = this.scene.add.text(BTN_W / 2, BTN_H / 2, d.label, {
        fontSize: isGlyph ? '34px' : '22px',
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
    const leftX = rightX - 2 * BTN_W - BTN_GAP; // left slot's left edge
    const rgtX = rightX - BTN_W;                // right slot's left edge

    const place = (kind: BtnKind, x: number) => {
      const b = this.buttons.find(bt => bt.kind === kind);
      if (!b) return;
      b.container.setPosition(x, y);
      b.bounds.setTo(x, y, BTN_W, BTN_H);
    };
    place('move', leftX);
    place('cancel', leftX);
    place('attack', rgtX);
    place('confirm', rgtX);

    this.refreshButtonVisibility();
  }

  private refreshButtonVisibility(): void {
    const canAct = this.hooks.canAct();
    const selecting = this.state !== 'idle';
    for (const b of this.buttons) {
      let visible = false;
      if (canAct) {
        if (selecting) visible = b.kind === 'confirm' || b.kind === 'cancel';
        else visible = b.kind === 'move' || b.kind === 'attack';
      }
      b.container.setVisible(visible);
    }
  }

  private hitButton(x: number, y: number): BtnKind | null {
    for (const b of this.buttons) {
      if (!b.container.visible) continue;
      if (b.bounds.contains(x, y)) return b.kind;
    }
    return null;
  }

  private onButton(kind: BtnKind): void {
    switch (kind) {
      case 'move': this.enterState('move'); break;
      case 'attack': this.enterState('attack'); break;
      case 'confirm': this.confirm(); break;
      case 'cancel': this.cancel(); break;
    }
  }

  // ============================================================
  // Selection state machine
  // ============================================================

  private enterState(s: SelectState): void {
    if (!this.hooks.canAct()) return;
    const pt = this.hooks.playerTile();
    if (!pt) return;
    // Stop any in-progress walk so the player isn't moving while re-deciding.
    this.hooks.haltStaged();
    this.state = s;
    this.dragTile = { x: pt.x, y: pt.y };
    this.attackTarget = { x: pt.x, y: pt.y };
    if (s === 'attack') this.hooks.beginAttackAim();
    this.selectorGfx.setVisible(true);
    this.previewGfx.setVisible(s === 'move');
    this.updatePreview();
    this.refreshButtonVisibility();
  }

  private confirm(): void {
    if (this.state === 'move') {
      if (this.previewValid && this.previewPath.length > 0) {
        this.hooks.commitMove(this.previewPath);
      }
    } else if (this.state === 'attack') {
      this.hooks.commitAttack(this.attackTarget);
    }
    this.exitToIdle(false);
  }

  private cancel(): void {
    this.exitToIdle(true);
  }

  /** Leave selection. `aborted` true = nothing committed (clear aim preview). */
  private exitToIdle(aborted: boolean): void {
    if (this.state === 'attack' && aborted) this.hooks.endAim();
    this.state = 'idle';
    this.selectorGfx.setVisible(false).clear();
    this.previewGfx.setVisible(false).clear();
    this.previewPath = [];
    this.refreshButtonVisibility();
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
      this.beginPinch();
      return;
    }

    // 1. Buttons.
    const btn = this.hitButton(pointer.x, pointer.y);
    if (btn) { this.dragRole = 'ui'; this.onButton(btn); return; }

    // 2. Bomb tray / loot panel taps (handled by the scene).
    if (this.hooks.tryHandleHudTap(pointer.x, pointer.y)) { this.dragRole = 'ui'; return; }

    // 3. Drag the selector if the touch landed on it.
    if (this.state !== 'idle' && this.isOverSelector(pointer.x, pointer.y)) {
      this.dragRole = 'selector';
      this.moveSelectorToPointer(pointer);
      return;
    }

    // 4. Otherwise pan the camera.
    this.dragRole = 'pan';
    const cam = this.hooks.worldCamera();
    this.panStart = { scrollX: cam.scrollX, scrollY: cam.scrollY, px: pointer.x, py: pointer.y };
    this.hooks.beginManualCamera();
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.pointers.has(pointer.id)) {
      this.pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    }

    if (this.dragRole === 'pinch' && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (this.dragRole === 'pan') {
      const cam = this.hooks.worldCamera();
      cam.scrollX = this.panStart.scrollX - (pointer.x - this.panStart.px) / cam.zoom;
      cam.scrollY = this.panStart.scrollY - (pointer.y - this.panStart.py) / cam.zoom;
      return;
    }
    if (this.dragRole === 'selector') {
      this.moveSelectorToPointer(pointer);
    }
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    this.pointers.delete(pointer.id);
    // End the current gesture; require a fresh touch to start the next one so
    // lifting one finger of a pinch doesn't snap into a pan.
    if (this.pointers.size === 0) this.dragRole = 'none';
    else if (this.dragRole === 'pinch') this.dragRole = 'none';
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

  /** True if (screenX,screenY) is over (or near) the current selector tile. */
  private isOverSelector(screenX: number, screenY: number): boolean {
    const cam = this.hooks.worldCamera();
    const ts = this.hooks.tileSize();
    const tile = this.state === 'attack' ? this.attackTarget : this.dragTile;
    const world = cam.getWorldPoint(screenX, screenY);
    const cx = tile.x * ts + ts / 2;
    const cy = tile.y * ts + ts / 2;
    // Grab radius ~1 tile so a fingertip near the selector still catches it.
    return Math.abs(world.x - cx) <= ts && Math.abs(world.y - cy) <= ts;
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

  // ============================================================
  // Per-frame
  // ============================================================

  update(): void {
    // Bail out of selection if the player can no longer act (died / stunned).
    if (this.state !== 'idle' && !this.hooks.canAct()) {
      this.exitToIdle(true);
    }
    this.refreshButtonVisibility();
    if (this.state === 'idle') return;
    // Keep the aim tile asserted (the scene's ghost/trajectory reads it each
    // frame) and animate the selector pulse.
    if (this.state === 'attack') this.hooks.setAimTile(this.attackTarget);
    this.drawSelector();
  }

  destroy(): void {
    this.scene.input.off('pointerdown', this.onPointerDown, this);
    this.scene.input.off('pointermove', this.onPointerMove, this);
    this.scene.input.off('pointerup', this.onPointerUp, this);
    this.scene.input.off('pointerupoutside', this.onPointerUp, this);
    this.scene.input.off('wheel', this.onWheel, this);
    this.selectorGfx.destroy();
    this.previewGfx.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.buttons = [];
    this.pointers.clear();
  }
}
