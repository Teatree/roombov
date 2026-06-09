# Mobile Version

> **Audience:** future Claude / any LLM (or human) who needs to understand how the
> mobile build differs from the desktop build before touching mobile code.
>
> **One-line summary:** Roombov has no native app — "mobile" means the **same
> browser build adapts** to a phone: forced landscape, camera-fit menus, a
> half-scale in-match HUD, and a touch control scheme that replaces mouse clicks.
> Everything mobile is gated so **desktop behaviour is unchanged**.

---

## 1. The mental model

- There is **one codebase and one build**. There is no separate mobile app, no
  separate entry point, no separate scenes. The same Phaser scenes render on both;
  mobile-specific branches are gated at runtime.
- The single gate is **`isMobileDevice()`** (`src/client/util/isMobile.ts`).
  Every mobile-only behaviour checks it. When it returns `false`, the code path is
  byte-for-byte the desktop path.
- **Orientation is always landscape.** Portrait is never supported or laid out —
  instead the player is asked to rotate (see §5).
- Design rule: a mobile change must be a **no-op on desktop**. If you add a mobile
  branch, make sure the `!isMobile` path is untouched.

### How `isMobileDevice()` decides
1. URL override first: `?mobile=1` / `?mobile=true` → forced mobile; `?mobile=0` /
   `?mobile=false` → forced desktop. (Used for Playwright + forcing on/off a touch
   laptop.)
2. Otherwise auto-detect: **touch capability AND `(pointer: coarse)`** must both
   hold (so a desktop touchscreen with a mouse stays on the desktop path).
3. Result is cached for the session. `__setMobileOverrideForTest(value)` overrides
   it in tests.

**To test the mobile build:** load any URL with `?mobile=1` (e.g.
`http://localhost:5173/?mobile=1`) in a narrow landscape window.

---

## 2. Differences from desktop — quick reference

| Area | Desktop | Mobile |
|---|---|---|
| Orientation | any | **landscape only**; portrait shows a "rotate" overlay (§5) |
| Canvas sizing | Phaser `Scale.RESIZE` to `#game` (`100vh`) | `#game` pinned to **`visualViewport`** px so the URL bar can't clip the bottom HUD (§4) |
| Menu/shop scaling | native size | scene **main-camera zoom** fits a fixed design box (`responsiveScene.ts`) |
| In-match HUD size | `hudScale = 1` | `hudScale = 0.5` — tray, icons, fonts, HP bar, loot panel all halved (§6) |
| Move/attack input | click tile to move; click slot then click tile to throw | **drag MOVE/ATTACK button onto map, release to commit**; **drag a bomb out of the tray** to throw that bomb; or **press-hold a tile** for an urgent move (§7) |
| Bomb selection | click a tray slot to arm (toggle) | tray is **always-armed** (`mobileArmedSlot`, Rock default); tap a slot to change it (§7) |
| Camera control | follows player; (no manual pan) | one-finger **drag pans**, two-finger **pinch zooms** (§7) |
| Confirm/Cancel | n/a | **none** — releasing the drag *is* the commit (§7) |
| Tutorial guide window | top-right | top-right (same on both since the mobile work) |

Everything else (game rules, server authority, rendering systems, scene flow) is
**identical** — mobile only changes input and layout, never gameplay logic.

---

## 3. File map (where mobile code lives)

| File | Responsibility |
|---|---|
| `src/client/util/isMobile.ts` | `isMobileDevice()` — the one gate. |
| `src/client/util/mobileViewport.ts` | `installMobileViewport(game)` — visualViewport sizing **and** the portrait rotate gate. Called once in `main.ts`. |
| `src/client/util/responsiveScene.ts` | `designViewport()` + `fitSceneToViewport()` — camera-zoom fit for menu/UI scenes (used on desktop too; no-op when the viewport already fits). |
| `src/client/systems/MobileControls.ts` | The entire in-match touch scheme. Pure input+presentation; mutates state only through `MobileHooks`. |
| `src/client/scenes/MatchScene.ts` | Owns `hudScale`/`slotSize`/`slotGap`, builds `MobileControls` via `buildMobileHooks()`, scales the loot panel, routes mobile taps. |

There is **no** `MobileScene` — mobile lives inside the normal scenes.

---

## 4. Viewport sizing (the URL-bar fix)

**Problem:** on phones the browser URL bar grows/shrinks dynamically. `100vh` (and
`window.innerHeight`) report the *layout* viewport, which includes the area behind
the URL bar — so a bottom-anchored HUD (bomb tray, MOVE/ATTACK buttons) renders
below the visible fold and gets clipped.

**Fix (`mobileViewport.ts`):** Phaser's `Scale.RESIZE` fits the canvas to its
parent (`#game`), so on every `visualViewport` `resize`/`scroll` (and window
`resize`/`orientationchange`) we **pin `#game` to `visualViewport`'s visible px**
and call `game.scale.resize(w, h)`. We cooperate with Phaser's parent-based RESIZE
rather than fight it. `index.html` uses `height: 100dvh` as the no-JS baseline.

- rAF-coalesced (one resize per frame).
- **Desktop:** `installMobileViewport` returns early — Phaser's own RESIZE handles
  it, nothing is pinned.

---

## 5. Portrait rotate gate

Built in `mobileViewport.ts` as a **DOM overlay** (not a Phaser scene) so it covers
the game uniformly regardless of active scene and works before the first scene
renders.

- Shown whenever `isMobileDevice()` **and** the visible viewport is portrait
  (`height > width`).
- Content: a CSS twisting-phone icon + "Please rotate your device" + a subtitle.
- While portrait, the canvas is **not** resized (it's hidden behind the cover).
- Styling/markup is injected inline (`#roombov-orientation`); there is no CSS file.

---

## 6. In-match HUD scaling (`hudScale`)

`MatchScene` sets `hudScale = isMobile ? 0.5 : 1` in `create()` and derives:

- `slotSize = round(SLOT_SIZE * hudScale)`, `slotGap = round(SLOT_GAP * hudScale)`
  — the bomb tray.
- `coinIconSize`, `keyIconSize` — top-right HUD column.
- `hpMetrics()` — the HP bar.
- A font floor helper `f(px) = max(9, round(px * hudScale))` keeps text legible.

**Consequences for anyone editing the HUD:**
- Use `this.slotSize` / `this.slotGap`, **never** the raw `SLOT_SIZE` / `SLOT_GAP`
  constants, anywhere the tray geometry matters (render, hit-test, tutorial rects).
- The **loot panel** (`renderLootPanel` / `hitTestLootPanel` / `getLootItemRect`)
  is scaled by `hudScale` so it reads as the same size as the loadout tray. Render
  and hit-test duplicate the layout math — **keep them in sync** if you touch
  either.
- `hudScale = 1` makes desktop byte-identical.

The **loot panel is left full-size only where noted** — current state: it IS
scaled (matches loadout). The persistent treasure wallet uses
`TreasureListWidget.rightAlignTo(rightEdgeX)` to sit flush against the right edge
(aligns by the real rendered extent, not the reserved text column).

---

## 7. In-match touch controls (`MobileControls.ts`)

This is the biggest divergence. On mobile, `MatchScene` instantiates
`MobileControls` and the desktop click-to-act path is gated behind `!isMobile`.

### Buttons
- Bottom-right: **`[MOVE]`** and **`[ATTACK]`** only. There is **no Confirm/Cancel**.
- They are **drag handles**, not toggles.

### Move / Attack = drag-and-hold
1. Press a button and, **in the same gesture**, drag onto the map.
2. The selector/indicator (and for ATTACK, the ghost AoE + dotted trajectory)
   **sticks to the finger**.
3. **Releasing commits** the action (a brief expanding-ring confirm flash plays on
   the target tile). Releasing without dragging far enough onto the map
   (`BTN_DRAG_THRESHOLD`) cancels.
- ATTACK throws whichever tray slot is **currently armed** (`mobileArmedSlot`).
- MOVE uses the same server-authoritative BFS path preview the desktop build uses.

### Urgent move = press-and-hold a tile
- Press and hold a finger on a map tile for `URGENT_HOLD_MS` → commits a **move**
  there (move only, not attack).
- A **radial hourglass** fills under the finger to telegraph the commit (drawn with
  two Graphics objects — backing disc/ring + progress arc — to avoid a Phaser
  rendering bug where mixing `strokeCircle`/`fillCircle` with path ops on one
  Graphics silently breaks).
- **Pan vs hold:** a one-finger map press starts ambiguous. If the finger travels
  past `URGENT_MOVE_TOLERANCE` it becomes a **camera pan** (pan origin is captured
  at press-down so the promotion is seamless). The tolerance is intentionally
  forgiving so a small twitch doesn't cancel the hold.

### Camera
- One-finger drag on empty map **pans**; two-finger **pinch zooms**; mouse wheel
  zooms (useful when testing `?mobile=1` on desktop).
- Panning/zooming sets a manual-camera override so the follow-camera stops fighting.

### Tray arming
- Exactly one tray slot is always armed (`mobileArmedSlot`, Rock = slot 0 default),
  shown with a persistent red border. Tap a slot to change it.
- Distinct from the desktop `selectedSlot` (which is only set transiently while
  aiming, so ghosts don't show when idle).

### Drag a bomb out of the tray = throw that bomb
- Press a **non-empty** tray slot (Rock slot 0 included) and, in the same gesture,
  drag onto the map → the gesture **promotes into the ATTACK drag** aiming that
  bomb (ghost + trajectory follow the finger); **releasing on the map commits**
  the throw.
- The press **arms the slot immediately** (identical end-state to a tap), but
  the throw only happens after the finger travels past `SLOT_DRAG_THRESHOLD`
  *and* is released off the tray — so **a plain tap can never throw**, and
  sliding a thumb across the tray (released over it) just arms.
- Gesture roles: `slotCandidate` (pressed, undecided) → `slotDrag` (promoted).
  Eligibility via the `hitTraySlot` hook: empty custom slots and presses while a
  loot swap is pending (`lootPendingSwap`) fall through to the plain tap path.

### Loot swap
- Tap a loot item, then tap an inventory slot to swap — same as PC. On mobile this
  is wired through `mobileHandleHudTap` → `executeLootSwap` when a swap is staged
  (`lootPendingSwap`).

### Tuning constants (top of `MobileControls.ts`)
| Constant | Value | Meaning |
|---|---|---|
| `URGENT_HOLD_MS` | 500 | hold duration to commit an urgent move |
| `URGENT_MOVE_TOLERANCE` | 22px | finger travel allowed before a hold becomes a pan |
| `BTN_DRAG_THRESHOLD` | 20px | drag distance for a button press to count as "on map" |
| `SLOT_DRAG_THRESHOLD` | 24px | finger travel before a tray-slot press promotes into a bomb drag (more forgiving than the button threshold — slots are half-scale, taps must stay taps) |
| `HOURGLASS_R` | 46px | hourglass radius (sized to read around a fingertip) |
| `FLASH_MS` | 260 | commit-confirmation flash duration |
| `BTN_W` / `BTN_H` | 82 / 42 | MOVE/ATTACK button size (≥42 stays a comfortable touch target) |

### The `MobileHooks` boundary
`MobileControls` is a **pure input+presentation layer**. It never reads or mutates
`MatchState` directly — every gameplay action goes through the `MobileHooks` bundle
built by `MatchScene.buildMobileHooks()` (`canAct`, `playerTile`, `computePath`,
`snapThrow`, `commitMove`, `commitAttack`, camera helpers, etc.). This keeps mobile
input using the **same server-authoritative** path/throw logic as desktop. If you
add a mobile action, add a hook — don't reach into the scene.

---

## 8. Menu / shop responsiveness (`responsiveScene.ts`)

Menus are authored at a comfortable desktop size and would overflow a short
landscape phone (~390px tall). Instead of reflowing every element, each scene lays
out in a fixed **design box** and lets the scene's **main camera zoom** scale the
whole box to fit.

- `designViewport(scene, DW, DH)` → `{ short, layoutW, layoutH }`. Use
  `layoutW`/`layoutH` (not `this.scale.*`) for **edge-anchored AND
  height/width-fraction** positions, so content lands inside the design box.
- `fitSceneToViewport(scene, DW, DH)` zooms the main camera to fit; **no-op
  (zoom 1) when the viewport already meets the design size**, so desktop is
  unchanged. Call it at the end of `create()` **and** on `scale.resize`.
- Wired into: `MainMenuScene`, `LobbyScene`, `BombermanShopScene`,
  `BombsShopScene`, `BombermanUpgradeScene`, `TutorialEndScene`.
- **`FactoryScene` opts out** — it has its own cover-fill layout; camera-fit would
  double-scale it.

**Gotchas:**
- The #1 bug source is leaving a `height * fraction` position on the live viewport
  height instead of `layoutH * fraction` — it misplaces content in the design box.
- Scenes with a background darker than the canvas bg (`#1a1a2e`) must
  `cameras.main.setBackgroundColor(...)` or the zoom-out reveals a lighter border.

---

## 9. Verification notes / known limitations

- **Playwright can't drive the touch gestures end-to-end.** Synthetic
  `PointerEvent`s don't reach Phaser's input manager (and the tutorial overlay
  intercepts), so drag/hold can't be tested via automated touch. Verify the
  *render* paths directly (e.g. call `mobileControls.drawHourglass(p)`), and test
  real gestures on a device or with the browser devtools touch emulation.
- `?mobile=1` + a narrow landscape window is the standard manual harness;
  `window.__game` exposes the Phaser game for scene navigation.
- Per-resolution checks: portrait gate (portrait viewport), shop no-overlap (a
  profile owning ≥1 Bomberman), HUD half-scale, and bottom HUD not clipped when the
  URL bar is visible.

---

## 10. Related docs / memory

- Architecture overview + mobile subsection: `CLAUDE.md` → "Mobile (responsive
  browser, not a native app)".
- This doc is the detailed reference; `CLAUDE.md` is the short pointer.
