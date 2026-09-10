"use strict";

/* ============================================================
   Polish Drinking Game – spiral board
   Pure client-side. No build step, no dependencies.

   The board itself is data: config/index.json lists the
   available board files, each board file (e.g. config/classic.json)
   holds the fields, their grid positions, effects and per-language
   text. Interface strings live in config/ui.json. Drop in another
   board file + add it to config/index.json to offer a new variant.
   ============================================================ */

const PLAYER_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231",
  "#911eb4", "#00b3b3", "#f032e6", "#9a6324",
];

const DIE_PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const STATE_KEY = "pdg-state-v1";
const PREFS_KEY = "pdg-prefs-v1";

/* ---------- Runtime ---------- */
let UI = null;              // parsed config/ui.json
let LANGS = {};             // code -> display name
let CONFIG_LIST = [];       // [{file, name}]
let CONFIG = null;          // active board config
let TILES = [];             // CONFIG.tiles, path order (index === position)
let WIN_POS = 0;            // last index (ZIEL)
let LAST_TILE = 0;          // WIN_POS - 1
let LANG = "en";

const THEME_IDS = ["modern", "paper", "cheese"];
let THEME = "modern";

const SPEECH_LANG = { en: "en-US", de: "de-DE", pl: "pl-PL" };
const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
let SPEAK = false;
let voicesCache = [];
let lastSpokenText = "";

/* One d6. Math.random() is already a good uniform generator (V8 uses
   xorshift128+), and scaling by 6 introduces no bias the way `% 6` on a byte
   would — so there is nothing to fix here for a dice game. */
const rollD6 = () => 1 + Math.floor(Math.random() * 6);

let state = null;
let busy = false;
let currentTilePos = null;  // field whose modal is open (for re-render on lang switch)

/* ---------- Element cache ---------- */
const el = (id) => document.getElementById(id);
const els = {};
const cellByPos = [];

/* ============================================================
   Boot
   ============================================================ */
document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  [
    "setupScreen", "gameScreen", "setupSubtitle", "loadError",
    "labelBoard", "configSelect", "labelLang", "langSelect",
    "labelTheme", "themeSelect", "labelSpeak", "speakField", "labelCount", "playerCount",
    "nameInputs", "startBtn", "howSummary", "rulesList",
    "turnInfo", "themeSelectTop", "langSelectTop", "speakBtn", "resetBtn",
    "board", "die", "rollBtn", "rollMsg", "playerPanel",
    "tileModal", "tileTitle", "replaySpeak", "tileTask", "tileNote", "tileEffect", "tileActions",
    "confirmModal", "confirmTitle", "confirmText", "confirmRestart", "confirmNew", "confirmCancel",
    "winModal", "winTitleH", "winText", "winFlavour", "winAgain", "winNew", "toast",
  ].forEach((id) => { els[id] = el(id); });

  // --- load config files ---
  try {
    UI = await fetchJSON("config/ui.json");
    LANGS = UI.languageNames || { en: "English" };
    CONFIG_LIST = (await fetchJSON("config/index.json")).configs || [];
    if (!CONFIG_LIST.length) throw new Error("no board configs listed");
  } catch (err) {
    console.error(err);
    showFatal();
    return;
  }

  const prefs = loadPrefs();
  const params = new URLSearchParams(location.search);
  const wantedFile =
    params.get("config") ||
    (prefs && prefs.configFile) ||
    CONFIG_LIST[0].file;
  const wantedLang = params.get("lang") || (prefs && prefs.lang) || null;

  THEME = normTheme(params.get("theme") || (prefs && prefs.theme) || "modern");
  applyTheme();

  SPEAK = (params.get("speak") === "1") || !!(prefs && prefs.speak);
  initTTS();

  buildConfigSelect();
  buildThemeSelects();
  try {
    await loadConfig(pickConfigFile(wantedFile), wantedLang);
  } catch (err) {
    console.error(err);
    showFatal();
    return;
  }

  buildPlayerCountOptions();
  wireEvents();

  // --- resume a saved game if there is one ---
  const saved = loadState();
  if (saved && Array.isArray(saved.players) && saved.players.length &&
      (saved.phase === "playing" || saved.phase === "won")) {
    if (saved.configFile && saved.configFile !== CONFIG.meta.file &&
        CONFIG_LIST.some((c) => c.file === saved.configFile)) {
      try { await loadConfig(saved.configFile, saved.lang); } catch (e) { /* keep current */ }
    }
    if (saved.lang && langSupported(saved.lang)) LANG = saved.lang;
    if (saved.theme) { THEME = normTheme(saved.theme); applyTheme(); }
    if (typeof saved.speak === "boolean") SPEAK = saved.speak;
    state = saved;
    applyLang();
    enterGame();
    if (state.phase === "won") showWin(state.winnerName);
  } else {
    applyLang();
  }
}

function showFatal() {
  els.loadError.textContent =
    (UI && UI.en && UI.en.loadError) ||
    "Could not load the config files. Serve this folder over HTTP (see README).";
  els.loadError.classList.remove("hidden");
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/* ============================================================
   Config / language loading
   ============================================================ */
function pickConfigFile(file) {
  return CONFIG_LIST.some((c) => c.file === file) ? file : CONFIG_LIST[0].file;
}

async function loadConfig(file, preferLang) {
  const cfg = await fetchJSON("config/" + file);
  cfg.meta = cfg.meta || {};
  cfg.meta.file = file;
  cfg.meta.languages = cfg.meta.languages && cfg.meta.languages.length
    ? cfg.meta.languages
    : ["en"];

  CONFIG = cfg;
  TILES = cfg.tiles;
  WIN_POS = cfg.meta.winPos != null ? cfg.meta.winPos : TILES.length - 1;
  LAST_TILE = WIN_POS - 1;

  // choose a language this board actually provides
  const want = preferLang || LANG || cfg.meta.defaultLanguage;
  LANG = langSupported(want) ? want : (cfg.meta.defaultLanguage || cfg.meta.languages[0]);

  buildLangSelects();
  buildBoard();
  els.configSelect.value = file;
}

function langSupported(code) {
  return !!CONFIG && CONFIG.meta.languages.indexOf(code) !== -1;
}

function buildConfigSelect() {
  els.configSelect.innerHTML = "";
  CONFIG_LIST.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.file;
    o.textContent = c.name || c.file;
    els.configSelect.appendChild(o);
  });
}

function buildLangSelects() {
  [els.langSelect, els.langSelectTop].forEach((sel) => {
    sel.innerHTML = "";
    CONFIG.meta.languages.forEach((code) => {
      const o = document.createElement("option");
      o.value = code;
      o.textContent = LANGS[code] || code;
      sel.appendChild(o);
    });
    sel.value = LANG;
  });
}

/* ============================================================
   Theme
   ============================================================ */
function normTheme(id) {
  return THEME_IDS.indexOf(id) !== -1 ? id : "modern";
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", THEME);
}

function buildThemeSelects() {
  [els.themeSelect, els.themeSelectTop].forEach((sel) => {
    sel.innerHTML = "";
    THEME_IDS.forEach((id) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = t("theme" + id.charAt(0).toUpperCase() + id.slice(1));
      sel.appendChild(o);
    });
    sel.value = THEME;
  });
}

/* ============================================================
   Text-to-speech (Web Speech API)
   ============================================================ */
function initTTS() {
  if (!ttsSupported) {
    els.speakBtn.classList.add("hidden");
    els.speakField.classList.add("hidden");
    els.replaySpeak.classList.add("hidden");
    return;
  }
  const load = () => { try { voicesCache = speechSynthesis.getVoices() || []; } catch (e) {} };
  load();
  try { speechSynthesis.addEventListener("voiceschanged", load); } catch (e) {}
}

function pickVoice(langTag) {
  const pfx = String(langTag).slice(0, 2).toLowerCase();
  return voicesCache.find((v) => v.lang && v.lang.toLowerCase().indexOf(pfx) === 0) || null;
}

function utter(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LANG[LANG] || "en-US";
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = 0.97;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

// Speak when a field opens (only if the toggle is on). Remembers the text so
// the in-modal replay button can repeat it regardless of the toggle.
function speakField(text) {
  lastSpokenText = text || "";
  if (SPEAK && ttsSupported && text) utter(text);
}

function replaySpeak() {
  if (ttsSupported && lastSpokenText) utter(lastSpokenText);
}

function setSpeak(on) {
  SPEAK = !!on;
  if (!SPEAK && ttsSupported) { try { speechSynthesis.cancel(); } catch (e) {} }
  savePrefs();
  if (state) { state.speak = SPEAK; saveState(); }
  applySpeakUI();
}

function applySpeakUI() {
  if (!ttsSupported) return;
  els.speakField.checked = SPEAK;
  els.speakBtn.setAttribute("aria-pressed", String(SPEAK));
  els.speakBtn.textContent = SPEAK ? "🔊" : "🔇";
  els.speakBtn.title = t("readAloud");
  els.labelSpeak.textContent = t("readAloud");
  els.replaySpeak.title = t("readAgain");
}

/* ============================================================
   i18n helpers
   ============================================================ */
function t(key, params) {
  const dict = (UI && UI[LANG]) || (UI && UI.en) || {};
  let s = dict[key];
  if (s == null) s = (UI && UI.en && UI.en[key] != null) ? UI.en[key] : key;
  if (params) {
    for (const k in params) s = s.split("{" + k + "}").join(params[k]);
  }
  return s;
}

// A field's text may be a plain string or {lang: string}
function fieldText(tile) {
  const tx = tile.text;
  if (tx == null) return "";
  if (typeof tx === "string") return tx;
  return tx[LANG] || tx[CONFIG.meta.defaultLanguage] || tx[Object.keys(tx)[0]] || "";
}
function labelText(label) {
  if (label == null) return "";
  if (typeof label === "string") return label;
  return label[LANG] || label[CONFIG.meta.defaultLanguage] || label[Object.keys(label)[0]] || "";
}

function applyLang() {
  document.documentElement.lang = LANG;

  els.setupSubtitle.innerHTML = t("subtitle");
  els.labelBoard.textContent = t("board");
  els.labelLang.textContent = t("language");
  els.labelTheme.textContent = t("theme");
  els.labelCount.textContent = t("numPlayers");
  els.startBtn.textContent = t("startGame");
  els.howSummary.textContent = t("howItWorks");
  els.resetBtn.textContent = t("reset");
  els.rollBtn.textContent = t("roll");

  els.confirmTitle.textContent = t("resetTitle");
  els.confirmText.textContent = t("resetText");
  els.confirmRestart.textContent = t("restartSame");
  els.confirmNew.textContent = t("newGame");
  els.confirmCancel.textContent = t("cancel");

  els.winTitleH.textContent = t("winTitle");
  els.winFlavour.textContent = t("winFlavour");
  els.winAgain.textContent = t("playAgain");
  els.winNew.textContent = t("winNew");

  const rules = (UI[LANG] && UI[LANG].rules) || UI.en.rules || [];
  els.rulesList.innerHTML = "";
  rules.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = r;
    els.rulesList.appendChild(li);
  });

  els.langSelect.value = LANG;
  els.langSelectTop.value = LANG;
  if (UI) buildThemeSelects();
  applySpeakUI();

  renderNameInputs();
  rebuildBoardText();

  if (state) {
    renderTokens();
    if (state.phase === "won") {
      els.winText.textContent = t("winText", { name: state.winnerName });
      els.rollMsg.textContent = t("wonReset", { name: state.winnerName });
    } else if (els.rollMsg.dataset.key) {
      els.rollMsg.textContent = t(els.rollMsg.dataset.key, JSON.parse(els.rollMsg.dataset.params || "{}"));
    }
  }

  if (currentTilePos != null && !els.tileModal.classList.contains("hidden")) {
    openTile(currentTilePos);
  }
}

// remember the last status message so it can be re-localised on language switch
function setRollMsg(key, params) {
  els.rollMsg.dataset.key = key;
  els.rollMsg.dataset.params = JSON.stringify(params || {});
  els.rollMsg.textContent = t(key, params);
}

/* ============================================================
   Setup screen
   ============================================================ */
function buildPlayerCountOptions() {
  els.playerCount.innerHTML = "";
  for (let i = 2; i <= 8; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    els.playerCount.appendChild(o);
  }
  els.playerCount.value = "4";
}

function renderNameInputs() {
  const count = Number(els.playerCount.value || 4);
  const existing = [...els.nameInputs.querySelectorAll("input")].map((i) => i.value);
  els.nameInputs.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "name-row";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = PLAYER_COLORS[i];

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 16;
    input.placeholder = t("playerN") + " " + (i + 1);
    input.value = existing[i] || "";

    row.appendChild(dot);
    row.appendChild(input);
    els.nameInputs.appendChild(row);
  }
}

function wireEvents() {
  els.playerCount.addEventListener("change", renderNameInputs);

  els.configSelect.addEventListener("change", async () => {
    try {
      await loadConfig(els.configSelect.value, LANG);
      savePrefs();
      applyLang();
    } catch (err) {
      console.error(err);
      showFatal();
    }
  });

  const onLangChange = (e) => {
    const code = e.target.value;
    if (!langSupported(code)) return;
    LANG = code;
    savePrefs();
    if (state) { state.lang = LANG; saveState(); }
    applyLang();
  };
  els.langSelect.addEventListener("change", onLangChange);
  els.langSelectTop.addEventListener("change", onLangChange);

  const onThemeChange = (e) => {
    THEME = normTheme(e.target.value);
    applyTheme();
    savePrefs();
    if (state) { state.theme = THEME; saveState(); }
    els.themeSelect.value = THEME;
    els.themeSelectTop.value = THEME;
  };
  els.themeSelect.addEventListener("change", onThemeChange);
  els.themeSelectTop.addEventListener("change", onThemeChange);

  els.speakField.addEventListener("change", (e) => setSpeak(e.target.checked));
  els.speakBtn.addEventListener("click", () => setSpeak(!SPEAK));
  els.replaySpeak.addEventListener("click", replaySpeak);

  els.startBtn.addEventListener("click", onStartGame);
  els.rollBtn.addEventListener("click", onRoll);

  els.resetBtn.addEventListener("click", () => show(els.confirmModal));
  els.confirmCancel.addEventListener("click", () => hide(els.confirmModal));
  els.confirmRestart.addEventListener("click", () => { hide(els.confirmModal); restartSamePlayers(); });
  els.confirmNew.addEventListener("click", () => { hide(els.confirmModal); toSetup(); });
  els.winAgain.addEventListener("click", () => { hide(els.winModal); restartSamePlayers(); });
  els.winNew.addEventListener("click", () => { hide(els.winModal); toSetup(); });

  document.addEventListener("keydown", onKey);
}

/* Enter / Space: roll on your turn, or dismiss the field popup. */
function onKey(e) {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const isEnter = e.key === "Enter";
  const isSpace = e.key === " " || e.key === "Spacebar";
  if (!isEnter && !isSpace) return;

  const target = e.target || document.body;
  const tag = (target.tagName || "").toLowerCase();

  // Setup screen: Enter from a name field starts the game.
  if (!els.setupScreen.classList.contains("hidden")) {
    if (isEnter && tag === "input" && target.type === "text") {
      e.preventDefault();
      onStartGame();
    }
    return;
  }

  // A focused button/select/input already handles these keys natively —
  // don't act again or we'd double-trigger.
  if (tag === "button" || tag === "select" || tag === "input" ||
      tag === "textarea" || target.isContentEditable) return;

  // Field popup open: trigger Continue, or a lone effect button (dice roll).
  if (!els.tileModal.classList.contains("hidden")) {
    e.preventDefault();
    const cont = els.tileActions.querySelector("button");
    if (cont) { cont.click(); return; }
    const fx = els.tileEffect.querySelectorAll("button");
    if (fx.length === 1) fx[0].click();
    return;
  }

  // Don't hijack keys while the reset / win dialogs are up.
  if (!els.confirmModal.classList.contains("hidden") ||
      !els.winModal.classList.contains("hidden")) return;

  // In-game: roll.
  if (!els.gameScreen.classList.contains("hidden")) {
    e.preventDefault(); // also suppresses Space page-scroll while busy
    if (!els.rollBtn.disabled) onRoll();
  }
}

function onStartGame() {
  const inputs = [...els.nameInputs.querySelectorAll("input")];
  const players = inputs.map((inp, i) => ({
    name: (inp.value.trim() || (t("playerN") + " " + (i + 1))).slice(0, 16),
    color: PLAYER_COLORS[i],
    pos: 0,
    skip: false,
  }));

  state = {
    phase: "playing",
    players,
    turn: 0,
    rollAgain: false,
    winnerName: null,
    configFile: CONFIG.meta.file,
    lang: LANG,
    theme: THEME,
    speak: SPEAK,
  };
  saveState();
  applyLang();
  enterGame();
}

/* ============================================================
   Board rendering
   ============================================================ */
function buildBoard() {
  const cols = CONFIG.meta.gridCols || 9;
  const rows = CONFIG.meta.gridRows || 8;
  els.board.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  els.board.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  els.board.style.aspectRatio = `${cols} / ${rows}`;
  els.board.innerHTML = "";
  cellByPos.length = 0;

  TILES.forEach((tile, pos) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.style.gridColumn = String(tile.c);
    cell.style.gridRow = String(tile.r);

    if (tile.n === "START") cell.classList.add("start");
    else if (pos === WIN_POS) cell.classList.add("ziel");
    else if (tile.big) cell.classList.add("big", "safe");
    else if (tile.clothing) cell.classList.add("clothing");

    const num = document.createElement("div");
    num.className = "num";
    cell.appendChild(num);

    const task = document.createElement("div");
    task.className = "task";
    cell.appendChild(task);

    const tokens = document.createElement("div");
    tokens.className = "tokens";
    cell.appendChild(tokens);

    els.board.appendChild(cell);
    cellByPos[pos] = cell;
  });

  markSpiralWalls();
  rebuildBoardText();
}

/* Thicken the cell edges that form the wall of the spiral corridor: an edge
   is a "wall" when the neighbouring grid cell is NOT the next/previous field
   on the path (or there is no neighbour, i.e. the outer frame). */
function markSpiralWalls() {
  const posByGrid = {};
  TILES.forEach((tile, pos) => { posByGrid[tile.c + "," + tile.r] = pos; });

  TILES.forEach((tile, pos) => {
    const cell = cellByPos[pos];
    const sides = [
      ["t", tile.c, tile.r - 1],
      ["r", tile.c + 1, tile.r],
      ["b", tile.c, tile.r + 1],
      ["l", tile.c - 1, tile.r],
    ];
    sides.forEach(([side, nc, nr]) => {
      const np = posByGrid[nc + "," + nr];
      if (np === undefined || Math.abs(np - pos) !== 1) cell.classList.add("wall-" + side);
    });
  });
}

// (re)fill the language-dependent text on every cell
function rebuildBoardText() {
  if (!cellByPos.length) return;
  TILES.forEach((tile, pos) => {
    const cell = cellByPos[pos];
    if (!cell) return;
    const num = cell.querySelector(".num");
    const task = cell.querySelector(".task");
    if (tile.n === "START") num.textContent = t("start");
    else if (pos === WIN_POS) num.textContent = t("ziel");
    else num.textContent = tile.n;
    task.textContent = tile.big ? "" : fieldText(tile);
  });
}

function renderTokens() {
  cellByPos.forEach((cell) => {
    cell.classList.remove("current");
    cell.querySelector(".tokens").innerHTML = "";
  });

  const tags = playerTags();
  state.players.forEach((p, i) => {
    const cell = cellByPos[p.pos];
    if (!cell) return;
    const tk = document.createElement("div");
    tk.className = "token" + (i === state.turn && state.phase === "playing" ? " active" : "");
    tk.style.background = p.color;
    tk.textContent = tags[i];
    tk.title = p.name;
    cell.querySelector(".tokens").appendChild(tk);
  });

  if (state.phase === "playing") {
    const c = cellByPos[state.players[state.turn].pos];
    if (c) c.classList.add("current");
  }

  renderPanel();
  renderTurnInfo();
}

/* Short labels for the board tokens. Everyone starts at their initials and
   any player still sharing a label grows it one letter at a time, so names
   stay recognisable: Ala/Anna -> "Al"/"An", Jan Kowalski/Jakub Kowal ->
   "Jan"/"Jak". Names that collide even at three letters (Ala/Alan) get the
   initial plus their number. */
function playerTags() {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  // progressively more specific labels for one player
  const formsFor = (p) => {
    const words = p.name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return ["?"];
    const compact = words.join("");
    const forms = [words.length > 1
      ? (words[0][0] + words[1][0]).toUpperCase()
      : words[0][0].toUpperCase()];
    for (let n = 2; n <= 3; n++) {
      if (compact.length >= n) forms.push(cap(compact.slice(0, n)));
    }
    return forms;
  };

  const forms = state.players.map(formsFor);
  const step = forms.map(() => 0);
  const labels = () => forms.map((f, i) => f[Math.min(step[i], f.length - 1)]);

  // grow only the labels that are still ambiguous, until nothing improves
  for (let pass = 0; pass < 4; pass++) {
    const cur = labels();
    const counts = cur.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
    let grew = false;
    cur.forEach((tag, i) => {
      if (counts[tag] > 1 && step[i] < forms[i].length - 1) { step[i]++; grew = true; }
    });
    if (!grew) break;
  }

  const final = labels();
  const counts = final.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
  return final.map((tag, i) => (counts[tag] > 1 ? tag.charAt(0) + (i + 1) : tag));
}

function renderPanel() {
  els.playerPanel.innerHTML = "";
  const tags = playerTags();
  state.players.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === state.turn && state.phase === "playing") li.classList.add("turn");

    // same marker as on the board, so the list maps onto the tokens at a glance
    const dot = document.createElement("span");
    dot.className = "dot dot-tag";
    dot.style.background = p.color;
    dot.textContent = tags[i];

    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = p.name;

    const meta = document.createElement("span");
    meta.className = "pmeta";
    meta.textContent = posLabel(p.pos);

    li.appendChild(dot);
    li.appendChild(name);
    if (p.skip) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = t("skipsNext");
      li.appendChild(b);
    }
    li.appendChild(meta);
    els.playerPanel.appendChild(li);
  });
}

function renderTurnInfo() {
  if (state.phase !== "playing") { els.turnInfo.innerHTML = "&nbsp;"; return; }
  const p = state.players[state.turn];
  els.turnInfo.innerHTML =
    `<span class="chip" style="background:${p.color}"></span>` + escapeText(t("turnOf", { name: p.name }));
}

/* ============================================================
   Turn flow
   ============================================================ */
function enterGame() {
  els.setupScreen.classList.add("hidden");
  els.gameScreen.classList.remove("hidden");
  clearDie();
  renderTokens();
  if (state.phase === "won") {
    els.rollMsg.textContent = t("wonReset", { name: state.winnerName });
    els.rollBtn.disabled = true;
  } else {
    setRollMsg("tapToStart");
    els.rollBtn.disabled = false;
    focusSoon(els.rollBtn);
  }
}

function onRoll() {
  if (busy || !state || state.phase !== "playing") return;
  busy = true;
  els.rollBtn.disabled = true;
  els.rollMsg.textContent = "";
  delete els.rollMsg.dataset.key;

  const finalRoll = rollD6();
  animateDie(finalRoll, () => applyRoll(finalRoll));
}

function applyRoll(roll) {
  const p = state.players[state.turn];
  const target = p.pos + roll;

  if (target > WIN_POS) {
    setRollMsg("overshoot", { name: p.name, roll, by: target - WIN_POS });
    saveState();
    endTurn(1100);
    return;
  }

  if (target === WIN_POS) {
    p.pos = WIN_POS;
    renderTokens();
    state.phase = "won";
    state.winnerName = p.name;
    saveState();
    showWin(p.name);
    busy = false;
    return;
  }

  p.pos = target;
  renderTokens();
  setRollMsg("rolledTo", { name: p.name, roll, pos: posLabel(target) });
  saveState();
  setTimeout(() => openTile(target), 420);
}

function endTurn(delay) {
  setTimeout(() => {
    const n = state.players.length;
    let guard = 0;
    while (guard < n * 2) {
      state.turn = (state.turn + 1) % n;
      guard++;
      const np = state.players[state.turn];
      if (np.skip) {
        np.skip = false;
        toast(t("sitsOut", { name: np.name }));
      } else {
        break;
      }
    }
    state.rollAgain = false;
    renderTokens();
    saveState();
    clearDie();
    els.rollBtn.disabled = false;
    busy = false;
    focusSoon(els.rollBtn);
  }, delay || 0);
}

/* ============================================================
   Field modal + effects
   ============================================================ */
function openTile(pos) {
  const tile = TILES[pos];
  currentTilePos = pos;

  els.tileTitle.textContent = pos === WIN_POS ? t("ziel") : t("fieldTitle", { n: tile.n });
  els.tileTask.textContent = tile.big ? t("safeField") : fieldText(tile);
  speakField(els.tileTask.textContent);

  if (tile.clothing) {
    els.tileNote.textContent = t("clothing");
    els.tileNote.classList.remove("hidden");
  } else {
    els.tileNote.classList.add("hidden");
  }

  els.tileEffect.innerHTML = "";
  els.tileActions.innerHTML = "";

  if (!tile.fx) addContinueButton();
  else buildEffectUI(tile.fx);

  show(els.tileModal);
}

function buildEffectUI(fx) {
  const p = state.players[state.turn];

  const finishNode = (node) => {
    els.tileEffect.innerHTML = "";
    els.tileEffect.appendChild(node);
    renderTokens();
    saveState();
    addContinueButton();
  };
  const finish = (msg) => {
    const p = document.createElement("p");
    p.className = "fx-result";
    p.textContent = msg;
    finishNode(p);
  };
  const moveMsg = (delta) =>
    (delta > 0 ? t("movedFwd", { n: delta, pos: posLabel(p.pos) })
               : t("movedBack", { n: -delta, pos: posLabel(p.pos) }));

  switch (fx.t) {
    case "move": {
      p.pos = clampTile(p.pos + fx.d);
      finish(moveMsg(fx.d));
      break;
    }
    case "goto": {
      p.pos = fx.to;
      finish(t("sentTo", { pos: posLabel(fx.to) }));
      break;
    }
    case "gotoPlayer": {
      const ref = closestOtherPlayer(fx.target);
      p.pos = clampTile(ref.pos);
      finish(t("sentToPlayer", { name: ref.name, pos: posLabel(p.pos) }));
      break;
    }
    case "skip": {
      p.skip = true;
      finish(t("willSkip", { name: p.name }));
      break;
    }
    case "again": {
      state.rollAgain = true;
      finish(t("rollsAgainAfter", { name: p.name }));
      break;
    }
    case "allMove": {
      state.players.forEach((pl) => { pl.pos = clampTile(pl.pos + fx.d); });
      finish(fx.d > 0 ? t("everyoneFwd", { n: fx.d }) : t("everyoneBack", { n: -fx.d }));
      break;
    }
    case "combo": {
      fx.list.forEach((step) => {
        if (step.t === "goto") p.pos = step.to;
        else if (step.t === "gotoPlayer") p.pos = clampTile(closestOtherPlayer(step.target).pos);
        else if (step.t === "move") p.pos = clampTile(p.pos + step.d);
        else if (step.t === "again") state.rollAgain = true;
        else if (step.t === "skip") p.skip = true;
        else if (step.t === "allMove") state.players.forEach((pl) => { pl.pos = clampTile(pl.pos + step.d); });
      });
      finish(state.rollAgain
        ? t("sentToAndAgain", { pos: posLabel(p.pos) })
        : t("sentTo", { pos: posLabel(p.pos) }));
      break;
    }
    case "diceBack": {
      const diceBtn = mkBtn(t("rollNDice", { n: fx.times }), () => {
        const rolls = [];
        let sum = 0;
        for (let i = 0; i < fx.times; i++) {
          const d = rollD6();
          rolls.push(d);
          sum += d;
        }
        p.pos = clampTile(p.pos - sum);
        finish(t("rolledBack", { rolls: rolls.join(" + "), sum, pos: posLabel(p.pos) }));
      });
      els.tileEffect.appendChild(diceBtn);
      focusSoon(diceBtn);
      break;
    }
    /* Everyone rolls a die; whoever matches drinks (and optionally moves). */
    case "allRoll": {
      const hits = (fx.drinkOn || []).map(Number);
      const btn = mkBtn(t("everyoneRolls"), () => {
        const results = state.players.map((pl) => ({ pl, roll: rollD6() }));
        const matched = results.filter((r) => hits.indexOf(r.roll) !== -1);

        if (fx.gotoOnMatch != null) {
          matched.forEach((r) => { r.pl.pos = clampTile(fx.gotoOnMatch); });
        }

        const box = document.createElement("div");
        box.className = "roll-results";
        results.forEach(({ pl, roll }) => {
          const hit = hits.indexOf(roll) !== -1;
          const row = document.createElement("div");
          row.className = "roll-row" + (hit ? " hit" : "");

          const who = document.createElement("span");
          who.className = "rr-name";
          who.textContent = pl.name;

          const val = document.createElement("span");
          val.className = "rr-die";
          val.style.background = pl.color;
          val.textContent = String(roll);

          const verdict = document.createElement("span");
          verdict.className = "rr-verdict";
          verdict.textContent = hit
            ? t("drinksLabel") + (fx.gotoOnMatch != null ? " → " + posLabel(fx.gotoOnMatch) : "")
            : "";

          row.appendChild(val);
          row.appendChild(who);
          row.appendChild(verdict);
          box.appendChild(row);
        });

        if (!matched.length) {
          const safe = document.createElement("p");
          safe.className = "fx-result";
          safe.textContent = t("nobodyMatched");
          box.appendChild(safe);
        }
        finishNode(box);
      });
      els.tileEffect.appendChild(btn);
      focusSoon(btn);
      break;
    }

    /* Roll one die and show it; the field text says who drinks. An optional
       `then` effect runs afterwards ("drink what you roll, then go to START"). */
    case "rollOne": {
      const btn = mkBtn(t("rollOneBtn"), () => {
        const d = rollD6();
        let msg = t("youRolled", { roll: d, parity: t(d % 2 === 0 ? "even" : "odd") });
        const step = fx.then;
        if (step) {
          if (step.t === "goto") {
            p.pos = clampTile(step.to);
            msg += " " + t("sentTo", { pos: posLabel(step.to) });
          } else if (step.t === "move") {
            p.pos = clampTile(p.pos + step.d);
            msg += " " + (step.d > 0
              ? t("movedFwd", { n: step.d, pos: posLabel(p.pos) })
              : t("movedBack", { n: -step.d, pos: posLabel(p.pos) }));
          } else if (step.t === "skip") {
            p.skip = true;
            msg += " " + t("willSkip", { name: p.name });
          } else if (step.t === "again") {
            state.rollAgain = true;
            msg += " " + t("rollsAgainAfter", { name: p.name });
          }
        }
        finish(msg);
      });
      els.tileEffect.appendChild(btn);
      focusSoon(btn);
      break;
    }

    /* Flip a coin and show it; the field text says who drinks. */
    case "coin": {
      const btn = mkBtn(t("flipCoin"), () => {
        finish(t("coinResult", { side: t(Math.random() < 0.5 ? "heads" : "tails") }));
      });
      els.tileEffect.appendChild(btn);
      focusSoon(btn);
      break;
    }

    case "choice": {
      fx.opts.forEach((opt) => {
        els.tileEffect.appendChild(mkBtn(labelText(opt.label), () => {
          if (opt.fx && opt.fx.t === "move") p.pos = clampTile(p.pos + opt.fx.d);
          else if (opt.fx && opt.fx.t === "goto") p.pos = opt.fx.to;
          finish(opt.fx
            ? t("chose", { label: labelText(opt.label), pos: posLabel(p.pos) })
            : t("choseNoMove", { label: labelText(opt.label) }));
        }));
      });
      break;
    }
    case "sendOther": {
      const info = document.createElement("p");
      info.className = "tile-note";
      info.textContent = t("pickPlayer", { pos: posLabel(fx.to) });
      els.tileEffect.appendChild(info);
      state.players.forEach((pl, i) => {
        if (i === state.turn) return;
        els.tileEffect.appendChild(mkBtn(pl.name, () => {
          pl.pos = fx.to;
          finish(t("playerSent", { name: pl.name, pos: posLabel(fx.to) }));
        }));
      });
      break;
    }
    default:
      addContinueButton();
  }
}

function addContinueButton() {
  els.tileActions.innerHTML = "";
  const btn = mkBtn(t("continue"), closeTile, "btn-primary");
  els.tileActions.appendChild(btn);
  focusSoon(btn);
}

// Move keyboard focus without yanking the page around on touch devices.
function focusSoon(node) {
  if (!node) return;
  setTimeout(() => { try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); } }, 0);
}

function closeTile() {
  hide(els.tileModal);
  currentTilePos = null;
  const rollAgain = state.rollAgain;
  state.rollAgain = false;
  renderTokens();

  if (rollAgain && state.phase === "playing") {
    setRollMsg("rollsAgain", { name: state.players[state.turn].name });
    clearDie();
    els.rollBtn.disabled = false;
    busy = false;
    saveState();
    focusSoon(els.rollBtn);
  } else {
    endTurn(0);
  }
}

/* ============================================================
   Win / reset
   ============================================================ */
function showWin(name) {
  els.winText.textContent = t("winText", { name });
  els.rollBtn.disabled = true;
  els.rollMsg.textContent = t("wonReset", { name });
  renderTokens();
  show(els.winModal);
}

function restartSamePlayers() {
  state.players.forEach((p) => { p.pos = 0; p.skip = false; });
  state.turn = 0;
  state.rollAgain = false;
  state.phase = "playing";
  state.winnerName = null;
  state.configFile = CONFIG.meta.file;
  state.lang = LANG;
  state.theme = THEME;
  state.speak = SPEAK;
  busy = false;
  saveState();
  enterGame();
}

function toSetup() {
  clearState();
  state = null;
  busy = false;
  currentTilePos = null;
  els.gameScreen.classList.add("hidden");
  els.setupScreen.classList.remove("hidden");
  applyLang();
}

/* ============================================================
   Die animation
   ============================================================ */
function setDieFace(face) {
  const pips = DIE_PIPS[face] || [];
  [...els.die.children].forEach((span, i) => {
    span.classList.toggle("on", pips.indexOf(i) !== -1);
  });
  els.die.classList.toggle("idle", !pips.length);
}

/* Blank the die whenever a fresh roll is pending, so the previous player's
   result is never left sitting there looking like the current player's. */
function clearDie() {
  setDieFace(0);
}

function animateDie(finalFace, done) {
  els.die.classList.add("rolling");
  let ticks = 0;
  const iv = setInterval(() => {
    setDieFace(rollD6()); // cosmetic tumble only
    ticks++;
    if (ticks >= 9) {
      clearInterval(iv);
      els.die.classList.remove("rolling");
      setDieFace(finalFace);
      setTimeout(done, 180);
    }
  }, 65);
}

/* ============================================================
   Helpers
   ============================================================ */
function clampTile(x) {
  return Math.max(0, Math.min(LAST_TILE, x));
}

// The other player nearest START (default) or nearest ZIEL (target: "closestToZiel").
function closestOtherPlayer(target) {
  const others = state.players.filter((_, i) => i !== state.turn);
  let ref = others[0];
  for (const o of others) {
    const better = target === "closestToZiel" ? o.pos > ref.pos : o.pos < ref.pos;
    if (better) ref = o;
  }
  return ref;
}

function posLabel(pos) {
  if (pos === 0) return t("start");
  if (pos === WIN_POS) return t("ziel");
  return t("posField", { n: pos });
}

function mkBtn(label, onClick, extraClass) {
  const b = document.createElement("button");
  b.className = "btn" + (extraClass ? " " + extraClass : "");
  b.textContent = label;
  b.addEventListener("click", onClick, { once: true });
  return b;
}

function show(node) { node.classList.remove("hidden"); }
function hide(node) { node.classList.add("hidden"); }

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  show(els.toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(els.toast), 2600);
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============================================================
   Persistence (localStorage)
   ============================================================ */
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.players) || !s.players.length) return null;
    return s;
  } catch (e) { return null; }
}
function clearState() {
  try { localStorage.removeItem(STATE_KEY); } catch (e) { /* ignore */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      configFile: CONFIG ? CONFIG.meta.file : null,
      lang: LANG,
      theme: THEME,
      speak: SPEAK,
    }));
  } catch (e) { /* ignore */ }
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "null"); }
  catch (e) { return null; }
}
