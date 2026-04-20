import type { TutorialStep } from './types.ts';

/**
 * The editable tutorial script. Each entry is one step; the director walks
 * them top-to-bottom. Edit freely — any balance / gameplay changes will be
 * picked up automatically by MatchScene since the tutorial runs the real
 * match loop.
 *
 * Phase 4 scope: Prologue + Beat 0 (HUD Primer) + one closing pause.
 * Subsequent beats are added phase by phase.
 */
export const TUTORIAL_SCRIPT: TutorialStep[] = [
  // Start in the muted state so stray self-clicks don't accidentally idle.
  { kind: 'setIdleMuted', muted: true },

  // --- Prologue -----------------------------------------------------------
  { kind: 'panCamera', focus: 'player', durationMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'Welcome to the dungeon.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Every click is a turn. Everyone moves at once.' },
  { kind: 'dialogue', portrait: 'char4', text: "Let's learn the basics." },
  { kind: 'pause', text: 'Click to Continue.' },

  // --- Beat 0: HUD Primer -------------------------------------------------
  { kind: 'highlight', target: { kind: 'phaseIndicator' } },
  { kind: 'dialogue', portrait: 'char4', text: 'This tells you what phase we are in — Action or Resolve.' },
  { kind: 'highlight', target: { kind: 'timer' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Your turn timer. Make a decision before it locks.' },
  { kind: 'highlight', target: { kind: 'hp' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Your HP. Two pips. Do not lose them.' },
  { kind: 'highlight', target: { kind: 'coinCounter' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Coins. You keep these after extraction.' },
  { kind: 'highlight', target: { kind: 'bombTray' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Four bomb slots. Loot to fill them.' },
  { kind: 'clearHighlight' },
  { kind: 'pause', text: "That's the HUD. Let's move." },

  // --- Beat 1: Movement ---------------------------------------------------
  // Player spawn is (6, 9). First step: walk east to (7, 9).
  { kind: 'highlight', target: { kind: 'tile', x: 7, y: 9 } },
  { kind: 'dialogue', portrait: 'char4', text: 'Click the highlighted tile to walk one step.' },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 7, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Movement: done.' },
  { kind: 'pause', text: 'Now let us try throwing.' },

  // --- Beat 2: Practice Throw (Rock slot) --------------------------------
  // Player is at (7, 9). Rock slot (0) is always filled. Throw at (8, 9).
  { kind: 'panCamera', focus: { x: 9, y: 9 }, durationMs: 500 },
  { kind: 'dialogue', portrait: 'char4', text: 'Your Rock slot is always available. Try it.' },
  { kind: 'highlight', target: { kind: 'slot', index: 0 } },
  { kind: 'dialogue', portrait: 'char4', text: 'Click the Rock slot, then the highlighted tile.' },
  { kind: 'highlight', target: { kind: 'tile', x: 8, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 8, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: "That's the arc. You commit the slot when you click the tile." },
  { kind: 'pause', text: 'Now let us find real bombs.' },

  // --- Beat 3: Chest Loot ------------------------------------------------
  // Chest2Zone in the tutorial map is near (10, 9). Hardcoded contents per
  // the GDD: 25 coins, 1 Flare, 1 Bomb.
  {
    kind: 'spawnChest',
    chestId: 'tut_chest',
    tier: 2,
    x: 10,
    y: 9,
    coins: 25,
    bombs: [
      { type: 'flare', count: 1 },
      { type: 'bomb', count: 1 },
    ],
  },
  { kind: 'panCamera', focus: { x: 10, y: 9 }, durationMs: 500 },
  { kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
  { kind: 'dialogue', portrait: 'char4', text: 'Chest. Coins auto-pick. Bombs via the loot panel.' },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 8, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 9, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 10, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'highlight', target: { kind: 'lootPanel' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Click the Flare to grab it.' },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'chest', bombType: 'flare' } },
  { kind: 'dialogue', portrait: 'char4', text: 'And the Bomb too.' },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'chest', bombType: 'bomb' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Two slots filled. Time to use them.' },
  { kind: 'pause', text: 'There is an enemy ahead.' },

  // --- Beat 4: Flare + Bomb kill (Bot1 at (17, 10)) ----------------------
  {
    kind: 'spawnBot',
    botId: 'B1',
    x: 17,
    y: 10,
    character: 'char1',
    tint: 0x886644,
    hp: 1,
  },
  { kind: 'panCamera', focus: { x: 14, y: 10 }, durationMs: 600 },
  { kind: 'dialogue', portrait: 'char4', text: 'An enemy. Let us light them up first — Flare reveals tiles.' },
  { kind: 'highlight', target: { kind: 'slot', index: 1 } },
  { kind: 'dialogue', portrait: 'char4', text: "Click the Flare slot, then the enemy's tile." },
  { kind: 'setBotAction', botId: 'B1', action: { kind: 'idle' } },
  {
    kind: 'waitForAction',
    expected: { kind: 'throwAt', slotIndex: 1, x: 17, y: 10, bombType: 'flare' },
  },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Lit. Now finish them.' },
  { kind: 'highlight', target: { kind: 'slot', index: 2 } },
  { kind: 'setBotAction', botId: 'B1', action: { kind: 'idle' } },
  {
    kind: 'waitForAction',
    expected: { kind: 'throwAt', slotIndex: 2, x: 17, y: 10, bombType: 'bomb' },
  },
  { kind: 'clearHighlight' },
  { kind: 'promptIdle', text: 'Bomb fuse is one turn. Click to wait.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Down.' },
  { kind: 'pause', text: 'They throw back, though. Let us dodge.' },

  // --- Beat 5: Dodging (Bot2 throws at player) ---------------------------
  // Spawn B2 close enough to throw. Player teleports near for reliable arc.
  {
    kind: 'spawnBot',
    botId: 'B2',
    x: 23,
    y: 10,
    character: 'char2',
    tint: 0x4488cc,
    hp: 2,
    inventory: [{ slot: 0, type: 'bomb', count: 1 }],
  },
  { kind: 'teleportPlayer', x: 20, y: 10 },
  { kind: 'panCamera', focus: { x: 21, y: 10 }, durationMs: 700 },
  { kind: 'dialogue', portrait: 'char4', text: 'They are aimed at you.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Movement resolves before explosions. Step off the target.' },
  { kind: 'highlight', target: { kind: 'tile', x: 21, y: 9 } },
  // B2 throws its Bomb (slot 1) at the player's current tile (20, 10).
  {
    kind: 'setBotAction',
    botId: 'B2',
    action: { kind: 'throw', slotIndex: 1, x: 20, y: 10 },
  },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 21, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'promptIdle', text: 'Bomb placed. Click to wait one turn.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Safe.' },
  { kind: 'pause', text: 'Some close the distance. Trap them.' },

  // --- Beat 6: Melee Trap ------------------------------------------------
  // Phase A — Player walks to the crouch tile (18, 9). B2 stays dormant.
  // Reset B2: HP 1 for drama, relocate to path-origin (22, 10) so the walk
  // is short and snappy. Keep script self-clicks muted until the crouch is
  // explicitly taught below.
  {
    kind: 'mutateState',
    mutate: (s) => {
      const b2 = s.bombermen.find((b) => b.playerId === 'B2');
      if (!b2) return;
      b2.hp = 1;
      b2.x = 22;
      b2.y = 10;
      b2.coins = 15; // becomes body2.coins after counter-kill
      // Reset inventory — B2 used its bomb in Beat 5. For body-loot drama,
      // put a fresh Bomb back so Beat 7 has something to pick up.
      b2.inventory.slots[0] = { type: 'bomb', count: 1 };
    },
  },
  { kind: 'panCamera', focus: { x: 18, y: 10 }, durationMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'Corners are defensive. Walk to the highlighted tile.' },
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 9 } },
  // Path from (21, 9) → (18, 9) = 3 steps west.
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 20, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 19, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 18, y: 9 } },
  { kind: 'clearHighlight' },

  // --- Unmute self-click-idle and teach the crouch ---
  { kind: 'setIdleMuted', muted: false },
  { kind: 'dialogue', portrait: 'char4', text: 'You can wait by clicking your own tile.' },
  { kind: 'dialogue', portrait: 'char4', text: 'That puts you in Melee Trap Mode — crouched, counter ready.' },
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Crouched. Stay still — they are coming.' },

  // Phase B — B2 walks (22, 10) → (18, 10) tile by tile. Each turn the
  // player self-idles to stay crouched; B2's step-in to (18, 10) is
  // Chebyshev-1 from (18, 9) → counter fires.
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 21, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'dialogue', portrait: 'char4', text: 'They are closer.' },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 20, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 19, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'dialogue', portrait: 'char4', text: 'One more step.' },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 18, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },

  { kind: 'dialogue', portrait: 'char4', text: 'Counter kill.' },
  { kind: 'pause', text: 'They dropped something. Scavenge it.' },

  // --- Beat 7: Body loot -------------------------------------------------
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 10 } },
  { kind: 'dialogue', portrait: 'char4', text: 'Walk onto the body. Coins auto-transfer.' },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 18, y: 10 } },
  { kind: 'clearHighlight' },
  { kind: 'highlight', target: { kind: 'lootPanel' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Grab their bomb.' },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'body', bombType: 'bomb' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Scavenging keeps you alive.' },
  { kind: 'pause', text: 'Last lesson: extraction.' },

  // --- Beat 8: Escape ----------------------------------------------------
  { kind: 'panCamera', focus: { x: 26, y: 7 }, durationMs: 900 },
  { kind: 'dialogue', portrait: 'char4', text: 'That is the hatch. Walk onto it, then wait one turn.' },
  { kind: 'highlight', target: { kind: 'tile', x: 26, y: 7 } },
  // Hop closer for pacing — the run from (18, 10) to (26, 7) is 11 tiles.
  { kind: 'teleportPlayer', x: 25, y: 8 },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 26, y: 8 } },
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 26, y: 7 } },
  { kind: 'dialogue', portrait: 'char4', text: 'On the hatch. Now wait one turn.' },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Extracted. You keep everything you carried.' },

  // --- Epilogue ----------------------------------------------------------
  { kind: 'dialogue', portrait: 'char4', text: 'You have learned: move, loot, throw, dodge, trap, scavenge, escape.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Real matches add three more players and fog of war. Same rules.' },
  { kind: 'pause', text: 'Tutorial complete. Click to return to the menu.' },
  { kind: 'endTutorial', message: 'Tutorial Finished' },
];
