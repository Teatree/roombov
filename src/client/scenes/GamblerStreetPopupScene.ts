import Phaser from 'phaser';
import type { GamblerStreetBetResultMsg } from '@shared/types/messages.ts';
import type { BetTier } from '@shared/config/gambler-street.ts';

const TUTORIAL_GUY_KEY = 'gambler_face_default';
const TUTORIAL_GUY_PATH = 'sprites/tutorial_guy.png';

const POPUP_W = 480;
const POPUP_H = 480;
const REVEAL_DURATION_MS = 3000;

interface InitData {
  tier: BetTier;
}

/**
 * "Which hand?" modal scene.
 *
 * Runs in parallel above GamblerStreetScene. Has three phases:
 *   1. ASK   — shows tutorial_guy + "Which hand?" + LEFT / RIGHT / CLOSE
 *   2. WAIT  — once player picks a hand, fires `gambler_bet_resolved` to the
 *              parent scene and waits for `gambler_bet_response` back.
 *   3. REVEAL — shows "well done" or "better luck" + confetti, auto-closes.
 */
export class GamblerStreetPopupScene extends Phaser.Scene {
  private root!: Phaser.GameObjects.Container;
  private dim!: Phaser.GameObjects.Rectangle;
  private titleText!: Phaser.GameObjects.Text;
  private subtitle: Phaser.GameObjects.Container | null = null;
  private leftBtn!: Phaser.GameObjects.Container;
  private rightBtn!: Phaser.GameObjects.Container;
  private closeBtn!: Phaser.GameObjects.Text;
  private waitingForResponse = false;
  private resolved = false;
  private confettiEmitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];

  constructor() {
    super({ key: 'GamblerStreetPopupScene' });
  }

  preload(): void {
    if (!this.textures.exists(TUTORIAL_GUY_KEY)) {
      this.load.image(TUTORIAL_GUY_KEY, TUTORIAL_GUY_PATH);
    }
    if (!this.textures.exists('confetti_particle')) {
      this.makeConfettiTexture();
    }
  }

  init(_data: InitData): void {
    void _data;
    this.waitingForResponse = false;
    this.resolved = false;
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    this.events.on('gambler_bet_response', this.onBetResponse, this);

    const { width, height } = this.scale;
    this.dim = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.6)
      .setInteractive(); // swallows clicks behind the modal

    this.root = this.add.container(width / 2, height / 2);
    const bg = this.add.rectangle(0, 0, POPUP_W, POPUP_H, 0x18181f, 1)
      .setStrokeStyle(2, 0x6b5536, 1);
    this.root.add(bg);

    const face = this.add.image(0, -POPUP_H / 2 + 130, TUTORIAL_GUY_KEY);
    face.setDisplaySize(220, 220);
    face.setTint(0xb8a890);
    this.root.add(face);

    this.titleText = this.add.text(0, 50, 'Which hand?', {
      fontSize: '32px',
      color: '#c4a566',
      fontFamily: 'serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.root.add(this.titleText);

    // Buttons
    this.leftBtn = this.makeHandButton(-110, 130, 'LEFT', () => this.pickHand('left'));
    this.rightBtn = this.makeHandButton(110, 130, 'RIGHT', () => this.pickHand('right'));
    this.root.add(this.leftBtn);
    this.root.add(this.rightBtn);

    // Close (×) button — top-right of popup
    this.closeBtn = this.add.text(POPUP_W / 2 - 18, -POPUP_H / 2 + 12, '✕', {
      fontSize: '24px',
      color: '#888',
      fontFamily: 'monospace',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    this.closeBtn.on('pointerover', () => this.closeBtn.setColor('#fff'));
    this.closeBtn.on('pointerout', () => this.closeBtn.setColor('#888'));
    this.closeBtn.on('pointerdown', () => this.cancel());
    this.root.add(this.closeBtn);

    // Confetti is built on demand inside fireConfetti() — different palettes
    // for win vs loss, and a one-shot explode burst rather than a continuous
    // stream. Building per-fire makes the per-particle tint trivially correct.
  }

  shutdown(): void {
    this.events.off('gambler_bet_response', this.onBetResponse, this);
    for (const e of this.confettiEmitters) e.destroy();
    this.confettiEmitters = [];
  }

  private pickHand(hand: 'left' | 'right'): void {
    if (this.waitingForResponse || this.resolved) return;
    this.waitingForResponse = true;

    // Disable buttons visually
    this.leftBtn.setAlpha(hand === 'left' ? 1.0 : 0.3);
    this.rightBtn.setAlpha(hand === 'right' ? 1.0 : 0.3);
    this.titleText.setText('...');

    // Notify the parent scene to send the bet.
    const parent = this.scene.get('GamblerStreetScene');
    parent.events.emit('gambler_bet_resolved', { pickedHand: hand });
  }

  private cancel(): void {
    if (this.resolved) return;
    if (this.waitingForResponse) return;
    this.resolved = true;
    const parent = this.scene.get('GamblerStreetScene');
    parent.events.emit('gambler_bet_cancelled');
    this.scene.stop();
  }

  private onBetResponse = (msg: GamblerStreetBetResultMsg) => {
    this.waitingForResponse = false;
    if (this.resolved) return;
    this.resolved = true;

    if (!msg.ok || !msg.outcome) {
      // Server refused the bet (insufficient treasure, expired, etc.).
      this.titleText.setText('They walked away.');
      this.titleText.setColor('#a85454');
      this.time.delayedCall(2000, () => this.scene.stop());
      return;
    }

    const o = msg.outcome;
    if (o.won) {
      this.titleText.setText('Well done!');
      this.titleText.setColor('#88c44a');
      this.showWinSubtitle(o.coinsGained);
      this.fireConfetti('gold');
    } else {
      this.titleText.setText('Better luck next time, chum.');
      this.titleText.setColor('#c44848');
      this.titleText.setFontSize(24);
      this.fireConfetti('grey');
    }
    // Hide the buttons during reveal
    this.leftBtn.setVisible(false);
    this.rightBtn.setVisible(false);
    this.closeBtn.setVisible(false);

    this.time.delayedCall(REVEAL_DURATION_MS, () => this.scene.stop());
  };

  /**
   * Render "You won N coins" beneath the title. The "N coins" portion is
   * coloured the same yellow as the persistent coins display (#ffd944);
   * the surrounding "You won " stays the default subtitle colour.
   */
  private showWinSubtitle(coins: number): void {
    const prefix = this.add.text(0, 100, 'You won ', {
      fontSize: '22px',
      color: '#e0d4b8',
      fontFamily: 'serif',
    }).setOrigin(1, 0.5);
    const won = this.add.text(0, 100, `${coins} coins`, {
      fontSize: '22px',
      color: '#ffd944',
      fontFamily: 'serif',
      fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    // Center the pair around x=0: both meet at x = (prefix.w - won.w) / 2.
    const meetX = (prefix.width - won.width) / 2;
    prefix.setX(meetX);
    won.setX(meetX);
    this.subtitle = this.add.container(0, 0, [prefix, won]);
    this.root.add(this.subtitle);
  }

  /**
   * Burst confetti from both sides of the popup, spewing up-and-inward so
   * the streams cross over the popup before gravity pulls them down. Colors
   * are baked per-particle via the `tint` EmitterOp callback (passing an
   * array to `setParticleTint` was rendering everything black, since that
   * API only takes a single value — that was the previous bug).
   */
  private fireConfetti(palette: 'gold' | 'grey'): void {
    const colors = palette === 'gold'
      ? [0xffd944, 0xffaa44, 0xffe88a, 0xc4a566, 0xffe4a0, 0xff8844]
      : [0xaaaaaa, 0x888888, 0x666666, 0x555555, 0x444444];

    const { width, height } = this.scale;
    const burstY = height / 2; // popup center — confetti rises from edges
    const leftX = width / 2 - POPUP_W / 2;
    const rightX = width / 2 + POPUP_W / 2;
    const burstCount = 36;

    const baseConfig = {
      lifespan: 1800,
      gravityY: 800,
      scale: { start: 1.4, end: 0.6 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 1, end: 0 },
      speed: { min: 350, max: 600 },
      quantity: 1,
      frequency: -1, // explode-only — no continuous stream
      tint: { onEmit: () => Phaser.Math.RND.pick(colors) },
      emitting: false,
    } as const;

    const left = this.add.particles(leftX, burstY, 'confetti_particle', {
      ...baseConfig,
      // Up-and-right: -100° (up + slight right) to -45° (mostly right + up).
      angle: { min: -100, max: -45 },
    });
    const right = this.add.particles(rightX, burstY, 'confetti_particle', {
      ...baseConfig,
      // Up-and-left: -135° (mostly left + up) to -80° (up + slight left).
      angle: { min: -135, max: -80 },
    });

    left.explode(burstCount);
    right.explode(burstCount);
    this.confettiEmitters.push(left, right);

    // Auto-cleanup after the longest particle has died.
    this.time.delayedCall(2400, () => {
      left.destroy();
      right.destroy();
      this.confettiEmitters = this.confettiEmitters.filter(e => e !== left && e !== right);
    });
  }

  private makeHandButton(
    x: number, y: number,
    label: string,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const w = 160;
    const h = 56;
    const bg = this.add.rectangle(0, 0, w, h, 0x2a4a55, 1)
      .setStrokeStyle(1, 0x000000, 0.9);
    c.add(bg);
    const txt = this.add.text(0, 0, label, {
      fontSize: '20px',
      color: '#e0d4b8',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    c.add(txt);

    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3a6e7a, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2a4a55, 1));
    bg.on('pointerdown', () => {
      bg.setFillStyle(0x2a4a55, 1);
      onClick();
    });
    return c;
  }

  /** Generate the small white square used for confetti particles. Per-particle
   *  tint is applied at emit time so the same texture serves every palette. */
  private makeConfettiTexture(): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 8, 8);
    g.generateTexture('confetti_particle', 8, 8);
    g.destroy();
  }
}
