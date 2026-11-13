/**
 * Connect6 engine tests.
 *
 * The referee's decision boundary is one stone per call, so every assertion here
 * places a single stone and checks the turn bookkeeping that follows.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_SIZE,
  ERROR_CODES,
  PHASES,
  RuleError,
  WIN_LENGTH,
  applyAction,
  computeResult,
  createGame,
  formatCell,
  getLegalActions,
  parseCell,
  playtestMetrics,
  replayActions,
  stonesRemaining
} from "../shared/rules.js";

function place(state, x, y) {
  return applyAction(state, { type: "place", x, y }).state;
}

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RuleError, "expected a RuleError, got " + error);
    assert.equal(error.code, code);
    return true;
  });
}

test("a new game is a 19x19 board with black on the clock for one stone", () => {
  const state = createGame({ playerCount: 2 });
  assert.equal(state.boardSize, BOARD_SIZE);
  assert.equal(state.phase, PHASES.PLAY);
  assert.equal(state.winLength, WIN_LENGTH);
  assert.equal(state.currentSeat, 0);
  assert.equal(state.turn, 1);
  assert.equal(stonesRemaining(state), 1);
  assert.equal(state.cells.length, BOARD_SIZE * BOARD_SIZE);
  assert.ok(state.cells.every((cell) => cell === null));
  assert.equal(getLegalActions(state).length, BOARD_SIZE * BOARD_SIZE);
});

test("one action is one stone, and a turn keeps the same seat for two decisions", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 9, 9);
  assert.equal(state.currentSeat, 1);
  assert.equal(state.turn, 2);
  assert.equal(stonesRemaining(state), 2);

  state = place(state, 0, 0);
  assert.equal(state.currentSeat, 1, "white is still on the clock");
  assert.equal(state.turn, 2, "the turn has not advanced yet");
  assert.equal(stonesRemaining(state), 1);

  state = place(state, 1, 0);
  assert.equal(state.currentSeat, 0, "the clock passes back to black");
  assert.equal(state.turn, 3);
  assert.equal(stonesRemaining(state), 2);
  assert.equal(state.cells[0], 1);
  assert.equal(state.cells[1], 1);
});

test("one action cannot place two stones", () => {
  const state = createGame({ playerCount: 2 });
  expectRuleError(
    () => applyAction(state, { type: "place", points: [{ x: 9, y: 9 }, { x: 9, y: 8 }] }),
    ERROR_CODES.WRONG_STONE_COUNT
  );
});

test("pass and resignation are not actions in this game", () => {
  const state = createGame({ playerCount: 2 });
  expectRuleError(() => applyAction(state, { type: "pass" }), ERROR_CODES.INVALID_ACTION);
  expectRuleError(() => applyAction(state, { type: "resign" }), ERROR_CODES.INVALID_ACTION);
});

test("occupied and off-board points are rejected", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 9, 9);
  expectRuleError(() => place(state, 9, 9), ERROR_CODES.CELL_OCCUPIED);
  expectRuleError(() => place(state, -1, 0), ERROR_CODES.OUT_OF_BOUNDS);
  expectRuleError(() => place(state, 0, BOARD_SIZE), ERROR_CODES.OUT_OF_BOUNDS);
});

/** White filler decisions that never line up six: row 19 with a gap between each. */
const WHITE_FILLER = [[[0, 18], [2, 18]], [[4, 18], [6, 18]], [[8, 18], [10, 18]]];

function applyWhiteFiller(state, round) {
  let next = state;
  for (const [x, y] of WHITE_FILLER[round]) next = place(next, x, y);
  return next;
}

test("six in a row wins immediately, and the winning line is reported", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 0, 0);
  state = applyWhiteFiller(state, 0);
  state = place(state, 1, 0);
  state = place(state, 2, 0);
  state = applyWhiteFiller(state, 1);
  state = place(state, 3, 0);
  state = place(state, 4, 0);
  state = applyWhiteFiller(state, 2);
  assert.equal(state.phase, PHASES.PLAY);

  state = place(state, 5, 0);
  assert.equal(state.phase, PHASES.FINISHED);
  assert.deepEqual(state.result.winnerSeats, [0]);
  assert.equal(state.result.endReason, "six_in_a_row");
  assert.equal(state.result.line.length, 6);
  assert.deepEqual(state.result.stoneCounts, [6, 6]);
});

test("a win needs the full six, not five", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 0, 0);
  state = applyWhiteFiller(state, 0);
  state = place(state, 1, 0);
  state = place(state, 2, 0);
  state = applyWhiteFiller(state, 1);
  state = place(state, 3, 0);
  state = place(state, 4, 0);
  assert.equal(state.phase, PHASES.PLAY, "five in a row is not a win");
});

test("a diagonal run also wins", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 0, 0);
  state = applyWhiteFiller(state, 0);
  state = place(state, 1, 1);
  state = place(state, 2, 2);
  state = applyWhiteFiller(state, 1);
  state = place(state, 3, 3);
  state = place(state, 4, 4);
  state = applyWhiteFiller(state, 2);
  state = place(state, 5, 5);
  assert.equal(state.phase, PHASES.FINISHED);
  assert.deepEqual(state.result.winnerSeats, [0]);
  assert.equal(state.result.line.length, 6);
});

test("a finished game refuses further moves", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 0, 0);
  state = applyWhiteFiller(state, 0);
  state = place(state, 1, 0);
  state = place(state, 2, 0);
  state = applyWhiteFiller(state, 1);
  state = place(state, 3, 0);
  state = place(state, 4, 0);
  state = applyWhiteFiller(state, 2);
  state = place(state, 5, 0);
  expectRuleError(() => place(state, 10, 10), ERROR_CODES.GAME_FINISHED);
});

test("replaying the action log reproduces the final position exactly", () => {
  const initial = createGame({ playerCount: 2 });
  let state = createGame({ playerCount: 2 });
  state = place(state, 9, 9);
  state = place(state, 9, 8);
  state = place(state, 8, 9);
  state = place(state, 10, 9);
  state = place(state, 10, 10);
  state = place(state, 8, 8);
  const replayed = replayActions(initial, state.history);
  assert.deepEqual(replayed, state);
  assert.deepEqual(computeResult(replayed), computeResult(state));
});

test("cell notation round-trips", () => {
  const state = createGame({ playerCount: 2 });
  assert.equal(formatCell(state, 0, 0), "A1");
  assert.equal(formatCell(state, 18, 18), "S19");
  assert.deepEqual(parseCell(state, "S19"), { x: 18, y: 18 });
  assert.deepEqual(parseCell(state, "a1"), { x: 0, y: 0 });
  assert.equal(parseCell(state, "T1"), null);
  assert.equal(parseCell(state, "A20"), null);
});

test("playtest metrics summarise a finished game", () => {
  let state = createGame({ playerCount: 2 });
  state = place(state, 0, 0);
  state = applyWhiteFiller(state, 0);
  state = place(state, 1, 0);
  state = place(state, 2, 0);
  state = applyWhiteFiller(state, 1);
  state = place(state, 3, 0);
  state = place(state, 4, 0);
  state = applyWhiteFiller(state, 2);
  state = place(state, 5, 0);
  const metrics = playtestMetrics(state, { startedAt: 1000, finishedAt: 4000 });
  assert.deepEqual(metrics.stoneCounts, [6, 6]);
  assert.deepEqual(metrics.winnerSeats, [0]);
  assert.equal(metrics.totalStones, 12);
  assert.equal(metrics.decisions, 12);
  assert.equal(metrics.durationMs, 3000);
  assert.equal(metrics.winningLineLength, 6);
  assert.deepEqual(metrics.decisionsPerSeat, [6, 6]);
});
