import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { trackScreen } from './sceneAnalytics.ts';
import { ProfileStore } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';
import { preloadBombIcons } from '../systems/BombIcons.ts';
import { preloadBombermanSpritesheets, ensureBombermanAnims } from '../systems/BombermanAnimations.ts';
import { designViewport, fitSceneToViewport } from '../util/responsiveScene.ts';
import { effectiveMaxCustomSlots, effectiveStackSize } from '@shared/utils/bomberman-stats.ts';
import type { MatchListing } from '@shared/types/match.ts';
import { COL, CSS, FONT, urgencyCol, urgencyHex, urgencyOf } from '../design/tokens.ts';
import { addTabLabel, drawNotchedPanel, drawSegmentBar } from '../util/pixelPanel.ts';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 280;
const CARD_GAP = 24;

/** Design box the scene lays out against; the camera scales it to fit short
 *  landscape-phone viewports. Width is generous (centered content); height is
 *  the natural stack: top titles → mid card row (center 0.4·H, half-height
 *  140) → bottom Bomberman selector band (height−130) and status bar. */
const DESIGN_W = 600;
const DESIGN_H = 740;

const ROLL_IN_MS = 280;
const ROLL_OUT_MS = 260;
const REFLOW_MS = 280;
const ROLL_IN_STAGGER_MS = 70;

/** What a card's action button area shows. 'none' = you're joined to a
 *  DIFFERENT match (can't join two). 'join-disabled' = no Bomberman equipped. */
type ActionState = 'join' | 'join-disabled' | 'unjoin' | 'none';

interface CardView {
  matchId: string;
  container: Phaser.GameObjects.Container;
  /** Live countdown text — updated in place each rebuild without rebuilding
   *  the card, so animations don't restart per second. */
  countdownText: Phaser.GameObjects.Text;
  /** Live player-count text — updated in place. */
  playerCountText: Phaser.GameObjects.Text;
  /** Border outline — re-styled when isJoined flips. */
  borderGfx: Phaser.GameObjects.Graphics;
  /** Segment bar under the countdown — redrawn per second (urgency + fill). */
  segmentGfx: Phaser.GameObjects.Graphics;
  /** Highest countdown observed for this card — denominator for the bar fill. */
  maxCountdown: number;
  /** True once a fly-off tween has been kicked off; view will be destroyed. */
  leaving: boolean;
  /** Set if this card was rendered as joined last time, so we can detect
   *  a state-change and re-stroke the border. */
  isJoined: boolean;
  /** Which action button the area currently shows. The area is rebuilt only
   *  when this changes — driven by the GLOBAL joined state, not just this
   *  card's, so a card created while joined elsewhere still gets its JOIN
   *  button back after you leave that match (the disappearing-JOIN bug). */
  actionState: ActionState;
  /** Container for the action button area (JOIN / UNJOIN / empty). */
  actionContainer: Phaser.GameObjects.Container;
}

/**
 * Lobby carousel. Server pushes `match_listings` every second; we render
 * them as join-able cards with diff-based add/remove animations:
 *   - Cards roll in from the off-screen right when first added.
 *   - Cards fly up + fade when removed (match started OR auto-expired).
 *   - Reflow tweens reposition surviving cards smoothly.
 *
 * The countdown + player count update in place without rebuilding the card
 * so the animations don't restart every second.
 */
export class LobbyScene extends Phaser.Scene {
  private listings: MatchListing[] = [];
  private joinedMatchId: string | null = null;
  /** Map id of the joined match. Captured at `joined_match` time because the
   *  server removes a started match from the carousel before broadcasting
   *  `match_start`, so the listing isn't around to look up later. */
  private joinedMatchMapId: string | null = null;
  private cardViews: Map<string, CardView> = new Map();
  private statusText!: Phaser.GameObjects.Text;
  private warnText!: Phaser.GameObjects.Text;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;
  /** "Equip Bombs" shortcut under the card row — see buildEquipBombsButton. */
  private equipBombsBtn: Phaser.GameObjects.Text | null = null;
  private equipBombsTween: Phaser.Tweens.Tween | null = null;
  private profileUnsub: (() => void) | null = null;
  /** True until the first `match_listings` arrives, used to stagger the
   *  initial roll-in cascade. */
  private firstRender = true;

  /** Rescale the camera-fit on viewport resize (no-op on desktop). */
  private readonly onResize = (): void => fitSceneToViewport(this, DESIGN_W, DESIGN_H);

  constructor() {
    super({ key: 'LobbyScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
  }

  create(): void {
    trackScreen(this, 'Lobby');
    ensureBombermanAnims(this);
    this.events.once('shutdown', this.shutdown, this);
    this.joinedMatchId = null;
    this.listings = [];
    this.cardViews = new Map();
    this.firstRender = true;

    const { width } = this.scale;
    const { layoutH } = designViewport(this, DESIGN_W, DESIGN_H);
    this.cameras.main.setBackgroundColor(CSS.bg);

    this.add.text(width / 2, 44, 'LOBBY', {
      fontSize: '36px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5).setShadow(5, 5, CSS.stageFrame, 0, true, true);

    this.add.text(width / 2, 86, 'CHOOSE A MATCH', {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0.5).setLetterSpacing(4);

    this.warnText = this.add.text(width / 2, 110, '', {
      fontSize: '13px', color: CSS.orange, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    this.statusText = this.add.text(width / 2, layoutH - 20, 'connecting…', {
      fontSize: '12px', color: CSS.statusGreen, fontFamily: FONT.silk,
    }).setOrigin(0.5);

    const backBtn = this.add.text(20, layoutH - 30, '[ < MENU ]', {
      fontSize: '14px', color: CSS.dim, fontFamily: FONT.silk,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor(CSS.text));
    backBtn.on('pointerout', () => backBtn.setColor(CSS.dim));
    backBtn.on('pointerdown', () => {
      if (this.joinedMatchId) NetworkManager.getSocket().emit('leave_match');
      this.scene.start('MainMenuScene');
    });

    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.joinedMatchId) NetworkManager.getSocket().emit('leave_match');
      this.scene.start('MainMenuScene');
    });

    this.activity = new ActivityIndicator(this);

    const socket = NetworkManager.connect();
    socket.emit('match_listings_request');

    socket.on('connect', () => {
      this.statusText.setText(`connected · ${socket.id}`);
      this.statusText.setColor(CSS.statusGreen);
    });
    if (socket.connected) {
      this.statusText.setText(`connected · ${socket.id}`);
      this.statusText.setColor(CSS.statusGreen);
    }
    socket.on('disconnect', () => {
      this.statusText.setText('disconnected');
      this.statusText.setColor(CSS.red);
    });

    socket.on('match_listings', (msg) => {
      this.listings = msg.listings;
      this.renderCards();
    });

    socket.on('joined_match', (msg) => {
      this.joinedMatchId = msg.matchId;
      // Capture the joined match's mapId now — the listing will be gone
      // from `this.listings` by the time `match_start` fires (the server
      // pulls full matches out of the carousel before starting them).
      const joinedListing = this.listings.find(l => l.config.id === msg.matchId);
      this.joinedMatchMapId = joinedListing?.config.mapId ?? null;
      this.renderCards();
    });

    socket.on('match_start', () => {
      console.log(`[Lobby] match_start → matchId=${this.joinedMatchId} mapId=${this.joinedMatchMapId}`);
      this.scene.start('MatchScene', {
        matchId: this.joinedMatchId,
        mapId: this.joinedMatchMapId,
      });
    });

    // Warn if no Bomberman is equipped
    const profile = ProfileStore.get();
    if (!profile?.equippedBombermanId) {
      this.warnText.setText('NO BOMBERMAN EQUIPPED — VISIT THE SHOP FIRST');
    }

    // Bomberman selector at the bottom — equip from the lobby
    this.selector = new BombermanSelector(this, layoutH - 130);
    this.selector.create();

    // "Equip Bombs" shortcut — sits in the band between the card row's
    // bottom (≈ cardY + 140) and the selector's header label.
    this.buildEquipBombsButton(layoutH);

    fitSceneToViewport(this, DESIGN_W, DESIGN_H);
    this.scale.on('resize', this.onResize, this);
  }

  /**
   * Shortcut button under the conveyor belt: shows how many bombs the
   * player's stockpile holds and how many loadout slots the equipped
   * Bomberman has free, and jumps to the Bombs Shop with back/Esc wired to
   * return HERE (BombsShopScene honors `backScene` init data). Pulses
   * (alpha yoyo) while the loadout is under 25% of total bomb capacity so
   * an under-equipped player notices it before queueing. Refreshed from
   * ProfileStore — the selector's equip roundtrip ends in a `profile`
   * push, so switching Bombermen retargets the counts automatically.
   */
  private buildEquipBombsButton(layoutH: number): void {
    const { width } = this.scale;
    const btnY = layoutH * 0.4 + CARD_HEIGHT / 2 + 28;
    this.equipBombsBtn = this.add.text(width / 2, btnY, '', {
      fontSize: '14px', color: CSS.blue, fontFamily: FONT.silk,
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.equipBombsBtn.on('pointerover', () => this.equipBombsBtn?.setColor('#9bd0ff'));
    this.equipBombsBtn.on('pointerout', () => this.equipBombsBtn?.setColor(CSS.blue));
    this.equipBombsBtn.on('pointerdown', () => {
      if (this.joinedMatchId) NetworkManager.getSocket().emit('leave_match');
      this.scene.start('BombsShopScene', { backScene: 'LobbyScene' });
    });

    this.profileUnsub = ProfileStore.subscribe(() => this.refreshEquipBombsButton());
    this.refreshEquipBombsButton();
  }

  /** Re-derive the button label + pulse from the current profile. */
  private refreshEquipBombsButton(): void {
    const btn = this.equipBombsBtn;
    if (!btn) return;
    const profile = ProfileStore.get();
    const bm = profile?.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (!profile || !bm) {
      btn.setVisible(false);
      this.stopEquipBombsPulse();
      return;
    }
    btn.setVisible(true);

    const stockTotal = Object.values(profile.bombStockpile ?? {})
      .reduce((sum: number, n) => sum + (n ?? 0), 0);
    // Total free bomb space = capacity (slots × stack size) minus carried
    // bombs — counts both unfilled slots and the headroom in partial stacks.
    // Rock is not a custom slot so it never counts toward fill.
    const capacity = effectiveMaxCustomSlots(bm) * effectiveStackSize(bm);
    const fill = bm.inventory.slots.reduce((sum, s) => sum + (s?.count ?? 0), 0);
    const freeSpace = Math.max(0, capacity - fill);
    btn.setText(`[ EQUIP BOMBS — ${stockTotal} IN STOCK · SPACE FOR ${freeSpace} ]`);

    // Pulse while the loadout sits under 25% of total bomb capacity.
    if (fill * 4 < capacity) {
      // In-flight guard — profile pushes arrive every few seconds and must
      // not restart (or stack) the tween.
      if (!this.equipBombsTween) {
        this.equipBombsTween = this.tweens.add({
          targets: btn, alpha: 0.45, duration: 600, yoyo: true, repeat: -1,
        });
      }
    } else {
      this.stopEquipBombsPulse();
    }
  }

  private stopEquipBombsPulse(): void {
    this.equipBombsTween?.remove();
    this.equipBombsTween = null;
    this.equipBombsBtn?.setAlpha(1);
  }

  shutdown(): void {
    this.scale.off('resize', this.onResize, this);
    const socket = NetworkManager.getSocket();
    socket.off('connect');
    socket.off('disconnect');
    socket.off('match_listings');
    socket.off('joined_match');
    socket.off('match_start');
    this.activity?.destroy();
    this.activity = null;
    this.selector?.destroy();
    this.selector = null;
    // A leaked store listener would fire after shutdown and touch a
    // destroyed Text — unsubscribe first, then drop the tween + ref.
    this.profileUnsub?.();
    this.profileUnsub = null;
    this.equipBombsTween?.remove();
    this.equipBombsTween = null;
    this.equipBombsBtn = null;
    for (const view of this.cardViews.values()) view.container.destroy();
    this.cardViews.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Card row — diff and animate from the listings array
  // ───────────────────────────────────────────────────────────────────────────

  private renderCards(): void {
    const nextIds = this.listings.map(l => l.config.id);

    // Removals: views that aren't in the latest listings get the fly-off
    // animation. Both "match started" and "match auto-expired" go through
    // this path — server just removes the listing.
    for (const [id, view] of this.cardViews) {
      if (view.leaving) continue;
      if (!nextIds.includes(id)) this.animateCardLeaving(id);
    }

    // Additions and updates.
    let addedIndex = 0;
    for (let i = 0; i < this.listings.length; i++) {
      const listing = this.listings[i];
      const existing = this.cardViews.get(listing.config.id);

      if (!existing || existing.leaving) {
        const delay = this.firstRender ? addedIndex * ROLL_IN_STAGGER_MS : 0;
        this.createAndArriveCard(listing, i, this.listings.length, delay);
        addedIndex++;
      } else {
        this.updateCardInPlace(existing, listing);
      }
    }

    // Reflow surviving cards to their new positions.
    for (let i = 0; i < this.listings.length; i++) {
      const listing = this.listings[i];
      const view = this.cardViews.get(listing.config.id);
      if (!view || view.leaving) continue;
      const targetX = this.cardTargetX(i, this.listings.length);
      if (Math.abs(view.container.x - targetX) > 1) {
        this.tweens.add({
          targets: view.container, x: targetX,
          duration: REFLOW_MS, ease: 'Quad.easeOut',
        });
      }
    }

    this.firstRender = false;
  }

  private cardTargetX(i: number, count: number): number {
    const totalW = count * CARD_WIDTH + Math.max(0, count - 1) * CARD_GAP;
    const startX = (this.scale.width - totalW) / 2;
    return startX + i * (CARD_WIDTH + CARD_GAP) + CARD_WIDTH / 2;
  }

  private createAndArriveCard(listing: MatchListing, index: number, count: number, delay: number): void {
    // Use the design height (not the live viewport) so the 40%-down card row
    // lands in the right place inside the scaled design box on short viewports.
    const { layoutH } = designViewport(this, DESIGN_W, DESIGN_H);
    const cardY = layoutH * 0.4;
    const startX = this.scale.width + CARD_WIDTH;
    const targetX = this.cardTargetX(index, count);

    const view = this.buildCard(startX, cardY, listing);
    view.container.setAlpha(0);
    this.cardViews.set(listing.config.id, view);

    this.tweens.add({
      targets: view.container,
      x: targetX,
      alpha: 1,
      duration: ROLL_IN_MS,
      ease: 'Quad.easeOut',
      delay,
    });
  }

  private animateCardLeaving(id: string): void {
    const view = this.cardViews.get(id);
    if (!view || view.leaving) return;
    view.leaving = true;
    view.container.list.forEach((c) => {
      const obj = c as Phaser.GameObjects.GameObject & { input?: { enabled: boolean } };
      if (obj.input) obj.disableInteractive?.();
    });
    this.tweens.add({
      targets: view.container,
      y: view.container.y - 80,
      alpha: 0,
      duration: ROLL_OUT_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        view.container.destroy();
        this.cardViews.delete(id);
      },
    });
  }

  private buildCard(x: number, y: number, listing: MatchListing): CardView {
    const container = this.add.container(x, y);
    const cfg = listing.config;
    const isJoined = this.joinedMatchId === cfg.id;
    const halfW = CARD_WIDTH / 2;
    const halfH = CARD_HEIGHT / 2;

    const borderGfx = this.add.graphics();
    this.drawCardBorder(borderGfx, isJoined);
    container.add(borderGfx);

    // Mode rides the top border as a tab label (green Normal / orange special).
    const modeText = cfg.allowBots ? 'NORMAL' : 'NO BOTS OR SCAVS';
    const modeColor = cfg.allowBots ? CSS.green : CSS.orange;
    const tab = addTabLabel(this, -halfW, -halfH, CARD_WIDTH, modeText, { side: 'left', color: modeColor });
    container.add([tab.bg, tab.label]);

    container.add(this.add.text(0, -halfH + 28, cfg.mapName, {
      fontSize: '15px', color: CSS.text, fontFamily: FONT.press,
    }).setOrigin(0.5));

    const playerCountText = this.add.text(0, -halfH + 58, `PLAYERS ${listing.playerCount}/${cfg.maxPlayers}`, {
      fontSize: '12px', color: CSS.faint, fontFamily: FONT.silk,
    }).setOrigin(0.5).setLetterSpacing(1);
    container.add(playerCountText);

    const secs = Math.ceil(listing.countdown);
    const u = urgencyOf(secs);
    const countdownText = this.add.text(0, -18, `${secs}`, {
      fontSize: '30px', color: urgencyHex(u), fontFamily: FONT.press,
    }).setOrigin(0.5);
    container.add(countdownText);

    // Segment bar — the conveyor position readout (time made physical).
    const segmentGfx = this.add.graphics();
    container.add(segmentGfx);

    const actionContainer = this.add.container(0, 0);
    container.add(actionContainer);

    const view: CardView = {
      matchId: cfg.id,
      container,
      countdownText,
      playerCountText,
      borderGfx,
      segmentGfx,
      maxCountdown: Math.max(1, secs),
      leaving: false,
      isJoined,
      actionState: this.desiredActionState(isJoined),
      actionContainer,
    };

    this.drawSegments(view, secs);
    this.populateActionArea(view, listing);
    return view;
  }

  private drawCardBorder(g: Phaser.GameObjects.Graphics, isJoined: boolean): void {
    g.clear();
    drawNotchedPanel(g, -CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, {
      fill: COL.panel, border: isJoined ? COL.green : COL.border, borderWidth: 2, notch: 8,
    });
  }

  /** Redraw the 14-segment time bar for the current seconds remaining. */
  private drawSegments(view: CardView, secs: number): void {
    view.maxCountdown = Math.max(view.maxCountdown, secs);
    const u = urgencyOf(secs);
    const segW = 13, gap = 2, segments = 14;
    const totalW = segments * segW + (segments - 1) * gap;
    view.segmentGfx.clear();
    drawSegmentBar(view.segmentGfx, -totalW / 2, 12, {
      segments, segW, segH: 10, gap,
      fraction: secs / view.maxCountdown,
      color: urgencyCol(u),
    });
  }

  /** Apply per-second updates to a kept card without rebuilding the whole
   *  thing. Re-styles the border + action area only when joined-state flips. */
  private updateCardInPlace(view: CardView, listing: MatchListing): void {
    const cfg = listing.config;
    const isJoined = this.joinedMatchId === cfg.id;

    view.playerCountText.setText(`PLAYERS ${listing.playerCount}/${cfg.maxPlayers}`);

    const secs = Math.ceil(listing.countdown);
    const u = urgencyOf(secs);
    view.countdownText.setText(`${secs}`);
    view.countdownText.setColor(urgencyHex(u));
    this.drawSegments(view, secs);

    // Border follows this card's own joined state.
    if (view.isJoined !== isJoined) {
      this.drawCardBorder(view.borderGfx, isJoined);
      view.isJoined = isJoined;
    }

    // Action button follows the GLOBAL state (joined here / elsewhere / not at
    // all, and whether a Bomberman is equipped). Rebuild only when it changes
    // so we don't churn the button every tick.
    const desired = this.desiredActionState(isJoined);
    if (view.actionState !== desired) {
      view.actionContainer.removeAll(true);
      this.populateActionArea(view, listing);
    }
  }

  /**
   * A card-width notched button. Variants: 'neutral' (panel2 fill, borderHi
   * border, hover→green), 'gold' (gold fill, hover→white border), 'danger'
   * (panel2 fill, red border + red label, never filled). Returns a setVariant
   * hook so the JOIN button can promote to gold on urgency.
   */
  private makeCardButton(
    parent: Phaser.GameObjects.Container, yLocal: number, w: number, h: number,
    label: string, fontPx: number, onClick: (() => void) | null,
  ): { setVariant: (v: 'neutral' | 'gold' | 'danger') => void; container: Phaser.GameObjects.Container } {
    const c = this.add.container(0, yLocal);
    parent.add(c);
    const g = this.add.graphics();
    const txt = this.add.text(0, 0, label, { fontSize: `${fontPx}px`, color: CSS.text, fontFamily: FONT.press }).setOrigin(0.5);
    c.add([g, txt]);
    let variant: 'neutral' | 'gold' | 'danger' = 'neutral';
    let hover = false;
    const redraw = () => {
      g.clear();
      if (variant === 'gold') {
        drawNotchedPanel(g, -w / 2, -h / 2, w, h, { fill: COL.gold, border: hover ? 0xffffff : COL.goldEdge, borderWidth: 2, notch: 6 });
        txt.setColor(CSS.goldText);
      } else if (variant === 'danger') {
        drawNotchedPanel(g, -w / 2, -h / 2, w, h, { fill: COL.panel2, border: COL.red, borderWidth: 2, notch: 6 });
        txt.setColor(CSS.red);
      } else {
        drawNotchedPanel(g, -w / 2, -h / 2, w, h, { fill: COL.panel2, border: hover ? COL.green : COL.borderHi, borderWidth: 2, notch: 6 });
        txt.setColor(CSS.text);
      }
    };
    redraw();
    if (onClick) {
      // Hit area anchored at (0,0) — Phaser container input-local coords come
      // from the rendered top-left, not the centered origin (a centered rect
      // would make only the top-left quadrant clickable).
      c.setSize(w, h).setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains);
      c.on('pointerover', () => { hover = true; this.input.setDefaultCursor('pointer'); redraw(); });
      c.on('pointerout', () => { hover = false; c.y = yLocal; this.input.setDefaultCursor('default'); redraw(); });
      c.on('pointerdown', () => { c.y = yLocal + 2; });
      c.on('pointerup', () => { c.y = yLocal; onClick(); });
    }
    return { setVariant: (v) => { variant = v; redraw(); }, container: c };
  }

  /** The action button this card should show, given the current global state. */
  private desiredActionState(isJoined: boolean): ActionState {
    if (isJoined) return 'unjoin';
    if (this.joinedMatchId !== null) return 'none';
    return ProfileStore.get()?.equippedBombermanId ? 'join' : 'join-disabled';
  }

  private populateActionArea(view: CardView, listing: MatchListing): void {
    const cfg = listing.config;
    const ac = view.actionContainer;
    const state = this.desiredActionState(view.isJoined);
    view.actionState = state;
    if (state === 'unjoin') {
      // Same geometry as JOIN so the button doesn't shrink / shift when joined.
      this.makeCardButton(ac, CARD_HEIGHT / 2 - 38, CARD_WIDTH - 36, 44, 'UNJOIN', 16, () => {
        NetworkManager.getSocket().emit('leave_match');
        this.joinedMatchId = null;
        this.renderCards();
      }).setVariant('danger');
    } else if (state === 'join' || state === 'join-disabled') {
      const join = this.makeCardButton(ac, CARD_HEIGHT / 2 - 38, CARD_WIDTH - 36, 44, 'JOIN', 16,
        state === 'join' ? () => NetworkManager.getSocket().emit('join_match', { matchId: cfg.id }) : null);
      if (state === 'join-disabled') join.container.setAlpha(0.55);
    }
    // 'none' → empty action area (joined to a different match).
  }
}
