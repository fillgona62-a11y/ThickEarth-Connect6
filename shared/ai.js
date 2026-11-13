/**
 * Connect6 heuristic engine.
 *
 * One call answers one decision: a single stone for the seat on the clock, which
 * is the same boundary the referee's baseline get_move(board) uses.
 *
 * Strategy, in order:
 *   1. take an immediate win if one exists
 *   2. block an immediate loss if the opponent has one
 *   3. otherwise score every sensible empty point by (my gain + the opponent gain
 *      it denies) and pick the best
 *
 * `hard` additionally penalises points after which the opponent would have a win
 * available, and rewards points that create two strong threats at once, because in
 * Connect6 a double threat is what actually wins games.
 *
 * Everything is deterministic for a given (state, difficulty, seed), so a game can
 * be reproduced from its seed and its action log.
 */

import { DIRECTIONS, PHASES, WIN_LENGTH } from "./rules.js";
import {
  WIN_SCORE,
  candidatePoints,
  cellsWithStone,
  centreBias,
  pointScore,
  runAlong,
  runScore,
  winningPoints
} from "./patterns.js";

export const DEFAULT_TIME_BUDGET_MS = 600;

/** How much denying the opponent is worth relative to my own gain. */
const DEFENCE_WEIGHT = 0.85;

/** Bonus for creating two independent strong threats at once. */
const DOUBLE_THREAT_BONUS = 40_000;

/** Multiplier applied when a move leaves the opponent an immediate win. */
const LOSS_ALLOWED_PENALTY = 0.02;

function makeRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function pseudoState(state, cells) {
  return { boardSize: state.boardSize, cells };
}

/** How many axes reach a genuinely threatening level after this placement. */
function strongThreatAxes(state, x, y, seat) {
  let axes = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const { length, openEnds } = runAlong(state, x, y, dx, dy, seat);
    if (runScore(length, openEnds) >= 12_000) axes += 1;
  }
  return axes;
}

function scoreCandidate(state, point, me, opp) {
  const mine = pointScore(state, point.x, point.y, me);
  const theirs = pointScore(state, point.x, point.y, opp);
  const bonus = centreBias(state, point.x, point.y);
  return {
    point,
    attack: mine.total,
    defence: theirs.total,
    value: mine.total + theirs.total * DEFENCE_WEIGHT + bonus
  };
}

/**
 * Chooses one stone for `seat`.
 *
 * @param {object} state engine state
 * @param {{difficulty?: "easy"|"normal"|"hard", seat?: number, timeBudgetMs?: number, seed?: number}} options
 * @returns {{type: "place", x: number, y: number}|null}
 */
export function chooseAiAction(state, options = {}) {
  if (!state || state.phase === PHASES.FINISHED) return null;
  const me = Number.isInteger(options.seat) ? options.seat : state.currentSeat;
  if (!Number.isInteger(me)) return null;
  const opp = 1 - me;
  const difficulty = options.difficulty === "easy" || options.difficulty === "hard"
    ? options.difficulty
    : "normal";
  const budget = Number.isFinite(options.timeBudgetMs)
    ? Math.max(20, options.timeBudgetMs)
    : DEFAULT_TIME_BUDGET_MS;
  const deadline = Date.now() + budget;
  const random = makeRandom((Number(options.seed) || 1) + state.seq * 7919);

  // 1. Win now.
  const wins = winningPoints(state, me);
  if (wins.length > 0) {
    const best = wins
      .map((point) => scoreCandidate(state, point, me, opp))
      .sort((a, b) => b.value - a.value)[0];
    return { type: "place", x: best.point.x, y: best.point.y };
  }

  const candidates = candidatePoints(state, 2);
  if (candidates.length === 0) return null;

  // 2. Block an immediate loss, preferring the block that also helps me most.
  const threats = winningPoints(state, opp);
  if (threats.length > 0) {
    const best = threats
      .map((point) => scoreCandidate(state, point, me, opp))
      .sort((a, b) => b.value - a.value)[0];
    return { type: "place", x: best.point.x, y: best.point.y };
  }

  // 3. Score the remaining points.
  const scored = [];
  for (const point of candidates) {
    if (Date.now() > deadline) break;
    scored.push(scoreCandidate(state, point, me, opp));
  }
  if (scored.length === 0) {
    const fallback = candidates[0];
    return { type: "place", x: fallback.x, y: fallback.y };
  }
  scored.sort((a, b) => b.value - a.value);

  if (difficulty === "easy") {
    const pool = scored.slice(0, Math.min(6, scored.length));
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    return { type: "place", x: pool[index].point.x, y: pool[index].point.y };
  }

  if (difficulty === "hard") {
    const pool = scored.slice(0, Math.min(16, scored.length));
    let best = null;
    for (const entry of pool) {
      if (Date.now() > deadline) break;
      const after = pseudoState(state, cellsWithStone(state, entry.point.x, entry.point.y, me));
      const opponentWins = winningPoints(after, opp).length;
      const axes = strongThreatAxes(after, entry.point.x, entry.point.y, me);
      let value = entry.value + (axes >= 2 ? DOUBLE_THREAT_BONUS : 0);
      if (opponentWins > 0) value *= LOSS_ALLOWED_PENALTY;
      if (!best || value > best.value) best = { value, point: entry.point };
    }
    const chosen = best ? best.point : scored[0].point;
    return { type: "place", x: chosen.x, y: chosen.y };
  }

  return { type: "place", x: scored[0].point.x, y: scored[0].point.y };
}

/**
 * Static evaluation of a position from `seat`'s perspective, positive when the
 * seat is ahead. Used by the analysis engine to judge a move in hindsight.
 */
export function evaluatePosition(state, seat) {
  let mine = 0;
  let theirs = 0;
  const size = state.boardSize;
  for (let index = 0; index < state.cells.length; index += 1) {
    const owner = state.cells[index];
    if (owner === null) continue;
    const x = index % size;
    const y = (index - x) / size;
    const { total } = pointScore(state, x, y, owner);
    if (owner === seat) mine += total;
    else theirs += total;
  }
  return mine - theirs;
}

/** True when `seat` has a point that completes the win length right now. */
export function hasWinningThreat(state, seat) {
  return winningPoints(state, seat).length > 0;
}

export { WIN_LENGTH, WIN_SCORE };
