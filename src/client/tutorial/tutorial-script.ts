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
  { kind: 'setBlockMovement', blocked: true },
  { kind: 'setIdleMuted', muted: true },
  // OOC Rush off for the opening beats — turned back on for Beat 6.
  { kind: 'setSuppressRush', enabled: true },
  // Melee Trap disabled for everyone until the ambush beat. Without this,
  // the player's first idle would arm a trap and the stray bots we spawn
  // could trap themselves, both of which would derail the scripted pacing.
  { kind: 'setSuppressMeleeTrap', scope: 'all' },
  // Lock the follow-player camera for the whole tutorial — the player
  // can't pan, and every scripted `panCamera` actually stays where it
  // was put. Unlocked right before the final escape click in Beat 8.
  { kind: 'setCameraLocked', locked: true },

  // --- Prologue -----------------------------------------------------------
  { kind: 'panCamera', focus: 'player', durationMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'Welcome to tutorial' },

  // --- Beat 0: HUD Primer -------------------------------------------------
  { kind: 'highlight', target: { kind: 'timer' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Every Action Requires a Turn.' },
  { kind: 'highlight', target: { kind: 'hp' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Your HP. Do not lose it.' },
  { kind: 'highlight', target: { kind: 'coinCounter' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Coins. You keep these after extraction.' },
  { kind: 'highlight', target: { kind: 'bombTray' } },
  { kind: 'dialogue', portrait: 'char4', text: 'Four bomb slots. Loot to fill them.' },
  { kind: 'clearHighlight' },

  // --- Beat 1: Movement ---------------------------------------------------
  // Spawn is (6, 9). Click the destination (9, 10) — the client walks one
  // tile per turn automatically via BFS pathing. The director accepts every
  // intermediate move and advances the script only when the player's
  // bomberman has actually reached (9, 10). OOC Rush stays suppressed so
  // the walk is exactly four single-tile turns.
  { kind: 'setBlockMovement', blocked: false },
  { kind: 'dialogue', portrait: 'char4', text: 'To move click on walkable tiles.' },
  { kind: 'highlight', target: { kind: 'tile', x: 8, y: 11 } },
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 8, y: 11 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Good Job.' },

  // --- Beat 2: Practice Throw (Rock slot) --------------------------------
  // Player is at (9, 10). Rock slot (0) is always filled. Throw at (10, 9).
  { kind: 'panCamera', focus: { x: 9, y: 9 }, durationMs: 500 },
  { kind: 'dialogue', portrait: 'char4', text: 'Now let us do some throwing' },
  { kind: 'dialogue', portrait: 'char4', text: 'You always have a rock on you, select it' },
  // Lock movement so a stray floor click during the "click the rock slot"
  // beat doesn't BFS-walk the player off the teaching tile.
  { kind: 'setBlockMovement', blocked: true },
  { kind: 'highlight', target: { kind: 'slot', index: 0 } },
  // Wait for the player to click the Rock slot in the HUD. Wrong slot
  // flashes the highlight; correct slot advances the script with no turn
  // resolution.
  { kind: 'waitForAction', expected: { kind: 'selectBomb', slotIndex: 0 } },
  { kind: 'setBlockMovement', blocked: false },
  { kind: 'highlight', target: { kind: 'tile', x: 9, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'throwAt', slotIndex: 0, x: 9, y: 9 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: "Yeah you killed the shit out of that target" },
  { kind: 'dialogue', portrait: 'char4', text: "Now let's find some real bomb!" },

  // --- Beat 3: Chest Loot ------------------------------------------------
  // Hand-placed chest at (10, 9): 25 coins, 1 Flare, 1 Bomb.
  {
    kind: 'spawnChest',
    chestId: 'tut_chest',
    tier: 2,
    x: 10,
    y: 10,
    coins: 25,
    bombs: [
      { type: 'flare', count: 1 },
      { type: 'bomb', count: 1 },
    ],
  },
  { kind: 'panCamera', focus: { x: 10, y: 10 }, durationMs: 500 },
  { kind: 'dialogue', portrait: 'char4', text: 'Chest. Walk onto it and loot it!' },
  { kind: 'highlight', target: { kind: 'tile', x: 10, y: 10 } },
  // Click the chest tile — the client BFS-walks there over two turns.
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 10, y: 10 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Grab the Flare.' },
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'flare' } },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'chest', bombType: 'flare' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'And the Bomb.' },
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'bomb' } },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'chest', bombType: 'bomb' } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Good job, notice that the coins get picked up automatically' },
  { kind: 'highlight', target: { kind: 'coinCounter' } },

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
  { kind: 'dialogue', portrait: 'char4', text: 'Test the Flares. Light up this area' },
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
  { kind: 'dialogue', portrait: 'char4', text: 'Holy Mother of Jesus! What a surprise, there is an enemy RIGHT FKN THERE! Kill em' },
  { kind: 'highlight', target: { kind: 'slot', index: 2 } },
  { kind: 'highlight', target: { kind: 'tile', x: 17, y: 9 } },
  { kind: 'setBotAction', botId: 'B1', action: { kind: 'idle' } },
  {
    kind: 'waitForAction',
    expected: { kind: 'throwAt', slotIndex: 2, x: 17, y: 9, bombType: 'bomb' },
  },
  { kind: 'clearHighlight' },
  // Hold after the explosion so the bot's death animation can finish
  // before 'Down.' fires (~1s on top of the normal turn timing).
  { kind: 'promptIdle', text: 'Some Bombs take a turn to blow up', delayAfterMs: 1000 },
  { kind: 'dialogue', portrait: 'char4', text: 'Down.' },

  // --- Beat 5: Dodge -----------------------------------------------------
  // B2 is spawned far east (27, 10) so it stays outside the player's LOS
  // for the whole dodge beat — the bomb visibly "arrives from the dark"
  // without the shooter being shown. B2 is reused later for the ambush
  // so hp=2 is fine (the counter-kill caps at 2 damage anyway).
  {
    kind: 'spawnBot',
    botId: 'B2',
    x: 31,
    y: 10,
    character: 'char2',
    tint: 0x4488cc,
    hp: 2,
    inventory: [{ slot: 0, type: 'bomb', count: 1 },
		{ slot: 2, type: 'ender_pearl', count: 1 }],
  },
  { kind: 'panCamera', focus: 'player', durationMs: 500 },
  { kind: 'dialogue', portrait: 'char4', text: 'This is how we fight out here.' },
  { kind: 'dialogue', portrait: 'char4', text: 'But sometimes you have to dodge as well.' },

  // Camera snaps east to suggest the bomb is flying in from the dark.
  // Nothing is actually shown at that tile — B2 is further out, outside
  // LOS. The tiles are either seen-dim or black.
  { kind: 'panCamera', focus: { x: 25, y: 10 }, durationMs: 400 },
  // B2 actually throws the bomb (throw ranges are infinite) instead of us
  // fabricating one inline. autoEquip guarantees slot 0 holds a bomb even
  // if earlier beats mutated inventory. After this turn resolves the bomb
  // sits at (11, 10) with fuseRemaining=0 (placed at 1, ticked to 0 this
  // turn), so it explodes on the next resolveTurn — exactly when the
  // player dodges south. Plus-radius at (11, 10) does NOT cover (10, 11)
  // diagonally, so stepping down one tile survives cleanly.
  {
    kind: 'botThrow',
    botId: 'B2',
    slotIndex: 1,
    x: 11,
    y: 10,
    bombType: 'bomb',
    autoEquip: true,
  },
  // Resolve the throw turn with the player forced idle. Player input is
  // auto-blocked during autoIdleTurn so stray clicks can't derail this.
  { kind: 'autoIdleTurn', delayBeforeMs: 100, delayAfterMs: 300 },
  // Pan back over the bomb tile toward the player — simulates the arc.
  { kind: 'panCamera', focus: 'player', durationMs: 600 },
  { kind: 'dialogue', portrait: 'char4', text: "Don't panic, that bomb will take a turn to explode." },
  { kind: 'dialogue', portrait: 'char4', text: 'Just move one tile down.' },
  { kind: 'highlight', target: { kind: 'tile', x: 10, y: 11 } },
  // Single-tile move south. On resolve, bomb explodes at (11, 10); player
  // at (10, 11) is outside the plus pattern.
  { kind: 'waitForAction', expected: { kind: 'moveTo', x: 10, y: 11 } },
  { kind: 'clearHighlight' },
  // Wait for the explosion + dust to settle before reacting.
  { kind: 'autoIdleTurn', delayBeforeMs: 400, delayAfterMs: 800 },
  { kind: 'dialogue', portrait: 'char4', text: 'That was a close one!' },

  // --- Beat 6: Ambush ----------------------------------------------------
  // Player walks to (18, 9) and hides. Trap arms on the next idle turn,
  // then B2 approaches ONE TILE PER TURN (the resolver rejects any `move`
  // action whose target isn't Chebyshev-1 from the bot's current tile —
  // silently drops it, no movement). On the step to (19, 10), B2 is
  // Chebyshev-1 from player at (18, 9) and the step-in melee counter
  // fires inside the same turn. B2 dies at (19, 10); body drops there.
  { kind: 'dialogue', portrait: 'char4', text: "But now we don't have any bombs left and we don't know exactly where the Enemy is!" },
  { kind: 'dialogue', portrait: 'char4', text: "Let's try to ambush them." },
  // OOC Rush on for the walk-to-trap so the player experiences rushing.
  // With the new LOS-capped OOC rule, B2 at (23, 10) is outside the
  // player's fog sight from (10, 11), so rush has time to kick in before
  // they get close.
  { kind: 'setSuppressRush', enabled: false },

  // Snap B2 to its ambush start. hp=1 so one counter hit kills. Keep the
  // bomb in slot 0 and the ender_pearl in slot 2 (inv[1]) so the body
  // drops with both bombs intact for looting in Beat 6.5.
  {
    kind: 'mutateState',
    mutate: (s) => {
      const b2 = s.bombermen.find((b) => b.playerId === 'B2');
      if (!b2) return;
      b2.hp = 1;
      b2.x = 23;
      b2.y = 10;
      b2.coins = 15;
      b2.inventory.slots[0] = { type: 'bomb', count: 1 };
      b2.inventory.slots[1] = { type: 'ender_pearl', count: 1 };
    },
  },

  // Hiding tile is (18, 9). Reachable from (10, 11) via row 10 / 11
  // without touching the wall column on row 9.
  { kind: 'panCamera', focus: { x: 18, y: 9 }, durationMs: 600 },
  { kind: 'highlight', target: { kind: 'tile', x: 18, y: 9 } },
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 18, y: 9 } },
  { kind: 'clearHighlight' },

  // Player is hiding. Open the trap mechanic for them (bots still can't
  // enter, so scripted bots don't crouch mid-approach).
  { kind: 'setSuppressMeleeTrap', scope: 'bots' },
  { kind: 'setIdleMuted', muted: false },

  // One idle turn with no bot action → trap arms. The sword overlay shows
  // at the end of this resolve. Player input is auto-blocked during
  // autoIdleTurn.
  { kind: 'autoIdleTurn', delayBeforeMs: 400, delayAfterMs: 500 },

  { kind: 'dialogue', portrait: 'char4', text: 'By Standing still you activate AMBUSH MODE.' },
  { kind: 'dialogue', portrait: 'char4', text: 'Now if anyone comes close, you will have an element of surprise!' },
  { kind: 'dialogue', portrait: 'char4', text: 'Just you wait...' },

  // B2 walks (23, 10) → (22, 10) → (21, 10) → (20, 10) → (19, 10) over
  // four auto-idle turns. EACH setBotAction MUST target an adjacent tile
  // or the resolver silently drops the move. On the final step B2 is
  // Chebyshev-1 from player at (18, 9); the step-in melee counter fires
  // inside the same turn and B2 dies at (19, 10).
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 22, y: 10 } },
  { kind: 'autoIdleTurn', delayAfterMs: 200 },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 21, y: 10 } },
  { kind: 'autoIdleTurn', delayAfterMs: 200 },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 20, y: 10 } },
  { kind: 'autoIdleTurn', delayAfterMs: 200 },
  { kind: 'setBotAction', botId: 'B2', action: { kind: 'move', x: 19, y: 10 } },
  // Counter kill fires this turn. Hold a long pause so the death
  // animation plays out cleanly before the next dialogue.
  { kind: 'autoIdleTurn', delayAfterMs: 3000 },

  { kind: 'dialogue', portrait: 'char4', text: 'He never saw it coming.' },
  { kind: 'dialogue', portrait: 'char4', text: 'When you are in a tight spot, you can always rely on good old melee.' },

  // --- Beat 6.5: Loot a body + Ender Pearl teach ------------------------
  // Body drops at (19, 10) where B2 died. Player walks there, loots the
  // ender_pearl, then throws it 2 tiles south of the Escape Hatch (26, 7)
  // to teleport near the extraction point.
  { kind: 'dialogue', portrait: 'char4', text: "Let's see what that fool had on him." },
  { kind: 'highlight', target: { kind: 'tile', x: 19, y: 10 } },
  { kind: 'waitForAction', expected: { kind: 'reachTile', x: 19, y: 10 } },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: 'Aw sweet, an Ender Pearl! Grab it' },
  { kind: 'highlight', target: { kind: 'lootItem', bombType: 'ender_pearl' } },
  { kind: 'waitForAction', expected: { kind: 'lootBomb', sourceKind: 'body', bombType: 'ender_pearl' } },
  { kind: 'clearHighlight' },
  // Force the ender_pearl into inventory.slots[1] (action slot 2) so the
  // next throwAt expectation is deterministic regardless of which slot
  // the player clicked in the loot panel. If it's already there, this
  // is a no-op; otherwise we swap whatever is in slot[1] with the pearl.
  {
    kind: 'mutateState',
    mutate: (s) => {
      const me = s.bombermen.find((b) => b.playerId === 'tutorial-player');
      if (!me) return;
      const slots = me.inventory.slots;
      const idx = slots.findIndex(sl => sl?.type === 'ender_pearl');
      if (idx === -1 || idx === 1) return;
      [slots[1], slots[idx]] = [slots[idx], slots[1]];
    },
  },
  { kind: 'dialogue', portrait: 'char4', text: "Nice let's test it out!" },
  { kind: 'dialogue', portrait: 'char4', text: "Throw it 2 tiles south of the Escape Hatch — you'll teleport right there." },
  // Target (26, 9): two tiles south of the hatch at (26, 7). Ender Pearl
  // teleports the thrower to the target tile, so the player ends up at
  // (26, 9) — Beat 7 then walks them the remaining two tiles north.
  { kind: 'highlight', target: { kind: 'slot', index: 2 } },
  { kind: 'highlight', target: { kind: 'tile', x: 26, y: 9 } },
  {
    kind: 'waitForAction',
    expected: { kind: 'throwAt', slotIndex: 2, x: 26, y: 9, bombType: 'ender_pearl' },
  },
  { kind: 'clearHighlight' },
  { kind: 'dialogue', portrait: 'char4', text: "Use Ender Pearls if you ever need to Escape" },
  { kind: 'dialogue', portrait: 'char4', text: "Now, let's GTFO." },

  // --- Beat 7: Escape ----------------------------------------------------
  // Unlock the camera the moment we invite the player back to the stick.
  // From now on it follows their bomberman again.
  { kind: 'setCameraLocked', locked: false },
  // Skip the long walk from the ambush corner to the hatch — drop the
  // player right next to it so the escape beat stays punchy.
  { kind: 'panCamera', focus: { x: 26, y: 7 }, durationMs: 900 },
  { kind: 'dialogue', portrait: 'char4', text: 'That is the hatch. Walk onto it, then wait one turn.' },
  { kind: 'highlight', target: { kind: 'tile', x: 26, y: 7 } },
  // Click the hatch — client BFS-walks there.
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
