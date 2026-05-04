# Gambler Street — menu redesign + drawer-based bet flow

A spec for replacing the current Gambler Street menu and the popup-based "which
hand?" reveal with a single in-place flow that opens, runs, and dismisses
itself underneath the selected gambler.

This is a **client-only** change. Server contracts (`GamblerSlot`, `Gambler`,
`BetOutcome`, the `GamblerStreetEngine`, `GamblerStreetService`) are unchanged.
The `correctHand` derivation already lives on the server and we keep it.

---

## 1. Goal of the redesign

Two things are changing at once:

1. **The menu screen itself** gets a clearer "five-stalls-on-a-street" layout
   so the loop reads as a market and not a list of buttons.
2. **The bet → reveal flow** stops using a separate popup scene
   (`GamblerStreetPopupScene`). It now happens in a drawer that drops in below
   the row of stalls, runs through its three stages (bet → pick hand → reveal),
   then collapses on its own.

The popup scene is deleted as part of this change.

---

## 2. Use the existing visual language (do not adopt the mockup's colors)

The interactive mockup I sent uses a generic dark-wood/gold tavern palette
purely to communicate the **layout** and **interaction**. Do **not** copy those
hex values into the codebase.

Instead, use whatever color tokens, fonts, frame styles, and chrome the rest
of the game's scenes already use — `MainMenu`, `BombermanShop`, `BombsShop`,
`Match`, `Results`, etc. Read those scenes first and reuse:

- the same Phaser text styles (font family, sizes, fills) used elsewhere,
- the same panel / card backgrounds and border treatments,
- the same button component(s),
- the same coin icon, treasure icons (already in `TreasureListWidget`), and
  HUD chrome.

If a color or style decision isn't already established in the codebase, ask
before inventing one. The goal is **zero visual seams** between this scene
and the rest of the game. The mockup is a wireframe in costume — treat the
costume as throwaway.

---

## 3. Screen structure

```
┌──────────────────────────────────────────────────────────────┐
│  [‹ main menu]        Gambler Street            [coins] [stash] │
│  Five gamblers waiting. Will fortune favour you tonight?       │
│                                                                 │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                  │
│  │ awn. │ │ awn. │ │ cool │ │ awn. │ │ awn. │   ← row of 5     │
│  │ 👤  │ │ 👤  │ │ down │ │ 👤  │ │ 👤  │      stalls         │
│  │ name │ │ name │ │ 1:42 │ │ name │ │ name │                  │
│  │ ask  │ │ ask  │ │      │ │ ask  │ │ ask  │                  │
│  │ rew  │ │ rew  │ │      │ │ rew  │ │ rew  │                  │
│  │ ▰▰▰░ │ │ ▰▰░░ │ │      │ │ ▰▰▰▰ │ │ ▰░░░ │   ← lifespan bar │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                  │
│                                                                 │
│  (drawer slides in here when a stall is selected — see §4)     │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Top bar

Three regions, left → middle → right:

- **Left**: a back button to the main menu.
- **Middle**: the scene title (`Gambler Street`) and a one-line italic
  flavor sub-header.
- **Right**: a coin counter pill (`coin icon + profile.coins`) and the
  **stash / treasure indicator exactly as it is in the game today**. Do not
  redesign it, do not move it into a button-and-overlay, do not change its
  position or behavior. Whatever the current Gambler Street scene already
  shows for the player's treasure stash stays as-is — same widget, same
  spot, same interaction. The mockup's `stash` button is wireframe filler
  and should be ignored.

### 3.2 The row of five stalls

Always exactly 5 cells, one per `GamblerSlot` in order. Each cell renders
based on `slot.kind`:

#### `slot.kind === 'gambler'` — active stall

- A small awning strip across the top (decoration only — pick a treatment
  consistent with how `BombermanShop` cards present their headers).
- **Avatar**: see §6 — always the `tutorial_guy` sprite, tinted by gambler id.
- **Name**: `gambler.name`, single line, ellipsis on overflow.
- **Ask line**: `wants {treasureAmount} {treasureIcon}`.
- **Reward line**: `win {coinReward} {coinIcon}`.
- **Lifespan bar**: thin progress bar at the bottom, width =
  `(gambler.expiresAt - now) / (gambler.expiresAt - gambler.createdAt)`.
  Update it on the same timer the existing scene uses for clock refresh
  (no need for a per-frame tween — once a second is enough).
- **States**:
  - `idle` — default.
  - `hover` — slightly emphasized border / background, same affordance the
    other shop cards use on hover.
  - `selected` — strong border + a small "pin" / pointer at the bottom
    center of the card that visually anchors the drawer below it.
  - `dimmed` — when *another* stall is selected, this card drops to ~55%
    opacity but stays clickable. Clicking a dimmed stall switches the
    drawer's contents to that gambler **without closing the drawer**
    (see §4.4).

#### `slot.kind === 'cooldown'` — empty stall

- Same card frame, muted styling, no avatar, no awning detail.
- Centered hourglass-or-similar icon plus a label
  `next gambler in {mm:ss}` derived from `slot.readyAt - now`.
- Not clickable. Tooltip on hover is fine but optional.

---

## 4. The drawer — replacing `GamblerStreetPopupScene`

This is the main behavioral change. The popup scene goes away entirely. In
its place, a drawer is rendered as part of `GamblerStreetScene` itself,
positioned directly below the row of stalls.

### 4.1 Component lifecycle

The drawer is **not always present**. It exists only while a flow is in
progress.

```
hidden  ──(click stall)──►  open(stage='bet')
                                ├──(pick tier)──►  open(stage='hand')
                                │                       ├──(pick hand)──►  open(stage='reveal')
                                │                       │                       └──(done / auto-timeout)──►  hidden
                                │                       └──(close)──►  hidden
                                └──(close)──►  hidden
```

The drawer DOM/Phaser container is created on open and torn down on close.
**It must not linger** as a faded-out element or "available but hidden" panel.
After the reveal step finishes, the drawer slides up and is destroyed,
returning the screen to the plain row-of-stalls layout.

### 4.2 Three stages, one container

All three stages render inside the **same drawer container**. Only the inner
content swaps between stages — the container's slide-in animation plays
exactly once (when the drawer first opens), and stage→stage transitions are
quick crossfades of the inner content (~150ms). This avoids a jarring
relayout each time the player picks something.

#### Stage 1 — `bet`

Header: gambler name, sub-line `wants X {treasure} · pays Y coins on a win`,
and a close (✕) button on the right.

Body: two equally-sized option cards side by side.

- **Cheap bet** card
  - Cost: `{gambler.treasureAmount} {treasureIcon}`
  - Win chance: `50%`
  - Payout footer: `{coinReward} coins · 2 min cooldown after`
- **Premium bet** card
  - Cost: `{gambler.treasureAmount * 2} {treasureIcon}`
  - Win chance: `75%`
  - Payout footer: `{coinReward} coins · same prize, safer odds`

If the player can't afford a tier, that card disables (greyed out, not
clickable, tooltip explaining the shortfall). If they can't afford either
tier, both cards are disabled and a small help line appears below them.

Clicking an enabled card → emits a `place_bet` to the server with
`{ slotIndex, tier }` and immediately advances to stage `hand` optimistically.
If the server rejects, fall back to closing the drawer with an error toast
(reuse whatever toast pattern other scenes use).

#### Stage 2 — `hand`

Header: same as before, plus a sub-line confirming what was paid:
`paid {amount} {treasure} — which hand has the coins?`.

Body: two large hand silhouettes, one labeled `left hand`, one `right hand`.
The right hand is the left hand sprite mirrored. Clicking either commits
the player's pick (kept locally only — it's not sent to the server) and
advances to stage `reveal`.

The server's `place_bet` response will already have come back by now in
practice. If it hasn't, show a brief "rolling…" state on the chosen hand
and wait for it.

The `correctHand` field on `BetOutcome` is what drives the reveal —
**we don't recompute it on the client**. The existing derivation
(`won ? picked : otherHand`) stays exactly where it is on the server.

#### Stage 3 — `reveal`

The drawer's content becomes a horizontal split:

- **Left**: a frame showing the chosen hand opening. If win, it holds the
  coin icon. If loss, it's empty. Frame border picks up a success/danger
  semantic color from the existing palette.
- **Right**: result text.
  - Win: `Fortune smiles!` headline, body =
    `the {correctHand} hand held the prize. +{coinReward} coins added to
    your purse.`
  - Loss: `Empty hand` headline, body =
    `the prize was in the {correctHand} hand. you lost {paid} {treasure}.`
- A single `done` button below the result text.

Clicking `done` triggers close (§4.3). If the player doesn't click `done`,
the drawer auto-closes after a short delay (suggest **6 seconds**, but
check whether other scenes have an established auto-dismiss duration and
match it). The auto-close gives passive players a clean exit without
leaving a stale drawer hanging.

### 4.3 Closing the drawer

Closing is reached by:

- the close (✕) button in the header (any stage),
- pressing escape,
- clicking the `done` button on the reveal stage,
- the auto-dismiss timer on the reveal stage,
- clicking the currently-selected stall a second time.

Closing always:

1. Plays a slide-up + fade-out animation on the drawer (~200ms).
2. Destroys the drawer container.
3. Clears the `selected` state on the stalls (and the `dimmed` state on
   the others).
4. Refreshes the row from the latest server state — the slot the bet
   was placed on should now be in `cooldown` kind. The client should not
   pre-mutate this; wait for the server's `gambler_street_update` (or
   whatever event is already used to push state) and re-render.

### 4.4 Switching gamblers without closing

If the drawer is open in stage `bet` and the player clicks a *different*
active stall, the drawer stays open and just retargets:

- previously-selected stall returns to idle,
- newly-clicked stall becomes selected (with its pin pointing up),
- drawer re-renders with the new gambler's bet options.

This is only allowed in stage `bet`. Once the player has committed to a
tier (stage `hand` onward), the drawer is locked to that gambler until
the flow finishes or is closed.

---

## 5. State the scene needs to track

```ts
type DrawerStage = 'bet' | 'hand' | 'reveal';

interface DrawerState {
  slotIndex: number;          // which stall is active
  stage: DrawerStage;
  tier: BetTier | null;       // set when entering 'hand'
  pickedHand: 'left' | 'right' | null;  // set when entering 'reveal'
  outcome: BetOutcome | null; // set when entering 'reveal'
  autoDismissTimer: Phaser.Time.TimerEvent | null;
}
```

Plus the existing `gamblerStreet: GamblerStreetState` already coming from the
server. Nothing else is added to the profile or to persistent state.

---

## 6. Avatars — use `tutorial_guy`, not procedural art

The mockup draws avatars procedurally with SVG. **Don't do that in the actual
implementation.** Every gambler's avatar should render the existing
`tutorial_guy` image asset (the same one used in the tutorial overlay).

To keep the five gamblers distinguishable on screen, apply a per-gambler
Phaser `setTint` derived deterministically from `gambler.id` (any stable
hash → 24-bit RGB will do — see how Bombermen tints are generated in
`BombermanShopService` for a pattern that already exists). Use the same
saturated-pastel range that Bombermen use so they read as "characters" and
not as UI chrome.

No procedural body parts, no per-tier hat variations, nothing along those
lines. One sprite, one tint per id, that's the whole avatar treatment.

In cooldown cells, no avatar at all — just the `next gambler in mm:ss`
label.

---

## 7. What gets deleted

- `src/client/scenes/GamblerStreetPopupScene.ts` — gone. The reveal lives
  inside `GamblerStreetScene` now.
- Any scene-launch / scene-stop wiring that referenced
  `GamblerStreetPopupScene` (check `GamblerStreetScene` and any scene
  registry / boot file).
- Any confetti/popup-only assets that were only used by the popup scene
  (audit before removing — if the same asset is reused elsewhere, leave it).

What survives:

- `GamblerStreetEngine` — untouched.
- `GamblerStreetService` — untouched.
- `gambler-street.ts` config — untouched.
- `BetOutcome` shape and `correctHand` derivation — untouched.

---

## 8. Suggested implementation order

1. Read `MainMenu`, `BombermanShop`, `Results`, and the existing
   `GamblerStreetScene` to lock in the color tokens, font styles, button
   component, and panel chrome you'll reuse. Do this *before* writing any
   new visual code.
2. Rebuild the row-of-5-stalls layout in `GamblerStreetScene` using those
   reused styles. Wire up idle / hover / selected / dimmed / cooldown
   states. No drawer yet — clicking a stall should just mark it selected
   and log to the console.
3. Add the drawer container + slide-in animation. Render only the `bet`
   stage. Wire it to the existing `place_bet` socket emit.
4. Add the `hand` stage. Pure client-side transition.
5. Add the `reveal` stage, driven by the `BetOutcome` returned by the
   server. Confirm `correctHand` is being honored.
6. Add the close paths: ✕ button, escape, done button, auto-dismiss timer,
   click-selected-stall-again.
7. Add the switch-gamblers-while-in-bet-stage behavior.
8. Delete `GamblerStreetPopupScene.ts` and its scene registration. Run the
   game; verify nothing else referenced it.
9. Visual pass — sit the new screen next to the bomb shop and the results
   screen and make sure the chrome matches.

---

## 9. Acceptance checklist

- [ ] No new color or font tokens introduced; everything reuses what other
      scenes already use.
- [ ] Five stalls always render, in slot order, regardless of active vs
      cooldown mix.
- [ ] Cooldown stalls show a live `mm:ss` counter that ticks down.
- [ ] Active stalls show a lifespan bar that depletes over time.
- [ ] Avatars are `tutorial_guy` with a per-id deterministic tint. No
      procedural avatars anywhere.
- [ ] Clicking a stall opens the drawer underneath the row with a slide-in.
- [ ] Drawer goes through bet → hand → reveal in place, with stage swaps
      not retriggering the slide-in.
- [ ] Cheap and premium bet cards disable correctly when the player can't
      afford them.
- [ ] Reveal honors `BetOutcome.correctHand` from the server.
- [ ] On close (any path), the drawer animates out and is destroyed —
      no lingering hidden panel.
- [ ] Auto-dismiss fires on the reveal stage if the player walks away.
- [ ] `GamblerStreetPopupScene.ts` and its registration are removed.
- [ ] Switching to a different active gambler in stage `bet` retargets
      the drawer; switching is locked once a tier is chosen.
