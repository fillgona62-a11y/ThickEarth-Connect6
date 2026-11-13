/**
 * Heuristic engine tests: legality, tactics, determinism, and self-play liveness.
 *
 * Turns alternate black [1 stone], white [2], black [2], ... so the helpers below
 * always place a whole turn and assert that the clock actually flipped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PHASES, applyAction, createGame, stonesRemaining } from "../shared/rules.js";
import { chooseAiAction } from "../shared/ai.js";

function place(state, x, y) {
  return applyAction(state, { type: "place", x, y }).state;
}

function playTurn(state, points) {
  const before = state.currentSeat;
  const owed = stonesRemaining(state);
  assert.equal(points.length, owed, "a turn must place exactly the stones it owes");
  let next = state;
  for (const [x, y] of points) next = place(next, x, y);
  assert.notEqual(next.currentSeat, before, "the clock must pass after a full turn");
  return next;
}

function isLegal(state, action) {
  if (!action || action.type !== "place") return false;
  if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) return false;
  if (action.x < 0 || action.y < 0) return false;
  if (action.x >= state.boardSize || action.y >= state.boardSize) return false;
  return state.cells[action.y * state.boardSize + action.x] === null;
}

/** Black builds five in a row on row 1 while white fills row 19 with gaps. */
function fiveInARowPosition() {
  let state = createGame({ playerCount: 2 });
  state = playTurn(state, [[9, 9]]);                 // black opens
  state = playTurn(state, [[0, 18], [2, 18]]);       // white
  state = playTurn(state, [[0, 0], [1, 0]]);         // black 3
  state = playTurn(state, [[4, 18], [6, 18]]);       // white
  state = playTurn(state, [[2, 0], [3, 0]]);         // black 5
  state = playTurn(state, [[8, 18], [10, 18]]);      // white
  state = playTurn(state, [[4, 0], [11, 11]]);       // black 6, five in a row
  return state;
}

test("the first decision on an empty board is the centre point", () => {
  const state = createGame({ playerCount: 2 });
  assert.deepEqual(chooseAiAction(state, { seat: 0, difficulty: "normal" }), { type: "place", x: 9, y: 9 });
});

test("the engine blocks an immediate loss", () => {
  const state = fiveInARowPosition();
  assert.equal(state.currentSeat, 1, "white defends");
  const action = chooseAiAction(state, { seat: 1, difficulty: "normal" });
  assert.deepEqual(action, { type: "place", x: 5, y: 0 }, "F1 is the only block");
  const after = place(state, action.x, action.y);
  assert.equal(after.phase, PHASES.PLAY, "the block must prevent the loss");
  assert.equal(after.cells[5], 1, "white took F1");
});

test("the engine takes an immediate win", () => {
  let state = fiveInARowPosition();
  state = playTurn(state, [[12, 12], [14, 14]]);     // white, harmless
  assert.equal(state.currentSeat, 0, "black is on the clock with five in a row");
  const action = chooseAiAction(state, { seat: 0, difficulty: "normal" });
  assert.deepEqual(action, { type: "place", x: 5, y: 0 }, "F1 completes six");
  const after = place(state, action.x, action.y);
  assert.equal(after.phase, PHASES.FINISHED, "black should win immediately");
  assert.deepEqual(after.result.winnerSeats, [0]);
  assert.equal(after.result.endReason, "six_in_a_row");
});

test("the same seed and position produce the same move", () => {
  let state = createGame({ playerCount: 2 });
  state = playTurn(state, [[9, 9]]);
  state = place(state, 10, 10);
  const a = chooseAiAction(state, { seat: 1, difficulty: "normal", seed: 42 });
  const b = chooseAiAction(state, { seat: 1, difficulty: "normal", seed: 42 });
  assert.deepEqual(a, b);
});

test("self-play reaches a finished game with legal moves only", () => {
  let state = createGame({ playerCount: 2 });
  let decisions = 0;
  while (state.phase !== PHASES.FINISHED && decisions < 400) {
    const action = chooseAiAction(state, {
      seat: state.currentSeat,
      difficulty: "normal",
      timeBudgetMs: 200,
      seed: decisions + 1
    });
    assert.ok(isLegal(state, action), "decision " + decisions + " was illegal: " + JSON.stringify(action));
    state = place(state, action.x, action.y);
    decisions += 1;
  }
  assert.equal(state.phase, PHASES.FINISHED, "self-play must terminate");
  assert.equal(decisions, state.seq);
  assert.equal(state.result.endReason, "six_in_a_row");
  assert.ok(state.result.line.length >= 6);
  assert.equal(state.result.winnerSeats.length, 1);
});

test("hard difficulty never returns an occupied point", () => {
  let state = createGame({ playerCount: 2 });
  for (let step = 0; step < 40; step += 1) {
    const action = chooseAiAction(state, { seat: state.currentSeat, difficulty: "hard", timeBudgetMs: 200 });
    assert.ok(isLegal(state, action), "illegal move at step " + step);
    state = place(state, action.x, action.y);
    if (state.phase === PHASES.FINISHED) break;
  }
});

test("a harder opponent beats an easier one over a match", () => {
  let hardWins = 0;
  for (let game = 0; game < 3; game += 1) {
    let state = createGame({ playerCount: 2 });
    const hardSeat = game % 2;
    let guard = 0;
    while (state.phase !== PHASES.FINISHED && guard < 400) {
      const seat = state.currentSeat;
      const action = chooseAiAction(state, {
        seat,
        difficulty: seat === hardSeat ? "hard" : "easy",
        timeBudgetMs: 150,
        seed: guard + game * 1000
      });
      state = place(state, action.x, action.y);
      guard += 1;
    }
    assert.equal(state.phase, PHASES.FINISHED);
    if (state.result.winnerSeats[0] === hardSeat) hardWins += 1;
  }
  assert.ok(hardWins >= 2, "expected the hard engine to win at least two of three, got " + hardWins);
});
