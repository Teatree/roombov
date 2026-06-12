/**
 * Bomberman types.
 *
 * A "Bomberman" is a purchased character skin + starting bomb inventory. In
 * shop listings it is a BombermanTemplate (the authored/generated data). Once
 * bought, the player owns an OwnedBomberman which they can equip.
 *
 * During a match the equipped Bomberman is projected into a BombermanState
 * (position, hp, live inventory) by the match room.
 */

import type { BombType, StatusEffect } from './bombs.ts';
import type { TreasureBundle } from '../config/treasures.ts';

/** Tier drives price range + starting bomb count + rarity of premium bombs. */
export type BombermanTier = 'free' | 'paid' | 'paid_expensive';

/**
 * Idle Action — what a Bomberman does when it stands still (submits `idle`)
 * for long enough. Defines the three purchasable Bomberman "classes":
 *  - `attack`  — Ambush Mode: crouch and melee any passing Bomberman (enters
 *                on the first idle turn). The original/default behavior.
 *  - `heal`    — after `BALANCE.idleActions.healIdleTurns` idle turns in place,
 *                recover HP (only when hurt and not standing on an escape hatch).
 *  - `disguise`— after `BALANCE.idleActions.disguiseIdleTurns` idle turns, turn
 *                into a random world object until the Bomberman moves or is hit.
 * Legacy Bombermen and all AI (bots/scavs) default to `attack`.
 */
export type IdleAction = 'attack' | 'heal' | 'disguise';

/** Human-facing class name for an Idle Action (UI badges + analytics):
 *  attack = "Ambusher", heal = "Healster", disguise = "Disguiser". */
export const IDLE_ACTION_LABEL: Record<IdleAction, string> = {
  attack: 'Ambusher',
  heal: 'Healster',
  disguise: 'Disguiser',
};

/**
 * Sprite-sheet variant a Bomberman is rendered with. Each character has its
 * own set of per-direction animation frames under
 * `public/sprites/char{N}_*.png`. Picked randomly per Bomberman at roll
 * time and preserved for the lifetime of the owned Bomberman — same as tint.
 */
export type CharacterVariant =
  | 'char1' | 'char2' | 'char3' | 'char4' | 'char5' | 'char6' | 'char7';

/** Rotatable variants — Bomberman shop + bot fallback roll from this set.
 *  `char5` is intentionally excluded; it's reserved for Scavenger NPCs. */
export const CHARACTER_VARIANTS: readonly CharacterVariant[] = [
  'char1', 'char2', 'char3', 'char4', 'char6', 'char7',
];

/** Visual assigned to every Scavenger NPC. Never enters shop rotation. */
export const SCAV_CHARACTER: CharacterVariant = 'char5';

/** Union of every variant the client must preload assets/animations for —
 *  rotation pool plus the scav-only variant. */
export const ALL_RENDERED_VARIANTS: readonly CharacterVariant[] = [
  ...CHARACTER_VARIANTS,
  SCAV_CHARACTER,
];

/**
 * Per-player Bomberman shop cycle. Lives on `PlayerProfile.bombermanShop`.
 * Wall-clock timestamps so the cycle ages while the player is offline; the
 * server-side service ticks state forward on read and regenerates the
 * cycle as soon as `endsAt` has passed.
 */
export interface BombermanShopCycle {
  cycleId: string;
  /** Unix ms when the cycle was generated. */
  startedAt: number;
  /** Unix ms when the cycle expires and the next batch rolls in. */
  endsAt: number;
  bombermen: BombermanTemplate[];
  /** Template ids the player has already bought during this cycle. The
   *  client filters these out so the bought card stays animated-out. */
  boughtTemplateIds: string[];
  /**
   * A bonus FREE Bomberman that is only offered (appended to the client-facing
   * `bombermen`) once every template in `bombermen` has been bought and the
   * cycle hasn't refreshed yet. Optional for back-compat with cycles persisted
   * before this field existed (they simply offer no bonus until they refresh).
   */
  freeBonus?: BombermanTemplate;
}

/** Cosmetic random palette generated per Bomberman in the shop cycle. */
export interface CosmeticColors {
  /** RGB hex numbers — Phaser uses 24-bit ints, not strings. */
  shirt: number;
  pants: number;
  hair: number;
}

/**
 * Bomb loadout inventory — N custom slots plus the fixed infinite Rock.
 *
 * The custom-slot count `N` is per-Bomberman now (see `maxCustomSlots` on
 * BombermanTemplate / OwnedBomberman / BombermanState), driven by tier:
 *   Free → 4, Paid → 5, Expensive → 6 custom slots.
 * Total visible loadout (with Rock) = N + 1 = 5 / 6 / 7.
 *
 * A slot is `null` when empty. Each slot carries a BombType + a count,
 * stacking up to the per-Bomberman `stackSize` (also tier-driven, rolled
 * within a range at shop time and locked at purchase).
 */
export interface BombSlot {
  type: BombType;
  count: number;
}

/**
 * Hard upper bound on custom slot count across all tiers — used in places
 * where a per-Bomberman count isn't available (loot panel cap-out logic,
 * defensive bounds checks, etc.). Bump this if a future tier ever exceeds 6.
 */
export const MAX_INVENTORY_SLOT_COUNT = 6;

export interface BombInventory {
  /** Custom slots (empty = null). Length equals the Bomberman's `maxCustomSlots`. */
  slots: (BombSlot | null)[];
}

export function emptyInventory(slotCount: number): BombInventory {
  return { slots: new Array(slotCount).fill(null) };
}

/**
 * A Bomberman as offered in the shop carousel. Not owned yet.
 * `price` is 0 for the free tier.
 */
export interface BombermanTemplate {
  /** Unique within the current shop cycle. */
  id: string;
  name: string;
  tier: BombermanTier;
  price: number;
  colors: CosmeticColors;
  /**
   * Single 24-bit RGB used by the in-match animated sprite via Sprite.setTint.
   * Generated as a vivid non-gray color so the character stands out on the
   * gray dungeon map. Shop cards still use `colors` for procedural drawing.
   */
  tint: number;
  /** Sprite-sheet variant — randomized from CHARACTER_VARIANTS at roll time. */
  character: CharacterVariant;
  /** How many custom inventory slots this Bomberman carries (excludes Rock).
   *  Tier-fixed: free=4, paid=5, paid_expensive=6. */
  maxCustomSlots: number;
  /** Per-slot stacking cap. Tier-rolled in `TIER_CONFIG[tier].stackSizeRange`. */
  stackSize: number;
  /** Idle Action "class" — assigned one-of-each across the cycle's offers. */
  idleAction: IdleAction;
  /** Starting bomb inventory generated at cycle time from tier weights. */
  inventory: BombInventory;
}

/** A Bomberman the player owns. Same shape as template + purchase metadata. */
export interface OwnedBomberman {
  id: string;
  name: string;
  tier: BombermanTier;
  colors: CosmeticColors;
  tint: number;
  /** Sprite-sheet variant inherited from the source template. Stable for the
   *  life of this owned Bomberman. */
  character: CharacterVariant;
  /** Slot count + stack size inherited from the source template. Stable for
   *  the life of this owned Bomberman (loadout shape never changes after
   *  purchase). */
  maxCustomSlots: number;
  stackSize: number;
  /** Idle Action "class" — inherited from the source template, stable for the
   *  life of this owned Bomberman. Optional for back-compat with profiles
   *  persisted before classes existed; PlayerStore backfills it to `attack`. */
  idleAction: IdleAction;
  /** Live inventory — mutated by the Bombs Shop equip flow. */
  inventory: BombInventory;
  /** Unix ms when the player bought this Bomberman. */
  purchasedAt: number;
  /**
   * The shop-template id this Bomberman was purchased from. Used to prevent
   * buying the same template twice within a single shop cycle.
   */
  sourceTemplateId: string;
  /** Banked Skill Points — earned in-match (chest opens, kills, survival),
   *  credited on escape, lost on death. Spent at the Upgrade popup. */
  sp: number;
  /** Total Skill Points this Bomberman has earned across all matches,
   *  including SP already spent on upgrades. Pure history counter — never
   *  decremented. Used for the lifetime-SP badge on the Results screen. */
  lifetimeSp: number;
  /** Number of upgrade tiers applied per track. Each tier adds +1 to the
   *  corresponding stat (max cap, stack size, hp). Cap'd by
   *  BALANCE.upgrades.<track>.maxTiers and the absolute stat ceilings. */
  upgrades: BombermanUpgradeState;
}

/** Tier-count per upgrade track. 0 = no upgrades purchased yet. */
export interface BombermanUpgradeState {
  cap: number;
  stack: number;
  hp: number;
}

/** Runtime Bomberman state inside an active match. */
export interface BombermanState {
  /** Socket / player id this Bomberman is controlled by. */
  playerId: string;
  /** True if this Bomberman is controlled by a bot (no real socket). Used to
   *  exclude bots from treasure collection — bots do not loot chests or bodies. */
  isBot: boolean;
  /** True if this Bomberman is a Scavenger NPC spawned mid-match. Implies
   *  `isBot: true`. Excluded from match-end "alive players" count so scavs
   *  don't keep a match running after all real players are dead/escaped.
   *  Defaults to false/undefined for normal bombermen. */
  isScav?: boolean;
  /** The OwnedBomberman id at the time of match start. */
  bombermanId: string;
  /** Display name copied from the OwnedBomberman at match start. Carried
   *  in-state so the Results screen still has it after death (the
   *  OwnedBomberman is stripped from the profile when its Bomberman dies). */
  name: string;
  colors: CosmeticColors;
  tint: number;
  /** Sprite-sheet variant copied from the equipped OwnedBomberman. */
  character: CharacterVariant;
  /** Idle Action "class" copied from the equipped OwnedBomberman. AI defaults
   *  to `attack`. Drives idle behavior (ambush / heal / disguise). */
  idleAction: IdleAction;
  /** Tile coordinates. */
  x: number;
  y: number;
  hp: number;
  /** Max HP captured at spawn (= starting HP after upgrades). Heal-on-idle
   *  caps healing at this value. */
  maxHp: number;
  alive: boolean;
  /** Treasures picked up during this match (dropped on death, kept on escape). */
  treasures: TreasureBundle;
  /** Coins picked up from chests during this match. Transferred to the body
   *  on death (auto-pickup on body-walk-over, no cap), banked into
   *  PlayerProfile.coins on escape. See docs/NEW_META.md §2. */
  coins: number;
  /** Number of escape-hatch keys currently held. Capped at
   *  BALANCE.keys.requiredPerHatch. Dropped to the body on death; consumed
   *  (set to 0) on escape. */
  keys: number;
  /** Bomberman stats — copied from the equipped OwnedBomberman at match start.
   *  In-match logic (loot panel, equip-to-slot, throws) reads from these. */
  maxCustomSlots: number;
  stackSize: number;
  /** Skill Points earned this match. Credited to the OwnedBomberman's
   *  persistent `sp` on escape; discarded on death. Bots and scavs use
   *  this too but their accumulated SP is never banked. */
  sp: number;
  /** Set true the first time this bomberman opens any chest (auto-loot of
   *  treasures/coins on walk-on). One-shot per chest per match — we credit
   *  perChestOpen SP only on the first opener. Stored on the chest, not here. */
  // (no field — see Chest.openedBy)
  /** Live bomb inventory (mutates as bombs are thrown / looted). */
  inventory: BombInventory;
  /** Turns remaining bleeding (0 = not bleeding). */
  bleedingTurns: number;
  /** True once the Bomberman has stepped onto an escape tile at turn transition. */
  escaped: boolean;
  /** Consecutive peaceful turns (no enemy nearby, no attacks). Resets on combat. */
  rushCooldown: number;
  /** True when Out of Combat Rush is active (2 tiles/turn movement). */
  rushActive: boolean;
  /**
   * Set for one turn when an Ender Pearl teleport lands this bomberman on a
   * new tile. Blocks the escape-tile check so teleporting onto an escape
   * hatch does NOT extract on the same turn — the player must still be on
   * the hatch at the start of the following turn to escape.
   */
  teleportedThisTurn: boolean;
  /**
   * Count of consecutive turns the bomberman has ended on an escape hatch
   * tile with `idle` as their chosen action (no move, no throw). Escape
   * fires when this reaches 1 — i.e. one full idle turn on the hatch.
   * Resets to 0 whenever the bomberman moves, throws, or steps off.
   */
  onHatchIdleTurns: number;
  /**
   * Console system (active while HIDDEN_FEATURES.keys hides the keys gate).
   * Indices into `map.consoleSpots` assigned to this bomberman at match
   * start — their personal trio of consoles to interact with before any
   * escape hatch accepts them. Empty on maps without consoles (requirement
   * derives to 0). Optional for back-compat; resolver backfills.
   */
  assignedConsoles?: number[];
  /** Indices of assigned consoles this bomberman has completed. */
  consolesUsed?: number[];
  /**
   * Consecutive damage-free idle turns spent engaged with the current
   * console (Chebyshev ≤ 1). Console completes at
   * BALANCE.consoles.interactIdleTurns. Resets on move/throw/damage/leave.
   */
  consoleIdleTurns?: number;
  /** Index of the console currently being interacted with, or null. */
  consoleEngagedId?: number | null;
  /** Active status effects (Stunned from Flash, etc.). Empty by default. */
  statusEffects: StatusEffect[];
  /**
   * Melee Trap Mode — when active, the bomberman crouches in place and
   * will counter-attack any bomberman who walks into Chebyshev-1 range.
   * Entered by skipping a turn (idle). Exited by moving or throwing.
   * Taking damage does NOT exit this mode.
   */
  meleeTrapMode: boolean;
  /**
   * Consecutive turns this bomberman has stood still (submitted `idle` with
   * unchanged position, not stunned/smoked). Shared progress counter for the
   * Heal and Disguise idle actions. Resets to 0 on move/throw/stun/smoke or on
   * taking any damage. Attack-class uses `meleeTrapMode` instead and ignores it.
   */
  idleStillTurns: number;
  /**
   * Index (0-5) into the `disguise_objects` sprite sheet while a Disguise-class
   * bomberman is disguised; `undefined` when not disguised. Set once the idle
   * threshold is reached; cleared when the bomberman moves, throws, or is hit.
   */
  disguiseFrame?: number;
  /**
   * Queued movement waypoints set by Fart Escape. If the player submits no
   * new move next turn, the server consumes one waypoint; if they submit a
   * new move target this is cleared. Optional/undefined when no queue.
   */
  queuedPath?: Array<{ x: number; y: number }>;
}
