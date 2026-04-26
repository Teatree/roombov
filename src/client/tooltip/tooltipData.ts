import type { BombType } from '@shared/types/bombs.ts';
import { BOMB_CATALOG } from '@shared/config/bombs.ts';

export type TooltipIcon =
  | { kind: 'bomb'; bombType: BombType }
  | { kind: 'shape'; shape: 'heart' | 'coin' | 'hourglass' | 'clock' | 'tile' | 'wall' | 'door' | 'chest' | 'body' | 'hatch' | 'flame' | 'blood' | 'pearl' | 'mess' | 'fog' | 'arrow' | 'pearl_icon' | 'flare_icon' };

export interface TooltipData {
  icon: TooltipIcon;
  /**
   * Lines of text. Each line is `{ text, bold? }` where bold renders
   * highlighted. Multiple bold spans per line via `parts`.
   */
  parts: Array<{ text: string; bold?: boolean }>;
}

export type TooltipKey =
  | { kind: 'turnsTicks' }
  | { kind: 'hp' }
  | { kind: 'turnLimit' }
  | { kind: 'treasureList' }
  | { kind: 'bombSlot'; bombType: BombType }
  | { kind: 'lootBomb'; bombType: BombType }
  | { kind: 'tileWalkable' }
  | { kind: 'tileWalkableExplosion' }
  | { kind: 'tileWalkablePearl' }
  | { kind: 'tileWalkableBlood' }
  | { kind: 'tileWalkableMess' }
  | { kind: 'tileObstacle' }
  | { kind: 'tileDoor' }
  | { kind: 'tileChest' }
  | { kind: 'tileBody' }
  | { kind: 'tileHatch' }
  | { kind: 'tileFog' }
  | { kind: 'targetThrow'; bombType: BombType }
  | { kind: 'targetTeleport' }
  | { kind: 'targetSmoke' }
  | { kind: 'targetFlare' };

export function tooltipDataFor(key: TooltipKey): TooltipData {
  switch (key.kind) {
    case 'turnsTicks':
      return {
        icon: { kind: 'shape', shape: 'hourglass' },
        parts: [
          { text: 'Turn Counter. ' },
          { text: 'Set up', bold: true },
          { text: ' to plan, ' },
          { text: 'Resolution', bold: true },
          { text: ' acts it out.' },
        ],
      };
    case 'hp':
      return {
        icon: { kind: 'shape', shape: 'heart' },
        parts: [{ text: 'Your ' }, { text: 'HP', bold: true }, { text: '.' }],
      };
    case 'turnLimit':
      return {
        icon: { kind: 'shape', shape: 'clock' },
        parts: [
          { text: 'Turn limit. ' },
          { text: 'Escape', bold: true },
          { text: ' before it runs out or you ' },
          { text: 'die', bold: true },
          { text: '.' },
        ],
      };
    case 'treasureList':
      return {
        icon: { kind: 'shape', shape: 'coin' },
        parts: [
          { text: 'Treasures ' },
          { text: 'looted', bold: true },
          { text: ' this match. Cash them in at ' },
          { text: 'Gambler Street', bold: true },
          { text: '.' },
        ],
      };
    case 'bombSlot':
    case 'lootBomb': {
      const def = BOMB_CATALOG[key.bombType];
      return {
        icon: { kind: 'bomb', bombType: key.bombType },
        parts: [
          { text: def.name, bold: true },
          { text: ' — ' + def.description },
        ],
      };
    }
    case 'tileWalkable':
      return {
        icon: { kind: 'shape', shape: 'tile' },
        parts: [{ text: 'A ' }, { text: 'walkable', bold: true }, { text: ' tile.' }],
      };
    case 'tileWalkableExplosion':
      return {
        icon: { kind: 'shape', shape: 'flame' },
        parts: [
          { text: 'A walkable tile, looks like there was a ' },
          { text: 'fight', bold: true },
          { text: '.' },
        ],
      };
    case 'tileWalkablePearl':
      return {
        icon: { kind: 'shape', shape: 'pearl' },
        parts: [
          { text: 'A walkable tile, looks like someone ' },
          { text: 'escaped', bold: true },
          { text: ' using the ' },
          { text: 'Ender Pearl', bold: true },
          { text: '.' },
        ],
      };
    case 'tileWalkableBlood':
      return {
        icon: { kind: 'shape', shape: 'blood' },
        parts: [
          { text: 'A walkable tile, looks like someone was ' },
          { text: 'hurt', bold: true },
          { text: '.' },
        ],
      };
    case 'tileWalkableMess':
      return {
        icon: { kind: 'shape', shape: 'mess' },
        parts: [
          { text: 'A walkable tile, what a ' },
          { text: 'mess', bold: true },
          { text: '.' },
        ],
      };
    case 'tileObstacle':
      return {
        icon: { kind: 'shape', shape: 'wall' },
        parts: [{ text: 'Can\'t walk there.' }],
      };
    case 'tileDoor':
      return {
        icon: { kind: 'shape', shape: 'door' },
        parts: [{ text: 'Walk up to it to ' }, { text: 'open', bold: true }, { text: '.' }],
      };
    case 'tileChest':
      return {
        icon: { kind: 'shape', shape: 'chest' },
        parts: [
          { text: 'Stand on it to ' },
          { text: 'open', bold: true },
          { text: ' and ' },
          { text: 'loot', bold: true },
          { text: '.' },
        ],
      };
    case 'tileBody':
      return {
        icon: { kind: 'shape', shape: 'body' },
        parts: [{ text: 'Stand on it to ' }, { text: 'loot', bold: true }, { text: '.' }],
      };
    case 'tileHatch':
      return {
        icon: { kind: 'shape', shape: 'hatch' },
        parts: [{ text: 'Stand on it to ' }, { text: 'Escape', bold: true }, { text: '.' }],
      };
    case 'tileFog':
      return {
        icon: { kind: 'shape', shape: 'fog' },
        parts: [{ text: 'Explore', bold: true }, { text: ' this area.' }],
      };
    case 'targetThrow': {
      const def = BOMB_CATALOG[key.bombType];
      return {
        icon: { kind: 'bomb', bombType: key.bombType },
        parts: [
          { text: 'Throw ' },
          { text: def.name, bold: true },
          { text: ' at this tile.' },
        ],
      };
    }
    case 'targetTeleport':
      return {
        icon: { kind: 'bomb', bombType: 'ender_pearl' },
        parts: [{ text: 'Teleport', bold: true }, { text: ' to this tile.' }],
      };
    case 'targetSmoke':
      return {
        icon: { kind: 'bomb', bombType: 'fart_escape' },
        parts: [{ text: 'Escape', bold: true }, { text: ' in this direction.' }],
      };
    case 'targetFlare':
      return {
        icon: { kind: 'bomb', bombType: 'flare' },
        parts: [{ text: 'Light up', bold: true }, { text: ' this area.' }],
      };
  }
}

/** Stable equality for tooltip keys — used to avoid re-firing the 300ms delay. */
export function tooltipKeyEquals(a: TooltipKey | null, b: TooltipKey | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  // bombType comparison for the bomb-bearing variants
  const ab = (a as { bombType?: BombType }).bombType;
  const bb = (b as { bombType?: BombType }).bombType;
  return ab === bb;
}
