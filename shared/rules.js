/**
 * Connect6 rules engine.
 *
 * Connect6 (六子棋) is a two-player, perfect-information game played on a 19x19
 * board. Black opens with a single stone; every later turn consists of two
 * stones placed by the same player. The first player to line up six or more
 * stones horizontally, vertically or diagonally wins. There are no forbidden
 * moves, no captures, no pass, no resignation and no hidden information.
 *
 * Decision boundary: one applied action is exactly ONE stone, matching the
 * referee's baseline `get_move(board)` contract. A turn therefore spans one or
 * two decisions by the same seat, and the engine keeps that bookkeeping in
 * `placedThisTurn` so callers never have to think about it.
 *
 * This module is the single source of truth for the rules. It is pure: no IO, no
 * randomness, no clock. Everything the server stores is derived from here, and a
 * game can always be rebuilt from its ordered action log by replayActions().
 */

export const RULESET_VERSION = "connect6/v1";
export const BOARD_SIZE = 19;
export const WIN_LENGTH = 6;
export const STONES_PER_TURN = 2;
export const FIRST_TURN_STONES = 1;
export const PLAYER_COUNTS = Object.freeze([2]);
export const PLAYER_COLORS = Object.freeze(["black", "white"]);

export const PHASES = Object.freeze({
  PLAY: "play",
  FINISHED: "finished"
});

export const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_ACTION: "INVALID_ACTION",
  INVALID_PHASE: "INVALID_PHASE",
  OUT_OF_BOUNDS: "OUT_OF_BOUNDS",
  CELL_OCCUPIED: "CELL_OCCUPIED",
  WRONG_STONE_COUNT: "WRONG_STONE_COUNT",
  GAME_FINISHED: "GAME_FINISHED"
});

export class RuleError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "RuleError";
    this.code = code;
    this.details = details;
  }
}

/** Column labels for a 19-wide board: A..S (the letter I is kept for index clarity). */
const COLUMN_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXY";

/** Direction vectors used by win detection and by the analysis/AI layers. */
export const DIRECTIONS = Object.freeze([
  Object.freeze([1, 0]),
  Object.freeze([0, 1]),
  Object.freeze([1, 1]),
  Object.freeze([1, -1])
]);

const clampName = (value, fallback) => {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 ? name.slice(0, 32) : fallback;
};

export function normalizeConfig(input = {}) {
  const playerCount = input.playerCount
    ?? (Array.isArray(input.players) ? input.players.length : null);
  if (playerCount !== 2) {
    throw new RuleError(ERROR_CODES.INVALID_CONFIG, "Connect6 is played by exactly two players.");
  }
  const boardSize = Number.isInteger(input.boardSize) ? input.boardSize : BOARD_SIZE;
  if (boardSize < 9 || boardSize > 25) {
    throw new RuleError(ERROR_CODES.INVALID_CONFIG, "Board size must be between 9 and 25.");
  }
  const winLength = Number.isInteger(input.winLength) ? input.winLength : WIN_LENGTH;
  if (winLength < 3 || winLength > boardSize) {
    throw new RuleError(ERROR_CODES.INVALID_CONFIG, "Win length is out of range.");
  }
  const playersInput = Array.isArray(input.players) ? input.players : [];
  const players = Array.from({ length: 2 }, (_, seat) => {
    const source = playersInput[seat] ?? {};
    const kind = source.kind === "ai" ? "ai" : source.kind === "agent" ? "agent" : "human";
    return {
      seat,
      name: clampName(source.name, (kind === "ai" ? "AI " : kind === "agent" ? "Agent " : "Player ") + (seat + 1)),
      kind
    };
  });
  return {
    playerCount: 2,
    boardSize,
    winLength,
    ruleSetVersion: RULESET_VERSION,
    players
  };
}

export function createGame(input = {}) {
  const config = normalizeConfig(input);
  const cellCount = config.boardSize * config.boardSize;
  const players = config.players.map((player) => ({
    seat: player.seat,
    name: player.name,
    kind: player.kind,
    color: PLAYER_COLORS[player.seat],
    stones: 0
  }));
  return {
    schemaVersion: 2,
    ruleSetVersion: config.ruleSetVersion,
    boardSize: config.boardSize,
    playerCount: 2,
    winLength: config.winLength,
    options: {
      stonesPerTurn: STONES_PER_TURN,
      firstTurnStones: FIRST_TURN_STONES
    },
    phase: PHASES.PLAY,
    cells: new Array(cellCount).fill(null),
    players,
    currentSeat: 0,
    turn: 1,
    placedThisTurn: 0,
    seq: 0,
    lastTurn: null,
    history: [],
    result: null
  };
}

export function cloneState(state) {
  return structuredClone(state);
}

export function boardCellCount(state) {
  return state.boardSize * state.boardSize;
}

export function cellIndex(state, x, y) {
  return y * state.boardSize + x;
}

export function coordFromIndex(state, index) {
  const size = state.boardSize;
  return { x: index % size, y: Math.floor(index / size) };
}

export function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.boardSize && y < state.boardSize;
}

/** Connect6 has no setup phase, so "current player" is simply the seat on the clock. */
export function currentPlayer(state) {
  return state.currentSeat === null ? null : state.players[state.currentSeat] ?? null;
}

export function activePlayers(state) {
  return state.players.filter((player) => !player.resigned);
}

export function playerAtCell(state, index) {
  const seat = state.cells[index];
  return seat === null || seat === undefined ? null : seat;
}

/** Stones this player still has to place on the current turn. */
export function stonesForTurn(turn) {
  return turn <= 1 ? FIRST_TURN_STONES : STONES_PER_TURN;
}

/** Stones still owed by the seat on the clock, i.e. how many decisions remain. */
export function stonesRemaining(state) {
  if (state.phase === PHASES.FINISHED) return 0;
  const remaining = stonesForTurn(state.turn) - (state.placedThisTurn ?? 0);
  return Math.max(0, remaining);
}

export function formatCell(state, x, y) {
  const column = COLUMN_LABELS[x] ?? "?";
  return column + String(y + 1);
}

export function parseCell(state, value) {
  if (typeof value !== "string") return null;
  const match = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(value);
  if (!match) return null;
  const x = COLUMN_LABELS.indexOf(match[1].toUpperCase());
  const y = Number(match[2]) - 1;
  if (x < 0 || !inBounds(state, x, y)) return null;
  return { x, y };
}

/** Every empty point, as coordinates. Connect6's action space is a point set, not a list. */
export function legalPoints(state) {
  if (state.phase === PHASES.FINISHED) return [];
  const points = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index] === null) points.push(coordFromIndex(state, index));
  }
  return points;
}

/**
 * Legal single placements for the next stone. Callers that need a whole turn must
 * combine `stonesForTurn(state.turn)` of them; the engine validates the set.
 */
export function getLegalActions(state) {
  return legalPoints(state).map(({ x, y }) => ({ type: "place", x, y }));
}

export function hasLegalAction(state) {
  return state.phase !== PHASES.FINISHED && state.cells.some((cell) => cell === null);
}

/**
 * One action is one stone. A `points` array of length 1 is accepted for
 * tolerance, but a multi-stone payload is rejected: the referee's decision
 * boundary is a single placement per call.
 */
export function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw new RuleError(ERROR_CODES.INVALID_ACTION, "Action must be an object.");
  }
  if (action.type !== "place") {
    throw new RuleError(
      ERROR_CODES.INVALID_ACTION,
      "Unknown action type; Connect6 has no pass and no resignation.",
      { type: action.type }
    );
  }
  let point;
  if (Array.isArray(action.points)) {
    if (action.points.length !== 1) {
      throw new RuleError(ERROR_CODES.WRONG_STONE_COUNT, "One action places exactly one stone.", {
        expected: 1,
        received: action.points.length
      });
    }
    point = action.points[0];
  } else {
    point = { x: action.x, y: action.y };
  }
  if (!point || typeof point !== "object") {
    throw new RuleError(ERROR_CODES.INVALID_ACTION, "A placement needs a point.");
  }
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RuleError(ERROR_CODES.INVALID_ACTION, "Point coordinates must be integers.");
  }
  return { type: "place", x, y };
}

/**
 * Longest consecutive run through (x, y) in one direction, counting both ways.
 * Returns the run as coordinates so callers can highlight it.
 */
export function runThrough(state, x, y, dx, dy, seat = state.cells[cellIndex(state, x, y)]) {
  if (seat === null || seat === undefined) return [];
  const run = [{ x, y }];
  for (const sign of [-1, 1]) {
    let step = 1;
    for (;;) {
      const nx = x + dx * step * sign;
      const ny = y + dy * step * sign;
      if (!inBounds(state, nx, ny)) break;
      if (state.cells[cellIndex(state, nx, ny)] !== seat) break;
      run.push({ x: nx, y: ny });
      step += 1;
    }
  }
  return run;
}

/**
 * Returns the winning line if any of `points` completes `winLength` in a row for
 * `seat`, otherwise null.
 */
export function findWinningLine(state, points, seat) {
  const need = state.winLength ?? WIN_LENGTH;
  for (const point of points) {
    for (const [dx, dy] of DIRECTIONS) {
      const run = runThrough(state, point.x, point.y, dx, dy, seat);
      if (run.length >= need) return run;
    }
  }
  return null;
}

function finish(state, { winnerSeats, line, endReason }) {
  state.phase = PHASES.FINISHED;
  state.result = computeResult(state, { winnerSeats, line, endReason });
  return state;
}

export function applyAction(state, rawAction) {
  if (!state || state.phase === PHASES.FINISHED) {
    throw new RuleError(ERROR_CODES.GAME_FINISHED, "The game is already finished.");
  }
  const action = normalizeAction(rawAction);
  if (stonesRemaining(state) <= 0) {
    throw new RuleError(ERROR_CODES.INVALID_PHASE, "This turn has no stones left to place.");
  }
  const seat = state.currentSeat;
  if (!inBounds(state, action.x, action.y)) {
    throw new RuleError(ERROR_CODES.OUT_OF_BOUNDS, "Point " + formatCell(state, action.x, action.y) + " is off the board.");
  }
  const index = cellIndex(state, action.x, action.y);
  if (state.cells[index] !== null) {
    throw new RuleError(ERROR_CODES.CELL_OCCUPIED, "Point " + formatCell(state, action.x, action.y) + " is already occupied.");
  }

  const next = cloneState(state);
  next.cells[index] = seat;
  next.players[seat].stones += 1;
  next.seq += 1;
  next.placedThisTurn = (next.placedThisTurn ?? 0) + 1;

  const point = { x: action.x, y: action.y };
  const entry = {
    seq: next.seq,
    turn: next.turn,
    seat,
    type: "place",
    points: [point],
    notation: formatCell(next, point.x, point.y)
  };
  next.history.push(entry);
  next.lastTurn = { seat, points: [point] };

  // A win is immediate, even with stones still owed on this turn.
  const line = findWinningLine(next, [point], seat);
  if (line) {
    finish(next, { winnerSeats: [seat], line, endReason: "six_in_a_row" });
    return { state: next, action: entry };
  }
  if (!next.cells.some((cell) => cell === null)) {
    finish(next, { winnerSeats: [], line: [], endReason: "board_full" });
    return { state: next, action: entry };
  }

  if (next.placedThisTurn >= stonesForTurn(next.turn)) {
    next.turn += 1;
    next.placedThisTurn = 0;
    next.currentSeat = 1 - seat;
  }
  return { state: next, action: entry };
}

export function computeResult(state, overrides = {}) {
  const existing = state.result;
  if (existing && Object.keys(overrides).length === 0) return existing;
  const winnerSeats = overrides.winnerSeats ?? existing?.winnerSeats ?? [];
  const line = overrides.line ?? existing?.line ?? [];
  const endReason = overrides.endReason ?? existing?.endReason ?? "unknown";
  const stoneCounts = state.players.map((player) => player.stones ?? 0);
  return {
    winnerSeats,
    line,
    endReason,
    stoneCounts,
    scores: stoneCounts,
    totalStones: stoneCounts.reduce((sum, count) => sum + count, 0),
    turns: state.turn,
    decisions: state.seq,
    winLength: state.winLength ?? WIN_LENGTH,
    neutralCells: 0,
    tiebreak: null
  };
}

export function notationForAction(state, action) {
  if (!action || typeof action !== "object") return "";
  if (action.type === "resign") return "resign";
  const points = Array.isArray(action.points)
    ? action.points
    : action.x !== undefined ? [{ x: action.x, y: action.y }] : [];
  return points.map((point) => formatCell(state, point.x, point.y)).join(" ");
}

export function replayActions(initialState, actions) {
  let state = cloneState(initialState);
  for (const entry of actions ?? []) {
    const action = entry && entry.action !== undefined ? entry.action : entry;
    if (!action || action.type !== "place") continue;
    state = applyAction(state, action).state;
  }
  return state;
}

export function createSummary(state) {
  const result = state.result ?? computeResult(state);
  return {
    phase: state.phase,
    turns: result.turns,
    stoneCounts: result.stoneCounts,
    winnerSeats: result.winnerSeats,
    endReason: result.endReason,
    line: result.line
  };
}

export function isFinished(state) {
  return state.phase === PHASES.FINISHED;
}

/**
 * Metrics persisted with a finished game. Kept flat and rule-specific so the
 * playtest export can aggregate without replaying anything.
 */
export function playtestMetrics(state, meta = {}) {
  const result = state.result ?? computeResult(state);
  const decisionsPerSeat = [0, 0];
  for (const entry of state.history) {
    if (entry.type !== "place") continue;
    if (entry.seat === 0 || entry.seat === 1) decisionsPerSeat[entry.seat] += 1;
  }
  const startedAt = meta.startedAt ?? null;
  const finishedAt = meta.finishedAt ?? meta.endedAt ?? null;
  const measured = startedAt !== null && finishedAt !== null ? Math.max(0, finishedAt - startedAt) : null;
  return {
    turns: result.turns,
    decisions: result.decisions,
    totalStones: result.totalStones,
    stoneCounts: result.stoneCounts,
    decisionsPerSeat,
    winnerSeats: result.winnerSeats,
    winningLineLength: Array.isArray(result.line) ? result.line.length : 0,
    endReason: result.endReason,
    boardSize: state.boardSize,
    durationMs: Number.isFinite(meta.durationMs) ? Math.max(0, meta.durationMs) : measured,
    hardestDecisionNote: typeof meta.hardestDecisionNote === "string" ? meta.hardestDecisionNote : ""
  };
}
