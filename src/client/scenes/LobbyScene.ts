import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { BombermanSelector } from '../systems/BombermanSelector.ts';
import { preloadBombIcons } from '../systems/BombIcons.ts';
import { preloadBombermanSpritesheets, ensureBombermanAnims } from '../systems/BombermanAnimations.ts';
import type { MatchListing } from '@shared/types/match.ts';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 280;
const CARD_GAP = 24;

const ROLL_IN_MS = 280;
const ROLL_OUT_MS = 260;
const REFLOW_MS = 280;
const ROLL_IN_STAGGER_MS = 70;

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
  /** True once a fly-off tween has been kicked off; view will be destroyed. */
  leaving: boolean;
  /** Set if this card was rendered as joined last time, so we can detect
   *  a state-change and rebuild the action button area. */
  isJoined: boolean;
  /** Container for the action button area (JOIN / JOINED+UNJOIN). Rebuilt
   *  in place when joined-state flips. */
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
  private cardViews: Map<string, CardView> = new Map();
  private statusText!: Phaser.GameObjects.Text;
  private warnText!: Phaser.GameObjects.Text;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;
  /** True until the first `match_listings` arrives, used to stagger the
   *  initial roll-in cascade. */
  private firstRender = true;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadBombIcons(this);
  }

  create(): void {
    ensureBombermanAnims(this);
    this.events.once('shutdown', this.shutdown, this);
    this.joinedMatchId = null;
    this.listings = [];
    this.cardViews = new Map();
    this.firstRender = true;

    const { width, height } = this.scale;

    this.add.text(width / 2, 40, 'LOBBY', {
      fontSize: '40px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, 84, 'Choose a match', {
      fontSize: '14px', color: '#888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.warnText = this.add.text(width / 2, 108, '', {
      fontSize: '14px', color: '#ff8844', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.statusText = this.add.text(width / 2, height - 20, 'Connecting...', {
      fontSize: '12px', color: '#666', fontFamily: 'monospace',
    }).setOrigin(0.5);

    const backBtn = this.add.text(20, height - 30, '[ < MENU ]', {
      fontSize: '16px', color: '#888', fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#ccc'));
    backBtn.on('pointerout', () => backBtn.setColor('#888'));
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
      this.statusText.setText(`Connected: ${socket.id}`);
      this.statusText.setColor('#44ff88');
    });
    if (socket.connected) {
      this.statusText.setText(`Connected: ${socket.id}`);
      this.statusText.setColor('#44ff88');
    }
    socket.on('disconnect', () => {
      this.statusText.setText('Disconnected');
      this.statusText.setColor('#ff4444');
    });

    socket.on('match_listings', (msg) => {
      this.listings = msg.listings;
      this.renderCards();
    });

    socket.on('joined_match', (msg) => {
      this.joinedMatchId = msg.matchId;
      this.renderCards();
    });

    socket.on('match_start', () => {
      this.scene.start('MatchScene', { matchId: this.joinedMatchId });
    });

    // Warn if no Bomberman is equipped
    const profile = ProfileStore.get();
    if (!profile?.equippedBombermanId) {
      this.warnText.setText('⚠ No Bomberman equipped — visit the shop first');
    }

    // Bomberman selector at the bottom — equip from the lobby
    this.selector = new BombermanSelector(this, height - 130);
    this.selector.create();
  }

  shutdown(): void {
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
    const cardY = this.scale.height * 0.4;
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

    const borderGfx = this.add.graphics();
    this.drawCardBorder(borderGfx, isJoined);
    container.add(borderGfx);

    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 24, cfg.mapName, {
      fontSize: '18px', color: '#fff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    const playerCountText = this.add.text(0, 0, `Players: ${listing.playerCount}/${cfg.maxPlayers}`, {
      fontSize: '14px', color: '#ccc', fontFamily: 'monospace',
    }).setOrigin(0.5);
    container.add(playerCountText);

    const secs = Math.ceil(listing.countdown);
    const countdownText = this.add.text(0, 40, `${secs}s`, {
      fontSize: '30px', color: this.countdownColor(secs), fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(countdownText);

    const actionContainer = this.add.container(0, 0);
    container.add(actionContainer);
    this.populateActionArea(actionContainer, listing, isJoined);

    return {
      matchId: cfg.id,
      container,
      countdownText,
      playerCountText,
      borderGfx,
      leaving: false,
      isJoined,
      actionContainer,
    };
  }

  private drawCardBorder(g: Phaser.GameObjects.Graphics, isJoined: boolean): void {
    g.clear();
    g.fillStyle(0x1a1a2e, 0.95);
    g.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    g.lineStyle(2, isJoined ? 0x44ff88 : 0x333355, 1);
    g.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
  }

  private countdownColor(secs: number): string {
    return secs <= 5 ? '#ff4444' : secs <= 15 ? '#ffcc44' : '#ffffff';
  }

  /** Apply per-second updates to a kept card without rebuilding the whole
   *  thing. Re-styles the border and rebuilds the action area only when the
   *  joined-state flips. */
  private updateCardInPlace(view: CardView, listing: MatchListing): void {
    const cfg = listing.config;
    const isJoined = this.joinedMatchId === cfg.id;

    view.playerCountText.setText(`Players: ${listing.playerCount}/${cfg.maxPlayers}`);

    const secs = Math.ceil(listing.countdown);
    view.countdownText.setText(`${secs}s`);
    view.countdownText.setColor(this.countdownColor(secs));

    if (view.isJoined !== isJoined) {
      this.drawCardBorder(view.borderGfx, isJoined);
      view.actionContainer.removeAll(true);
      this.populateActionArea(view.actionContainer, listing, isJoined);
      view.isJoined = isJoined;
    }
  }

  private populateActionArea(actionContainer: Phaser.GameObjects.Container, listing: MatchListing, isJoined: boolean): void {
    const cfg = listing.config;
    if (isJoined) {
      actionContainer.add(this.add.text(0, CARD_HEIGHT / 2 - 56, 'JOINED - WAITING...', {
        fontSize: '13px', color: '#44ff88', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
      const unjoinBtn = this.add.text(0, CARD_HEIGHT / 2 - 30, '[ UNJOIN ]', {
        fontSize: '14px', color: '#ff6644', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#2a1818', padding: { x: 16, y: 6 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      unjoinBtn.on('pointerover', () => unjoinBtn.setColor('#ffaa88'));
      unjoinBtn.on('pointerout', () => unjoinBtn.setColor('#ff6644'));
      unjoinBtn.on('pointerdown', () => {
        NetworkManager.getSocket().emit('leave_match');
        this.joinedMatchId = null;
        this.renderCards();
      });
      actionContainer.add(unjoinBtn);
    } else if (this.joinedMatchId === null) {
      const profile = ProfileStore.get();
      const canJoin = !!profile?.equippedBombermanId;
      const btn = this.add.text(0, CARD_HEIGHT / 2 - 40, '[ JOIN ]', {
        fontSize: '18px', color: canJoin ? '#44aaff' : '#555', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#222244', padding: { x: 24, y: 8 },
      }).setOrigin(0.5);
      if (canJoin) {
        btn.setInteractive({ useHandCursor: true });
        btn.on('pointerover', () => btn.setColor('#88ccff'));
        btn.on('pointerout', () => btn.setColor('#44aaff'));
        btn.on('pointerdown', () => {
          NetworkManager.getSocket().emit('join_match', { matchId: cfg.id });
        });
      }
      actionContainer.add(btn);
    }
  }
}
