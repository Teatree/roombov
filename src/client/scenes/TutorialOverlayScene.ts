import Phaser from 'phaser';
import { preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import type { MatchScene } from './MatchScene.ts';
import type { HighlightTarget } from '../tutorial/types.ts';
import type { TutorialMatchBackend } from '../backends/TutorialMatchBackend.ts';

/**
 * Overlay primitives commanded by the TutorialDirector. Stays parallel to
 * MatchScene and draws on top of its HUD camera.
 *
 * Dialogue / pause / highlight / camera pan / input block are the five
 * required UX directives from the GDD §3.
 */
export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'world' rects are in map coords (transformed by main camera);
   *  'hud' rects are in screen space (drawn directly). */
  space: 'world' | 'hud';
}

const DIALOGUE_PANEL_W = 420;
const DIALOGUE_PANEL_H = 160;
const DIALOGUE_MARGIN = 20;
const PORTRAIT_SIZE = 128;

/**
 * Parallel scene that renders all tutorial-only UI on top of MatchScene.
 *
 * The scene has its own camera that ignores the world — it only draws the
 * dialogue panel, pause screen, highlights, and input blocker. World-space
 * highlights are projected through MatchScene's main camera via
 * `matchScene.getMainCamera()`.
 *
 * Phase 3 implements the primitives; the TutorialDirector (Phase 4) drives
 * them via the public API.
 */
export class TutorialOverlayScene extends Phaser.Scene {
  private matchScene: MatchScene | null = null;

  // Dialogue
  private dialoguePanel!: Phaser.GameObjects.Container;
  private dialogueBg!: Phaser.GameObjects.Rectangle;
  private dialogueText!: Phaser.GameObjects.Text;
  private dialogueFooter!: Phaser.GameObjects.Text;
  private dialoguePortrait: Phaser.GameObjects.Sprite | null = null;

  // Pause
  private pauseContainer!: Phaser.GameObjects.Container;
  private pauseDim!: Phaser.GameObjects.Rectangle;
  private pauseText!: Phaser.GameObjects.Text;

  // Highlight
  private highlightGfx!: Phaser.GameObjects.Graphics;
  private currentHighlight: HighlightRect | null = null;
  private highlightPulseT = 0;

  // Input blocker / click catcher
  private clickCatcher!: Phaser.GameObjects.Rectangle;
  private inputBlockedUntil = 0;
  /** Advance callback installed by director while a dialogue/pause is open. */
  private advanceHandler: (() => void) | null = null;

  constructor() {
    super({ key: 'TutorialOverlayScene' });
  }

  preload(): void {
    // Defensive: ensure char4 spritesheet is loaded for the portrait.
    preloadBombermanSpritesheets(this);
  }

  private backend: TutorialMatchBackend | null = null;

  init(data: { matchScene: MatchScene; backend?: TutorialMatchBackend }): void {
    this.matchScene = data.matchScene;
    this.backend = data.backend ?? null;
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);

    const { width, height } = this.scale;

    // --- Click catcher — full-screen transparent. Enabled only while
    //     dialogue/pause is open or input is explicitly blocked. ---
    this.clickCatcher = this.add.rectangle(0, 0, width, height, 0x000000, 0)
      .setOrigin(0, 0)
      .setDepth(0)
      .setInteractive()
      .setVisible(false);
    this.clickCatcher.on('pointerdown', () => {
      if (this.inputBlockedUntil > this.time.now) return;
      this.advanceHandler?.();
    });

    // --- Pause screen — full-screen dim + centered text. ---
    this.pauseContainer = this.add.container(0, 0).setDepth(100).setVisible(false);
    this.pauseDim = this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0, 0);
    this.pauseText = this.add.text(width / 2, height / 2, '', {
      fontSize: '28px',
      color: '#ffffff',
      fontFamily: 'monospace',
      align: 'center',
      wordWrap: { width: width * 0.6 },
    }).setOrigin(0.5);
    const pauseFooter = this.add.text(width / 2, height / 2 + 80, 'Click to Continue', {
      fontSize: '16px',
      color: '#cccccc',
      fontFamily: 'monospace',
    }).setOrigin(0.5);
    this.pauseContainer.add([this.pauseDim, this.pauseText, pauseFooter]);

    // --- Dialogue panel — bottom-right. Portrait + text + footer. ---
    const panelX = width - DIALOGUE_PANEL_W - DIALOGUE_MARGIN;
    const panelY = height - DIALOGUE_PANEL_H - DIALOGUE_MARGIN;
    this.dialoguePanel = this.add.container(panelX, panelY).setDepth(110).setVisible(false);

    this.dialogueBg = this.add.rectangle(0, 0, DIALOGUE_PANEL_W, DIALOGUE_PANEL_H, 0x0a1020, 0.92)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0x44aaff, 1);

    // Portrait slot — a PORTRAIT_SIZE square on the left inside the panel.
    const portraitFrame = this.add.rectangle(12, 12, PORTRAIT_SIZE, PORTRAIT_SIZE, 0x000000, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x224466, 1);

    this.dialogueText = this.add.text(PORTRAIT_SIZE + 24, 16, '', {
      fontSize: '15px',
      color: '#ffffff',
      fontFamily: 'monospace',
      wordWrap: { width: DIALOGUE_PANEL_W - PORTRAIT_SIZE - 40 },
    });

    this.dialogueFooter = this.add.text(DIALOGUE_PANEL_W - 12, DIALOGUE_PANEL_H - 8, 'Click to Continue', {
      fontSize: '11px',
      color: '#88aaff',
      fontFamily: 'monospace',
      fontStyle: 'italic',
    }).setOrigin(1, 1);

    this.dialoguePanel.add([this.dialogueBg, portraitFrame, this.dialogueText, this.dialogueFooter]);

    // --- Highlight layer — draws after everything, depth 90 so pause/dialogue
    //     (100/110) sit on top of it. ---
    this.highlightGfx = this.add.graphics().setDepth(90);

    // Overlay camera must be transparent — it sits on top of MatchScene's
    // cameras and must NOT fill the canvas with black. Phaser's default
    // camera background color has alpha=0; leave it alone.

    // Handle window resize.
    this.scale.on('resize', this.onResize, this);

    // Notify the backend that overlay primitives are ready. Triggers the
    // director to start walking the script.
    this.backend?.attachOverlay(this);
  }

  /**
   * Resolve a symbolic HighlightTarget into a screen-space rect using
   * MatchScene as the authority on HUD layout.
   */
  getHudRectFor(target: HighlightTarget): HighlightRect | null {
    return this.matchScene?.getHudRect(target) ?? null;
  }

  private onResize(size: Phaser.Structs.Size): void {
    const { width, height } = size;
    this.clickCatcher?.setSize(width, height);
    this.pauseDim?.setSize(width, height);
    this.pauseText?.setPosition(width / 2, height / 2);
    this.dialoguePanel?.setPosition(
      width - DIALOGUE_PANEL_W - DIALOGUE_MARGIN,
      height - DIALOGUE_PANEL_H - DIALOGUE_MARGIN,
    );
  }

  // ============================================================
  // Public API — called by TutorialDirector
  // ============================================================

  /**
   * Show a dialogue line. Character portrait (close-up char4) + text + footer.
   * `onAdvance` fires when the player clicks to continue. The panel stays
   * open until the director calls `hideDialogue()` or shows a different one.
   */
  showDialogue(text: string, onAdvance: () => void): void {
    this.ensurePortrait();
    this.dialogueText.setText(text);
    this.dialoguePanel.setVisible(true);
    this.enableClickCatcher(onAdvance);
  }

  hideDialogue(): void {
    this.dialoguePanel.setVisible(false);
    this.maybeDisableClickCatcher();
  }

  /**
   * Full-screen pause with centered message. Player clicks anywhere to
   * advance. Blocks match input entirely while visible.
   */
  showPause(text: string, onAdvance: () => void): void {
    this.pauseText.setText(text);
    this.pauseContainer.setVisible(true);
    this.enableClickCatcher(onAdvance);
  }

  hidePause(): void {
    this.pauseContainer.setVisible(false);
    this.maybeDisableClickCatcher();
  }

  /**
   * Set a pulsing yellow outline on the given rect. Pass `null` to clear.
   * World-space rects are transformed by the main camera so they track
   * the world on pan/zoom.
   */
  setHighlight(rect: HighlightRect | null): void {
    this.currentHighlight = rect;
    if (!rect) this.highlightGfx.clear();
  }

  /**
   * Pan the match camera to a world-space point over `durationMs`, cubic-out.
   * Calls `onComplete` when the pan finishes.
   */
  panCamera(worldX: number, worldY: number, durationMs: number, onComplete?: () => void): void {
    const cam = this.matchScene?.getMainCamera();
    if (!cam) {
      onComplete?.();
      return;
    }
    cam.pan(worldX, worldY, durationMs, 'Cubic.easeOut', true, (_c, progress) => {
      if (progress >= 1) onComplete?.();
    });
  }

  /**
   * Block all tutorial advance input for `ms` milliseconds. During this
   * window the click catcher swallows clicks silently.
   */
  blockInput(ms: number): void {
    this.inputBlockedUntil = Math.max(this.inputBlockedUntil, this.time.now + ms);
    this.clickCatcher.setVisible(true);
    // Auto-hide once the block expires if nothing else needs the catcher.
    this.time.delayedCall(ms + 16, () => this.maybeDisableClickCatcher());
  }

  /** Short flash of the highlight to signal a wrong input. */
  flashHint(rect: HighlightRect): void {
    this.setHighlight(rect);
    this.time.delayedCall(600, () => {
      if (this.currentHighlight === rect) this.setHighlight(null);
    });
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Build the char4 portrait sprite lazily — runtime-cropped to the head. */
  private ensurePortrait(): void {
    if (this.dialoguePortrait) return;
    // Place at the same offset as the portrait frame, 2× scale, cropped to
    // the top 40% of the idle frame. Exact crop numbers get tuned in Phase 12.
    const sprite = this.add.sprite(12 + PORTRAIT_SIZE / 2, 12 + PORTRAIT_SIZE / 2, 'char4_idle');
    sprite.setOrigin(0.5, 0.5);
    // char4 idle spritesheet frames are typically ~32×48; take the top 40%.
    const f = sprite.frame;
    sprite.setCrop(0, 0, f.width, Math.floor(f.height * 0.4));
    // Scale so the cropped head fills the portrait box.
    const scale = (PORTRAIT_SIZE - 8) / Math.max(f.width, f.height * 0.4);
    sprite.setScale(scale);
    this.dialoguePanel.add(sprite);
    this.dialoguePortrait = sprite;
  }

  private enableClickCatcher(onAdvance: () => void): void {
    this.advanceHandler = onAdvance;
    this.clickCatcher.setVisible(true);
    // Ensure the catcher is above dialogue/pause but below their interactive
    // elements — dialogue has no interactive children so a simple setDepth=150
    // on the catcher just means it intercepts everything behind pause/dialogue.
    this.clickCatcher.setDepth(105);
  }

  private maybeDisableClickCatcher(): void {
    const dialogueOpen = this.dialoguePanel?.visible;
    const pauseOpen = this.pauseContainer?.visible;
    const blocked = this.inputBlockedUntil > this.time.now;
    if (!dialogueOpen && !pauseOpen && !blocked) {
      this.clickCatcher.setVisible(false);
      this.advanceHandler = null;
    }
  }

  update(_time: number, delta: number): void {
    if (this.currentHighlight) {
      this.highlightPulseT += delta / 1000;
      this.drawHighlight(this.currentHighlight);
    }
  }

  private drawHighlight(rect: HighlightRect): void {
    const cam = this.matchScene?.getMainCamera();
    let x = rect.x, y = rect.y;
    if (rect.space === 'world' && cam) {
      // Transform world coords to screen coords via the main camera.
      x = (rect.x - cam.worldView.x) * cam.zoom;
      y = (rect.y - cam.worldView.y) * cam.zoom;
    }
    const w = rect.space === 'world' && cam ? rect.w * cam.zoom : rect.w;
    const h = rect.space === 'world' && cam ? rect.h * cam.zoom : rect.h;

    // Yellow pulse — alpha 0.6 → 1.0 with sine, stroke width 3.
    const alpha = 0.6 + 0.4 * Math.abs(Math.sin(this.highlightPulseT * 4));
    this.highlightGfx.clear();
    this.highlightGfx.lineStyle(3, 0xffdd22, alpha);
    this.highlightGfx.strokeRect(x, y, w, h);
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    this.currentHighlight = null;
    this.advanceHandler = null;
  }
}
