import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';

/**
 * Entry point after Boot. Connects to the server, authenticates, and offers
 * navigation to the shops or to the lobby. All shop/lobby scenes return here.
 */
export class MainMenuScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private coinsText!: Phaser.GameObjects.Text;
  private equippedContainer!: Phaser.GameObjects.Container;
  private unsubscribe: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private debugFeedback!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainMenuScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
  }

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    ensureBombermanAnims(this);
    const { width, height } = this.scale;

    this.add.text(width / 2, 60, 'BOMBERMAN', {
      fontSize: '56px', color: '#e0e0e0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(width / 2, 110, 'Main Menu', {
      fontSize: '18px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.coinsText = this.add.text(width / 2, 160, 'Coins: --', {
      fontSize: '22px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.equippedContainer = this.add.container(width / 2, 260);

    // Buttons
    const buttons: Array<[string, () => void]> = [
      ['[ PLAY ]', () => this.scene.start('LobbyScene')],
      ['[ BOMBERMAN SHOP ]', () => this.scene.start('BombermanShopScene')],
      ['[ BOMBS SHOP ]', () => this.scene.start('BombsShopScene')],
    ];

    for (let i = 0; i < buttons.length; i++) {
      const [label, action] = buttons[i];
      const btn = this.add.text(width / 2, 380 + i * 60, label, {
        fontSize: '24px',
        color: '#44aaff',
        fontFamily: 'monospace',
        backgroundColor: '#222244',
        padding: { x: 24, y: 10 },
      }).setOrigin(0.5);

      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setColor('#88ccff'));
      btn.on('pointerout', () => btn.setColor('#44aaff'));
      btn.on('pointerdown', action);
    }

    // Debug reset — dev-only helper. Wipes the profile clean on the server.
    const debugBtn = this.add.text(width / 2, height - 80, '[ DEBUG: RESET PROFILE ]', {
      fontSize: '14px',
      color: '#ff6644',
      fontFamily: 'monospace',
      backgroundColor: '#2a1818',
      padding: { x: 14, y: 6 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    debugBtn.on('pointerover', () => debugBtn.setColor('#ffaa88'));
    debugBtn.on('pointerout', () => debugBtn.setColor('#ff6644'));
    debugBtn.on('pointerdown', () => {
      this.debugFeedback.setText('Resetting...').setColor('#ffcc44');
      NetworkManager.track('debug_reset', 'profile');
      NetworkManager.getSocket().emit('debug_reset', { confirm: true });
    });

    this.debugFeedback = this.add.text(width / 2, height - 48, '', {
      fontSize: '12px', color: '#888', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.activity = new ActivityIndicator(this);

    this.statusText = this.add.text(width / 2, height - 20, 'Connecting...', {
      fontSize: '12px', color: '#666666', fontFamily: 'monospace',
    }).setOrigin(0.5);

    const socket = NetworkManager.connect();
    if (socket.connected) this.statusText.setText(`Connected: ${socket.id}`);
    socket.on('connect', () => {
      this.statusText.setText(`Connected: ${socket.id}`);
      this.statusText.setColor('#44ff88');
    });
    socket.on('disconnect', () => {
      this.statusText.setText('Disconnected');
      this.statusText.setColor('#ff4444');
    });

    this.unsubscribe = ProfileStore.subscribe(() => this.renderProfile());
    this.renderProfile();
  }

  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.activity?.destroy();
    this.activity = null;
    const socket = NetworkManager.getSocket();
    socket.off('connect');
    socket.off('disconnect');
  }

  private renderProfile(): void {
    const profile = ProfileStore.get();
    if (!profile) return;

    if (this.debugFeedback && this.debugFeedback.text === 'Resetting...') {
      this.debugFeedback.setText('Profile reset ✓').setColor('#44ff88');
      this.time.delayedCall(1500, () => this.debugFeedback.setText(''));
    }

    this.coinsText.setText(`Coins: ${profile.coins}`);

    // Clear and rebuild the equipped preview
    this.equippedContainer.removeAll(true);
    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (!equipped) {
      const msg = this.add.text(0, 0, 'No Bomberman equipped', {
        fontSize: '14px', color: '#888', fontFamily: 'monospace',
      }).setOrigin(0.5);
      this.equippedContainer.add(msg);
      return;
    }

    // Equipped Bomberman preview. Character variant is persistent on the
    // owned Bomberman; the UI animation (idle/idle3/walk) is stable-until-match
    // via UiAnimLock — refreshes only after playing a match with this one.
    const preview = createShopBombermanSprite(
      this, 0, 0, equipped.tint, equipped.character, UiAnimLock.get(equipped.id), 1,
    );
    this.equippedContainer.add(preview);

    const label = this.add.text(0, 70, `${equipped.name ?? equipped.tier.replace('_', ' ')}`, {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.equippedContainer.add(label);
  }
}
