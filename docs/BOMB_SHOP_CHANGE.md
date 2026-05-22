# Bombs Shop — Redesign Handoff

This document describes the changes needed in `BombsShopScene` to match the
mockup at `Bombs Shop Hi-Fi.html`. **Read the constraints in §1 before
anything else.** A large part of this work is restructuring layout — most
existing visual chrome (colors, fonts, header, bottom bar) must stay exactly
as it is in the live game, regardless of how it looks in the mockup.

---

## 1. What must NOT change (overriding rules)

These rules supersede anything the mockup shows. The mockup was built with
web fonts, web colors, and a slightly different chrome treatment for
prototyping speed — **do not port those choices**. Use the live game's
existing tokens / sprites / sub-scenes.

### 1.1 Background color
Keep the current dark navy background exactly as it is in `BombsShopScene`.
The mockup uses `#191428`; if your live value differs, the live one wins.
Do not touch it.

### 1.2 Fonts
Keep every font (family, size, weight, letter-spacing) as it is in the live
game. The mockup uses Press Start 2P + Silkscreen + JetBrains Mono — these
are placeholders, not direction. All headings, labels, prices, counts,
button text, etc. should use the live game's existing Phaser bitmap/web
fonts unchanged.

### 1.3 Header — unchanged
The top header (the `BOMBS SHOP` title and the `Coins: N` display) must stay
exactly as it is in the live game across all screens:

- **No horizontal line separator** under the header. The mockup draws one;
  the game does not — keep the game's version.
- Same vertical position, same font, same weight, same color, same
  letter-spacing.
- Coins display unchanged: same `Coins: N` format, same gold color, same
  font, same position (top-right).

The mockup's header is for layout reference only. Copy the live one verbatim.

### 1.4 Bottom section — unchanged in full
Everything from the loadout area downward must stay exactly as it is in the
live game. Specifically:

- **`YOUR BOMBERMEN` row** — the bomberman selector widget — used as-is.
  Same font for `YOUR BOMBERMEN`, same card shapes, same tier badge
  positions, same EQUIPPED/EQUIP states, same character sprite rendering,
  same hover/click behaviour.
- **`[ < BACK ]` button** — same font, same position (bottom-left), same
  color, same click behaviour. The mockup wraps it in `[ < BACK ]` brackets;
  if the live version doesn't, keep the live formatting.
- **No horizontal line separators** between header → body → loadout → bombermen → back.
  The mockup uses thin border lines; the live game does not. Don't add them.

### 1.5 Bomberman tier-badge hover popup — unchanged
The game has a hover behaviour where mousing over the tier badge (`I`, `III`,
etc.) on a Bomberman card opens an additional info panel (HP, slot count,
perk — `TierInfoBadge` per `PROJECT-SUMMARY` §6 and §11.3). **Keep this
functionality exactly as it is in the live game.** The mockup omits it but
that's because it's hover state — port the live one as-is.

### 1.6 No other functionality changes outside the body
Switching equipped Bomberman, click-to-equip, the in-flight purchase toasts,
network round-trips — all unchanged.

---

## 2. What DOES change — body layout

Replace the body of `BombsShopScene` (the area between the header and the
`YOUR BOMBERMEN` row) with the three-panel layout below. Everything outside
this area is governed by §1.

### 2.1 Three columns
The body becomes a 3-column grid (~1:1.2:1 ratio across the available width).
Suggested gaps: 24px between columns, 36px outer horizontal padding.

```
┌────────────┐ ┌──────────────────┐ ┌────────────┐
│  CATALOG   │ │    BOMBERMAN     │ │  STOCKPILE │
│ (scroll)   │ │  + 7-slot list   │ │  (scroll)  │
└────────────┘ └──────────────────┘ └────────────┘
```

Each column is a Panel: a dark rounded-rect container with a header strip
at the top showing the column title. Header strip styling should follow
existing game tokens (the live game's panel chrome) — the mockup's
rendition is illustrative only.

Panel titles:
- Left: `CATALOG`
- Middle: `BOMBERMAN`
- Right: `STOCKPILE`

(Note the middle is **`BOMBERMAN`**, not `EQUIPPED`.)

---

### 2.2 CATALOG column (left)

A **scrollable** 3-column grid of bomb tiles. **All 15 buyable bombs**
(`PURCHASABLE_BOMBS`) are shown; the container scrolls vertically if there
are more rows than fit on-screen.

Per-tile contents (no description, no category label, no owned-count):

```
┌─────────────┐
│   [ICON]    │   ← 40px sprite from BOMB_CATALOG icon
│             │
│  Bomb Name  │   ← small text, centered, 1 line wrap allowed
│             │
│ 200c  [BUY] │   ← price + buy button on the SAME row
└─────────────┘
```

Tile fixed height ~116px so rows align cleanly when the list scrolls.

**Affordability states** (player coin balance vs. tile price):
- **Affordable**: full opacity, price in gold, `BUY` button enabled (gold bg,
  dark text).
- **Unaffordable**: tile dimmed (~65% opacity), price in red, button
  rendered as a disabled `—` placeholder (no `BUY` text, no click).

**Click behaviour**: clicking `BUY` increments `PlayerProfile.bombStockpile[type]`
(same as today). Clicking the tile body (not the button) selects it for
detail purposes only — no purchase.

**Important**: Do **not** show owned-count badges in catalog tiles. The
catalog supply is effectively infinite; owned counts belong in Stockpile.

---

### 2.3 STOCKPILE column (right)

A **scrollable** 3-column grid of tiles, same shape as catalog tiles, but
showing only bombs the player owns (`stockpile[type] > 0`).

Per-tile contents:

```
┌─────────────┐ ×N    ← stock badge top-right (green)
│   [ICON]    │
│             │
│  Bomb Name  │
└─────────────┘
```

Same fixed height as catalog tiles for visual consistency.

**Click behaviour**: clicking selects this stockpile entry as "the bomb to
be equipped next." On second click, deselects. When something is selected:
- Selected tile gets a gold border + light highlight.
- A small footer strip inside the Stockpile panel shows "Selected to equip:
  <Name> · Pick a slot to equip".
- Empty loadout slots in the middle panel get a subtle gold-glow pulse to
  invite the next click.

Equipping itself uses the existing `bombsShop.equipFromStockpile(slotIdx, type)`
logic — no flow change.

---

### 2.4 BOMBERMAN column (middle)

This is the renamed/restructured "Equipped" panel. The currently-equipped
Bomberman appears as a portrait at the top of the column with their 7-slot
loadout listed beneath, **inside the same panel** (not as a separate strip).

#### 2.4.1 Bomberman header (top of panel)

```
┌─────────────────────────────────────────────────────┐
│ [BOMBERMAN]                  52 bombs · 6/6 slots   │  ← panel header
├─────────────────────────────────────────────────────┤
│                                                     │
│  [CHAR]   Hermes    (III)                          │
│  120px    Tier III · 52/66 carried                  │
│           ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱  ← capacity fill meter   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  ... 7 slot rows ...                                │
└─────────────────────────────────────────────────────┘
```

- **Character sprite**: ~120px tall, single front-facing frame from the
  equipped Bomberman's spritesheet. **Re-use the existing
  `BombermanSpriteSystem` renderer** — same animation set, same tint, same
  pixel scale. Don't change how characters are drawn.
- **Name**: same font/size as elsewhere in the game's character displays.
- **Tier badge** (`I` / `III` / etc.) is the existing `TierInfoBadge`
  component — keep its hover-popup behaviour exactly (see §1.5).
- **Capacity meter**: thin horizontal fill bar (~6px tall) showing
  `totalEquipped / (slotCount × stackLimit)`. Optional but reads at a
  glance. Uses an existing UI color token if you have one for "progress
  good" (the same green used by the slot stack-full indicator).

#### 2.4.2 Slot rows (the 7-slot loadout, vertical list)

Beneath the header, **all 7 slots are listed vertically** in their existing
order (slot 1–6 custom, slot 7 = infinite Rock fallback).

Each row is a 5-column grid:

```
[ SLOT 1 ]  [icon 30px]  [Bomb Name           ]  [ 8/11 ]  [ UNEQUIP ]
            (centered)   ▰▰▰▰▰▱▱▱▱▱  meter
```

Columns (left → right):
1. **Slot label**: `SLOT N` in monospace, dim color, letter-spaced.
2. **Icon**: 30px sprite of the equipped bomb. (Smaller than the 40px in
   the Catalog/Stockpile tiles — the loadout slots are denser and a 40px
   icon overflows the row visually.)
3. **Name + fill meter**: bomb name on top, a thin 4px stack-fill meter
   below (gold for partial, green when stack is full).
4. **Count**: `8/11` in monospace. White when partial, green when full.
5. **UNEQUIP button**: small ghost button (transparent bg, dim border,
   monospace label). Click triggers existing unequip behaviour.

**Slot 7 (Rock, infinite)** styles differently:
- Row container has a **dashed** border instead of solid; background is
  transparent (not the standard slot fill).
- The count column reads `∞` instead of `N/M`.
- A sub-label `infinite (fallback)` appears below the name.
- **No UNEQUIP button**. Rock can't be removed.

**Padding**: each row needs `8px 16px` of padding so the SLOT label and
UNEQUIP button stay comfortably inside the row's border. The mockup had
these elements visually clipping at the edges initially — give them room.

**Hover highlight**: when the player hovers a bomb anywhere on screen
(catalog tile, stockpile tile, or a slot row), any slot row whose
`bombId` matches the hovered bomb should highlight (subtle gold border +
slight background tint). This is purely a discoverability cue ("I already
have this equipped").

---

## 3. On-hover bomb-details tooltip

This is the only new functionality in the screen. **Verify Phaser supports
it the way described** — see §3.5 for implementation notes.

### 3.1 What it is

When the player's pointer enters any element that represents a specific
bomb — a Catalog tile, a Stockpile tile, or a slot row in the middle
panel — a small **floating tooltip** appears near the pointer showing
that bomb's name, category, and one-line description. When the pointer
leaves the element, the tooltip disappears.

### 3.2 Contents

The tooltip contains, top to bottom:

1. A 2px-tall **colored bar** along the top, colored by the bomb's category
   (Standard = blue, Tactical = gold, Utility = green, Defensive = blue,
   Super = pink). This bar is the only category indicator on the screen
   apart from the small label below it.
2. A horizontal row: bomb icon (~40px) on the left; on the right, a small
   uppercase category label (same color as the top bar) on top, and the
   bomb name (larger) underneath.
3. A short description paragraph (`bomb.desc`) in dim text. **Keep it
   short** — one sentence. Use the simplified strings in the mockup data
   (`hifi-data.jsx`) as the source for these.

That's everything. **No** fuse/radius/owned/stats/tags rows; the mockup
explicitly excludes them.

### 3.3 Sizing and visual style

- Fixed width ~260px. Height auto from contents (~120–140px typical).
- Background: same panel background as the column panels.
- Border: 1px in the panel-border color, plus the 2px category-color top
  border described above.
- Drop shadow underneath for depth (the tooltip overlays the rest of the
  screen).
- `pointer-events: none` — the tooltip never intercepts the mouse. The
  player must be able to mouse straight through it onto another tile.

### 3.4 Positioning rules

- Default anchor: 16px right and 14px below the cursor (so the tooltip
  doesn't cover the element being hovered).
- **Flip horizontally** if the tooltip would extend past the right edge of
  the viewport — render it `cursor.x − tooltipWidth − 16` instead. (This
  matters because Stockpile tiles are on the right side of the screen.)
- **Flip vertically** if it would extend past the bottom edge — render it
  `cursor.y − tooltipHeight` instead.
- Update position on every `pointermove`. Don't snap to the tile —
  follow the cursor.

### 3.5 Phaser implementation notes

Phaser doesn't have HTML-style hover events out of the box, but the
existing game already has a `TooltipScene` (per `PROJECT-SUMMARY` §11.10)
which solves this exact problem: a global floating box that follows the
cursor and is shared across all scenes, with HUD/map tooltip
suppression rules. **Re-use it** instead of building a separate widget.

If `TooltipScene` doesn't currently support the rich layout (icon + colored
top bar + category label + name + description), extend its content
renderer to accept a structured payload like:

```ts
type BombTooltipContent = {
  kind: 'bomb';
  bombType: BombType;
  // pulled from BOMB_CATALOG: name, category, desc, iconKey
};
```

Wire up the hover surfaces (CatalogTile, StockpileTile, SlotRow) via
Phaser's built-in `setInteractive()` + `'pointerover'` / `'pointerout'` /
`'pointermove'` events:

```ts
tile.setInteractive();
tile.on('pointerover',  () => TooltipScene.show({ kind: 'bomb', bombType }));
tile.on('pointerout',   () => TooltipScene.hide());
tile.on('pointermove',  (p) => TooltipScene.move(p.x, p.y));
```

`TooltipScene.move` does the offset + edge-flip math from §3.4.

**Suppression** — preserve the existing `TooltipScene` rules: hide during
tutorial dialogue, throw-aim mode, and any full-screen overlay. Don't
build a parallel system that ignores these.

If after investigation you confirm `TooltipScene` cannot be extended to
carry image content (it may currently only render plain text), tell us
before forking — we'd rather extend the shared component than introduce a
shop-only tooltip widget that diverges from the rest of the game.

---

## 4. Affordability colors (catalog only)

Use existing game tokens for these states; don't introduce new colors.

- **Affordable price**: existing "coin gold" color (same as the coin
  display).
- **Unaffordable price**: existing "warning red" color (same color used
  elsewhere in the game for warnings — e.g. the broken-hatch warning,
  per `PROJECT-SUMMARY` §10).
- **Disabled BUY**: button is rendered without its gold fill, label
  replaced with a single `—` glyph in dim text.
- **Dimmed tile**: ~65% opacity on the whole tile container.

---

## 5. Files to touch

- `src/client/scenes/BombsShopScene.ts` — primary layout owner. Refactor
  the body composition; leave header / bombermen / back code paths alone.
- `src/client/scenes/TooltipScene.ts` (or wherever the shared tooltip
  lives) — extend to render the bomb-tooltip layout (§3).
- Asset usage: re-use existing bomb sprites from `BOMB_CATALOG` icons and
  the equipped Bomberman's spritesheet. No new assets required.
- Strings: simplified bomb descriptions can be lifted verbatim from
  `hifi-data.jsx → HIFI_BOMBS[*].desc`. Keep them this short — the
  tooltip is single-paragraph by design.

---

## 6. Things explicitly OUT of scope

- Sort / filter controls in the catalog (we have 15 bombs; not worth it).
- Per-tile category label, fuse/radius/tags inline on cards.
- Persistent always-visible detail panel in the layout — the tooltip is
  the only inspect surface.
- `+ Add Bomberman` affordance in the bottom strip (don't render one).
- Changing any of the items listed in §1.

---

## 7. Sprite mapping note (open question)

When building the mockup we matched bomb names to positions in
`bombs.png` by visual inspection — Phaser already has the correct mapping
in `BOMB_CATALOG`'s icon keys, so this section is informational only.
Use the existing icon keys; don't re-derive them.
