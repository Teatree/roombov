import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { ActivityIndicator } from '../systems/ActivityIndicator.ts';
import { ensureBombermanAnims, createShopBombermanSprite, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { preloadTreasureIcons } from '../systems/TreasureIcons.ts';
import { attachTierInfoBadge } from '../systems/TierInfoBadge.ts';
import { effectiveMaxCustomSlots, effectiveStackSize } from '@shared/utils/bomberman-stats.ts';
import { NotificationBadge } from '../systems/NotificationBadge.ts';
import { FACTORY_IDS, projectedClaimable } from '@shared/types/factory.ts';
import { FACTORIES } from '@shared/config/factories.ts';
import type { PlayerProfile } from '@shared/types/player-profile.ts';

/**
 * Entry point after Boot. Connects to the server, authenticates, and offers
 * navigation to the shops or to the lobby. All shop/lobby scenes return here.
 */
export class MainMenuScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private coinsText!: Phaser.GameObjects.Text;
  private treasureList!: TreasureListWidget;
  private equippedContainer!: Phaser.GameObjects.Container;
  private unsubscribe: (() => void) | null = null;
  private activity: ActivityIndicator | null = null;
  private debugFeedback!: Phaser.GameObjects.Text;
  private factoryBadge: NotificationBadge | null = null;
  private factoryBadgeTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: 'MainMenuScene' });
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
    preloadTreasureIcons(this);
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

    // Treasures list — top-right of the menu, read-only mirror of the
    // persistent profile stash. Standardised horizontal layout shared with
    // BombsShopScene and FactoryScene; right-aligned via setX in
    // renderProfile() after the bundle is known.
    this.treasureList = new TreasureListWidget(this, {
      x: width - 20,
      y: 20,
      anchor: 'top-left',
      direction: 'horizontal',
      iconScale: 0.5,
      fontSize: 11,
      rowGap: 4,
      depth: 100,
    });

    this.equippedContainer = this.add.container(width / 2, 260);

    // Buttons
    const buttons: Array<[string, () => void]> = [
      ['[ PLAY ]', () => this.scene.start('LobbyScene')],
      ['[ BOMBERMAN SHOP ]', () => this.scene.start('BombermanShopScene')],
      ['[ BOMBS SHOP ]', () => this.scene.start('BombsShopScene')],
      ['[ FACTORY ]', () => this.scene.start('FactoryScene')],
      ['[ TUTORIAL ]', () => this.scene.start('MatchScene', { mode: 'tutorial' })],
    ];

    let factoryBtn: Phaser.GameObjects.Text | null = null;
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
      if (label === '[ FACTORY ]') factoryBtn = btn;
    }

    // Factory claim badge — red dot on the Factory button's top-right corner.
    // Shows the total bombs the player can claim from all factories combined;
    // hidden when zero. Refreshes on profile updates + a 5s timer so cycles
    // that complete while the menu is open light up the badge promptly.
    if (factoryBtn) {
      const badgeX = factoryBtn.x + factoryBtn.displayWidth / 2 - 4;
      const badgeY = factoryBtn.y - factoryBtn.displayHeight / 2 + 4;
      this.factoryBadge = new NotificationBadge(this, badgeX, badgeY);
      this.refreshFactoryBadge();
      this.factoryBadgeTimer = this.time.addEvent({
        delay: 5000,
        loop: true,
        callback: () => this.refreshFactoryBadge(),
      });
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
    this.factoryBadge?.destroy();
    this.factoryBadge = null;
    this.factoryBadgeTimer?.remove();
    this.factoryBadgeTimer = null;
    const socket = NetworkManager.getSocket();
    socket.off('connect');
    socket.off('disconnect');
  }

  /** Sum of projected claimable bombs across all 4 factories. */
  private refreshFactoryBadge(): void {
    if (!this.factoryBadge) return;
    const profile = ProfileStore.get();
    if (!profile) {
      this.factoryBadge.setCount(0);
      return;
    }
    this.factoryBadge.setCount(totalClaimable(profile));
  }

  private renderProfile(): void {
    const profile = ProfileStore.get();
    if (!profile) return;

    if (this.debugFeedback && this.debugFeedback.text === 'Resetting...') {
      this.debugFeedback.setText('Profile reset ✓').setColor('#44ff88');
      this.time.delayedCall(1500, () => this.debugFeedback.setText(''));
    }

    this.coinsText.setText(`Coins: ${profile.coins}`);
    this.treasureList.setBundle(profile.treasures);
    // Horizontal layout extends rightward from anchor — right-align by
    // computing the rendered width and shifting X to (rightEdge - width).
    const tRect = this.treasureList.getRect();
    if (tRect && tRect.w > 0) {
      this.treasureList.setX(this.scale.width - 20 - tRect.w);
    }
    this.refreshFactoryBadge();

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

    // Tier info badge at the top-right of the sprite preview. Hover reveals
    // HP / Bomb Slots / Stack Size for this Bomberman.
    attachTierInfoBadge(this, this.equippedContainer, {
      x: 38, y: -36,
      tier: equipped.tier,
      maxCustomSlots: effectiveMaxCustomSlots(equipped),
      stackSize: effectiveStackSize(equipped),
    });

    const label = this.add.text(0, 70, `${equipped.name ?? equipped.tier.replace('_', ' ')}`, {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.equippedContainer.add(label);
  }
}

/** Sum of bombs claimable from every factory right now (projected forward). */
function totalClaimable(profile: PlayerProfile): number {
  const now = Date.now();
  let total = 0;
  for (const id of FACTORY_IDS) {
    total += projectedClaimable(profile.factories[id], FACTORIES[id].cycleDurationMs, now);
  }
  return total;
}
