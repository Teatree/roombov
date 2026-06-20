# Roombov — "Pixel Panel" UI Style Handoff

> **For Claude Code.** This documents the visual system and element arrangement
> decided in the design prototype (`Pixel Panel Prototype.html`). You already
> know the project's functionality — **nothing here asks you to build new
> features**. This is a restyle + rearrange spec for UI that already exists.
> Where the prototype and the live game differ functionally, the live game wins;
> only adopt the looks and layout.
>
> Reference screens live in the prototype: Main Menu, Lobby, Bombs Shop,
> Bomberman (upgrade + shop), and the in-match HUD. Main Menu and Lobby are
> specified in full detail below; the rest follow the same system.

---

## 1. Design system — "Pixel Panel"

The aesthetic: the game's existing dark-purple palette and pixel sprites, made
coherent through ONE panel construction, TWO fonts, and STRICT color semantics.
No theming, no fiction copy ("PLAY" is "PLAY", not "DEPLOY"). Readability first.

### 1.1 Color tokens

Use these exact values everywhere. Do not invent new colors; if a new need
arises, reuse the closest semantic token.

| Token        | Hex       | Use |
|--------------|-----------|-----|
| `bg`         | `#191428` | Screen background (all screens) |
| `panel`      | `#221b35` | Panel fill |
| `panel2`     | `#1e1730` | Nested/recessed fill (inside a panel: stat boxes, slot rows, char boxes) |
| `border`     | `#3a2f54` | Default 2px panel border, 1px inner dividers |
| `borderHi`   | `#5b4a7d` | Hover border, emphasized border |
| `text`       | `#e8e1cf` | Primary text (warm off-white) |
| `dim`        | `#9a8eb0` | Secondary text |
| `faint`      | `#5e526f` | Tertiary text, labels, empty-state glyphs |
| `gold`       | `#ffc83a` | PRIMARY accent: main CTA fill, coins, partial-fill counts |
| `goldEdge`   | `#a87f1a` | Border on gold-filled elements |
| `goldText`   | `#241a06` | Text on gold fill (never white-on-gold) |
| `green`      | `#7ad159` | "Yours / positive": equipped, joined, full stacks, Normal mode, STACK stat |
| `red`        | `#ff5a4a` | HP stat, urgent timers (≤5s), destructive actions (UNJOIN) |
| `blue`       | `#5db5ff` | Hyperlink-style text actions, CAP stat, informational (Tutorial, UAV) |
| `orange`     | `#ffa14d` | Special match modes (anything not "Normal") |
| stage frame  | `#0d0a18` | Letterbox behind the 1600×980 stage; also the title text-shadow color |
| debug red    | `#7e453c` | Debug-only footer actions (muted, deliberately uninviting) |
| status green | `#5d8a4a` | Muted connection status line |

### 1.2 Typography

Two faces only (Google Fonts):

- **Press Start 2P** — headings, button labels, numerals that must read as
  "game data" (timers, prices, stat values, counts, level numbers, wallet).
  It runs large; sizes are SMALL: screen title 36px, panel heading 13–22px,
  button label 10–20px, data numerals 11–15px. Big countdowns: 30px.
- **Silkscreen** — everything else: body copy, field labels, meta text,
  link-style actions. Sizes 12–16px.

Conventions:
- Label style: Silkscreen, 12–14px, `letter-spacing: 1–4px`, color `faint`
  or `dim`, UPPERCASE (e.g. `PLAYERS 2/4`, `LOADOUT`, `YOUR BOMBERMEN`).
- Screen titles: Press Start 2P 36px, `text` color, hard pixel shadow
  `5px 5px 0 #0d0a18`, centered at top. Subtitle below: Silkscreen 16px,
  `letter-spacing: 4px`, `dim`.
- Never use any other font, italics, or font-weight tricks (these faces have
  one weight that matters).

### 1.3 Panel construction (the signature element)

Every container is built the same way:

1. Fill: `panel` (or `panel2` when nested inside another panel).
2. Border: `2px solid border`.
3. **Notched corners**: four 8×8px squares of the PARENT's background color,
   absolutely positioned at `-2px` over each border corner. This clips the
   corners into the pixel-notch shape. Nested panels use 5–6px notches.
   (In Phaser this is simply a 9-slice / corner mask; the point is corners
   read as cut, not rounded.)
4. **Tab label** (optional): a small Silkscreen 14px label sitting ON the top
   border (offset up ~22px, padded 8px horizontally with the panel's own fill
   so it interrupts the border line). Used for panel roles: `EQUIPPED`,
   `CATALOG`, mode names on match cards. A second tab may sit right-aligned
   (e.g. `JOINED ✓`).

**No rounded corners anywhere** (the level badge circle is the one exception).
**No gradients, no blur/glow, no drop shadows** (the only shadow in the system
is the title's hard pixel shadow). **No emoji.**

### 1.4 Color semantics (keep these strict)

- **Gold = "the main thing / money."** Exactly one gold-filled element per
  screen wherever possible (PLAY on menu; the urgent JOIN in the lobby; BUY
  where affordable). Gold fill always pairs `goldEdge` border + `goldText` text.
- **Stat color-coding** (matches the Bomberman upgrade screen, used EVERYWHERE
  a stat appears — boxes, popups, upgrade tracks): **HP = red, CAP = blue,
  STACK = green.** Both the label and the value take the color.
- **SP is NOT a stat.** It is the Bomberman's experience. Never render it in
  the stat row/boxes. It gets its own "experience strip": a full-width
  `panel2` bar, 1px `border`, with `EXPERIENCE` (Silkscreen, faint,
  letter-spaced) left and `N SP` (Press Start, `text` color) right. In hover
  popups it appears below a divider, same left/right arrangement.
- **Class colors**: Healster = green, Disguiser = gold, Attacker = red.
  Class name always renders in its class color.
- **Timer urgency ramp**: >15s remaining = neutral (`text` numerals, green
  segments) · ≤15s = `gold` · ≤5s = `red`. Applied to the countdown numeral
  AND the segment bar AND any urgency-promoted button simultaneously.
- **Level badge color ramp**: level 1–2 = green, 3–4 = gold, 5+ = red.

### 1.5 Interactive states

- Buttons are panels. Hover: border lightens (`border` → `borderHi`, or
  gold-filled → white border). Press: the whole button translates down 2px
  (no scale, no shadow). Disabled: 55% opacity.
- Link-style actions are Silkscreen `blue` text in brackets: `[ EQUIP ]`,
  `[ < MENU ]`, `[ EQUIP BOMBS — … ]`. Hover may lighten; no underline.
- Transient feedback (toasts): a small notched panel, bottom-center,
  Silkscreen 16px, auto-dismiss. No color coding on the toast itself.

### 1.6 Sprites

- All sprites render with `image-rendering: pixelated`; never smooth-scaled.
- **Character portrait boxes**: the char sprite sheet frame is ~97% transparent
  margin (figure ≈ 21×44px inside a 128px frame). Portraits therefore use a
  square `panel2` box with `overflow: hidden` and the sprite overscaled to
  ~2.45× the box size, nudged up ~5.6% of box height — so the FIGURE fills the
  box. Box sizes used: 302px (menu hero), 128px (upgrade), 76px (roster cards),
  62px (bombs-shop header), 50px (HUD chip), 46px (lobby crew slots).
- Bomb/treasure sprites at 16–30px, always paired with their count.

### 1.7 Level badge + hover popup

The level badge replaces all "Tier" UI. **Terminology: "Level"/"LV", never
"Tier."**

- Badge: circle, 2px border in the level-ramp color, level number in
  Press Start (same color), fill `bg`. Sizes 28–40px depending on context.
  Cursor: help.
- Hover popup (anchored above or below the badge, ~250px wide, `borderHi`
  border): 
  1. `NAME · LV n` (Silkscreen dim; LV n in ramp color)
  2. Class name (class color) + one-line class behavior in `dim`:
     - Healster — "Heals when still for 3 ticks"
     - Disguiser — "Disguises as a random object if still for 3 ticks"
     - Attacker — "Sets up ambush mode when still"
  3. divider (1px `border`)
  4. HP / CAP / STACK rows, color-coded
  5. divider
  6. `EXPERIENCE … N SP` row (the SP treatment from §1.4)

### 1.8 Screen chrome (shared by all full screens)

- Fixed 1600×980 design space, letterboxed on `#0d0a18`.
- Screen title block top-center (§1.2).
- **Wallet** top-right: a notched panel; coins in Press Start gold (`3162c`),
  treasure counts below in a Silkscreen row (gem sprite + count, `dim`).
- Footer: debug actions bottom-left in debug-red; `connected · <socket-id>`
  bottom-center in status-green; back-navigation `[ < MENU ]` bottom-left
  (Silkscreen `dim`) on sub-screens.

---

## 2. Main Menu — decisions

Composition: **one centered 760px column**; everything important lives in it.
Two stacked groups: the hero panel, then the action stack. No side columns.

### 2.1 Hero panel ("EQUIPPED")

The featured Bomberman is the centerpiece of the screen — it was explicitly
made big.

- Notched panel, 760px wide, tab label `EQUIPPED`, positioned directly under
  the title block (small gap — the screen should NOT have dead space between
  header and hero).
- Left: **302px square portrait box** (§1.6 crop technique) — the figure
  itself stands ~250px tall.
- Right column, top to bottom:
  - Name (Press Start 22px) with the **level badge (40px) right-aligned** on
    the same row; badge popup opens downward here.
  - Class line: class name in class color + an em-dash + the class behavior
    sentence in `faint` (Silkscreen 16px).
  - **Three stat boxes** in a row (HP / CAP / STACK): nested `panel2` notched
    boxes, equal flex width; label (Silkscreen 13px) and value (Press Start
    15px) both in the stat's color.
  - **Experience strip** (§1.4) full-width under the stat boxes.
  - Bottom row: `LOADOUT` label + bomb sprites (26px) each with its count
    beneath; `▸ UPGRADE` as a blue text action right-aligned on the same row.

### 2.2 Action stack

Hierarchy is deliberate: one primary, two secondary, one "different kind".

- **PLAY** — the only gold-filled element on the screen. Full 760px width,
  tall (~68px), Press Start 20px, letter-spaced. Disabled (55% opacity) when
  no Bomberman is equipped.
- **BOMBERMEN** and **BOMBS SHOP** — a two-up row of equal neutral panel
  buttons (Press Start 13px). They are siblings in importance; neither gets
  an accent.
- **TUTORIAL** — kept visually DIFFERENT on purpose (it's a fundamentally
  different function) but promoted to a real, noticeable button: full-width,
  **dashed** 2px border in a muted blue (`#36527a`, hover `blue`), `panel2`
  fill, no corner notches, laid out as a row: blue `?` glyph + blue `TUTORIAL`
  label left, `offline practice match` hint in `dim` right. Dashed + blue =
  "practice, not the real economy"; full-width = still discoverable.
- **FACTORY is gone.** Do not carry over any factory entry point, badge, or
  copy on this screen.

### 2.3 Empty state (no Bomberman owned)

Players start the game with no Bomberman; the hero panel must handle it:

- Tab label switches to `OPERATIVE`. Portrait box becomes a **dashed-border
  box** containing the character sprite as a pure-black silhouette at 30%
  opacity (`filter: brightness(0)`) — "what could be."
- Right side: `NO BOMBERMAN` (Press Start, `dim`), two lines of Silkscreen
  copy, and a gold **HIRE A BOMBERMAN** button leading to the Bomberman shop.
- PLAY disables; the BOMBERMEN button takes a gold border + gold label as a
  steer (the screen's gold focus moves from PLAY to hiring).

---

## 3. Lobby — decisions

Composition: title block, then a **single centered row of three match cards**
(the conveyor), an equip-bombs text link under it, then the roster row.
Wallet compact top-right; `[ < MENU ]` bottom-left.

### 3.1 Match cards (the conveyor)

- Fixed 380×392px notched panels, 30px gap, always 3 in the row.
- **Mode rides the top border as a tab label**: green for `Normal`, orange
  for any special mode (e.g. `NO BOTS OR SCAVS`). Map name inside as the
  heading (Press Start 15px). When the player has joined, a second
  right-aligned tab `JOINED ✓` (green) appears, and the card's whole border
  turns green.
- **Crew slots**: a row of 46px boxes under a `PLAYERS n/cap` label. Filled
  slot = nested notched box with a character portrait (the player's own slot
  gets a green border and shows THEIR equipped character); empty slot =
  dashed `border` box with a centered `·`.
- **Countdown**: the card's focal point. Press Start 30px, centered,
  urgency-ramped (§1.4).
- **Segment bar** under the countdown: 14 segments, 16×10px, 3px gap; filled
  proportionally to time remaining, in the urgency color (green when calm).
  This is the "conveyor position" readout — time made physical.
- **JOIN**: full-card-width button anchored at the card bottom. Neutral
  (`panel2` fill, `borderHi` border, hover-to-green border) while calm;
  **promotes to gold fill when the card goes urgent (red phase)** — the
  dying card becomes the loudest thing on screen, which matches the real
  decision pressure. When joined, it's replaced by **UNJOIN**: `panel2`
  fill with red border + red label (destructive styling, never filled red).
- **Conveyor motion**: departing cards slide left 90px + fade out (~450ms);
  arriving cards slide in from the right with the same easing. The row reads
  as a belt without any belt graphics.

### 3.2 Communicating Bomberman stats & bombs (without busy-ness)

This was the core lobby problem; the resolution:

- Each roster card carries a **level badge overlapping its top-right corner**
  (36px, popup opens upward). Stats, class behavior, and experience live in
  the badge's hover popup (§1.7) — NOT printed on the card. The card face
  stays calm.
- The card face shows only: 76px portrait, name (Press Start 12px),
  class (class color) `· LV n` (`faint`), and the **bomb loadout row** —
  each equipped bomb's sprite (22px) with its count beneath in `faint`.
- Equipped card gets a green border + green `EQUIPPED` text; the other cards
  get a blue `[ EQUIP ]` text action. Never two green-bordered roster cards.
- Above the roster: the equip-bombs entry stays a single bracketed blue text
  link (`[ EQUIP BOMBS — n IN STOCK · SPACE FOR m ]`) — intentionally NOT a
  panel button, to keep the match cards dominant.

---

## 4. Consistency notes for the remaining screens

These screens keep their existing approved layouts; they only adopt the system:

- **Bombs Shop**: three notched panels (`CATALOG` / `BOMBERMAN` / `STOCKPILE`)
  with tab labels; catalog tiles are nested `panel2` notched tiles with gold
  prices and small gold BUY buttons (disabled-dim when unaffordable); loadout
  slot rows are `panel2` rows with a thin gold/green fill bar (gold = partial,
  green = full); the Rock slot is a dashed row with `∞`. Selection highlights
  use green borders, swap targets blue.
- **Bomberman screen**: upgrade tracks are `panel2` rows with a **4px left
  border in the track's stat color**, tier pips in the same color, costs
  rendered per-currency (`SP n` blue / `n c` gold, the lacking one red).
  Shop cards show the level badge and class color; FREE state is green.
- **In-match HUD**: same tokens on near-black (`#0d0a18` bars over the
  world). Top bar: HP as red pips left, clock (Press Start) + blue UAV line
  center, keys + coins gold right. Bottom tray: notched 62px slots — Rock ∞
  first, then loadout with `n/stack` counts (gold partial / green full),
  slot-number badges, gold selection ring, Silkscreen name tooltip on hover.
  The HUD must never cover the playfield beyond these two bars.

### Do-not list (quick audit checklist)

- ❌ "Tier" anywhere → "Level" / "LV"
- ❌ SP inside a stat row/box → own experience strip / popup section
- ❌ Factory button/badge on the Main Menu
- ❌ Rounded corners (except level-badge circles), gradients, glows, emoji
- ❌ More than one gold-filled element per screen (urgency promotion excepted)
- ❌ Smooth-scaled sprites; always `image-rendering: pixelated`
- ❌ Stat colors used off-semantics (e.g. blue HP)
