# Polish Drinking Game

A browser version of the spiral board drinking game ("this game has never been finished").
Pure client-side — plain HTML, CSS and JavaScript. No build step, no dependencies, no
server code. English / German / Polish, and the board itself is swappable JSON.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup for the setup screen, board, controls and modals |
| `styles.css` | All styling (dark theme, responsive board) |
| `game.js` | Game logic + i18n plumbing (no board data) |
| `config/index.json` | List of board configurations offered in the setup dropdown |
| `config/classic.json` | The default 70-field spiral board (fields, positions, effects, text) |
| `config/ui.json` | All interface strings, per language |

## Run locally

The page loads its CSS, JS and the `config/*.json` files over HTTP, so open it through a
web server rather than `file://`:

```bash
python3 -m http.server 4173
```

Then visit <http://localhost:4173>.

## Host on GitHub Pages

1. Push `index.html`, `styles.css`, `game.js` and the `config/` folder to a repository
   (they must keep the same relative layout, or adjust the paths in `index.html` /
   `game.js`).
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch**.
3. Pick the branch and `/ (root)` folder, save.
4. The game is served at `https://<user>.github.io/<repo>/`.

Any other static host (Netlify, Cloudflare Pages, S3, nginx) works the same way — just
serve the files as-is.

## How the game works

- Add 2–8 players and their names, pick a **board** and a **language**, then **Start game**.
  Everyone begins on **START**.
- On your turn, press **Roll** (one d6). Your token moves that many fields.
- The field you land on shows its task. Do it, or drink instead, then press **Continue**.
- Fields showing only a big number (8, 18, 28, 38, 48, 58, 68 on the classic board) are
  safe — no task.
- **Fixed movement** tasks are applied automatically: "go to field 32", "back 2 fields",
  "to START", etc. The field you land on *after* an automatic move is **not** re-triggered
  (keeps the game from looping).
- **Dice-based movement** tasks ("roll 3 dice and go back that many") give you a roll
  button inside the popup.
- Choice fields ("drink 3 **or** back 4"), "send another player to field 6", "everyone
  back 1", "roll again" and "sit out a turn" are all handled in the popup / on the panel.
- You must land on **ZIEL** exactly. Overshoot and your turn is forfeited.
- First to land on ZIEL exactly wins.

## Themes

Pick a look from the **Theme** dropdown (setup screen, or the top bar mid-game):

| Theme | Look |
|-------|------|
| **Modern** | Dark UI, coloured fields (default) |
| **Original paper** | Black-on-white, thick grid lines, Arial — like the printout |
| **Wine & cheese** | Warm cream / wine-red palette with cheese, grapes, wine glass & bottle SVGs around the board (from the wine-and-cheese nights this game gets played at) |

Themes are pure CSS: `game.js` sets `data-theme="modern|paper|cheese"` on `<html>` and the
rules live at the bottom of `styles.css`. The chosen theme is saved (per browser) and can be
forced with `?theme=paper`. The wine & cheese decorations are inline SVG in `index.html`
(`#boardDeco`), shown only for that theme.

Each theme sets `--grid` (thin line between consecutive fields) and `--wall` (thick line
along the spiral's walls) alongside its palette — see *Reading the spiral* below.

## Reading the spiral

The path snakes inward, which is hard to follow on a plain grid. `markSpiralWalls()` walks
the field list and, for each of a cell's four edges, checks whether the neighbouring grid cell
is the **next or previous field on the path**. If it isn't (or there's no neighbour at all),
that edge gets a thick `--wall` border; edges you actually travel through stay a hairline
`--grid`. The result is a drawn corridor from START to ZIEL, the way the original printout uses
heavy rules. It's derived from the config at load time, so a custom board gets correct walls
for free.

## Controls during a game

- **Roll** — take your turn.
- <kbd>Enter</kbd> / <kbd>Space</kbd> — roll, and dismiss the field popup. Focus is moved to
  the relevant button automatically, so you can play a whole game one-handed without the
  mouse. On the setup screen, <kbd>Enter</kbd> in a name box starts the game.
- **🔊 / 🔇** (top bar) — toggle reading each field's task out loud.
- **Theme** and **Language** dropdowns (top bar) — switch at any time, mid-game included.
- **Reset** (top right) — choose *Restart (same players, back to START)* or *New game
  (back to the setup screen)*.

## Read fields out loud

The app can speak each field's task when you land on it, using the browser's built-in
**Web Speech API** (`speechSynthesis`) — no network calls, no API keys, no audio files.
Enable it with the checkbox on the setup screen or the speaker button in the top bar; the
🔊 button inside a field popup repeats the last text even when the toggle is off.

The utterance language follows the game language (`en-US` / `de-DE` / `pl-PL`) and the app
picks a matching installed voice when one exists, otherwise it hands the language tag to the
browser and lets it choose. Quality and availability of voices are entirely up to the
operating system and browser — desktop Chrome/Edge/Safari and both mobile platforms ship
voices for all three languages; a bare Linux install often ships none, in which case nothing
is spoken. Where the API is missing entirely, the controls hide themselves.

## Randomness

Dice rolls use `crypto.getRandomValues()` (the platform CSPRNG) rather than `Math.random()`.
Values `0–255` are drawn one byte at a time and any byte in the last, incomplete block of six
(`252–255`) is discarded and redrawn — *rejection sampling*, which keeps all six faces exactly
equally likely. Taking `byte % 6` without that step would make 1–4 slightly more likely than
5–6, since 256 isn't a multiple of 6. `Math.random()` is kept only as a fallback for browsers
without Web Crypto. See `randInt()` / `rollD6()` in `game.js`.

Every roll goes through `rollD6()`: the turn roll, the "roll N dice and move back" fields, and
the die-tumble animation.

## Saved state

The current game (players, positions, whose turn, skip/roll-again flags, winner, chosen
board, language, theme and read-aloud setting) is written to `localStorage` after every
action, so a refresh or accidental tab close drops you straight back into the game.
"New game" / reset clears it. Those same settings are also remembered for the setup screen.
Everything is per-browser and never leaves the device.

You can also force settings from the URL: `?config=classic.json`, `?lang=de`, `?theme=paper`,
`?speak=1`.

## Languages

`config/ui.json` holds every interface string under a language key (`en`, `de`, `pl`),
plus `languageNames` for the dropdown labels. `{name}`, `{roll}`, `{pos}`, `{n}`, `{by}`,
`{sum}`, `{rolls}` and `{label}` are placeholders filled in at runtime. Add a new language
by adding a key here **and** listing its code in a board config's `meta.languages`. Missing
keys fall back to English.

## Editing or adding a board

Board files live in `config/`. Each is self-contained:

```jsonc
{
  "meta": {
    "name": "Classic spiral",
    "languages": ["en", "de", "pl"],
    "defaultLanguage": "en",
    "gridCols": 9,
    "gridRows": 8,
    "winPos": 71               // index of ZIEL (last field)
  },
  "tiles": [
    { "n": "START", "c": 1, "r": 8 },
    { "n": 1, "c": 2, "r": 8,
      "text": { "en": "Everyone drinks.", "de": "Alle trinken.", "pl": "Wszyscy piją." } },
    { "n": 3, "c": 4, "r": 8, "text": { ... }, "fx": { "t": "move", "d": -2 } },
    { "n": "ZIEL", "c": 4, "r": 4 }
  ]
}
```

- `tiles` is in **path order**: index `0` = START, index `N` = field `N`, last index = ZIEL.
  `goto` / `sendOther` targets are these indices (`0` = START).
- `c` / `r` are 1-based grid column / row. `gridCols` × `gridRows` cells must exist and each
  `c,r` pair must be unique; consecutive fields should be grid-adjacent so the path reads
  as a spiral.
- `big: true` → safe field (no task). `clothing: true` → adds the "remove a piece of
  clothing" hint. `text` may be a plain string (same in every language) or a
  `{ lang: string }` object.

### Effect shapes (`fx`)

| `t` | fields | meaning |
|-----|--------|---------|
| `move` | `d` | move `d` fields (negative = back), applied automatically |
| `goto` | `to` | jump to field index `to`, automatically |
| `gotoPlayer` | `target` | jump to another player's field — `"closestToStart"` (default) or `"closestToZiel"` |
| `skip` | – | player sits out their next turn |
| `again` | – | player rolls again after this field |
| `allMove` | `d` | every player moves `d` fields |
| `diceBack` | `times` | popup button: roll `times` dice, move back the total |
| `choice` | `opts` | popup buttons; each `opt` is `{ "label": <text>, "fx": <fx or null> }` |
| `sendOther` | `to` | popup: pick another player, who jumps to field `to` |
| `combo` | `list` | run several of the above in order (used for "go to 28 **and** roll again") |

The field you land on after an automatic `move` / `goto` / `combo` is not re-evaluated.

### Registering a new board

Add an entry to `config/index.json`:

```json
{ "configs": [
  { "file": "classic.json", "name": "Classic spiral (70 fields)" },
  { "file": "my-board.json", "name": "My custom board" }
] }
```

It then appears in the **Board** dropdown on the setup screen.
