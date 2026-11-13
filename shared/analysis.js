/**
 * ThickEarth grounded post-game analysis.
 *
 * Pure, deterministic analysis of a Connect6 engine state. Every sentence this
 * module emits is derived from data the engine already has: the ordered action
 * log, the pattern primitives in shared/patterns.js, the heuristic recommendation
 * from shared/ai.js and the final result. No LLM, no network, no randomness, and
 * the input state is never mutated.
 *
 * Decision boundary: one applied action is ONE stone, exactly like the referee's
 * baseline `get_move(board)`. A turn spans one or two decisions by the same seat,
 * and the analysis reports both granularities: `summary.turns` is turns,
 * `summary.decisions` is stones.
 *
 * The returned shape is a contract with shared/agent-protocol.js (coach grounding)
 * and with web/js/views/game.js (rendering). Do not rename these keys:
 *
 *   analyzeGame(state, { metrics } = {}) -> {
 *     summary,          // headline, resultLine, per-seat stone table, winning line
 *     keyMoments,       // {seat, turn, notation, kind, severity, title, detail}
 *     weaknesses,       // {seat, severity, code, title, detail}
 *     recommendations,  // {seat, priority, code, title, detail, alternative}
 *     metrics           // {timeline, perPlayer, swings, ...}
 *   }
 *
 * Every human-facing string exists in English (`title`) and Chinese (`titleZh`),
 * because the UI picks one and the coach prompt picks one.
 */

import {
  DIRECTIONS,
  FIRST_TURN_STONES,
  PHASES,
  RULESET_VERSION,
  STONES_PER_TURN,
  WIN_LENGTH,
  applyAction,
  computeResult,
  createGame,
  formatCell
} from "./rules.js";
import { WIN_SCORE, centreBias, pointScore, runAlong, runScore, winningPoints } from "./patterns.js";
import { chooseAiAction } from "./ai.js";

export const ANALYSIS_VERSION = "thick-earth-analysis/v2";

/** Hard caps so a 300-decision game cannot produce a megabyte of JSON. */
const MAX_TIMELINE = 400;
const TIMELINE_HEAD = 60;
const MAX_KEY_MOMENTS = 12;
const MAX_LIST = 10;
const MAX_EVIDENCE = 4;

/** Time budget for the per-decision reference moves; the cheap pass has no cap. */
const DETAIL_BUDGET_MS = 3000;

/** Mirrors DEFENCE_WEIGHT in shared/ai.js so "value" means the same thing here. */
const DEFENCE_WEIGHT = 0.85;

/** Run-score bands, aligned with runScore() in shared/patterns.js. */
const SCORE_FIVE = 5_000_000;
const SCORE_OPEN_FOUR = 120_000;
const SCORE_OPEN_THREE = 6_000;
const SCORE_OPEN_TWO = 300;
/** A two-in-a-row with one open end. Anything below this joined nothing. */
const SCORE_TWO = 60;

/** Swings are capped so a completed six does not dwarf every other number. */
const MAX_SWING = 1_000_000;

const END_REASON_TEXT = Object.freeze({
  six_in_a_row: "six in a row",
  board_full: "the board filled up",
  in_progress: "still in progress",
  unknown: "unknown"
});

const END_REASON_ZH = Object.freeze({
  six_in_a_row: "连成六子",
  board_full: "棋盘填满",
  in_progress: "对局进行中",
  unknown: "原因未知"
});

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function round(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function seatLabel(seat) {
  return "P" + (seat + 1);
}

function playerName(state, seat) {
  const player = safeArray(state.players)[seat];
  return player && typeof player.name === "string" && player.name ? player.name : seatLabel(seat);
}

function playerColor(state, seat) {
  const player = safeArray(state.players)[seat];
  if (player && typeof player.color === "string") return player.color;
  return seat === 0 ? "black" : "white";
}

function playerKind(state, seat) {
  const player = safeArray(state.players)[seat];
  return player && typeof player.kind === "string" ? player.kind : "human";
}

/** Human display name; avoids "P1 P1" when the player is still called P1. */
function displayName(state, seat) {
  const name = playerName(state, seat);
  return name === seatLabel(seat) ? "Player " + (seat + 1) : name;
}

/** Chinese display name, e.g. "玩家1（P1）"; custom names are kept verbatim. */
function displayNameZh(state, seat) {
  const name = playerName(state, seat);
  const isDefault = name === seatLabel(seat) || name === "Player " + (seat + 1);
  const base = isDefault ? "玩家" + (seat + 1) : name;
  return base + "（" + seatLabel(seat) + "）";
}

function colourWord(state, seat, language) {
  const colour = playerColor(state, seat);
  if (language === "zh") return colour === "black" ? "黑方" : "白方";
  return colour === "black" ? "Black" : "White";
}

/**
 * Colour prefix for prose, suppressed when the player's own name already says it
 * — "Black Black wins" is what happens otherwise.
 */
function colourPrefix(state, seat, name, language) {
  const colour = colourWord(state, seat, language);
  const bare = language === "zh" ? colour.replace("方", "") : colour;
  return name.includes(bare) ? "" : colour + " ";
}

function plural(count, singular, pluralForm) {
  if (count === 1) return singular;
  return pluralForm || singular + "s";
}

function notationOf(state, point) {
  if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) return "";
  return formatCell(state, point.x, point.y);
}

function formatCellList(state, points, max) {
  const list = safeArray(points).slice(0, max || MAX_EVIDENCE).map((point) => notationOf(state, point));
  return list.join(" ");
}

/** Coarse name for the winning axis, used in prose only. */
function axisNameOf(line) {
  const cells = safeArray(line);
  if (cells.length < 2) return { en: "a line", zh: "一条直线" };
  const dx = Math.sign(cells[1].x - cells[0].x);
  const dy = Math.sign(cells[1].y - cells[0].y);
  if (dy === 0) return { en: "a row", zh: "横线" };
  if (dx === 0) return { en: "a column", zh: "竖线" };
  return dx * dy > 0
    ? { en: "the main diagonal", zh: "主对角线" }
    : { en: "the anti-diagonal", zh: "副对角线" };
}

/** Human label for a shape band, so weaknesses read like coaching and not like constants. */
function shapeOf(bestScore) {
  if (bestScore >= WIN_SCORE) return { code: "six", en: "a completed six", zh: "连成六子" };
  if (bestScore >= SCORE_FIVE) return { code: "five", en: "a five with an open end", zh: "冲五（再一子即成六）" };
  if (bestScore >= SCORE_OPEN_FOUR) return { code: "open_four", en: "an open four", zh: "活四" };
  if (bestScore >= SCORE_OPEN_THREE) return { code: "open_three", en: "an open three", zh: "活三" };
  if (bestScore >= SCORE_OPEN_TWO) return { code: "open_two", en: "an open two", zh: "活二" };
  if (bestScore >= SCORE_TWO) return { code: "closed_two", en: "a two with one open end", zh: "眠二" };
  return { code: "loose", en: "no connection at all", zh: "没有任何连子" };
}

function endReasonText(reason, language) {
  const table = language === "zh" ? END_REASON_ZH : END_REASON_TEXT;
  return table[reason] || table.unknown;
}

/* ------------------------------------------------------------------------- */
/* Replay                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Rebuilds the game from its ordered action log. `before[i]` is the exact state
 * the i-th decision was made in, `records[i]` describes that decision.
 *
 * A malformed or historically incompatible log stops the replay at the first bad
 * entry; everything before it stays usable, which is what we want for analysis.
 */
function replayGame(state) {
  const history = safeArray(state.history);
  const players = safeArray(state.players).map((player) => ({
    name: player && player.name,
    kind: player && player.kind
  }));
  let current;
  try {
    current = createGame({
      playerCount: 2,
      boardSize: state.boardSize,
      winLength: state.winLength,
      players
    });
  } catch (error) {
    return { final: null, before: [], records: [], truncated: false };
  }
  const before = [];
  const records = [];
  for (const entry of history) {
    if (!entry || entry.type !== "place") continue;
    const point = Array.isArray(entry.points) && entry.points.length === 1
      ? entry.points[0]
      : { x: entry.x, y: entry.y };
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) continue;
    const snapshot = current;
    let applied;
    try {
      applied = applyAction(current, { type: "place", x: point.x, y: point.y });
    } catch (error) {
      return { final: current, before, records, truncated: true };
    }
    before.push(snapshot);
    records.push({
      decision: records.length + 1,
      seq: applied.action.seq,
      turn: applied.action.turn,
      seat: applied.action.seat,
      x: point.x,
      y: point.y,
      notation: applied.action.notation
    });
    current = applied.state;
  }
  return { final: current, before, records, truncated: false };
}

/* ------------------------------------------------------------------------- */
/* Per-decision evaluation                                                   */
/* ------------------------------------------------------------------------- */

/** Same blend the AI optimises, so a "better move" always means the same thing. */
function heuristicValue(before, x, y, seat) {
  const opponent = 1 - seat;
  const attack = pointScore(before, x, y, seat).total;
  const defence = pointScore(before, x, y, opponent).total;
  return attack + defence * DEFENCE_WEIGHT + centreBias(before, x, y);
}

/**
 * Static balance of a position from `seat`'s point of view.
 *
 * Deliberately not ai.evaluatePosition(): that one lets a five score 5,000,000
 * and a six 1,000,000,000, so every single move would look like a multi-million
 * point swing. Capping each stone's contribution at an open four keeps the
 * decision-to-decision delta readable as a positional change.
 */
function patternBalance(state, seat) {
  const size = state.boardSize;
  let mine = 0;
  let theirs = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const owner = state.cells[index];
    if (owner === null || owner === undefined) continue;
    const x = index % size;
    const y = (index - x) / size;
    const value = Math.min(pointScore(state, x, y, owner).best, SCORE_OPEN_FOUR);
    if (owner === seat) mine += value;
    else theirs += value;
  }
  return mine - theirs;
}

function samePoint(a, b) {
  return Boolean(a) && Boolean(b) && a.x === b.x && a.y === b.y;
}

function containsPoint(points, x, y) {
  return safeArray(points).some((point) => point.x === x && point.y === y);
}

/**
 * Walks every decision once and produces the flat record the rest of the module
 * (and the timeline in metrics) is built from.
 *
 * Two tiers of work:
 *   - always: threat lists, axis shapes, pattern values, board balance
 *   - while inside DETAIL_BUDGET_MS: the heuristic reference move, used to say
 *     "X was available and worth more"
 */
function analyseDecisions(context) {
  const { state, result, replay } = context;
  const started = Date.now();
  const decisions = [];
  const reason = result.endReason;
  const winners = safeArray(result.winnerSeats);
  const lastIndex = replay.records.length - 1;

  for (let index = 0; index < replay.records.length; index += 1) {
    const record = replay.records[index];
    const before = replay.before[index];
    if (!before) continue;
    const seat = record.seat;
    const opponent = 1 - seat;
    const winsAvailable = winningPoints(before, seat);
    const threatsFaced = winningPoints(before, opponent);
    const attack = pointScore(before, record.x, record.y, seat);
    const defence = pointScore(before, record.x, record.y, opponent);

    const axes = [];
    for (const [dx, dy] of DIRECTIONS) {
      const run = runAlong(before, record.x, record.y, dx, dy, seat);
      axes.push({ dx, dy, length: run.length, openEnds: run.openEnds, score: runScore(run.length, run.openEnds) });
    }
    axes.sort((a, b) => b.score - a.score);
    const bestAxis = axes[0] || { length: 0, openEnds: 0, score: 0 };
    const strongAxes = axes.filter((axis) => axis.score >= SCORE_OPEN_FOUR).length;
    const fiveAxes = axes.filter((axis) => axis.score >= SCORE_FIVE).length;

    const after = index + 1 < replay.before.length ? replay.before[index + 1] : replay.final;
    let swing = 0;
    if (after) {
      try {
        swing = clamp(patternBalance(after, seat) - patternBalance(before, seat), -MAX_SWING, MAX_SWING);
      } catch (error) {
        swing = 0;
      }
    }

    const tookAvailableWin = containsPoint(winsAvailable, record.x, record.y);
    const answeredThreat = containsPoint(threatsFaced, record.x, record.y);
    const endedGame = index === lastIndex && reason === "six_in_a_row" && winners.includes(seat);

    let reference = null;
    let referenceValue = 0;
    if (Date.now() - started < DETAIL_BUDGET_MS && !endedGame) {
      try {
        const suggestion = chooseAiAction(before, { seat, difficulty: "normal", seed: 20260101 });
        if (suggestion && Number.isInteger(suggestion.x)) {
          reference = { x: suggestion.x, y: suggestion.y };
          referenceValue = heuristicValue(before, reference.x, reference.y, seat);
        }
      } catch (error) {
        reference = null;
      }
    }

    let quality;
    const value = attack.total + defence.total * DEFENCE_WEIGHT + centreBias(before, record.x, record.y);
    let ratio = null;
    if (endedGame) {
      quality = "winning";
    } else if (winsAvailable.length > 0) {
      quality = tookAvailableWin ? "winning" : "missed_win";
    } else if (threatsFaced.length > 0) {
      quality = answeredThreat ? "critical_block" : "blunder";
    } else if (reference && referenceValue > 0) {
      ratio = value / referenceValue;
      quality = ratio >= 0.98 ? "best" : ratio >= 0.8 ? "good" : ratio >= 0.45 ? "ok" : "loose";
    } else {
      quality = "unrated";
    }

    decisions.push({
      decision: record.decision,
      seq: record.seq,
      turn: record.turn,
      seat,
      x: record.x,
      y: record.y,
      notation: record.notation,
      attack: attack.total,
      defence: defence.total,
      value: round(value, 1),
      ratio: ratio === null ? null : round(ratio, 3),
      bestAxisScore: bestAxis.score,
      bestAxis: { length: bestAxis.length, openEnds: bestAxis.openEnds },
      strongAxes,
      fiveAxes,
      winsAvailable: winsAvailable.length,
      threatsFaced: threatsFaced.length,
      winPoint: winsAvailable[0] || null,
      threatPoint: threatsFaced[0] || null,
      tookAvailableWin,
      answeredThreat,
      endedGame,
      reference,
      referenceValue: round(referenceValue, 1),
      quality,
      swing: round(swing, 1)
    });
  }
  return decisions;
}

/* ------------------------------------------------------------------------- */
/* Key moments                                                               */
/* ------------------------------------------------------------------------- */

function moment(entry) {
  return {
    seat: entry.seat,
    turn: entry.turn,
    notation: entry.notation,
    kind: entry.kind,
    severity: entry.severity,
    weight: entry.weight,
    title: entry.title,
    titleZh: entry.titleZh,
    detail: entry.detail,
    detailZh: entry.detailZh
  };
}

function buildKeyMoments(context) {
  const { state, result, decisions, replay } = context;
  const moments = [];
  const axis = axisNameOf(result.line);
  const lineLength = safeArray(result.line).length;
  const winnerSeat = safeArray(result.winnerSeats)[0];
  const lastRecord = replay.records[replay.records.length - 1] || null;

  if (result.endReason === "six_in_a_row" && Number.isInteger(winnerSeat) && lastRecord) {
    moments.push(moment({
      seat: winnerSeat,
      turn: lastRecord.turn,
      notation: lastRecord.notation,
      kind: "winning_line",
      severity: "high",
      weight: 1000,
      title: "Six in a row",
      titleZh: "连成六子",
      detail: "Turn " + lastRecord.turn + ": " + lastRecord.notation + " closed a line of "
        + lineLength + " on " + axis.en + ".",
      detailZh: "第 " + lastRecord.turn + " 回合，" + lastRecord.notation + " 在" + axis.zh
        + "上连成 " + lineLength + " 子。"
    }));
  }

  for (const decision of decisions) {
    if (decision.quality === "missed_win") {
      const win = decision.winPoint;
      moments.push(moment({
        seat: decision.seat,
        turn: decision.turn,
        notation: decision.notation,
        kind: "missed_win",
        severity: "high",
        weight: 900,
        title: "Winning stone left on the board",
        titleZh: "错过了制胜的一手",
        detail: "Turn " + decision.turn + ": " + decision.notation + " ignored "
          + notationOf(state, win) + ", which would have completed six immediately.",
        detailZh: "第 " + decision.turn + " 回合，" + decision.notation + " 没有走 "
          + notationOf(state, win) + "，那一手可以直接连成六子。"
      }));
    }

    if (decision.quality === "blunder") {
      const threat = decision.threatPoint;
      moments.push(moment({
        seat: decision.seat,
        turn: decision.turn,
        notation: decision.notation,
        kind: "unanswered_threat",
        severity: "high",
        weight: 880,
        title: "Immediate six not blocked",
        titleZh: "没有挡住对手的连六",
        detail: "Turn " + decision.turn + ": the opponent already had a winning point at "
          + notationOf(state, threat) + " and " + decision.notation + " played elsewhere.",
        detailZh: "第 " + decision.turn + " 回合，对手在 " + notationOf(state, threat)
          + " 已经有连六的点，但 " + decision.notation + " 走了别处。"
      }));
    }

    if (decision.strongAxes >= 2) {
      moments.push(moment({
        seat: decision.seat,
        turn: decision.turn,
        notation: decision.notation,
        kind: "double_threat",
        severity: "medium",
        weight: 620,
        title: "Double threat",
        titleZh: "形成双威胁",
        detail: "Turn " + decision.turn + ": " + decision.notation + " created threats on "
          + decision.strongAxes + " axes at once.",
        detailZh: "第 " + decision.turn + " 回合，" + decision.notation
          + " 同时在 " + decision.strongAxes + " 条线上形成威胁。"
      }));
    }

    if (decision.winsAvailable > 0 && decision.threatsFaced > 0 && !decision.endedGame) {
      moments.push(moment({
        seat: decision.seat,
        turn: decision.turn,
        notation: decision.notation,
        kind: "threat_race",
        severity: "medium",
        weight: 560,
        title: "Both sides had a winning point",
        titleZh: "双方都握有制胜点",
        detail: "Turn " + decision.turn + ": " + decision.seat + " could win, and so could the opponent — "
          + decision.notation + " decided the race.",
        detailZh: "第 " + decision.turn + " 回合，双方都有连六的点，" + decision.notation + " 决定了这场对攻。"
      }));
    }
  }

  // Blocking is routine in Connect6 — every turn has a five to answer — so only
  // a multi-threat save is worth calling out, and only the two most extreme ones.
  const blocks = decisions
    .filter((decision) => decision.quality === "critical_block" && decision.threatsFaced >= 2)
    .sort((a, b) => b.threatsFaced - a.threatsFaced || a.turn - b.turn)
    .slice(0, 2);
  for (const decision of blocks) {
    moments.push(moment({
      seat: decision.seat,
      turn: decision.turn,
      notation: decision.notation,
      kind: "critical_block",
      severity: "medium",
      weight: 520,
      title: "Held off " + decision.threatsFaced + " winning points",
      titleZh: "同时挡住 " + decision.threatsFaced + " 个连六点",
      detail: "Turn " + decision.turn + ": the opponent had " + decision.threatsFaced
        + " winning points at once and " + decision.notation + " closed one of them.",
      detailZh: "第 " + decision.turn + " 回合，对手同时有 " + decision.threatsFaced
        + " 个连六点，" + decision.notation + " 堵住了其中一个。"
    }));
  }

  // Momentum swings: only finished, non-winning decisions can show a clean delta.
  const swings = decisions
    .filter((decision) => !decision.endedGame)
    .slice()
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
    .slice(0, 3);
  for (const decision of swings) {
    if (Math.abs(decision.swing) < 20_000) continue;
    const up = decision.swing > 0;
    moments.push(moment({
      seat: decision.seat,
      turn: decision.turn,
      notation: decision.notation,
      kind: up ? "swing_up" : "swing_down",
      severity: up ? "low" : "medium",
      weight: 300,
      title: up ? "Position swung your way" : "Position swung away",
      titleZh: up ? "局面大幅向你倾斜" : "局面大幅转向对手",
      detail: "Turn " + decision.turn + ": " + decision.notation + " moved the pattern balance by "
        + (up ? "+" : "") + String(decision.swing) + ".",
      detailZh: "第 " + decision.turn + " 回合，" + decision.notation + " 让棋型差值变化 "
        + (up ? "+" : "") + String(decision.swing) + "。"
    }));
  }

  return moments
    .sort((a, b) => b.weight - a.weight || (a.turn || 0) - (b.turn || 0))
    .slice(0, MAX_KEY_MOMENTS)
    .map((entry) => {
      const { weight, ...rest } = entry;
      return rest;
    });
}

/* ------------------------------------------------------------------------- */
/* Per-seat aggregates                                                       */
/* ------------------------------------------------------------------------- */

function seatFacts(state, seat, decisions) {
  const mine = decisions.filter((decision) => decision.seat === seat);
  const loose = mine.filter((decision) => decision.bestAxisScore < SCORE_TWO);
  const fiveOrMore = mine.filter((decision) => decision.bestAxisScore >= SCORE_FIVE);
  const centre = (state.boardSize - 1) / 2;
  const band = Math.floor(state.boardSize / 3);
  const edge = mine.filter((decision) => {
    const dx = Math.abs(decision.x - centre);
    const dy = Math.abs(decision.y - centre);
    return dx >= band || dy >= band;
  });
  let max = null;
  for (const decision of mine) {
    if (!max || decision.bestAxisScore > max.bestAxisScore) max = decision;
  }
  const shapes = { six: 0, five: 0, open_four: 0, open_three: 0, open_two: 0, closed_two: 0, loose: 0 };
  for (const decision of mine) {
    const code = shapeOf(decision.bestAxisScore).code;
    if (code in shapes) shapes[code] += 1;
  }
  const total = mine.length || 1;
  return {
    seat,
    decisions: mine.length,
    stones: mine.length,
    loose: loose.length,
    looseRatio: round(loose.length / total, 3),
    edge: edge.length,
    edgeRatio: round(edge.length / total, 3),
    fiveOrMore: fiveOrMore.length,
    missedWins: mine.filter((decision) => decision.quality === "missed_win").length,
    unblocked: mine.filter((decision) => decision.quality === "blunder").length,
    blocks: mine.filter((decision) => decision.quality === "critical_block").length,
    best: mine.filter((decision) => decision.quality === "best").length,
    shapes,
    peak: max,
    firstDecision: mine[0] || null
  };
}

/* ------------------------------------------------------------------------- */
/* Weaknesses                                                                */
/* ------------------------------------------------------------------------- */

function buildWeaknesses(context) {
  const { state, result, decisions, seats } = context;
  const list = [];
  const reason = result.endReason;

  for (const seat of seats) {
    const facts = seatFacts(state, seat, decisions);
    const lost = reason === "six_in_a_row" && !safeArray(result.winnerSeats).includes(seat);
    const mine = decisions.filter((decision) => decision.seat === seat);

    const unblocked = mine.filter((decision) => decision.quality === "blunder");
    if (unblocked.length > 0) {
      const first = unblocked[0];
      list.push({
        seat,
        severity: "high",
        code: "unblocked_six",
        turn: first.turn,
        notation: first.notation,
        cells: unblocked.slice(0, MAX_EVIDENCE).map((decision) => decision.notation),
        title: "Let a six through",
        titleZh: "放过了对手的连六",
        detail: unblocked.length === 1
          ? "On turn " + first.turn + " the opponent had a winning point at "
            + notationOf(state, first.threatPoint) + " and it was not taken."
          : unblocked.length + " decisions ignored an opponent's immediate six, starting on turn "
            + first.turn + " (" + first.notation + "), while " + notationOf(state, first.threatPoint)
            + " was already a winning point.",
        detailZh: unblocked.length === 1
          ? "第 " + first.turn + " 回合，对手在 " + notationOf(state, first.threatPoint)
            + " 已经能连六，但这一手没有去挡。"
          : "共有 " + unblocked.length + " 手没有挡对手的连六，最早出现在第 "
            + first.turn + " 回合（" + first.notation + "），而 " + notationOf(state, first.threatPoint)
            + " 当时已经是制胜点。"
      });
    } else if (lost) {
      // No blunder means the opponent's six was never left unanswered — it was
      // built and closed inside a single turn, which is a different lesson.
      const last = mine[mine.length - 1] || null;
      const insideOneTurn = Boolean(last) && last.threatsFaced === 0;
      const winnerSeat = safeArray(result.winnerSeats)[0];
      list.push({
        seat,
        severity: "high",
        code: "no_defence",
        turn: last ? last.turn : null,
        notation: last ? last.notation : "",
        title: insideOneTurn ? "The six formed inside one turn" : "No answer to the winning line",
        titleZh: insideOneTurn ? "连六在一个回合内成形" : "对制胜线路没有应对",
        detail: insideOneTurn
          ? "Your last move (turn " + last.turn + ", " + last.notation + ") still faced no winning point, "
            + "so " + displayName(state, winnerSeat) + " built and closed the six inside a single turn. "
            + "The five had to be broken one turn earlier."
          : "The game ended with " + endReasonText(reason, "en") + " on turn " + result.turns
            + " and the last five was never contested.",
        detailZh: insideOneTurn
          ? "你最后一手（第 " + last.turn + " 回合 " + last.notation + "）时对手还没有连六点，"
            + displayNameZh(state, winnerSeat) + " 是在自己最后一个回合里把六子搭好并连成的。"
            + "要破的是上一个回合刚出现的五。"
          : "对局在第 " + result.turns + " 回合以" + endReasonText(reason, "zh")
            + "结束，最后的五连没有被干扰。"
      });
    }

    const missed = mine.filter((decision) => decision.quality === "missed_win");
    if (missed.length > 0) {
      const first = missed[0];
      list.push({
        seat,
        severity: "high",
        code: "missed_win",
        turn: first.turn,
        notation: first.notation,
        cells: [notationOf(state, first.winPoint)],
        title: "Winning stone not played",
        titleZh: "没有落下制胜的一手",
        detail: "On turn " + first.turn + ", " + notationOf(state, first.winPoint)
          + " would have won immediately; " + first.notation + " was played instead.",
        detailZh: "第 " + first.turn + " 回合，" + notationOf(state, first.winPoint)
          + " 可以直接连六，但实际走了 " + first.notation + "。"
      });
    }

    if (facts.fiveOrMore === 0 && facts.decisions >= 6) {
      const peak = facts.peak;
      const shape = shapeOf(peak ? peak.bestAxisScore : 0);
      list.push({
        seat,
        severity: "medium",
        code: "no_serious_threat",
        turn: peak ? peak.turn : null,
        notation: peak ? peak.notation : "",
        title: "Never threatened six",
        titleZh: "始终没有形成连六威胁",
        detail: "Not one stone created a five or better. The strongest shape was "
          + shape.en + (peak ? " at " + peak.notation + " (turn " + peak.turn + ")" : "") + ".",
        detailZh: "没有任何一手形成冲五以上的形状。最强的形状是" + shape.zh
          + (peak ? "（第 " + peak.turn + " 回合 " + peak.notation + "）" : "") + "。"
      });
    }

    if (facts.looseRatio >= 0.4 && facts.decisions >= 8) {
      const worst = mine
        .filter((decision) => decision.bestAxisScore < SCORE_TWO)
        .sort((a, b) => a.bestAxisScore - b.bestAxisScore)[0];
      list.push({
        seat,
        severity: "medium",
        code: "loose_stones",
        turn: worst ? worst.turn : null,
        notation: worst ? worst.notation : "",
        title: "Stones that join nothing",
        titleZh: "落子没有形成连接",
        detail: Math.round(facts.looseRatio * 100) + "% of the stones ("
          + facts.loose + " of " + facts.decisions + ") created no run of two or more"
          + (worst ? ", worst at " + worst.notation + " on turn " + worst.turn : "") + ".",
        detailZh: "有 " + Math.round(facts.looseRatio * 100) + "% 的落子（"
          + facts.loose + "/" + facts.decisions + "）没有形成两子以上的连接"
          + (worst ? "，最差的是第 " + worst.turn + " 回合的 " + worst.notation : "") + "。"
      });
    }

    if (facts.edgeRatio >= 0.45 && facts.decisions >= 8) {
      list.push({
        seat,
        severity: "low",
        code: "edge_heavy",
        title: "Played away from the centre",
        titleZh: "过于偏离开局中心",
        detail: Math.round(facts.edgeRatio * 100) + "% of the stones sit in the outer third of the board; "
          + "six-in-a-row lines are much easier to build through the centre.",
        detailZh: "有 " + Math.round(facts.edgeRatio * 100) + "% 的落子位于棋盘外三分之一；"
          + "从中心向外发展连六要容易得多。"
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return list
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || a.seat - b.seat)
    .slice(0, MAX_LIST);
}

/* ------------------------------------------------------------------------- */
/* Recommendations                                                           */
/* ------------------------------------------------------------------------- */

function buildRecommendations(context) {
  const { state, result, decisions, seats } = context;
  const list = [];

  for (const seat of seats) {
    const mine = decisions.filter((decision) => decision.seat === seat);
    if (mine.length === 0) continue;
    const firstIndex = list.length;
    const facts = seatFacts(state, seat, decisions);

    const missed = mine.filter((decision) => decision.quality === "missed_win");
    if (missed.length > 0) {
      const first = missed[0];
      list.push({
        seat,
        priority: 1,
        code: "take_the_win",
        turn: first.turn,
        notation: first.notation,
        title: "Scan for the winning stone first",
        titleZh: "先扫一遍能连六的点",
        detail: "Before anything else, check every empty point that touches your own run of five. "
          + "On turn " + first.turn + ", " + notationOf(state, first.winPoint) + " was exactly that.",
        detailZh: "每次落子前先检查所有贴着自己五连的空点。第 " + first.turn + " 回合的 "
          + notationOf(state, first.winPoint) + " 就是这样的点。",
        alternative: notationOf(state, first.winPoint)
      });
    }

    const unblocked = mine.filter((decision) => decision.quality === "blunder");
    if (unblocked.length > 0) {
      const first = unblocked[0];
      list.push({
        seat,
        priority: 2,
        code: "block_the_six",
        turn: first.turn,
        notation: first.notation,
        title: "Read the opponent's five before you build",
        titleZh: "先数对手的五连，再考虑进攻",
        detail: "A five with an open end is a gun on the table. On turn " + first.turn
          + " the opponent had one at " + notationOf(state, first.threatPoint) + ".",
        detailZh: "有活端的五连就是顶在头上的枪。第 " + first.turn + " 回合，对手在 "
          + notationOf(state, first.threatPoint) + " 就有这样的点。",
        alternative: notationOf(state, first.threatPoint)
      });
    }

    if (facts.fiveOrMore === 0 && facts.decisions >= 6) {
      const peak = facts.peak;
      const shape = shapeOf(peak ? peak.bestAxisScore : 0);
      list.push({
        seat,
        priority: 3,
        code: "build_threats",
        turn: peak ? peak.turn : null,
        notation: peak ? peak.notation : "",
        title: "Build two threats, not one",
        titleZh: "要造两个威胁，而不是一个",
        detail: "Single threats are answered for free in Connect6 because a turn is two stones. "
          + "Your best shape all game was " + shape.en + "; aim for two open fours at once.",
        detailZh: "六子棋一回合两子，单点威胁很容易被挡住。你全盘最好的形状只是"
          + shape.zh + "；目标应该是同时形成两个活四。",
        alternative: peak && peak.reference ? notationOf(state, peak.reference) : ""
      });
    }

    if (facts.looseRatio >= 0.4 && facts.decisions >= 8) {
      const loose = mine
        .filter((decision) => decision.bestAxisScore < SCORE_TWO && decision.reference)
        .sort((a, b) => a.bestAxisScore - b.bestAxisScore)[0];
      if (loose) {
        list.push({
          seat,
          priority: 4,
          code: "connect_stones",
          turn: loose.turn,
          notation: loose.notation,
          title: "Every stone should touch your own shape",
          titleZh: "每一子都要贴着自己的形状",
          detail: "A stone with no friendly neighbour is a stone the opponent can ignore. "
            + loose.notation + " on turn " + loose.turn + " joined nothing; "
            + notationOf(state, loose.reference) + " would have extended your own group.",
          detailZh: "没有友邻的落子等于送给对手一步。第 " + loose.turn + " 回合的 "
            + loose.notation + " 没有连上任何己方棋子；" + notationOf(state, loose.reference)
            + " 可以延伸你自己的棋形。",
          alternative: notationOf(state, loose.reference)
        });
      }
    }

    if (facts.edgeRatio >= 0.45 && facts.decisions >= 8) {
      list.push({
        seat,
        priority: 5,
        code: "play_centre",
        title: "Occupy the centre band early",
        titleZh: "开局先占中腹",
        detail: "The middle third of a " + state.boardSize + "x" + state.boardSize
          + " board holds the most six-length lines. Your opening drifted to the edge.",
        detailZh: state.boardSize + "×" + state.boardSize
          + " 棋盘的中腹拥有最多的六连线路，你的开局却偏到了边上。",
        alternative: ""
      });
    }

    if (result.endReason === "six_in_a_row" && !safeArray(result.winnerSeats).includes(seat)) {
      list.push({
        seat,
        priority: 6,
        code: "study_the_loss",
        title: "Replay the losing turn",
        titleZh: "复盘输掉的那一手",
        detail: "The game ended by " + endReasonText(result.endReason, "en")
          + " on turn " + result.turns + ". Step back two turns and find where the opponent's five appeared.",
        detailZh: "对局在第 " + result.turns + " 回合以" + endReasonText(result.endReason, "zh")
          + "结束。往回退两回合，找出对手的五连是哪一步成形的。",
        alternative: ""
      });
    }

    // A clean game deserves a next step rather than an empty column.
    if (list.length === firstIndex) {
      const peak = facts.peak;
      list.push({
        seat,
        priority: 7,
        code: "raise_the_ceiling",
        turn: peak ? peak.turn : null,
        notation: peak ? peak.notation : "",
        title: "Turn the strongest shape into two threats",
        titleZh: "把最强的形状做成双威胁",
        detail: "Nothing in this game needed fixing. The next step is conversion: your peak shape was "
          + shapeOf(peak ? peak.bestAxisScore : 0).en
          + (peak ? " at " + peak.notation + " (turn " + peak.turn + ")" : "")
          + "; pair it with a second line so the opponent cannot answer both.",
        detailZh: "这盘没有需要纠正的地方。下一步是转化能力：你最好的形状是"
          + shapeOf(peak ? peak.bestAxisScore : 0).zh
          + (peak ? "（第 " + peak.turn + " 回合 " + peak.notation + "）" : "")
          + "；把它和第二条线配起来，对手就挡不住两边。",
        alternative: ""
      });
    }
  }

  return list
    .sort((a, b) => a.priority - b.priority || a.seat - b.seat)
    .slice(0, MAX_LIST);
}

/* ------------------------------------------------------------------------- */
/* Summary                                                                   */
/* ------------------------------------------------------------------------- */

function buildScores(state, result, decisions, seats) {
  const counts = safeArray(result.stoneCounts);
  const winners = safeArray(result.winnerSeats);
  const sorted = seats.slice().sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  const ranks = new Map();
  sorted.forEach((seat, index) => {
    if (index > 0 && (counts[seat] ?? 0) === (counts[sorted[index - 1]] ?? 0)) {
      ranks.set(seat, ranks.get(sorted[index - 1]));
    } else {
      ranks.set(seat, index + 1);
    }
  });
  return seats.map((seat) => ({
    seat,
    name: displayName(state, seat),
    color: playerColor(state, seat),
    kind: playerKind(state, seat),
    score: counts[seat] ?? 0,
    occupied: counts[seat] ?? 0,
    decisions: decisions.filter((decision) => decision.seat === seat).length,
    rank: winners.includes(seat) && result.endReason === "six_in_a_row" ? 1 : ranks.get(seat) ?? seats.length,
    won: winners.includes(seat)
  }));
}

function buildSummary(context) {
  const { state, result, decisions, seats, replay } = context;
  const scores = buildScores(state, result, decisions, seats);
  const winners = safeArray(result.winnerSeats);
  const counts = safeArray(result.stoneCounts);
  const totalStones = counts.reduce((sum, value) => sum + value, 0);
  const boardCells = state.boardSize * state.boardSize;
  const margin = counts.length >= 2 ? Math.abs((counts[0] ?? 0) - (counts[1] ?? 0)) : 0;
  const inProgress = state.phase !== PHASES.FINISHED;
  const winnerNames = winners.map((seat) => displayName(state, seat));
  const winnerNamesZh = winners.map((seat) => displayNameZh(state, seat));
  const turnCount = result.turns ?? state.turn;
  const decisionCount = result.decisions ?? replay.records.length;

  let headline;
  let headlineZh;
  if (winners.length === 0) {
    headline = inProgress
      ? "In progress: " + totalStones + " " + plural(totalStones, "stone") + " on the board."
      : "Draw: " + endReasonText(result.endReason, "en") + " with no six in a row.";
    headlineZh = inProgress
      ? "对局进行中：盘面已有 " + totalStones + " 子。"
      : "和棋：棋盘" + endReasonText(result.endReason, "zh") + "，无人连成六子。";
  } else if (result.endReason === "six_in_a_row") {
    const seat = winners[0];
    headline = colourPrefix(state, seat, winnerNames[0], "en") + winnerNames[0]
      + " wins by six in a row on turn " + turnCount + ".";
    headlineZh = "第 " + turnCount + " 回合，" + colourPrefix(state, seat, winnerNamesZh[0], "zh")
      + winnerNamesZh[0] + " 连成六子获胜。";
  } else {
    headline = winnerNames.join(" and ") + " won (" + endReasonText(result.endReason, "en") + ").";
    headlineZh = winnerNamesZh.join("、") + " 获胜（" + endReasonText(result.endReason, "zh") + "）。";
  }

  const stoneLine = scores
    .map((row) => "P" + (row.seat + 1) + " " + row.score)
    .join(" · ");
  const resultLine = "Stones: " + stoneLine + " · " + totalStones + " "
    + plural(totalStones, "stone") + " in " + decisionCount + " "
    + plural(decisionCount, "decision") + " over " + turnCount + " "
    + plural(turnCount, "turn") + " · " + state.boardSize + "x" + state.boardSize
    + " board, " + WIN_LENGTH + " in a row wins.";
  const resultLineZh = "子数：" + scores.map((row) => "P" + (row.seat + 1) + " " + row.score).join(" · ")
    + " · 共 " + turnCount + " 回合 " + decisionCount + " 手 " + totalStones + " 子 · "
    + state.boardSize + "×" + state.boardSize + " 棋盘，连 " + WIN_LENGTH + " 子获胜。";

  const line = safeArray(result.line).map((point) => ({
    x: point.x,
    y: point.y,
    notation: notationOf(state, point)
  }));

  // Best shape reached before the game was decided: "the winning six" is already
  // the headline, so the interesting number is the strongest non-winning threat.
  const peak = decisions
    .filter((decision) => !decision.endedGame)
    .reduce((best, decision) => {
      if (!best || decision.bestAxisScore > best.bestAxisScore) return decision;
      return best;
    }, null);

  return {
    version: ANALYSIS_VERSION,
    headline,
    headlineZh,
    resultLine,
    resultLineZh,
    inProgress,
    playerCount: 2,
    boardSize: state.boardSize,
    winLength: state.winLength ?? WIN_LENGTH,
    ruleSetVersion: state.ruleSetVersion || RULESET_VERSION,
    phase: state.phase,
    turns: turnCount,
    actionCount: decisionCount,
    decisions: decisionCount,
    totalStones,
    stonesPerTurn: STONES_PER_TURN,
    firstTurnStones: FIRST_TURN_STONES,
    endReason: result.endReason,
    endReasonText: endReasonText(result.endReason, "en"),
    endReasonTextZh: endReasonText(result.endReason, "zh"),
    winnerSeats: winners.slice(),
    winnerNames,
    scoreMargin: margin,
    tiebreak: null,
    firstPlayerRank: winners.includes(0) ? 1 : 2,
    occupiedCells: totalStones,
    boardCells,
    boardFullness: round(totalStones / boardCells, 3),
    scores,
    winningLine: line,
    peakThreat: peak
      ? {
        seat: peak.seat,
        turn: peak.turn,
        notation: peak.notation,
        length: peak.bestAxis.length,
        openEnds: peak.bestAxis.openEnds,
        shape: shapeOf(peak.bestAxisScore).code
      }
      : null
  };
}

/* ------------------------------------------------------------------------- */
/* Metrics                                                                   */
/* ------------------------------------------------------------------------- */

function buildTimeline(decisions) {
  const entries = decisions.map((decision) => ({
    seq: decision.seq,
    decision: decision.decision,
    turn: decision.turn,
    seat: decision.seat,
    type: "place",
    notation: decision.notation,
    x: decision.x,
    y: decision.y,
    attack: decision.attack,
    defence: decision.defence,
    shape: shapeOf(decision.bestAxisScore).code,
    winsAvailable: decision.winsAvailable,
    threatsFaced: decision.threatsFaced,
    swing: decision.swing,
    quality: decision.quality
  }));
  if (entries.length <= MAX_TIMELINE) return entries;
  return entries.slice(0, TIMELINE_HEAD).concat(entries.slice(entries.length - (MAX_TIMELINE - TIMELINE_HEAD)));
}

function buildMetrics(context, provided) {
  const { state, result, decisions, seats, replay } = context;
  const metrics = isObject(provided) ? { ...provided } : {};

  metrics.analysisVersion = ANALYSIS_VERSION;
  metrics.timeline = buildTimeline(decisions);
  metrics.decisions = result.decisions ?? replay.records.length;
  metrics.turns = result.turns ?? state.turn;
  metrics.totalStones = safeArray(result.stoneCounts).reduce((sum, value) => sum + value, 0);
  metrics.boardSize = state.boardSize;
  metrics.winLength = state.winLength ?? WIN_LENGTH;
  metrics.winningLineLength = safeArray(result.line).length;
  metrics.endReason = result.endReason;
  metrics.winnerSeats = safeArray(result.winnerSeats).slice();
  metrics.replayTruncated = Boolean(replay.truncated);

  metrics.perPlayer = seats.map((seat) => {
    const facts = seatFacts(state, seat, decisions);
    const shape = shapeOf(facts.peak ? facts.peak.bestAxisScore : 0);
    return {
      seat,
      name: displayName(state, seat),
      color: playerColor(state, seat),
      kind: playerKind(state, seat),
      decisions: facts.decisions,
      stones: facts.stones,
      expectedDecisions: Math.round(metrics.decisions / Math.max(1, seats.length)),
      missedWins: facts.missedWins,
      unblockedThreats: facts.unblocked,
      blocks: facts.blocks,
      bestMoves: facts.best,
      looseStones: facts.loose,
      looseRatio: facts.looseRatio,
      edgeRatio: facts.edgeRatio,
      fiveOrMore: facts.fiveOrMore,
      shapes: facts.shapes,
      peakShape: shape.code,
      peakTurn: facts.peak ? facts.peak.turn : null,
      peakNotation: facts.peak ? facts.peak.notation : ""
    };
  });

  metrics.swings = decisions
    .filter((decision) => !decision.endedGame && Math.abs(decision.swing) > 0)
    .slice()
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
    .slice(0, 6)
    .map((decision) => ({
      seq: decision.seq,
      turn: decision.turn,
      seat: decision.seat,
      notation: decision.notation,
      impact: decision.swing
    }));
  // Kept under the historical key so older coach prompts and exports still read it.
  metrics.territorySwings = metrics.swings;

  // The hardest call is the one where the heuristic disagreed most with what was
  // actually played — not the position with the smallest raw score.
  const rated = decisions.filter((decision) => (
    !decision.endedGame
    && decision.reference
    && decision.ratio !== null
    && decision.ratio < 0.98
  ));
  const hardest = rated
    .sort((a, b) => (b.referenceValue - b.value) - (a.referenceValue - a.value))[0];
  metrics.hardestDecision = hardest
    ? {
      seat: hardest.seat,
      turn: hardest.turn,
      notation: hardest.notation,
      alternative: notationOf(state, hardest.reference),
      quality: hardest.quality,
      gap: Math.round(hardest.referenceValue - hardest.value)
    }
    : null;

  metrics.qualityCounts = decisions.reduce((acc, decision) => {
    acc[decision.quality] = (acc[decision.quality] || 0) + 1;
    return acc;
  }, {});

  return metrics;
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

function emptyAnalysis(errorCode) {
  return {
    summary: {
      version: ANALYSIS_VERSION,
      headline: "No analysis available for this state.",
      headlineZh: "该对局暂无可用的分析数据。",
      resultLine: "",
      resultLineZh: "",
      inProgress: true,
      playerCount: 0,
      boardSize: 0,
      winLength: WIN_LENGTH,
      ruleSetVersion: null,
      phase: null,
      turns: 0,
      actionCount: 0,
      decisions: 0,
      totalStones: 0,
      stonesPerTurn: STONES_PER_TURN,
      firstTurnStones: FIRST_TURN_STONES,
      endReason: "unknown",
      endReasonText: END_REASON_TEXT.unknown,
      endReasonTextZh: END_REASON_ZH.unknown,
      winnerSeats: [],
      winnerNames: [],
      scoreMargin: 0,
      tiebreak: null,
      firstPlayerRank: 1,
      occupiedCells: 0,
      boardCells: 0,
      boardFullness: 0,
      scores: [],
      winningLine: [],
      peakThreat: null
    },
    keyMoments: [],
    weaknesses: [],
    recommendations: [],
    metrics: { analysisVersion: ANALYSIS_VERSION, analysisError: errorCode || "invalid_state" }
  };
}

function resolveResult(state) {
  if (isObject(state.result) && Array.isArray(state.result.stoneCounts)) return state.result;
  if (state.phase === PHASES.FINISHED) return computeResult(state);
  return computeResult(state, { winnerSeats: [], line: [], endReason: "in_progress" });
}

/**
 * Analyse a Connect6 game.
 *
 * @param {object} state engine state, finished or in progress
 * @param {{metrics?: object}} [options] stored playtest metrics to merge into the output metrics
 * @returns {{summary: object, keyMoments: object[], weaknesses: object[], recommendations: object[], metrics: object}}
 */
export function analyzeGame(state, options = {}) {
  const provided = isObject(options) && isObject(options.metrics) ? options.metrics : null;
  try {
    if (!state || typeof state !== "object" || !Array.isArray(state.cells) || !Array.isArray(state.players)
      || !Number.isInteger(state.boardSize) || state.boardSize <= 0) {
      return emptyAnalysis("invalid_state");
    }
    const result = resolveResult(state);
    const replay = replayGame(state);
    const seats = [0, 1];
    const context = { state, result, replay, seats };
    const decisions = analyseDecisions(context);
    context.decisions = decisions;
    return {
      summary: buildSummary(context),
      keyMoments: buildKeyMoments(context),
      weaknesses: buildWeaknesses(context),
      recommendations: buildRecommendations(context),
      metrics: buildMetrics(context, provided)
    };
  } catch (error) {
    const fallback = emptyAnalysis("analysis_failed");
    fallback.metrics.analysisErrorDetail = error && error.message
      ? String(error.message).slice(0, 200)
      : "unknown";
    return fallback;
  }
}
