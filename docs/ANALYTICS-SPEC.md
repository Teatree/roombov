# Roombov Analytics — Data Spec

This document describes every event the game will send to the analytics sheet, what the columns mean, and what the data actually looks like when it lands.

The analytics pipeline is: **server → Google Apps Script web app → Google Sheet**. Each event becomes one row in one of four tabs.

---

## Two shared concepts

Before the per-sheet specs, two IDs that show up everywhere:

- **`sessionId`** — generated once per Socket.IO connection (the server already has this as the socket id). All events from the same play-session share it. Useful for asking "what did this person do from page-load to page-close." Resets every time the player reloads the tab.
- **`visitId`** — generated when a player **enters** a screen, attached to both the `enter` and the matching `exit` row. Lets you pair the two events even if a player visits the same screen twice in one session.

Both are short opaque strings — you don't need to read them, only group by them.

---

## Sheet 1 — `MatchResults`

**Purpose:** one row per real player per match that ended (escape, death, or turn-limit timeout). Bots and Scavs are excluded.

**Fired when:** the match concludes and the server settles each player's profile (banks SP, adds treasures to stash, etc.). One row per participating real player.

### Columns

| Column | Meaning |
|---|---|
| `timestamp` | Filled in by Apps Script on receipt. |
| `ip` | Player's IP address. Empty string in tutorial / offline mode. |
| `sessionId` | This play session. |
| `matchId` | The match this row belongs to. Players in the same match share this. |
| `profileId` | Stable profile id from the JSON store. |
| `profileName` | Display name. |
| `bombermanName` | Which Bomberman they played. |
| `bombermanTier` | `free` / `paid` / `paid_expensive`. |
| `outcome` | `escaped` / `killed` / `timeout`. |
| `turnsAlive` | How many turns they survived. |
| `kills` | Confirmed kills (player Bombermen + Scavs combined). |
| `chestsOpened` | Chests they personally opened this match. |
| `spEarned` | SP banked into the Bomberman on escape. 0 if killed. |
| `treasuresGainedJson` | Stringified treasure haul, e.g. `{"mushrooms":12,"coffee":3}`. Empty `{}` if killed. |
| `bombsUsedJson` | Stringified bomb usage, e.g. `{"bomb":4,"flare":2}`. |
| `coinsAfter` | Profile coin balance after settlement. |
| `stashTotalAfter` | Total treasures across all types in stash after settlement. |

### Example rows

| timestamp | ip | sessionId | matchId | profileId | profileName | bombermanName | bombermanTier | outcome | turnsAlive | kills | chestsOpened | spEarned | treasuresGainedJson | bombsUsedJson | coinsAfter | stashTotalAfter |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-05-30 14:22:01 | 192.168.1.42 | s_aB3kQ | m_8821 | p_abc123 | AlexShadow | Vorlik the Bold | paid | escaped | 87 | 1 | 4 | 75 | `{"mushrooms":18,"coffee":4,"grapes":1}` | `{"bomb":3,"flare":1,"flash":1}` | 1845 | 142 |
| 2026-05-30 14:22:01 | 203.45.123.8 | s_xyZ12 | m_8821 | p_def456 | KaboomQueen | Splatface | free | killed | 54 | 0 | 2 | 0 | `{}` | `{"bomb":2,"banana":1}` | 320 | 67 |
| 2026-05-30 14:22:01 | 78.91.4.17 | s_pQr89 | m_8821 | p_ghi789 | mireille | DETONATRIX | paid_expensive | killed | 71 | 2 | 3 | 0 | `{}` | `{"bomb":1,"contact":1,"flash":2,"big_huge":1}` | 2100 | 89 |
| 2026-05-30 14:35:44 | 192.168.1.42 | s_aB3kQ | m_8822 | p_abc123 | AlexShadow | Vorlik the Bold | paid | timeout | 250 | 0 | 1 | 5 | `{}` | `{"flare":3}` | 1845 | 142 |

Notes worth seeing:
- The first three rows share `matchId=m_8821` — they were in the same match. AlexShadow escaped, the other two died.
- `spEarned` is 0 on death because the rule is "die and you lose all match-earned SP."
- The fourth row is AlexShadow's *next* match (same `sessionId`, new `matchId`). They timed out — survived all 250 turns but didn't escape, so no treasures banked.

---

## Sheet 2 — `ProfileSnapshots`

**Purpose:** a snapshot of the player's persistent state at a meaningful moment, so you can graph currency/stash growth over time.

**Fired when:** immediately after each `MatchResults` row for the same player. (We could fire on every profile save, but that creates a lot of noise — match-end is the natural cadence.)

### Columns

| Column | Meaning |
|---|---|
| `timestamp` | Filled in by Apps Script. |
| `ip` | Player IP. |
| `sessionId` | This play session. |
| `profileId` | Stable profile id. |
| `coins` | Current coin balance. |
| `treasuresJson` | Full stash, stringified, e.g. `{"mushrooms":89,"coffee":34,"grapes":12,"lanterns":3}`. |
| `bombStockpileTotal` | Sum of counts across all bomb types in stockpile. |
| `ownedBombermenCount` | How many Bombermen they own (cap is 5). |
| `totalMatchesPlayed` | Lifetime match count. New counter added to the profile. |

### Example rows

| timestamp | ip | sessionId | profileId | coins | treasuresJson | bombStockpileTotal | ownedBombermenCount | totalMatchesPlayed |
|---|---|---|---|---|---|---|---|---|
| 2026-05-30 14:22:01 | 192.168.1.42 | s_aB3kQ | p_abc123 | 1845 | `{"mushrooms":89,"coffee":34,"grapes":12,"lanterns":3,"fish":4}` | 27 | 3 | 14 |
| 2026-05-30 14:22:01 | 203.45.123.8 | s_xyZ12 | p_def456 | 320 | `{"mushrooms":45,"coffee":18,"grapes":4}` | 8 | 2 | 6 |
| 2026-05-30 14:35:44 | 192.168.1.42 | s_aB3kQ | p_abc123 | 1845 | `{"mushrooms":89,"coffee":34,"grapes":12,"lanterns":3,"fish":4}` | 27 | 3 | 15 |

Notes:
- AlexShadow's row at 14:35:44 shows the same coins/stash but `totalMatchesPlayed` ticked up — they played a match but timed out, so nothing was banked except the match count.
- The legacy `fish` treasure shows up because the profile has some banked from before the NEW_META cull — it's still in the stash even though chests no longer roll it.

---

## Sheet 3 — `ScreenEvents`

**Purpose:** track which menu screens players visit, how long they stay, and where they came from. Two rows per visit: one when they enter, one when they leave.

**Fired when:**
- `enter` — the moment a Phaser scene becomes active (after the previous scene's `shutdown`).
- `exit` — the moment a Phaser scene shuts down (on transition to another scene).

The match scene itself is **not** tracked here — `MatchResults` covers that. Tutorial is **not** tracked here — `TutorialEvents` covers that. The Tooltip and TutorialOverlay parallel scenes are also not tracked (they're overlays, not destinations).

**Tracked screens:** `MainMenu`, `Lobby`, `BombermanShop`, `BombsShop`, `Factory`, `BombermanUpgrade`, `Results`.

### Columns

| Column | Meaning |
|---|---|
| `timestamp` | Filled in by Apps Script. |
| `ip` | Player IP. |
| `sessionId` | This play session. |
| `visitId` | Pairs the `enter` row with its `exit` row. |
| `profileId` | Profile id. |
| `profileName` | Display name. |
| `screen` | Screen name (see list above). |
| `eventType` | `enter` or `exit`. |
| `previousScreen` | On `enter` only: the screen they came from (or `Boot` for first navigation). Empty on `exit`. |
| `durationMs` | On `exit` only: how long they stayed, in milliseconds. Empty on `enter`. |
| `coinsAtEvent` | Coin balance at the moment of the event. Useful for cross-referencing browsing behavior to wealth. |

### Example rows

| timestamp | ip | sessionId | visitId | profileId | profileName | screen | eventType | previousScreen | durationMs | coinsAtEvent |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-05-30 14:18:02 | 192.168.1.42 | s_aB3kQ | v_001 | p_abc123 | AlexShadow | MainMenu | enter | Boot |  | 1770 |
| 2026-05-30 14:18:24 | 192.168.1.42 | s_aB3kQ | v_001 | p_abc123 | AlexShadow | MainMenu | exit |  | 22104 | 1770 |
| 2026-05-30 14:18:24 | 192.168.1.42 | s_aB3kQ | v_002 | p_abc123 | AlexShadow | BombermanShop | enter | MainMenu |  | 1770 |
| 2026-05-30 14:19:48 | 192.168.1.42 | s_aB3kQ | v_002 | p_abc123 | AlexShadow | BombermanShop | exit |  | 84301 | 1320 |
| 2026-05-30 14:19:48 | 192.168.1.42 | s_aB3kQ | v_003 | p_abc123 | AlexShadow | BombsShop | enter | BombermanShop |  | 1320 |
| 2026-05-30 14:20:55 | 192.168.1.42 | s_aB3kQ | v_003 | p_abc123 | AlexShadow | BombsShop | exit |  | 66890 | 1145 |
| 2026-05-30 14:20:55 | 192.168.1.42 | s_aB3kQ | v_004 | p_abc123 | AlexShadow | MainMenu | enter | BombsShop |  | 1145 |
| 2026-05-30 14:21:09 | 192.168.1.42 | s_aB3kQ | v_004 | p_abc123 | AlexShadow | MainMenu | exit |  | 13980 | 1145 |
| 2026-05-30 14:21:09 | 192.168.1.42 | s_aB3kQ | v_005 | p_abc123 | AlexShadow | Lobby | enter | MainMenu |  | 1145 |

What this sequence tells you: AlexShadow loaded the game, sat on the main menu for 22 seconds, went into the Bomberman Shop for 84 seconds (spent 450 coins — went from 1770 → 1320), then Bombs Shop for 67 seconds (spent another 175), then back to the menu, then into the lobby. The matching `Lobby exit` row would land when they joined a match.

A few specific cases worth flagging:

- **The popup `BombermanUpgrade`** is a parallel scene over MainMenu or Results. The `enter` row will fire when the popup opens, the `exit` row when it closes. The `previousScreen` will be whichever scene it was launched over.
- **Crashed/closed sessions** leave a dangling `enter` with no matching `exit`. That's actually useful — you can spot "screens players ragequit on" by finding orphaned enters.
- **`previousScreen` for the very first navigation** is `Boot`. After that it should always be one of the tracked screens.

---

## Sheet 4 — `TutorialEvents`

**Purpose:** track tutorial engagement — how many start it, how many finish it, where in the tutorial they bail.

**Fired when:**
- `enter` — when the player clicks `[TUTORIAL]` from MainMenu and the scripted match starts.
- `exit` — when the tutorial ends, regardless of how. Three possible exit reasons:
  - `completed` — they reached the scripted end.
  - `skipped` — they used a "skip tutorial" affordance (if one exists; if not, this value won't occur).
  - `abandoned` — they navigated away mid-tutorial (back to menu, reloaded, etc.).

### Columns

| Column | Meaning |
|---|---|
| `timestamp` | Filled in by Apps Script. |
| `ip` | Player IP. |
| `sessionId` | This play session. |
| `tutorialRunId` | Pairs `enter` with its `exit`. |
| `profileId` | Profile id. |
| `profileName` | Display name. |
| `eventType` | `enter` or `exit`. |
| `exitReason` | On `exit` only: `completed` / `skipped` / `abandoned`. |
| `furthestStepReached` | On `exit` only: the id or index of the last tutorial beat the player reached. Lets you see *where* people drop off. |
| `durationMs` | On `exit` only: total time spent in tutorial, in milliseconds. |

### Example rows

| timestamp | ip | sessionId | tutorialRunId | profileId | profileName | eventType | exitReason | furthestStepReached | durationMs |
|---|---|---|---|---|---|---|---|---|---|
| 2026-05-30 09:14:22 | 78.91.4.17 | s_pQr89 | t_001 | p_ghi789 | mireille | enter |  |  |  |
| 2026-05-30 09:18:51 | 78.91.4.17 | s_pQr89 | t_001 | p_ghi789 | mireille | exit | completed | step_14_escape | 269033 |
| 2026-05-30 11:02:14 | 45.122.8.91 | s_dLk55 | t_002 | p_jkl000 | newbie_42 | enter |  |  |  |
| 2026-05-30 11:03:08 | 45.122.8.91 | s_dLk55 | t_002 | p_jkl000 | newbie_42 | exit | abandoned | step_3_first_bomb | 53901 |
| 2026-05-30 13:45:00 | 88.5.221.4 | s_mNb33 | t_003 | p_mno111 | curious_one | enter |  |  |  |

Notes:
- mireille finished the tutorial in ~4.5 minutes (`completed`, all the way to `step_14_escape`).
- newbie_42 bailed after 54 seconds, only got to the first bomb step — that's a drop-off signal worth knowing about.
- curious_one is mid-tutorial as of the data snapshot — they have an `enter` row but no `exit` yet. If they reload the tab, that row stays orphaned (counts as `abandoned` for analysis purposes).

---

## Useful cross-sheet queries

Once data is flowing, a few things you can answer by combining sheets:

- **"Is it just me testing?"** — Filter any sheet by `ip` and count distinct `profileId`s. Your home IP will have one profile; real players will have a mix.
- **"How many sessions never made it into a match?"** — `sessionId`s that appear in `ScreenEvents` but never in `MatchResults`.
- **"What's the tutorial completion rate?"** — Count `TutorialEvents` rows where `eventType=enter` vs. `eventType=exit AND exitReason=completed`.
- **"Where do tutorial dropouts happen?"** — Group `TutorialEvents` exits by `furthestStepReached`.
- **"Does time in the Bomberman shop correlate with first match outcome?"** — Join `ScreenEvents` (filter `screen=BombermanShop`) with the next `MatchResults` row for the same `sessionId`.
- **"How fast are players accumulating treasures?"** — Plot `ProfileSnapshots.treasuresJson` parsed values over `timestamp` per `profileId`.

---

## What we are deliberately NOT tracking

To keep this lean:

- **In-match events** (bomb placements, individual movements, chest opens) — `MatchResults` summarizes the match; we're not building a play-by-play log.
- **Mouse positions, click coordinates, scroll depth** — no need.
- **Anything from the Tooltip or TutorialOverlay overlay scenes** — they're not destinations.
- **Match scene as a tracked screen in `ScreenEvents`** — match data lives in `MatchResults`, no point duplicating.
- **Boot scene** — instantaneous, not interesting. It only shows up as `previousScreen=Boot` on the first real navigation.
- **Profile saves outside match end** — too noisy. If you later want per-purchase snapshots, we can add a "PurchaseEvents" sheet.
