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

/**
 * Lobby carousel. Server pushes `match_listings` every second; we render
 * them as join-able cards. On `match_start` we transition to MatchScene.
 */
export class LobbyScene extends Phaser.Scene {
  private listings: MatchListing[] = [];
  private joinedMatchId: string | null = null;
  private cardContainers: Phaser.GameObjects.Container[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private warnText!: Phaser.GameObjects.Text;
  private activity: ActivityIndicator | null = null;
  private selector: BombermanSelector | null = null;

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
    this.cardContainers = [];

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
      this.rebuildCards();
    });

    socket.on('joined_match', (msg) => {
      this.joinedMatchId = msg.matchId;
      this.rebuildCards();
    });

    socket.on('match_start', () => {
      // Pass our matchId so MatchScene can ignore any `match_state` broadcasts
      // coming from a previous match whose socket.io room cleanup raced us.
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
    for (const c of this.cardContainers) c.destroy();
    this.cardContainers = [];
  }

  private rebuildCards(): void {
    for (const c of this.cardContainers) c.destroy();
    this.cardContainers = [];

    const { width, height } = this.scale;
    const count = this.listings.length;
    if (count === 0) return;

    const totalW = count * CARD_WIDTH + (count - 1) * CARD_GAP;
    const startX = (width - totalW) / 2 + CARD_WIDTH / 2;
    const y = height * 0.4;

    for (let i = 0; i < count; i++) {
      const card = this.createCard(startX + i * (CARD_WIDTH + CARD_GAP), y, this.listings[i]);
      this.cardContainers.push(card);
    }
  }

  private createCard(x: number, y: number, listing: MatchListing): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const cfg = listing.config;
    const isJoined = this.joinedMatchId === cfg.id;

    const bg = this.add.graphics();
    bg.fillStyle(0x1a1a2e, 0.95);
    bg.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    bg.lineStyle(2, isJoined ? 0x44ff88 : 0x333355, 1);
    bg.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
    container.add(bg);

    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 24, cfg.mapName, {
      fontSize: '18px', color: '#fff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.add(this.add.text(0, -CARD_HEIGHT / 2 + 56, 'Turn-based arena', {
      fontSize: '11px', color: '#888', fontFamily: 'monospace',
    }).setOrigin(0.5));

    container.add(this.add.text(0, 0, `Players: ${listing.playerCount}/${cfg.maxPlayers}`, {
      fontSize: '14px', color: '#ccc', fontFamily: 'monospace',
    }).setOrigin(0.5));

    const secs = Math.ceil(listing.countdown);
    const color = secs <= 5 ? '#ff4444' : secs <= 15 ? '#ffcc44' : '#ffffff';
    container.add(this.add.text(0, 40, `${secs}s`, {
      fontSize: '30px', color, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    if (isJoined) {
      container.add(this.add.text(0, CARD_HEIGHT / 2 - 56, 'JOINED - WAITING...', {
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
        this.rebuildCards();
      });
      container.add(unjoinBtn);
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
      container.add(btn);
    }

    return container;
  }
}
