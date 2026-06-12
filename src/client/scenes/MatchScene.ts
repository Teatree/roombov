import Phaser from 'phaser';
import { ProfileStore, UiAnimLock } from '../ClientState.ts';
import type { MatchBackend } from '../backends/MatchBackend.ts';
import { SocketMatchBackend } from '../backends/SocketMatchBackend.ts';
import { TutorialMatchBackend, TUTORIAL_PLAYER_ID } from '../backends/TutorialMatchBackend.ts';
import type { TutorialOverlayScene } from './TutorialOverlayScene.ts';
import type { TooltipScene } from './TooltipScene.ts';
import type { TooltipKey } from '../tooltip/tooltipData.ts';
import { MapRenderer, preloadTiledMap } from '../systems/MapRenderer.ts';
import { FogRenderer } from '../systems/FogRenderer.ts';
import { BombRenderer, decalDecayAlpha } from '../systems/BombRenderer.ts';
import { BombermanSpriteSystem, deathAnimationDurationMs } from '../systems/BombermanSpriteSystem.ts';
const SWORD_FADE_MS = BombermanSpriteSystem.SWORD_FADE_MS;
import { ensureBombermanAnims, preloadBombermanSpritesheets } from '../systems/BombermanAnimations.ts';
import { loadMapById } from '@shared/maps/map-loader.ts';
import { findPath, type PathTile } from '@shared/systems/Pathfinding.ts';
import { resolveBombTrigger, bombAffectedTiles } from '@shared/systems/BombResolver.ts';
import type { MapData } from '@shared/types/map.ts';
import type { MatchState } from '@shared/types/match.ts';
import type { BombermanState } from '@shared/types/bomberman.ts';
import { defaultStatsForTier } from '@shared/config/bomberman-tiers.ts';
import type { BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';
import { BALANCE } from '@shared/config/balance.ts';
import { HIDDEN_FEATURES } from '@shared/config/features.ts';
import { hashStringToInt } from '@shared/utils/seeded-random.ts';
import { preloadBombIcons, bombIconFrame } from '../systems/BombIcons.ts';
import { BombShopTooltip, bombTooltipInfoFor, type BombTooltipInfo } from '../systems/BombShopTooltip.ts';
import { preloadTreasureIcons, TREASURE_TEXTURE_KEY, treasureIconFrame } from '../systems/TreasureIcons.ts';
import { TreasureListWidget } from '../systems/TreasureListWidget.ts';
import { ShieldRenderer } from '../systems/ShieldRenderer.ts';
import { MobileControls, type MobileHooks } from '../systems/MobileControls.ts';
import { isMobileDevice } from '../util/isMobile.ts';
import {
  type TreasureType,
  type TreasureBundle,
  TREASURE_TYPES,
  TREASURE_DISPLAY_NAMES,
  hasAnyTreasure,
} from '@shared/config/treasures.ts';
import type { MatchEndMsg } from '@shared/types/messages.ts';

/**
 * Click targeting mode.
 *   - idle: nothing staged
 *   - pathing: the user clicked a floor tile; we computed a BFS path and
 *     will auto-send one move action per turn until the path is consumed
 *   - aim: a bomb slot is selected; the next floor click stages a throw
 */
type InputMode =
  | { kind: 'idle' }
  | { kind: 'pathing'; path: PathTile[] }
  | { kind: 'aim'; slotIndex: number; targetX: number | null; targetY: number | null };

const SLOT_SIZE = 64;
const SLOT_GAP = 8;

// Top-right HUD column geometry. Shared by buildHud() and the resize relayout
// (layoutResponsiveHud) so the coin row / treasure list / keys counter stay
// pinned to the right edge at any viewport width.
const COIN_ICON_SIZE = 28;
const COIN_ROW_Y = 14;
const KEY_ICON = 22;
const HUD_RIGHT_MARGIN = 20;

/** Bombs that may be thrown onto ANY tile (incl. walls) — their throw target
 *  snaps to whatever tile is under the cursor. Every other bomb is "restricted"
 *  and snaps to the nearest floor tile (see snapThrowTarget). */
const THROW_ANYWHERE_BOMBS = new Set<BombType>(['flare', 'phosphorus', 'fart_escape']);

/** Landed bombs of these types do NOT show the filled "danger" ghost zone:
 *  they detonate on impact / are non-damaging, so there's no delayed threat to
 *  telegraph. (The aiming-preview outline still shows for all bombs.) */
const LANDED_GHOST_EXCLUDED = new Set<BombType>([
  'phosphorus', 'flare', 'contact', 'molotov', 'fart_escape', 'ender_pearl', 'cluster_bomb',
]);
// Slot count is per-Bomberman now (tier-driven). Use `localTotalSlotCount`
// in instance methods. The `_LOCAL_FALLBACK_*` constants below are used
// before the local Bomberman is known (e.g., scene init, before first state).
const FREE_TIER_DEFAULT = defaultStatsForTier('free');
const LOCAL_FALLBACK_CUSTOM_SLOTS = FREE_TIER_DEFAULT.maxCustomSlots;
const LOCAL_FALLBACK_TOTAL_SLOTS = 1 + LOCAL_FALLBACK_CUSTOM_SLOTS;
const LOCAL_FALLBACK_STACK_SIZE = FREE_TIER_DEFAULT.stackSize;

/**
 * Active match scene.
 *
 * Server is authoritative — we receive MatchState snapshots and render them.
 * Clicks on floor tiles compute a BFS path that the client walks one tile
 * per turn. Clicks on bomb slots (bottom HUD) switch into aim mode; a
 * subsequent tile click stages a throw. Clicking self cancels any staged
 * action.
 */
export class MatchScene extends Phaser.Scene {
  /** Source of authoritative match events. Swapped to TutorialMatchBackend
   *  in tutorial mode; everything else (rendering, input, HUD) is identical. */
  private backend: MatchBackend | null = null;
  /** 'network' drives a real server match. 'tutorial' runs a scripted
   *  single-player scenario via the TutorialMatchBackend. */
  private mode: 'network' | 'tutorial' = 'network';
  private mapData: MapData | null = null;
  private mapRenderer: MapRenderer | null = null;
  private fogRenderer: FogRenderer | null = null;
  private shieldRenderer: ShieldRenderer | null = null;
  private shieldLayer!: Phaser.GameObjects.Container;
  private shieldShardLayer!: Phaser.GameObjects.Container;
  private bombRenderer: BombRenderer | null = null;
  private state: MatchState | null = null;
  private myPlayerId: string | null = null;
  private inputMode: InputMode = { kind: 'idle' };
  /** Which bomb slot is armed for throwing. Purely visual — movement continues
   *  until the player actually clicks a tile to throw at. */
  private selectedSlot: number | null = null;
  /** True on touch devices: swaps the PC click-to-act input for the mobile
   *  Move/Attack button + drag-selector scheme (see MobileControls). */
  private isMobile = false;
  /** Mobile-only: the always-selected bomb slot (Rock = 0 by default). Drives
   *  the persistent armed-slot border in the tray. Distinct from `selectedSlot`,
   *  which is set only while actively aiming so the ghost/trajectory preview
   *  doesn't show outside attack-selection. */
  private mobileArmedSlot = 0;
  /** Mobile-only touch control system (buttons + selector + pan/zoom). */
  private mobileControls: MobileControls | null = null;
  /** HUD size multiplier. 1 on desktop; 0.5 on mobile so the in-match HUD
   *  (tray, HP bar, top readouts, buttons, guide) is half-size and leaves the
   *  small landscape screen to the game. Set in create() from `isMobile`. */
  private hudScale = 1;
  /** Per-instance tray slot size/gap = SLOT_SIZE/SLOT_GAP × hudScale. Used by
   *  every tray render + hit-test path so they stay in sync. */
  private slotSize = SLOT_SIZE;
  private slotGap = SLOT_GAP;
  /** Top-right HUD icon sizes × hudScale (coin circle + key image). Used by
   *  buildHud, layoutResponsiveHud and getRightHudBottomY so they stay in sync. */
  private coinIconSize = COIN_ICON_SIZE;
  private keyIconSize = KEY_ICON;
  private lastPhase: string | null = null;
  /** Set on the first middle/right mouse click of a match. Once true, the
   *  per-frame `centerOn` in update() stops running so the player can pan
   *  freely. Resets to false in create() for each new match. */
  private cameraManualOverride = false;
  /** Tutorial-only: when true, the per-frame centerOn() in update() is
   *  skipped entirely so scripted `panCamera` destinations actually stick.
   *  The tutorial director toggles this via `setCameraLocked`. Without
   *  this flag, the default follow-player behavior snaps the camera back
   *  on the next frame and the tutorial's "cinematic" pans never land. */
  private cameraTutorialLocked = false;
  private cameraDragging = false;
  /** Suppresses the browser right-click menu so right-drag pan works. Stored
   *  as a field so shutdown() can remove the listener by reference. */
  private preventContext = (e: Event): void => { e.preventDefault(); };
  private cameraDragStartX = 0;
  private cameraDragStartY = 0;
  private cameraScrollStartX = 0;
  private cameraScrollStartY = 0;
  /** Authoritative matchId this scene is bound to (from LobbyScene). Any
   *  `match_state` broadcast with a different matchId is ignored — guards
   *  against stale socket.io room subscriptions from a previous match. */
  private myMatchId: string | null = null;
  private myDeathAt: number | null = null;
  /** Wall-clock time at which the local player's escape event fired.
   *  Set when the `escaped` TurnEvent arrives for this player. Used to
   *  (a) avoid double-transitioning when `match_end` eventually arrives and
   *  (b) drive the delayed jump to the Results screen without waiting for
   *  the room-wide `match_end` broadcast, which only fires once everyone
   *  else is also out. */
  private myEscapeAt: number | null = null;
  /** Treasures snapshot captured from the local player's `escaped` event.
   *  The server drains `bm.treasures` on escape (to avoid double-credit at
   *  finalize), so by the time `transitionToResults` reads `me.treasures`
   *  it's already empty. Snapshotting here preserves the haul for the
   *  Results screen. */
  private myEscapeTreasures: TreasureBundle | null = null;
  /** Running tally of treasures the LOCAL player has picked up this match.
   *  Accumulated client-side from every `treasures_collected` / `body_looted`
   *  event that names the local player. Used as the bulletproof fallback for
   *  the Results screen — independent of any server snapshot, network
   *  ordering, or `match_end` payload. */
  private myTreasureTally: TreasureBundle = {};
  private myKills = 0;
  private myKillerName: string | null = null;
  /** Equipped Bomberman's banked SP captured at match-start. Used as the
   *  fallback when `match_end.spEarned` is missing/0 — earnings = current
   *  owned.sp − initial owned.sp. The server's authoritative `match_end`
   *  payload is still preferred when present and non-zero. */
  private mySpAtStart = 0;
  /** Equipped Bomberman's lifetime SP captured at match-start. Survives
   *  the death case where the OwnedBomberman is removed from the profile
   *  before `match_end` fires. */
  private myLifetimeSpAtStart = 0;
  /** Equipped Bomberman's display name captured at match-start. Survives
   *  the death case where the OwnedBomberman is stripped from the profile
   *  before the Results scene reads from it. */
  private myBombermanNameAtStart: string | null = null;
  /** Equipped Bomberman's visual identity captured at match-start. Used to
   *  render the dead-screen corpse correctly even though the OwnedBomberman
   *  is gone from the profile by match-end. */
  private myBombermanTintAtStart: number | undefined = undefined;
  private myBombermanCharacterAtStart: string | undefined = undefined;
  /** Latest in-match SP accumulator for the local Bomberman — mirrored from
   *  every `match_state` update so we can compute lifetime SP even on death
   *  when the server-side snapshot machinery misses this match's accruals. */
  private myInMatchSp = 0;
  private tiledInfo: ReturnType<typeof preloadTiledMap> = null;
  /** Dedicated HUD camera that ignores world zoom/pan. */
  private hudCamera: Phaser.Cameras.Scene2D.Camera | null = null;

  // World-space display layers (draw order enforced by setDepth).
  // Spec: top → bottom render order is
  //   Explosion Burst > Bomberman (alive) > Bombs > Corpse > Blood >
  //     Ender Pearl Decal > Chests > Doors/Hatches > Scorch Decal > Map
  // Depths:
  //   0   map (tilemap layers and tileset graphics)
  //   5   scorchDecalLayer (explosion/burn scorch marks) — ground level, UNDER
  //       doors/hatches/chests so those objects sit on top of the burn scars.
  //       Dimmed by the lesser-fog overlay like the map itself; drawn opaque
  //       enough that the scars stay clearly visible (not faded to nothing)
  //       once a tile drops to seen-dim.
  //   10  doors + escape hatch sprites
  //   15  chests
  //   22  pearlDecalLayer (ender pearl teleport decals)
  //   25  bloodDecalLayer (blood splatter)
  //   28  corpseLayer (dead Bomberman sprites)
  //   35  bombLayer (persistent bombs, throw arcs, fire, flare flames, fuse nums)
  //   50  fog of war overlay
  //   60  path line
  //   100 bombermanLayer (alive Bomberman sprites + overlays)
  //   105 entitiesLayer (coin bags, pickups, bodies — pure rebuild-each-tick)
  //   120 explosionLayer (shockwaves + ender pearl FROM puff, always through fog)
  //   150 highlights (aim/move targets)
  //   1000+ HUD
  private entitiesLayer!: Phaser.GameObjects.Container;
  private bombermanLayer!: Phaser.GameObjects.Container;
  private corpseLayer!: Phaser.GameObjects.Container;
  private bombLayer!: Phaser.GameObjects.Container;
  private explosionLayer!: Phaser.GameObjects.Container;
  private scorchDecalLayer!: Phaser.GameObjects.Container;
  private pearlDecalLayer!: Phaser.GameObjects.Container;
  private bloodDecalLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private highlightGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;
  /** Explosion-ghost overlay. Depth 0.5 → just above the map "Tiles" layer but
   *  below decoration layers, decals, bombs, corpses, and Bombermen. Fog
   *  (depth 50) occludes it, so ghosts never show through black fog. Holds both
   *  the "landed bomb" filled zones (everyone) and the local "aiming" outline. */
  private ghostGraphics!: Phaser.GameObjects.Graphics;
  /** Dotted throw-trajectory arc (fillCircle dots only). Kept on its own
   *  Graphics so its fills never interleave with highlightGraphics' arc/path
   *  strokes — mixing fillCircle with beginPath on one Graphics breaks rendering. */
  private trajectoryGraphics!: Phaser.GameObjects.Graphics;
  private bombermanSpriteSystem: BombermanSpriteSystem | null = null;

  // HUD — each element is created as a scene root object with
  // setScrollFactor(0) so Phaser's native input system handles hit-testing.
  // Avoids the container+scrollFactor interaction bug that previously
  // prevented bomb slot clicks from registering.
  private timerText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  /** Tiny red label shown just right of the turn counter while the local
   *  player is standing on a broken (already-used) escape hatch. */
  private brokenHatchText: Phaser.GameObjects.Text | null = null;
  /** Top-left HP bar widget. Replaces the old "HP X/Y" text and the per-sprite
   *  pips above the bomberman's head. `hpBarContainer` is jittered on hurt;
   *  `hpBarFill` is redrawn with one segment per `maxHp` pip, filled when
   *  `displayedHp` covers them. `hpBarLastHp` tracks the previously-drawn HP
   *  so a hit can spawn the lost segment as a falling Graphics that fades. */
  private hpBarContainer: Phaser.GameObjects.Container | null = null;
  private hpBarLabel: Phaser.GameObjects.Text | null = null;
  private hpBarFill: Phaser.GameObjects.Graphics | null = null;
  private hpBarLastHp: number = -1;
  private hpBarLastMax: number = -1;
  /** Geometry constants for the HP bar, reused by getHudRect() so the
   *  tutorial highlight rect tracks the actual widget. */
  private static readonly HP_BAR_X = 20;
  private static readonly HP_BAR_Y = 14;
  private static readonly HP_BAR_LABEL_W = 36;
  /** Bar width / height — width reduced 40%, height reduced 20% from the
   *  first pass. `HP_BAR_H` stays even so the bar's vertical center matches
   *  the label's (the label is anchored origin-Y 0.5 at HP_BAR_H/2). */
  private static readonly HP_BAR_W = 132;
  private static readonly HP_BAR_H = 16;
  private treasureList!: TreasureListWidget;
  /** Top-right HUD coin counter (NEW_META §2). Always visible regardless
   *  of amount, pinned above the treasure list. */
  private coinHudIcon: Phaser.GameObjects.Graphics | null = null;
  private coinHudText: Phaser.GameObjects.Text | null = null;
  /** Top bar background + exit-tutorial button refs, kept so the responsive
   *  relayout (layoutResponsiveHud) can re-stretch / re-anchor them on resize. */
  private topBarBg: Phaser.GameObjects.Graphics | null = null;
  private exitTutorialBtn: Phaser.GameObjects.Text | null = null;
  /** Running tally of coins the local player has picked up this match.
   *  Client-authoritative for the Results screen — same pattern as
   *  myTreasureTally. */
  private myCoinTally = 0;
  private slotRects: Phaser.GameObjects.Rectangle[] = [];
  private slotLabelTexts: Phaser.GameObjects.Text[] = [];
  private slotCountTexts: Phaser.GameObjects.Text[] = [];
  private slotHighlights: Phaser.GameObjects.Graphics[] = [];
  private slotIcons: Phaser.GameObjects.Image[] = [];
  /** Semi-transparent gray overlay covering the bomb tray + STUNNED banner
   *  shown while the local bomberman has the stunned status effect. */
  private stunHudOverlay: Phaser.GameObjects.Graphics | null = null;
  private stunHudLabel: Phaser.GameObjects.Text | null = null;
  /** Small sword icon shown on the left of the bomb tray while the local
   *  bomberman is in Melee Trap Mode. Disappears instantly on exit. */
  private meleeHudIcon: Phaser.GameObjects.Image | null = null;
  /** Rush_Mode icon sitting in the HUD buffs row (left of the loadout,
   *  immediately left of the sword icon) while the local bomberman has
   *  `rushActive`. Pops off (scale up + fade) on rush exit, pulses while
   *  active to match the treasure-row "thrum". */
  private rushHudIcon: Phaser.GameObjects.Image | null = null;
  /** Active pop-off tween for the rush HUD badge, so a re-entry into rush
   *  can cancel the in-flight pop and snap the badge back to its base size. */
  private rushHudPopTween: Phaser.Tweens.Tween | null = null;
  /** Active pulse tween for the rush HUD badge (yoyo scale, treasure-style). */
  private rushHudPulseTween: Phaser.Tweens.Tween | null = null;
  /** Active pop-off tween for the melee-trap (sword) HUD icon — mirrors
   *  the rush badge's exit animation. */
  private meleeHudPopTween: Phaser.Tweens.Tween | null = null;
  /** Active pulse tween for the melee-trap (sword) HUD icon. */
  private meleeHudPulseTween: Phaser.Tweens.Tween | null = null;
  /** Buffs-row ordering. Index 0 = rightmost (first activated). Each entry
   *  is a stable per-buff ID ('melee' for the sword, 'rush' for rush mode).
   *  A buff is added on first activation and removed only AFTER its pop-off
   *  animation completes, so the visible slot doesn't shift mid-pop. */
  private buffOrder: string[] = [];
  /** Right-edge x of the buffs row (computed in buildHudTray). All icons
   *  use origin (0.5, 0.5) and are positioned so their right edges step
   *  leftward from here by BUFF_SIZE + 8 per index. */
  private buffsRightX = 0;
  /** Vertical center of the buffs row, aligned to the loadout center. */
  private buffsCenterY = 0;
  /** Screen-edge warning overlay shown while the local bomberman is standing
   *  on a tile that a currently-fusing bomb will hit. Red when any damaging
   *  bomb is incoming, blue when only a Flash (stun) is incoming. Hidden
   *  otherwise. Lives in the HUD camera so it stays viewport-locked. */
  private bombThreatEdge: Phaser.GameObjects.Graphics | null = null;
  private errorText!: Phaser.GameObjects.Text;
  // UAV indicator (top HUD) + "UAV is Revealing the whole area" banner.
  // Hidden in tutorial matches. Throbs when the next UAV is <=3 turns away.
  private uavText: Phaser.GameObjects.Text | null = null;
  private uavPulseTween: Phaser.Tweens.Tween | null = null;
  private uavBannerText: Phaser.GameObjects.Text | null = null;
  private uavBannerTimer: Phaser.Time.TimerEvent | null = null;

  // Loot panel — appears above the bomb tray when standing on loot
  private lootPanelObjects: Phaser.GameObjects.GameObject[] = [];
  private lootPanelVisible = false;
  /** If set, the player clicked a loot bomb that doesn't fit — highlight it
   * and the next inventory-slot click will swap. */
  private lootPendingSwap: { sourceKind: 'chest' | 'body'; sourceId: string; bombType: import('@shared/types/bombs.ts').BombType; count: number } | null = null;

  // ---- Keys ----
  /** One sprite per key currently rendered, keyed by "x,y". */
  private keySprites = new Map<string, Phaser.GameObjects.Image>();
  /** Per-client fog-of-war memory: was a key on this tile the last time we
   *  saw it? Updated only when the tile is in current LOS, so a key that
   *  disappears out of LOS remains visible on this client until we look
   *  back. Resets each match (cleared in shutdown / on scene init). */
  private keyMemory = new Map<string, boolean>();
  /** Small icon used in the HUD requirement counter — the key image, or a
   *  🖥 emoji Text while the Keys system is hidden (Console system live). */
  private keysHudIcon: Phaser.GameObjects.Image | Phaser.GameObjects.Text | null = null;
  /** "N/3" text shown next to the HUD requirement icon. */
  private keysHudText: Phaser.GameObjects.Text | null = null;

  /** One sprite per map console footprint. Frame 1 (active) while the spot is
   *  in the local player's assigned trio, not yet used, and consoles have
   *  powered on (BALANCE.consoles.activationDelayTurns); frame 0 otherwise.
   *  Views intentionally differ between players — trios are per-player.
   *  `memoryFrame` is the door-style fog-of-war memory: the frame the player
   *  last saw with LOS on the footprint. Outside LOS the sprite keeps showing
   *  it, so a console that powers on behind lesser fog stays dark until
   *  re-seen. Starts 0 — every console is dark at match start. */
  private consoleSprites: Array<{
    idx: number;
    box: { x: number; y: number; w: number; h: number };
    sprite: Phaser.GameObjects.Sprite;
    memoryFrame: number;
  }> = [];
  /** Cyan channel-progress ring under the local bomberman while engaged with
   *  a console. Same phase-timed model as the escape ring. */
  private consoleRing: Phaser.GameObjects.Graphics | null = null;
  /** Red navigation line toward the next pending console / nearest hatch.
   *  Drawn above fog (depth 55) but skipped over never-seen tiles. */
  private consoleNavGraphics: Phaser.GameObjects.Graphics | null = null;
  /** Nav-line stages the player already reached: touching the target console
   *  (or getting near any usable hatch once the trio is done) retires the
   *  line for that stage permanently — even if they walk away again. Keys:
   *  `console:<usedCount>` per console stage, `hatch` for the final leg. */
  private consoleNavDismissed = new Set<string>();

  // Escape hatch animated sprites
  // States:
  //   intact   — default closed-hatch frame, animated spritesheet still bound
  //   opening  — playing hatch_opening (triggered by a local 'escaped' event
  //              for this hatch with LOS on the tile at the moment of escape)
  //   closing  — playing hatch_closing (chained after opening completes)
  //   broken   — final state; texture swapped to escape_hatch_broken (static)
  //
  // `memoryBroken` is the per-client "last known" broken state for fog-of-war:
  // updated only when this client has LOS on the hatch. Once true, the broken
  // texture stays even when the tile is in seen-dim fog.
  private escapeSprites: Array<{
    x: number; y: number;
    sprite: Phaser.GameObjects.Sprite;
    /** Pit-and-ladder backdrop drawn under the animated hatch. */
    underSprite: Phaser.GameObjects.Image;
    state: 'intact' | 'opening' | 'closing' | 'broken';
    memoryBroken: boolean;
  }> = [];

  /** One badge per escape tile — lock icon + "N/3" text floating above the
   *  hatch. Visible only while the local bomberman is on or Chebyshev-adjacent
   *  to that hatch, the hatch is not broken, and keys < cap. */
  private lockBadges: Array<{
    x: number; y: number;
    container: Phaser.GameObjects.Container;
    text: Phaser.GameObjects.Text;
  }> = [];

  /** Yoyo pulse tween running on the HUD key icon while the local player
   *  stands on a short-of-keys hatch. Stopped (and nulled) when the condition
   *  clears. */
  private keyHudPulseTween: Phaser.Tweens.Tween | null = null;

  /** Circular progress ring drawn around the local player while ready-to-escape;
   *  fills clockwise over the input phase. */
  private escapeRing: Phaser.GameObjects.Graphics | null = null;

  // Chest animated sprites (persistent, like escape hatches)
  private chestSprites: Array<{
    id: string; x: number; y: number; tier: 1 | 2 | 3;
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open' | 'closing';
    permanentlyOpened: boolean;
    /** Whether the chest tile was in LoS on the previous updateChests tick.
     *  Used so opening / closing animations skip their wind-up on the frame
     *  we regain LoS — you just see the chest in whatever state it should
     *  be in, same rule as doors. */
    wasVisible: boolean;
  }> = [];

  // Door animated sprites
  private doorSprites: Array<{
    id: number;
    tiles: Array<{ x: number; y: number }>;
    orientation: 'horizontal' | 'vertical';
    sprite: Phaser.GameObjects.Sprite;
    state: 'closed' | 'opening' | 'open';
    opened: boolean;
    /** True between the moment a `door_opened` event lands and the BEAT3-
     *  delayed callback that decides whether to animate or snap. While true,
     *  `updateDoors()` must NOT snap the sprite to the open frame, or it
     *  races and beats the animation handler. */
    openingPending: boolean;
  }> = [];

  // Blood trail decals (persistent, one per tile, tracked separately from
  // explosion decals). Map so we can iterate for the per-turn decal-decay pass.
  private bloodDecals = new Map<string, Phaser.GameObjects.Graphics>();

  /**
   * Rich cursor-following tooltip (same widget as the Bombs Shop). Shown only
   * for bomb hovers — HUD loadout slots (incl. the Rock) and loot-panel items
   * (across all stacked loot rows). Tiles/HP/turns/targeting are NOT covered;
   * those keep using the bottom-right TooltipScene. While a bomb tooltip is
   * pending or showing, the bottom-right panel is suppressed so the same bomb
   * isn't described twice.
   *
   * In-match only, the tooltip arms a 1s hover delay: it appears only after the
   * cursor has rested on the SAME bomb for `BOMB_TOOLTIP_HOVER_MS`. Moving to a
   * different bomb (different slot / loot index) restarts the timer; mouse
   * motion within the same bomb does not. The Bombs Shop keeps using the same
   * widget with no delay — the delay lives entirely here in the caller.
   */
  private bombTooltip: BombShopTooltip | null = null;
  private static readonly BOMB_TOOLTIP_HOVER_MS = 1000;
  /** Identity of the bomb currently under the cursor (`hud:<n>` / `loot:<n>`), or null. */
  private bombTooltipHoverId: string | null = null;
  /** `time.now` at which the hovered bomb's tooltip becomes eligible to show. */
  private bombTooltipShowAt = 0;
  /** False while the cursor is outside the game canvas — gates the per-frame
   *  tooltip refresh so a stale pointer position can't keep a tooltip alive. */
  private pointerInsideGame = true;

  /**
   * Tile under the cursor in world tile coords, updated by the pointermove
   * handler. Null when the cursor is off the map or outside the viewport.
   * Drives the red throw-target preview reticle (see drawHighlights()).
   */
  private hoveredTileX: number | null = null;
  private hoveredTileY: number | null = null;

  /**
   * RTS-style fog: tracks which entities/decals the player has "discovered"
   * by having them in LOS at least once. Objects in seen-dim areas are only
   * rendered if they're in this set. New objects that appear while the area
   * is in seen-dim stay hidden until the player revisits.
   */
  private knownEntities = new Set<string>();

  constructor() {
    super({ key: 'MatchScene' });
  }

  preload(): void {
    const mapIdForPreload = this.mode === 'tutorial'
      ? 'tutorial_map'
      : (this.visualMapId ?? 'main_map');
    console.log(`[MatchScene] preload(): visualMapId=${this.visualMapId} mode=${this.mode} → loading tilemap '${mapIdForPreload}'`);
    this.tiledInfo = preloadTiledMap(this, mapIdForPreload);
    // Escape hatch: 288x32 sheet, 6 frames of 48x32
    this.load.spritesheet('escape_hatch', 'sprites/escape_hatch.png', {
      frameWidth: 48,
      frameHeight: 32,
    });
    // Explosion sprite-sheet: 384x48 sheet, 8 frames of 48x48. Replaces the
    // hand-drawn fireBoom/plasmaBurst graphics on the bombs listed in
    // docs/explosion-sprite-animation.md.
    this.load.spritesheet('explosion_sprite', 'sprites/explosion_sprite_sheet.png', {
      frameWidth: 48,
      frameHeight: 48,
    });
    // Pit-and-ladder backdrop rendered UNDER the escape_hatch animation so the
    // closed/opening/open frames sit on top of a visible shaft.
    this.load.image('escape_hatch_under', 'sprites/escape_hatch_under.png');
    // Broken hatch: 288x32 spritesheet, same layout as escape_hatch — we use
    // frame 0 only, as a 1:1 replacement for the closed-hatch frame.
    this.load.spritesheet('escape_hatch_broken', 'sprites/escape_hatch_broken.png', {
      frameWidth: 48,
      frameHeight: 32,
    });
    // Key collectible — single static image, stretched to fit a full tile.
    this.load.image('key', 'sprites/key.png');
    // Escape consoles: 64x32 sheet, two 32x32 frames — 0 inactive, 1 active.
    this.load.spritesheet('consoles', 'sprites/consoles.png', { frameWidth: 32, frameHeight: 32 });
    // Chests: 64x32 sheets, 4 frames of 16x32 each
    this.load.spritesheet('chest_1', 'sprites/chest_1.png', { frameWidth: 16, frameHeight: 32 });
    this.load.spritesheet('chest_2', 'sprites/chest_2.png', { frameWidth: 16, frameHeight: 32 });
    this.load.spritesheet('chest_3', 'sprites/chest_3.png', { frameWidth: 16, frameHeight: 32 });
    // Disguise objects: 96x16 sheet, 6 frames of 16x16 — Disguise-on-idle class.
    this.load.spritesheet('disguise_objects', 'sprites/disguise_objects.png', { frameWidth: 16, frameHeight: 16 });
    // Doors: loaded as a plain image, frames added manually in create()
    this.load.image('double_doors', 'sprites/double_doors.png');
    // Sword icon — Melee Trap Mode indicator (HUD + above-head overlay).
    this.load.image('sword_icon', 'sprites/sword_icon.png');
    // Stunned effect — 2-frame 32x32 question-mark loop above the head while
    // the bomberman has the `stunned` status effect. Animation registered in
    // create() at 2 fps so the two frames read as a slow, deliberate blink.
    this.load.spritesheet('stunned_effect', 'sprites/stunned_effect.png', {
      frameWidth: 32,
      frameHeight: 32,
    });
    // Rush Mode icon — single 32x32 image used as the fly-up VFX when the
    // local bomberman enters out-of-combat Rush. Replaces the previous green
    // up-arrow text glyph.
    this.load.image('rush_mode', 'sprites/Rush_Mode.png');
    // Bomb icons (safety fallback — normally loaded by BootScene)
    preloadBombIcons(this);
    preloadTreasureIcons(this);
    // Bomberman sheets are normally loaded by BootScene, but this is a
    // safety fallback in case MatchScene is reached without Boot running.
    preloadBombermanSpritesheets(this);
  }

  init(data: { matchId?: string | null; mode?: 'network' | 'tutorial'; mapId?: string | null } | undefined): void {
    this.myMatchId = data?.matchId ?? null;
    this.mode = data?.mode ?? 'network';
    // Visual map id — supplied by LobbyScene from the joined match config.
    // Used in preload() to fetch the correct .tmj. Tutorial overrides this
    // with the hardcoded tutorial_map below.
    this.visualMapId = data?.mapId ?? null;
  }

  /** Map id used for the visual tilemap preload. Set in init() from the
   *  scene-start data so the .tmj fetched matches the server's chosen map.
   *  Falls back to 'main_map' if not provided (legacy callers, fail-safe). */
  private visualMapId: string | null = null;

  create(): void {
    this.events.once('shutdown', this.shutdown, this);
    this.isMobile = isMobileDevice();
    this.mobileArmedSlot = 0;
    this.hudScale = this.isMobile ? 0.5 : 1;
    this.slotSize = Math.round(SLOT_SIZE * this.hudScale);
    this.slotGap = Math.round(SLOT_GAP * this.hudScale);
    this.coinIconSize = Math.round(COIN_ICON_SIZE * this.hudScale);
    this.keyIconSize = Math.round(KEY_ICON * this.hudScale);
    if (this.mode === 'tutorial') {
      // Tutorial is single-player with a fabricated player id — skip the
      // profile lookup and the post-match UI-anim-lock clear.
      this.myPlayerId = TUTORIAL_PLAYER_ID;
      console.log(`[MatchScene] create(): tutorial mode, myPlayerId = ${this.myPlayerId}`);
    } else {
      const profile = ProfileStore.get();
      this.myPlayerId = profile?.id ?? null;
      // Snapshot equipped Bomberman's banked SP — used as the Results fallback
      // when the server's match_end.spEarned is missing (see onMatchEnd).
      const equipped = profile?.ownedBombermen.find(b => b.id === profile.equippedBombermanId);
      this.mySpAtStart = equipped?.sp ?? 0;
      this.myLifetimeSpAtStart = equipped?.lifetimeSp ?? 0;
      this.myBombermanNameAtStart = equipped?.name ?? null;
      this.myBombermanTintAtStart = equipped?.tint;
      this.myBombermanCharacterAtStart = equipped?.character;
      this.myInMatchSp = 0;
      console.log(`[MatchScene] create(): myPlayerId = ${this.myPlayerId}, matchId = ${this.myMatchId}, name = ${this.myBombermanNameAtStart}, spAtStart = ${this.mySpAtStart}, lifetimeSpAtStart = ${this.myLifetimeSpAtStart}`);

      // "The selected Bomberman's UI animation cycles, but only after you play a
      // match with him." Clearing the lock now means the next post-match UI
      // render (menu, shops, selector) picks a fresh random idle/idle3/walk.
      if (profile?.equippedBombermanId) {
        UiAnimLock.clear(profile.equippedBombermanId);
      }
    }

    this.inputMode = { kind: 'idle' };
    this.lastPhase = null;
    this.cameraManualOverride = false;
    // Tutorial scripts toggle this via setCameraLocked; reset on every scene
    // entry so a second run doesn't start camera-locked from a stale flag.
    this.cameraTutorialLocked = false;
    this.cameraDragging = false;
    this.myDeathAt = null;
    this.myEscapeAt = null;
    this.myEscapeTreasures = null;
    this.myTreasureTally = {};
    this.myCoinTally = 0;
    this.myKills = 0;
    this.myKillerName = null;
    this.escapeSprites = [];
    this.keySprites = new Map();
    this.keyMemory = new Map();
    this.bloodDecals = new Map();
    this.knownEntities = new Set();
    if (!this.anims.exists('hatch_closed')) {
      this.anims.create({
        key: 'hatch_closed',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 0 }),
        repeat: -1,
      });
      this.anims.create({
        key: 'hatch_opening',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 0, end: 5 }),
        frameRate: 10,
        repeat: 0,
      });
      this.anims.create({
        key: 'hatch_open',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 5 }),
        repeat: -1,
      });
      this.anims.create({
        key: 'hatch_closing',
        frames: this.anims.generateFrameNumbers('escape_hatch', { start: 5, end: 0 }),
        frameRate: 10,
        repeat: 0,
      });
    }

    // Explosion sprite animation (8 frames). Plays at fixed frameRate —
    // spriteExplosion does NOT pass a duration override, so this rate is
    // what plays. 12 fps × 8 frames ≈ 667 ms per cycle. Tune here to
    // change playback speed. See docs/explosion-sprite-animation.md.
    if (!this.anims.exists('explosion_sprite_anim')) {
      this.anims.create({
        key: 'explosion_sprite_anim',
        frames: this.anims.generateFrameNumbers('explosion_sprite', { start: 0, end: 7 }),
        frameRate: 12,
        repeat: 0,
      });
    }

    // Stunned effect: 2-frame loop at 2 fps so the question mark blinks
    // slowly and deliberately. Looped indefinitely; visibility is gated by
    // BombermanSpriteSystem based on the bomberman's stunned status.
    if (!this.anims.exists('stunned_effect_anim')) {
      this.anims.create({
        key: 'stunned_effect_anim',
        frames: this.anims.generateFrameNumbers('stunned_effect', { start: 0, end: 1 }),
        frameRate: 2,
        repeat: -1,
      });
    }

    // Chest animations (same pattern as escape hatches)
    if (!this.anims.exists('chest_1_closed')) {
      for (const tier of [1, 2, 3] as const) {
        const key = `chest_${tier}`;
        this.anims.create({ key: `${key}_closed`,  frames: this.anims.generateFrameNumbers(key, { start: 0, end: 0 }), repeat: -1 });
        this.anims.create({ key: `${key}_opening`, frames: this.anims.generateFrameNumbers(key, { start: 0, end: 3 }), frameRate: 8, repeat: 0 });
        this.anims.create({ key: `${key}_open`,    frames: this.anims.generateFrameNumbers(key, { start: 3, end: 3 }), repeat: -1 });
        this.anims.create({ key: `${key}_closing`, frames: this.anims.generateFrameNumbers(key, { start: 3, end: 0 }), frameRate: 8, repeat: 0 });
      }
    }

    // Door animations — manually define frames from the non-uniform spritesheet
    if (!this.anims.exists('door_h_closed')) {
      const tex = this.textures.get('double_doors');
      // Horizontal open-up: 6 frames of 64×32 at y=0
      for (let i = 0; i < 6; i++) tex.add(`h_${i}`, 0, i * 64, 0, 64, 32);
      // Vertical open-right: 6 frames of 32×64 at y=80
      for (let i = 0; i < 6; i++) tex.add(`v_${i}`, 0, i * 32, 80, 32, 64);

      const hFrames = Array.from({ length: 6 }, (_, i) => ({ key: 'double_doors', frame: `h_${i}` }));
      this.anims.create({ key: 'door_h_closed',  frames: [hFrames[0]], repeat: -1 });
      this.anims.create({ key: 'door_h_opening', frames: hFrames, frameRate: 12, repeat: 0 });
      this.anims.create({ key: 'door_h_open',    frames: [hFrames[5]], repeat: -1 });

      const vFrames = Array.from({ length: 6 }, (_, i) => ({ key: 'double_doors', frame: `v_${i}` }));
      this.anims.create({ key: 'door_v_closed',  frames: [vFrames[0]], repeat: -1 });
      this.anims.create({ key: 'door_v_opening', frames: vFrames, frameRate: 12, repeat: 0 });
      this.anims.create({ key: 'door_v_open',    frames: [vFrames[5]], repeat: -1 });
    }

    // Bomberman animations (idempotent — first scene to call this wins).
    ensureBombermanAnims(this);

    // Paint the viewport black behind everything. Anything outside the map
    // rect (including camera pan padding and spots the fog doesn't cover)
    // renders as solid black instead of the game's default dark-blue canvas.
    this.cameras.main.setBackgroundColor('#000000');

    // Explicit depth stack — see class-level comment for the full spec.
    // Decals are split into 3 containers so blood > pearl > scorch ordering is enforced.
    // Scorch sits just above the map (depth 5) and BELOW doors/hatches (10) and
    // chests (15), so those objects render on top of the burn scars. It's dimmed
    // by the lesser-fog overlay like the map, but drawn opaque enough to remain
    // visible there. Visibility is gated to discovered tiles by
    // updateDecalVisibility so it never shows over unexplored (black) fog.
    this.scorchDecalLayer = this.add.container(0, 0).setDepth(5);
    this.pearlDecalLayer = this.add.container(0, 0).setDepth(22);
    // Shield Wall shards: persistent floor decals from shattered Shield Bombs.
    this.shieldShardLayer = this.add.container(0, 0).setDepth(23);
    this.bloodDecalLayer = this.add.container(0, 0).setDepth(25);
    // Corpses get their own layer so bombs (depth 35) render on top of them per spec.
    this.corpseLayer = this.add.container(0, 0).setDepth(28);
    // Active Shield Walls render between corpses and bombs — they're solid
    // tile-level obstacles.
    this.shieldLayer = this.add.container(0, 0).setDepth(32);
    // Bombs render above corpses/decals, below fog.
    this.bombLayer = this.add.container(0, 0).setDepth(35);
    // Alive Bombermen render above fog — managed visibility via setVisible.
    this.bombermanLayer = this.add.container(0, 0).setDepth(100);
    this.entitiesLayer = this.add.container(0, 0).setDepth(105);
    // Explosion layer is ABOVE fog — shockwaves always visible.
    this.explosionLayer = this.add.container(0, 0).setDepth(120);
    this.effectsLayer = this.add.container(0, 0).setDepth(150);
    // Aim indicator sits below bombermen (depth 100) so it doesn't paint over
    // sprites that overlap the target tile. Just above pathGraphics for layering.
    this.highlightGraphics = this.add.graphics().setDepth(65);
    this.pathGraphics = this.add.graphics().setDepth(60);
    // Explosion-ghost overlay — see field doc. 0.5 sits between the "Tiles"
    // ground layer (depth 0) and the first decoration layer (depth 1).
    this.ghostGraphics = this.add.graphics().setDepth(0.5);
    // Throw-trajectory dots sit just below the reticle/hourglass (depth 65).
    this.trajectoryGraphics = this.add.graphics().setDepth(64);

    // HUD uses a second camera that never zooms/scrolls. It ignores all world
    // containers so it only draws HUD objects. The main camera ignores HUD objects
    // so it only draws the world.
    this.hudCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, 'hud');
    this.hudCamera.setScroll(0, 0);
    // Tell the HUD camera to ignore all world-space containers
    this.hudCamera.ignore([
      this.bombLayer, this.scorchDecalLayer, this.pearlDecalLayer, this.bloodDecalLayer,
      this.corpseLayer, this.explosionLayer, this.entitiesLayer, this.bombermanLayer,
      this.effectsLayer, this.highlightGraphics, this.pathGraphics,
      this.shieldLayer, this.shieldShardLayer, this.ghostGraphics,
      this.trajectoryGraphics,
    ]);

    this.buildHud();

    this.errorText = this.hud(this.add.text(this.scale.width / 2, this.scale.height / 2, '', {
      fontSize: '18px',
      color: '#ff4444',
      fontFamily: 'monospace',
      align: 'center',
      backgroundColor: '#1a0a0a',
      padding: { x: 24, y: 16 },
    }).setOrigin(0.5).setDepth(10000).setVisible(false));

    // Construct the authoritative-events backend. In network mode this wraps
    // the shared socket; in tutorial mode it's a local scripted resolver.
    // MatchScene's rendering/input code is backend-agnostic from here on.
    this.backend = this.mode === 'tutorial'
      ? this.buildTutorialBackend()
      : new SocketMatchBackend();
    this.backend.onMatchState((state) => this.onMatchState(state));
    this.backend.onTurnResult((events) => this.onTurnResult(events));
    this.backend.onMatchEnd((msg) => {
      // If we already transitioned client-side (death or local escape), ignore.
      if (this.myDeathAt !== null || this.myEscapeAt !== null) return;
      // Delay so the player can see the Bomberman reaching the escape hatch
      // before the results screen appears. The walk animation takes 70% of
      // the transition phase; wait for the full transition to complete.
      const delay = BALANCE.match.transitionPhaseSeconds * 1000 + 500;
      this.time.delayedCall(delay, () => this.transitionToResults(msg));
    });
    this.backend.start();

    // Tutorial-only overlay. Renders dialogue, highlights, pause, etc.
    // above MatchScene's HUD camera. Receives a scene ref so it can query
    // HUD rects and drive camera pans on the main camera.
    //
    // Defensive: explicitly stop any lingering instance from a previous
    // tutorial run before launching. Without this, a second tutorial entry
    // can hit a Phaser state where the overlay's init/create don't re-run,
    // leaving the director un-attached and the player frozen on Beat 0.
    if (this.mode === 'tutorial') {
      if (this.scene.isActive('TutorialOverlayScene') || this.scene.isSleeping('TutorialOverlayScene')) {
        this.scene.stop('TutorialOverlayScene');
      }
      this.scene.launch('TutorialOverlayScene', { matchScene: this, backend: this.backend });
    }

    // Hover tooltip overlay — runs in both network and tutorial mode.
    if (!this.scene.isActive('TooltipScene')) this.scene.launch('TooltipScene');

    // Rich cursor tooltip for bomb hovers (lives inside this scene, depth 5000).
    // Reset dwell state too — Phaser reuses the scene instance across matches.
    this.bombTooltip = new BombShopTooltip(this);
    // The tooltip is positioned in screen space, so only the HUD camera should
    // draw it — make the zoomed/scrolled world camera ignore it (otherwise a
    // second, mis-scaled copy appears over the map).
    this.bombTooltip.ignoreFrom(this.cameras.main);
    this.bombTooltipHoverId = null;
    this.bombTooltipShowAt = 0;
    this.pointerInsideGame = true;

    // Re-pin viewport-anchored HUD whenever the canvas resizes (window drag,
    // orientation change). Registered for both desktop and mobile.
    this.scale.on('resize', this.onResize, this);

    // Mobile: install the touch control scheme (Move/Attack buttons, drag
    // selector, one-finger pan, pinch zoom) instead of the PC click-to-act
    // handlers below. Everything the mobile path needs from the scene is
    // exposed through `buildMobileHooks()`.
    if (this.isMobile) {
      this.input.addPointer(2); // ensure 2 touch pointers for pinch-zoom
      this.mobileControls = new MobileControls(this, this.buildMobileHooks());
      // Suppress the browser context menu so a long-press doesn't pop the OS
      // menu over the canvas. (The PC path adds this below; mobile returns early.)
      this.game.canvas.addEventListener('contextmenu', this.preventContext);
      // Keyboard slot hotkeys are pointless on mobile — skip the rest of create().
      return;
    }

    // Left-click = game actions. Middle/right = manual camera pan: first
    // press also flips `cameraManualOverride` on, which disables the
    // per-frame auto-centering in update() for the rest of the match.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.onClick(pointer);
        return;
      }
      if (pointer.middleButtonDown() || pointer.rightButtonDown()) {
        // First manual pan of the match — drop the camera bounds. With tight
        // bounds set to the map rect, Phaser clamps scrollX/scrollY to zero
        // whenever the map is smaller than the viewport at the current zoom
        // (so panning only worked on whichever axis the map actually overflowed).
        // Removing bounds gives free pan in both axes — outside the map you
        // just see the black backdrop, which is expected in manual mode.
        if (!this.cameraManualOverride) {
          this.cameras.main.removeBounds();
        }
        this.cameraManualOverride = true;
        this.cameraDragging = true;
        this.cameraDragStartX = pointer.x;
        this.cameraDragStartY = pointer.y;
        this.cameraScrollStartX = this.cameras.main.scrollX;
        this.cameraScrollStartY = this.cameras.main.scrollY;
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.pointerInsideGame = true;
      // Track hovered tile for the red throw-target reticle. Runs on every
      // pointermove regardless of drag state so the reticle keeps tracking
      // while the player moves the mouse.
      if (this.mapData) {
        const ts = this.mapData.tileSize;
        const wp = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
        const tx = Math.floor(wp.x / ts);
        const ty = Math.floor(wp.y / ts);
        if (tx >= 0 && ty >= 0 && tx < this.mapData.width && ty < this.mapData.height) {
          this.hoveredTileX = tx;
          this.hoveredTileY = ty;
        } else {
          this.hoveredTileX = null;
          this.hoveredTileY = null;
        }
      }
      this.refreshTooltip(pointer.x, pointer.y);
      if (!this.cameraDragging) return;
      const dx = pointer.x - this.cameraDragStartX;
      const dy = pointer.y - this.cameraDragStartY;
      const zoom = this.cameras.main.zoom;
      this.cameras.main.scrollX = this.cameraScrollStartX - dx / zoom;
      this.cameras.main.scrollY = this.cameraScrollStartY - dy / zoom;
    });

    this.input.on('pointerup', () => { this.cameraDragging = false; });
    this.input.on('gameover', () => { this.pointerInsideGame = true; });
    this.input.on('gameout', () => {
      this.pointerInsideGame = false;
      this.getTooltipScene()?.setKey(null);
      this.bombTooltip?.hide();
      this.bombTooltipHoverId = null; // re-arm the dwell delay on re-entry
    });

    // Suppress the browser context menu so right-drag works cleanly.
    this.game.canvas.addEventListener('contextmenu', this.preventContext);

    // Scroll-wheel zoom — clamped 0.5×–4×.
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _objs: unknown[], _dx: number, dy: number) => {
      const next = Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 4);
      this.cameras.main.setZoom(next);
    });

    // Keyboard shortcuts for the bomb slots — bound up to the hard upper
    // bound of slot count (Rock + MAX_INVENTORY_SLOT_COUNT custom = 7).
    // `onSlotClicked` no-ops on indices that don't exist for the current
    // Bomberman, so it's safe to wire all of them unconditionally.
    const kb = this.input.keyboard;
    if (kb) {
      const digitKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'];
      for (let i = 0; i < digitKeys.length; i++) {
        kb.on(`keydown-${digitKeys[i]}`, () => this.onSlotClicked(i));
      }
      kb.on('keydown-ESC', () => {
        this.inputMode = { kind: 'idle' };
        this.sendAction({ kind: 'idle' });
        this.rebuildEntities();
        this.renderHud();
      });
    }
  }

  shutdown(): void {
    this.game.canvas.removeEventListener('contextmenu', this.preventContext);
    this.backend?.destroy();
    this.backend = null;
    // Stop the parallel tutorial overlay scene, if it was launched.
    if (this.mode === 'tutorial' && this.scene.isActive('TutorialOverlayScene')) {
      this.scene.stop('TutorialOverlayScene');
    }
    if (this.scene.isActive('TooltipScene')) this.scene.stop('TooltipScene');
    this.bombTooltip?.destroy();
    this.bombTooltip = null;
    this.mapRenderer?.destroy();
    this.mapRenderer = null;
    this.fogRenderer?.destroy();
    this.fogRenderer = null;
    this.shieldRenderer?.destroy();
    this.shieldRenderer = null;
    this.bombRenderer?.destroy();
    this.bombRenderer = null;
    this.bombermanSpriteSystem?.destroy();
    this.bombermanSpriteSystem = null;
    this.state = null;
    this.slotRects = [];
    this.slotLabelTexts = [];
    this.slotCountTexts = [];
    this.slotHighlights = [];
    this.slotIcons = [];
    this.hudTrayBg = null;
    this.stunHudOverlay = null;
    this.stunHudLabel = null;
    this.meleeHudIcon = null;
    this.rushHudIcon = null;
    this.rushHudPopTween?.remove();
    this.rushHudPopTween = null;
    this.rushHudPulseTween?.remove();
    this.rushHudPulseTween = null;
    this.meleeHudPopTween?.remove();
    this.meleeHudPopTween = null;
    this.meleeHudPulseTween?.remove();
    this.meleeHudPulseTween = null;
    this.buffOrder = [];
    this.uavText = null;
    this.brokenHatchText = null;
    this.bombThreatEdge?.destroy();
    this.bombThreatEdge = null;
    this.uavPulseTween?.stop();
    this.uavPulseTween?.remove();
    this.uavPulseTween = null;
    this.uavBannerText?.destroy();
    this.uavBannerText = null;
    this.uavBannerTimer?.remove();
    this.uavBannerTimer = null;
    this.lastBuiltSlotCount = -1;
    for (const esc of this.escapeSprites) { esc.sprite.destroy(); esc.underSprite.destroy(); }
    this.escapeSprites = [];
    for (const b of this.lockBadges) b.container.destroy();
    this.lockBadges = [];
    this.keyHudPulseTween?.stop();
    this.keyHudPulseTween?.remove();
    this.keyHudPulseTween = null;
    this.escapeRing?.destroy();
    this.escapeRing = null;
    for (const s of this.keySprites.values()) s.destroy();
    this.keySprites = new Map();
    this.keyMemory = new Map();
    this.keysHudIcon = null;
    this.keysHudText = null;
    for (const cs of this.consoleSprites) cs.sprite.destroy();
    this.consoleSprites = [];
    this.consoleRing?.destroy();
    this.consoleRing = null;
    this.consoleNavGraphics?.destroy();
    this.consoleNavGraphics = null;
    this.consoleNavDismissed.clear();
    this.hudObjects = [];
    if (this.hudCamera) {
      this.cameras.remove(this.hudCamera);
      this.hudCamera = null;
    }
    this.scale.off('resize', this.onResize, this);
    this.mobileControls?.destroy();
    this.mobileControls = null;
    this.input.keyboard?.removeAllListeners();
  }

  update(time: number, delta: number): void {
    // Drive Tiled animated tile clock
    this.mapRenderer?.tick(delta);
    // Drive Bomberman walk lerps + overlay positions
    this.bombermanSpriteSystem?.tick(time);

    if (!this.state) return;

    // Re-evaluate the hover tooltip every frame from the live pointer position.
    // pointermove alone can't reveal the bomb tooltip after its 1s dwell when
    // the cursor has come to rest, so we re-check here while it's over the canvas.
    if (this.pointerInsideGame) {
      const p = this.input.activePointer;
      this.refreshTooltip(p.x, p.y);
    }

    // Update ready-to-escape feedback (banner above head + progress ring)
    this.updateEscapeReadyIndicator();

    // Update heal/disguise idle-action progress rings (smooth, phase-timed —
    // same model as the escape ring).
    this.updateIdleActionIndicators();

    // Console channel progress ring (cyan, 3 idle turns — Console system).
    this.updateConsoleReadyIndicator();

    // Mobile: refresh the drag selector + preview (path for move, aim tile for
    // attack). Runs before the ghost/path draws below so they pick up the
    // selector's tile this frame.
    this.mobileControls?.update();

    // Redraw the path each frame so the path[0] hourglass arc animates
    // smoothly during the input phase (instead of stepping only on
    // server-state updates).
    if (this.inputMode.kind === 'pathing') {
      this.drawPath();
    }

    // Explosion ghosts every frame: landed-bomb danger zones flash via Date.now(),
    // and the aiming preview tracks the live (possibly motionless) cursor.
    this.drawGhostZones();
    // Throw reticle (arc + cross + red hourglass) — redraw every frame so the
    // hourglass drains smoothly (like the movement path) and clears the instant
    // aiming ends (drawHighlights() early-returns with both graphics cleared).
    this.drawHighlights();

    // Reveal the map's Contour boundary outline near the throw-aim target.
    // Tiles within range fade in while aiming; everything fades back out when
    // not aiming. No-op on maps without a Contour layer.
    const contourAim = this.currentThrowAimTile();
    this.mapRenderer?.updateContourReveal(contourAim?.x ?? null, contourAim?.y ?? null, delta);

    // Camera follow: snap to the local player's tile center every frame.
    // Skips if the player has escaped (sprite is gone) so the last framing
    // holds through the 500ms delay before the Results transition. Also
    // skips once the player has manually panned (middle/right click) —
    // from that point on they're in control until the match ends.
    if (this.mapData && !this.cameraManualOverride && !this.cameraTutorialLocked) {
      const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
      if (me && !me.escaped) {
        const ts = this.mapData.tileSize;
        this.cameras.main.centerOn(me.x * ts + ts / 2, me.y * ts + ts / 2);
      }
    }

    // Top-center match clock (M:SS). Frozen while a tutorial dialogue/pause is
    // up so the clock visibly stops with the rest of the game; otherwise it
    // counts down in real time. See formatMatchClock for the turns→time mapping.
    const tutorialPaused = this.mode === 'tutorial'
      && !!(this.scene.get('TutorialOverlayScene') as TutorialOverlayScene | undefined)?.isBlockingInput?.();
    if (!tutorialPaused) {
      this.timerText.setText(this.formatMatchClock());
    }

    // Keep the HUD HP number in sync with the sprite system's delayed
    // HP — tick() swaps displayedHp once the post-damage delay ends, and
    // the text here follows along without waiting for a match_state.
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (me && me.alive) {
      const displayedHp = this.bombermanSpriteSystem?.getDisplayedHp(me.playerId) ?? me.hp;
      this.updateHpBar(displayedHp, BALANCE.match.bombermanMaxHp, /* dead */ false);
    }
  }

  private async onMatchState(state: MatchState): Promise<void> {
    // Defense-in-depth against stale socket.io room subscriptions. If the
    // server forgets to unsubscribe us from a previous match, its state
    // broadcasts would otherwise land here and fight with the real match.
    if (this.myMatchId && state.matchId !== this.myMatchId) {
      console.warn(`[MatchScene] ignoring stale match_state from ${state.matchId} (bound to ${this.myMatchId})`);
      return;
    }
    const firstFrame = this.state === null;
    const phaseBecameInput = state.phase === 'input' && this.lastPhase !== 'input';
    // Mirror the local Bomberman's in-match SP accumulator so we can recover
    // it on death (the server zeroes bm.sp before sending match_end).
    if (this.myPlayerId) {
      const me = state.bombermen.find(b => b.playerId === this.myPlayerId);
      if (me && typeof me.sp === 'number') this.myInMatchSp = me.sp;
    }
    // Snapshot the outgoing flare light set before swapping state — the fog
    // update below unions it with the incoming set so tiles that ARE losing
    // illumination this turn stay lit through the transition animations
    // (explosions, decals, blood) and only dim after those have played out.
    const prevLightTiles = this.state?.lightTiles ?? [];
    this.state = state;

    try {
      if (firstFrame || !this.mapData || this.mapData.id !== state.mapId) {
        console.log(`[MatchScene] loading map '${state.mapId}'`);
        this.mapData = await loadMapById(state.mapId);
        console.log(`[MatchScene] map loaded: ${this.mapData.width}x${this.mapData.height}`);
        this.mapRenderer?.destroy();
        // Seed decorative-object placement by matchId so every client in the
        // match sees the same scatter (and it varies match-to-match).
        this.mapRenderer = new MapRenderer(this, this.mapData, 0, this.tiledInfo, hashStringToInt(state.matchId));
        // Create one animated hatch sprite per escape tile. The sprite is
        // rendered at native 48x32 pixel size and centered on the escape
        // tile's world position. No setDisplaySize() — let the art render
        // at its native resolution so pixels stay crisp.
        for (const spr of this.escapeSprites) { spr.sprite.destroy(); spr.underSprite.destroy(); }
        this.escapeSprites = [];
        for (const b of this.lockBadges) b.container.destroy();
        this.lockBadges = [];
        const mapTs = this.mapData.tileSize;
        // Use the server's per-match `escapeTiles` (a random subset of the
        // map's authored pool, see MatchRoom.buildInitialState) so each match
        // gets a fresh hatch placement. Falls back to the map's full pool
        // only if state didn't ship escapeTiles (legacy / tutorial backend).
        const escapeTilesFromState = state.escapeTiles?.length ? state.escapeTiles : this.mapData.escapeTiles;
        for (const esc of escapeTilesFromState) {
          // Under-layer: pit-and-ladder backdrop drawn at depth 9 so the
          // animated hatch sits on top. Same anchor as the hatch sprite.
          const underSprite = this.add.image(
            esc.x * mapTs + mapTs / 2,
            esc.y * mapTs + mapTs,
            'escape_hatch_under',
          );
          underSprite.setDepth(9);
          underSprite.setOrigin(0.5, 1);
          if (this.hudCamera) this.hudCamera.ignore(underSprite);

          // Anchor: horizontally centered, bottom of sprite aligned to bottom
          // of the escape tile. The 48x32 sprite splits into a 3x2 grid of
          // 16x16 cells, and the middle-bottom cell is the one that should
          // sit ON the escape tile.
          const sprite = this.add.sprite(
            esc.x * mapTs + mapTs / 2,
            esc.y * mapTs + mapTs,
            'escape_hatch',
          );
          sprite.setDepth(10);
          sprite.setOrigin(0.5, 1);
          sprite.play('hatch_closed');
          if (this.hudCamera) this.hudCamera.ignore(sprite);
          this.escapeSprites.push({ x: esc.x, y: esc.y, sprite, underSprite, state: 'intact', memoryBroken: false });

          // Lock badge — floats above the hatch. Hidden by default; renderHud
          // toggles visibility based on local-player adjacency + key shortfall.
          // Uses the same key sprite used everywhere else for consistency.
          const badgeCx = esc.x * mapTs + mapTs / 2;
          const badgeCy = esc.y * mapTs - 14;
          const badge = this.add.container(badgeCx, badgeCy).setDepth(120).setVisible(false);
          const bg = this.add.graphics();
          bg.fillStyle(0x0a0a14, 0.85);
          bg.fillRoundedRect(-15, -8, 30, 15, 3);
          bg.lineStyle(1, 0xff5555, 1);
          bg.strokeRoundedRect(-15, -8, 30, 15, 3);
          // Keys hidden → the badge shows the console requirement instead
          // (computer emoji per the Console-system spec).
          const keyIcon = HIDDEN_FEATURES.keys
            ? this.add.text(-8, 0, '🖥', { fontSize: '8px' }).setOrigin(0.5, 0.5)
            : this.add.image(-7, 0, 'key').setDisplaySize(9, 9);
          const txt = this.add.text(2, 0, '0/3', {
            fontSize: '6px', color: '#ff8888', fontFamily: 'Arial, sans-serif', fontStyle: 'bold',
            stroke: '#000000', strokeThickness: 1,
          }).setOrigin(0, 0.5);
          badge.add([bg, keyIcon, txt]);
          if (this.hudCamera) this.hudCamera.ignore(badge);
          this.lockBadges.push({ x: esc.x, y: esc.y, container: badge, text: txt });
        }

        // Console sprites — one per map console footprint (Console system).
        // Frame is synced per state update in updateConsoles(): active for
        // the local player's pending trio, inactive otherwise. Same depth
        // band as hatches; fog (depth 50) covers them naturally.
        for (const cs of this.consoleSprites) cs.sprite.destroy();
        this.consoleSprites = [];
        if (HIDDEN_FEATURES.keys) {
          (this.mapData.consoleSpots ?? []).forEach((box, idx) => {
            const spr = this.add.sprite(
              (box.x + box.w / 2) * mapTs,
              (box.y + box.h) * mapTs,
              'consoles',
              0,
            );
            spr.setOrigin(0.5, 1);
            spr.setDisplaySize(box.w * mapTs, box.h * mapTs);
            spr.setDepth(10);
            if (this.hudCamera) this.hudCamera.ignore(spr);
            this.consoleSprites.push({ idx, box: { ...box }, sprite: spr, memoryFrame: 0 });
          });
          this.updateConsoles();
        }
        // Initial chest-sprite build — subsequent syncs happen below on every
        // state update so tutorial-spawned chests also get sprites.
        for (const cs of this.chestSprites) cs.sprite.destroy();
        this.chestSprites = [];
        this.syncChestSprites(state, mapTs);

        // Create door sprites
        for (const ds of this.doorSprites) ds.sprite.destroy();
        this.doorSprites = [];
        if (state.doors) {
          for (const door of state.doors) {
            const prefix = door.orientation === 'horizontal' ? 'h' : 'v';
            const animKey = `door_${prefix}`;
            const tiles = door.tiles;
            let sx: number, sy: number;
            if (door.orientation === 'horizontal') {
              // Center between the 2 tiles, bottom-aligned
              sx = tiles[0].x * mapTs + mapTs;
              sy = tiles[0].y * mapTs + mapTs;
            } else {
              // Vertical door: center of the tile column, bottom of lowest tile + 1 tile
              // The sprite is 32×64 (4 tiles tall) but the door is only 3 tiles.
              // Anchor at bottom-center, position at the bottom edge of the lowest tile.
              sx = tiles[0].x * mapTs + mapTs / 2;
              sy = (tiles[tiles.length - 1].y + 1) * mapTs + mapTs;
            }
            const sprite = this.add.sprite(sx, sy, 'double_doors', `${prefix}_0`);
            sprite.setDepth(10);
            sprite.setOrigin(0.5, 1);
            sprite.play(door.opened ? `${animKey}_open` : `${animKey}_closed`);
            if (this.hudCamera) this.hudCamera.ignore(sprite);
            this.doorSprites.push({
              id: door.id, tiles: door.tiles, orientation: door.orientation,
              sprite, state: door.opened ? 'open' : 'closed', opened: door.opened,
              openingPending: false,
            });
          }
        }

        // Tell the HUD camera to ignore everything the map renderer created
        if (this.hudCamera) {
          this.mapRenderer.ignoreFromCamera(this.hudCamera);
        }
        this.fogRenderer?.destroy();
        this.fogRenderer = new FogRenderer(this, this.mapData, BALANCE.match.losRadius, 50);
        if (this.hudCamera) this.fogRenderer.ignoreFromCamera(this.hudCamera);
        this.bombRenderer?.destroy();
        this.bombRenderer = new BombRenderer(this, this.bombLayer, this.explosionLayer, this.scorchDecalLayer, this.pearlDecalLayer, this.mapData.tileSize);
        this.shieldRenderer?.destroy();
        this.shieldRenderer = new ShieldRenderer({
          scene: this,
          wallLayer: this.shieldLayer,
          vfxLayer: this.explosionLayer,
          decalLayer: this.shieldShardLayer,
          hudCamera: this.hudCamera,
          tileSize: this.mapData.tileSize,
        });
        this.bombermanSpriteSystem?.destroy();
        this.bombermanSpriteSystem = new BombermanSpriteSystem(this, this.bombermanLayer, this.corpseLayer, this.mapData.tileSize);
        if (this.hudCamera) this.bombermanSpriteSystem.ignoreFromCamera(this.hudCamera);
        const bounds = this.mapRenderer.getWorldBounds();
        const ts = this.mapData.tileSize;
        const spawnMe = this.myBomberman();
        const startX = spawnMe ? spawnMe.x * ts + ts / 2 : bounds.width / 2;
        const startY = spawnMe ? spawnMe.y * ts + ts / 2 : bounds.height / 2;
        console.log(`[MatchScene] camera init: spawn=(${spawnMe?.x},${spawnMe?.y}) startPx=(${startX},${startY}) bounds=(${bounds.width},${bounds.height})`);
        // Tight bounds (no padding), fixed zoom, snap to spawn. Per-frame
        // follow happens in update() — see cameraFollowPlayer().
        const cam = this.cameras.main;
        cam.setBounds(0, 0, bounds.width, bounds.height);
        cam.setZoom(2.5);
        cam.centerOn(startX, startY);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MatchScene] map load failed:', err);
      this.errorText.setText(`MAP LOAD FAILED\n${msg}\n\nCheck browser console.`);
      this.errorText.setVisible(true);
      return;
    }

    this.errorText.setVisible(false);

    // Sync chest sprites to state every update, not just on the first frame.
    // Tutorial's `spawnChest` mutateState pushes chests into the state after
    // the initial map load — without this we'd never create sprites for them.
    if (this.mapData) {
      this.syncChestSprites(state, this.mapData.tileSize);
    }

    const me = this.myBomberman();

    // Feed flare light tiles into fog as external reveals (visible for everyone).
    // Two-phase update:
    //   1. Push the UNION of previous + new lightTiles immediately. Tiles
    //      being added (a flare just landed) light up right away; tiles
    //      being removed (a flare shrank or expired) stay lit through the
    //      transition so the turn's explosions/decals/blood don't render
    //      on a dimmed fog.
    //   2. At the end of the transition phase, collapse to just the new
    //      set — the tiles that actually lost illumination now darken.
    if (this.fogRenderer) {
      const unionKeys = new Set<string>();
      const unionTiles: Array<{ x: number; y: number }> = [];
      const pushUnique = (t: { x: number; y: number }): void => {
        const k = `${t.x},${t.y}`;
        if (!unionKeys.has(k)) { unionKeys.add(k); unionTiles.push({ x: t.x, y: t.y }); }
      };
      for (const t of prevLightTiles) pushUnique(t);
      for (const t of state.lightTiles) pushUnique(t);
      this.fogRenderer.setExternalReveals(unionTiles);
      // Closed-door tiles block LOS the same as walls.
      const closedDoorTiles: Array<{ x: number; y: number }> = [];
      for (const d of state.doors ?? []) {
        if (d.opened) continue;
        for (const t of d.tiles) closedDoorTiles.push({ x: t.x, y: t.y });
      }
      this.fogRenderer.setClosedDoorTiles(closedDoorTiles);
      // Active Shield Walls also block LoS like solid walls.
      const shieldWallTiles: Array<{ x: number; y: number }> = [];
      for (const w of state.shieldWalls ?? []) {
        for (const t of w.tiles) shieldWallTiles.push({ x: t.x, y: t.y });
      }
      this.fogRenderer.setShieldWallTiles(shieldWallTiles);
      // Suppress LoS when the local bomberman is inside any smoke cloud —
      // per design, the smoked player only sees their own tile plus the
      // seen-dim map they already discovered. Also hoists bomb graphics
      // above the fog so the smoked player can still see bombs clearly.
      const meInSmoke = !!me && (state.smokeClouds ?? []).some(c =>
        c.tiles.some(t => t.x === me.x && t.y === me.y),
      );
      this.fogRenderer.setLosSuppressed(meInSmoke);
      this.bombRenderer?.setSmokeMode(meInSmoke);
      if (me) this.fogRenderer.update(me.x, me.y);

      const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
      this.time.delayedCall(transitionMs, () => {
        if (!this.fogRenderer || this.state !== state) return;
        this.fogRenderer.setExternalReveals(state.lightTiles);
        const myNow = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
        if (myNow) {
          const meInSmokeNow = (state.smokeClouds ?? []).some(c =>
            c.tiles.some(t => t.x === myNow.x && t.y === myNow.y),
          );
          this.fogRenderer.setLosSuppressed(meInSmokeNow);
          this.bombRenderer?.setSmokeMode(meInSmokeNow);
          this.fogRenderer.update(myNow.x, myNow.y);
        }
      });
    }

    // Keep bomb/fire/light visuals in sync with the state
    this.bombRenderer?.syncBombs(state.bombs);
    this.bombRenderer?.syncFire(state.fireTiles, state.turnNumber);
    this.bombRenderer?.syncFlares(state.flares);
    this.bombRenderer?.syncSmokeClouds(state.smokeClouds ?? []);
    this.bombRenderer?.syncMines(state.mines ?? []);

    // Decal decay pass — recompute alpha for every existing decal and blood
    // splat based on the current turn number. See BALANCE.decalDecay.
    this.bombRenderer?.applyDecalDecay(state.turnNumber);
    this.applyBloodDecalDecay(state.turnNumber);

    // Sync persistent Bomberman sprites (creates/destroys + updates HP/aim)
    this.bombermanSpriteSystem?.syncFromState(
      state,
      this.myPlayerId,
      this.selectedSlot !== null || this.inputMode.kind === 'aim',
      (x, y) => this.fogRenderer?.isVisible(x, y) ?? true,
      // RTS fog for corpses: discover on LOS, persist in seen-dim
      (playerId, x, y) => {
        const key = `corpse_${playerId}`;
        if (this.fogRenderer?.isVisible(x, y)) {
          this.knownEntities.add(key);
          return true;
        }
        return this.knownEntities.has(key) && (this.fogRenderer?.isDiscovered(x, y) ?? false);
      },
    );

    // Flush any staged action at the start of every new input phase.
    // This is how the "queue during transition" flexibility works: click
    // stages input locally, the send is deferred until we're back in input.
    if (phaseBecameInput) {
      this.flushStagedAction();
    }
    // After the transition resolves, a staged throw has been consumed — drop
    // aim mode so the next input phase doesn't re-throw from the same slot.
    // Spawn a 1s fade-out of the aim indicator so the target tile lingers
    // visibly as the bomb flies/lands instead of vanishing the moment phase
    // flips.
    if (state.phase === 'transition' && this.inputMode.kind === 'aim') {
      const aim = this.inputMode;
      this.inputMode = { kind: 'idle' };
      if (aim.targetX !== null && aim.targetY !== null) {
        this.spawnAimFadeOut(aim.targetX, aim.targetY);
      }
    }
    // Note: selectedSlot is NOT cleared on transition — it persists until the
    // player either throws (onClick clears it) or toggles it off (same key).

    this.lastPhase = state.phase;
    this.rebuildEntities();
    this.renderHud();
  }

  /**
   * Send the server an action matching our current staged inputMode.
   * No-op if we're not in the input phase (server would ignore it anyway);
   * onMatchState calls this again when the next input phase begins.
   */
  private flushStagedAction(): void {
    if (!this.state || this.state.phase !== 'input') return;
    const me = this.myBomberman();
    if (!me) return;

    switch (this.inputMode.kind) {
      case 'idle':
        this.sendAction({ kind: 'idle' });
        return;

      case 'pathing': {
        // Pop tiles up to and including me's current position. Handles both
        // 1-tile moves (me === path[0]) and 2-tile rush moves (me === path[1]
        // with path[0] being the consumed passthrough). Rush no longer pre-
        // shifts before send — keeping the passthrough in path until the
        // bomberman has actually traversed it means drawPath can render the
        // full path (and identify pause vs. passthrough tiles correctly).
        for (let i = 0; i < Math.min(2, this.inputMode.path.length); i++) {
          if (this.inputMode.path[i].x === me.x && this.inputMode.path[i].y === me.y) {
            this.inputMode.path.splice(0, i + 1);
            break;
          }
        }
        if (this.inputMode.path.length === 0) {
          this.inputMode = { kind: 'idle' };
          this.sendAction({ kind: 'idle' });
          return;
        }
        // Rush: send both the first and second waypoints so the server
        // processes two sequential 1-tile moves in a single turn.
        const rushActive = me.rushActive ?? false;
        const first = this.inputMode.path[0];
        if (rushActive && this.inputMode.path.length >= 2) {
          const second = this.inputMode.path[1];
          this.sendAction({ kind: 'move', x: first.x, y: first.y, rushX: second.x, rushY: second.y });
        } else {
          this.sendAction({ kind: 'move', x: first.x, y: first.y });
        }
        return;
      }

      case 'aim':
        if (this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
          this.sendAction({
            kind: 'throw',
            slotIndex: this.inputMode.slotIndex,
            x: this.inputMode.targetX,
            y: this.inputMode.targetY,
          });
        }
        return;
    }
  }

  private transitionToResults(msg?: MatchEndMsg): void {
    // Tutorial intentionally rewards nothing — skip ResultsScene (and all
    // its SP / treasure / kill readout) for a dedicated "you're done" card.
    if (this.state?.isTutorial === true) {
      this.scene.start('TutorialEndScene');
      return;
    }
    const me = this.state?.bombermen.find(b => b.playerId === this.myPlayerId);
    // Prefer the authoritative escape list from match_end when available;
    // fall back to the per-player flag on state for the client-side-exit
    // path (local escape triggers Results before match_end arrives).
    const escaped = msg?.escapedPlayerIds?.includes(this.myPlayerId ?? '') ?? (me?.escaped ?? false);
    const alive = me?.alive ?? false;
    const endReason = msg?.endReason ?? (alive ? 'all_escaped' : 'all_dead');

    // Determine outcome
    let outcome: 'escaped' | 'died' | 'lost' = 'died';
    if (escaped) {
      outcome = 'escaped';
    } else if (endReason === 'turn_limit' && alive) {
      outcome = 'lost';
    }

    // Collect inventory summary for escaped players
    const inventory: Array<{ type: BombType; name: string; count: number }> = [];
    if (me && escaped) {
      for (const slot of me.inventory.slots) {
        if (slot) {
          const def = BOMB_CATALOG[slot.type];
          inventory.push({ type: slot.type, name: def.name, count: slot.count });
        }
      }
    }

    // Treasure source priority — first non-empty wins. The client-side tally
    // is the primary source because we accumulate it from `treasures_collected`
    // / `body_looted` events as they arrive, so it cannot be lost to any
    // server-side drain or message ordering issue:
    //  1. `myTreasureTally` — what we actually saw the player pick up.
    //  2. `match_end` payload — server's authoritative bundle.
    //  3. `myEscapeTreasures` — snapshot from the `escaped` event payload.
    //  4. `me.treasures` — current state (only valid when nothing has drained,
    //     e.g. tutorial backend).
    const fromMatchEnd = msg?.treasuresEarned?.[this.myPlayerId ?? ''];
    const myTreasures: TreasureBundle =
      (hasAnyTreasure(this.myTreasureTally) ? { ...this.myTreasureTally } : null)
      ?? (fromMatchEnd && hasAnyTreasure(fromMatchEnd) ? { ...fromMatchEnd } : null)
      ?? (this.myEscapeTreasures && hasAnyTreasure(this.myEscapeTreasures) ? { ...this.myEscapeTreasures } : null)
      ?? (me?.treasures ? { ...me.treasures } : {});

    // SP earned this match — prefer the server's authoritative match_end
    // payload when present and non-zero. Fall back to (current owned.sp −
    // pre-match owned.sp), which is also authoritative since the profile
    // broadcast lands BEFORE match_end. This catches the edge case where
    // the per-escape snapshot didn't fire even though SP was banked.
    const fromServer = msg?.spEarned?.[this.myPlayerId ?? ''] ?? 0;
    let spEarned = fromServer;
    if (fromServer <= 0 && outcome === 'escaped') {
      const profileNow = ProfileStore.get();
      const equippedNow = profileNow?.ownedBombermen.find(b => b.id === profileNow.equippedBombermanId);
      const diff = (equippedNow?.sp ?? 0) - this.mySpAtStart;
      if (diff > 0) spEarned = diff;
    }
    // Lifetime SP — the design ask is "all SP this Bomberman ever gathered,
    // including SP spent on upgrades AND including the run they just played
    // even if they died". We compute it client-side from the values we
    // captured at match start + the mirrored in-match accumulator. The
    // server's `match_end.lifetimeSp` is used only as a sanity ceiling
    // since it doesn't always include the lost-on-death this-match SP.
    const serverLifetime = msg?.lifetimeSp?.[this.myPlayerId ?? ''] ?? 0;
    const profileNow = ProfileStore.get();
    const equippedNow = profileNow?.ownedBombermen.find(b => b.id === profileNow.equippedBombermanId);
    const liveLifetime = equippedNow?.lifetimeSp ?? 0;
    // For escapees, owned.lifetimeSp on the profile has already been bumped
    // by THIS match. For dead players, owned is gone, so we add the
    // in-match accumulator to the pre-match snapshot ourselves.
    const computedFromDeath = this.myLifetimeSpAtStart + this.myInMatchSp;
    const lifetimeSp = Math.max(serverLifetime, liveLifetime, computedFromDeath);

    // Snapshot visual identity from the in-match state so the dead-Bomberman
    // hero on Results still renders correctly (the OwnedBomberman gets
    // stripped from the profile on death).
    const meState = this.state?.bombermen.find(b => b.playerId === this.myPlayerId);
    this.scene.start('ResultsScene', {
      outcome,
      treasuresEarned: myTreasures,
      turnsPlayed: this.state?.turnNumber ?? 0,
      inventory,
      kills: this.myKills,
      killerName: this.myKillerName,
      myBombermanName: meState?.name ?? this.myBombermanNameAtStart,
      spEarned,
      lifetimeSp,
      myBombermanTint: meState?.tint ?? this.myBombermanTintAtStart,
      myBombermanCharacter: meState?.character ?? this.myBombermanCharacterAtStart,
    });
  }

  /** One-shot visuals from the server's authoritative turn resolution. */
  private onTurnResult(events: Array<{ kind: string; [k: string]: unknown }>): void {
    if (!this.bombRenderer) return;

    // UAV banner + flash burst. Per uav_fired event, play the same per-tile
    // flareFlash burst a player-thrown flare produces on detonation at every
    // UAV flare's center tile. The persistent flame on each tile is then
    // drawn by syncFlares once the new state arrives.
    for (const ev of events) {
      if (ev.kind !== 'uav_fired') continue;
      this.showUavBanner();
      const tiles = (ev.tiles as Array<{ x: number; y: number }>) ?? [];
      const flashMs = Math.round(BALANCE.match.transitionPhaseSeconds * 1000 * 0.5);
      for (const t of tiles) {
        this.bombRenderer.flareFlash({ x: t.x, y: t.y }, flashMs);
      }
    }

    // Drive Bomberman walk lerps + facing changes from `moved` events.
    // Each lerp lasts the full transition phase so the sprite physically
    // walks from old tile to new tile in sync with the resolution timer.
    // Group moved events by player — rush moves produce 2 events for one player.
    // Walks are Beat 1 ("Action Perform") of the 3-beat resolve phase — they
    // finish at the 1/3 mark, just before explosions/teleports/smoke (Beat 2,
    // "Action Result") kick in.
    // Bombermen who exited Melee Trap this turn: their walk/throw visuals
    // are held back by the sword-fade duration so the fade-out plays
    // cleanly before the sprite starts moving (per the spec). The HUD
    // melee icon also pops off / pops on for the LOCAL player here so the
    // buff row reacts to the same event the in-world sword does.
    const meleeExiters = new Set<string>();
    for (const ev of events) {
      if (ev.kind !== 'melee_trap_changed') continue;
      const pid = ev.playerId as string;
      if (ev.active === false) meleeExiters.add(pid);
      if (pid === this.myPlayerId) {
        if (ev.active === true) this.showMeleeHudIcon();
        else this.popOffMeleeHudIcon();
      }
    }
    // Three-beat resolve timings. Beat 1 is fixed (walks + throws must
    // complete within it); Beats 2 and 3 are allowed to linger past their
    // nominal slot as long as they start on time.
    const transitionMsTotal = BALANCE.match.transitionPhaseSeconds * 1000;
    const BEAT1_END_MS = Math.round(transitionMsTotal / 3);
    const BEAT3_START_MS = Math.round((transitionMsTotal * 2) / 3);
    const moveDurationMs = BEAT1_END_MS;
    const movesByPlayer = new Map<string, Array<{ fromX: number; fromY: number; toX: number; toY: number }>>();
    for (const ev of events) {
      if (ev.kind !== 'moved') continue;
      const pid = ev.playerId as string;
      if (!movesByPlayer.has(pid)) movesByPlayer.set(pid, []);
      movesByPlayer.get(pid)!.push({
        fromX: ev.fromX as number, fromY: ev.fromY as number,
        toX: ev.toX as number, toY: ev.toY as number,
      });
    }
    for (const [playerId, moves] of movesByPlayer) {
      const exitHold = meleeExiters.has(playerId) ? SWORD_FADE_MS : 0;
      const perMoveDuration = moveDurationMs / moves.length;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const delay = exitHold + i * perMoveDuration;
        if (delay > 0) {
          this.time.delayedCall(delay, () => {
            this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
          });
        } else {
          this.bombermanSpriteSystem?.applyMoveEvent(playerId, m.fromX, m.fromY, m.toX, m.toY, perMoveDuration);
        }
      }
    }

    // Collect every player id that will have its TakeDamage / Die anim
    // driven this turn so we only play it ONCE per victim. Bomb damage
    // + melee damage landing on the same bomberman in the same turn
    // should drop HP by 2 but only play the hurt animation once (design
    // spec). Melee wins precedence — it has its own timed Attack3 → hurt
    // sequence that we don't want to step on.
    const hurtQueued = new Set<string>();

    // Melee Trap counter-attacks first.
    for (const ev of events) {
      if (ev.kind !== 'melee_attack') continue;
      const attackerId = ev.attackerId as string;
      const victimId = ev.victimId as string;
      const killed = ev.killed as boolean;
      const intermediate = ev.intermediate as { x: number; y: number } | undefined;
      if (hurtQueued.has(victimId)) continue; // victim already queued
      hurtQueued.add(victimId);
      // SMACK_CONNECT_FRAC = 0.65 mirrors BombermanSpriteSystem's connect-at
      // timing for Attack3 (see ATTACK3_DURATION_MS * 0.65). Fire the impact
      // burst at that moment so it reads as the actual contact.
      const connectAtMs = Math.round(BombermanSpriteSystem.ATTACK3_DURATION_MS * 0.65);
      if (intermediate) {
        // Trigger Attack3 at the walk midpoint so it looks like the strike
        // intercepts the rushing victim. Walk takes half the transition;
        // halfway through walk == 25% of transition.
        const delay = Math.round((BALANCE.match.transitionPhaseSeconds * 1000) * 0.25);
        this.time.delayedCall(delay, () => {
          this.bombermanSpriteSystem?.applyMeleeAttack(attackerId, victimId, killed);
        });
        this.time.delayedCall(delay + connectAtMs, () => {
          this.spawnMeleeSmackVfx(victimId);
        });
      } else {
        // Walk-end or mutual trigger — fire Attack3 after the walk lerp
        // completes (50% of transition) for step-in, or immediately for
        // mutual melee (victim isn't moving).
        const delay = Math.round((BALANCE.match.transitionPhaseSeconds * 1000) * 0.5);
        this.time.delayedCall(delay, () => {
          this.bombermanSpriteSystem?.applyMeleeAttack(attackerId, victimId, killed);
        });
        this.time.delayedCall(delay + connectAtMs, () => {
          this.spawnMeleeSmackVfx(victimId);
        });
      }
    }

    // Heal-on-idle VFX — green aura + rising crosses when a Heal-class
    // Bomberman recovers HP. Fired around the transition midpoint so it reads
    // alongside the HP bar refill.
    for (const ev of events) {
      if (ev.kind !== 'heal_applied') continue;
      const healId = ev.playerId as string;
      const delay = Math.round((BALANCE.match.transitionPhaseSeconds * 1000) * 0.5);
      this.time.delayedCall(delay, () => {
        this.bombermanSpriteSystem?.playHealEffect(healId);
      });
    }

    // Hurt animations on damage events — Beat 3 ("Action Reaction"). Fires
    // 2/3 of the way through the transition so the victim visibly reacts
    // AFTER the explosion (beat 2) connects, not at the start of the turn.
    //   - hpRemaining > 0: play Hurt.
    //   - hpRemaining === 0: skip — the death animation (also in beat 3,
    //     scheduled below) covers the lethal blow per design ("just die
    //     animation if 1 hp").
    // Skipped for any victim already queued (melee victim, or a previous
    // damage event in the same turn).
    for (const ev of events) {
      if (ev.kind !== 'damaged') continue;
      const playerId = ev.playerId as string;
      if (hurtQueued.has(playerId)) continue;
      hurtQueued.add(playerId);
      const hpRemaining = ev.hpRemaining as number;
      if (hpRemaining <= 0) continue; // death anim covers lethal hits
      this.time.delayedCall(BEAT3_START_MS, () => {
        this.bombermanSpriteSystem?.applyHurtEvent(playerId);
      });
    }

    // First pass: spawn arcs for every throw this turn and record the bomb
    // ids so we can time-shift their matching explosions.
    const arcDurationByBombId = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind !== 'throw') continue;
      const playerId = ev.playerId as string;
      const type = ev.type as BombType;
      const bombId = ev.bombId as string;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.x as number;
      const toY = ev.y as number;
      // Arc always renders, but per-frame LOS-clipped: the bomb sprite
      // hides on any frame whose current tile is outside LOS, so a throw
      // from the fog visibly emerges when it enters the player's sight.
      // The thrower's throw *animation*, however, still only plays if the
      // thrower is in LOS — no point animating a sprite in darkness.
      const throwerVisible = playerId === this.myPlayerId
        || this.fogRenderer?.isVisible(fromX, fromY);
      const fog = this.fogRenderer;
      const los = fog ? (tx: number, ty: number) => fog.isVisible(tx, ty) : undefined;
      const exitHold = meleeExiters.has(playerId) ? SWORD_FADE_MS : 0;
      if (exitHold > 0) {
        // Delay the throw arc + throw animation so the melee-trap sword
        // fade clearly plays before the bomberman unwinds into the throw.
        // Arc duration matches the Beat 1 window (1/3 of the transition).
        const duration = BEAT1_END_MS;
        const totalFlightMs = duration + exitHold;
        arcDurationByBombId.set(bombId, totalFlightMs);
        // Hold the landed-bomb sprite until the full exit-hold + arc finishes
        // (onTurnResult runs before the new state is applied, so syncBombs
        // will honor this marker when it sees the new BombInstance).
        this.bombRenderer?.markPendingThrow(bombId, totalFlightMs);
        this.time.delayedCall(exitHold, () => {
          this.bombRenderer?.spawnThrowArc(type, fromX, fromY, toX, toY, los);
          if (throwerVisible) {
            this.bombermanSpriteSystem?.applyThrowEvent(playerId, fromX, fromY, toX, toY, duration);
          }
        });
      } else {
        const { duration } = this.bombRenderer.spawnThrowArc(type, fromX, fromY, toX, toY, los);
        arcDurationByBombId.set(bombId, duration);
        this.bombRenderer?.markPendingThrow(bombId, duration);
        if (throwerVisible) {
          this.bombermanSpriteSystem?.applyThrowEvent(playerId, fromX, fromY, toX, toY, duration);
        }
      }
    }

    // Second pass: explosions. Beat 2 ("Action Result") — starts at the 1/3
    // mark when walks + throws have completed. Explosions are allowed to
    // linger past the end of the transition; they are not clipped by the
    // turn boundary. For thrown bombs whose arc exceeds the beat 1 window
    // (e.g. a melee-exiter whose arc is offset by SWORD_FADE_MS), the
    // explosion starts when the bomb lands instead.
    const transitionMs = transitionMsTotal;
    const explosionStartMs = BEAT1_END_MS;
    // Pinned to an absolute 1400 ms so explosion ember/dust tails keep their
    // full length regardless of turn-duration tuning. Starts at BEAT1_END_MS
    // and is allowed to linger past the end of the transition.
    const burstDurationMs = 1400;
    // Pre-collect cluster mine positions from this turn's mine_placed
    // events so we can animate bombs flying out of the cluster cylinder
    // toward each mine landing site.
    const clusterMinesByOwner = new Map<string, Array<{ x: number; y: number }>>();
    for (const ev of events) {
      if (ev.kind !== 'mine_placed') continue;
      if (ev.mineKind !== 'cluster') continue;
      const ownerId = ev.ownerId as string;
      if (!clusterMinesByOwner.has(ownerId)) clusterMinesByOwner.set(ownerId, []);
      clusterMinesByOwner.get(ownerId)!.push({ x: ev.x as number, y: ev.y as number });
    }

    for (const ev of events) {
      if (ev.kind !== 'bomb_triggered') continue;
      const type = ev.type as BombType;
      const tiles = ev.tiles as Array<{ x: number; y: number }>;
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      const bombId = ev.bombId as string;
      const arcDelay = arcDurationByBombId.get(bombId) ?? 0;
      const startDelay = Math.max(arcDelay, explosionStartMs);
      if (type === 'cluster_bomb') {
        // Route cluster impact through the dedicated cylinder+scatter
        // animation. Look up the mine positions placed this turn by the
        // throwing player. The throw event carried ownerId via playerId.
        const throwEv = events.find(e => e.kind === 'throw' && e.bombId === bombId);
        const ownerId = (throwEv?.playerId as string | undefined) ?? '';
        const mines = clusterMinesByOwner.get(ownerId) ?? [];
        this.bombRenderer.spawnClusterCylinder(centerX, centerY, mines, startDelay);
        continue;
      }
      this.bombRenderer.spawnExplosion(type, centerX, centerY, tiles, startDelay, burstDurationMs, this.state?.turnNumber ?? 0);
    }

    // Mine triggers render as explosions too. Cluster mines get a plus-r1
    // fire boom + scorch decal (same as a contact bomb). Motion detector
    // mines are handled via flare spawn server-side (flame appears via
    // syncFlares), but we also draw a small flash + whitish decal at the
    // trigger tile so the player sees the mine "popped".
    for (const ev of events) {
      if (ev.kind !== 'mine_triggered') continue;
      const mineKind = ev.mineKind as 'motion_detector' | 'cluster';
      const tiles = (ev.tiles as Array<{ x: number; y: number }>) ?? [];
      const centerX = ev.x as number;
      const centerY = ev.y as number;
      if (mineKind === 'cluster') {
        // Reuse contact bomb's explosion + decal path.
        this.bombRenderer.spawnExplosion(
          'contact', centerX, centerY, tiles,
          explosionStartMs, burstDurationMs, this.state?.turnNumber ?? 0,
        );
      } else {
        // Motion detector: single flash + whitish decal at mine tile.
        this.bombRenderer.spawnExplosion(
          'flare', centerX, centerY, [{ x: centerX, y: centerY }],
          explosionStartMs, burstDurationMs, this.state?.turnNumber ?? 0,
        );
        // Small "flare cartridge fires upward" particle effect — orange
        // streak shoots up from the mine tile to sell the trigger.
        this.time.delayedCall(explosionStartMs, () => {
          this.bombRenderer?.spawnMotionDetectorLaunch(centerX, centerY);
        });
      }
    }

    // Teleport pass: Ender Pearl teleports the thrower at the halfway point
    // of the transition (when the pearl visually arrives). Puff effects play
    // at origin and destination, decals stamp after the puff completes.
    for (const ev of events) {
      if (ev.kind !== 'teleport') continue;
      const playerId = ev.playerId as string;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.toX as number;
      const toY = ev.toY as number;
      const puffDuration = explosionStartMs;
      // At the halfway point: snap sprite, play puffs at both ends
      this.time.delayedCall(explosionStartMs, () => {
        // Snap the Bomberman sprite to the destination tile
        this.bombermanSpriteSystem?.applyTeleportEvent(playerId, toX, toY);
        // Puff effects at origin and destination (TO puff on pearlDecalLayer = RTS-fog gated)
        this.bombRenderer?.spawnTeleportPuff(fromX, fromY, puffDuration, true);  // FROM: above fog (visible like explosions)
        this.bombRenderer?.spawnTeleportPuff(toX, toY, puffDuration, false, this.fogRenderer?.isVisible(toX, toY) ?? false);  // TO: suppressed entirely when destination is fogged
      });
      // Stamp decals after the puff finishes (at the end of the transition)
      const teleportSpawnTurn = this.state?.turnNumber ?? 0;
      this.time.delayedCall(explosionStartMs + puffDuration, () => {
        // Decals are stamped late in the transition (post-puff) — by then, fog
        // may have re-fallen. Pass current LOS so the decal is born hidden
        // when fogged, avoiding a one-frame flash before updatePearlDecalVisibility.
        this.bombRenderer?.stampTeleportDecal(fromX, fromY, teleportSpawnTurn, this.fogRenderer?.isVisible(fromX, fromY) ?? false);
        this.bombRenderer?.stampTeleportDecal(toX, toY, teleportSpawnTurn, this.fogRenderer?.isVisible(toX, toY) ?? false);
      });
    }

    // Shield Bomb pass: push vfx + wall spawn + wall break.
    //   shield_pushed: yellow puff at origin/destination + light-gray decal,
    //                  parallels the Ender Pearl teleport flow.
    //   shield_wall_spawned: slam-in animation per tile (handled in syncWalls
    //                  too, so we only need to play the bomberman-snap if a
    //                  bomberman was pushed AS the wall formed — already
    //                  handled by the shield_pushed branch below).
    //   shield_wall_broken: visual fade-out (state already drained the wall).
    for (const ev of events) {
      if (ev.kind === 'shield_pushed') {
        const fromX = ev.fromX as number;
        const fromY = ev.fromY as number;
        const toX = ev.toX as number;
        const toY = ev.toY as number;
        const puffDuration = explosionStartMs;
        const playerId = (ev as { playerId?: string }).playerId;
        this.time.delayedCall(explosionStartMs, () => {
          if (playerId) {
            this.bombermanSpriteSystem?.applyTeleportEvent(playerId, toX, toY);
          }
          this.shieldRenderer?.spawnPushPuff(fromX, fromY, puffDuration);
          this.shieldRenderer?.spawnPushPuff(toX, toY, puffDuration);
        });
        this.time.delayedCall(explosionStartMs + puffDuration, () => {
          this.shieldRenderer?.stampPushDecal(fromX, fromY);
          this.shieldRenderer?.stampPushDecal(toX, toY);
        });
      } else if (ev.kind === 'shield_wall_broken') {
        const wallId = ev.wallId as string;
        const tiles = ev.tiles as Array<{ x: number; y: number }>;
        const shardIds = (ev as { shardIds?: string[] }).shardIds ?? [];
        this.shieldRenderer?.breakWall(wallId, tiles, shardIds);
      }
      // shield_wall_spawned: handled by syncWalls() called every state tick.
    }

    // Door-opened events: Beat 3 ("Action Reaction"). Deferred to the 2/3
    // mark so a door opened BY an explosion visibly reacts to the blast
    // rather than animating at turn start. Proximity-triggered opens (a
    // bomberman walking up to the door in beat 1) also play here — visually
    // the door opens a moment after the bomberman arrives, which still
    // reads naturally.
    //
    // Gate the animation on current LoS — if ANY of the door's tiles is in
    // the local player's LoS at event time we play it; otherwise snap
    // straight to `open` so the animation doesn't leak through seen-dim
    // fog and reveal enemy positions. Next time the player gets LoS they
    // just see an already-open door.
    for (const ev of events) {
      if (ev.kind !== 'door_opened') continue;
      const doorId = ev.doorId as number;
      const ds = this.doorSprites.find(d => d.id === doorId);
      if (!ds || ds.opened || ds.openingPending) continue;
      if (ds.state !== 'closed') continue;
      // Latch openingPending immediately so the per-tick `updateDoors()`
      // snap-to-open (driven by the server state sync) doesn't race ahead
      // and replace the closed frame before our delayed handler runs. We
      // intentionally DO NOT set `ds.opened = true` yet — the delayed
      // callback owns that flip after it picks animate-vs-snap based on
      // LoS at event time. Door delay is intentionally ~1/3 of BEAT3 so
      // the open animation starts crisply right after a bomberman steps up
      // to a door (rather than waiting through the full beat slot — the
      // other beat-3 visuals like hurt frames still use the full slot).
      ds.openingPending = true;
      const doorDelayMs = Math.round(BEAT3_START_MS / 3);
      this.time.delayedCall(doorDelayMs, () => {
        if (ds.state !== 'closed') { ds.openingPending = false; return; }
        const prefix = ds.orientation === 'horizontal' ? 'h' : 'v';
        const inLoS = ds.tiles.some(t => this.fogRenderer?.isVisible(t.x, t.y));
        if (inLoS) {
          ds.state = 'opening';
          ds.opened = true;
          ds.openingPending = false;
          ds.sprite.play(`door_${prefix}_opening`);
          ds.sprite.once('animationcomplete', () => {
            ds.state = 'open';
            ds.sprite.play(`door_${prefix}_open`);
          });
        } else {
          // Not in LoS at event time: keep the CLOSED visual frozen. Playing
          // the open frame here makes the door visibly pop open in seen-dim
          // fog (the regression). Record `opened` in data and drop the latch,
          // but leave the sprite on its closed frame and ds.state as 'closed'
          // — updateDoors snaps it to the open frame only once the player
          // regains LoS on it, so they just see an already-open door.
          ds.opened = true;
          ds.openingPending = false;
        }
      });
    }

    // Melee-killed victims: collect their IDs so we skip the generic death
    // animation replay below (applyMeleeAttack already triggered the death
    // anim at the Attack3 connect point). We still run the death-side-
    // effects (blood splash, kill tracking, results transition).
    const meleeKilled = new Set<string>();
    for (const ev of events) {
      if (ev.kind === 'melee_attack' && ev.killed) meleeKilled.add(ev.victimId as string);
    }

    // Third pass: deaths — delayed so the explosion/bomb effect plays out first.
    // The death animation starts after the explosion visual completes (near
    // the end of the transition), not at the start of the turn.
    const deathDelay = Math.round(transitionMs * 0.85);
    for (const ev of events) {
      if (ev.kind !== 'died') continue;
      const playerId = ev.playerId as string;
      const x = ev.x as number;
      const y = ev.y as number;
      const killerId = (ev.killerId as string | null) ?? null;

      // Track kills: if I killed someone
      if (killerId === this.myPlayerId && playerId !== this.myPlayerId) {
        this.myKills++;
      }
      // Track killer: if someone killed me
      if (playerId === this.myPlayerId && killerId) {
        const killerBm = this.state?.bombermen.find(b => b.playerId === killerId);
        this.myKillerName = (killerBm as any)?.name ?? killerId;
      }

      const isMeleeKill = meleeKilled.has(playerId);
      this.time.delayedCall(deathDelay, () => {
        const deathMs = isMeleeKill
          ? deathAnimationDurationMs()
          : (this.bombermanSpriteSystem?.applyDeathEvent(playerId, x, y) ?? deathAnimationDurationMs());
        // Death-time blood splash removed by request — only the hurt-trail
        // puddles (state.bloodTiles) remain.
        if (playerId === this.myPlayerId) {
          this.myDeathAt = Date.now();
          this.inputMode = { kind: 'idle' };
          this.lootPendingSwap = null;
          this.time.delayedCall(deathMs + 2000, () => {
            this.transitionToResults();
          });
        }
      });
    }

    // Per-hatch escape animation. Plays opening → closing → swap-to-broken,
    // but only if this client has LOS on the hatch tile at the moment the
    // event arrives. Clients without LOS (including those who only have the
    // tile under seen-dim fog) skip the animation entirely and never update
    // their memory — they'll see the broken state silently next time they
    // regain LOS via updateEscapeHatches(). Idempotent against the resolver's
    // habit of re-emitting `escaped` for already-escaped players every turn.
    if (this.fogRenderer) {
      for (const ev of events) {
        if (ev.kind !== 'escaped') continue;
        const e = ev as { hatchX?: number; hatchY?: number };
        if (typeof e.hatchX !== 'number' || typeof e.hatchY !== 'number') continue;
        const esc = this.escapeSprites.find(s => s.x === e.hatchX && s.y === e.hatchY);
        if (!esc) continue;
        if (esc.memoryBroken) continue;
        if (esc.state !== 'intact') continue;
        if (!this.fogRenderer.isVisible(e.hatchX, e.hatchY)) continue;
        esc.state = 'opening';
        esc.sprite.play('hatch_opening');
        esc.sprite.once('animationcomplete', () => {
          esc.state = 'closing';
          esc.sprite.play('hatch_closing');
          esc.sprite.once('animationcomplete', () => {
            esc.state = 'broken';
            esc.memoryBroken = true;
            esc.sprite.anims.stop();
            esc.sprite.setTexture('escape_hatch_broken');
          });
        });
      }
    }

    // Key pickup — flying icon over the picker (only for the local player)
    // to mirror the treasure popup pattern. Keys for other players don't
    // show a popup; they update the world sprite via the next state sync.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'key_pickup') continue;
        const e = ev as unknown as { playerId: string; x: number; y: number };
        if (e.playerId !== this.myPlayerId) continue;
        const bm = this.state?.bombermen.find(b => b.playerId === e.playerId);
        if (!bm) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        this.spawnKeyPopup(baseX, baseY);
      }

      // Console hacked (local player) — flash the console sprite and float a
      // progress confirmation over it. The frame flip to inactive happens on
      // the next updateConsoles() sync.
      for (const ev of events) {
        if (ev.kind !== 'console_used') continue;
        const e = ev as unknown as { playerId: string; consoleId: number; remaining: number };
        const cs = this.consoleSprites.find(c => c.idx === e.consoleId);
        if (!cs) continue;
        // Mini-flare launch — a small light pops up out of the console's
        // center (the persistent half-size flame from state.flares takes
        // over via syncFlares). Plays for ANY player's completion, gated on
        // LOS like other through-fog VFX; the flash + label below stay
        // local-player-only.
        const centerTileX = cs.box.x + Math.floor(cs.box.w / 2);
        const centerTileY = cs.box.y + Math.floor(cs.box.h / 2);
        if (this.fogRenderer?.isVisible(centerTileX, centerTileY) ?? true) {
          const fcx = (cs.box.x + cs.box.w / 2) * ts;
          const fcy = (cs.box.y + cs.box.h / 2) * ts;
          // Half the thrown-flare circle (ts * 0.22 in spawnThrowArc).
          const puff = this.add.circle(fcx, fcy, ts * 0.11, 0xffffff, 1).setDepth(500);
          if (this.hudCamera) this.hudCamera.ignore(puff);
          this.tweens.add({
            targets: puff,
            y: fcy - ts * 0.9,
            alpha: 0,
            duration: 450,
            ease: 'Cubic.easeOut',
            onComplete: () => puff.destroy(),
          });
          // Half-size flare detonation burst at the flame's tile — same VFX
          // a thrown flare / motion-detector mine plays, scaled to mini.
          const flashMs = Math.round(BALANCE.match.transitionPhaseSeconds * 1000 * 0.5);
          this.bombRenderer?.flareFlash({ x: centerTileX, y: centerTileY }, flashMs, 0.5);
        }
        if (e.playerId !== this.myPlayerId) continue;
        cs.sprite.setTintFill(0xaaffee);
        this.time.delayedCall(180, () => { if (cs.sprite.active) cs.sprite.clearTint(); });
        const px = (cs.box.x + cs.box.w / 2) * ts;
        const py = cs.box.y * ts - 4;
        const label = e.remaining > 0 ? `🖥 ${e.remaining} LEFT` : '🖥 HATCH UNLOCKED';
        const popup = this.add.text(px, py, label, {
          fontSize: '8px', color: '#44ddff', fontFamily: 'monospace', fontStyle: 'bold',
          stroke: '#000000', strokeThickness: 2,
        }).setOrigin(0.5, 1).setDepth(500);
        if (this.hudCamera) this.hudCamera.ignore(popup);
        this.tweens.add({
          targets: popup,
          y: py - ts * 1.2,
          alpha: 0,
          duration: 1200,
          ease: 'Cubic.easeOut',
          onComplete: () => popup.destroy(),
        });
      }
    }

    // Local escape — jump to Results without waiting for match_end.
    // The server only broadcasts match_end once ALL players are dead or
    // escaped; in a multi-player match we need to exit the scene on our own
    // escape. Mirrors the death-exit pattern above (delayed call so the
    // walk-to-hatch animation finishes before the transition).
    for (const ev of events) {
      if (ev.kind !== 'escaped') continue;
      if ((ev.playerId as string) !== this.myPlayerId) continue;
      if (this.myEscapeAt !== null || this.myDeathAt !== null) break;
      this.myEscapeAt = Date.now();
      this.myEscapeTreasures = { ...((ev as { treasures?: TreasureBundle }).treasures ?? {}) };
      this.inputMode = { kind: 'idle' };
      this.lootPendingSwap = null;
      const escapeDelay = BALANCE.match.transitionPhaseSeconds * 1000 + 500;
      this.time.delayedCall(escapeDelay, () => this.transitionToResults());
      break;
    }

    // Rush changed indicators
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'rush_changed') continue;
        const bm = this.state?.bombermen.find(b => b.playerId === (ev.playerId as string));
        if (!bm) continue;
        // Only show for the local player's Bomberman
        if (bm.playerId !== this.myPlayerId) continue;
        const wx = bm.x * ts + ts / 2 + ts * 0.6;
        const wy = bm.y * ts + ts / 2 - ts * 1.5;
        const active = ev.active as boolean;
        if (active) {
          const indicator = this.add.image(wx, wy, 'rush_mode')
            .setOrigin(0.5)
            .setDepth(150)
            .setDisplaySize(ts * 0.9, ts * 0.9);
          if (this.hudCamera) this.hudCamera.ignore(indicator);
          this.tweens.add({
            targets: indicator, y: wy - ts * 1.5, alpha: 0,
            duration: 1200, ease: 'Cubic.easeOut',
            onComplete: () => indicator.destroy(),
          });
          this.showRushHudBadge();
        } else {
          // Rush exit: red-tinted Rush_Mode image flying DOWN from the same
          // anchor point used by the entry indicator, then fading. Mirrors
          // the up-flying entry so the player can read "rush ended" at a
          // glance regardless of WHAT caused the exit (movement, action,
          // taking damage, etc.).
          const indicator = this.add.image(wx, wy, 'rush_mode')
            .setOrigin(0.5)
            .setDepth(150)
            .setDisplaySize(ts * 0.9, ts * 0.9)
            .setTint(0xff4444);
          if (this.hudCamera) this.hudCamera.ignore(indicator);
          this.tweens.add({
            targets: indicator, y: wy + ts * 1.5, alpha: 0,
            duration: 1200, ease: 'Cubic.easeIn',
            onComplete: () => indicator.destroy(),
          });
          this.popOffRushHudBadge();
        }
      }
    }

    // Coin pickup visuals (NEW_META §2). Flying "+N coin" popup mirroring
    // treasure pickup, plus tally accumulation for the Results fallback.
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        if (ev.kind !== 'coins_picked_up') continue;
        const playerId = ev.playerId as string;
        const amount = ev.amount as number;
        if (playerId === this.myPlayerId) this.myCoinTally += amount;
        const bm = this.state?.bombermen.find(b => b.playerId === playerId);
        if (!bm) continue;
        if (bm.playerId !== this.myPlayerId) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        this.spawnCoinPopup(baseX, baseY, amount);
      }
    }

    // Fourth pass: treasure collection visuals. Stagger per type so the
    // player can read each pickup separately (icon + "+N").
    if (this.mapData) {
      const ts = this.mapData.tileSize;
      for (const ev of events) {
        let bundle: TreasureBundle | null = null;
        let playerId: string | null = null;
        if (ev.kind === 'treasures_collected') {
          bundle = ev.treasures as TreasureBundle;
          playerId = ev.playerId as string;
        } else if (ev.kind === 'body_looted') {
          bundle = ev.treasures as TreasureBundle;
          playerId = ev.playerId as string;
        }
        if (!bundle || !playerId) continue;
        // Accumulate into the local-player tally. This is the bulletproof
        // source for the Results screen — we own these numbers client-side
        // and never lose them to a server-side drain.
        if (playerId === this.myPlayerId) {
          for (const t of TREASURE_TYPES) {
            const n = bundle[t] ?? 0;
            if (n > 0) this.myTreasureTally[t] = (this.myTreasureTally[t] ?? 0) + n;
          }
        }
        const bm = this.state?.bombermen.find(b => b.playerId === playerId);
        if (!bm) continue;
        if (bm.playerId !== this.myPlayerId) continue;
        // Fly-out popups suppressed while the treasure economy is hidden
        // (server sends empty bundles, but gate the visual too so stale
        // clients / in-flight matches can't show them). The tally above
        // still accumulates — it is data plumbing, not presentation.
        if (HIDDEN_FEATURES.treasures) continue;
        const baseX = bm.x * ts + ts / 2;
        const baseY = bm.y * ts + ts / 2 - ts * 0.5;
        let stagger = 0;
        for (const t of TREASURE_TYPES) {
          const amount = bundle[t] ?? 0;
          if (amount > 0) {
            this.spawnTreasurePopup(baseX, baseY, t, amount, stagger);
            stagger += 220;
          }
        }
      }
    }
  }

  /** Floating "+N [coin]" popup mirroring the treasure pickup VFX.
   *  Coin icon drawn inline as Graphics (mirrors tooltip 'coin' shape). */
  private spawnCoinPopup(worldX: number, worldY: number, amount: number): void {
    const POPUP_ICON = 7;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0);
    const r = POPUP_ICON / 2;
    const iconY = -3;
    const icon = this.add.graphics();
    icon.fillStyle(0xffd944, 1);
    icon.fillCircle(0, iconY, r);
    icon.fillStyle(0xc09020, 1);
    icon.fillCircle(0, iconY, r * 0.7);
    icon.fillStyle(0xffd944, 1);
    icon.fillRect(-r * 0.1, iconY - r * 0.45, r * 0.2, r * 0.9);
    const text = this.add.text(0, 4, `+${amount}`, {
      fontSize: '7px', color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 1,
    }).setOrigin(0.5, 0.5);
    c.add(icon);
    c.add(text);
    if (this.hudCamera) this.hudCamera.ignore(c);
    this.tweens.add({ targets: c, alpha: 1, duration: 120 });
    this.tweens.add({
      targets: c,
      y: worldY - 16,
      alpha: 0,
      duration: 1200,
      delay: 120,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });
  }

  /** Beefier "+KEY" popup — bigger icon, distinct cyan/teal text and longer
   *  hang time so it isn't lost in the swarm of coin/treasure popups at the
   *  same tile. Also spawns a flying-to-HUD icon that triggers the HUD key
   *  counter pulse on arrival. */
  private spawnKeyPopup(worldX: number, worldY: number): void {
    const POPUP_ICON = 11;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0).setScale(0.6);
    const icon = this.add.image(0, -3, 'key').setDisplaySize(POPUP_ICON, POPUP_ICON);
    const text = this.add.text(0, 5, '+KEY', {
      fontSize: '7px', color: '#88ddff', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000022', strokeThickness: 2,
    }).setOrigin(0.5, 0.5);
    c.add([icon, text]);
    if (this.hudCamera) this.hudCamera.ignore(c);
    // Punch in, then rise + fade. Longer hang than the treasure popup so the
    // key reads as a distinct event.
    this.tweens.add({ targets: c, alpha: 1, scale: 1, duration: 160, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: c,
      y: worldY - 22,
      alpha: 0,
      duration: 1800,
      delay: 200,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });

    // Flying icon: arcs from the pickup tile up to the HUD key counter, then
    // triggers the HUD pulse on arrival. Snapshotted endpoint — slight drift
    // is fine if the world camera moves during the ~700ms flight.
    this.spawnKeyFlightToHud(worldX, worldY);
  }

  /** Arc a small key icon from a world position to the HUD key counter,
   *  pulse the counter on arrival. Uses a quadratic Bezier so it visibly
   *  travels along a curve rather than a straight line. */
  private spawnKeyFlightToHud(worldX: number, worldY: number): void {
    if (!this.keysHudIcon) return;
    const cam = this.cameras.main;
    const target = cam.getWorldPoint(this.keysHudIcon.x, this.keysHudIcon.y);
    const start = new Phaser.Math.Vector2(worldX, worldY - 16);
    const end = new Phaser.Math.Vector2(target.x, target.y);
    const midX = (start.x + end.x) / 2;
    const midY = Math.min(start.y, end.y) - 80;
    const curve = new Phaser.Curves.QuadraticBezier(
      start,
      new Phaser.Math.Vector2(midX, midY),
      end,
    );
    const icon = this.add.image(start.x, start.y, 'key').setDisplaySize(24, 24).setDepth(600);
    if (this.hudCamera) this.hudCamera.ignore(icon);
    const t = { p: 0 };
    const point = new Phaser.Math.Vector2();
    this.tweens.add({
      targets: t,
      p: 1,
      duration: 700,
      ease: 'Cubic.easeIn',
      onUpdate: () => {
        curve.getPoint(t.p, point);
        icon.setPosition(point.x, point.y);
      },
      onComplete: () => {
        icon.destroy();
        this.pulseKeyHud();
      },
    });
  }

  /** Briefly scale the HUD key icon + count text up and back. Fires when a
   *  flying-to-HUD icon arrives, so the eye is drawn to the counter at the
   *  exact moment the number bumps. */
  private pulseKeyHud(): void {
    // Skip while the standing-on-short-hatch pulse is running so we don't
    // stack tweens on the same target (they'd fight over the scale value).
    if (this.keyHudPulseTween) return;
    if (!this.keysHudIcon || !this.keysHudText) return;
    this.tweens.add({
      targets: [this.keysHudIcon, this.keysHudText],
      scale: 1.6,
      duration: 140,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

  /**
   * Per-frame driver for the Heal / Disguise idle-action progress rings. Uses
   * the SAME continuous phase-timed model as the escape-hatch ready ring so the
   * ring fills smoothly across input + transition phases (not in stages). The
   * resolver increments `idleStillTurns` at turn resolution (completed turns),
   * so progress = elapsed / (required turns' worth of input+transition).
   * BombermanSpriteSystem owns the per-bomberman ring graphic + its LOS gating;
   * here we only feed it the fill value.
   */
  private updateIdleActionIndicators(): void {
    if (!this.state || !this.bombermanSpriteSystem) return;
    const inputMs = BALANCE.match.inputPhaseSeconds * 1000;
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    const phaseRemaining = Math.max(0, this.state.phaseEndsAt - Date.now());
    for (const b of this.state.bombermen) {
      if (b.idleAction !== 'heal' && b.idleAction !== 'disguise') continue;
      const required = b.idleAction === 'heal'
        ? BALANCE.idleActions.healIdleTurns
        : BALANCE.idleActions.disguiseIdleTurns;
      const completed = b.idleStillTurns ?? 0;
      const totalMs = required * inputMs + (required - 1) * transitionMs;
      let elapsed: number;
      if (this.state.phase === 'input') {
        elapsed = completed * (inputMs + transitionMs) + (inputMs - phaseRemaining);
      } else {
        elapsed = (completed - 1) * (inputMs + transitionMs) + inputMs + (transitionMs - phaseRemaining);
      }
      this.bombermanSpriteSystem.setIdleHourglassProgress(b.playerId, elapsed / totalMs);
    }
  }

  /** Per-frame driver for the ready-to-escape feedback: a clockwise-filling
   *  progress ring at the local player's feet. Spans the full wait window
   *  from step-on to escape (both input AND transition phases of every wait
   *  turn). Hidden during the transition that walks the bomberman onto the
   *  hatch — the ring only "starts playing" the moment they actually arrive. */
  private updateEscapeReadyIndicator(): void {
    if (!this.state || !this.mapData) {
      this.setEscapeIndicatorVisible(false);
      return;
    }
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (!me || !me.alive || me.escaped) {
      this.setEscapeIndicatorVisible(false);
      return;
    }
    const onHatch = this.state.escapeTiles.some(t => t.x === me.x && t.y === me.y);
    const onBroken = this.state.brokenHatches.some(t => t.x === me.x && t.y === me.y);
    // Unlock requirement mirrors the resolver's escape gate: consoles used
    // while keys are hidden (Console system), carried keys otherwise.
    const requirementMet = HIDDEN_FEATURES.keys
      ? (me.consolesUsed ?? []).length >= Math.min(
          BALANCE.consoles.requiredToEscape, (me.assignedConsoles ?? []).length)
      : (me.keys ?? 0) >= BALANCE.keys.requiredPerHatch;
    if (!onHatch || onBroken || !requirementMet) {
      this.setEscapeIndicatorVisible(false);
      return;
    }
    // Suppress the ring during the arrival transition (action was 'move', so
    // onHatchIdleTurns is still 0 and the bomberman is still visually lerping
    // toward the hatch). The ring should appear the moment they're standing
    // on it — i.e. at the start of the next input phase.
    const onHatchTurns = me.onHatchIdleTurns ?? 0;
    if (this.state.phase === 'transition' && onHatchTurns === 0) {
      this.setEscapeIndicatorVisible(false);
      return;
    }

    this.ensureEscapeIndicator();
    const ts = this.mapData.tileSize;
    const cx = me.x * ts + ts / 2;
    const cy = me.y * ts + ts / 2;

    // Ring fill: continuous progress from step-on (end of the arrival
    // transition = start of the first wait input phase) to escape (end of
    // the last wait input phase, when the resolver flips `escaped`).
    //   - required: BALANCE.escapeHatches.idleTurnsRequired wait turns.
    //   - each wait turn = inputMs + transitionMs.
    //   - escape fires at end of the LAST wait turn's input phase, so total
    //     duration = (required - 1) full turn cycles + 1 input phase
    //              = required * inputMs + (required - 1) * transitionMs.
    // `onHatchIdleTurns` (= completed idle input phases) + phaseRemaining are
    // sufficient to derive elapsed continuously across phase boundaries.
    const required = BALANCE.escapeHatches.idleTurnsRequired;
    const inputMs = BALANCE.match.inputPhaseSeconds * 1000;
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    const totalMs = required * inputMs + (required - 1) * transitionMs;
    const phaseRemaining = Math.max(0, this.state.phaseEndsAt - Date.now());
    let elapsed: number;
    if (this.state.phase === 'input') {
      // We're in input of wait turn (onHatchTurns + 1).
      elapsed = onHatchTurns * (inputMs + transitionMs) + (inputMs - phaseRemaining);
    } else {
      // We're in transition of wait turn `onHatchTurns` (resolver just
      // incremented). Skip-on-arrival is handled above (onHatchTurns >= 1
      // is guaranteed here).
      elapsed = (onHatchTurns - 1) * (inputMs + transitionMs) + inputMs
        + (transitionMs - phaseRemaining);
    }
    const progress = Math.max(0, Math.min(1, elapsed / totalMs));
    const g = this.escapeRing!;
    // Re-show every time we reach the draw path. The ring is created visible,
    // but setEscapeIndicatorVisible(false) hides it when the player steps off
    // the hatch; without this, stepping back onto a hatch would draw the arc
    // onto a still-hidden Graphics and nothing would appear.
    g.setVisible(true);
    g.clear();
    const radius = ts * 0.55;
    // Faint backing ring so the partially-filled arc still reads as a circle.
    // Purple to match the recolored escape-hatch tile (green is now Heal-only).
    g.lineStyle(2, 0x3a2244, 0.55);
    g.strokeCircle(cx, cy, radius);
    if (progress > 0) {
      g.lineStyle(3, 0xbb44ff, 1);
      g.beginPath();
      const start = -Math.PI / 2;
      g.arc(cx, cy, radius, start, start + progress * Math.PI * 2, false);
      g.strokePath();
    }
  }

  /** Lazy-create the escape progress ring (hidden). Idempotent. */
  private ensureEscapeIndicator(): void {
    if (this.escapeRing) return;
    const ring = this.add.graphics().setDepth(15);
    if (this.hudCamera) this.hudCamera.ignore(ring);
    this.escapeRing = ring;
  }

  /** Toggle visibility for the escape progress ring. */
  private setEscapeIndicatorVisible(visible: boolean): void {
    if (this.escapeRing) {
      this.escapeRing.setVisible(visible);
      if (!visible) this.escapeRing.clear();
    }
  }

  /** Sync console sprite frames to the local player's trio state: frame 1
   *  (active) for assigned-and-pending spots once consoles have powered on
   *  (BALANCE.consoles.activationDelayTurns), frame 0 (inactive) otherwise.
   *  Per-player perspective by design — other players see their own trios.
   *
   *  Door-style fog-of-war rule: the authoritative frame is only adopted
   *  while the player has LOS on the footprint (any of its tiles — solid
   *  tiles become 'visible' via the FogRenderer adjacent-wall pass). Outside
   *  LOS the sprite keeps the remembered last-seen frame, so a console that
   *  powered on under lesser fog still reads as dark until looked at again. */
  private updateConsoles(): void {
    if (!this.state || this.consoleSprites.length === 0) return;
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    const assigned = new Set(me?.assignedConsoles ?? []);
    const used = new Set(me?.consolesUsed ?? []);
    const powered = this.state.turnNumber > BALANCE.consoles.activationDelayTurns;
    for (const cs of this.consoleSprites) {
      const authFrame =
        powered && assigned.has(cs.idx) && !used.has(cs.idx) ? 1 : 0;
      let inLos = !this.fogRenderer; // no fog (tutorial-style) → always trust auth
      if (this.fogRenderer) {
        for (let ty = cs.box.y; ty < cs.box.y + cs.box.h && !inLos; ty++) {
          for (let tx = cs.box.x; tx < cs.box.x + cs.box.w && !inLos; tx++) {
            if (this.fogRenderer.isVisible(tx, ty)) inLos = true;
          }
        }
      }
      if (inLos) cs.memoryFrame = authFrame;
      cs.sprite.setFrame(cs.memoryFrame);
    }
  }

  /**
   * Cyan channel-progress ring under the local bomberman while engaged with
   * one of their pending consoles. Clone of the escape ring's phase-timed
   * model with required = BALANCE.consoles.interactIdleTurns (3 idle turns).
   */
  private updateConsoleReadyIndicator(): void {
    const hide = (): void => {
      if (this.consoleRing) { this.consoleRing.setVisible(false); this.consoleRing.clear(); }
    };
    if (!HIDDEN_FEATURES.keys || !this.state || !this.mapData) { hide(); return; }
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (!me || !me.alive || me.escaped) { hide(); return; }
    // Engagement is resolver-derived state — set while standing in channel
    // range of an assigned pending console (TurnResolver step 9.45).
    if (me.consoleEngagedId === null || me.consoleEngagedId === undefined) { hide(); return; }
    // Suppress during the arrival/reset transition (counter still 0 and the
    // bomberman may still be lerping) — mirror the escape ring's rule.
    const channelTurns = me.consoleIdleTurns ?? 0;
    if (this.state.phase === 'transition' && channelTurns === 0) { hide(); return; }

    if (!this.consoleRing) {
      const ring = this.add.graphics().setDepth(15);
      if (this.hudCamera) this.hudCamera.ignore(ring);
      this.consoleRing = ring;
    }
    const ts = this.mapData.tileSize;
    const cx = me.x * ts + ts / 2;
    const cy = me.y * ts + ts / 2;
    const required = BALANCE.consoles.interactIdleTurns;
    const inputMs = BALANCE.match.inputPhaseSeconds * 1000;
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    const totalMs = required * inputMs + (required - 1) * transitionMs;
    const phaseRemaining = Math.max(0, this.state.phaseEndsAt - Date.now());
    let elapsed: number;
    if (this.state.phase === 'input') {
      elapsed = channelTurns * (inputMs + transitionMs) + (inputMs - phaseRemaining);
    } else {
      elapsed = (channelTurns - 1) * (inputMs + transitionMs) + inputMs
        + (transitionMs - phaseRemaining);
    }
    const progress = Math.max(0, Math.min(1, elapsed / totalMs));
    const g = this.consoleRing;
    g.setVisible(true);
    g.clear();
    const radius = ts * 0.55;
    // Cyan — the Console system's signature color (escape ring is purple,
    // heal is green).
    g.lineStyle(2, 0x113a44, 0.55);
    g.strokeCircle(cx, cy, radius);
    if (progress > 0) {
      g.lineStyle(3, 0x44ddff, 1);
      g.beginPath();
      const start = -Math.PI / 2;
      g.arc(cx, cy, radius, start, start + progress * Math.PI * 2, false);
      g.strokePath();
    }
  }

  /**
   * Red navigation line guiding the local player through the Console flow.
   * Appears once at least one console is done: points to a seeded-random
   * pick among the remaining pending consoles, and — once the trio is done —
   * to the nearest (path-distance) unbroken escape hatch. Recomputed per
   * state update; segments over never-seen (darkest) fog are skipped, so the
   * line reads over lesser fog only, never revealing unexplored map.
   */
  private updateConsoleNavPath(): void {
    const clear = (): void => { this.consoleNavGraphics?.clear(); };
    if (!HIDDEN_FEATURES.keys || !this.state || !this.mapData) { clear(); return; }
    const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    if (!me || !me.alive || me.escaped) { clear(); return; }
    const assigned = me.assignedConsoles ?? [];
    const used = me.consolesUsed ?? [];
    const required = Math.min(BALANCE.consoles.requiredToEscape, assigned.length);
    if (assigned.length === 0 || used.length === 0) { clear(); return; }

    const spots = this.mapData.consoleSpots ?? [];
    let path: PathTile[] | null = null;
    if (used.length < required) {
      // Touching the target even once retires the line for this stage —
      // the player has seen where it is; don't keep hand-holding.
      const stageKey = `console:${used.length}`;
      if (this.consoleNavDismissed.has(stageKey)) { clear(); return; }
      // Next pending console — seeded-deterministic pick so the target is
      // stable for this stage and identical across reconnects.
      const remaining = assigned.filter(id => !used.includes(id) && spots[id]);
      if (remaining.length === 0) { clear(); return; }
      const pick = remaining[
        hashStringToInt(`${this.state.matchId}:${this.myPlayerId}:nav:${used.length}`) % remaining.length
      ];
      const box = spots[pick];
      const dx = Math.max(box.x - me.x, me.x - (box.x + box.w - 1), 0);
      const dy = Math.max(box.y - me.y, me.y - (box.y + box.h - 1), 0);
      if (Math.max(dx, dy) <= 1) {
        this.consoleNavDismissed.add(stageKey);
        clear(); return;
      }
      path = this.shortestPathToConsole(me.x, me.y, box);
    } else {
      // Trio complete — guide to the nearest unbroken hatch (any hatch
      // works). Getting near any usable hatch retires the line for good.
      if (this.consoleNavDismissed.has('hatch')) { clear(); return; }
      const broken = this.state.brokenHatches;
      const usable = this.state.escapeTiles.filter(
        esc => !broken.some(b => b.x === esc.x && b.y === esc.y),
      );
      if (usable.some(esc => Math.max(Math.abs(esc.x - me.x), Math.abs(esc.y - me.y)) <= 2)) {
        this.consoleNavDismissed.add('hatch');
        clear(); return;
      }
      let best: PathTile[] | null = null;
      for (const esc of usable) {
        const p = findPath(me.x, me.y, esc.x, esc.y, this.mapData);
        if (p.length === 0) continue;
        if (!best || p.length < best.length) best = p;
      }
      path = best;
    }

    if (!this.consoleNavGraphics) {
      // Depth 55: above fog (50) so the line reads over lesser fog; darkest
      // fog is handled by skipping unseen segments below.
      const g = this.add.graphics().setDepth(55);
      if (this.hudCamera) this.hudCamera.ignore(g);
      this.consoleNavGraphics = g;
    }
    const g = this.consoleNavGraphics;
    g.clear();
    if (!path || path.length === 0) return;
    const ts = this.mapData.tileSize;
    const full: Array<{ x: number; y: number }> = [{ x: me.x, y: me.y }, ...path];
    // Dotted + translucent — a hint, not a painted road.
    g.lineStyle(2, 0xff3344, 0.6);
    for (let i = 0; i < full.length - 1; i++) {
      const a = full[i];
      const b = full[i + 1];
      // Never draw over never-seen fog — the path must not map unexplored
      // territory. Lesser (seen-dim) fog is fine.
      if (this.fogRenderer?.isUnseen(a.x, a.y) || this.fogRenderer?.isUnseen(b.x, b.y)) continue;
      this.drawDashedLine(
        g,
        a.x * ts + ts / 2, a.y * ts + ts / 2,
        b.x * ts + ts / 2, b.y * ts + ts / 2,
      );
    }
  }

  /** Draw a line as short dashes (4px on / 6px off) using lineBetween per
   *  dash — beginPath/lineTo mixed with other primitives on one Graphics
   *  breaks silently in Phaser, lineBetween is safe. */
  private drawDashedLine(
    g: Phaser.GameObjects.Graphics,
    x1: number, y1: number, x2: number, y2: number,
    dash = 4, gap = 6,
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return;
    const ux = dx / len;
    const uy = dy / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(d + dash, len);
      g.lineBetween(x1 + ux * d, y1 + uy * d, x1 + ux * e, y1 + uy * e);
    }
  }

  /** Shortest walkable path toward the BOTTOM face of a console footprint
   *  (the footprint itself is solid). End-tile candidates are the ring tiles
   *  beside/below the footprint's bottom row — falling back to the full ring
   *  if the bottom approach is walled off — and the bottom footprint tile
   *  nearest the path's end is appended as a final, visual-only point so the
   *  drawn line lands on the console itself. Null if unreachable. */
  private shortestPathToConsole(
    sx: number, sy: number, box: { x: number; y: number; w: number; h: number },
  ): PathTile[] | null {
    const map = this.mapData;
    if (!map) return null;
    // Already in channel range — no line needed.
    const dx = Math.max(box.x - sx, sx - (box.x + box.w - 1), 0);
    const dy = Math.max(box.y - sy, sy - (box.y + box.h - 1), 0);
    if (Math.max(dx, dy) <= 1) return null;
    const bottomY = box.y + box.h - 1;
    const search = (minTy: number): PathTile[] | null => {
      let best: PathTile[] | null = null;
      for (let ty = Math.max(minTy, box.y - 1); ty <= box.y + box.h; ty++) {
        for (let tx = box.x - 1; tx <= box.x + box.w; tx++) {
          const insideBox = tx >= box.x && tx < box.x + box.w && ty >= box.y && ty < box.y + box.h;
          if (insideBox) continue;
          if (map.grid[ty]?.[tx] !== 0) continue;
          const p = findPath(sx, sy, tx, ty, map);
          if (p.length === 0) continue;
          if (!best || p.length < best.length) best = p;
        }
      }
      return best;
    };
    const best = search(bottomY) ?? search(box.y - 1);
    if (!best) return null;
    const end = best[best.length - 1];
    const bx = Math.max(box.x, Math.min(box.x + box.w - 1, end.x));
    return [...best, { x: bx, y: bottomY }];
  }

  /** Floating "+N [icon]" treasure popup that rises and fades out. Staggered
   *  by `delayMs` so multi-type pickups appear in sequence. The icon and the
   *  "+N" text render in a single tight container centered over the
   *  Bomberman so the player sees ONE popup, not a "left icon" + "right
   *  number" pair. */
  private spawnTreasurePopup(worldX: number, worldY: number, type: TreasureType, amount: number, delayMs: number): void {
    const POPUP_ICON = 7;
    const c = this.add.container(worldX, worldY).setDepth(500).setAlpha(0);
    const icon = this.add.image(0, -3, TREASURE_TEXTURE_KEY, treasureIconFrame(type))
      .setDisplaySize(POPUP_ICON, POPUP_ICON);
    const text = this.add.text(0, 4, `+${amount}`, {
      fontSize: '7px',
      color: '#ffd944',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 1,
    }).setOrigin(0.5, 0.5);
    c.add(icon);
    c.add(text);
    if (this.hudCamera) this.hudCamera.ignore(c);

    this.tweens.add({
      targets: c,
      alpha: 1,
      duration: 120,
      delay: delayMs,
    });
    this.tweens.add({
      targets: c,
      y: worldY - 16,
      alpha: 0,
      duration: 1200,
      delay: delayMs + 120,
      ease: 'Cubic.easeOut',
      onComplete: () => c.destroy(),
    });
  }

  private myBomberman(): BombermanState | null {
    return this.state?.bombermen.find(b => b.playerId === this.myPlayerId) ?? null;
  }

  /** Custom slot count for the local player (tier-driven). Falls back to the
   *  Free-tier default before the local Bomberman is known. */
  private localCustomSlotCount(): number {
    return this.myBomberman()?.maxCustomSlots ?? LOCAL_FALLBACK_CUSTOM_SLOTS;
  }

  /** Total HUD slot count (Rock + custom) for the local player. */
  private localTotalSlotCount(): number {
    return 1 + this.localCustomSlotCount();
  }

  /** Per-slot stack cap for the local player. */
  private localStackSize(): number {
    return this.myBomberman()?.stackSize ?? LOCAL_FALLBACK_STACK_SIZE;
  }

  /**
   * Apply the decal-decay alpha curve to every blood decal. Call on each
   * turn boundary; pairs with BombRenderer.applyDecalDecay which handles
   * scorch + pearl decals. See BALANCE.decalDecay in balance.ts.
   */
  private applyBloodDecalDecay(currentTurn: number): void {
    for (const g of this.bloodDecals.values()) {
      const spawnTurn = g.getData('spawnTurn') as number | undefined;
      const baseAlpha = g.getData('baseAlpha') as number | undefined;
      if (spawnTurn === undefined || baseAlpha === undefined) continue;
      const age = Math.max(0, currentTurn - spawnTurn);
      if (age <= BALANCE.decalDecay.fullTurns) continue;
      g.setAlpha(baseAlpha * decalDecayAlpha(age));
    }
  }

  private rebuildEntities(): void {
    this.entitiesLayer.removeAll(true);
    if (!this.state || !this.mapData) return;
    const ts = this.mapData.tileSize;

    // RTS-style fog filter: objects are only shown if the player has actively
    // seen them in LOS. Objects in seen-dim (previously visited but not
    // currently visible) only show if they were already discovered by the
    // player. New objects that appear while the area is dim stay hidden
    // until the player revisits.
    const rtsVisible = (entityId: string, x: number, y: number): boolean => {
      if (this.fogRenderer?.isVisible(x, y)) {
        this.knownEntities.add(entityId);
        return true;
      }
      if (this.fogRenderer?.isDiscovered(x, y) && this.knownEntities.has(entityId)) {
        return true; // stale — last-known state
      }
      return false;
    };

    // Chests are rendered as persistent animated sprites (see chestSprites +
    // updateChests), not rebuilt each frame like bodies.

    // Sync chest open state from server → local sprite permanence
    this.updateChests();

    // Sync Shield Walls + shards from server state, then apply per-tile fog
    // visibility. Walls are LoS-gated; shards are persistent (always visible
    // once revealed — handled inside the renderer).
    if (this.shieldRenderer && this.state) {
      this.shieldRenderer.syncWalls(this.state.shieldWalls ?? []);
      this.shieldRenderer.syncShards(this.state.shieldShards ?? []);
      this.shieldRenderer.applyFogVisibility(
        // Walls: LoS-only (smoke does NOT reveal walls per spec).
        (x, y) => this.fogRenderer?.isVisible(x, y) ?? false,
        // Shards: discovered (LoS now OR previously seen) — same rule as
        // bomb scorch decals. Tiles never spotted stay hidden.
        (x, y) => this.fogRenderer?.isDiscovered(x, y) ?? false,
      );
    }

    // Dropped bodies no longer need a separate indicator — the corpse sprite
    // in corpseLayer already communicates "something is here to loot". The
    // loot panel surfaces the contents when the local player stands on one.

    // Bombermen are no longer drawn here — BombermanSpriteSystem owns the
    // persistent animated sprites, HP pips, self-ring and aim shadow. They
    // live in bombermanLayer and are positioned by the per-frame `tick` based
    // on lerp state from the most recent `moved` event.

    // Sync the local player's aim shadow visibility to the sprite system —
    // covers click-driven aim toggles since rebuildEntities runs after every
    // input action.
    if (this.myPlayerId) {
      this.bombermanSpriteSystem?.setAimActive(this.myPlayerId, this.selectedSlot !== null || this.inputMode.kind === 'aim');
    }

    // Escape hatch state machine — runs only if you've wired up sprites
    if (this.escapeSprites.length > 0) this.updateEscapeHatches();

    // Key sprite reconcile with per-client fog memory.
    this.updateKeys();

    // Console sprites + red navigation line track the local trio state.
    this.updateConsoles();
    this.updateConsoleNavPath();

    // Door state machine
    if (this.doorSprites.length > 0) this.updateDoors();

    // Blood trail decals — only created when their tile is currently visible
    // (RTS fog: blood that appears while area is dim stays hidden until revisited)
    for (const bt of this.state.bloodTiles) {
      const key = `blood_${bt.x},${bt.y}`;
      if (this.bloodDecals.has(key)) continue;
      if (!rtsVisible(key, bt.x, bt.y)) continue;
      const g = this.add.graphics();
      const cx = bt.x * ts + ts / 2;
      const cy = bt.y * ts + ts / 2;
      // Larger blood splatters
      g.fillStyle(0x881111, 0.75);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.3, cy + (Math.random() - 0.5) * ts * 0.3, ts * 0.25);
      g.fillStyle(0x660808, 0.65);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.4, cy + (Math.random() - 0.5) * ts * 0.4, ts * 0.18);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.35, cy + (Math.random() - 0.5) * ts * 0.35, ts * 0.12);
      g.fillStyle(0x440505, 0.5);
      g.fillCircle(cx + (Math.random() - 0.5) * ts * 0.2, cy + (Math.random() - 0.5) * ts * 0.2, ts * 0.08);
      // Tag for decal decay — see BALANCE.decalDecay in balance.ts.
      g.setData('spawnTurn', this.state.turnNumber);
      g.setData('baseAlpha', 1.0);
      this.bloodDecalLayer.add(g);
      this.bloodDecals.set(key, g);
    }

    // Strict LOS gate for blood splats: lesser fog (0.55 alpha) doesn't hide
    // depth-25 graphics on its own, so hide them explicitly when not in LOS.
    // Reappear on re-entry. Per "never show over fog of war" rule.
    // Same for active smoke clouds (Fart Escape): the puffs are translucent
    // and render above (depth 120), so blood under a cloud would bleed
    // through — hide it outright until the cloud dissipates.
    const smokedTiles = new Set<string>();
    for (const cloud of this.state.smokeClouds ?? []) {
      for (const t of cloud.tiles) smokedTiles.add(`${t.x},${t.y}`);
    }
    for (const [key, g] of this.bloodDecals) {
      const coords = key.slice(6).split(',');
      const bx = Number(coords[0]);
      const by = Number(coords[1]);
      g.setVisible(
        (this.fogRenderer?.isVisible(bx, by) ?? true) && !smokedTiles.has(`${bx},${by}`),
      );
    }

    // Explosion decals: scorch marks persist through lesser fog. Visible
    // whenever the tile has been discovered (LOS now OR seen-dim), hidden only
    // under unexplored (greater) fog — which is opaque black anyway. This
    // stops the blast's decals from being clipped at the lesser-fog boundary
    // when an explosion reaches tiles that are discovered but out of LOS.
    this.bombRenderer?.updateDecalVisibility((x, y) => {
      const key = `decal_${x},${y}`;
      if (this.fogRenderer?.isVisible(x, y)) this.knownEntities.add(key);
      return this.fogRenderer?.isDiscovered(x, y) ?? true;
    });

    // Pearl decals: stricter rule than scorch — visible only while currently
    // in LOS. No seen-dim persistence (would bleed through lesser fog).
    this.bombRenderer?.updatePearlDecalVisibility((x, y) => this.fogRenderer?.isVisible(x, y) ?? false);

    // Path line + staged-action highlight
    this.drawPath();
    this.drawHighlights();
  }

  /**
   * Escape hatch state machine — memory-aware, fog-of-war respecting.
   *
   * The opening/closing animations are triggered exclusively by the local
   * 'escaped' event handler in resolveTurnEvents — never by passive bomberman
   * proximity. This update method only handles the lazy "snap to broken on
   * LOS re-acquire" case: if our local memory still says intact but we just
   * regained LOS on a hatch that is authoritatively broken, swap the texture
   * silently (no animation — we missed the moment of escape).
   *
   * If the tile is currently outside LOS, this method does nothing — the
   * sprite continues to render whatever its last-known state was (intact or
   * broken), which is exactly the fog-of-war memory the spec requires.
   */
  private updateEscapeHatches(): void {
    if (!this.state || !this.fogRenderer) return;
    for (const esc of this.escapeSprites) {
      // Don't interrupt in-flight animations.
      if (esc.state === 'opening' || esc.state === 'closing') continue;
      const visibleNow = this.fogRenderer.isVisible(esc.x, esc.y);
      if (!visibleNow) continue;
      const authBroken = this.state.brokenHatches.some(t => t.x === esc.x && t.y === esc.y);
      if (authBroken && !esc.memoryBroken) {
        // LOS re-acquired after a missed escape: snap to broken, no animation.
        esc.state = 'broken';
        esc.memoryBroken = true;
        esc.sprite.anims.stop();
        esc.sprite.setTexture('escape_hatch_broken', 0);
      }
    }
  }

  /**
   * Reconcile key sprites with per-client fog-of-war memory.
   *
   * For tiles currently in LOS: trust the authoritative state — if a key is
   * there, render it (and remember); if not, hide and remember "gone".
   *
   * For tiles outside LOS: render based on memory only. A key the player
   * once saw stays visible to them until they look back (and either confirm
   * it's still there or notice it was picked up). This matches the spec
   * scenario from docs/keys-system.md §9.
   */
  private updateKeys(): void {
    if (!this.state || !this.mapData || !this.fogRenderer) return;
    const ts = this.mapData.tileSize;
    const fog = this.fogRenderer;

    // Build a quick set of authoritative key positions for fast lookup.
    const authKeys = new Set<string>();
    for (const k of this.state.keys) authKeys.add(`${k.x},${k.y}`);

    // Update memory from current LOS — for each key, if its tile is in LOS,
    // memory says "present"; for tiles in LOS that USED to have a key but
    // no longer do, mark memory as "gone".
    // We iterate the union of authoritative keys + remembered tiles so we
    // catch the "I had it remembered, now I see it's gone" transition.
    const tilesToCheck = new Set<string>();
    for (const key of authKeys) tilesToCheck.add(key);
    for (const key of this.keyMemory.keys()) tilesToCheck.add(key);

    for (const tileKey of tilesToCheck) {
      const [xs, ys] = tileKey.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (fog.isVisible(x, y)) {
        this.keyMemory.set(tileKey, authKeys.has(tileKey));
      }
      // Outside LOS: leave memory untouched.
    }

    // Reconcile sprites: each memory entry with present=true gets a sprite.
    // Entries with present=false get their sprite (if any) destroyed.
    for (const [tileKey, present] of this.keyMemory) {
      const existing = this.keySprites.get(tileKey);
      if (present) {
        if (!existing) {
          const [xs, ys] = tileKey.split(',');
          const x = Number(xs);
          const y = Number(ys);
          const img = this.add.image(x * ts + ts / 2, y * ts + ts / 2, 'key')
            .setDisplaySize(ts, ts)
            .setDepth(15);
          if (this.hudCamera) this.hudCamera.ignore(img);
          this.keySprites.set(tileKey, img);
        }
      } else if (existing) {
        existing.destroy();
        this.keySprites.delete(tileKey);
      }
    }
  }

  /**
   * Sync `chestSprites` to the latest `state.chests`. Creates sprites for
   * newly-added chests and destroys sprites for chests that disappeared.
   * Called both on first map load (during handleMatchState's firstFrame
   * block) and on every subsequent state update so the tutorial's
   * spawnChest mutations render correctly.
   */
  private syncChestSprites(state: MatchState, mapTs: number): void {
    const stateChests = state.chests ?? [];

    // Remove sprites whose chest is no longer in state.
    const liveIds = new Set(stateChests.map(c => c.id));
    for (let i = this.chestSprites.length - 1; i >= 0; i--) {
      if (!liveIds.has(this.chestSprites[i].id)) {
        this.chestSprites[i].sprite.destroy();
        this.chestSprites.splice(i, 1);
      }
    }

    // Add sprites for new chests.
    const existingIds = new Set(this.chestSprites.map(cs => cs.id));
    const isTutorial = state.isTutorial === true;
    for (const chest of stateChests) {
      if (existingIds.has(chest.id)) continue;
      const key = `chest_${chest.tier}` as 'chest_1' | 'chest_2' | 'chest_3';
      const sprite = this.add.sprite(
        chest.x * mapTs + mapTs / 2,
        chest.y * mapTs + mapTs,
        key,
      );
      sprite.setDepth(15);
      sprite.setOrigin(0.5, 1);
      const opened = chest.opened;
      sprite.play(opened ? `${key}_open` : `${key}_closed`);
      if (this.hudCamera) this.hudCamera.ignore(sprite);
      this.chestSprites.push({
        id: chest.id, x: chest.x, y: chest.y, tier: chest.tier,
        sprite, state: opened ? 'open' : 'closed',
        permanentlyOpened: opened,
        wasVisible: false,
      });

      // Tutorial: chests appear via scripted `spawnChest`, so puff smoke
      // underneath them so the appearance reads as an event rather than a
      // jump-cut. Skipped in real matches (chests are placed at match start).
      if (isTutorial && !opened) {
        this.spawnChestAppearSmoke(chest.x, chest.y, mapTs);
      }
    }
  }

  /** Melee impact VFX at a Bomberman's center mass — a single yellow circle
   *  that expands outward from the victim's center-mass point (the tile
   *  center, lifted ~half a tile so it sits over the torso, not the feet)
   *  and fades to alpha 0 as it grows. Scheduled by the melee_attack
   *  handler to fire at the Attack3 connect frame so it reads as contact.
   *
   *  Renders inside `explosionLayer` (depth 120, always-above-fog) — same
   *  container the existing teleport puff uses. */
  private spawnMeleeSmackVfx(victimId: string): void {
    if (!this.state || !this.mapData) return;
    const victim = this.state.bombermen.find(b => b.playerId === victimId);
    if (!victim) return;
    if (!this.explosionLayer) return;
    const ts = this.mapData.tileSize;
    const cx = victim.x * ts + ts / 2;
    const cy = victim.y * ts + ts / 2 - ts * 0.5;
    const startR = ts * 0.25;
    const endR = ts * 0.9;
    const duration = 360;

    // One Graphics that holds the circle outline. We re-draw it each tick
    // of the tween at the interpolated radius. Alpha-tweens the Graphics
    // itself so the whole shape fades uniformly.
    const ring = this.add.graphics();
    this.explosionLayer.add(ring);
    const draw = (r: number): void => {
      ring.clear();
      ring.lineStyle(3, 0xffe44a, 1);
      ring.strokeCircle(cx, cy, r);
    };
    draw(startR);

    const obj = { r: startR };
    this.tweens.add({
      targets: obj,
      r: endR,
      duration,
      ease: 'Cubic.easeOut',
      onUpdate: () => { if (ring.active) draw(obj.r); },
    });
    this.tweens.add({
      targets: ring,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  /** Gray smoke puff under a tile — used in the tutorial when a scripted
   *  chest pops into existence. Renders below the chest sprite (depth 14)
   *  so the chest itself stays on top. */
  private spawnChestAppearSmoke(tileX: number, tileY: number, ts: number): void {
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts - 4; // near the chest's bottom edge
    const duration = 600;

    const g = this.add.graphics().setDepth(14);
    if (this.hudCamera) this.hudCamera.ignore(g);
    this.tweens.add({
      targets: g,
      duration,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.progress;
        g.clear();
        g.fillStyle(0x9a9a9a, (1 - t) * 0.7);
        g.fillCircle(cx, cy, ts * (0.25 + 0.55 * t));
        g.fillStyle(0xcccccc, (1 - t) * 0.5);
        g.fillCircle(cx, cy - ts * 0.1 * t, ts * (0.15 + 0.35 * t));
      },
      onComplete: () => g.destroy(),
    });

    // A few drifting puff particles for shape; rise up and outward, fade.
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI; // mostly upward
      const dist = ts * (0.35 + Math.random() * 0.35);
      const dot = this.add.graphics().setDepth(14);
      if (this.hudCamera) this.hudCamera.ignore(dot);
      dot.fillStyle(0xb0b0b0, 0.7);
      dot.fillCircle(0, 0, 2 + Math.random() * 1.5);
      dot.setPosition(cx, cy);
      this.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: duration * 0.9,
        ease: 'Cubic.easeOut',
        onComplete: () => dot.destroy(),
      });
    }
  }

  /**
   * Spawn a floating "!" over a world-space point. Used by the rush-broken
   * indicator and by the tutorial's scripted enemy-reveal highlight.
   */
  spawnExclamation(worldX: number, worldY: number, color: string = '#ff4444'): void {
    const indicator = this.add.text(worldX, worldY, '!', {
      fontSize: '20px', color, fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(150);
    if (this.hudCamera) this.hudCamera.ignore(indicator);
    const ts = this.mapData?.tileSize ?? 32;
    this.tweens.add({
      targets: indicator,
      y: worldY - ts * 1.5,
      alpha: 0,
      duration: 1200,
      ease: 'Cubic.easeOut',
      onComplete: () => indicator.destroy(),
    });
  }

  /**
   * Chest animation state machine — same proximity pattern as escape hatches.
   * Once a chest is `opened` on the server, it stays permanently open.
   */
  private updateChests(): void {
    if (!this.state) return;
    for (const cs of this.chestSprites) {
      const key = `chest_${cs.tier}` as 'chest_1' | 'chest_2' | 'chest_3';

      // RTS fog: chest only visible if tile is in LOS or was previously discovered
      const entityId = `chest_${cs.id}`;
      const vis = this.fogRenderer?.isVisible(cs.x, cs.y) ?? false;
      if (vis) {
        this.knownEntities.add(entityId);
        cs.sprite.setVisible(true);
      } else if (this.fogRenderer?.isDiscovered(cs.x, cs.y) && this.knownEntities.has(entityId)) {
        cs.sprite.setVisible(true);
        // In seen-dim: snap any in-progress transition to its rest frame so
        // the user doesn't see the tail end of opening/closing animations.
        if (cs.state === 'opening') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        } else if (cs.state === 'closing') {
          cs.state = 'closed';
          cs.sprite.play(`${key}_closed`);
        }
        cs.wasVisible = false;
        continue;
      } else {
        cs.sprite.setVisible(false);
        cs.wasVisible = false;
        continue;
      }

      // Doors rule applied to chests too: if the player is gaining LoS on
      // this tile THIS frame, skip any wind-up animation. The chest just
      // snaps to whatever state matches the world (server-opened or a
      // bomberman currently adjacent). Prevents enemies walking adjacent
      // in the dim from "revealing themselves" via a chest anim the moment
      // the player reveals the tile.
      const justRevealed = !cs.wasVisible;

      // Sync server opened state → permanent
      const serverChest = this.state.chests.find(c => c.id === cs.id);
      if (serverChest?.opened && !cs.permanentlyOpened) {
        cs.permanentlyOpened = true;
        if (cs.state !== 'open' && cs.state !== 'opening') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        }
      }

      // Permanently opened chests skip proximity logic
      if (cs.permanentlyOpened) {
        if (cs.state === 'opening') { cs.wasVisible = vis; continue; }
        if (cs.state !== 'open') {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        }
        cs.wasVisible = vis;
        continue;
      }

      // Proximity check: any alive, non-escaped Bomberman within Chebyshev ≤ 1
      const nearby = this.state.bombermen.some(b =>
        b.alive && !b.escaped &&
        Math.max(Math.abs(b.x - cs.x), Math.abs(b.y - cs.y)) <= 1,
      );

      if (nearby && cs.state === 'closed') {
        if (justRevealed) {
          cs.state = 'open';
          cs.sprite.play(`${key}_open`);
        } else {
          cs.state = 'opening';
          cs.sprite.play(`${key}_opening`);
          cs.sprite.once('animationcomplete', () => {
            cs.state = 'open';
            cs.sprite.play(`${key}_open`);
          });
        }
      } else if (!nearby && cs.state === 'open') {
        if (justRevealed) {
          cs.state = 'closed';
          cs.sprite.play(`${key}_closed`);
        } else {
          cs.state = 'closing';
          cs.sprite.play(`${key}_closing`);
          cs.sprite.once('animationcomplete', () => {
            cs.state = 'closed';
            cs.sprite.play(`${key}_closed`);
          });
        }
      }

      cs.wasVisible = vis;
    }
  }

  /**
   * Door animation state machine. Doors open on proximity (Chebyshev ≤ 1 of
   * any door tile) and stay open permanently. Also syncs server opened state.
   */
  private updateDoors(): void {
    if (!this.state) return;
    for (const ds of this.doorSprites) {
      const prefix = ds.orientation === 'horizontal' ? 'h' : 'v';
      const animKey = `door_${prefix}`;

      // RTS fog: door visible if ANY of its tiles are in LOS or previously discovered
      const entityId = `door_${ds.id}`;
      const anyVisible = ds.tiles.some(t => this.fogRenderer?.isVisible(t.x, t.y));
      if (anyVisible) {
        this.knownEntities.add(entityId);
        ds.sprite.setVisible(true);
      } else {
        const anyDiscovered = ds.tiles.some(t => this.fogRenderer?.isDiscovered(t.x, t.y));
        if (anyDiscovered && this.knownEntities.has(entityId)) {
          ds.sprite.setVisible(true);
          // In seen-dim: snap any in-progress opening animation to its final
          // rest frame. Phaser keeps playing frame-by-frame once play() is
          // called, so a door mid-open when the player walks away would keep
          // animating visibly through the dim fog without this.
          if (ds.state === 'opening') {
            ds.state = 'open';
            ds.sprite.play(`${animKey}_open`);
          }
          continue;
        }
        ds.sprite.setVisible(false);
        continue;
      }

      // Sync server state — but ONLY when no opening animation is pending.
      // If openingPending is true, a `door_opened` event just arrived and
      // its BEAT3-delayed handler will set `ds.opened` after picking
      // animate-vs-snap based on LoS. Setting ds.opened here would let the
      // snap branch below preempt the animation handler and skip the
      // opening play entirely.
      if (!ds.openingPending) {
        const serverDoor = this.state.doors?.find(d => d.id === ds.id);
        if (serverDoor?.opened && !ds.opened) {
          ds.opened = true;
        }
      }

      // Snap-to-open fallback for doors that opened without a witnessed
      // event (e.g. the door was already open when this client joined, or
      // the event was missed). Gated on !openingPending so the pending
      // animation handler from onTurnResult always wins the race.
      if (ds.opened && !ds.openingPending && ds.state !== 'open' && ds.state !== 'opening') {
        ds.state = 'open';
        ds.sprite.play(`${animKey}_open`);
      }
    }
  }

  private drawPath(): void {
    this.pathGraphics.clear();
    if (this.inputMode.kind !== 'pathing' || !this.mapData) return;
    const me = this.myBomberman();
    if (!me) return;
    const ts = this.mapData.tileSize;

    // Skip tiles already traversed this turn. During transition `me.x/y` has
    // already advanced to the resolved-post-turn position, but flushStaged-
    // Action only pops in the *next* input phase. Without this skip the path
    // line backtracks (e.g. in rush: me=B, path[0]=A, line goes B→A→B→...).
    let skipUpTo = 0;
    for (let i = 0; i < Math.min(2, this.inputMode.path.length); i++) {
      if (this.inputMode.path[i].x === me.x && this.inputMode.path[i].y === me.y) {
        skipUpTo = i + 1;
        break;
      }
    }
    const drawTiles = this.inputMode.path.slice(skipUpTo);

    const points: Phaser.Math.Vector2[] = [];
    points.push(new Phaser.Math.Vector2(me.x * ts + ts / 2, me.y * ts + ts / 2));
    for (const p of drawTiles) {
      points.push(new Phaser.Math.Vector2(p.x * ts + ts / 2, p.y * ts + ts / 2));
    }

    // Thin path line
    this.pathGraphics.lineStyle(1.5, 0x44aaff, 0.5);
    this.pathGraphics.beginPath();
    this.pathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.pathGraphics.lineTo(points[i].x, points[i].y);
    this.pathGraphics.strokePath();

    // Pause-aware waypoint markers, computed over the post-skip drawTiles so
    // they reflect the FUTURE path from me's current position.
    //   - Non-rush, length N: every index is a pause.
    //   - Rush, length N: pause if (i % 2 === 1) OR (i === N - 1). drawTiles[0]
    //     is the passthrough the rush sweeps through; drawTiles[1] is the
    //     pause/landing. Final tile is always a pause (1-tile fallback if the
    //     parity would otherwise make it a passthrough).
    //
    // Hourglass on pauseIndices[0] (= next-walk-target). Empties at walk-start,
    // then *switches* to the next pause and refills:
    //   - input phase:      remaining = phaseRemaining  (drains over input,
    //                       reaches 0 at end-of-input = walk-start).
    //   - transition phase: remaining = phaseRemaining + inputMs  (refills to
    //                       full at walk-start = start of transition because
    //                       drawTiles has shifted past the just-walked tile,
    //                       drains through transition + next input, hits 0 at
    //                       the next walk-start).
    // Denominator = totalMs = inputMs + transitionMs. A click mid-input shows
    // the hourglass partially drained (the cycle started at the prior walk-
    // start).
    // Dots render on every other pause tile (the non-hourglass ones). Rush
    // passthrough tiles get no marker; the path line still draws through them.
    const phase = this.state?.phase;
    const inputMs = BALANCE.match.inputPhaseSeconds * 1000;
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    const totalMs = inputMs + transitionMs;
    const phaseRemaining = this.state ? Math.max(0, this.state.phaseEndsAt - Date.now()) : 0;
    const rushActive = me.rushActive;
    const N = drawTiles.length;
    const pauseIndices: number[] = [];
    for (let i = 0; i < N; i++) {
      const isPause = !rushActive || (i % 2 === 1) || (i === N - 1);
      if (isPause) pauseIndices.push(i);
    }
    let hourglassIdx = -1;
    let hourglassRemaining = 0;
    if (this.state && pauseIndices.length > 0 && (phase === 'input' || phase === 'transition')) {
      hourglassIdx = pauseIndices[0];
      hourglassRemaining = phase === 'input' ? phaseRemaining : phaseRemaining + inputMs;
    }
    for (let i = 0; i < N; i++) {
      const p = drawTiles[i];
      const cx = p.x * ts + ts / 2;
      const cy = p.y * ts + ts / 2;
      if (i === hourglassIdx) {
        const progress = Math.max(0, Math.min(1, hourglassRemaining / totalMs));
        const radius = ts * 0.255;
        this.pathGraphics.lineStyle(1.5, 0x223344, 0.4);
        this.pathGraphics.strokeCircle(cx, cy, radius);
        if (progress > 0) {
          // Move-green (matches the 'move' click feedback + mobile urgent-move
          // hourglass) — distinct from the blue path line/dots around it.
          this.pathGraphics.lineStyle(2.5, 0x44ff88, 0.76);
          this.pathGraphics.beginPath();
          const start = -Math.PI / 2;
          this.pathGraphics.arc(cx, cy, radius, start, start + progress * Math.PI * 2, false);
          this.pathGraphics.strokePath();
        }
      } else if (pauseIndices.includes(i)) {
        this.pathGraphics.lineStyle(1, 0x44aaff, 0.4);
        this.pathGraphics.strokeCircle(cx, cy, 3);
      }
      // else: rush passthrough tile — path line draws through it, no marker
    }
  }

  /** Pop-in feedback ring on the clicked tile (final move destination for
   *  pathing, or target tile for an attack). Outline only (transparent
   *  interior). Grows fast then slow-fades out. Depth 90 — below the
   *  bomberman sprite at 100. */
  private spawnClickFeedback(kind: 'move' | 'attack', tileX: number, tileY: number): void {
    if (!this.mapData) return;
    const ts = this.mapData.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const color = kind === 'move' ? 0x44ff88 : 0xff4466;
    // 30% smaller than the prior ts*0.55 → ts*0.385.
    const baseRadius = ts * 0.385;

    const g = this.add.graphics().setDepth(90);
    if (this.hudCamera) this.hudCamera.ignore(g);
    g.lineStyle(3, color, 1);
    g.strokeCircle(0, 0, baseRadius);
    g.setPosition(cx, cy);
    g.setScale(0.15);

    // Two-stage tween: fast pop to full size, then slow expand + fade-out.
    this.tweens.add({
      targets: g,
      scale: 1.0,
      duration: 90,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: g,
          scale: 1.45,
          alpha: 0,
          duration: 320,
          ease: 'Sine.easeOut',
          onComplete: () => g.destroy(),
        });
      },
    });
  }


  /** Spawn a transient copy of the aim indicator that fades out over 1s when
   *  the bomb has actually been thrown. The live highlightGraphics is cleared
   *  the moment inputMode flips to idle, so we render the fading copy as a
   *  separate one-shot Graphics. Same depth as highlightGraphics (65) so it
   *  stays beneath any bomberman sprite overlapping the target tile. */
  private spawnAimFadeOut(tileX: number, tileY: number): void {
    if (!this.mapData) return;
    const ts = this.mapData.tileSize;
    const cx = tileX * ts + ts / 2;
    const cy = tileY * ts + ts / 2;
    const half = ts * 0.35;

    const g = this.add.graphics().setDepth(65);
    if (this.hudCamera) this.hudCamera.ignore(g);
    g.fillStyle(0xff4444, 0.15);
    g.fillRect(tileX * ts, tileY * ts, ts, ts);
    g.lineStyle(1, 0xff4444, 0.8);
    g.lineBetween(cx - half, cy - half, cx + half, cy + half);
    g.lineBetween(cx - half, cy + half, cx + half, cy - half);

    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: 1000,
      ease: 'Sine.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  /**
   * Throw reticle: a dotted parabolic trajectory arc from the local Bomberman
   * to the (snapped) target, a simple red X cross on the target, and a red
   * countdown hourglass over it. Replaces the old filled-square + cross.
   * The arc dots live on `trajectoryGraphics`; the cross + hourglass on
   * `highlightGraphics` (see the trajectoryGraphics field doc for why).
   */
  private drawHighlights(): void {
    this.highlightGraphics.clear();
    this.trajectoryGraphics.clear();
    if (!this.mapData) return;
    const ts = this.mapData.tileSize;
    const me = this.myBomberman();

    // Snapped throw target (committed aim > armed-hover), or null when not aiming.
    const snapped = this.currentThrowAimTile();
    if (!snapped || !me) return;
    const cx = snapped.x * ts + ts / 2;
    const cy = snapped.y * ts + ts / 2;

    // Dotted parabolic arc from the Bomberman's tile center to the target.
    this.drawTrajectoryArc(me.x * ts + ts / 2, me.y * ts + ts / 2, cx, cy, ts);

    // Simple red X cross on the target tile.
    const half = ts * 0.35;
    this.highlightGraphics.lineStyle(1.5, 0xff4444, 0.85);
    this.highlightGraphics.lineBetween(cx - half, cy - half, cx + half, cy + half);
    this.highlightGraphics.lineBetween(cx - half, cy + half, cx + half, cy - half);

    // Red countdown hourglass over the cross.
    this.drawTargetHourglass(cx, cy, ts);
  }

  /**
   * The snapped throw-target tile while the local player is aiming a throw
   * (committed aim target > armed-slot hover), or null when not aiming. Shared
   * by the throw reticle (drawHighlights) and the Contour reveal so both track
   * the exact same tile.
   */
  private currentThrowAimTile(): { x: number; y: number } | null {
    const me = this.myBomberman();
    const bombType = this.selectedThrowBombType();
    if (!me || !bombType) return null;

    // Raw target: committed aim target > armed-hover preview.
    let rawTx: number | null = null;
    let rawTy: number | null = null;
    if (this.inputMode.kind === 'aim'
        && this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
      rawTx = this.inputMode.targetX;
      rawTy = this.inputMode.targetY;
    } else if (this.selectedSlot !== null
        && this.hoveredTileX !== null && this.hoveredTileY !== null) {
      rawTx = this.hoveredTileX;
      rawTy = this.hoveredTileY;
    }
    if (rawTx === null || rawTy === null) return null;

    // Snap to a valid target. The committed aim target is already snapped at
    // click time, so re-snapping it is a no-op.
    return this.snapThrowTarget(rawTx, rawTy, bombType);
  }

  /** Bomb type currently armed for throwing (committed aim or hover slot), or null. */
  private selectedThrowBombType(): BombType | null {
    const me = this.myBomberman();
    if (!me) return null;
    let slotIdx: number | null = null;
    if (this.inputMode.kind === 'aim') slotIdx = this.inputMode.slotIndex;
    else if (this.selectedSlot !== null) slotIdx = this.selectedSlot;
    if (slotIdx === null) return null;
    if (slotIdx === 0) return 'rock';
    return me.inventory.slots[slotIdx - 1]?.type ?? null;
  }

  /**
   * Snap a raw cursor tile to a throw target:
   *  - Greater (black) fog → any tile (you can't see whether it's a wall).
   *  - Flare/Phosphorus/Fart Escape → any tile.
   *  - Otherwise (restricted bomb in discovered space) → the tile if it's floor,
   *    else the nearest floor tile. No range limit.
   */
  private snapThrowTarget(rawTx: number, rawTy: number, bombType: BombType): { x: number; y: number } {
    if (!this.mapData) return { x: rawTx, y: rawTy };
    if (this.fogRenderer?.isUnseen(rawTx, rawTy)) return { x: rawTx, y: rawTy };
    if (THROW_ANYWHERE_BOMBS.has(bombType)) return { x: rawTx, y: rawTy };
    if (this.isFloorTile(rawTx, rawTy)) return { x: rawTx, y: rawTy };
    return this.nearestFloorTile(rawTx, rawTy) ?? { x: rawTx, y: rawTy };
  }

  private isFloorTile(tx: number, ty: number): boolean {
    return this.mapData?.grid[ty]?.[tx] === 0;
  }

  /** Nearest floor tile to (tx,ty) by ring search (capped). Null if none near. */
  private nearestFloorTile(tx: number, ty: number): { x: number; y: number } | null {
    const md = this.mapData;
    if (!md) return null;
    const MAX_R = 10;
    for (let r = 1; r <= MAX_R; r++) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= md.width || ny >= md.height) continue;
          if (md.grid[ny]?.[nx] !== 0) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Dotted parabolic arc from (sx,sy) to (ex,ey). Dots evenly spaced along the
   * curve; the path lifts upward proportional to distance so it reads as a
   * lobbed throw. Drawn on trajectoryGraphics (fillCircle only).
   */
  private drawTrajectoryArc(sx: number, sy: number, ex: number, ey: number, ts: number): void {
    const dist = Math.hypot(ex - sx, ey - sy);
    if (dist < 2) return;
    const arcHeight = Math.min(ts * 2.2, dist * 0.35);
    const dotCount = Math.max(4, Math.round(dist / (ts * 0.42)));
    const dotR = Math.max(1.5, ts * 0.06);
    // Skip the first stretch so dots don't pile onto the thrower sprite.
    const startT = Math.min(0.35, (ts * 0.5) / dist);
    this.trajectoryGraphics.fillStyle(0xff4444, 0.85);
    for (let i = 0; i <= dotCount; i++) {
      const t = startT + (1 - startT) * (i / dotCount);
      const x = sx + (ex - sx) * t;
      const y = sy + (ey - sy) * t - arcHeight * 4 * t * (1 - t);
      this.trajectoryGraphics.fillCircle(x, y, dotR);
    }
  }

  /**
   * Red countdown hourglass over the throw target. Functions EXACTLY like the
   * movement path hourglass (drawPath), just red:
   *  - denominator is the full turn (`totalMs = inputMs + transitionMs`)
   *  - endpoint is throw-start (input→transition boundary), so during input the
   *    arc drains `phaseRemaining/totalMs`; during transition it shows the
   *    refilled `(phaseRemaining + inputMs)/totalMs` (matches the movement model)
   *  - driven off the global phase timer, so it never resets on click
   * strokeCircle + arc/strokePath only — mirrors drawPath, no fillCircle here.
   */
  private drawTargetHourglass(cx: number, cy: number, ts: number): void {
    if (!this.state) return;
    const phase = this.state.phase;
    if (phase !== 'input' && phase !== 'transition') return;
    const inputMs = BALANCE.match.inputPhaseSeconds * 1000;
    const transitionMs = BALANCE.match.transitionPhaseSeconds * 1000;
    const totalMs = inputMs + transitionMs;
    const phaseRemaining = Math.max(0, this.state.phaseEndsAt - Date.now());
    const remaining = phase === 'input' ? phaseRemaining : phaseRemaining + inputMs;
    const progress = Math.max(0, Math.min(1, remaining / totalMs));
    const radius = ts * 0.255;
    const g = this.highlightGraphics;
    g.lineStyle(1.5, 0x442222, 0.4);
    g.strokeCircle(cx, cy, radius);
    if (progress > 0) {
      g.lineStyle(2.5, 0xff4466, 0.76);
      g.beginPath();
      const start = -Math.PI / 2;
      g.arc(cx, cy, radius, start, start + progress * Math.PI * 2, false);
      g.strokePath();
    }
  }

  /**
   * Explosion-ghost overlay (depth 0.5; fog occludes it naturally). Two parts:
   *  1. Landed bombs (visible to everyone): filled 40% red tiles for delayed
   *     explosives (excluding the impact/non-damaging types). Tiles that a
   *     next-resolution detonation covers (fuseRemaining===0) flash.
   *  2. Aiming preview (local player only): a red outline of where the armed
   *     bomb would land, following the snapped target. Hidden in greater fog.
   * Zones are unioned so overlapping bombs paint each tile once.
   */
  private drawGhostZones(): void {
    this.ghostGraphics.clear();
    if (!this.mapData || !this.state) return;
    const ts = this.mapData.tileSize;
    const closedDoors = this.buildClosedDoorSet();
    const shieldWalls = this.buildShieldWallSet();

    // --- Landed bombs (filled, everyone) ---
    const landed = new Map<string, { x: number; y: number; flash: boolean }>();
    for (const b of this.state.bombs) {
      if (LANDED_GHOST_EXCLUDED.has(b.type)) continue;
      // Flash only when an actual explosion is imminent. A scatter bomb (Banana)
      // at fuse 0 merely spawns its children (no blast that turn), so it stays
      // steady — only the spawned children flash when THEY are about to explode.
      const flash = b.fuseRemaining === 0 && BOMB_CATALOG[b.type].behavior.kind !== 'scatter';
      for (const t of bombAffectedTiles(b.type, b.x, b.y, this.mapData, closedDoors, shieldWalls)) {
        const key = `${t.x},${t.y}`;
        const cell = landed.get(key);
        if (cell) { if (flash) cell.flash = true; }
        else landed.set(key, { x: t.x, y: t.y, flash });
      }
    }
    // Flash via Date.now() oscillation (no tween — Phaser forceSetTimeOut gotcha).
    // Alphas are ~1/3 more transparent than the first pass (×2/3).
    const flashAlpha = 0.167 + 0.20 * (0.5 + 0.5 * Math.sin(Date.now() / 150));
    for (const cell of landed.values()) {
      this.ghostGraphics.fillStyle(0xff4444, cell.flash ? flashAlpha : 0.27);
      this.ghostGraphics.fillRect(cell.x * ts, cell.y * ts, ts, ts);
    }

    // --- Aiming preview (outline, local only) ---
    if (this.selectedSlot !== null || this.inputMode.kind === 'aim') {
      const bombType = this.selectedThrowBombType();
      let rawTx: number | null = null;
      let rawTy: number | null = null;
      if (this.inputMode.kind === 'aim'
          && this.inputMode.targetX !== null && this.inputMode.targetY !== null) {
        rawTx = this.inputMode.targetX;
        rawTy = this.inputMode.targetY;
      } else if (this.hoveredTileX !== null && this.hoveredTileY !== null) {
        rawTx = this.hoveredTileX;
        rawTy = this.hoveredTileY;
      }
      if (bombType && rawTx !== null && rawTy !== null) {
        const snapped = this.snapThrowTarget(rawTx, rawTy, bombType);
        // Don't reveal a zone whose target sits in greater (black) fog.
        if (!this.fogRenderer?.isUnseen(snapped.x, snapped.y)) {
          const tiles = bombAffectedTiles(bombType, snapped.x, snapped.y, this.mapData, closedDoors, shieldWalls);
          this.strokeZonePerimeter(tiles, ts);
        }
      }
    }
  }

  /** Outline the perimeter of a tile set (only edges bordering non-set tiles). */
  private strokeZonePerimeter(tiles: Array<{ x: number; y: number }>, ts: number): void {
    const set = new Set(tiles.map(t => `${t.x},${t.y}`));
    this.ghostGraphics.lineStyle(2, 0xff4444, 0.57); // ~1/3 more transparent (×2/3)
    for (const t of tiles) {
      const px = t.x * ts;
      const py = t.y * ts;
      if (!set.has(`${t.x},${t.y - 1}`)) this.ghostGraphics.lineBetween(px, py, px + ts, py);
      if (!set.has(`${t.x},${t.y + 1}`)) this.ghostGraphics.lineBetween(px, py + ts, px + ts, py + ts);
      if (!set.has(`${t.x - 1},${t.y}`)) this.ghostGraphics.lineBetween(px, py, px, py + ts);
      if (!set.has(`${t.x + 1},${t.y}`)) this.ghostGraphics.lineBetween(px + ts, py, px + ts, py + ts);
    }
  }

  private buildClosedDoorSet(): Set<string> {
    const s = new Set<string>();
    if (!this.state) return s;
    for (const d of this.state.doors) {
      if (d.opened) continue;
      for (const t of d.tiles) s.add(`${t.x},${t.y}`);
    }
    return s;
  }

  private buildShieldWallSet(): Set<string> {
    const s = new Set<string>();
    if (!this.state) return s;
    for (const w of this.state.shieldWalls) {
      for (const t of w.tiles) s.add(`${t.x},${t.y}`);
    }
    return s;
  }

  private onClick(pointer: Phaser.Input.Pointer): void {
    if (!this.state) return;
    if (!this.mapData) return;

    // Dead players can't interact with anything
    const me = this.myBomberman();
    if (!me || !me.alive) return;
    // Stun gate: ignore clicks while stunned — the server would reject them
    // anyway. HUD renders a lock icon to make the state visible.
    if ((me.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)) return;


    // Loot panel intercepts first (it sits above the bomb tray).
    const lootSlot = this.hitTestLootPanel(pointer.x, pointer.y);
    if (lootSlot >= 0) {
      this.onLootSlotClicked(lootSlot);
      return;
    }

    // HUD bomb slots
    const hudSlot = this.hitTestHud(pointer.x, pointer.y);
    if (hudSlot >= 0) {
      this.onSlotClicked(hudSlot);
      return;
    }

    // World-space tile click
    const ts = this.mapData.tileSize;
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const tx = Math.floor(worldPoint.x / ts);
    const ty = Math.floor(worldPoint.y / ts);

    if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) return;
    if (me.escaped) return;

    // Tutorial: when a walk-target highlight is posted (circle on a specific
    // tile), only clicks on that tile or on self are honored — every other
    // tile is ignored. This stops dialogue-dismiss clicks and stray map
    // clicks from BFS-walking the player off the scripted path, and lets a
    // single click on the highlighted tile both dismiss the active dialogue
    // and fire the real gameplay action (e.g. wait-one-turn on the escape
    // hatch). When no walk target is posted we fall back to the general
    // "block gameplay clicks while a dialogue/pause is up" rule so those
    // beats still can't leak phantom actions.
    if (this.mode === 'tutorial') {
      const overlay = this.scene.get('TutorialOverlayScene') as TutorialOverlayScene | undefined;
      const walkTarget = overlay?.getActiveWalkTargetTile?.(ts) ?? null;
      const isSelf = tx === me.x && ty === me.y;
      if (walkTarget) {
        const onTarget = tx === walkTarget.x && ty === walkTarget.y;
        if (!onTarget && !isSelf) return;
      } else if (overlay?.isBlockingInput?.()) {
        return;
      }
    }

    // Click on self = cancel any staged action (armed slot stays)
    if (tx === me.x && ty === me.y) {
      this.inputMode = { kind: 'idle' };
      this.flushStagedAction();
      this.rebuildEntities();
      this.renderHud();
      return;
    }

    // Armed slot: click = throw at this tile (stops movement, goes idle after)
    if (this.selectedSlot !== null) {
      const slotIdx = this.selectedSlot;
      const selectedType: BombType = slotIdx === 0 ? 'rock'
        : (me.inventory.slots[slotIdx - 1]?.type ?? 'rock');

      // Snap to the same tile the aiming preview points at: restricted bombs
      // land on the nearest floor tile (so a wall-click still throws to a valid
      // tile), flare/phosphorus/fart and greater-fog clicks pass through. This
      // is the committed throw target.
      const snapped = this.snapThrowTarget(tx, ty, selectedType);

      // Stage the throw via aim mode (flushStagedAction handles sending +
      // the input-phase gate so throws queued during transition are deferred).
      this.inputMode = {
        kind: 'aim',
        slotIndex: slotIdx,
        targetX: snapped.x,
        targetY: snapped.y,
      };
      this.selectedSlot = null;
      this.spawnClickFeedback('attack', snapped.x, snapped.y);
      this.flushStagedAction();
      this.rebuildEntities();
      this.renderHud();
      return;
    }

    // Otherwise: compute BFS path and stage the first move
    const path = findPath(me.x, me.y, tx, ty, this.mapData);
    if (path.length === 0) {
      console.log(`[click] no path to (${tx},${ty})`);
      return;
    }
    this.inputMode = { kind: 'pathing', path };
    // Spawn feedback at the final destination tile of the chosen path —
    // that's the player's intent, not the immediate next step.
    const dest = path[path.length - 1];
    this.spawnClickFeedback('move', dest.x, dest.y);
    this.flushStagedAction();
    this.rebuildEntities();
  }

  private sendAction(action: { kind: 'idle' } | { kind: 'move'; x: number; y: number; rushX?: number; rushY?: number } | { kind: 'throw'; slotIndex: number; x: number; y: number }): void {
    this.backend?.sendAction(action);
  }

  /** Exposed to TutorialOverlayScene so its camera pans can target the world camera. */
  getMainCamera(): Phaser.Cameras.Scene2D.Camera {
    return this.cameras.main;
  }

  /** Exposed to the tutorial: freeze or unfreeze the follow-player camera.
   *  While locked, `update()` skips centerOn, so scripted panCamera targets
   *  stay put instead of snapping back to the player on the next frame. */
  setTutorialCameraLocked(locked: boolean): void {
    this.cameraTutorialLocked = locked;
  }

  // ============================================================
  // Tooltip
  // ============================================================

  private getTooltipScene(): TooltipScene | null {
    const sc = this.scene.get('TooltipScene') as TooltipScene | null;
    return sc && this.scene.isActive('TooltipScene') ? sc : null;
  }

  /**
   * Recompute the hover-tooltip key from the current pointer screen position
   * and dispatch to TooltipScene. Cheap to call every pointermove — the
   * scene does its own debouncing.
   */
  private refreshTooltip(screenX: number, screenY: number): void {
    // Rich cursor tooltip for bomb hovers (HUD loadout + loot slots), gated by
    // the 1s same-bomb hover delay. Suppress the bottom-right panel while a
    // bomb is hovered so its description isn't duplicated.
    const hover = this.bombHoverUnderCursor(screenX, screenY);
    if (hover) {
      this.getTooltipScene()?.setKey(null);
      if (this.bombTooltipHoverId !== hover.id) {
        // Moved onto a different bomb — restart the dwell timer and hide until
        // it elapses. (Motion within the same bomb keeps the same id, so the
        // timer is preserved.)
        this.bombTooltipHoverId = hover.id;
        this.bombTooltipShowAt = this.time.now + MatchScene.BOMB_TOOLTIP_HOVER_MS;
        this.bombTooltip?.hide();
      }
      if (this.time.now >= this.bombTooltipShowAt) {
        this.bombTooltip?.show(hover.info);
        this.bombTooltip?.move(screenX, screenY);
      }
      return;
    }

    // Not a bomb hover — drop the rich tooltip, reset dwell, fall back to the
    // bottom-right panel for tiles / HP / turns / targeting.
    this.bombTooltipHoverId = null;
    this.bombTooltip?.hide();
    this.getTooltipScene()?.setKey(this.computeTooltipKey(screenX, screenY));
  }

  /**
   * If the cursor is over a bomb in a HUD (loadout tray slot incl. the Rock, or
   * a loot-panel slot across any stacked source row), return a stable identity
   * for that bomb plus the tooltip content. Returns null otherwise — tiles and
   * non-bomb UI are deliberately excluded.
   *
   * The `id` distinguishes individual slots (`hud:2`, `loot:7`) so the hover
   * dwell timer restarts when the cursor crosses from one bomb to another.
   */
  private bombHoverUnderCursor(
    screenX: number,
    screenY: number,
  ): { id: string; info: BombTooltipInfo } | null {
    const me = this.myBomberman();

    // Loadout tray. Slot 0 is the always-available Rock.
    const hudSlot = this.hitTestHud(screenX, screenY);
    if (hudSlot >= 0) {
      if (hudSlot === 0) return { id: 'hud:0', info: bombTooltipInfoFor('rock') };
      const slot = me?.inventory.slots[hudSlot - 1];
      if (!slot) return null; // empty slot — no tooltip
      return { id: `hud:${hudSlot}`, info: bombTooltipInfoFor(slot.type) };
    }

    // Loot panel (chests + bodies under the player, each its own row). The flat
    // index is unique across all stacked rows.
    if (me) {
      const lootIdx = this.hitTestLootPanel(screenX, screenY);
      if (lootIdx >= 0) {
        const lootType = this.lootSlotBombType(me, lootIdx);
        if (lootType) return { id: `loot:${lootIdx}`, info: bombTooltipInfoFor(lootType) };
      }
    }

    return null;
  }

  /**
   * Inspect HUD rects and the hovered world tile and decide which tooltip
   * (if any) to show. Returns null when nothing meaningful is under the cursor.
   */
  private computeTooltipKey(screenX: number, screenY: number): TooltipKey | null {
    const me = this.myBomberman();
    const W = this.scale.width;

    // ---- HUD hit tests (top bar + bomb tray) ----
    if (screenY >= 0 && screenY <= 48) {
      // HP bar (top-left) — covers label + segmented bar.
      const hp = this.hpMetrics();
      const hpRight = hp.x + hp.labelW + hp.barW;
      if (screenX >= hp.x - 4 && screenX <= hpRight + 4) return { kind: 'hp' };
      // turn counter (centered around W/2)
      if (Math.abs(screenX - W / 2) <= 100) return { kind: 'turnLimit' };
      // phase indicator + timer (right of the turn counter)
      if (screenX >= W / 2 + 100 && screenX <= W / 2 + 320) return { kind: 'turnsTicks' };
      // treasure list + coin row (top-right column) — tooltip suppressed
      // while the treasure economy is hidden (the wallet renders nothing).
      if (!HIDDEN_FEATURES.treasures && screenX >= W - 130 && screenX <= W - 5) return { kind: 'treasureList' };
    }

    const hudSlot = this.hitTestHud(screenX, screenY);
    if (hudSlot >= 0) {
      if (hudSlot === 0) return { kind: 'bombSlot', bombType: 'rock' };
      const slot = me?.inventory.slots[hudSlot - 1];
      if (!slot) return null; // empty slot — no tooltip
      return { kind: 'bombSlot', bombType: slot.type };
    }

    // Loot panel item (when standing on a chest/body)
    const lootIdx = this.hitTestLootPanel(screenX, screenY);
    if (lootIdx >= 0 && me) {
      const lootType = this.lootSlotBombType(me, lootIdx);
      if (lootType) return { kind: 'lootBomb', bombType: lootType };
    }

    // ---- World tile ----
    if (!this.mapData || !this.state) return null;
    const ts = this.mapData.tileSize;
    const wp = this.cameras.main.getWorldPoint(screenX, screenY);
    const tx = Math.floor(wp.x / ts);
    const ty = Math.floor(wp.y / ts);
    if (tx < 0 || ty < 0 || tx >= this.mapData.width || ty >= this.mapData.height) return null;

    // If a bomb slot is armed (selectedSlot) and we're hovering a tile,
    // produce a contextual targeting tooltip rather than the world-tile one.
    if (this.selectedSlot !== null) {
      const bt: BombType = this.selectedSlot === 0
        ? 'rock'
        : (me?.inventory.slots[this.selectedSlot - 1]?.type ?? 'rock');
      switch (bt) {
        case 'ender_pearl': return { kind: 'targetTeleport' };
        case 'fart_escape': return { kind: 'targetSmoke' };
        case 'flare':       return { kind: 'targetFlare' };
        default:            return { kind: 'targetThrow', bombType: bt };
      }
    }

    // Fog: if the tile is entirely undiscovered, suggest exploring.
    const fog = this.fogRenderer;
    if (fog && !fog.isVisible(tx, ty) && !fog.isDiscovered(tx, ty)) {
      return { kind: 'tileFog' };
    }

    // Floor key — checked before fog gates so hovering over a key in LOS
    // (or one remembered from a prior visit) shows the right hint.
    if (this.keyMemory.get(`${tx},${ty}`) === true) {
      return { kind: 'tileKey' };
    }

    // Escape hatch — broken hatches use a separate key so the tooltip
    // reflects the "single-use" state with a darker icon and warning text.
    // We honor the per-client memory (escapeSprites[].memoryBroken) rather
    // than the authoritative state, so a player who never observed the
    // escape still sees the intact tooltip until they regain LOS.
    for (const e of this.mapData.escapeTiles) {
      if (e.x === tx && e.y === ty) {
        const spr = this.escapeSprites.find(s => s.x === tx && s.y === ty);
        const broken = !!spr?.memoryBroken;
        if (broken) return { kind: 'tileHatchBroken' };
        const me = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
        // Keys hidden → the hatch tooltip reports console progress instead.
        const held = HIDDEN_FEATURES.keys
          ? (me?.consolesUsed ?? []).length
          : (me?.keys ?? 0);
        const required = HIDDEN_FEATURES.keys
          ? Math.min(BALANCE.consoles.requiredToEscape, (me?.assignedConsoles ?? []).length)
          : BALANCE.keys.requiredPerHatch;
        return { kind: 'tileHatch', held, required };
      }
    }
    // Chest
    for (const c of this.state.chests) {
      if (c.x === tx && c.y === ty) return { kind: 'tileChest' };
    }
    // Body
    for (const b of this.state.bodies) {
      if (b.x === tx && b.y === ty) return { kind: 'tileBody' };
    }
    // Door
    for (const d of this.state.doors) {
      for (const t of d.tiles) {
        if (t.x === tx && t.y === ty) return { kind: 'tileDoor' };
      }
    }

    const tile = this.mapData.grid[ty]?.[tx];
    const walkable = tile === 0; // TileType.FLOOR
    if (!walkable) return { kind: 'tileObstacle' };

    // Decals: count which kinds of marks are on this floor tile.
    const key = `${tx},${ty}`;
    const hasBlood = this.bloodDecals.has(key);
    const hasExplosion = this.bombRenderer?.scorchKeys.has(key) ?? false;
    const hasPearl = this.bombRenderer?.pearlKeys.has(key) ?? false;
    const decalCount = (hasBlood ? 1 : 0) + (hasExplosion ? 1 : 0) + (hasPearl ? 1 : 0);
    if (decalCount >= 2) return { kind: 'tileWalkableMess' };
    if (hasPearl)        return { kind: 'tileWalkablePearl' };
    if (hasBlood)        return { kind: 'tileWalkableBlood' };
    if (hasExplosion)    return { kind: 'tileWalkableExplosion' };
    return { kind: 'tileWalkable' };
  }

  /**
   * Resolve a symbolic HighlightTarget into a screen-space rect. Called by
   * the overlay every frame while a highlight is active — keep the math
   * tight and don't allocate.
   *
   * Approximate rects for Phase 4 — exact positions are tuned in Phase 12
   * by reading the actual HUD widget bounds (hudObjects[]).
   */
  getHudRect(target: { kind: string; index?: number; bombType?: BombType }): { x: number; y: number; w: number; h: number; space: 'hud' } | null {
    const W = this.scale.width;
    const H = this.scale.height;
    switch (target.kind) {
      case 'phaseIndicator':
        return { x: W / 2 + 105, y: 10, w: 130, h: 32, space: 'hud' };
      case 'timer':
        // Match the recentred top-center match clock (timerText at W/2, y≈12).
        return { x: W / 2 - 45, y: 6, w: 90, h: 32, space: 'hud' };
      case 'hp': {
        // Match the HP bar widget exactly (label + bar), padded for clarity.
        const hp = this.hpMetrics();
        const x = hp.x - 6;
        const y = hp.y - 6;
        const w = hp.labelW + hp.barW + 12;
        const h = hp.barH + 12;
        return { x, y, w, h, space: 'hud' };
      }
      case 'treasureList': {
        const r = this.treasureList?.getRect();
        if (r && r.h > 0) return { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, space: 'hud' };
        // Empty list: highlight the anchor area so the tutorial dialogue
        // still has somewhere to point at on first encounter. Includes the
        // coin row that sits above the treasure list.
        return { x: W - 130, y: 8, w: 125, h: 60, space: 'hud' };
      }
      case 'bombTray': {
        // N slots + gaps, bottom-centered (sizes scale with hudScale on mobile).
        const totalW = this.localTotalSlotCount() * this.slotSize + (this.localTotalSlotCount() - 1) * this.slotGap;
        return { x: (W - totalW) / 2, y: H - this.slotSize - 16, w: totalW, h: this.slotSize, space: 'hud' };
      }
      case 'slot': {
        const i = target.index ?? 0;
        const totalW = this.localTotalSlotCount() * this.slotSize + (this.localTotalSlotCount() - 1) * this.slotGap;
        const trayX = (W - totalW) / 2;
        return {
          x: trayX + i * (this.slotSize + this.slotGap),
          y: H - this.slotSize - 16,
          w: this.slotSize,
          h: this.slotSize,
          space: 'hud',
        };
      }
      case 'lootPanel':
        // Approximate — real position is centered above the tray.
        return { x: (W - 320) / 2, y: H - this.slotSize - 140, w: 320, h: 110, space: 'hud' };
      case 'lootItem':
        return target.bombType ? this.getLootItemRect(target.bombType) : null;
      default:
        return null;
    }
  }

  /**
   * Rect of the specific loot-panel icon for the given bomb type, or null
   * if the loot panel isn't visible or the type isn't shown. Used by the
   * tutorial to highlight a single item (e.g. "click the Flare") instead
   * of the whole panel.
   */
  private getLootItemRect(bombType: BombType): { x: number; y: number; w: number; h: number; space: 'hud' } | null {
    if (!this.lootPanelVisible || !this.state) return null;
    const me = this.myBomberman();
    if (!me) return null;

    // Rebuild the same flattened order used by renderLootPanel so indices
    // line up with the visible icons.
    const lootSlots: Array<{ type: BombType }> = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        for (const b of c.bombs) {
          lootSlots.push({ type: b.type });
          if (lootSlots.length >= this.localCustomSlotCount()) break;
        }
      }
      if (lootSlots.length >= this.localCustomSlotCount()) break;
    }
    if (lootSlots.length < this.localCustomSlotCount()) {
      for (const b of this.state.bodies) {
        if (b.x === me.x && b.y === me.y) {
          for (const bb of b.bombs) {
            lootSlots.push({ type: bb.type });
            if (lootSlots.length >= this.localCustomSlotCount()) break;
          }
        }
        if (lootSlots.length >= this.localCustomSlotCount()) break;
      }
    }

    const idx = lootSlots.findIndex(s => s.type === bombType);
    if (idx < 0) return null;

    const W = this.scale.width;
    const hs = this.hudScale;
    const panelWidth = this.localTotalSlotCount() * this.slotSize + (this.localTotalSlotCount() - 1) * this.slotGap + Math.round(20 * hs);
    const panelX = (W - panelWidth) / 2;
    const slotStartX = panelX + Math.round(10 * hs);
    return {
      x: slotStartX + idx * (this.slotSize + this.slotGap),
      y: this.lootPanelY + Math.round(18 * hs),
      w: this.slotSize,
      h: Math.round(50 * hs),
      space: 'hud',
    };
  }

  /**
   * Constructs the TutorialMatchBackend. Kept as a method so `create()` stays
   * clean. Called only when `mode === 'tutorial'`.
   */
  private buildTutorialBackend(): MatchBackend {
    return new TutorialMatchBackend();
  }

  // --- HUD (rendered on a separate camera that never zooms/scrolls) ---

  private hudTrayX = 0;
  private hudTrayY = 0;
  private hudTrayBg: Phaser.GameObjects.Graphics | null = null;
  /** Slot count we last built the tray for. When the local Bomberman's
   *  `maxCustomSlots` arrives or changes (re-equip mid-scene, late state
   *  arrival), we rebuild the tray to match. */
  private lastBuiltSlotCount = -1;
  private hudObjects: Phaser.GameObjects.GameObject[] = [];

  /** Tag an object as HUD-only: visible on hudCamera, hidden from main cam. */
  private hud<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    if (this.hudCamera) {
      this.cameras.main.ignore(obj);
    }
    this.hudObjects.push(obj);
    return obj;
  }

  private buildHud(): void {
    const { width, height } = this.scale;
    const hs = this.hudScale;
    const f = (px: number): string => `${Math.max(9, Math.round(px * hs))}px`;
    const coinSize = this.coinIconSize;
    const keySize = this.keyIconSize;

    // Top bar — height scales with the HUD so it doesn't eat a short screen.
    const topBg = this.add.graphics().setDepth(1000);
    topBg.fillStyle(0x0a0a14, 0.85);
    topBg.fillRect(0, 0, width, Math.round(48 * hs));
    this.topBarBg = this.hud(topBg);

    // Top-left HP bar widget (replaces old phaseText + the right-side hpText).
    // Container is jittered on hurt; bar fill is redrawn per-frame to track
    // displayedHp. See HP_BAR_* constants on the class.
    this.buildHpBar();

    // Turn counter + phase label are intentionally hidden: we present the match
    // as a real-time clock instead of a turn count to shed the "turn-based"
    // feel. The objects are kept (created hidden) so the rest of the HUD code
    // can keep its references without null checks; nothing updates them anymore.
    this.turnText = this.hud(this.add.text(width / 2, Math.round(14 * hs), '', {
      fontSize: f(16), color: '#aaaaaa', fontFamily: 'monospace',
    }).setOrigin(0.5, 0).setDepth(1001).setVisible(false));

    this.phaseText = this.hud(this.add.text(width / 2 + 110, Math.round(14 * hs), '', {
      fontSize: f(14), color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0).setDepth(1001).setVisible(false));

    // Match clock — the only top-center readout now. Shows remaining match time
    // as M:SS (see formatMatchClock); freezes during tutorial pauses.
    this.timerText = this.hud(this.add.text(width / 2, Math.round(12 * hs), '0:00', {
      fontSize: f(18), color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(1001));

    // Broken-hatch warning, dropped just below the top bar (phase + timer
    // now occupy the space right of the turn counter). Visible only while
    // the local bomberman is standing on a broken or under-keyed hatch.
    this.brokenHatchText = this.hud(this.add.text(width / 2, Math.round(52 * hs), 'This Hatch is Broken, you won’t be able to Escape from it', {
      fontSize: f(11), color: '#ff4040', fontFamily: 'monospace',
    }).setOrigin(0.5, 0).setDepth(1001).setVisible(false));

    // UAV indicator — sits just below the match clock at the top-center.
    // Shows a seconds countdown to the next UAV; throbs when it's <=3 turns
    // away; hidden in tutorial matches.
    this.uavText = this.hud(this.add.text(width / 2, Math.round(34 * hs), '', {
      fontSize: f(13), color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(1001).setVisible(false));

    // (Old top-right "HP --" text moved to the new top-left HP bar widget.)

    // Coin row (NEW_META §2) — pinned at the top of the top-right column,
    // always visible regardless of amount. Drawn as a graphics circle to
    // mirror the tooltip 'coin' shape (no extra texture asset needed).
    // (COIN_ICON_SIZE / COIN_ROW_Y are module constants — see layoutResponsiveHud.)
    const coinIcon = this.add.graphics().setDepth(1001);
    {
      const r = coinSize / 2;
      const cx = -r;
      const cy = r;
      coinIcon.fillStyle(0xffd944, 1);
      coinIcon.fillCircle(cx, cy, r);
      coinIcon.fillStyle(0xc09020, 1);
      coinIcon.fillCircle(cx, cy, r * 0.7);
      coinIcon.fillStyle(0xffd944, 1);
      coinIcon.fillRect(cx - r * 0.1, cy - r * 0.45, r * 0.2, r * 0.9);
      coinIcon.setPosition(width - HUD_RIGHT_MARGIN, COIN_ROW_Y);
    }
    this.coinHudIcon = this.hud(coinIcon);
    this.coinHudText = this.hud(this.add.text(
      width - HUD_RIGHT_MARGIN - coinSize - 6,
      COIN_ROW_Y + coinSize / 2,
      'x0',
      {
        fontSize: f(16),
        color: '#ffd944',
        fontFamily: 'monospace',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: Math.max(2, Math.round(3 * hs)),
      },
    ).setOrigin(1, 0.5).setDepth(1001));

    // Treasure list — vertical, top-right, fills as the player picks up
    // treasures during the match. Anchored below the coin row.
    this.treasureList = new TreasureListWidget(this, {
      x: width - HUD_RIGHT_MARGIN,
      y: COIN_ROW_Y + coinSize + 6,
      anchor: 'top-right',
      iconScale: hs,
      fontSize: Math.max(9, Math.round(16 * hs)),
      depth: 1001,
      pulseOnCount: true,
    });

    // Escape-requirement counter — small icon + "N/3" text, sits just left of
    // the coin row + TreasureListWidget column. Its own column, per
    // docs/keys-system.md §9. Keys hidden (Console system live): the icon is
    // a 🖥 emoji and the count tracks consoles used instead of keys carried.
    const keyColX = Math.round(160 * hs);
    const keyTxtX = Math.round(146 * hs);
    this.keysHudIcon = this.hud(
      HIDDEN_FEATURES.keys
        ? this.add.text(width - keyColX, COIN_ROW_Y + keySize / 2, '🖥', {
            fontSize: `${Math.max(10, keySize)}px`,
          }).setOrigin(0.5, 0.5).setDepth(1001)
        : this.add.image(width - keyColX, COIN_ROW_Y + keySize / 2, 'key')
            .setOrigin(0.5, 0.5)
            .setDisplaySize(keySize, keySize)
            .setDepth(1001));
    const requirementCap = HIDDEN_FEATURES.keys
      ? BALANCE.consoles.requiredToEscape
      : BALANCE.keys.requiredPerHatch;
    this.keysHudText = this.hud(this.add.text(width - keyTxtX, COIN_ROW_Y + keySize / 2, `0/${requirementCap}`, {
      fontSize: f(14), color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: Math.max(2, Math.round(3 * hs)),
    }).setOrigin(0, 0.5).setDepth(1001));

    // Slot tray is built lazily — at this point the local Bomberman state
    // hasn't arrived yet so we don't know `maxCustomSlots`. `renderHud`
    // calls `rebuildSlotTrayIfNeeded()` once state is in.

    // Exit Tutorial button — only visible in tutorial mode. Matches the
    // monospace "[ < BACK ]" style used as the back button on other scenes.
    if (this.mode === 'tutorial') {
      const exitBtn = this.add.text(20, height - 30, '[ EXIT TUTORIAL ]', {
        fontSize: f(16), color: '#888888', fontFamily: 'monospace',
      }).setOrigin(0, 0.5).setDepth(1001).setInteractive({ useHandCursor: true });
      exitBtn.on('pointerover', () => exitBtn.setColor('#cccccc'));
      exitBtn.on('pointerout', () => exitBtn.setColor('#888888'));
      exitBtn.on('pointerdown', () => this.scene.start('MainMenuScene'));
      this.exitTutorialBtn = this.hud(exitBtn);
    }
  }

  /**
   * Reposition the viewport-anchored HUD after a resize (window drag, device
   * orientation, DPR change). All these elements are created in buildHud() at
   * the then-current size; this re-pins them to the new edges so nothing drifts
   * off-screen. The HP bar (top-left, fixed) and the bomb tray (rebuilt via
   * rebuildSlotTrayIfNeeded) are handled separately.
   */
  private layoutResponsiveHud(): void {
    const { width, height } = this.scale;
    const hs = this.hudScale;
    const coinSize = this.coinIconSize;
    const keySize = this.keyIconSize;

    // Top bar — redraw to the full new width (scaled height).
    if (this.topBarBg) {
      this.topBarBg.clear();
      this.topBarBg.fillStyle(0x0a0a14, 0.85);
      this.topBarBg.fillRect(0, 0, width, Math.round(48 * hs));
    }
    // Top-center readouts.
    this.timerText?.setPosition(width / 2, Math.round(12 * hs));
    this.turnText?.setPosition(width / 2, Math.round(14 * hs));
    this.phaseText?.setPosition(width / 2 + 110, Math.round(14 * hs));
    this.uavText?.setPosition(width / 2, Math.round(34 * hs));
    this.brokenHatchText?.setPosition(width / 2, Math.round(52 * hs));
    this.errorText?.setPosition(width / 2, height / 2);

    // Top-right column: coins, treasure list, keys.
    this.coinHudIcon?.setPosition(width - HUD_RIGHT_MARGIN, COIN_ROW_Y);
    this.coinHudText?.setPosition(width - HUD_RIGHT_MARGIN - coinSize - 6, COIN_ROW_Y + coinSize / 2);
    this.treasureList?.setX(width - HUD_RIGHT_MARGIN);
    this.keysHudIcon?.setPosition(width - Math.round(160 * hs), COIN_ROW_Y + keySize / 2);
    this.keysHudText?.setPosition(width - Math.round(146 * hs), COIN_ROW_Y + keySize / 2);

    // Bottom-left exit-tutorial button.
    this.exitTutorialBtn?.setPosition(20, height - 30);

    // Bomb tray is centered + bottom-anchored — force a rebuild so it re-centers.
    this.lastBuiltSlotCount = -1;
    this.rebuildSlotTrayIfNeeded();
    this.renderHud();

    // Mobile control buttons re-anchor to the new bottom-right corner.
    this.mobileControls?.layout();
  }

  /**
   * Screen-space Y just below the top-right HUD column (coins + treasure list).
   * The tutorial guide window docks here so it never overlaps the treasures.
   */
  getRightHudBottomY(): number {
    const coinBottom = COIN_ROW_Y + this.coinIconSize;
    let treasureBottom = coinBottom;
    if (this.treasureList) {
      const r = this.treasureList.getRect();
      treasureBottom = r.y + r.h;
    }
    return Math.max(coinBottom, treasureBottom);
  }

  /** Canvas resize → resize the HUD camera and re-pin all anchored HUD. */
  private onResize(gameSize: Phaser.Structs.Size): void {
    this.hudCamera?.setSize(gameSize.width, gameSize.height);
    this.layoutResponsiveHud();
  }

  // ============================================================
  // Mobile control bridge — methods called by MobileControls.
  // ============================================================

  /**
   * The bundle of scene operations MobileControls needs. Grouping them in one
   * object keeps the public surface small and the coupling explicit.
   */
  private buildMobileHooks(): MobileHooks {
    return {
      canAct: () => {
        const me = this.myBomberman();
        if (!me || !me.alive || me.escaped) return false;
        if ((me.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)) return false;
        return true;
      },
      playerTile: () => {
        const me = this.myBomberman();
        return me ? { x: me.x, y: me.y } : null;
      },
      tileSize: () => this.mapData?.tileSize ?? 32,
      mapSize: () => ({ w: this.mapData?.width ?? 0, h: this.mapData?.height ?? 0 }),
      computePath: (tx, ty) => {
        const me = this.myBomberman();
        if (!me || !this.mapData) return [];
        return findPath(me.x, me.y, tx, ty, this.mapData);
      },
      snapThrow: (tx, ty) => {
        const bt = this.mobileArmedBombType();
        return this.snapThrowTarget(tx, ty, bt);
      },
      worldCamera: () => this.cameras.main,
      tagWorldObject: (obj) => { this.hudCamera?.ignore(obj); },
      beginManualCamera: () => {
        if (!this.cameraManualOverride) this.cameras.main.removeBounds();
        this.cameraManualOverride = true;
      },
      tryHandleHudTap: (x, y) => this.mobileHandleHudTap(x, y),
      hitTraySlot: (x, y) => this.mobileHitTraySlot(x, y),
      armSlot: (i) => this.mobileArmSlot(i),
      isOverTray: (x, y) => this.mobileIsOverTray(x, y),
      haltStaged: () => {
        this.inputMode = { kind: 'idle' };
        this.flushStagedAction();
      },
      beginAttackAim: () => {
        this.selectedSlot = this.mobileArmedSlot;
        this.renderHud();
      },
      endAim: () => {
        this.selectedSlot = null;
        this.hoveredTileX = null;
        this.hoveredTileY = null;
        this.renderHud();
      },
      setAimTile: (tile) => {
        this.hoveredTileX = tile ? tile.x : null;
        this.hoveredTileY = tile ? tile.y : null;
      },
      commitMove: (path) => {
        if (path.length === 0) return;
        this.inputMode = { kind: 'pathing', path };
        const dest = path[path.length - 1];
        this.spawnClickFeedback('move', dest.x, dest.y);
        this.flushStagedAction();
        this.rebuildEntities();
      },
      commitAttack: (tile) => {
        this.inputMode = {
          kind: 'aim',
          slotIndex: this.mobileArmedSlot,
          targetX: tile.x,
          targetY: tile.y,
        };
        this.selectedSlot = null;
        this.hoveredTileX = null;
        this.hoveredTileY = null;
        this.spawnClickFeedback('attack', tile.x, tile.y);
        this.flushStagedAction();
        this.rebuildEntities();
        this.renderHud();
      },
    };
  }

  /** Bomb type for the currently armed mobile slot (Rock for slot 0). */
  private mobileArmedBombType(): BombType {
    const me = this.myBomberman();
    if (this.mobileArmedSlot === 0 || !me) return 'rock';
    return me.inventory.slots[this.mobileArmedSlot - 1]?.type ?? 'rock';
  }

  /** Mobile tap on the bomb tray / loot panel. Returns true if it hit one. */
  private mobileHandleHudTap(x: number, y: number): boolean {
    const lootIdx = this.hitTestLootPanel(x, y);
    if (lootIdx >= 0) { this.onLootSlotClicked(lootIdx); return true; }
    const slot = this.hitTestHud(x, y);
    if (slot >= 0) {
      // Loot swap: when a loot bomb is staged (no compatible slot to merge
      // into), tapping an inventory slot completes the swap — mirrors the PC
      // click-loot-then-click-slot flow. Otherwise the tap just arms the slot.
      if (this.lootPendingSwap && slot >= 1 && slot <= this.localCustomSlotCount()) {
        this.executeLootSwap(slot);
      } else {
        this.mobileArmSlot(slot);
      }
      return true;
    }
    return false;
  }

  /**
   * Mobile: tray slot at (x,y) if it can start a bomb drag, else -1.
   * Ineligible: a pending loot swap (slot taps must keep completing the
   * swap on press, untouched timing), or an empty custom slot. Slot 0
   * (Rock) is always draggable. The loot panel is a disjoint region and
   * never matches here, so its taps stay on the immediate path.
   */
  private mobileHitTraySlot(x: number, y: number): number {
    if (this.lootPendingSwap) return -1;
    const slot = this.hitTestHud(x, y);
    if (slot < 0) return -1;
    if (slot >= 1 && this.myBomberman()?.inventory.slots[slot - 1] == null) return -1;
    return slot;
  }

  /** Mobile: whether (x,y) falls anywhere on the tray band — slots AND the
   *  gaps between them (unlike hitTestHud, which rejects gaps). Keep the
   *  geometry in sync with hitTestHud / rebuildSlotTrayIfNeeded. */
  private mobileIsOverTray(x: number, y: number): boolean {
    if (y < this.hudTrayY || y > this.hudTrayY + this.slotSize) return false;
    const count = this.localTotalSlotCount();
    const totalW = count * this.slotSize + (count - 1) * this.slotGap;
    return x >= this.hudTrayX && x <= this.hudTrayX + totalW;
  }

  /** Mobile: select (not toggle) a tray slot as the armed bomb. No-op for an
   *  empty slot so exactly one valid slot stays armed at all times. */
  private mobileArmSlot(slotIndex: number): void {
    const me = this.myBomberman();
    if (!me) return;
    if (slotIndex !== 0 && me.inventory.slots[slotIndex - 1] == null) return;
    this.mobileArmedSlot = slotIndex;
    // If we're mid-aim, keep the live preview in sync with the new bomb.
    if (this.selectedSlot !== null) this.selectedSlot = slotIndex;
    this.renderHud();
  }

  /**
   * Build (or rebuild) the bomb slot tray to match the local Bomberman's
   * `maxCustomSlots`. Idempotent — only does work when the count changes.
   * The tray BG, stun overlay, melee icon, and all per-slot rects/icons/
   * labels are recreated together because they're all sized off the count.
   */
  private rebuildSlotTrayIfNeeded(): void {
    const count = this.localTotalSlotCount();
    if (count === this.lastBuiltSlotCount) return;

    // Tear down any prior tray bits.
    this.hudTrayBg?.destroy();
    this.hudTrayBg = null;
    this.stunHudOverlay?.destroy();
    this.stunHudOverlay = null;
    this.stunHudLabel?.destroy();
    this.stunHudLabel = null;
    this.meleeHudPopTween?.remove();
    this.meleeHudPopTween = null;
    this.meleeHudPulseTween?.remove();
    this.meleeHudPulseTween = null;
    this.meleeHudIcon?.destroy();
    this.meleeHudIcon = null;
    this.rushHudPopTween?.remove();
    this.rushHudPopTween = null;
    this.rushHudPulseTween?.remove();
    this.rushHudPulseTween = null;
    this.rushHudIcon?.destroy();
    this.rushHudIcon = null;
    this.buffOrder = [];
    for (const r of this.slotRects) r.destroy();
    for (const t of this.slotLabelTexts) t.destroy();
    for (const i of this.slotIcons) i.destroy();
    for (const t of this.slotCountTexts) t.destroy();
    for (const g of this.slotHighlights) g.destroy();
    this.slotRects = [];
    this.slotLabelTexts = [];
    this.slotIcons = [];
    this.slotCountTexts = [];
    this.slotHighlights = [];

    const { width, height } = this.scale;
    const s = this.slotSize;
    const gap = this.slotGap;
    const hs = this.hudScale;
    // Text floors at 9px so the half-scale mobile HUD stays legible.
    const f = (px: number): string => `${Math.max(9, Math.round(px * hs))}px`;
    const pad = Math.round(10 * hs);
    const trayWidth = count * s + (count - 1) * gap;
    const trayX = (width - trayWidth) / 2;
    const trayY = height - s - Math.round(16 * hs);
    this.hudTrayX = trayX;
    this.hudTrayY = trayY;

    const trayBg = this.add.graphics().setDepth(1000);
    trayBg.fillStyle(0x0a0a14, 0.85);
    trayBg.fillRoundedRect(trayX - pad, trayY - pad, trayWidth + pad * 2, s + pad * 2, 6);
    this.hudTrayBg = this.hud(trayBg);

    // Bomb-threat camera-edge warning — a thick stroked rectangle around
    // the entire viewport, hidden by default. updateBombThreatWarning()
    // (called from renderHud) toggles visibility + color based on whether
    // the local bomberman's tile is in any currently-fusing bomb's
    // predicted blast. Depth 1100 sits above the buff icons but below the
    // stun overlay's label so the stun banner remains legible.
    const threatEdge = this.add.graphics().setDepth(1100).setVisible(false);
    this.bombThreatEdge = this.hud(threatEdge);

    // Stun HUD overlay — drawn on top of the tray + all slots, hidden by
    // default. renderHud toggles visibility based on the local bomberman's
    // status effects. Depth > slot depths (1001–1003) so it fully obscures
    // interactive elements behind it.
    const stunOverlay = this.add.graphics().setDepth(1050).setVisible(false);
    stunOverlay.fillStyle(0x223355, 0.7);
    stunOverlay.fillRoundedRect(trayX - pad, trayY - pad, trayWidth + pad * 2, s + pad * 2, 6);
    stunOverlay.lineStyle(3, 0x88ccff, 0.9);
    stunOverlay.strokeRoundedRect(trayX - pad, trayY - pad, trayWidth + pad * 2, s + pad * 2, 6);
    this.stunHudOverlay = this.hud(stunOverlay);

    const stunLabel = this.add.text(
      trayX + trayWidth / 2, trayY + s / 2,
      'STUNNED',
      {
        fontSize: f(24), color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
        stroke: '#000022', strokeThickness: Math.max(2, Math.round(5 * hs)),
      },
    ).setOrigin(0.5).setDepth(1051).setVisible(false);
    this.stunHudLabel = this.hud(stunLabel);

    // Buffs/debuffs row — anchored to the LEFT of the loadout, growing
    // leftward. Both icons share size + vertical center so the row reads
    // as a single group. Layout is INSERTION-ORDER driven: the first buff
    // to become active sits closest to the tray (index 0 = rightmost);
    // each newer buff stacks one slot to its left. See `layoutBuffsRow`.
    // Icons here are created at the rightmost position; layoutBuffsRow
    // moves them into the correct slot when they become visible.
    this.buffsRightX = trayX - Math.round(18 * hs);
    this.buffsCenterY = trayY + s / 2;
    const BUFF_SIZE = this.buffIconBaseSize();
    const meleeIcon = this.add.image(this.buffsRightX, this.buffsCenterY, 'sword_icon')
      .setOrigin(0.5, 0.5)
      .setDepth(1002)
      .setVisible(false)
      .setDisplaySize(BUFF_SIZE, BUFF_SIZE);
    this.meleeHudIcon = this.hud(meleeIcon);
    const rushIcon = this.add.image(this.buffsRightX, this.buffsCenterY, 'rush_mode')
      .setOrigin(0.5, 0.5)
      .setDepth(1002)
      .setVisible(false)
      .setDisplaySize(BUFF_SIZE, BUFF_SIZE);
    this.rushHudIcon = this.hud(rushIcon);

    for (let i = 0; i < count; i++) {
      const sx = trayX + i * (s + gap);

      const rect = this.add.rectangle(sx, trayY, s, s, 0x1a1a2e, 1)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x444466)
        .setDepth(1001);
      this.slotRects.push(this.hud(rect));

      // Keyboard shortcut key badge — white bg, black text, bottom-left
      const label = this.add.text(sx + Math.round(4 * hs), trayY + s - Math.round(4 * hs), `${i + 1}`, {
        fontSize: f(12), color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#ffffff', padding: { x: Math.max(1, Math.round(3 * hs)), y: 1 },
      }).setOrigin(0, 1).setDepth(1003);
      this.slotLabelTexts.push(this.hud(label));

      // Bomb icon image centered in the slot
      const icon = this.add.image(sx + s / 2, trayY + s / 2, 'bomb_icons', 0)
        .setDisplaySize(s * 0.75, s * 0.75)
        .setDepth(1001)
        .setVisible(false);
      this.slotIcons.push(this.hud(icon));

      const countTxt = this.add.text(sx + s / 2, trayY + s - Math.round(4 * hs), '', {
        fontSize: f(14), color: '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 1).setDepth(1002);
      this.slotCountTexts.push(this.hud(countTxt));

      const highlight = this.add.graphics().setDepth(1003);
      this.slotHighlights.push(this.hud(highlight));
    }

    this.lastBuiltSlotCount = count;
  }

  /** Returns slot index [0..4] if (x,y) is on a bomb slot, -1 otherwise. */
  private hitTestHud(screenX: number, screenY: number): number {
    if (screenY < this.hudTrayY || screenY > this.hudTrayY + this.slotSize) return -1;
    const rel = screenX - this.hudTrayX;
    if (rel < 0) return -1;
    const stride = this.slotSize + this.slotGap;
    const idx = Math.floor(rel / stride);
    if (idx < 0 || idx >= this.localTotalSlotCount()) return -1;
    const offset = rel - idx * stride;
    if (offset > this.slotSize) return -1; // in the gap between slots
    return idx;
  }

  /**
   * Real-time ms remaining in the current turn: input-phase remainder plus the
   * full upcoming transition, or just the transition remainder, and 0 once the
   * match is over. Used to make the match clock and UAV countdown tick smoothly
   * across turn boundaries instead of jumping a whole turn at a time.
   */
  private currentTurnRemainingMs(): number {
    if (!this.state) return 0;
    const phaseLeft = Math.max(0, this.state.phaseEndsAt - Date.now());
    if (this.state.phase === 'input') {
      return phaseLeft + BALANCE.match.transitionPhaseSeconds * 1000;
    }
    if (this.state.phase === 'transition') return phaseLeft;
    return 0;
  }

  /**
   * Remaining match time as "M:SS". The match still runs on discrete turns; we
   * just convert turns-left into real time using the per-turn duration
   * (inputPhaseSeconds + transitionPhaseSeconds from balance.ts = one turn) so
   * the HUD reads like a clock instead of a turn counter. Purely presentational
   * — no game logic depends on this value, and balance.ts is untouched.
   */
  private formatMatchClock(): string {
    if (!this.state) return '0:00';
    const turnMs = (BALANCE.match.inputPhaseSeconds + BALANCE.match.transitionPhaseSeconds) * 1000;
    const fullTurnsLeft = Math.max(0, BALANCE.match.turnLimit - this.state.turnNumber);
    const totalMs = fullTurnsLeft * turnMs + this.currentTurnRemainingMs();
    const totalSec = Math.max(0, Math.ceil(totalMs / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private renderHud(): void {
    if (!this.state) return;
    const me = this.myBomberman();
    // Build (or rebuild) the slot tray now that we know the local Bomberman's
    // `maxCustomSlots`. Idempotent — only does work on count change.
    this.rebuildSlotTrayIfNeeded();

    // Turn counter + phase label are hidden (see buildHud) — the top-center
    // match clock in update() is the only time/progress readout now. The match
    // still runs on discrete turns under the hood; this is purely presentation.

    // Hatch warning text: broken (precedence) or needs-keys. Visible only
    // while the local player is alive, not escaped, and standing on a
    // hatch tile.
    const meForHatch = this.state.bombermen.find(b => b.playerId === this.myPlayerId);
    const aliveLocal = !!meForHatch && meForHatch.alive && !meForHatch.escaped;
    const onHatch = aliveLocal &&
      this.state.escapeTiles.some(t => t.x === meForHatch.x && t.y === meForHatch.y);
    const onBroken = onHatch &&
      this.state.brokenHatches.some(t => t.x === meForHatch.x && t.y === meForHatch.y);
    // Requirement readout: consoles used (keys hidden) or keys carried.
    // A consoles cap of 0 (map without consoles, e.g. tutorial) gates nothing
    // and hides the counter + badges entirely.
    const cap = HIDDEN_FEATURES.keys
      ? Math.min(BALANCE.consoles.requiredToEscape, (meForHatch?.assignedConsoles ?? []).length)
      : BALANCE.keys.requiredPerHatch;
    const heldKeys = HIDDEN_FEATURES.keys
      ? (meForHatch?.consolesUsed ?? []).length
      : (meForHatch?.keys ?? 0);
    const onShortHatch = onHatch && !onBroken && heldKeys < cap;

    if (this.brokenHatchText) {
      if (onBroken) {
        this.brokenHatchText.setText('This Hatch is Broken, you won’t be able to Escape from it');
        this.brokenHatchText.setVisible(true);
      } else if (onShortHatch) {
        this.brokenHatchText.setText(HIDDEN_FEATURES.keys
          ? `Consoles ${heldKeys}/${cap} — hack your highlighted consoles first`
          : `Keys ${heldKeys}/${cap} — loot chests for more`);
        this.brokenHatchText.setVisible(true);
      } else {
        this.brokenHatchText.setVisible(false);
      }
    }

    // Lock badges — show on hatches the local bomberman is on or
    // Chebyshev-adjacent to, when keys < cap and that hatch is not broken.
    for (const badge of this.lockBadges) {
      const broken = this.state.brokenHatches.some(t => t.x === badge.x && t.y === badge.y);
      const near = aliveLocal &&
        Math.max(Math.abs(meForHatch.x - badge.x), Math.abs(meForHatch.y - badge.y)) <= 1;
      const show = near && !broken && heldKeys < cap;
      badge.container.setVisible(show);
      if (show) badge.text.setText(`${heldKeys}/${cap}`);
    }

    // Keys counter: count text, color, and pulse. Three states:
    //   - on a short hatch  → red + pulse (you need keys NOW)
    //   - at cap            → green steady (you can escape)
    //   - otherwise         → default yellow
    if (this.keysHudText && this.keysHudIcon) {
      // Hide the counter entirely on maps without consoles (cap derives to 0
      // while keys are hidden — tutorial map).
      const counterVisible = !HIDDEN_FEATURES.keys || cap > 0;
      this.keysHudIcon.setVisible(counterVisible);
      this.keysHudText.setVisible(counterVisible);
      this.keysHudText.setText(`${heldKeys}/${cap}`);
      const atCap = cap > 0 && heldKeys >= cap;
      if (onShortHatch) {
        this.keysHudText.setColor('#ff5555');
        this.keysHudIcon.setTint(0xff8888);
        if (!this.keyHudPulseTween) {
          this.keyHudPulseTween = this.tweens.add({
            targets: [this.keysHudIcon, this.keysHudText],
            scale: 1.25,
            duration: 380,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          });
        }
      } else {
        if (this.keyHudPulseTween) {
          this.keyHudPulseTween.stop();
          this.keyHudPulseTween.remove();
          this.keyHudPulseTween = null;
          this.keysHudIcon.setScale(1);
          this.keysHudText.setScale(1);
        }
        if (atCap) {
          this.keysHudText.setColor('#44ff88');
          this.keysHudIcon.setTint(0x88ff88);
        } else {
          this.keysHudText.setColor('#ffd944');
          this.keysHudIcon.clearTint();
        }
      }
    }

    // UAV countdown + throb starting 3 turns out. Hidden in tutorial matches
    // and whenever no UAV is scheduled. Shown as a seconds countdown (turns
    // until fire × turn duration) rather than the raw turn number.
    const nextFire = this.state.uavNextFireTurn;
    if (this.state.isTutorial || nextFire === undefined) {
      this.uavText?.setVisible(false);
      this.stopUavPulse();
    } else {
      const turnsUntil = nextFire - this.state.turnNumber;
      const turnMs = (BALANCE.match.inputPhaseSeconds + BALANCE.match.transitionPhaseSeconds) * 1000;
      const uavMs = Math.max(0, turnsUntil - 1) * turnMs + this.currentTurnRemainingMs();
      this.uavText?.setText(`✈ UAV ${Math.max(0, Math.ceil(uavMs / 1000))}s`);
      this.uavText?.setVisible(true);
      if (turnsUntil <= 3 && turnsUntil > 0) this.startUavPulse();
      else this.stopUavPulse();
    }

    if (me && me.alive) {
      // Use the sprite system's *displayed* HP so the bar tracks the
      // delayed post-animation update instead of dropping instantly at the
      // start of the transition.
      const displayedHp = this.bombermanSpriteSystem?.getDisplayedHp(me.playerId) ?? me.hp;
      this.updateHpBar(displayedHp, BALANCE.match.bombermanMaxHp, /* dead */ false);
      this.treasureList.setBundle(me.treasures);
      if (this.coinHudText) this.coinHudText.setText(`x${me.coins ?? 0}`);
      this.renderBombSlots(me);
      this.renderLootPanel(me);
    } else {
      this.updateHpBar(0, BALANCE.match.bombermanMaxHp, /* dead */ true);
      this.hideLootPanel();
    }

    // Stun HUD lock: grayed overlay + STUNNED banner over the bomb tray
    // when the local bomberman has an active stunned status effect.
    const stunned = !!me && me.alive && (me.statusEffects ?? []).some(
      s => s.kind === 'stunned' && s.turnsRemaining > 0,
    );
    this.stunHudOverlay?.setVisible(stunned);
    this.stunHudLabel?.setVisible(stunned);

    // Buffs row sync — covers cases where badge state can't be driven by
    // the corresponding event handler: fresh page load while a buff is
    // already active, HUD tray rebuilt by slot-count change while a buff
    // is active, and player dying/escaping while a buff was up (badge
    // drops). Event-driven entry/exit animations still own the visible
    // transition; this just keeps the steady state honest.
    const meleeIcon = this.meleeHudIcon;
    if (meleeIcon) {
      const meleeTrap = !!me && me.alive && !me.escaped && !!me.meleeTrapMode;
      if (meleeTrap && !meleeIcon.visible && !this.meleeHudPopTween) {
        this.showMeleeHudIcon();
      } else if (!meleeTrap && meleeIcon.visible && !this.meleeHudPopTween) {
        meleeIcon.setVisible(false);
        this.meleeHudPulseTween?.remove();
        this.meleeHudPulseTween = null;
        this.removeBuff('melee');
        this.layoutBuffsRow();
      }
    }

    const rushIcon = this.rushHudIcon;
    if (rushIcon) {
      const inRush = !!me && me.alive && !me.escaped && (me.rushActive ?? false);
      if (inRush && !rushIcon.visible && !this.rushHudPopTween) {
        this.showRushHudBadge();
      } else if (!inRush && rushIcon.visible && !this.rushHudPopTween) {
        rushIcon.setVisible(false);
        this.rushHudPulseTween?.remove();
        this.rushHudPulseTween = null;
        this.removeBuff('rush');
        this.layoutBuffsRow();
      }
    }

    this.updateBombThreatWarning(me);
  }

  private startUavPulse(): void {
    if (this.uavPulseTween || !this.uavText) return;
    this.uavPulseTween = this.tweens.add({
      targets: this.uavText,
      scale: 1.2,
      duration: 350,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  /** Base display size shared by every icon in the HUD buffs row. */
  private buffIconBaseSize(): number {
    return this.slotSize * 0.6;
  }

  /** Map a buff ID to its icon GameObject. Central so the layout helper
   *  doesn't have to know about new buff types — just add a case here. */
  private buffIcon(id: string): Phaser.GameObjects.Image | null {
    if (id === 'melee') return this.meleeHudIcon;
    if (id === 'rush') return this.rushHudIcon;
    return null;
  }

  /** Snap every entry in `buffOrder` to its position based on insertion
   *  index. Index 0 = rightmost; each subsequent index moves one slot
   *  to the left. Icons mid-pop stay in their slot until removal so the
   *  exit animation doesn't get yanked sideways. */
  private layoutBuffsRow(): void {
    const base = this.buffIconBaseSize();
    const gap = 8;
    for (let i = 0; i < this.buffOrder.length; i++) {
      const icon = this.buffIcon(this.buffOrder[i]);
      if (!icon) continue;
      // Center x for origin (0.5, 0.5): right edge at buffsRightX, step
      // leftward by (BUFF_SIZE + gap) per index.
      const centerX = this.buffsRightX - base / 2 - i * (base + gap);
      icon.setPosition(centerX, this.buffsCenterY);
    }
  }

  /** Add a buff ID to the row if it isn't already in. */
  private insertBuffIfMissing(id: string): void {
    if (this.buffOrder.includes(id)) return;
    this.buffOrder.push(id);
  }

  /** Remove a buff ID from the row (called from pop-off onComplete). */
  private removeBuff(id: string): void {
    const i = this.buffOrder.indexOf(id);
    if (i >= 0) this.buffOrder.splice(i, 1);
  }

  /**
   * Start (or restart) a continuous yoyo-scale "thrum" on a HUD buff icon.
   * Matches the treasure-list pulse (amplitude 20%, ~700 ms cycle, eased)
   * so the whole top-of-tray row breathes at the same cadence.
   */
  private startBuffPulse(icon: Phaser.GameObjects.Image, baseSize: number): Phaser.Tweens.Tween {
    icon.setDisplaySize(baseSize, baseSize);
    return this.tweens.add({
      targets: icon,
      displayWidth: baseSize * 1.20,
      displayHeight: baseSize * 1.20,
      duration: 350,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  /**
   * Pop-off animation shared by the rush and melee HUD icons: scale up
   * (base → 0.95 × SLOT_SIZE) while fading alpha 1 → 0 over 400 ms.
   * Pulse tween (if any) is killed first to avoid display-size tween
   * conflicts. onComplete restores the icon's base size + alpha so the
   * next show is clean.
   */
  private popOffBuffIcon(
    icon: Phaser.GameObjects.Image,
    pulseTween: Phaser.Tweens.Tween | null,
    baseSize: number,
    onDone: () => void,
  ): Phaser.Tweens.Tween {
    pulseTween?.remove();
    const popSize = this.slotSize * 0.95;
    return this.tweens.add({
      targets: icon,
      displayWidth: popSize,
      displayHeight: popSize,
      alpha: 0,
      duration: 400,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        icon.setVisible(false);
        icon.setAlpha(1);
        icon.setDisplaySize(baseSize, baseSize);
        onDone();
      },
    });
  }

  /**
   * Snap the HUD rush badge to its visible-with-pulse state. Called by the
   * `rush_changed` event handler on entry and by renderHud()'s sync as a
   * fresh-load safety net. Adds 'rush' to the buffs row if missing so the
   * insertion-order layout treats it like a freshly activated buff.
   */
  private showRushHudBadge(): void {
    const icon = this.rushHudIcon;
    if (!icon) return;
    this.rushHudPopTween?.remove();
    this.rushHudPopTween = null;
    this.rushHudPulseTween?.remove();
    const base = this.buffIconBaseSize();
    icon.setVisible(true);
    icon.setAlpha(1);
    icon.setDisplaySize(base, base);
    this.insertBuffIfMissing('rush');
    this.layoutBuffsRow();
    this.rushHudPulseTween = this.startBuffPulse(icon, base);
  }

  /** Pop-off + cleanup for the rush HUD badge. Removes 'rush' from the
   *  buffs row only AFTER the pop completes so the slot it occupied
   *  doesn't reflow mid-animation. */
  private popOffRushHudBadge(): void {
    const icon = this.rushHudIcon;
    if (!icon || !icon.visible) return;
    this.rushHudPopTween?.remove();
    this.rushHudPopTween = this.popOffBuffIcon(
      icon,
      this.rushHudPulseTween,
      this.buffIconBaseSize(),
      () => {
        this.rushHudPopTween = null;
        this.rushHudPulseTween = null;
        this.removeBuff('rush');
        this.layoutBuffsRow();
      },
    );
  }

  /** Mirror of showRushHudBadge for the melee-trap sword icon. */
  private showMeleeHudIcon(): void {
    const icon = this.meleeHudIcon;
    if (!icon) return;
    this.meleeHudPopTween?.remove();
    this.meleeHudPopTween = null;
    this.meleeHudPulseTween?.remove();
    const base = this.buffIconBaseSize();
    icon.setVisible(true);
    icon.setAlpha(1);
    icon.setDisplaySize(base, base);
    this.insertBuffIfMissing('melee');
    this.layoutBuffsRow();
    this.meleeHudPulseTween = this.startBuffPulse(icon, base);
  }

  /**
   * Camera-edge bomb-threat warning. Scans every bomb currently in state
   * (regardless of fuse remaining) and predicts its blast tiles via the
   * shared `resolveBombTrigger`. If the local bomberman's tile sits in
   * any predicted damage/fire tile, draw a red outline along the inside
   * edge of the viewport. If only Flash (stun) tiles cover the bomberman,
   * draw blue. Both → red wins, since dying matters more than getting
   * stunned. None → hide.
   *
   * Re-run every renderHud pass; state diffs (bombs added/removed, the
   * bomberman moving) flip the visual on the same frame the state lands.
   * Doors and shield walls are read live so the prediction respects them
   * the same way the resolver will at trigger time.
   */
  private updateBombThreatWarning(me: BombermanState | null): void {
    const g = this.bombThreatEdge;
    if (!g) return;
    const state = this.state;
    if (!state || !this.mapData || !me || !me.alive || me.escaped) {
      g.setVisible(false);
      return;
    }
    const myKey = `${me.x},${me.y}`;
    let inDamage = false;
    let inStun = false;
    // Build closed-door and shield-wall sets once for the whole pass —
    // resolveBombTrigger needs them to clip its raycasts.
    const closedDoorTiles = new Set<string>();
    for (const d of state.doors ?? []) {
      if (d.opened) continue;
      for (const t of d.tiles) closedDoorTiles.add(`${t.x},${t.y}`);
    }
    const shieldWallTiles = new Set<string>();
    for (const w of state.shieldWalls ?? []) {
      for (const t of w.tiles) shieldWallTiles.add(`${t.x},${t.y}`);
    }
    for (const bomb of state.bombs) {
      const trig = resolveBombTrigger(
        bomb.type, bomb.x, bomb.y, this.mapData, closedDoorTiles, shieldWallTiles,
      );
      if (!inDamage) {
        for (const t of trig.damageTiles) {
          if (`${t.x},${t.y}` === myKey) { inDamage = true; break; }
        }
      }
      if (!inDamage) {
        for (const t of trig.fireTiles) {
          if (`${t.x},${t.y}` === myKey) { inDamage = true; break; }
        }
      }
      if (!inStun) {
        for (const t of trig.stunTiles) {
          if (`${t.x},${t.y}` === myKey) { inStun = true; break; }
        }
      }
      if (inDamage) break; // damage already wins, no point scanning more
    }
    // Phosphorus-pending fires spawn next turn on tiles around the impact
    // origin — also threatening even though no bomb entry covers them.
    if (!inDamage) {
      for (const p of state.phosphorusPending ?? []) {
        const dx = me.x - p.originX;
        const dy = me.y - p.originY;
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) { inDamage = true; break; }
      }
    }
    if (!inDamage && !inStun) {
      g.setVisible(false);
      return;
    }
    const color = inDamage ? 0xff3333 : 0x66aaff;
    const w = this.scale.width;
    const h = this.scale.height;
    const thickness = 6;
    g.clear();
    g.lineStyle(thickness, color, 0.95);
    // Stroke is centered on the path — offset by half-thickness so the
    // rect sits flush with the viewport edge.
    const half = thickness / 2;
    g.strokeRect(half, half, w - thickness, h - thickness);
    g.setVisible(true);
  }

  /** Mirror of popOffRushHudBadge for the melee-trap sword icon. */
  private popOffMeleeHudIcon(): void {
    const icon = this.meleeHudIcon;
    if (!icon || !icon.visible) return;
    this.meleeHudPopTween?.remove();
    this.meleeHudPopTween = this.popOffBuffIcon(
      icon,
      this.meleeHudPulseTween,
      this.buffIconBaseSize(),
      () => {
        this.meleeHudPopTween = null;
        this.meleeHudPulseTween = null;
        this.removeBuff('melee');
        this.layoutBuffsRow();
      },
    );
  }

  private stopUavPulse(): void {
    if (!this.uavPulseTween) return;
    this.uavPulseTween.stop();
    this.uavPulseTween.remove();
    this.uavPulseTween = null;
    this.uavText?.setScale(1);
  }

  private showUavBanner(): void {
    if (this.uavBannerText) { this.uavBannerText.destroy(); this.uavBannerText = null; }
    this.uavBannerTimer?.remove();
    const { width, height } = this.scale;
    this.uavBannerText = this.hud(this.add.text(width / 2, height / 2 - 60,
      'UAV is Revealing the whole area',
      {
        fontSize: '24px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
        stroke: '#000022', strokeThickness: 5,
      }).setOrigin(0.5).setDepth(10000));
    this.uavBannerTimer = this.time.delayedCall(3000, () => {
      this.uavBannerText?.destroy();
      this.uavBannerText = null;
    });
  }

  /**
   * Build the top-left HP bar widget: "HP:" label + dark background + a
   * Graphics that gets redrawn per segment in `updateHpBar`. The whole row
   * lives inside a Container so a hurt tween can jitter it cheaply.
   */
  /** HP bar geometry scaled by hudScale (half-size on mobile). Shared by
   *  buildHpBar / updateHpBar / getHudRect / hitTestHud so they stay in sync. */
  private hpMetrics(): { x: number; y: number; labelW: number; barW: number; barH: number } {
    const k = this.hudScale;
    return {
      x: Math.round(MatchScene.HP_BAR_X * k),
      y: Math.round(MatchScene.HP_BAR_Y * k),
      labelW: Math.round(MatchScene.HP_BAR_LABEL_W * k),
      barW: Math.round(MatchScene.HP_BAR_W * k),
      barH: 2 * Math.round(MatchScene.HP_BAR_H * k / 2), // keep even
    };
  }

  private buildHpBar(): void {
    const { x, y, labelW, barW, barH } = this.hpMetrics();

    const container = this.add.container(x, y).setDepth(1001);
    this.hud(container);

    this.hpBarLabel = this.add.text(0, barH / 2, 'HP:', {
      fontSize: `${Math.max(9, Math.round(16 * this.hudScale))}px`, color: '#ff8888', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    container.add(this.hpBarLabel);

    // Dark frame + fill graphics. Both live inside the container so the
    // hurt-jitter tween can offset them together.
    const bg = this.add.graphics();
    bg.fillStyle(0x111111, 0.85);
    bg.fillRoundedRect(labelW, 0, barW, barH, 3);
    bg.lineStyle(1, 0x444444, 1);
    bg.strokeRoundedRect(labelW, 0, barW, barH, 3);
    container.add(bg);

    this.hpBarFill = this.add.graphics();
    container.add(this.hpBarFill);

    this.hpBarContainer = container;
  }

  /**
   * Redraw the HP bar with `current` filled segments out of `max`. If
   * `current` dropped since the last call (and the bar isn't being torn
   * down by death), play the hurt jitter + fly-down on the lost segment.
   */
  private updateHpBar(current: number, max: number, dead: boolean): void {
    if (!this.hpBarFill || !this.hpBarLabel) return;
    const { labelW, barW, barH } = this.hpMetrics();
    const innerPad = 2;
    const segGap = 2;
    const innerW = barW - innerPad * 2;
    const innerH = barH - innerPad * 2;
    const segCount = Math.max(1, max);
    const segW = (innerW - segGap * (segCount - 1)) / segCount;

    const wasHp = this.hpBarLastHp;
    const wasMax = this.hpBarLastMax;
    const hpDropped = wasHp >= 0 && wasMax === max && current < wasHp && !dead;

    const g = this.hpBarFill;
    g.clear();
    for (let i = 0; i < segCount; i++) {
      const sx = labelW + innerPad + i * (segW + segGap);
      const sy = innerPad;
      const filled = i < current;
      g.fillStyle(filled ? 0xdd3333 : 0x2a1a1a, 1);
      g.fillRect(sx, sy, segW, innerH);
    }

    if (dead) {
      this.hpBarLabel.setText('HP: DEAD');
      this.hpBarLabel.setColor('#666666');
    } else {
      this.hpBarLabel.setText('HP:');
      this.hpBarLabel.setColor('#ff8888');
    }

    if (hpDropped) {
      // The lost segment is the one at index `current` (zero-based) — the
      // one that just turned from filled to empty.
      const lostIdx = current;
      const sx = labelW + innerPad + lostIdx * (segW + segGap);
      const sy = innerPad;
      this.playHpHurtAnim(sx, sy, segW, innerH);
    }

    this.hpBarLastHp = current;
    this.hpBarLastMax = max;
  }

  /**
   * Jitter the HP bar container and spawn a transient red rectangle at the
   * lost segment that falls straight down + fades, travelling at most 4×
   * its own height before disappearing.
   */
  private playHpHurtAnim(localSx: number, localSy: number, segW: number, segH: number): void {
    const container = this.hpBarContainer;
    if (!container) return;
    const baseX = container.x;
    const baseY = container.y;

    // Bar jitter — quick yoyo nudge in x. Container only, so the falling
    // segment ghost (added to the scene root) doesn't shake with it.
    this.tweens.killTweensOf(container);
    container.setPosition(baseX, baseY);
    this.tweens.add({
      targets: container,
      x: baseX + 4,
      duration: 50,
      yoyo: true,
      repeat: 3,
      ease: 'Sine.easeInOut',
      onComplete: () => container.setPosition(baseX, baseY),
    });

    // Falling segment ghost — drawn at the same screen coords as the lost
    // segment, falls straight down + fades. Max travel = 4× segment height.
    const ghost = this.add.graphics().setDepth(1002);
    this.hud(ghost);
    const worldSx = baseX + localSx;
    const worldSy = baseY + localSy;
    ghost.fillStyle(0xdd3333, 1);
    ghost.fillRect(worldSx, worldSy, segW, segH);
    this.tweens.add({
      targets: ghost,
      y: segH * 4,        // pixel offset, not absolute y
      alpha: 0,
      duration: 600,
      ease: 'Quad.easeIn',
      onComplete: () => ghost.destroy(),
    });
  }

  private renderBombSlots(me: BombermanState): void {
    // Slot layout: 0 = Rock (infinite), 1..maxCustomSlots = custom inventory[0..N-1]
    const stackLimit = this.localStackSize();
    for (let i = 0; i < this.localTotalSlotCount(); i++) {
      let sub = '';
      let bombType: import('@shared/types/bombs.ts').BombType | null = null;

      if (i === 0) {
        bombType = 'rock';
        sub = '∞';
      } else {
        const slot = me.inventory.slots[i - 1];
        if (slot) {
          bombType = slot.type;
          sub = `${slot.count}/${stackLimit}`;
        }
      }

      // Show bomb icon or hide if empty slot
      const icon = this.slotIcons[i];
      if (icon) {
        if (bombType) {
          icon.setFrame(bombIconFrame(bombType));
          icon.setVisible(true);
        } else {
          icon.setVisible(false);
        }
      }
      // Key badge always shows the number; dim it when slot is empty
      this.slotLabelTexts[i].setAlpha(bombType ? 1 : 0.3);
      this.slotCountTexts[i].setText(sub);

      // Highlight selected slot (armed for throwing, or staged throw in aim
      // mode). On mobile, the armed slot border is always shown — exactly one
      // bomb is selected at all times (Rock by default).
      const isSelected = this.selectedSlot === i
        || (this.inputMode.kind === 'aim' && this.inputMode.slotIndex === i)
        || (this.isMobile && this.mobileArmedSlot === i);
      const hl = this.slotHighlights[i];
      hl.clear();
      if (isSelected) {
        hl.lineStyle(3, 0xff4444, 1);
        hl.strokeRoundedRect(this.hudTrayX + i * (this.slotSize + this.slotGap), this.hudTrayY, this.slotSize, this.slotSize, 4);
      }
    }
  }

  /** Quick horizontal shake on the slot's "n/N" text — used as cap-reached
   *  feedback when the player tries to loot a same-type bomb. */
  private jiggleSlotCount(slotIndex: number): void {
    const t = this.slotCountTexts[slotIndex];
    if (!t) return;
    const baseX = (t as unknown as { __jiggleBaseX?: number }).__jiggleBaseX ?? t.x;
    (t as unknown as { __jiggleBaseX?: number }).__jiggleBaseX = baseX;
    this.tweens.killTweensOf(t);
    t.x = baseX;
    this.tweens.add({
      targets: t,
      x: { from: baseX - 3, to: baseX + 3 },
      duration: 50,
      yoyo: true,
      repeat: 3,
      onComplete: () => { t.x = baseX; },
    });
  }

  private onSlotClicked(slotIndex: number): void {
    // Staging is phase-independent; flushStagedAction() gates the send.
    if (!this.state) return;
    const me = this.myBomberman();
    if (!me || !me.alive || me.escaped) return;
    // Stun gate: server will reject any action from a stunned bomberman,
    // so just ignore clicks client-side for clean UX (no feedback needed).
    if ((me.statusEffects ?? []).some(s => s.kind === 'stunned' && s.turnsRemaining > 0)) return;

    // Loot swap shortcut: clicking an inventory slot while a loot swap is
    // pending triggers the swap instead of entering aim mode.
    if (this.lootPendingSwap && slotIndex >= 1 && slotIndex <= this.localCustomSlotCount()) {
      this.executeLootSwap(slotIndex);
      return;
    }

    // Slot 0 is Rock (always available), slots 1..maxCustomSlots map to inventory.slots[0..N-1]
    let hasBomb = false;
    if (slotIndex === 0) {
      hasBomb = true;
    } else {
      hasBomb = me.inventory.slots[slotIndex - 1] != null;
    }
    if (!hasBomb) return;

    // Backend gate: the tutorial director can block slot selection
    // persistently (setBlockSlotSelection) or wait for a specific slot
    // (selectBomb expectation). Live matches always return true.
    if (this.backend && !this.backend.onSlotSelected(slotIndex)) return;

    // Toggle the armed slot. Movement continues uninterrupted — the player
    // only commits to a throw when they click a target tile.
    if (this.selectedSlot === slotIndex) {
      this.selectedSlot = null;
    } else {
      this.selectedSlot = slotIndex;
    }

    this.lootPendingSwap = null;
    this.rebuildEntities();
    this.renderHud();
    // Slot toggle changes the contextual tooltip (e.g. "Throw at this tile" /
    // "Teleport to this tile"). Re-derive from the current pointer so the
    // tooltip updates immediately, even if the user used a 1-5 hotkey.
    const p = this.input.activePointer;
    this.refreshTooltip(p.x, p.y);
  }

  // --- Loot panel ---

  private lootPanelY = 0;

  private renderLootPanel(me: BombermanState): void {
    this.hideLootPanel();
    if (!this.state) return;

    // Find what's on the player's tile. Each source carries its own slot
    // count: chests are always 5 (`CHEST_LOOT_SLOT_COUNT`), bodies match the
    // deceased's `maxCustomSlots`. The looting UI renders one row per source
    // sized accordingly — the player's HUD slot tray remains the only thing
    // sized off the local Bomberman's stats.
    type LootSourceRow = {
      kind: 'chest' | 'body';
      id: string;
      bombs: Array<{ type: import('@shared/types/bombs.ts').BombType; count: number }>;
      label: string;
      slotCount: number;
      /** Bombs from bodies show `count/stackSize` to mirror the loadout HUD.
       *  Chests stay as a flat `xN` because their slot cap is implicit. */
      stackSize?: number;
    };

    const CHEST_LOOT_SLOT_COUNT = 5;
    const sources: LootSourceRow[] = [];
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        sources.push({
          kind: 'chest',
          id: c.id,
          bombs: c.bombs.map(b => ({ type: b.type, count: b.count })),
          label: `CHEST (TIER ${c.tier})`,
          slotCount: CHEST_LOOT_SLOT_COUNT,
        });
      }
    }
    for (const b of this.state.bodies) {
      if (b.x === me.x && b.y === me.y && b.bombs.length > 0) {
        sources.push({
          kind: 'body',
          id: b.id,
          bombs: b.bombs.map(bb => ({ type: bb.type, count: bb.count })),
          label: 'BODY LOOT',
          slotCount: b.maxCustomSlots,
          stackSize: b.stackSize,
        });
      }
    }

    if (sources.length === 0) {
      this.lootPanelVisible = false;
      this.lootPendingSwap = null;
      return;
    }
    this.lootPanelVisible = true;

    const { width } = this.scale;
    // Loot slots match the player's loadout tray size (half-scale on mobile).
    // All literals are scaled by hudScale so the loot tray reads as the same
    // size as the loadout — hitTestLootPanel + getLootItemRect mirror these.
    const hs = this.hudScale;
    const lootSlotSize = this.slotSize;
    const lootGap = this.slotGap;
    const slotH = Math.round(50 * hs);
    const labelH = Math.round(18 * hs);
    const rowGap = Math.round(8 * hs);
    const headerH = Math.round(26 * hs);
    const rowH = Math.round(70 * hs);
    const panelPad = Math.round(20 * hs);
    const iconPx = Math.round(28 * hs);
    const f = (px: number): string => `${Math.max(9, Math.round(px * hs))}px`;

    // Panel sized by the widest row. Each row's width = slotCount * slotSize
    // + (slotCount - 1) * gap + padding.
    let widestRow = 0;
    for (const src of sources) {
      const w = src.slotCount * lootSlotSize + Math.max(0, src.slotCount - 1) * lootGap + panelPad;
      if (w > widestRow) widestRow = w;
    }
    const panelWidth = widestRow;
    const panelHeight = headerH + sources.length * rowH + Math.max(0, sources.length - 1) * rowGap + Math.round(12 * hs);

    const panelX = (width - panelWidth) / 2;
    const panelY = this.hudTrayY - panelHeight - Math.round(10 * hs);
    this.lootPanelY = panelY;

    // Background
    const bg = this.hud(this.add.graphics().setDepth(1010));
    bg.fillStyle(0x112211, 0.92);
    bg.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 6);
    bg.lineStyle(2, 0x44ff88, 0.9);
    bg.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 6);
    this.lootPanelObjects.push(bg);

    // Render each source as its own slot row. Index `i` here is the row;
    // the absolute slot index across all rows is what the click handlers
    // use (reconstructed in the same order in `tryLootSlotAt`).
    let cursorY = panelY + Math.round(8 * hs);
    for (const src of sources) {
      const rowTitle = this.hud(this.add.text(panelX + Math.round(12 * hs), cursorY, src.label, {
        fontSize: f(11), color: src.kind === 'chest' ? '#44ff88' : '#ffaa66',
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0).setDepth(1011));
      this.lootPanelObjects.push(rowTitle);
      cursorY += labelH;

      const rowWidth = src.slotCount * lootSlotSize + Math.max(0, src.slotCount - 1) * lootGap;
      const slotStartX = panelX + (panelWidth - rowWidth) / 2;
      const slotY = cursorY;

      for (let i = 0; i < src.slotCount; i++) {
        const sx = slotStartX + i * (lootSlotSize + lootGap);
        const bomb = src.bombs[i];

        const rect = this.hud(this.add.rectangle(sx, slotY, lootSlotSize, slotH, 0x1a2a1e, 1)
          .setOrigin(0, 0)
          .setStrokeStyle(2, bomb ? (src.kind === 'chest' ? 0x44ff88 : 0xffaa66) : 0x333355)
          .setDepth(1011));
        this.lootPanelObjects.push(rect);

        if (!bomb) {
          const dash = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + slotH * 0.5, '—', {
            fontSize: f(12), color: '#444', fontFamily: 'monospace',
          }).setOrigin(0.5).setDepth(1012));
          this.lootPanelObjects.push(dash);
          continue;
        }

        const isPending = this.lootPendingSwap?.sourceId === src.id && this.lootPendingSwap?.bombType === bomb.type;

        const lootIcon = this.hud(this.add.image(
          sx + lootSlotSize / 2, slotY + slotH * 0.44, 'bomb_icons', bombIconFrame(bomb.type),
        ).setDisplaySize(iconPx, iconPx).setDepth(1012));
        this.lootPanelObjects.push(lootIcon);

        const countLabel = src.kind === 'body' && src.stackSize
          ? `${bomb.count}/${src.stackSize}`
          : `x${bomb.count}`;
        const countText = this.hud(this.add.text(sx + lootSlotSize / 2, slotY + slotH * 0.86, countLabel, {
          fontSize: f(12), color: isPending ? '#ffcc44' : '#ffd944', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5, 1).setDepth(1012));
        this.lootPanelObjects.push(countText);

        if (isPending) {
          const hlGfx = this.hud(this.add.graphics().setDepth(1013));
          hlGfx.lineStyle(3, 0xffcc44, 1);
          hlGfx.strokeRoundedRect(sx, slotY, lootSlotSize, slotH, 4);
          this.lootPanelObjects.push(hlGfx);
        }
      }

      cursorY += slotH + rowGap;
    }
  }

  private hideLootPanel(): void {
    for (const obj of this.lootPanelObjects) obj.destroy();
    this.lootPanelObjects = [];
    this.lootPanelVisible = false;
  }

  /**
   * Build the same per-source-row layout used by `renderLootPanel`. Returns
   * a flat array where each row's slots are appended in order: chests (5
   * slots each), then bodies (deceased.maxCustomSlots slots each). Empty
   * slots are represented as `null`. The flat index in this array maps 1:1
   * to the visual click target produced by `renderLootPanel`.
   */
  private lootRowsFlat(me: BombermanState): Array<{
    kind: 'chest' | 'body';
    sourceId: string;
    type: import('@shared/types/bombs.ts').BombType;
    count: number;
  } | null> {
    const CHEST_LOOT_SLOT_COUNT = 5;
    const flat: Array<{
      kind: 'chest' | 'body';
      sourceId: string;
      type: import('@shared/types/bombs.ts').BombType;
      count: number;
    } | null> = [];
    if (!this.state) return flat;
    for (const c of this.state.chests) {
      if (c.x !== me.x || c.y !== me.y || c.bombs.length === 0) continue;
      for (let i = 0; i < CHEST_LOOT_SLOT_COUNT; i++) {
        const b = c.bombs[i];
        flat.push(b ? { kind: 'chest', sourceId: c.id, type: b.type, count: b.count } : null);
      }
    }
    for (const body of this.state.bodies) {
      if (body.x !== me.x || body.y !== me.y || body.bombs.length === 0) continue;
      for (let i = 0; i < body.maxCustomSlots; i++) {
        const b = body.bombs[i];
        flat.push(b ? { kind: 'body', sourceId: body.id, type: b.type, count: b.count } : null);
      }
    }
    return flat;
  }

  /** Bomb type at a given loot panel index. */
  private lootSlotBombType(me: BombermanState, lootIndex: number): BombType | null {
    return this.lootRowsFlat(me)[lootIndex]?.type ?? null;
  }

  /** Hit-test the loot panel. Returns the flat loot slot index or -1. */
  private hitTestLootPanel(screenX: number, screenY: number): number {
    if (!this.lootPanelVisible || !this.state) return -1;
    const me = this.myBomberman();
    if (!me) return -1;

    // Reconstruct the same row layout `renderLootPanel` produced. Each row
    // is `headerH=18` of label + 50 of slot rect + spacing.
    type Row = {
      kind: 'chest' | 'body';
      slotCount: number;
      flatStart: number;
    };
    const CHEST_LOOT_SLOT_COUNT = 5;
    const rows: Row[] = [];
    let flatCursor = 0;
    for (const c of this.state.chests) {
      if (c.x === me.x && c.y === me.y && c.bombs.length > 0) {
        rows.push({ kind: 'chest', slotCount: CHEST_LOOT_SLOT_COUNT, flatStart: flatCursor });
        flatCursor += CHEST_LOOT_SLOT_COUNT;
      }
    }
    for (const body of this.state.bodies) {
      if (body.x === me.x && body.y === me.y && body.bombs.length > 0) {
        rows.push({ kind: 'body', slotCount: body.maxCustomSlots, flatStart: flatCursor });
        flatCursor += body.maxCustomSlots;
      }
    }
    if (rows.length === 0) return -1;

    // Mirror renderLootPanel's hudScale-scaled geometry exactly.
    const { width } = this.scale;
    const hs = this.hudScale;
    const lootSlotSize = this.slotSize;
    const lootGap = this.slotGap;
    const slotH = Math.round(50 * hs);
    const labelH = Math.round(18 * hs);
    const rowGap = Math.round(8 * hs);
    const panelPad = Math.round(20 * hs);

    let widestRow = 0;
    for (const r of rows) {
      const w = r.slotCount * lootSlotSize + Math.max(0, r.slotCount - 1) * lootGap + panelPad;
      if (w > widestRow) widestRow = w;
    }
    const panelWidth = widestRow;
    const panelX = (width - panelWidth) / 2;

    // Mirror render: each row is title (labelH) + slots (slotH) + rowGap.
    let cursorY = this.lootPanelY + Math.round(8 * hs);
    for (const row of rows) {
      cursorY += labelH; // label height
      const slotYTop = cursorY;
      const slotYBot = cursorY + slotH;
      if (screenY >= slotYTop && screenY <= slotYBot) {
        const rowWidth = row.slotCount * lootSlotSize + Math.max(0, row.slotCount - 1) * lootGap;
        const slotStartX = panelX + (panelWidth - rowWidth) / 2;
        const rel = screenX - slotStartX;
        if (rel < 0) return -1;
        const stride = lootSlotSize + lootGap;
        const idx = Math.floor(rel / stride);
        if (idx < 0 || idx >= row.slotCount) return -1;
        if (rel - idx * stride > lootSlotSize) return -1;
        return row.flatStart + idx;
      }
      cursorY += slotH + rowGap;
    }
    return -1;
  }

  private onLootSlotClicked(lootIndex: number): void {
    if (!this.state) return;
    const me = this.myBomberman();
    if (!me) return;

    // Use the same flat-row layout as the render path.
    const lootSlots = this.lootRowsFlat(me);

    const loot = lootSlots[lootIndex];
    if (!loot) return;

    // Try to find a compatible slot: empty, or same type with room
    const stackLimit = this.localStackSize();
    let targetSlot = -1;

    // First: matching slot with room
    for (let i = 0; i < this.localCustomSlotCount(); i++) {
      const slot = me.inventory.slots[i];
      if (slot && slot.type === loot.type && slot.count < stackLimit) {
        targetSlot = i + 1; // network convention: 1..maxCustomSlots
        break;
      }
    }
    // Cap-feedback: even if we proceed to use an empty slot, jiggle any
    // existing same-type slot that's at cap so the player learns where the
    // ceiling is.
    if (targetSlot === -1) {
      for (let i = 0; i < this.localCustomSlotCount(); i++) {
        const slot = me.inventory.slots[i];
        if (slot && slot.type === loot.type && slot.count >= stackLimit) {
          this.jiggleSlotCount(i + 1);
        }
      }
    }
    // Second: empty slot
    if (targetSlot === -1) {
      for (let i = 0; i < this.localCustomSlotCount(); i++) {
        if (!me.inventory.slots[i]) {
          targetSlot = i + 1;
          break;
        }
      }
    }

    if (targetSlot !== -1) {
      // Direct pickup — compatible slot found
      this.lootPendingSwap = null;
      this.backend?.sendLoot({
        sourceKind: loot.kind,
        sourceId: loot.sourceId,
        bombType: loot.type,
        targetSlotIndex: targetSlot,
      });
    } else {
      // No compatible slot — highlight this loot bomb. Next click on an
      // inventory slot (1..4) will swap.
      this.lootPendingSwap = {
        sourceKind: loot.kind,
        sourceId: loot.sourceId,
        bombType: loot.type,
        count: loot.count,
      };
      this.renderHud();
    }
  }

  private executeLootSwap(inventorySlotIndex: number): void {
    if (!this.lootPendingSwap) return;
    this.backend?.sendLoot({
      sourceKind: this.lootPendingSwap.sourceKind,
      sourceId: this.lootPendingSwap.sourceId,
      bombType: this.lootPendingSwap.bombType,
      targetSlotIndex: inventorySlotIndex,
    });
    this.lootPendingSwap = null;
    this.renderHud();
  }
}
