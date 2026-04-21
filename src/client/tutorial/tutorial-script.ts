import type { TutorialStep } from './types.ts';

/**
 * The editable tutorial script. Each entry is one step; the director walks
 * them top-to-bottom. Edit freely — any balance / gameplay changes will be
 * picked up automatically by MatchScene since the tutorial runs the real
 * match loop.
 *
 * Design rules enforced by this script:
 *   - Instructions are delivered via a dialogue **before** the interaction
 *     step. We never stack a "click to continue" dialogue on top of a
 *     "click this HUD thing" waitForAction — otherwise the first player
 *     click dismisses the dialogue instead of arming the slot.
 *   - OOC Rush is suppressed for every beat except Beat 6's walk-to-trap
 *     so it can teach rush in context without activating prematurely.
 */
export const TUTORIAL_SCRIPT: TutorialStep[] = [
  // Start in the muted state so stray self-clicks don't accidentally idle.
  { kind: 'setIdleMuted', muted: true },
  // OOC Rush off for the opening beats — turned back on for Beat 6.
  { kind: 'setSuppressRush', enabled: true },

  // --- Prologue -----------------------------------------------------------
  { kind: 'panCamera', focus: 'player', durationMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'Welcome to the dungeon.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Every click is a turn. Everyone moves at once.' },
  { kind: 'dialogue', portrait: 'char4', text: "Let's learn the basics." },
  { kind: 'pause', text: 'Now it begins.' },

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
  // Spawn is (6, 9). Click the destination (9, 10) — the client walks one
  // tile per turn automatically via BFS pathing. The director accepts every
  // intermediate move and advances the script only when the player's
  // bomberman has actually reached (9, 10). OOC Rush stays suppressed so
  // the walk is exactly four single-tile turns.
  { kind: 'dialogue', portrait: 'char4', text: 'Click the highlighted tile. You walk one tile per turn — the game resolves each step before the next.' },
  { kind: 'highlight', target: { kind: 'tile', x: 9, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 9, y: 10 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Movement: done.' },
  { kind: 'pause', text: 'Now let us try throwing.' },

  // --- Beat 2: Practice Throw (Rock slot) --------------------------------
  // Player is at (9, 10). Rock slot (0) is always filled. Throw at (10, 9).
  { kind: 'panCamera', focus: { x: 10, y: 9 }, durationMs: 500 },
  { kind: 'dialogue', portrait: 'char4', text: 'Your Rock slot is always available. Arm it and throw.' },
  { kind: 'highlight', target: { kind: 'slot', index: 0 } },
  { kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 10, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: "That's the arc. You commit the slot when you click the tile." },
  { kind: 'pause', text: 'Now let us find real bombs.' },

  // --- Beat 3: Chest Loot ------------------------------------------------
  // Hand-placed chest at (10, 9): 25 coins, 1 Flare, 1 Bomb.
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
  { kind: 'dialogue', portrait: 'char4', text: 'Chest. Walk onto it — coins auto-pick; bombs are looted via the panel.' },
  { kind: 'highlight', target: { kind: 'tile', x: 10, y: 9 } },
  // Click the chest tile — the client BFS-walks there over two turns.
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 10, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Grab the Flare.' },
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'flare' } },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'chest', bombType: 'flare' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'And the Bomb.' },
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'bomb' } },
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
  { kind: 'dialogue', portrait: 'char4', text: 'An enemy. Light them up first — Flare reveals tiles.' },
  // Flare target is one tile LEFT of the enemy (16, 10) so the flare
  // lights the enemy tile without landing on top of it.
  { kind: 'highlight', target: { kind: 'slot', index: 1 } },
  { kind: 'highlight', target: { kind: 'tile', x: 16, y: 10 } },
  { kind: 'setBotAction', botId: 'B1', action: { kind: 'idle' } },
  {
    kind: 'waitForAction',
    expected: { kind: 'throwAt', slotIndex: 1, x: 16, y: 10, bombType: 'flare' },
  },
  { kind: 'clearHighlight' },
  // Enemy revealed — pop an exclamation over the bot.
  { kind: 'flashExclamation', x: 17, y: 10 },
  { kind: 'dialogue', portrait: 'char4', text: 'Lit. Now finish them.' },
  { kind: 'highlight', target: { kind: 'slot', index: 2 } },
  { kind: 'highlight', target: { kind: 'tile', x: 17, y: 10 } },
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
  // Phase A — OOC Rush teaches here. B2 starts far east so the player's
  // walk-to-trap-tile can use rush (2 tiles/turn) without enemy proximity
  // breaking rush instantly. After Phase A walk is done we flip
  // suppressRush back on so the trap countdown doesn't trigger more rush.
  {
    kind: 'mutateState',
    mutate: (s) => {
      const b2 = s.bombermen.find((b) => b.playerId === 'B2');
      if (!b2) return;
      b2.hp = 1;
      b2.x = 27;
      b2.y = 10;
      b2.coins = 15;
      b2.inventory.slots[0] = { type: 'bomb', count: 1 };
      // Give rush a head start so it's active for the walk.
      const me = s.bombermen.find((b) => b.playerId === 'tutorial-player');
      if (me) {
        me.rushCooldown = 3;
        me.rushActive = true;
      }
    },
  },
  // OOC Rush on for the walk-to-trap step.
  { kind: 'setSuppressRush', enabled: false },
  { kind: 'panCamera', focus: { x: 18, y: 10 }, durationMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'OOC Rush is active — you move two tiles per click while clear of enemies.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Click the highlighted corner.' },
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 9 } },
  // Player at (21, 9). Click (18, 9): BFS path = [(20,9),(19,9),(18,9)].
  // Rush kicks in → move action carries head=(20,9), rush=(19,9).
  {
    kind: 'waitForAction',
    expected: { kind: 'moveTo', x: 20, y: 9, rushX: 19, rushY: 9 },
  },
  // Next click: path from (19,9) to (18,9) is a single tile — no rush.
  {
    kind: 'waitForAction',
    expected: { kind: 'moveTo', x: 18, y: 9 },
  },
  { kind: 'clearHighlight' },
  // Rush off again — keeps the trap sequencing deterministic.
  { kind: 'setSuppressRush', enabled: true },

  // --- Unmute self-click-idle and teach the crouch ---
  { kind: 'setIdleMuted', muted: false },
  { kind: 'dialogue', portrait: 'char4', text: 'You can wait by clicking your own tile.' },
  { kind: 'dialogue', portrait: 'char4', text: 'That puts you in Melee Trap Mode — crouched, counter ready.' },
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Crouched. Stay still — they are coming.' },

  // Phase B — B2 walks (27, 10) → (18, 10) tile by tile. Each turn the
  // player self-idles to stay crouched. B2's step-in to (18, 10) is
  // Chebyshev-1 from (18, 9) → counter fires.
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 26, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 25, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 24, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 23, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 22, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
  { kind: 'dialogue', portrait: 'char4', text: 'They are closer.' },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 21, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'idle' } },
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
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'bomb' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Grab their bomb.' },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'body', bombType: 'bomb' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Scavenging keeps you alive.' },
  { kind: 'pause', text: 'Last lesson: extraction.' },

  // --- Beat 8: Escape ----------------------------------------------------
  { kind: 'panCamera', focus: { x: 26, y: 7 }, durationMs: 900 },
  { kind: 'dialogue', portrait: 'char4', text: 'That is the hatch. Walk onto it, then wait one turn.' },
  { kind: 'highlight', target: { kind: 'tile', x: 26, y: 7 } },
  { kind: 'teleportPlayer', x: 25, y: 8 },
  // Click the hatch — client BFS-walks there over two turns.
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 26, y: 7 } },
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
