import Phaser from 'phaser';
import { NetworkManager } from '../NetworkManager.ts';
import { type TreasureBundle, hasAnyTreasure } from '@shared/config/treasures.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { createBombIcon } from '../systems/BombIcons.ts';
import { NotificationBadge } from '../systems/NotificationBadge.ts';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import { FACTORY_IDS, projectedClaimable } from '@shared/types/factory.ts';
import { FACTORIES } from '@shared/config/factories.ts';
import type { BombType } from '@shared/types/bombs.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { tiersRemaining } from '@shared/utils/bomberman-stats.ts';
import type { OwnedBomberman } from '@shared/types/bomberman.ts';
import {
  ensureBombermanAnims,
  createShopBombermanSprite,
  preloadBombermanSpritesheets,
} from '../systems/BombermanAnimations.ts';

export interface MatchResultsData {
  outcome: 'escaped' | 'died' | 'lost';
  treasuresEarned: TreasureBundle;
  turnsPlayed: number;
  /** Bomb inventory kept (escaped only). Includes the bomb type so icons can
   *  render (mirroring the treasure tally). */
  inventory: Array<{ type: BombType; name: string; count: number }>;
  /** Number of enemy Bombermen killed this match. */
  kills: number;
  /** Name of the Bomberman who killed you (died only). */
  killerName: string | null;
  /** Name of your Bomberman (died only — shown as "R.I.P. <name>"). */
  myBombermanName: string | null;
  /** SP earned this match (banked on escape, 0 on death). */
  spEarned: number;
  /** Total SP this Bomberman gathered across its life — includes SP already
   *  spent on upgrades. Counted for memorial display on both escape and
   *  death screens, above the "Turns survived" line. */
  lifetimeSp: number;
  /** Visual identity of the local Bomberman for the hero block. Captured
   *  in-match so the screen still renders the right sprite on death (the
   *  OwnedBomberman is removed from the profile on death). */
  myBombermanTint?: number;
  myBombermanCharacter?: string;
}

/**
 * Results screen — shown after the match ends.
 *
 * Three outcomes:
 *  - Escaped: green title, details of gold + items + kills
 *  - Died: red title, shows who killed you
 *  - Lost: red title, shown when player exceeded turn limit
 */
export class ResultsScene extends Phaser.Scene {
  private results!: MatchResultsData;
  /** Pip graphics shown next to the [UPGRADE BOMBERMAN] button when at least
   *  one upgrade is affordable. Held so it can be cleared on profile updates
   *  (e.g. after the player applies an upgrade and nothing is affordable). */
  private upgradePip: Phaser.GameObjects.Graphics | null = null;
  /** Cached reference to the upgrade button so the pip can re-attach to it. */
  private upgradeBtn: Phaser.GameObjects.Text | null = null;
  private profileUnsub: (() => void) | null = null;

  constructor() {
    super({ key: 'ResultsScene' });
  }

  init(data: MatchResultsData): void {
    this.results = data ?? {
      outcome: 'died',
      treasuresEarned: {},
      turnsPlayed: 0,
      inventory: [],
      kills: 0,
      killerName: null,
      myBombermanName: null,
      spEarned: 0,
      lifetimeSp: 0,
    };
  }

  preload(): void {
    preloadBombermanSpritesheets(this);
  }

  create(): void {
    ensureBombermanAnims(this);
    this.events.once('shutdown', () => {
      this.profileUnsub?.();
      this.profileUnsub = null;
    });
    const { width, height } = this.scale;
    const r = this.results;

    // Background
    const bg = this.add.graphics();
    bg.fillStyle(0x0a0a14, 1);
    bg.fillRect(0, 0, width, height);

    // Title
    let title = '';
    let titleColor = '#ffffff';
    switch (r.outcome) {
      case 'escaped':
        title = 'ESCAPED';
        titleColor = '#44ff88';
        break;
      case 'died':
        title = 'DIED';
        titleColor = '#ff4444';
        break;
      case 'lost':
        title = 'LOST';
        titleColor = '#ff4444';
        break;
    }

    this.add.text(width / 2, height * 0.16, title, {
      fontSize: '48px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    // Subtitle line
    let subtitleY = height * 0.26;

    if (r.outcome === 'escaped') {
      // Section header style is shared between Treasures Gathered + Items
      // Kept so they read as parallel summaries.
      const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
        fontSize: '18px', color: '#c4a566', fontFamily: 'monospace', fontStyle: 'bold',
      };

      // --- SP hero block ---
      // Bomberman sprite + animated +N SP count-up + reaction headline.
      // Sits above the haul tallies so the SP banner is the first thing the
      // eye lands on after the ESCAPED title.
      subtitleY = this.renderSpHero(width / 2, subtitleY, r.spEarned, r.myBombermanName);
      subtitleY += 18;

      // Treasures earned this match — horizontal row with the same pulse as
      // the in-match HUD so a fat haul "thrums" on the results screen too.
      if (hasAnyTreasure(r.treasuresEarned)) {
        this.add.text(width / 2, subtitleY, 'Treasures Gathered', headerStyle).setOrigin(0.5);
        subtitleY += 32;

        // Build the widget centered horizontally. We need to know its width
        // before placing it, so build it once at (0,0), measure, then
        // position. The widget's container is repositioned via its options.
        // Easiest: instantiate, populate, then offset the container.
        const widget = new TreasureListWidget(this, {
          x: 0, // placeholder — corrected below
          y: subtitleY,
          anchor: 'top-left',
          direction: 'horizontal',
          iconScale: 1.0,
          rowGap: 14,
          fontSize: 18,
          staticRender: true,
          pulseOnCount: true,
        });
        widget.setBundleStatic(r.treasuresEarned);
        const rect = widget.getRect();
        // Re-anchor: shift container so the row is centered on screen.
        widget.setX(width / 2 - rect.w / 2);
        subtitleY += rect.h + 16;
      }

      // Items Kept — horizontal row of bomb icons + "xN" counts, mirroring
      // the Treasures Gathered layout above so the two tallies read as
      // parallel summaries.
      if (r.inventory.length > 0) {
        this.add.text(width / 2, subtitleY, 'Items Kept', headerStyle).setOrigin(0.5);
        subtitleY += 32;
        subtitleY += this.renderItemsKeptRow(width / 2, subtitleY, r.inventory) + 16;
      }

      // Kills (positioned below Items Kept so the haul tallies come first)
      if (r.kills > 0) {
        this.add.text(width / 2, subtitleY, `Bombermen eliminated: ${r.kills}`, {
          fontSize: '16px', color: '#ff8844', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      }

      // Lifetime SP — sum of all SP this Bomberman ever earned across all
      // matches, including SP already spent on upgrades. Memorial-style
      // total that sits right above the turns-survived line.
      subtitleY += 10;
      this.add.text(width / 2, subtitleY, `Lifetime SP: ${r.lifetimeSp}`, {
        fontSize: '16px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      subtitleY += 24;

      // Turns — sized to match Bombermen eliminated; keeps its dim gray so
      // the eye lands on the headline tallies first.
      this.add.text(width / 2, subtitleY, `Turns survived: ${r.turnsPlayed}`, {
        fontSize: '16px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);

    } else if (r.outcome === 'died') {
      // Dead-Bomberman hero block — mirrors the escape SP hero but with a
      // dead sprite + animated "R.I.P." in place of "+N SP".
      subtitleY = this.renderRipHero(width / 2, subtitleY, r.myBombermanName, r.myBombermanTint, r.myBombermanCharacter);
      subtitleY += 18;

      // Killed by
      if (r.killerName) {
        this.add.text(width / 2, subtitleY, `Killed by: ${r.killerName}`, {
          fontSize: '16px', color: '#ff8844', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      } else {
        this.add.text(width / 2, subtitleY, 'Killed in action', {
          fontSize: '16px', color: '#888888', fontFamily: 'monospace',
        }).setOrigin(0.5);
        subtitleY += 30;
      }

      // Lifetime SP memorial — same line slot as the escape variant. Even
      // though the Bomberman is dead, we still honor what they collected.
      subtitleY += 10;
      this.add.text(width / 2, subtitleY, `Lifetime SP: ${r.lifetimeSp}`, {
        fontSize: '14px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      subtitleY += 22;

      this.add.text(width / 2, subtitleY, `Turns survived: ${r.turnsPlayed}`, {
        fontSize: '13px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);

    } else {
      // Lost (turn limit exceeded)
      this.add.text(width / 2, subtitleY, 'Time ran out!', {
        fontSize: '20px', color: '#ff8844', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      subtitleY += 36;

      this.add.text(width / 2, subtitleY, `You stayed too long (${r.turnsPlayed} turns)`, {
        fontSize: '14px', color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }

    // Back button
    const playBtn = this.add.text(width / 2, height * 0.82, '[ BACK TO LOBBY ]', {
      fontSize: '24px', color: '#44aaff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    playBtn.on('pointerover', () => playBtn.setColor('#88ccff'));
    playBtn.on('pointerout', () => playBtn.setColor('#44aaff'));
    playBtn.on('pointerdown', () => this.backToLobby());

    // Shortcut row — Factory + Bombs Shop + (escaped only) Upgrade Bomberman,
    // all sharing the same chrome so the row reads as a parallel set of
    // detours before re-queueing.
    const shortcutY = height * 0.92;
    const shortcutGap = 24;
    const shortcutStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '16px', color: '#44aaff', fontFamily: 'monospace',
      backgroundColor: '#1a1a2a', padding: { x: 14, y: 6 },
    };
    const factoryBtn = this.add.text(0, 0, '[ FACTORY ]', shortcutStyle).setOrigin(0.5);
    const bombsBtn = this.add.text(0, 0, '[ BOMBS SHOP ]', shortcutStyle).setOrigin(0.5);
    const upgradeBtn = r.outcome === 'escaped'
      ? this.add.text(0, 0, '[ UPGRADE BOMBERMAN ]', shortcutStyle).setOrigin(0.5)
      : null;

    // Lay the row out left-to-right with gaps, centered on screen.
    const rowItems: Phaser.GameObjects.Text[] = upgradeBtn
      ? [factoryBtn, bombsBtn, upgradeBtn]
      : [factoryBtn, bombsBtn];
    const totalW = rowItems.reduce((sum, b) => sum + b.width, 0)
      + shortcutGap * (rowItems.length - 1);
    let cursor = width / 2 - totalW / 2;
    for (const btn of rowItems) {
      btn.setPosition(cursor + btn.width / 2, shortcutY);
      cursor += btn.width + shortcutGap;
    }

    for (const [btn, target] of [[factoryBtn, 'FactoryScene'], [bombsBtn, 'BombsShopScene']] as const) {
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setColor('#88ccff'));
      btn.on('pointerout', () => btn.setColor('#44aaff'));
      btn.on('pointerdown', () => {
        NetworkManager.getSocket().emit('leave_match');
        this.scene.start(target);
      });
    }

    if (upgradeBtn) {
      this.upgradeBtn = upgradeBtn;
      upgradeBtn.setInteractive({ useHandCursor: true });
      upgradeBtn.on('pointerover', () => upgradeBtn.setColor('#88ccff'));
      upgradeBtn.on('pointerout', () => upgradeBtn.setColor('#44aaff'));
      upgradeBtn.on('pointerdown', () => {
        const p = ProfileStore.get();
        if (!p || !p.equippedBombermanId) return;
        this.scene.launch('BombermanUpgradeScene', { ownedId: p.equippedBombermanId });
      });

      // Breadcrumb pip — green dot, shown when any upgrade track is
      // currently affordable. Refreshed on every profile update so the pip
      // disappears the moment the player applies an upgrade that empties
      // their affordable list.
      this.refreshUpgradePip();
      this.profileUnsub = ProfileStore.subscribe(() => this.refreshUpgradePip());
    }

    // Factory claim badge — only shown when claimable bombs > 0. The results
    // screen is short-lived so a one-shot compute is enough (no timer).
    const profile = ProfileStore.get();
    if (profile) {
      const now = Date.now();
      let claimable = 0;
      for (const id of FACTORY_IDS) {
        claimable += projectedClaimable(profile.factories[id], FACTORIES[id].cycleDurationMs, now);
      }
      if (claimable > 0) {
        const badgeX = factoryBtn.x + factoryBtn.displayWidth / 2 - 4;
        const badgeY = factoryBtn.y - factoryBtn.displayHeight / 2 + 4;
        new NotificationBadge(this, badgeX, badgeY).setCount(claimable);
      }
    }

    this.input.keyboard?.on('keydown-ESC', () => this.backToLobby());
  }

  /**
   * SP hero block — Bomberman sprite + animated "+N SP" count-up + reaction
   * message ("Bad" / "Not Bad" / "Nice" / "Excellent") that fades in after
   * the count finishes.
   *
   * Lays out as:
   *   [sprite] [SP text]
   *   [reaction message under the SP text, centered on the block]
   *
   * Reserves a fixed-height row so downstream content (Treasures Gathered)
   * doesn't reflow when the reaction message fades in.
   */
  private renderSpHero(
    centerX: number,
    topY: number,
    spEarned: number,
    nameFallback: string | null,
  ): number {
    const profile = ProfileStore.get();
    const equipped = profile?.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    const tint = equipped?.tint ?? 0xffffff;
    const character = equipped?.character ?? 'char4';
    const anim = equipped ? UiAnimLock.get(equipped.id) : 'idle';
    const name = equipped?.name ?? nameFallback ?? 'Bomberman';

    // Block geometry — sprite on the left, SP text on the right, reaction
    // centered beneath. SPRITE_BOX is the sprite's visual cell.
    const SPRITE_BOX = 80;
    const SP_TEXT_GAP = 18;
    const blockTop = topY;
    const spriteCY = blockTop + SPRITE_BOX / 2;

    // Name label ABOVE the sprite so the player reads identity first.
    this.add.text(centerX - 50, blockTop - 16, name, {
      fontSize: '12px', color: '#cfd6e6', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    // Sprite preview — uses the same builder as the Bomberman card on the
    // main menu so animation parity is automatic. Shifted down a touch to
    // leave room for the name above.
    const sprite = createShopBombermanSprite(this, 0, 0, tint, character, anim, 1.3);
    sprite.setPosition(centerX - 50, spriteCY + 6);

    // SP text — count-up tween from 0 → spEarned. Wallet-blue to match the
    // upgrade popup's SP cost color.
    const spText = this.add.text(centerX + SP_TEXT_GAP, spriteCY + 6, '+0 SP', {
      fontSize: '34px', color: '#5db5ff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);

    // Reaction message — sits directly UNDER the SP text (not under the
    // sprite). Hidden until the count-up tween completes.
    const reactionY = spriteCY + 6 + 24;
    const reactionText = this.add.text(centerX + SP_TEXT_GAP, reactionY, '', {
      fontSize: '18px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0).setAlpha(0);

    const COUNT_DURATION = Math.max(600, Math.min(1600, 600 + spEarned * 20));
    const tween = { value: 0 };
    this.tweens.add({
      targets: tween,
      value: spEarned,
      duration: COUNT_DURATION,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        spText.setText(`+${Math.round(tween.value)} SP`);
      },
      onComplete: () => {
        spText.setText(`+${spEarned} SP`);
        const { label, color } = this.spReaction(spEarned);
        reactionText.setText(label);
        reactionText.setColor(color);
        this.tweens.add({
          targets: reactionText,
          alpha: 1,
          y: reactionY - 4,
          duration: 380,
          ease: 'Back.easeOut',
        });
      },
    });

    // Total block height = name + sprite + reaction line.
    return blockTop + SPRITE_BOX + 28 + 12;
  }

  /**
   * Dead-Bomberman hero block — twin of `renderSpHero`. Shows the name
   * above a corpse sprite playing the one-shot death animation (stops on
   * the last frame), with an animated "R.I.P." in red to the right where
   * the "+N SP" sits on the escape variant.
   *
   * The R.I.P. letters fade in one-by-one (R → I → P) with a stagger so
   * the message lands as a slow funeral beat rather than a snap-in.
   */
  private renderRipHero(
    centerX: number,
    topY: number,
    nameFallback: string | null,
    tintArg: number | undefined,
    characterArg: string | undefined,
  ): number {
    // Visual identity — captured pre-death in MatchScene since the
    // OwnedBomberman is stripped from the profile on death.
    const tint = tintArg ?? 0xffffff;
    const character = characterArg ?? 'char4';
    const name = nameFallback ?? 'Bomberman';

    const SPRITE_BOX = 80;
    // Pushed right by an extra letter's worth (~22px at 34px monospace bold)
    // per the dead-screen tuning pass.
    const RIP_TEXT_GAP = 18 + 22;
    const blockTop = topY;
    const spriteCY = blockTop + SPRITE_BOX / 2;

    // Name label ABOVE the sprite — gravestone style. Slightly muted color
    // so it reads as memorial text.
    this.add.text(centerX - 50, blockTop - 16, name, {
      fontSize: '12px', color: '#a8a4b0', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    // Death sprite — plays the one-shot Die animation (registered with
    // repeat=false in BombermanAnimations.ts) so it lands on and holds the
    // last frame. Built directly instead of going through
    // createShopBombermanSprite because that helper's `animation` type
    // doesn't include 'death'.
    const deathTexture = `bomber_death_${character}`;
    const deathAnim = `bomber_death_${character}_down`;
    const sprite = this.add.sprite(centerX - 50, spriteCY + 6, deathTexture);
    sprite.setOrigin(0.5, 0.5);
    sprite.setScale(1.3 * 1.5);
    sprite.setTint(tint);
    if (this.anims.exists(deathAnim)) {
      sprite.play(deathAnim);
      sprite.anims.timeScale = 0.6;
    }

    // "R.I.P." — built letter-by-letter so we can fade each in on a stagger.
    // 34px matches the +N SP text on the escape variant exactly. Red
    // tombstone color. The text origin is left-baseline so each letter
    // appears at the right x without re-measuring.
    const LETTERS = ['R', '.', 'I', '.', 'P', '.'];
    const LETTER_STAGGER = 220; // ms between each *visible* letter
    const FADE_DURATION = 280;
    const ripStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '34px', color: '#ff4a4a', fontFamily: 'monospace', fontStyle: 'bold',
    };
    // Anchor at the same baseline as +N SP would sit.
    const ripX = centerX + RIP_TEXT_GAP;
    const ripY = spriteCY + 6;
    let cursorX = ripX;
    // Pre-compute each letter's width by adding it momentarily (Phaser needs
    // to lay out the text first), so we can place subsequent letters cleanly.
    // We then assign delays so the periods follow their letter almost
    // immediately (so "R" appears, then ".", then small pause, then "I" etc).
    let letterIdx = 0;
    for (let i = 0; i < LETTERS.length; i++) {
      const ch = LETTERS[i];
      const isPeriod = ch === '.';
      const t = this.add.text(cursorX, ripY, ch, ripStyle).setOrigin(0, 0.5).setAlpha(0);
      // Period hugs the previous letter; the next letter waits a full beat.
      // Each LETTER consumes one stagger slot; the period attached to it
      // shares the slot with a short tail.
      const delay = isPeriod ? letterIdx * LETTER_STAGGER + 80 : letterIdx * LETTER_STAGGER;
      this.tweens.add({
        targets: t,
        alpha: 1,
        duration: FADE_DURATION,
        delay,
        ease: 'Sine.easeOut',
      });
      cursorX += t.width;
      if (!isPeriod) letterIdx++;
    }

    return blockTop + SPRITE_BOX + 28 + 12;
  }

  /** Re-evaluate the affordable-upgrade pip. Drawn fresh each time so we
   *  don't have to track its position when the row reflows. */
  private refreshUpgradePip(): void {
    if (!this.upgradeBtn) return;
    this.upgradePip?.destroy();
    this.upgradePip = null;

    const profile = ProfileStore.get();
    if (!profile) return;
    const equipped = profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
    if (!equipped) return;
    if (!this.hasAffordableUpgrade(equipped, profile.coins, profile.treasures)) return;

    const pip = this.add.graphics();
    const px = this.upgradeBtn.x + this.upgradeBtn.displayWidth / 2 - 4;
    const py = this.upgradeBtn.y - this.upgradeBtn.displayHeight / 2 + 4;
    pip.fillStyle(0x44ff88, 1);
    pip.fillCircle(px, py, 5);
    pip.lineStyle(1, 0x0a3a18, 1);
    pip.strokeCircle(px, py, 5);
    this.upgradePip = pip;
  }

  /** Map SP earned to (reaction label, color) per the design tiers. */
  private spReaction(sp: number): { label: string; color: string } {
    if (sp <= 0)  return { label: 'Bad',       color: '#ff5a4a' };
    if (sp <= 30) return { label: 'Not Bad',   color: '#c4a566' };
    if (sp <= 80) return { label: 'Nice',      color: '#88ddff' };
    return         { label: 'Excellent!',     color: '#44ff88' };
  }

  /** True when any of the three upgrade tracks has a tier the player can
   *  afford right now (SP + coins + treasure). Drives the breadcrumb pip on
   *  the [ UPGRADE BOMBERMAN ] button. Mirrors the same check in
   *  BombermanSelector so the two pips agree. */
  private hasAffordableUpgrade(
    owned: OwnedBomberman,
    coins: number,
    treasures: Partial<Record<string, number>>,
  ): boolean {
    for (const track of ['cap', 'stack', 'hp'] as const) {
      if (tiersRemaining(owned, track) <= 0) continue;
      const applied = owned.upgrades?.[track] ?? 0;
      const tier = BALANCE.upgrades[track].tiers[applied];
      if (!tier) continue;
      if ((owned.sp ?? 0) < tier.sp) continue;
      if (coins < tier.coins) continue;
      const treasureType = BALANCE.upgrades[track].treasure;
      if ((treasures[treasureType] ?? 0) < tier.treasure) continue;
      return true;
    }
    return false;
  }

  /**
   * Renders the "Items Kept" row as horizontal cells of [icon][gap][xN],
   * centered on `centerX` at `topY`. Mirrors TreasureListWidget's horizontal
   * layout so the two tallies read as visually parallel. Returns the row
   * height in pixels so the caller can advance the cursor.
   */
  private renderItemsKeptRow(
    centerX: number,
    topY: number,
    inventory: MatchResultsData['inventory'],
  ): number {
    const iconPx = 32;
    const fontSize = 18;
    const iconTextGap = 6;
    const cellGap = 14;
    // Approximate cell width (icon + gap + count text). Count text is short
    // ("x12" worst case) so we budget ~3 chars at the font's em width.
    const cellW = iconPx + iconTextGap + fontSize * 2.5;
    const totalW = inventory.length * cellW + (inventory.length - 1) * cellGap;

    const container = this.add.container(centerX - totalW / 2, topY);
    inventory.forEach((item, idx) => {
      const cellLeft = idx * (cellW + cellGap);
      const icon = createBombIcon(this, cellLeft + iconPx / 2, iconPx / 2, item.type, iconPx);
      const text = this.add.text(cellLeft + iconPx + iconTextGap, iconPx / 2, `x${item.count}`, {
        fontSize: `${fontSize}px`, color: '#ffffff', fontFamily: 'monospace',
      }).setOrigin(0, 0.5);
      container.add([icon, text]);
    });
    return Math.max(iconPx, fontSize);
  }

  /**
   * Release the server-side session binding before leaving the scene. Without
   * this, the server still treats us as "in a match" until the room-wide
   * finalize fires, which silently rejects the next `join_match` attempt.
   */
  private backToLobby(): void {
    NetworkManager.getSocket().emit('leave_match');
    this.scene.start('LobbyScene');
  }
}
