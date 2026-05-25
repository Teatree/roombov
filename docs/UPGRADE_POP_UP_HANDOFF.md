# Bomberman Upgrade Popup — Engineering Handoff

> Implementation brief for `BombermanUpgradePopup` (working name). Companion
> mockup: `Upgrade Popup Hi-Fi.html`. Read `DESIGN_PREFERENCES.md` first if
> you haven't — the universal screen rules apply here too.

---

## 1. What must NOT change (overriding rules)

These rules override anything in the mockup. The mockup is for layout
intent only; do not port its font choices or color hex values verbatim.

### 1.1 The live game's wallet widget — unchanged
The popup is modal but the **wallet stays outside it**, in the live
game's existing top-right wallet widget. **Reuse the wallet exactly as
the game already renders it** (font, color, icon order, spacing).
The mockup approximates it but is reference only.

The wallet display in the live game must already show **all three
resource types**:

- `SP` (renamed from XP) — primary character-progression resource.
- `Coins` — primary currency.
- Treasures — the gem icons, one per type. The Upgrade popup uses three
  specific types (see §3) — make sure they're rendered in the wallet
  during the upgrade flow.

If `SP` (Skill Points) is the live game's existing name for the
character-progression currency, keep that. If the live game still calls
it `XP`, this redesign **renames it to `SP`** in all surface UI —
update the wallet widget, profile screens, and any tooltips.

### 1.2 The Bomberman select / roster screen behind the popup — unchanged
The popup opens on top of an existing roster screen (the most likely
trigger — see §4.1). That screen's content, layout, and chrome are all
unchanged. The popup just dims it.

### 1.3 Tier-badge hover popup behavior — unchanged
If the live game has the existing hover-on-tier-badge info popup on
Bomberman cards, that behavior continues to work elsewhere. **The
Upgrade popup does NOT replace it.**

### 1.4 No separator lines
The live game's UI style does not use horizontal divider lines between
sections. The popup itself can have a thin border framing it (it's a
modal), but the contents inside use spacing alone to separate the hero
section from the stat list. Don't draw a horizontal divider under the
sprite.

### 1.5 Fonts
The mockup uses Press Start 2P + Silkscreen + JetBrains Mono as
placeholders. **Use the live game's existing fonts.** Sizes and
letter-spacing in this doc are written for the mockup approximations;
adjust to match the live game's metrics while keeping the visual
hierarchy intact.

---

## 2. The popup — visual specification

A centered modal overlay. Roughly 520px wide on desktop; height hugs
content (~520–600px in active state, ~480px in maxed state).

### 2.1 Backdrop

- Render a full-screen `0x000612` dim layer at ~78% opacity over the
  parent scene. The parent scene continues to render underneath at
  reduced visibility — this is important for context.
- Block clicks on everything behind the dim layer.
- ESC closes the popup. Clicking the dim layer (outside the popup
  body) also closes the popup.

### 2.2 Popup container

- Background: existing dark panel color (matches the Bombs Shop's panel
  background — `~#221b35` in the mockup).
- Border: 2px in the slightly-lighter panel-highlight color
  (`~#5b4a7d`). This is the modal's distinguishing chrome — it's
  intentionally a hair brighter than non-modal panels.
- Corner radius: 4px (matches existing panel corner treatment).
- Drop shadow: a subtle dark glow (`0 12px 60px rgba(0,0,0,0.55)`) to
  lift it off the dimmed backdrop. No bright outer glow.

### 2.3 Close button (X)

- Lives at the popup's top-right corner: 8px inset from the top and
  right edges, 28×28px.
- Style: transparent background, dim text color (`~#9a8eb0`), thin
  1px border in the panel-border color, 2px radius, monospace `×`
  glyph at ~18px.
- Hover: text brightens to body color, border to panel-highlight color.
- Click: close popup.

### 2.4 Hero section (Bomberman)

The popup's top section, centered. Stack of three elements **in this
vertical order**, matching the Bomberman select cards' arrangement:

1. **Tier badge** — 40×40 round chip, 2px border in tier color, dark
   panel-alt background, tier color text, monospace font ~16px, bold.
   Centered on screen-X.
2. **Name** — game's heading font, ~22px, 3px letter-spacing, default
   text color. ~8px gap above.
3. **Sprite** — 140×140px, pixelated rendering, drawn from the
   Bomberman's character spritesheet. Use the existing
   `BombermanSpriteSystem` renderer — same single front-facing frame
   used by the Bomberman select cards. ~4px gap above the sprite.

Total hero section padding: ~22px top, ~18px bottom.

**If the Bomberman is fully maxed** (every upgradeable stat at cap),
add a gold "FULLY UPGRADED" banner directly under the sprite:

- Padding 5×14, gold background, dark text, ~11px heading font, 3px
  letter-spacing, 2px radius.

### 2.5 Stat rows

Three rows in a vertical list (CAP, STACK, HP — in that order), one per
upgradeable stat. Gap between rows: 10px. Horizontal padding 18px
inside the popup.

Each row is a 3-column grid:

```
┌───────────┬────────────────────────┬─────────────────┐
│ label     │   cur   →   next       │  cost line       │
│ + pips    │   (centered)           │  UPGRADE button  │
└───────────┴────────────────────────┴─────────────────┘
   ~78px              1fr                  ~134px
```

Row container:
- Background: `~#1e1730` (slightly darker than the popup body).
- Border: 1px in the panel-border color.
- **Border-left: 3px in the stat color** — this is the only
  category-color usage in the row.
- Corner radius: 3px.
- Padding: 12px 14px.

#### Column 1 — Label + pips

- Stat label: heading font, ~13px, 2px letter-spacing, **stat color**.
- Below the label, a row of tier pips with 3px gap:
  - Each pip is a 14×4 rectangle, 1px border, 1px corner radius.
  - Pips are filled with the stat color if `tier <= current`, else
    transparent with a dim border.
  - HP only has 1 pip (single upgrade tier).
  - CAP & STACK have 3 pips each (three upgrade tiers).

#### Column 2 — Current → next

- Centered horizontally and vertically.
- Layout: `<current>  →  <next>`.
- Current value: heading font, ~30px, default text color (or stat
  color if the row is maxed — see §2.6).
- Arrow: monospace, ~16px, dim text color.
- Next value: heading font, ~30px, **stat color**.
- ~10px gap between elements.

#### Column 3 — Cost + button

Stacked vertically with a 4px gap:

**Cost line** (above the button, horizontally centered, 8px gap
between tokens):

- `SP <amount>` — heading font for "SP" (~11px), monospace for the
  number, blue (`~#5db5ff`).
- `<amount>c` — monospace, gold (`~#ffc83a`).
- `<amount>` followed by the treasure icon — monospace, default text
  color; icon is 11×11px from the treasure spritesheet.

**Affordability tinting**: each token tints **independently**. Only the
deficient currency turns red (`~#ff5a4a`); the other tokens stay in
their normal color. This matches the Bombs Shop's behavior.

**UPGRADE button**:

- Heading font, ~11px, 2px letter-spacing.
- Padding 8px 0, width fills the column.
- Affordable: gold background (`~#ffc83a`), dark text, 1px gold
  border, 2px radius. Pointer cursor.
- Unaffordable: transparent background, dim text, 1px panel-border,
  not-allowed cursor. Label text changes from `UPGRADE` to `LOCKED`.

### 2.6 Maxed stat row

When the player has fully upgraded a single stat (its current value is
at the cap of its upgrade track), that row swaps two things:

1. **Row opacity drops to ~78%** — visually de-emphasized, signals
   "this is done."
2. **Column 2** still shows the current value, but in the stat color
   (no arrow, no next value).
3. **Column 3** replaces the cost line + UPGRADE button with a single
   **MAXED** badge:
   - Heading font, ~11px, 2px letter-spacing.
   - Padding 10px 0, fills the column.
   - Center-aligned text in the stat color.
   - 1px **dashed** border in the stat color, 2px radius.
   - No background fill.
   - Not interactive.

### 2.7 Fully-maxed popup (all stats maxed)

When every stat is maxed:

- All three rows render in their maxed state (per §2.6).
- The "FULLY UPGRADED" banner from §2.4 appears under the sprite.
- The popup is still openable — the player can review their final
  stats. The X button is the only interactive element.

**Alternative**: consider hiding the UPGRADE affordance entirely on the
Bomberman card (the entry-point button — see §4) when the character is
fully maxed, so this popup is only reachable via a "review stats" link.
Discuss with design — current spec keeps the popup reachable.

---

## 3. Data model

Each Bomberman carries its own upgrade state in `PlayerProfile`:

```ts
type UpgradeStatId = 'cap' | 'stack' | 'hp';
type TreasureId    = string; // existing treasure type id

interface UpgradeTier {
  to: number;            // value after applying this tier
  sp: number;            // SP cost
  coins: number;         // coin cost
  treasure: TreasureId;  // which treasure type
  treasureAmt: number;   // treasure cost
}

interface BombermanUpgradeTrack {
  current: number;       // current stat value
  // upgrades[i] is the i-th tier upgrade; absent if no tiers left.
  upgrades: UpgradeTier[];
  // baseValue is the starting value before any upgrades.
  baseValue: number;
}

interface BombermanProfile {
  // ...existing fields (tier, name, equipped, etc.)
  upgrades: {
    cap:   BombermanUpgradeTrack;  // 0–3 tiers remaining
    stack: BombermanUpgradeTrack;  // 0–3 tiers remaining
    hp:    BombermanUpgradeTrack;  // 0–1 tiers remaining (most start at 2, cap is 3)
  };
}
```

Limits (per project summary):

- **CAP**: 3 tiers max. Per-Bomberman tier amounts differ.
- **STACK**: 3 tiers max. Per-Bomberman tier amounts differ.
- **HP**: 1 tier max. Most Bombermen start at HP 2 → upgrade to HP 3.

The popup's pip display uses `upgrades.length + tiersAlreadyDone` to
draw pips. A pip is "done" when its corresponding tier has been
applied (i.e. `current >= baseValue + tierIndex + 1` is one way to
derive this if the tiers are stored as a flat list keyed by index).

### 3.1 Treasure-to-stat mapping (default)

Mockup uses:

- CAP    → `bones`
- STACK  → `fish`
- HP     → `amulet`

The live game can choose its own mapping; this is data-driven. Each
`UpgradeTier` carries its own `treasure` id, so the mapping can vary by
Bomberman or tier if needed.

### 3.2 Affordability

```ts
function canAfford(tier: UpgradeTier, profile: PlayerProfile): boolean {
  return profile.sp >= tier.sp
      && profile.coins >= tier.coins
      && (profile.treasures[tier.treasure] ?? 0) >= tier.treasureAmt;
}
```

Each currency is checked independently for red-tint cues (see §2.5).

### 3.3 Apply upgrade

```ts
function applyUpgrade(profile: PlayerProfile, bombermanId: string, statId: UpgradeStatId) {
  const bm = profile.bombermen[bombermanId];
  const track = bm.upgrades[statId];
  const tier = track.upgrades.shift();  // pull the next tier
  if (!tier || !canAfford(tier, profile)) return;
  profile.sp -= tier.sp;
  profile.coins -= tier.coins;
  profile.treasures[tier.treasure] -= tier.treasureAmt;
  track.current = tier.to;
  // persist + sync server
}
```

---

## 4. Integration

### 4.1 Entry point

The Upgrade popup is triggered from a per-Bomberman action on the
Bomberman select / roster screen. Recommended: a small UPGRADE button
on each Bomberman card, sitting alongside or below the existing
EQUIP / EQUIPPED control.

- Button label: `UPGRADE`.
- Style: matches the existing ghost-button style on Bomberman cards.
- Disabled state: if the Bomberman is fully maxed AND we decide to
  hide the popup on max (§2.7 alternative), the button shows
  `MAXED` instead of `UPGRADE` and does nothing.

Clicking opens the popup focused on that Bomberman.

### 4.2 Phaser scene structure

Implement as a dedicated overlay scene (e.g. `BombermanUpgradeScene`)
that:

- Pauses input on the parent scene (the roster scene).
- Renders the dim layer + popup container at the top of the scene
  stack.
- Restores parent input on close.
- Stops itself on ESC, dim-layer click, or X click.

If the game already has a generic modal-overlay scene (similar pattern
to `TooltipScene`), prefer extending that — one shared modal stack
keeps z-index discipline simpler.

### 4.3 Wallet sync

After a successful `applyUpgrade()` call:

- Emit the existing wallet-changed event so the live wallet widget
  re-renders with the deducted balances.
- Re-render the popup itself (the next tier slot becomes the new
  "active" upgrade in the row that was just clicked).
- If the player has now maxed that stat, that row collapses to the
  maxed state per §2.6. If they've now maxed everything, add the
  FULLY UPGRADED banner per §2.7.

### 4.4 Animation

Keep animations restrained. Acceptable:

- Popup fade-in / fade-out (~150ms).
- Brief flash on the row after a successful upgrade (~200ms),
  highlighting the new pip.
- Optional: a small +1 number float-up on the stat value after upgrade.

Avoid screen shake, confetti, big particle bursts. The popup is a
utility surface; the celebration moment is the "FULLY UPGRADED" banner
appearing.

---

## 5. Affordability colors

Reuse the existing game tokens (this is a repeat of the Bombs Shop's
treatment for consistency):

- SP cost text: blue (`~#5db5ff`) when affordable; red when not.
- Coin cost text: gold (`~#ffc83a`) when affordable; red when not.
- Treasure cost text: default text color when affordable; red when not.
- UPGRADE button: gold fill when all three are affordable; otherwise
  transparent fill with dim text and `LOCKED` label.

---

## 6. State matrix

| Bomberman state                           | What renders                                |
| ----------------------------------------- | ------------------------------------------- |
| All stats have upgrades remaining         | Three normal stat rows. UPGRADE on each.    |
| Player can't afford the next tier of a stat | That row's currency token(s) turn red, button shows `LOCKED`. |
| One or two stats are maxed                | Those rows render in the maxed state (§2.6). Others remain normal. |
| All three stats are maxed                 | All rows in maxed state + FULLY UPGRADED banner under the sprite (§2.7). |
| Bomberman not yet unlocked / not owned    | The popup should not be reachable. Hide the entry-point UPGRADE button on un-owned cards. |

---

## 7. Files (suggested)

- `src/client/scenes/BombermanUpgradeScene.ts` — the new overlay
  scene.
- `src/client/widgets/UpgradeStatRow.ts` — single stat row component
  used three times.
- `src/client/widgets/Wallet.ts` — **extend** existing wallet to
  display the SP + coins + treasure triplet (if it currently only
  shows coins or coins + treasures).
- `src/shared/data/BombermanUpgradeTables.ts` — per-tier cost data for
  every Bomberman tier. Authored data.
- `src/server/handlers/applyUpgrade.ts` — server endpoint for the
  upgrade transaction (validates costs, applies deductions, returns
  new state).

---

## 8. Out of scope (explicitly)

- **Refunding / respeccing upgrades.** Not supported.
- **Cross-Bomberman shared progression.** Each Bomberman's upgrades are
  independent.
- **Reset on extraction loss.** Upgrades persist regardless of
  extraction outcomes (unless the game design says otherwise — confirm
  with design).
- **In-popup currency purchase shortcuts.** Don't add a "buy more coins"
  affordance inside this popup. If the player can't afford, they
  close and earn more coins elsewhere.
- **Multi-tier preview** (showing all 3 cap upgrades on one screen).
  The popup always shows only the NEXT tier — the pip strip is the
  hint that more remain.

---

## 9. Open questions

1. **Where does SP come from?** The data model assumes a `profile.sp`
   field. If the game currently calls this `xp`, the rename is part of
   this work. Confirm whether the rename should also retroactively
   update saved profiles.
2. **Entry-point styling.** The UPGRADE button on each Bomberman card
   needs to be added. Confirm whether it should sit next to EQUIP, or
   replace the tier badge's click action, or appear only on hover.
3. **Max-on-card display.** When a Bomberman is fully maxed, should
   the Bomberman card itself show a "MAX" marker (e.g. a small badge
   next to the tier badge)? Recommended yes — gives players a clean
   at-a-glance read of who's done.
