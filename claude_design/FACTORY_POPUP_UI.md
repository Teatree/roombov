# Factory Production Popup — UI Specification

This document specifies the popup that opens when the player clicks one of the four factories on the **Factory** screen. The functionality (commissioning, queueing, producing, claiming) already exists per `NEW_META.md` — what's described here is how that functionality is **presented** to the player.

The accompanying `factory_popup_reference.html` is a visual reference of the target layout, dimensions, colors, and proportions. Open it in a browser to inspect the design. Do **not** use it as implementation code — the game is Phaser, not DOM. Use it only as a faithful visual target.

---

## 1. Context

- **Screen**: `FactoryScene` (or wherever the four factory machines are rendered against `factory_bg.png`).
- **Trigger**: player clicks one of the four factory machines.
- **Modality**: modal — a half-transparent dark overlay sits behind the popup; clicking the overlay or pressing `ESC` closes the popup. Only one popup is open at a time.
- **Implementation suggestion**: a `Phaser.GameObjects.Container` inside an overlay scene that's launched on top of `FactoryScene`. The same scene/container is reused for all four factories — the data binding switches based on which factory was clicked.

---

## 2. Outer chrome

| Property | Value |
|---|---|
| Popup width | 440 px |
| Popup height | Variable — grows with queue/storage. Min ~480, typical ~620 |
| Background | `#1a2530` (dark steel) |
| Border | 1 px `#324658` on all sides |
| Top accent | 3 px solid `#4ade80` (neon green strip across the top edge — ties popup to the factory's green tube lights) |
| Corner radius | 3 px (very subtle, pixel-art friendly) |
| Backdrop | Full-screen rect at `rgba(0,0,0,0.6)`, input-blocking, dismisses popup on click |

---

## 3. Section-by-section breakdown

The popup is composed of six stacked sections, in order from top:

1. Header
2. Description (flavor)
3. Schematic (bomb preview)
4. Commission row
5. Production queue
6. Storage

Each section is described in detail below.

### 3.1 Header

A 40 px tall row, padded `11px 14px`, with a 1 px `#2a3a48` border-bottom.

Three elements, laid out horizontally:

**Factory chip** (left)
- Text: `FACTORY {n}` where `n` is 1–4.
- Style: text `#94a3b8` on `#0e1820` background, 1 px `#324658` border, padding `3px 7px`, font 11 px / weight 500 / letter-spacing 0.08em.
- Purpose: instant disambiguation between the four factories.
- Static — no hover or click.

**Machine name** (middle, flex-grow)
- Text: the factory's unique nonsense name from config (e.g. `DISCOMBOBULATOR 2000`).
- Style: 15 px / weight 500 / letter-spacing 0.06em, color `#e2e8f0`.
- Static.

**Close button** (right)
- Size: 24 × 24 px.
- Style: transparent background, 1 px `#324658` border, `#94a3b8` X icon (use the game's existing close-icon asset, or a clean X glyph).
- Hover: border `#4ade80`, X turns white.
- Click: close popup.

### 3.2 Description (flavor)

A single-line italic caption directly under the header.

| Property | Value |
|---|---|
| Padding | `8px 14px` |
| Background | `#16212c` (slightly lighter than the popup body — sets it off as a banner) |
| Bottom border | 1 px `#2a3a48` |
| Font | 12 px italic, color `#94a3b8`, centered |
| Content | Per-factory description string from config |

Suggested copy per factory (boss-approved phrasing for Factory 1; adapt the others in the same style):

- Factory 1: *"Produces a random weak bomb each cycle."*
- Factory 2: *"Produces a random tactical bomb each cycle."*
- Factory 3: *"Produces a random utility bomb each cycle."*
- Factory 4: *"Produces a random super bomb each cycle."*

These are placeholders — actual copy is content-team's call. The point is: the player learns "this factory makes random bombs of category X" without opening any submenu.

### 3.3 Schematic (bomb preview)

The visual hero of the popup. A "blueprint" panel with the bomb-being-produced sitting on it.

| Property | Value |
|---|---|
| Container padding | `16px 14px 4px` (bottom padding intentionally tight) |
| Blueprint box size | 180 × 110 px, centered |
| Blueprint background | Solid `#0a3252` with a 14 px grid of `rgba(56,189,248,0.18)` lines (cyan, faint) |
| Blueprint border | 1 px `#1e4d75` |
| Bomb sprite | `bomb_suprise.png` for prototype, displayed ~56 px square, centered |
| Corner label | Text `SCHEMATIC · {n}` (n = factory number) in top-left, 9 px / color `#5ab4ed` / letter-spacing 0.1em |

The blueprint isn't decorative — it frames the bomb as "what this factory is planning to make," which is the correct mental model. When the boss eventually wants per-factory bomb illustrations, they replace `bomb_suprise.png` for that factory only; the blueprint stays.

### 3.4 Commission row

The action zone. Two elements side by side, padded `12px 14px 14px`, with 10 px gap.

#### Commission button (flex:1)

| Property | Value |
|---|---|
| Background | `#cbd5e1` (light steel) |
| Border | 1 px `#94a3b8`, plus border-bottom 3 px `#64748b` — gives a tactile "raised button" feel |
| Padding | `10px 12px` |
| Text color | `#0f172a` |
| Cursor | pointer (when enabled) |
| Layout | Two stacked centered lines |

Line 1 — action text:
- `COMMISSION +1`
- 13 px, weight 500, letter-spacing 0.08em.
- The `+1` is important: it signals "this adds one to the queue" without an extra UI element, addressing the boss's requirement that "more bombs can be added at any time."

Line 2 — cost chip:
- Background `#f1f5f9`, 1 px `#94a3b8` border, padding `2px 8px`, font 13 px / color `#0f172a`.
- Content: one icon-+-number pair per treasure cost, separated by ~6 px gaps.
  - Factory 1: 🍄 25
  - Factory 2: ☕ 10  🍄 25
  - Factory 3: 🍇 10  ☕ 15
  - Factory 4: 🏮 8  🍇 15  🍄 50
- Treasure icons are the **actual pixel sprites** from the existing treasure spritesheet, scaled to ~14 px display height. The light cost-chip background was chosen specifically because the colorful pixel-art treasure icons don't read against bright yellow or dark steel.

**Button states**

| State | Visual |
|---|---|
| Enabled | As described above |
| Hover | Background lightens to `#e2e8f0` |
| Pressed (active) | `scale(0.97)`, border-bottom shrinks from 3 px to 1 px |
| Disabled (can't afford) | Background `#475569`, text `#94a3b8`, cost chip's deficient numbers turn `#ef4444` |

**Click behavior**
- Enabled: deduct treasures from wallet, increment the factory's `queueTotal` and `pendingQueue`. If `activeBombStartedAt === null`, set it to `Date.now()` so production starts immediately.
- Disabled: brief horizontal shake animation on the button, red flash on the cost chip. No state change.

#### Cycle indicator (92 px fixed width)

| Property | Value |
|---|---|
| Background | `#0e1820` |
| Border | 1 px `#324658` |
| Padding | 6 px |
| Layout | Three stacked centered lines |

- Line 1: `CYCLE` — 11 px / `#94a3b8` / letter-spacing 0.08em.
- Line 2: `{m}:{ss}` (e.g. `5:00`) — 20 px / weight 500 / monospace / color `#4ade80`.
- Line 3: `per bomb` — 11 px / `#94a3b8`.

This is a **static display** of the factory's configured cycle time (5 / 10 / 20 / 30 min). It is **not** the live countdown — that lives in the Production Queue section. Showing it next to the cost lets the player make the value judgment at a glance: "25 mushrooms every 5 minutes."

### 3.5 Production Queue

Two parts: a section header row, then a queue display box.

#### Section header

A flex row, label left + status right, 11 px / `#94a3b8` / letter-spacing 0.1em.

- Left label: `▸ PRODUCTION QUEUE` in weight 500.
- Right status: `{done} / {total} done` in weight 500, color `#4ade80`.
  - `done` = bombs completed in the current queue session.
  - `total` = bombs commissioned in the current queue session.
  - "Session" resets when: the queue empties out (`done === total` AND no active bomb) AND the player commissions a new bomb. The new commission starts a fresh `0 / 1 done` counter.

#### Queue display box

| Property | Value |
|---|---|
| Background | `#0e1820` |
| Border | 1 px `#324658` |
| Padding | 10 px |
| Layout | Horizontal flex: active bomb \| progress \| queue dots |
| Gap | 10 px |

**Active bomb** (left)
- 36 × 36 px mini blueprint (same `#0a3252` bg, 8 px cyan grid, 1 px `#1e4d75` border).
- Bomb icon ~22 px centered.
- Visible only when `activeBombStartedAt !== null`.

**Progress** (middle, flex:1)
- A two-row stack:
  - **Bar**: 8 px tall, `#0a1218` background, 1 px `#1e2c38` border. Fill `#4ade80`, width = `((now − activeBombStartedAt) / cycleMs) × 100%`, clamped 0–100. Updates every frame.
  - **Sub-row**: 11 px, flex justify-between. Left: `⏱ {Xm Ys}` remaining in color `#cbd5e1`. Right: `bomb {current} of {total}` in `#94a3b8`.

**Queue dots** (right)
- One 22 × 22 px dashed-outline square per bomb in `pendingQueue` (i.e. bombs after the active one).
- Border: 1 px dashed `#4ade8055` (33% alpha).
- Contents: `?` glyph, 12 px / weight 500 / `#4ade80`.
- Wraps to a new row if more than ~4 dots are needed.

**Empty state** (no active bomb, no queue):
- Hide the Queue display box entirely.
- Section header still visible, showing `0 / 0 done`.

### 3.6 Storage

Two parts: a section header row, then a storage grid.

#### Section header

Flex row, label left + button right.

- Left label: `▸ STORAGE · {count} ready`
  - "STORAGE" portion: 11 px / `#94a3b8` / letter-spacing 0.1em / weight 500.
  - "{count} ready" portion: same size, color `#4ade80`, letter-spacing normal. Shows total bomb count across all storage slots.
- Right: `TAKE ALL` button.
  - Background transparent, 1 px `#64748b` border, color `#cbd5e1`, padding `3px 10px`, font 11 px / weight 500 / letter-spacing 0.08em.
  - Hover: border `#4ade80`, text white.
  - Disabled state (storage empty): border `#2a3a48`, text `#475569`, no hover.
  - Click: claim all bombs (move every entry in `storage[]` to the player's `bombStockpile`).

#### Storage grid

| Property | Value |
|---|---|
| Background | `#0e1820` |
| Border | 1 px `#324658` |
| Padding | 8 px |
| Grid | 6 columns, 6 px gap |
| Rows | At least 1 (6 slots minimum). Grows to additional rows of 6 as needed. |

**Filled slot** (a stored bomb type with `count > 0`):
- Background `#1a2530`, 1 px `#324658` border.
- Bomb sprite (the actual bomb type's pixel sprite) ~22 px centered.
- Count badge in bottom-right corner: `×{n}` at 11 px / `#4ade80` / weight 500.
- Hover: border `#4ade80`, slight `scale(1.05)`.
- Click: claim one bomb of that type — decrement `count`, add 1 to `bombStockpile[bombType]`. If `count` reaches 0, slot becomes empty.

**Empty slot** (placeholder):
- Background `#0a1218`, 1 px **dashed** `#2a3a48` border.
- No content, not interactive.

The dashed-vs-solid distinction is the same visual language used in the queue's `?` dots: **dashed = reserved space, nothing here yet**. Reusing this language is intentional.

---

## 4. State and data binding

The popup is fully driven by per-factory state stored on the player profile. The recommended shape:

```ts
type FactoryId = 'factory1' | 'factory2' | 'factory3' | 'factory4';

type FactoryRuntimeState = {
  // current queue session
  queueDone: number;                  // bombs completed in this session (display "X / Y done")
  queueTotal: number;                 // bombs commissioned in this session
  pendingQueue: number;               // bombs still waiting AFTER the active one
  activeBombStartedAt: number | null; // unix ms when current bomb started; null if idle

  // persistent storage
  storage: Array<{ bombType: BombType; count: number }>;
};

type PlayerProfile = {
  // ... existing fields ...
  factories: Record<FactoryId, FactoryRuntimeState>;
};
```

Invariant: `queueTotal === queueDone + (activeBombStartedAt !== null ? 1 : 0) + pendingQueue`.

### Catch-up on scene open / app resume

The production timer is wall-clock based — bombs continue producing while the player is offline. On `FactoryScene` boot/resume, for each factory, run this catch-up loop **before** rendering the popup if it's about to open:

```
while (activeBombStartedAt !== null && now - activeBombStartedAt >= cycleMs) {
  produceOneBomb(factoryId);  // rolls bombType, increments storage, queueDone++
  if (pendingQueue > 0) {
    pendingQueue--;
    activeBombStartedAt += cycleMs;
  } else {
    activeBombStartedAt = null;
    break;
  }
}
```

This ensures the player who left with "0 / 4 done" and returned 25 minutes later (Factory 1 at 5 min/bomb) sees "4 / 4 done" with all 4 bombs in storage.

### Live progress

While the popup is open, the active bomb's progress bar and remaining-time label must update every frame from `(Date.now() − activeBombStartedAt) / cycleMs`. When progress reaches 100%, run a single `produceOneBomb` step and advance state (see catch-up loop above) — then continue rendering the next bomb in the queue from 0%.

### Session reset semantics

When does `queueDone / queueTotal` reset to `0 / 0`?

- **Recommended rule**: reset happens on the next `COMMISSION` click that fires while the queue is fully complete (`queueDone === queueTotal` AND `activeBombStartedAt === null` AND `pendingQueue === 0`).
- Why: gives the player the satisfaction of seeing `3 / 3 done` linger on screen as a small "task complete" moment, then resets cleanly when they start a new batch.
- Alternative considered: never reset, keep counting forever. Rejected because long-term play makes the counter visually noisy ("142 / 144 done") without adding information.

---

## 5. Interactions cheat sheet

| Element | Action | Effect |
|---|---|---|
| Close button | Click | Close popup |
| Modal overlay (outside popup) | Click | Close popup |
| `ESC` key | Press | Close popup |
| Commission button (enabled) | Click | Deduct cost, enqueue 1 bomb |
| Commission button (disabled) | Click | Shake + red flash, no state change |
| Storage slot (filled) | Click | Claim 1 bomb of that type |
| Storage slot (empty) | Click | No-op |
| TAKE ALL (enabled) | Click | Claim all stored bombs at once |
| TAKE ALL (disabled, empty storage) | Click | No-op |

---

## 6. Animation / juice (low priority, polish pass)

- **Commission click**: button press animation (the `scale(0.97)` + border-bottom collapse) + a soft "thunk" SFX if available.
- **Insufficient funds**: 200 ms horizontal shake (±4 px) on the commission button, simultaneous 200 ms red flash on the deficient cost number(s).
- **Bomb completes**: progress bar pulses white for 1 frame, then the new bomb "pops into" storage via a 150 ms scale-in from 0 to 1.
- **Take all**: stored bombs fly off-screen toward wherever the bombs-stockpile UI lives, then storage clears. If no destination is visible, just fade them out over 200 ms.
- **Reveal animation**: per boss feedback, **no reveal moment** is wanted. The bomb just appears in storage. Don't add a roll/spin/flash on bomb identity.

---

## 7. Edge cases

- **Commission while a bomb is mid-cycle**: `pendingQueue` increments. The current cycle continues without restart. The new queue dot appears immediately to the right of any existing dots.
- **Clock skew / `activeBombStartedAt > now`**: treat progress as 0%. Don't show negative time.
- **Storage exceeds 6 types**: grid expands to a second row of 6 slots. (More than 12 unique types is currently impossible — there are 16 bomb types, but a single factory's probability table covers at most ~5.)
- **Multiple factories producing simultaneously**: each factory has its own `FactoryRuntimeState`. The popup only shows the state of the one the player clicked.
- **Popup open during production tick**: the popup must subscribe to or poll state changes; when `produceOneBomb` fires inside the popup's render loop, the storage section should update without needing to close+reopen.
- **Player commissions, then closes popup, then reopens**: state is fully persisted in `PlayerProfile.factories[factoryId]`. The popup re-renders from that state on open — no special handling needed.
- **Out of treasure mid-queue**: not a problem. Treasure is deducted at the moment of commission, not at the moment a bomb starts producing. If the player has 3 bombs in queue and 0 mushrooms, the queue still completes.

---

## 8. Phaser implementation notes

- **Containers**: each of the six sections is its own `Phaser.GameObjects.Container`, parented to a popup container. Makes layout updates and section-level show/hide trivial.
- **Backdrop**: `this.add.rectangle(0, 0, gameWidth, gameHeight, 0x000000, 0.6).setOrigin(0, 0).setInteractive()`. Attach a click handler that calls `closePopup()`.
- **Input blocking**: backdrop is interactive, so clicks on it don't fall through to `FactoryScene` below. Popup elements are rendered on top.
- **Borders and panels**: use `Phaser.GameObjects.Rectangle` with `setStrokeStyle()` for the various 1 px borders. For the blueprint grid, either pre-bake a 180×110 image asset, or generate it once with a `Phaser.GameObjects.Graphics` drawing lines, then convert to a texture with `generateTexture()` for reuse.
- **Text**: prefer bitmap fonts if the project has any — they render crisply at the small sizes used here (9–13 px). Otherwise `Phaser.GameObjects.Text` with `setResolution(window.devicePixelRatio || 2)` is acceptable.
- **Live timer**: in the popup's `update(time, delta)` method (or a tick handler subscribed when open), recompute the progress fraction and update the progress bar's width and the remaining-time label. Don't recreate text objects — mutate `text.text`.
- **Interactive zones**: use `setInteractive()` with `useHandCursor: true` on the close button, commission button, storage slots, and TAKE ALL button. Attach `pointerover` / `pointerout` for hover states (border swap).
- **Cost chip icons**: composed of an `Image` (treasure sprite from the existing spritesheet) + a `Text` ("25"), parented to a small `Container` per cost entry, then arranged horizontally inside the chip with a fixed gap.

---

## 9. Acceptance checklist

Before considering this popup done:

- [ ] Popup opens with the correct factory data when each of the 4 machines is clicked.
- [ ] Header chip shows the correct factory number (1–4).
- [ ] Description text matches the per-factory config string.
- [ ] Cost chip displays the correct treasure(s) and amounts for the factory.
- [ ] Cycle indicator displays the correct minutes:seconds for the factory (5:00 / 10:00 / 20:00 / 30:00).
- [ ] Commission button is disabled (and visually distinct) when the player can't afford the cost.
- [ ] Clicking Commission while affordable deducts treasures and starts/queues a bomb.
- [ ] Production queue header shows accurate `done / total` counts.
- [ ] Active bomb's progress bar updates in real-time.
- [ ] Queue dots match `pendingQueue` count.
- [ ] Bombs complete on time and appear in storage.
- [ ] Bombs produced while the player is offline are correctly counted on return (catch-up loop).
- [ ] Storage slot click claims one bomb at a time.
- [ ] TAKE ALL claims everything in one go.
- [ ] Storage grid shows 6 empty placeholder slots when storage is empty.
- [ ] Close button, overlay click, and ESC all close the popup.
- [ ] No more than one popup open at a time.
