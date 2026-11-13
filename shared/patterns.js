/**
 * Connect6 pattern primitives.
 *
 * Shared by the heuristic AI and by the analysis engine so that "how good is this
 * point" has exactly one definition in the product. Everything here is pure and
 * operates on the engine state from shared/rules.js.
 *
 * A point is scored by looking along the four axes through it and classifying the
 * run of same-colour stones that the placement would join, together with how many
 * ends of that run are still open. An open end is what makes a run extendable, so
 * openness dominates the score.
 */

import { DIRECTIONS, WIN_LENGTH, cellIndex, inBounds } from "./rules.js";

/** Score floor for a run that already wins the game. */
export const WIN_SCORE = 1_000_000_000;

/**
 * Value of a run of `length` stones with `openEnds` free ends, for the player who
 * owns the run. `length` includes the stone being considered.
 */
export function runScore(length, openEnds) {
  if (length >= WIN_LENGTH) return WIN_SCORE;
  if (openEnds === 0 && length < WIN_LENGTH - 1) return 0;
  switch (length) {
    case 5:
      return openEnds >= 1 ? 5_000_000 : 400_000;
    case 4:
      return openEnds === 2 ? 120_000 : openEnds === 1 ? 12_000 : 0;
    case 3:
      return openEnds === 2 ? 6_000 : openEnds === 1 ? 600 : 0;
    case 2:
      return openEnds === 2 ? 300 : openEnds === 1 ? 60 : 0;
    default:
      return openEnds === 2 ? 20 : 8;
  }
}

/**
 * Length and openness of the run that `seat` would own at (x, y) along one axis,
 * assuming (x, y) is empty or already counted.
 */
export function runAlong(state, x, y, dx, dy, seat) {
  const size = state.boardSize;
  let length = 1;
  let openEnds = 0;
  for (const sign of [-1, 1]) {
    let step = 1;
    for (;;) {
      const nx = x + dx * step * sign;
      const ny = y + dy * step * sign;
      if (!inBounds(state, nx, ny)) break;
      const cell = state.cells[ny * size + nx];
      if (cell === seat) {
        length += 1;
        step += 1;
        continue;
      }
      if (cell === null) openEnds += 1;
      break;
    }
  }
  return { length, openEnds };
}

/**
 * Total pattern value of placing `seat` at (x, y). Sums the four axes.
 */
export function pointScore(state, x, y, seat) {
  let total = 0;
  let best = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const { length, openEnds } = runAlong(state, x, y, dx, dy, seat);
    const score = runScore(length, openEnds);
    total += score;
    if (score > best) best = score;
  }
  return { total, best };
}

/** How many axes would produce a run of at least `needed` after placing here. */
export function threatCount(state, x, y, seat, needed = WIN_LENGTH) {
  let count = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const { length } = runAlong(state, x, y, dx, dy, seat);
    if (length >= needed) count += 1;
  }
  return count;
}

/** Points where `seat` would immediately complete the win length. */
export function winningPoints(state, seat) {
  const points = [];
  const size = state.boardSize;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index] !== null) continue;
    const x = index % size;
    const y = (index - x) / size;
    if (threatCount(state, x, y, seat) > 0) points.push({ x, y });
  }
  return points;
}

/**
 * Empty points worth considering: those within `radius` of an existing stone.
 * Connect6 is a placing game, so moves far from every stone are almost never
 * useful and pruning them keeps the search cheap.
 */
export function candidatePoints(state, radius = 2) {
  const size = state.boardSize;
  const seen = new Set();
  const points = [];
  let anyStone = false;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index] === null) continue;
    anyStone = true;
    const x = index % size;
    const y = (index - x) / size;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(state, nx, ny)) continue;
        const neighbour = ny * size + nx;
        if (state.cells[neighbour] !== null) continue;
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        points.push({ x: nx, y: ny });
      }
    }
  }
  if (!anyStone) {
    const center = Math.floor(size / 2);
    return [{ x: center, y: center }];
  }
  return points;
}

/** Distance from the centre, used only as a tiny tie-breaker. */
export function centreBias(state, x, y) {
  const center = (state.boardSize - 1) / 2;
  const distance = Math.abs(x - center) + Math.abs(y - center);
  return Math.max(0, state.boardSize - distance);
}

/** A copy of the cells array with one stone added, for lookahead. */
export function cellsWithStone(state, x, y, seat) {
  const cells = state.cells.slice();
  cells[cellIndex(state, x, y)] = seat;
  return cells;
}
