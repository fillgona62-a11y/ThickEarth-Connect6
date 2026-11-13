/**
 * ThickEarth agent protocol.
 *
 * Prompt builders and strict parsers for the optional OpenAI-compatible LLM
 * integration described in docs/AI-INTEGRATION.md (LLM opponent seats, coach
 * report generation and coach chat).
 *
 * The rule set is Connect6 (六子棋): 19x19, black opens with one stone, every
 * later turn places two stones, six in a row wins. One model reply places ONE
 * stone, which is the same decision boundary as the referee's get_move(board).
 *
 * Design rules:
 *  - Pure ESM, browser/Node compatible, no network, no provider SDK, no deps
 *    beyond the in-repo rules engine.
 *  - Builders are deterministic: the same inputs always produce the same
 *    messages (no timestamps, no randomness).
 *  - Parsers never throw; they return null (or a fully validated object) and
 *    never trust the model. Every action is validated against the canonical
 *    legal point list, and every coach claim is validated against the replay.
 *  - Coach reports follow the exact `thick-earth-coach/v1` schema from
 *    docs/AI-INTEGRATION.md. The server stamps provider/model/generatedAt/usage/
 *    source metadata; the model only authors the content fields.
 *
 * Public surface is documented in docs/AGENT-PROMPTS.md.
 */

import {
  PHASES,
  createGame,
  applyAction,
  getLegalActions,
  formatCell,
  computeResult,
  stonesRemaining
} from "./rules.js";

export const AGENT_PROTOCOL_VERSION = "thick-earth-agent/v1";
export const COACH_REPORT_VERSION = "thick-earth-coach/v1";

/**
 * Contract limits (docs/AI-INTEGRATION.md §5 "Validation rules"). Lengths are
 * character counts after whitespace normalisation.
 */
export const COACH_LIMITS = Object.freeze({
  headline: 120,
  summary: 1200,
  title: 80,
  detail: 400,
  reason: 300,
  trainingItem: 200,
  moveReason: 200,
  chatMessage: 600,
  weaknessCells: 6,
  strengths: 4,
  weaknesses: 6,
  keyMistakes: 6,
  recommendations: 6,
  trainingPlan: 5,
  chatHistory: 8
});

/**
 * Connect6 has exactly one action type: placing a single stone. There is no
 * pass, no resignation and no capture, so anything else a model emits is
 * rejected rather than mapped onto something close.
 */
const ACTION_TYPES = Object.freeze(["place"]);
const SEVERITIES = Object.freeze(["high", "medium", "low"]);

/** Board marks: X for the black stones (seat 0), O for white (seat 1). */
const STONE_MARKS = Object.freeze(["X", "O"]);
const COLOR_MARKS = Object.freeze({ black: "X", white: "O" });

/* ------------------------------------------------------------------------- */
/* Generic helpers                                                           */
/* ------------------------------------------------------------------------- */

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalises model-authored text: unifies newlines, trims, optionally collapses
 * to a single line, and truncates to a contract limit (with an ellipsis).
 */
function cleanText(value, maxLength, options = {}) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\r\n?/g, "\n").trim();
  if (options.singleLine) {
    text = text.replace(/\s+/g, " ");
  } else {
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (typeof maxLength === "number" && maxLength > 1 && text.length > maxLength) {
    text = text.slice(0, maxLength - 1).trimEnd() + "\u2026";
  }
  return text;
}

function cleanToken(value, maxLength) {
  return cleanText(value, maxLength, { singleLine: true });
}

function normalizeLanguage(language) {
  if (typeof language !== "string") return "zh";
  const value = language.trim().toLowerCase();
  if (value.startsWith("en")) return "en";
  if (value.startsWith("zh") || value.startsWith("cn") || value.startsWith("ch")) return "zh";
  return "zh";
}

function languageInstruction(language) {
  return normalizeLanguage(language) === "en"
    ? "Write all human-readable strings in English."
    : "Use Simplified Chinese (简体中文) for all human-readable strings. Keep board notation (A1..S19) and JSON keys untranslated.";
}

function seatLabel(seat) {
  return "P" + (seat + 1);
}

/** Connect6 is strictly two-player; anything else is a caller bug, not a variant. */
function resolvePlayerCount() {
  return 2;
}

function boardSize(state) {
  const size = Number(state && state.boardSize);
  if (Number.isInteger(size) && size >= 9 && size <= 25) return size;
  return 19;
}

function safeLegalActions(state) {
  try {
    return getLegalActions(state) || [];
  } catch (error) {
    return [];
  }
}

/* ------------------------------------------------------------------------- */
/* Actions and board rendering                                               */
/* ------------------------------------------------------------------------- */

/** Canonical { type: "place", x, y } or null. */
function canonicalAction(action) {
  if (!isObject(action)) return null;
  if (!ACTION_TYPES.includes(action.type)) return null;
  if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) return null;
  return { type: action.type, x: action.x, y: action.y };
}

function sameAction(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.x === b.x && a.y === b.y;
}

function normalizeLegalActionList(actions, state) {
  const source = Array.isArray(actions) && actions.length > 0 ? actions : safeLegalActions(state);
  const out = [];
  for (const action of source) {
    const canonical = canonicalAction(action);
    if (canonical) out.push(canonical);
  }
  return out;
}

/** Canonical engine notation for one stone, e.g. "D4". */
export function actionNotation(state, action) {
  const canonical = canonicalAction(action);
  if (!canonical) return "";
  return formatCell(state, canonical.x, canonical.y);
}

function entryNotation(state, entry) {
  if (!isObject(entry)) return "";
  const point = Array.isArray(entry.points) && entry.points.length === 1
    ? entry.points[0]
    : { x: entry.x, y: entry.y };
  if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) return "";
  return formatCell(state, point.x, point.y);
}

/**
 * Parses a model-authored move string ("place D4", "D4", "d4.") into
 * { type: "place"|null, cell }. Used by both parsers so the model may quote
 * moves as bare coordinates.
 */
function parseActionText(text) {
  if (typeof text !== "string") return null;
  const value = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.。]$/, "");
  if (!value) return null;
  let match = /^(?:place\s+)?([a-s])(\d{1,2})$/.exec(value);
  if (match) return { type: "place", cell: (match[1] + match[2]).toUpperCase() };
  match = /^([a-s])(\d{1,2})$/.exec(value);
  if (match) return { type: null, cell: (match[1] + match[2]).toUpperCase() };
  return null;
}

function cellNotation(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 24) return null;
  return String.fromCharCode(65 + x) + (y + 1);
}

function cellOfAction(action) {
  if (!action) return null;
  return cellNotation(action.x, action.y);
}

/** Finds the canonical legal action that a parsed string refers to. */
function resolveTextToLegalAction(parsed, legalActions) {
  if (!parsed || !parsed.cell) return null;
  const matches = legalActions.filter((action) => cellOfAction(action) === parsed.cell);
  return matches.length === 1 ? matches[0] : null;
}

/** Finds the canonical legal action for a JSON object candidate. */
function resolveObjectToLegalAction(candidate, legalActions) {
  if (!isObject(candidate)) return null;
  if (Number.isInteger(candidate.x) && Number.isInteger(candidate.y)) {
    const matches = legalActions.filter((action) => action.x === candidate.x && action.y === candidate.y);
    return matches.length === 1 ? matches[0] : null;
  }
  // Tolerate a bare cell string in the x field: {"x":"D4"} or {"cell":"D4"}.
  const cellText = typeof candidate.x === "string" ? candidate.x : candidate.cell;
  if (typeof cellText === "string") {
    return resolveTextToLegalAction(parseActionText(cellText), legalActions);
  }
  return null;
}

function playerLine(state, seat) {
  const players = Array.isArray(state.players) ? state.players : [];
  const player = players[seat];
  if (!player) return seatLabel(seat);
  const parts = [seatLabel(seat)];
  if (isNonEmptyString(player.name)) parts.push(player.name);
  if (isNonEmptyString(player.color)) parts.push("(" + player.color + ")");
  const count = Number.isInteger(player.stones) ? player.stones : 0;
  parts.push(count === 1 ? "1 stone" : count + " stones");
  return parts.join(" ");
}

function stoneMark(state, seat) {
  const player = (state.players || [])[seat] || {};
  if (isNonEmptyString(player.color) && COLOR_MARKS[player.color]) return COLOR_MARKS[player.color];
  return STONE_MARKS[seat] || "?";
}

/**
 * Fixed-width board dump. Rows are numbered downwards from the top edge, exactly
 * like the notation, so a model can read a coordinate straight off the picture.
 */
function renderBoard(state) {
  const size = boardSize(state);
  const columns = [];
  for (let x = 0; x < size; x += 1) columns.push(String.fromCharCode(65 + x));
  const lines = [];
  lines.push("    " + columns.join(" "));
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const seat = Array.isArray(state.cells) ? state.cells[index] : null;
      row.push(seat === null || seat === undefined ? "." : stoneMark(state, seat));
    }
    lines.push(String(y + 1).padStart(2, " ") + "  " + row.join(" "));
  }
  const legend = [];
  for (let seat = 0; seat < 2; seat += 1) {
    const player = (state.players || [])[seat] || {};
    legend.push(stoneMark(state, seat) + "=" + seatLabel(seat) + " " + (player.name || "player")
      + " (" + (player.color || (seat === 0 ? "black" : "white")) + ")");
  }
  lines.push("Legend: " + legend.join("; ") + "; .=empty");
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- */
/* JSON extraction                                                           */
/* ------------------------------------------------------------------------- */

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, value: undefined };
  }
}

function stripFences(text) {
  const match = /```(?:json|JSON|js)?\s*([\s\S]*?)```/.exec(text);
  return match ? match[1].trim() : text;
}

/** Conservative repairs for common model JSON glitches. */
function repairJson(text) {
  let value = text.trim();
  // Remove trailing commas before a closing brace/bracket.
  value = value.replace(/,(\s*[}\]])/g, "$1");
  // Normalise full-width quotes/brackets that occasionally leak in.
  value = value
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\uff5b\uff5d]/g, (match) => (match === "｛" ? "{" : "}"))
    .replace(/[\uff3b\uff3d]/g, (match) => (match === "［" ? "[" : "]"));
  return value;
}

/** Returns every balanced {...} / [...] candidate substring, outermost first. */
function findJsonCandidates(text) {
  const candidates = [];
  const openers = ["{", "["];
  const closers = { "{": "}", "[": "]" };
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (!openers.includes(opener)) continue;
    const stack = [closers[opener]];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (openers.includes(char)) {
        stack.push(closers[char]);
        continue;
      }
      if (closers[opener] === char || stack[stack.length - 1] === char) {
        if (char === stack[stack.length - 1]) stack.pop();
        if (stack.length === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
    if (candidates.length >= 40) break;
  }
  return candidates;
}

/**
 * Extracts the first JSON value from a model response.
 * Handles plain JSON, fenced code blocks, prose around JSON, nested braces
 * inside strings and a few common structural glitches (trailing commas,
 * full-width quotes). Returns the parsed value or null.
 */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  let source = text.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!source) return null;
  source = stripFences(source);
  const direct = tryParseJson(source);
  if (direct.ok) return direct.value;
  for (const candidate of findJsonCandidates(source)) {
    const parsed = tryParseJson(candidate);
    if (parsed.ok) return parsed.value;
    const repaired = tryParseJson(repairJson(candidate));
    if (repaired.ok) return repaired.value;
  }
  return null;
}


/* ------------------------------------------------------------------------- */
/* LLM opponent move prompt and response parser                              */
/* ------------------------------------------------------------------------- */

function unwrapState(input) {
  if (!input || typeof input !== "object") return null;
  if (Array.isArray(input.cells) && Array.isArray(input.players) && Number.isInteger(input.boardSize)) return input;
  if (input.state && Array.isArray(input.state.cells)) return input.state;
  return null;
}

function moveSystemPrompt(state, options) {
  const seat = options.seat;
  const players = Array.isArray(state.players) ? state.players : [];
  const player = players[seat] || {};
  const size = boardSize(state);
  const winLength = Number.isInteger(state.winLength) ? state.winLength : 6;
  const stonesOwed = Number.isInteger(options.stonesRemaining) ? options.stonesRemaining : 2;
  const multi = options.multiStone === true;
  const lines = [
    "You are a strong Connect6 (六子棋) player controlling exactly one seat. Connect6 is a perfect-information placing game for two players; there is no randomness, no hidden information, no capture and no forbidden move.",
    "",
    "RULES SUMMARY",
    "- The board is " + size + "x" + size + ". Columns are labelled A-"
      + String.fromCharCode(65 + size - 1) + " left to right and rows 1-" + size
      + " top to bottom. Cell notation is the column letter followed by the row number (for example K10).",
    "- Black (P1) moves first and places ONE stone on the opening turn. Every later turn, the player on the move places TWO stones, one after the other.",
    "- The first player to line up " + winLength + " or more stones in an unbroken row horizontally, vertically or diagonally wins. Longer runs also win.",
    "- There is no pass and no resignation. If the board fills up with no line of " + winLength + ", the game is a draw.",
    "",
    "STRATEGY THAT ACTUALLY WINS",
    "- A single threat is worthless: the opponent answers it with the first of their two stones. Build DOUBLE threats — two separate lines that both need answering — because one turn cannot cover both.",
    "- Before anything else, check (a) whether one of your own lines of " + (winLength - 1) + " can be completed right now, and (b) whether the opponent is one stone away from " + winLength + ".",
    "- The centre holds the most " + winLength + "-length lines; stones far from every other stone rarely matter.",
    "",
    "YOUR SEAT",
    "- seat: " + seatLabel(seat) + (isNonEmptyString(player.name) ? " (" + player.name + ")" : "")
      + (isNonEmptyString(player.color) ? ", color " + player.color : "")
      + "; you are on the move",
    "- stone" + (stonesOwed === 1 ? "" : "s") + " still owed this turn: " + stonesOwed
      + (multi
        ? " — answer BOTH stones in this single reply"
        : " (you answer one stone per reply; you will be asked again if more are owed)"),
    "- requested play strength: " + (options.difficulty || "normal"),
    "",
    "OUTPUT CONTRACT",
    "- Reply with exactly one JSON object and nothing else. No markdown fences, no commentary, no extra keys.",
    ...(multi ? [
      "- Shape: {\"actions\":[{\"type\":\"place\",\"x\":9,\"y\":9},{\"type\":\"place\",\"x\":10,\"y\":9}],\"reason\":\"short reason\"}",
      "- The actions array must hold exactly two DIFFERENT points; both are placed in this turn.",
      "- If either point is illegal it is discarded, so choose two distinct empty points from the list below."
    ] : [
      "- Shape: {\"action\":{\"type\":\"place\",\"x\":9,\"y\":9},\"reason\":\"short reason\"}"
    ]),
    "- x is the zero-based column index (A=0), y is the zero-based row index (row 1 = 0).",
    "- There is exactly one legal action type: \"place\". Never emit pass, resign, recall or camp.",
    "- Every point you choose must appear in the CANDIDATE POINTS list of the user message.",
    "- reason: at most 200 characters, " + languageInstruction(options.language)
  ];
  if (isNonEmptyString(options.providerLabel)) {
    lines.push("- provider label: " + cleanToken(options.providerLabel, 40));
  }
  return lines.join("\n");
}

/**
 * On a 19x19 board, listing all ~360 empty points costs thousands of input
 * tokens and makes the model slow without making it any stronger: useful moves
 * are always near existing stones. Show those neighbours instead; the server
 * still validates against the full legal action space, so a shortlist cannot
 * let an illegal move through.
 */
function candidateLegalActions(state, legalActions) {
  const size = boardSize(state);
  const cells = Array.isArray(state.cells) ? state.cells : [];
  const occupied = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const seat = cells[y * size + x];
      if (seat !== null && seat !== undefined) occupied.push([x, y]);
    }
  }
  const centre = (size - 1) / 2;
  const relevant = (x, y) => {
    if (occupied.length === 0) return Math.abs(x - centre) <= 3 && Math.abs(y - centre) <= 3;
    return occupied.some(([ox, oy]) => Math.abs(x - ox) <= 2 && Math.abs(y - oy) <= 2);
  };
  const shortlist = legalActions.filter((action) => action.type === "place" && relevant(action.x, action.y));
  return shortlist.length >= 12 ? shortlist : legalActions;
}

function moveUserPrompt(state, options) {
  const seat = options.seat;
  const legalActions = options.legalActions;
  const turn = Number.isInteger(state.turn) ? state.turn : 0;
  const stonesOwed = Number.isInteger(options.stonesRemaining) ? options.stonesRemaining : 0;
  const cells = Array.isArray(state.cells) ? state.cells : [];
  const occupied = cells.filter((cell) => cell !== null && cell !== undefined).length;
  const lines = [
    "[PHASE] play; turn " + turn + "; you move " + seatLabel(seat) + "; "
      + stonesOwed + " stone" + (stonesOwed === 1 ? "" : "s") + " owed this turn",
    "",
    "[YOU] " + playerLine(state, seat),
    "",
    "[PLAYERS]"
  ];
  for (let other = 0; other < 2; other += 1) {
    lines.push("- " + playerLine(state, other) + (other === seat ? "  <-- you" : ""));
  }
  lines.push("", "[BOARD] " + occupied + "/" + (boardSize(state) * boardSize(state)) + " points occupied");
  lines.push(renderBoard(state), "");
  // One line per row keeps a 19x19 point set to about twenty lines instead of
  // the three hundred a one-point-per-line list would cost in tokens.
  const shown = options.fullLegalList ? legalActions : candidateLegalActions(state, legalActions);
  lines.push("[CANDIDATE POINTS] " + shown.length + " of " + legalActions.length
    + " empty points shown; every empty point is legal, these are the relevant ones."
    + (options.multiStone ? " Choose exactly two:" : " Choose exactly one:"));
  const byRow = new Map();
  for (const action of shown) {
    const row = action.y + 1;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(formatCell(state, action.x, action.y));
  }
  for (const row of Array.from(byRow.keys()).sort((a, b) => a - b)) {
    lines.push("  row " + row + ": " + byRow.get(row).join(" "));
  }
  lines.push("", options.multiStone
    ? "Answer with the JSON object whose actions array holds two points, as described in the system message. In that object x is the column index (A=0) and y is the row index minus one (row 1 = 0)."
    : "Answer with the JSON object described in the system message. In that object x is the column index (A=0) and y is the row index minus one (row 1 = 0). A bare cell string such as \"K10\" is also accepted.");
  return lines.join("\n");
}

/**
 * Builds OpenAI-compatible chat messages for an LLM opponent move.
 *
 * @param {object} options
 * @param {object} options.state engine state (a GameView with .state also works)
 * @param {number} [options.seat] seat the model controls (defaults to currentSeat)
 * @param {Array} [options.legalActions] canonical legal actions (defaults to engine actions)
 * @param {"easy"|"normal"|"hard"} [options.difficulty="normal"] informational play strength
 * @param {string} [options.providerLabel=""] optional provider label for logging/attribution
 * @param {"zh"|"en"} [options.language="zh"] language of the short reason
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMoveMessages(options = {}) {
  const state = unwrapState(options.state);
  if (!state) throw new TypeError("buildMoveMessages requires a valid engine state");
  if (state.phase === PHASES.FINISHED) throw new TypeError("buildMoveMessages cannot be used on a finished game");
  const seat = Number.isInteger(options.seat) ? options.seat : state.currentSeat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= resolvePlayerCount(state)) {
    throw new TypeError("buildMoveMessages requires a valid seat");
  }
  const legalActions = normalizeLegalActionList(options.legalActions, state);
  const owed = typeof stonesRemaining === "function"
    ? stonesRemaining(state)
    : (Number.isInteger(options.stonesRemaining) ? options.stonesRemaining : 2);
  const resolved = {
    seat,
    legalActions,
    stonesRemaining: owed,
    difficulty: typeof options.difficulty === "string" ? options.difficulty : "normal",
    providerLabel: typeof options.providerLabel === "string" ? options.providerLabel : "",
    language: normalizeLanguage(options.language),
    multiStone: options.multiStone === true,
    fullLegalList: options.fullLegalList === true
  };
  return [
    { role: "system", content: moveSystemPrompt(state, resolved) },
    { role: "user", content: moveUserPrompt(state, resolved) }
  ];
}

/**
 * Same position, but ask for both stones of a Connect6 turn in one reply, so a
 * turn costs one provider round-trip instead of two.
 */
export function buildTurnMessages(options = {}) {
  return buildMoveMessages({ ...options, stonesRemaining: 2, multiStone: true });
}

function pickActionCandidate(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.length > 0 ? pickActionCandidate(parsed[0]) : null;
  }
  if (!isObject(parsed)) return null;
  if ("action" in parsed) return parsed.action;
  if ("move" in parsed) return parsed.move;
  if (Array.isArray(parsed.actions)) return parsed.actions.length > 0 ? parsed.actions[0] : null;
  if (typeof parsed.type === "string") return parsed;
  return null;
}

/**
 * Validates a model-authored action object against canonical legal actions.
 * Returns the canonical legal action or null. Throws never.
 *
 * @param {object} action {"type":"place","x":3,"y":4}
 * @param {Array} legalActions canonical legal points from shared/rules.js
 * @param {object} [state] optional engine state (kept for signature compatibility)
 */
export function validateMoveAction(action, legalActions, state = null) {
  try {
    if (!Array.isArray(legalActions) || legalActions.length === 0) return null;
    const legal = [];
    for (const candidate of legalActions) {
      const canonical = canonicalAction(candidate);
      if (canonical) legal.push(canonical);
    }
    if (legal.length === 0) return null;
    const resolved = resolveObjectToLegalAction(action, legal);
    return resolved ? { ...resolved } : null;
  } catch (error) {
    return null;
  }
}

/**
 * Parses an LLM move response.
 *
 * @param {string} text raw model output (JSON, possibly fenced or with prose)
 * @param {Array} legalActions canonical legal actions from shared/rules.js
 * @returns {{action: object, reason: string} | null}
 */
export function parseMoveResponse(text, second) {
  try {
    let legalActions;
    let backendMode = false;
    if (Array.isArray(second)) {
      legalActions = second;
    } else if (isObject(second)) {
      backendMode = true;
      legalActions = Array.isArray(second.legalActions)
        ? second.legalActions
        : (second.state ? safeLegalActions(second.state) : []);
    }
    if (!Array.isArray(legalActions) || legalActions.length === 0) return null;
    const parsed = extractJson(text);
    if (parsed === null) return null;
    const candidate = pickActionCandidate(parsed);
    if (candidate === null || candidate === undefined) return null;
    const legal = [];
    for (const action of legalActions) {
      const canonical = canonicalAction(action);
      if (canonical) legal.push(canonical);
    }
    if (legal.length === 0) return null;
    let action = null;
    if (typeof candidate === "string") {
      action = resolveTextToLegalAction(parseActionText(candidate), legal);
    } else if (isObject(candidate)) {
      action = resolveObjectToLegalAction(candidate, legal);
    }
    if (!action) return null;
    const reasonSource = isObject(parsed) ? parsed.reason : null;
    const reason = cleanText(reasonSource, COACH_LIMITS.moveReason, { singleLine: true });
    if (backendMode) return { ...action };
    return { action: { ...action }, reason };
  } catch (error) {
    return null;
  }
}

/**
 * Parses a two-stone turn reply. Returns up to two distinct canonical legal
 * actions; a malformed or single-stone reply simply yields fewer actions and
 * the caller falls back for the missing stone.
 */
export function parseTurnResponse(text, options = {}) {
  try {
    const context = isObject(options) ? options : {};
    const legalActions = Array.isArray(context.legalActions)
      ? context.legalActions
      : (context.state ? safeLegalActions(context.state) : []);
    if (!Array.isArray(legalActions) || legalActions.length === 0) return [];
    const parsed = extractJson(text);
    if (parsed === null) return [];
    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (isObject(parsed) && Array.isArray(parsed.actions)) list = parsed.actions;
    else if (isObject(parsed)) list = [parsed];
    if (!list) return [];
    const out = [];
    for (const raw of list) {
      if (out.length >= 2) break;
      const candidate = isObject(raw) && ("action" in raw || "move" in raw)
        ? pickActionCandidate(raw)
        : raw;
      const action = validateMoveAction(candidate, legalActions, context.state ?? null);
      if (!action) continue;
      if (out.some((existing) => sameAction(existing, action))) continue;
      out.push(action);
    }
    return out;
  } catch (error) {
    return [];
  }
}


/* ------------------------------------------------------------------------- */
/* Coach report prompt                                                       */
/* ------------------------------------------------------------------------- */

function normalizeCoachGame(game, explicitState) {
  const source = isObject(game) ? game : {};
  const state = unwrapState(explicitState) || unwrapState(source);
  const playersSource = Array.isArray(source.players) && source.players.length > 0
    ? source.players
    : (state && Array.isArray(state.players) ? state.players : []);
  const result = isObject(source.result) ? source.result : (state && isObject(state.result) ? state.result : null);
  const metrics = isObject(source.metrics) ? source.metrics : null;
  return {
    id: typeof source.id === "string" ? source.id : null,
    mode: typeof source.mode === "string" ? source.mode : null,
    status: typeof source.status === "string" ? source.status : null,
    state,
    players: playersSource,
    result,
    metrics,
    playerCount: state ? resolvePlayerCount(state) : (Number(source.playerCount) || playersSource.length || 2)
  };
}

/**
 * Replays the action log so coach output can be validated against real turns:
 * turn number -> record { turn, seat, type, notation, beforeState, action }.
 * Falls back to the timestamps in the local analysis metrics when the engine
 * state cannot be replayed.
 */
function buildTurnContext(state, localAnalysis) {
  if (state) {
    try {
      const history = Array.isArray(state.history) ? state.history : [];
      let current = createGame({
        boardSize: state.boardSize,
        winLength: state.winLength,
        players: (state.players || []).map((player) => ({
          name: player && player.name,
          kind: player && player.kind
        }))
      });
      const entries = [];
      const byKey = new Map();
      for (const entry of history) {
        const point = Array.isArray(entry.points) && entry.points.length === 1
          ? entry.points[0]
          : { x: entry.x, y: entry.y };
        const action = { type: "place", x: point.x, y: point.y };
        const record = {
          turn: entry.turn,
          seat: entry.seat,
          type: "place",
          notation: entryNotation(current, entry),
          beforeState: current,
          action,
          canValidateLegal: true
        };
        entries.push(record);
        byKey.set(record.turn + ":" + record.seat, record);
        current = applyAction(current, action).state;
      }
      return { available: true, entries, byKey, source: "replay" };
    } catch (error) {
      // Fall through to the analysis timeline.
    }
  }
  const timeline = localAnalysis && localAnalysis.metrics && Array.isArray(localAnalysis.metrics.timeline)
    ? localAnalysis.metrics.timeline
    : null;
  if (timeline && timeline.length > 0) {
    const entries = [];
    const byKey = new Map();
    for (const item of timeline) {
      if (!isObject(item)) continue;
      if (!Number.isInteger(item.turn) || !Number.isInteger(item.seat)) continue;
      const record = {
        turn: item.turn,
        seat: item.seat,
        type: typeof item.type === "string" ? item.type : "place",
        notation: typeof item.notation === "string" ? item.notation : "",
        beforeState: null,
        action: null,
        canValidateLegal: false
      };
      entries.push(record);
      byKey.set(record.turn + ":" + record.seat, record);
    }
    return { available: entries.length > 0, entries, byKey, source: "analysis-timeline" };
  }
  return { available: false, entries: [], byKey: new Map(), source: "none" };
}

function findTurnRecord(turnContext, turn, seat) {
  if (!turnContext.available || !Number.isInteger(turn)) return null;
  const direct = turnContext.byKey.get(turn + ":" + seat);
  if (direct) return direct;
  return null;
}

function normalizeCoachResult(game) {
  const result = game.result;
  if (isObject(result) && Array.isArray(result.scores)) return result;
  if (game.state) {
    try {
      return computeResult(game.state, game.state.phase === PHASES.FINISHED
        ? {}
        : { winnerSeats: [], line: [], endReason: "in_progress" });
    } catch (error) {
      return null;
    }
  }
  return null;
}

function formatGameFacts(game, metrics) {
  const state = game.state;
  const result = normalizeCoachResult(game);
  const players = game.players;
  const lines = [];
  lines.push("- mode: " + (game.mode || "unknown") + (game.id ? "; id: " + cleanToken(game.id, 40) : ""));
  lines.push("- players: " + (state ? resolvePlayerCount(state) : game.playerCount));
  for (const player of players) {
    if (!isObject(player)) continue;
    const seat = Number.isInteger(player.seat) ? player.seat : players.indexOf(player);
    lines.push("  - " + seatLabel(seat) + " name=" + (isNonEmptyString(player.name) ? cleanToken(player.name, 32) : "player")
      + (isNonEmptyString(player.color) ? " color=" + player.color : "")
      + (isNonEmptyString(player.kind) ? " kind=" + player.kind : ""));
  }
  if (result) {
    const stones = Array.isArray(result.stoneCounts) ? result.stoneCounts : (Array.isArray(result.scores) ? result.scores : []);
    const winners = Array.isArray(result.winnerSeats) ? result.winnerSeats : [];
    lines.push("- winner: " + (winners.length > 0 ? winners.map(seatLabel).join(" and ") : "none (draw)"));
    if (typeof result.endReason === "string") lines.push("- end reason: " + result.endReason);
    if (Array.isArray(result.line) && result.line.length > 0) {
      lines.push("- winning line length: " + result.line.length + " (" + result.line.length + " in a row wins here)");
    }
    if (stones.length > 0) {
      lines.push("- stones placed: " + stones.map((count, seat) => seatLabel(seat) + " " + count).join(", "));
    }
    if (Number.isInteger(result.turns)) lines.push("- turns played: " + result.turns);
    if (Number.isInteger(result.decisions)) lines.push("- decisions (one stone each): " + result.decisions);
  } else {
    lines.push("- final result: unavailable");
  }
  const turnCount = state && Number.isInteger(state.turn) ? state.turn : null;
  if (turnCount !== null && !result) lines.push("- turns played: " + turnCount);
  const metricSource = isObject(metrics) ? metrics : game.metrics;
  if (isObject(metricSource)) {
    if (Number.isFinite(metricSource.durationMs)) lines.push("- durationMs: " + metricSource.durationMs);
    if (Number.isInteger(metricSource.decisions)) lines.push("- recorded decisions: " + metricSource.decisions);
  }
  return lines.join("\n");
}

function formatActionLog(turnContext, limit) {
  const max = limit || 60;
  if (!turnContext.available || turnContext.entries.length === 0) return "Action log unavailable; do not reference turn numbers you cannot see.";
  const lines = [];
  let entries = turnContext.entries;
  if (entries.length > max) {
    const head = entries.slice(0, 20);
    const tail = entries.slice(entries.length - (max - 20));
    entries = head.concat([null], tail);
  }
  for (const entry of entries) {
    if (entry === null) {
      lines.push("...");
      continue;
    }
    lines.push("- turn " + entry.turn + " | " + seatLabel(entry.seat) + " | " + entry.notation);
  }
  return lines.join("\n");
}

function truncateLine(text, max) {
  return cleanText(text, max, { singleLine: true });
}

/** Compact, deterministic digest of the local analysis for grounding prompts. */
function buildAnalysisDigest(localAnalysis, language) {
  if (!isObject(localAnalysis)) {
    return "No local analysis is available. Use only the game facts and action log above.";
  }
  const zh = normalizeLanguage(language) === "zh";
  /** The analysis carries both languages; prompts only need the one being written. */
  const pick = (source, base) => {
    if (!isObject(source)) return "";
    return (zh ? source[base + "Zh"] : source[base]) || source[base] || source[base + "Zh"] || "";
  };
  const summary = isObject(localAnalysis.summary) ? localAnalysis.summary : {};
  const metrics = isObject(localAnalysis.metrics) ? localAnalysis.metrics : {};
  const lines = [];
  lines.push("LOCAL ANALYSIS (server-computed; treat as ground truth, do not contradict)");
  if (isNonEmptyString(summary.headline)) lines.push("- headline: " + truncateLine(summary.headline, 200));
  if (isNonEmptyString(summary.resultLine)) lines.push("- result: " + truncateLine(summary.resultLine, 600));
  if (Array.isArray(summary.scores)) {
    lines.push("- stones on the board: " + summary.scores.map((entry) => (
      isObject(entry) ? seatLabel(entry.seat) + " " + entry.score : ""
    )).filter(Boolean).join("; "));
  }
  if (isObject(summary.peakThreat)) {
    lines.push("- peak threat: " + seatLabel(summary.peakThreat.seat) + " " + summary.peakThreat.notation
      + " (turn " + summary.peakThreat.turn + ") run of " + summary.peakThreat.length
      + " with " + summary.peakThreat.openEnds + " open end(s), shape " + summary.peakThreat.shape);
  }
  if (Array.isArray(metrics.perPlayer)) {
    lines.push("- per player:");
    for (const player of metrics.perPlayer) {
      if (!isObject(player)) continue;
      const parts = [
        seatLabel(player.seat),
        "decisions " + player.decisions,
        "missed wins " + player.missedWins,
        "unblocked sixes " + player.unblockedThreats,
        "blocks " + player.blocks,
        "stones that joined nothing " + player.looseStones,
        "peak shape " + player.peakShape + (player.peakNotation ? " at " + player.peakNotation : "")
      ];
      lines.push("  - " + parts.join(", "));
    }
  }
  if (Array.isArray(localAnalysis.keyMoments) && localAnalysis.keyMoments.length > 0) {
    lines.push("- key moments:");
    for (const moment of localAnalysis.keyMoments.slice(0, 8)) {
      if (!isObject(moment)) continue;
      lines.push("  - turn " + moment.turn + " " + (moment.kind || "moment") + " " + (moment.notation || "")
        + (isNonEmptyString(pick(moment, "title")) ? ": " + truncateLine(pick(moment, "title"), 80) : "")
        + (isNonEmptyString(pick(moment, "detail")) ? " — " + truncateLine(pick(moment, "detail"), 160) : ""));
    }
  }
  if (Array.isArray(metrics.swings) && metrics.swings.length > 0) {
    lines.push("- biggest positional swings:");
    for (const swing of metrics.swings.slice(0, 4)) {
      if (!isObject(swing)) continue;
      lines.push("  - turn " + swing.turn + " " + seatLabel(swing.seat) + " " + swing.notation + " impact " + swing.impact);
    }
  }
  if (Array.isArray(localAnalysis.weaknesses) && localAnalysis.weaknesses.length > 0) {
    lines.push("- detected weaknesses:");
    for (const weakness of localAnalysis.weaknesses.slice(0, 6)) {
      if (!isObject(weakness)) continue;
      lines.push("  - " + seatLabel(weakness.seat) + " [" + weakness.severity + "] " + weakness.code + ": "
        + truncateLine(pick(weakness, "detail"), 180));
    }
  }
  if (Array.isArray(localAnalysis.recommendations) && localAnalysis.recommendations.length > 0) {
    lines.push("- local recommendations:");
    for (const recommendation of localAnalysis.recommendations.slice(0, 6)) {
      if (!isObject(recommendation)) continue;
      lines.push("  - " + seatLabel(recommendation.seat) + " priority " + recommendation.priority + " " + recommendation.code
        + ": " + truncateLine(pick(recommendation, "detail"), 180));
    }
  }
  const digest = lines.join("\n");
  return digest.length > 6000 ? digest.slice(0, 5999) + "\u2026" : digest;
}

function coachOutputSpec(language) {
  const caps = COACH_LIMITS;
  return [
    "OUTPUT CONTRACT",
    "Reply with exactly one JSON object and nothing else (no markdown fences, no prose outside the JSON).",
    "Keys and limits:",
    "- headline: string, non-empty, <= " + caps.headline + " characters.",
    "- summary: string, non-empty, <= " + caps.summary + " characters.",
    "- strengths: array of <= " + caps.strengths + " objects {seat:int, title:string<=" + caps.title + ", detail:string<=" + caps.detail + "}.",
    "- weaknesses: array of <= " + caps.weaknesses + " objects {seat:int, severity:\"high\"|\"medium\"|\"low\", title:string, detail:string, turn?:int, cells?:string[]}.",
    "- keyMistakes: array of <= " + caps.keyMistakes + " objects {seat:int, turn:int, actual:string, better?:string, reason:string<=" + caps.reason + ", gain?:int}.",
    "- recommendations: array of <= " + caps.recommendations + " objects {seat:int, priority:int, title:string, detail:string}.",
    "- trainingPlan: array of <= " + caps.trainingPlan + " strings, each <= " + caps.trainingItem + " characters.",
    "Do NOT include version, source, provider, model, generatedAt or usage; the server adds those.",
    "Seat numbers are zero-based: P1=0 (black, moves first), P2=1 (white).",
    "Moves use bare cell notation only: \"K10\", \"D4\", \"Q16\". There is no pass, no resignation and no multi-stone action.",
    "Every keyMistakes.turn must be a turn number that appears in the action log, and keyMistakes.actual must be the single stone played on that turn.",
    "A better move must have been legal on that turn; if you are not sure, omit the better field instead of guessing.",
    languageInstruction(language)
  ].join("\n");
}

function coachSystemPrompt(language) {
  return [
    "You are a professional Connect6 (六子棋) coach writing a post-game report for the human player.",
    "Connect6 is a deterministic, perfect-information placing game for two players on a 19x19 board (columns A-S, rows 1-19). Black opens with one stone; every later turn the player on the move places two stones, one decision at a time. The first player to line up six or more stones in a row, column or diagonal wins. There is no pass, no resignation, no capture and no forbidden move.",
    "",
    "WHAT MAKES A CONNECT6 MISTAKE",
    "- Ignoring a finishing move: a line of five with an open end wins immediately.",
    "- Failing to block: if the opponent has five in a row with an open end, that point had to be taken.",
    "- Single threats: because a turn is two stones, one threat is answered for free. Only double threats win.",
    "- Disconnected stones: a stone that joins nothing spends a tempo for nothing.",
    "",
    "GROUNDING RULES (strict, anti-hallucination)",
    "- Use only the game facts, action log and LOCAL ANALYSIS provided by the user. They are computed by the server and are authoritative.",
    "- Never invent turns, moves, points, line lengths or results. If the evidence does not support a claim, omit it.",
    "- keyMistakes must reference a real turn and the stone actually played on it; the better move must have been legal on that turn (otherwise omit it).",
    "- Cite concrete turns and cells when explaining a mistake or a strength.",
    "- The report must be specific to this game; no generic motivational filler.",
    "",
    coachOutputSpec(language)
  ].join("\n");
}

/**
 * Builds OpenAI-compatible chat messages for a coach report generation.
 *
 * @param {object} options
 * @param {object} options.game game summary/GameView ({id, mode, playerCount, players, result, metrics}) or engine state
 * @param {object} [options.state] engine state (needed for turn-level grounding)
 * @param {object} [options.localAnalysis] analyzeGame() output used as grounding evidence
 * @param {object} [options.metrics] stored playtest metrics (optional)
 * @param {"zh"|"en"} [options.language="zh"]
 * @returns {Array<{role:string, content:string}>}
 */
export function buildCoachMessages(options = {}) {
  const game = normalizeCoachGame(options.game ?? options.state, options.state);
  if (!game.state && !game.result && !isObject(options.localAnalysis)) {
    throw new TypeError("buildCoachMessages requires a game context (state, result or local analysis)");
  }
  const turnContext = buildTurnContext(game.state, options.localAnalysis);
  const language = normalizeLanguage(options.language);
  const userLines = [
    "[GAME FACTS]",
    formatGameFacts(game, options.metrics),
    "",
    "[ACTION LOG] (turn | seat | canonical action)",
    formatActionLog(turnContext),
    "",
    "[TURN VALIDITY]",
    turnContext.available
      ? "keyMistakes.turn must be one of the turn numbers listed above."
      : "The action log is unavailable, so return an empty keyMistakes array and avoid naming specific turns.",
    "",
    "[LOCAL ANALYSIS GROUNDING]",
    buildAnalysisDigest(options.localAnalysis, language),
    "",
    coachOutputSpec(language)
  ];
  return [
    { role: "system", content: coachSystemPrompt(language) },
    { role: "user", content: userLines.join("\n") }
  ];
}


/* ------------------------------------------------------------------------- */
/* Coach report parser (strict, replay-grounded)                             */
/* ------------------------------------------------------------------------- */

function resolveCaps(overrides) {
  const caps = {
    strengths: COACH_LIMITS.strengths,
    weaknesses: COACH_LIMITS.weaknesses,
    keyMistakes: COACH_LIMITS.keyMistakes,
    recommendations: COACH_LIMITS.recommendations,
    trainingPlan: COACH_LIMITS.trainingPlan
  };
  if (isObject(overrides)) {
    for (const key of Object.keys(caps)) {
      const value = overrides[key];
      if (Number.isInteger(value) && value >= 0) caps[key] = Math.min(value, caps[key]);
    }
  }
  return caps;
}

function normalizeUsage(usage) {
  const source = isObject(usage) ? usage : {};
  const toCount = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
  return { inputTokens: toCount(source.inputTokens), outputTokens: toCount(source.outputTokens) };
}

function normalizeGain(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(-49, Math.min(49, Math.round(number)));
}

function validCellNotation(value, size) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  const match = /^([A-S])(\d{1,2})$/.exec(trimmed);
  if (!match) return null;
  const column = trimmed.charCodeAt(0) - 65;
  const row = Number(match[2]);
  if (column < 0 || column >= size || row < 1 || row > size) return null;
  return trimmed;
}

function recordTypeAndCell(record) {
  if (!record) return null;
  if (record.action && isObject(record.action)) {
    return { type: "place", cell: cellNotation(record.action.x, record.action.y) };
  }
  if (typeof record.notation === "string") {
    const parsed = parseActionText(record.notation);
    if (parsed) return { type: parsed.type, cell: parsed.cell };
  }
  return null;
}

function actionMatchesRecord(actualText, record) {
  const parsed = parseActionText(actualText);
  if (!parsed) return false;
  const target = recordTypeAndCell(record);
  if (!target || !target.cell) return false;
  return parsed.cell === target.cell;
}

function canonicalActionText(action) {
  if (!action) return null;
  return cellNotation(action.x, action.y);
}

/**
 * Validates the model's "better" move against the legal actions that existed on
 * that turn. Returns canonical notation or null when it cannot be verified.
 */
function resolveBetterMove(record, rawBetter) {
  if (!record || !record.canValidateLegal || !record.beforeState) return null;
  if (!isNonEmptyString(rawBetter) && !isObject(rawBetter)) return null;
  let legalActions = [];
  try {
    legalActions = safeLegalActions(record.beforeState);
  } catch (error) {
    return null;
  }
  if (legalActions.length === 0) return null;
  let resolved = null;
  if (typeof rawBetter === "string") {
    resolved = resolveTextToLegalAction(parseActionText(rawBetter), legalActions);
  } else if (isObject(rawBetter)) {
    resolved = resolveObjectToLegalAction(rawBetter, legalActions);
  }
  if (!resolved) return null;
  const actualText = canonicalActionText(record.action);
  const betterText = canonicalActionText(resolved);
  if (!betterText || betterText === actualText) return null;
  return betterText;
}

function normalizeSeverity(value) {
  if (typeof value !== "string") return "medium";
  const severity = value.trim().toLowerCase();
  return SEVERITIES.includes(severity) ? severity : "medium";
}

/**
 * Strictly validates an already-parsed coach report payload against the
 * docs/AI-INTEGRATION.md §5 schema and the real game replay.
 *
 * Metadata is stamped by the server via options:
 *   { state, localAnalysis, taskCounts?, caps?, source?, provider?, model?, generatedAt?, usage?, playerCount? }
 *
 * Returns a full `thick-earth-coach/v1` report object or null when the payload
 * is unusable (missing headline/summary, not an object, validation failure).
 * Individual malformed array entries are dropped instead of failing the report;
 * the contract caps (strengths ≤4, weaknesses ≤6, keyMistakes ≤6,
 * recommendations ≤6, trainingPlan ≤5) always apply.
 */
export function validateCoachReport(raw, options = {}) {
  try {
    if (!isObject(raw)) return null;
    const state = unwrapState(options.state);
    const localAnalysis = isObject(options.localAnalysis) ? options.localAnalysis : null;
    const turnContext = buildTurnContext(state, localAnalysis);
    const playerCount = 2;
    const boardDimension = state ? boardSize(state) : 19;
    const caps = resolveCaps(options.taskCounts || options.caps);

    const headline = cleanText(raw.headline, COACH_LIMITS.headline, { singleLine: true });
    const summary = cleanText(raw.summary, COACH_LIMITS.summary);
    if (!headline || !summary) return null;

    const seatValid = (seat) => Number.isInteger(seat) && seat >= 0 && seat < playerCount;

    const strengths = [];
    if (Array.isArray(raw.strengths)) {
      for (const item of raw.strengths) {
        if (!isObject(item)) continue;
        const seat = Number(item.seat);
        const title = cleanText(item.title, COACH_LIMITS.title, { singleLine: true });
        const detail = cleanText(item.detail, COACH_LIMITS.detail);
        if (!seatValid(seat) || !title || !detail) continue;
        strengths.push({ seat, title, detail });
        if (strengths.length >= caps.strengths) break;
      }
    }

    const weaknesses = [];
    if (Array.isArray(raw.weaknesses)) {
      for (const item of raw.weaknesses) {
        if (!isObject(item)) continue;
        const seat = Number(item.seat);
        const title = cleanText(item.title, COACH_LIMITS.title, { singleLine: true });
        const detail = cleanText(item.detail, COACH_LIMITS.detail);
        if (!seatValid(seat) || !title || !detail) continue;
        const entry = { seat, severity: normalizeSeverity(item.severity), title, detail };
        const turn = Number(item.turn);
        if (Number.isInteger(turn) && turn >= 0 && turnContext.available) {
          const record = findTurnRecord(turnContext, turn, seat);
          if (record) entry.turn = record.turn;
        }
        if (Array.isArray(item.cells)) {
          const cells = [];
          for (const cell of item.cells) {
            const valid = validCellNotation(cell, boardDimension);
            if (valid && !cells.includes(valid)) cells.push(valid);
            if (cells.length >= COACH_LIMITS.weaknessCells) break;
          }
          if (cells.length > 0) entry.cells = cells;
        }
        weaknesses.push(entry);
        if (weaknesses.length >= caps.weaknesses) break;
      }
    }

    const keyMistakes = [];
    if (Array.isArray(raw.keyMistakes)) {
      for (const item of raw.keyMistakes) {
        if (!isObject(item)) continue;
        const seat = Number(item.seat);
        const turn = Number(item.turn);
        const reason = cleanText(item.reason, COACH_LIMITS.reason);
        const actualRaw = cleanText(item.actual, 120, { singleLine: true });
        if (!seatValid(seat) || !Number.isInteger(turn) || turn < 0 || !reason || !actualRaw) continue;
        let actual = actualRaw;
        let better = null;
        if (turnContext.available) {
          const record = findTurnRecord(turnContext, turn, seat);
          if (!record) continue;
          if (record.seat !== seat) continue;
          if (!actionMatchesRecord(actualRaw, record)) continue;
          const canonical = recordTypeAndCell(record);
          if (!canonical) continue;
          actual = canonical.cell;
          better = resolveBetterMove(record, item.better);
        }
        const entry = { seat, turn, actual, reason };
        if (better) entry.better = better;
        const gain = normalizeGain(item.gain);
        if (gain !== null) entry.gain = gain;
        keyMistakes.push(entry);
        if (keyMistakes.length >= caps.keyMistakes) break;
      }
    }

    const recommendations = [];
    if (Array.isArray(raw.recommendations)) {
      for (let index = 0; index < raw.recommendations.length; index += 1) {
        const item = raw.recommendations[index];
        if (!isObject(item)) continue;
        const seat = Number(item.seat);
        const title = cleanText(item.title, COACH_LIMITS.title, { singleLine: true });
        const detail = cleanText(item.detail, COACH_LIMITS.detail);
        if (!seatValid(seat) || !title || !detail) continue;
        let priority = Number(item.priority);
        if (!Number.isInteger(priority) || priority < 1) priority = index + 1;
        recommendations.push({ seat, priority: Math.min(priority, 99), title, detail });
        if (recommendations.length >= caps.recommendations) break;
      }
    }

    const trainingPlan = [];
    if (Array.isArray(raw.trainingPlan)) {
      for (const item of raw.trainingPlan) {
        if (typeof item !== "string") continue;
        const text = cleanText(item, COACH_LIMITS.trainingItem, { singleLine: true });
        if (!text) continue;
        trainingPlan.push(text);
        if (trainingPlan.length >= caps.trainingPlan) break;
      }
    }

    return {
      version: COACH_REPORT_VERSION,
      source: options.source === "local-fallback" ? "local-fallback" : "llm",
      provider: isNonEmptyString(options.provider) ? cleanToken(options.provider, 40) : null,
      model: isNonEmptyString(options.model) ? cleanToken(options.model, 80) : null,
      generatedAt: Number.isFinite(Number(options.generatedAt)) ? Math.trunc(Number(options.generatedAt)) : Date.now(),
      headline,
      summary,
      strengths,
      weaknesses,
      keyMistakes,
      recommendations,
      trainingPlan,
      usage: normalizeUsage(options.usage)
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parses a model-authored coach report and applies the strict
 * docs/AI-INTEGRATION.md schema, caps and replay/legality validation.
 *
 * @param {string} text raw model output
 * @param {object} [options] { state, localAnalysis, taskCounts?, caps?, provider?, model?, generatedAt?, usage?, source?, playerCount? }
 * @returns {object | null} full thick-earth-coach/v1 report or null
 */
export function parseCoachReport(text, options = {}) {
  try {
    return validateCoachReport(extractJson(text), options);
  } catch (error) {
    return null;
  }
}


/* ------------------------------------------------------------------------- */
/* Coach chat                                                                */
/* ------------------------------------------------------------------------- */

function normalizeChatHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = cleanText(message.content, COACH_LIMITS.chatMessage);
    if (!content) continue;
    out.push({ role: message.role, content });
  }
  return out.slice(-COACH_LIMITS.chatHistory);
}

function buildReportDigest(report) {
  if (!isObject(report)) return "No saved coach report is available.";
  const lines = ["SAVED COACH REPORT (ground truth)"];
  if (isNonEmptyString(report.headline)) lines.push("- headline: " + cleanText(report.headline, 160, { singleLine: true }));
  if (isNonEmptyString(report.summary)) lines.push("- summary: " + cleanText(report.summary, 600));
  if (Array.isArray(report.keyMistakes) && report.keyMistakes.length > 0) {
    lines.push("- key mistakes:");
    for (const mistake of report.keyMistakes.slice(0, 4)) {
      if (!isObject(mistake)) continue;
      lines.push("  - " + seatLabel(mistake.seat) + " turn " + mistake.turn + ": actual " + mistake.actual
        + (mistake.better ? ", better " + mistake.better : "")
        + (mistake.reason ? " (" + cleanText(mistake.reason, 150, { singleLine: true }) + ")" : ""));
    }
  }
  if (Array.isArray(report.weaknesses) && report.weaknesses.length > 0) {
    lines.push("- weaknesses: " + report.weaknesses.slice(0, 4).map((weakness) => (
      isObject(weakness) ? seatLabel(weakness.seat) + " [" + weakness.severity + "] " + cleanText(weakness.title, 60, { singleLine: true }) : ""
    )).filter(Boolean).join("; "));
  }
  if (Array.isArray(report.recommendations) && report.recommendations.length > 0) {
    lines.push("- recommendations:");
    for (const recommendation of report.recommendations.slice(0, 4)) {
      if (!isObject(recommendation)) continue;
      lines.push("  - " + seatLabel(recommendation.seat) + " priority " + recommendation.priority + ": "
        + cleanText(recommendation.title + " — " + recommendation.detail, 200, { singleLine: true }));
    }
  }
  if (Array.isArray(report.trainingPlan) && report.trainingPlan.length > 0) {
    lines.push("- training plan: " + report.trainingPlan.slice(0, 3).join(" / "));
  }
  return lines.join("\n");
}

function chatSystemPrompt(language, reportDigest, analysisDigest, gameFacts, actionLog) {
  return [
    "You are the Connect6 (六子棋) AI coach in a follow-up conversation with a player about one finished game.",
    "Answer questions about this game: what happened, why a move was weak, what to train next. Be concrete: cite turns and points using bare cell notation (A1..S19, for example K10 or D4). There is no pass and no resignation in Connect6.",
    "",
    "GROUNDING RULES",
    "- The game facts, action log, local analysis and saved coach report below are authoritative. Use them.",
    "- Never invent turns, moves, points or line lengths. If the available evidence does not answer the question, say plainly that the data is not available and suggest what to review.",
    "- Keep the reply conversational and concise: at most about 400 characters or 4 short sentences.",
    "- Reply in the same language as the user's latest message. Plain text only: no JSON, no markdown fences, no headings.",
    languageInstruction(language),
    "",
    "[GAME FACTS]",
    gameFacts,
    "",
    "[ACTION LOG]",
    actionLog,
    "",
    "[ANALYSIS DIGEST]",
    analysisDigest.length > 2600 ? analysisDigest.slice(0, 2599) + "\u2026" : analysisDigest,
    "",
    "[REPORT DIGEST]",
    reportDigest
  ].join("\n");
}

/**
 * Builds OpenAI-compatible chat messages for a coach follow-up question.
 *
 * @param {object} options
 * @param {object} [options.report] saved coach report (ground truth)
 * @param {object} [options.game] game summary/GameView
 * @param {object} [options.state] engine state (for turn-level grounding)
 * @param {object} [options.localAnalysis] analyzeGame() output
 * @param {Array} [options.messages] stored chat history [{role, content}] (last 8 are used)
 * @param {string} [options.userMessage] new user message (1-600 chars)
 * @param {"zh"|"en"} [options.language="zh"]
 * @returns {Array<{role:string, content:string}>}
 */
export function buildCoachChatMessages(options = {}) {
  const game = normalizeCoachGame(options.game ?? options.state, options.state);
  const turnContext = buildTurnContext(game.state, options.localAnalysis);
  const history = normalizeChatHistory(options.messages ?? options.history);
  const userMessage = cleanText(options.userMessage ?? options.message, COACH_LIMITS.chatMessage);
  const system = chatSystemPrompt(
    options.language,
    buildReportDigest(options.report),
    buildAnalysisDigest(options.localAnalysis, options.language),
    formatGameFacts(game, options.metrics),
    formatActionLog(turnContext, 40)
  );
  const messages = [{ role: "system", content: system }];
  for (const item of history) messages.push(item);
  if (userMessage && (history.length === 0 || history[history.length - 1].content !== userMessage)) {
    messages.push({ role: "user", content: userMessage });
  }
  return messages;
}

/**
 * Parses an LLM coach chat reply into plain text, or null when the model
 * returned nothing usable. Accepts plain text, fenced text, or a JSON wrapper
 * ({"reply": "..."} / {"message": "..."} / {"content": "..."}).
 */
export function parseCoachChatResponse(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = extractJson(trimmed);
  if (isObject(parsed)) {
    for (const key of ["reply", "message", "content", "text"]) {
      const candidate = parsed[key];
      if (isNonEmptyString(candidate)) return cleanText(candidate, 2000);
    }
    return null;
  }
  if (Array.isArray(parsed)) return null;
  const plain = stripFences(trimmed).trim();
  if (!plain) return null;
  if (plain.startsWith("{") || plain.startsWith("[")) return null;
  return cleanText(plain, 2000);
}

/* ------------------------------------------------------------------------- */
/* Repair prompts                                                            */
/* ------------------------------------------------------------------------- */

function appendRepair(messages, previousText, repairInstruction) {
  const base = [];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isObject(message)) continue;
      if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") continue;
      const content = cleanText(message.content, 4000);
      if (!content) continue;
      base.push({ role: message.role, content });
    }
  }
  const out = base.slice();
  const previous = cleanText(previousText, 1600);
  if (previous) out.push({ role: "assistant", content: previous });
  out.push({ role: "user", content: repairInstruction });
  return out;
}

function repairInstructionFor(role, issue) {
  const reason = cleanText(issue, 300, { singleLine: true }) || "the previous reply did not satisfy the contract";
  if (role === "move") {
    return "Your previous reply was not usable as a move: " + reason + ". Choose exactly one action from the LEGAL ACTIONS list and reply again with ONLY the JSON object {\"action\":{...},\"reason\":\"...\"}. No markdown fences, no commentary, no extra keys.";
  }
  if (role === "chat") {
    return "Your previous reply was not usable: " + reason + ". Reply again in plain text only, in the same language as the last user message, at most about 400 characters. Do not return JSON or markdown.";
  }
  return "Your previous coach report was not usable: " + reason + ". Reply again with ONLY one valid JSON object using the required keys and limits. Do not add markdown or commentary. Every seat must exist, every keyMistakes.turn must appear in the action log, and every better move must have been legal on that turn.";
}

/**
 * Generic repair-message builder: appends the invalid assistant output and a
 * corrective user instruction to the original messages.
 *
 * @param {object} options { messages, previousText, issue, role?: "coach"|"move"|"chat" }
 */
export function buildRepairMessages(options = {}) {
  const role = options.role === "move" || options.role === "chat" ? options.role : "coach";
  return appendRepair(options.messages, options.previousText, repairInstructionFor(role, options.issue));
}

function contextMessages(context) {
  if (Array.isArray(context)) return context;
  if (isObject(context)) {
    if (Array.isArray(context.messages)) return context.messages;
    if (Array.isArray(context.previousMessages)) return context.previousMessages;
  }
  return [];
}

/**
 * Backend-compatible repair builder for LLM moves.
 * Returns the original move messages plus the invalid reply and a retry
 * instruction. Accepts either { messages, previousText, issue } or the same
 * options as buildMoveMessages plus previousText.
 */
export function buildMoveRepairMessages(options = {}) {
  const messages = Array.isArray(options.messages)
    ? options.messages
    : buildMoveMessages(options);
  return appendRepair(messages, options.previousText, repairInstructionFor("move", options.issue));
}

/**
 * Backend-compatible repair builder for coach reports. `context` may be the
 * messages array returned by buildCoachReportMessages() or the same options
 * object.
 */
export function buildCoachReportRepairMessages(options = {}) {
  const context = options.context;
  let messages = contextMessages(context);
  if (messages.length === 0 && isObject(context) && (context.game || context.state)) {
    messages = buildCoachMessages({
      game: context.game ?? context.state,
      state: context.state,
      localAnalysis: context.analysis ?? context.localAnalysis,
      metrics: context.metrics,
      language: context.language
    });
  }
  return appendRepair(messages, options.previousText, repairInstructionFor("coach", options.issue));
}

/** Backend-compatible repair builder for coach chat. */
export function buildCoachChatRepairMessages(options = {}) {
  const context = options.context;
  let messages = contextMessages(context);
  if (messages.length === 0 && isObject(context) && (context.game || context.state || context.report)) {
    messages = buildCoachChatMessages({
      report: context.report,
      game: context.game ?? context.state,
      state: context.state,
      localAnalysis: context.analysis ?? context.localAnalysis,
      messages: context.messages ?? context.history,
      userMessage: context.userMessage ?? context.message,
      language: context.language
    });
  }
  return appendRepair(messages, options.previousText, repairInstructionFor("chat", options.issue));
}

/* ------------------------------------------------------------------------- */
/* Backend adapter aliases                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Backend seam: { game, state, analysis, metrics, language } -> messages.
 * Thin alias over buildCoachMessages().
 */
export function buildCoachReportMessages(options = {}) {
  return buildCoachMessages({
    game: options.game ?? options.state,
    state: options.state,
    localAnalysis: options.analysis ?? options.localAnalysis,
    metrics: options.metrics,
    language: options.language
  });
}

/**
 * Backend seam: extract the JSON object from a coach response without applying
 * the schema (the server validates caps/seats/turns/legality itself).
 */
export function parseCoachReportResponse(text) {
  try {
    const parsed = extractJson(text);
    if (isObject(parsed)) return parsed;
    if (Array.isArray(parsed) && parsed.length === 1 && isObject(parsed[0])) return parsed[0];
    return null;
  } catch (error) {
    return null;
  }
}

/** Minimal "reply with OK" prompt for POST /api/ai/test. */
export function buildConnectionTestMessages() {
  return [
    { role: "system", content: "You are a connectivity test for an OpenAI-compatible chat provider. Follow the user's instruction exactly." },
    { role: "user", content: "Reply with exactly OK and nothing else." }
  ];
}




