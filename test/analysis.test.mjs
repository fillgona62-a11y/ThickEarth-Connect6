/**
 * Contract tests for shared/analysis.js.
 *
 * The analysis output is consumed by shared/agent-protocol.js (coach grounding)
 * and by web/js/views/game.js (rendering), so the tests pin the shape as much as
 * the content. Positions are built by playing legal moves, never by editing the
 * board array, so the fixtures always match what the engine can actually reach.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyAction, createGame, PHASES } from "../shared/rules.js";
import { analyzeGame } from "../shared/analysis.js";

/** Plays a flat list of [x, y] points, one stone per entry. */
function play(state, points) {
  let current = state;
  for (const [x, y] of points) {
    current = applyAction(current, { type: "place", x, y }).state;
  }
  return current;
}

/** A fresh two-player game with recognisable names. */
function freshGame() {
  return createGame({
    players: [
      { name: "Black", kind: "human" },
      { name: "White", kind: "human" }
    ]
  });
}

/**
 * Black owns five in a row on row 10 (y = 9): A10..E10, open only at F10.
 * Turn order is 1 stone for black, then 2 per turn, so black needs three turns.
 */
function fiveForBlack() {
  return play(freshGame(), [
    [0, 9],           // turn 1, black (1 stone)
    [10, 0], [11, 0], // turn 2, white
    [1, 9], [2, 9],   // turn 3, black
    [10, 1], [11, 1], // turn 4, white
    [3, 9], [4, 9]    // turn 5, black -> five in a row at F10
  ]);
}

test("finished game produces the documented shape", () => {
  const state = play(fiveForBlack(), [
    [10, 2], [11, 2], // turn 6, white declines to block
    [5, 9]            // turn 7, black wins by six in a row
  ]);
  assert.equal(state.phase, PHASES.FINISHED);

  const analysis = analyzeGame(state);
  assert.equal(typeof analysis.summary, "object");
  assert.equal(typeof analysis.summary.headline, "string");
  assert.ok(analysis.summary.headline.length > 0);
  assert.ok(analysis.summary.headlineZh.length > 0);
  assert.deepEqual(analysis.summary.winnerSeats, [0]);
  assert.equal(analysis.summary.endReason, "six_in_a_row");
  assert.equal(analysis.summary.winningLine.length, 6);
  assert.equal(analysis.summary.scores.length, 2);
  assert.equal(analysis.summary.scores[0].rank, 1);
  assert.equal(analysis.summary.scores[0].won, true);
  assert.equal(analysis.summary.scores[1].won, false);

  for (const key of ["keyMoments", "weaknesses", "recommendations"]) {
    assert.ok(Array.isArray(analysis[key]), key + " must be an array");
  }
  for (const moment of analysis.keyMoments) {
    assert.equal(typeof moment.title, "string");
    assert.equal(typeof moment.titleZh, "string");
    assert.equal(typeof moment.detail, "string");
    assert.equal(typeof moment.detailZh, "string");
    assert.equal(typeof moment.seat, "number");
    assert.equal(typeof moment.turn, "number");
    assert.equal(typeof moment.notation, "string");
    assert.equal(typeof moment.kind, "string");
  }
  for (const weakness of analysis.weaknesses) {
    assert.equal(typeof weakness.seat, "number");
    assert.ok(["high", "medium", "low"].includes(weakness.severity));
    assert.equal(typeof weakness.code, "string");
    assert.equal(typeof weakness.detail, "string");
  }
  for (const recommendation of analysis.recommendations) {
    assert.equal(typeof recommendation.seat, "number");
    assert.equal(typeof recommendation.priority, "number");
    assert.equal(typeof recommendation.code, "string");
    assert.equal(typeof recommendation.alternative, "string");
  }

  const first = analysis.keyMoments[0];
  assert.equal(first.kind, "winning_line");
  assert.equal(first.notation, "F10");
});

test("metrics carry a per-decision timeline the coach can replay", () => {
  const state = play(fiveForBlack(), [[10, 2], [11, 2], [5, 9]]);
  const analysis = analyzeGame(state, { metrics: { durationMs: 4321 } });
  const metrics = analysis.metrics;

  assert.equal(metrics.durationMs, 4321, "stored playtest metrics are preserved");
  assert.equal(metrics.timeline.length, state.seq);
  assert.equal(metrics.decisions, state.seq);
  assert.equal(metrics.turns, state.turn);
  assert.equal(metrics.boardSize, state.boardSize);
  assert.equal(metrics.winLength, state.winLength);
  assert.equal(metrics.perPlayer.length, 2);

  for (const entry of metrics.timeline) {
    assert.equal(entry.type, "place");
    assert.equal(typeof entry.turn, "number");
    assert.equal(typeof entry.seat, "number");
    assert.match(entry.notation, /^[A-S]\d{1,2}$/);
  }
  const total = metrics.perPlayer.reduce((sum, player) => sum + player.decisions, 0);
  assert.equal(total, state.seq);
  assert.ok(Array.isArray(metrics.swings));
  assert.ok(Array.isArray(metrics.territorySwings), "legacy key stays in place");
});

test("an ignored winning point is reported as a missed win", () => {
  // Black has A10..E10 open at F10 from turn 5 on, then plays elsewhere twice.
  const state = play(fiveForBlack(), [
    [10, 2], [11, 2], // turn 6, white
    [0, 0], [1, 0],   // turn 7, black ignores F10
    [10, 3], [11, 3], // turn 8, white
    [2, 0], [3, 0],   // turn 9, black ignores F10 again
    [10, 4], [11, 4]  // turn 10, white
  ]);

  const analysis = analyzeGame(state);
  const weakness = analysis.weaknesses.find((entry) => entry.code === "missed_win");
  assert.ok(weakness, "a missed_win weakness must be reported");
  assert.equal(weakness.seat, 0);
  assert.equal(weakness.severity, "high");
  assert.ok(weakness.detail.includes("F10"), "the winning point is named: " + weakness.detail);

  const recommendation = analysis.recommendations.find((entry) => entry.code === "take_the_win");
  assert.ok(recommendation);
  assert.equal(recommendation.alternative, "F10");

  const moment = analysis.keyMoments.find((entry) => entry.kind === "missed_win");
  assert.ok(moment);
  assert.ok(moment.detail.includes("F10"));
});

test("failing to block an opponent five is reported as a blunder", () => {
  // White to move on turn 6 while black threatens F10; white plays elsewhere.
  const state = play(fiveForBlack(), [
    [10, 2], [11, 2], // turn 6, white does not block
    [5, 9]            // turn 7, black completes six
  ]);

  const analysis = analyzeGame(state);
  const weakness = analysis.weaknesses.find((entry) => entry.code === "unblocked_six");
  assert.ok(weakness, "an unblocked_six weakness must be reported");
  assert.equal(weakness.seat, 1);
  assert.equal(weakness.severity, "high");
  assert.ok(weakness.detail.includes("F10"), weakness.detail);

  const moment = analysis.keyMoments.find((entry) => entry.kind === "unanswered_threat");
  assert.ok(moment);
  assert.equal(moment.seat, 1);

  const recommendation = analysis.recommendations.find((entry) => entry.code === "block_the_six");
  assert.ok(recommendation);
  assert.equal(recommendation.alternative, "F10");
});

test("in-progress positions are analysed with a provisional result", () => {
  const state = fiveForBlack();
  assert.equal(state.phase, PHASES.PLAY);

  const analysis = analyzeGame(state);
  assert.equal(analysis.summary.inProgress, true);
  assert.deepEqual(analysis.summary.winnerSeats, []);
  assert.ok(analysis.summary.headline.startsWith("In progress"));
  assert.equal(analysis.summary.totalStones, state.seq);
  assert.equal(analysis.summary.occupiedCells, state.seq);
  assert.ok(analysis.summary.boardFullness > 0);
  assert.equal(analysis.metrics.endReason, "in_progress");
});

test("a full board without six in a row is reported as a draw", () => {
  const empty = freshGame();
  const state = {
    ...empty,
    phase: PHASES.FINISHED,
    cells: empty.cells.map((_, index) => (Math.floor(index / empty.boardSize) + index) % 2),
    result: null
  };
  // A synthetic board cannot be replayed, so the analysis must degrade, not throw.
  const analysis = analyzeGame(state);
  assert.equal(typeof analysis.summary.headline, "string");
  assert.equal(Array.isArray(analysis.keyMoments), true);
  assert.equal(analysis.metrics.replayTruncated, false);
  assert.equal(analysis.metrics.timeline.length, 0);
});

test("invalid input returns an empty, well-formed analysis", () => {
  for (const bad of [null, undefined, {}, { cells: [], players: [] }, "nope"]) {
    const analysis = analyzeGame(bad);
    assert.equal(analysis.summary.version, "thick-earth-analysis/v2");
    assert.deepEqual(analysis.keyMoments, []);
    assert.deepEqual(analysis.weaknesses, []);
    assert.deepEqual(analysis.recommendations, []);
    assert.equal(analysis.metrics.analysisError, "invalid_state");
  }
});

test("analysis never mutates the engine state", () => {
  const state = play(fiveForBlack(), [[10, 2], [11, 2], [5, 9]]);
  const snapshot = JSON.stringify(state);
  analyzeGame(state);
  assert.equal(JSON.stringify(state), snapshot);
});

test("a corrupted action log degrades to the prefix it can replay", () => {
  const state = play(fiveForBlack(), [[10, 2], [11, 2], [5, 9]]);
  const corrupted = JSON.parse(JSON.stringify(state));
  corrupted.history[4] = { type: "place", points: [{ x: 0, y: 9 }], x: 0, y: 9 };

  const analysis = analyzeGame(corrupted);
  assert.equal(analysis.metrics.replayTruncated, true);
  assert.equal(analysis.metrics.timeline.length, 4, "only the legal prefix is analysed");
  assert.equal(typeof analysis.summary.headline, "string");
});
