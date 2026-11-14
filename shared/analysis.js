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
  formatCell,
  inBounds
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

/** Concrete line evidence for a placed or hypothetical stone. */
function axisEvidence(state, point, seat, dx, dy) {
  const line = [{ x: point.x, y: point.y }];
  const open = [];
  for (const sign of [-1, 1]) {
    let x = point.x + dx * sign;
    let y = point.y + dy * sign;
    while (inBounds(state, x, y) && state.cells[y * state.boardSize + x] === seat) {
      if (sign < 0) line.unshift({ x, y });
      else line.push({ x, y });
      x += dx * sign;
      y += dy * sign;
    }
    if (inBounds(state, x, y) && state.cells[y * state.boardSize + x] === null) open.push({ x, y });
  }
  return { line, open, axis: axisNameOf(line) };
}

/** Six-cell routes through a point that need only one or two more stones. */
function completionPlans(state, seat, point) {
  const plans = [];
  const seen = new Set();
  for (const [dx, dy] of DIRECTIONS) {
    for (let offset = 0; offset < WIN_LENGTH; offset += 1) {
      const line = [];
      const stones = [];
      const gaps = [];
      for (let step = 0; step < WIN_LENGTH; step += 1) {
        const x = point.x + (step - offset) * dx;
        const y = point.y + (step - offset) * dy;
        if (!inBounds(state, x, y)) break;
        const owner = state.cells[y * state.boardSize + x];
        if (owner !== null && owner !== seat) break;
        const cell = { x, y };
        line.push(cell);
        if (owner === seat) stones.push(cell);
        else gaps.push(cell);
      }
      if (line.length !== WIN_LENGTH || gaps.length < 1 || gaps.length > STONES_PER_TURN) continue;
      const key = gaps.map((cell) => cell.y * state.boardSize + cell.x).sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({ line, stones, gaps, axis: axisNameOf(line) });
    }
  }
  return plans.sort((a, b) => a.gaps.length - b.gaps.length);
}

function planText(state, plan) {
  const range = notationOf(state, plan.line[0]) + "–" + notationOf(state, plan.line[plan.line.length - 1]);
  const stones = formatCellList(state, plan.stones, WIN_LENGTH);
  const gaps = formatCellList(state, plan.gaps, STONES_PER_TURN);
  return {
    en: "the " + plan.axis.en + " " + range + " contains stones at " + stones
      + "; filling " + gaps + " (" + plan.gaps.length + " more stones) completes six",
    zh: plan.axis.zh + " " + range + " 已有 " + stones + "，再补 " + gaps
      + "（" + plan.gaps.length + " 子）就能连六"
  };
}

function decisionExplanation(context, decision) {
  const { state } = context;
  const plan = decision.createdPlans[0];
  const blocked = decision.blockedPlans[0];
  if (blocked && (!plan || decision.bestAxis.length < 4)) {
    const text = planText(state, blocked);
    return {
      en: "Turn " + decision.turn + ": the opponent's " + text.en + ". Playing " + decision.notation
        + " occupied one of those gaps and broke this route. Other routes still need checking.",
      zh: "第 " + decision.turn + " 回合，对手的" + text.zh + "。你落在 " + decision.notation
        + "，占住了其中一个缺口，切断这条连六路线；接下来仍需检查对手的其他线路。"
    };
  }
  if (plan) {
    const text = planText(state, plan);
    return {
      en: "Turn " + decision.turn + ", after " + decision.notation + ": " + text.en
        + ". This is a threat, not a forced win: the opponent can occupy a gap before your next turn.",
      zh: "第 " + decision.turn + " 回合落在 " + decision.notation + " 后，" + text.zh
        + "。这一步形成了具体威胁；如果轮到对手，对手可以先占缺口，因此还不能据此认定必胜。"
    };
  }
  const line = formatCellList(state, decision.lineEvidence.line, state.boardSize);
  const open = formatCellList(state, decision.lineEvidence.open);
  return {
    en: "Turn " + decision.turn + ": " + decision.notation + " joined " + line + " on "
      + decision.lineEvidence.axis.en + " (" + decision.bestAxis.length + " stones). "
      + (open ? "Open ends: " + open + ". Check those extensions while watching the opponent's threats."
        : "Both ends are blocked; this run cannot be extended along that axis."),
    zh: "第 " + decision.turn + " 回合，" + decision.notation + " 把 " + line + " 在"
      + decision.lineEvidence.axis.zh + "上连成 " + decision.bestAxis.length + " 子。"
      + (open ? "可延伸的端点是 " + open + "；下一步可围绕这些点发展，同时先检查对手是否有连六威胁。"
        : "两端均被棋子或边界封住，这条线暂时无法继续延伸。")
  };
}

/** Reconstruct the winning route at the loser's final chance to defend. */
function losingRoute(context, seat) {
  const { result, decisions, replay, state } = context;
  if (result.endReason !== "six_in_a_row" || safeArray(result.winnerSeats).includes(seat) || replay.truncated) return null;
  const finalDecision = decisions.filter((entry) => entry.seat === seat).at(-1);
  if (!finalDecision) return null;
  const last = decisions.find((entry) => entry.seat === seat && entry.turn === finalDecision.turn);
  const before = replay.before[last.decision - 1];
  const winner = safeArray(result.winnerSeats)[0];
  const finalMove = replay.records.at(-1);
  const plans = completionPlans(before, winner, finalMove)
    .filter((plan) => plan.line.every((cell) => state.cells[cell.y * state.boardSize + cell.x] === winner));
  if (!plans.length) return null;
  return { decision: last, plan: plans[0] };
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
    let turnEnd = index;
    while (turnEnd < lastIndex && replay.records[turnEnd + 1].seat === seat
      && replay.records[turnEnd + 1].turn === record.turn) turnEnd += 1;
    const afterTurn = replay.before[turnEnd + 1] ?? replay.final;
    const turnFinished = afterTurn && (afterTurn.turn !== record.turn || afterTurn.phase === PHASES.FINISHED);
    const wonThisTurn = turnEnd === lastIndex && reason === "six_in_a_row" && winners.includes(seat);
    const unblockedAtTurnEnd = turnFinished && !wonThisTurn ? winningPoints(afterTurn, opponent).length : 0;
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
      quality = tookAvailableWin ? "winning" : wonThisTurn ? "good"
        : turnFinished && index === turnEnd ? "missed_win" : "unrated";
    } else if (threatsFaced.length > 0) {
      quality = answeredThreat ? "critical_block"
        : unblockedAtTurnEnd > 0 && index === turnEnd ? "blunder" : "unrated";
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
      lineEvidence: axisEvidence(before, record, seat, bestAxis.dx ?? 1, bestAxis.dy ?? 0),
      createdPlans: after ? completionPlans(after, seat, record) : [],
      blockedPlans: completionPlans(before, opponent, record)
        .filter((plan) => containsPoint(plan.gaps, record.x, record.y)),
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
        + lineLength + " on " + axis.en + ": " + formatCellList(state, result.line, state.boardSize) + ".",
      detailZh: "第 " + lastRecord.turn + " 回合，" + lastRecord.notation + " 在" + axis.zh
        + "上将 " + formatCellList(state, result.line, state.boardSize) + " 连成 " + lineLength + " 子，直接结束对局。"
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

    if (decision.strongAxes >= 2 && !decision.endedGame) {
      const explanation = decisionExplanation(context, decision);
      moments.push(moment({
        seat: decision.seat,
        turn: decision.turn,
        notation: decision.notation,
        kind: "double_threat",
        severity: "medium",
        weight: 620,
        title: "Double threat",
        titleZh: "形成双威胁",
        detail: explanation.en + " There are strong shapes on " + decision.strongAxes
          + " axes, but two defensive stones may still answer them.",
        detailZh: explanation.zh + " 此处同时涉及 " + decision.strongAxes
          + " 个方向；对手一回合有两子，不能只凭双威胁就断定挡不住。"
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
      title: "Prioritised an opponent's winning point",
      titleZh: "优先封堵对手的制胜点",
      detail: "Turn " + decision.turn + ": the opponent had " + decision.threatsFaced
        + " winning points at once and " + decision.notation + " closed one of them.",
      detailZh: "第 " + decision.turn + " 回合，对手同时有 " + decision.threatsFaced
        + " 个连六点，" + decision.notation + " 堵住了其中一个。"
    }));
  }

  // Keep the numeric balance in metrics. Human review explains the actual line,
  // empty cells and consequence instead of presenting an unexplained score.
  const developments = decisions
    .filter((decision) => !decision.endedGame && decision.strongAxes < 2
      && !["missed_win", "blunder"].includes(decision.quality)
      && (decision.createdPlans.length || decision.blockedPlans.length || decision.bestAxis.length >= 3))
    .slice()
    .sort((a, b) => Number(Boolean(b.createdPlans.length || b.blockedPlans.length))
      - Number(Boolean(a.createdPlans.length || a.blockedPlans.length)) || Math.abs(b.swing) - Math.abs(a.swing));
  const selectedTurns = new Set();
  for (const decision of developments) {
    const key = decision.seat + ":" + decision.turn;
    if (selectedTurns.has(key)) continue;
    selectedTurns.add(key);
    if (selectedTurns.size > 4) break;
    const explanation = decisionExplanation(context, decision);
    const blocked = decision.blockedPlans.length > 0 && (!decision.createdPlans.length || decision.bestAxis.length < 4);
    moments.push(moment({
      seat: decision.seat,
      turn: decision.turn,
      notation: decision.notation,
      kind: blocked ? "route_block" : "shape_development",
      severity: "low",
      weight: decision.createdPlans.length || blocked ? 420 : 300,
      title: blocked ? "Cut off a route to six" : decision.createdPlans.length ? "Created a route to six" : "Connected stones with room to extend",
      titleZh: blocked ? "切断对手的连六路线" : decision.createdPlans.length ? "留下可连六的缺口" : "连接棋子并寻找延伸点",
      detail: explanation.en,
      detailZh: explanation.zh
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
  const loose = mine.filter((decision) => decision.bestAxisScore < SCORE_TWO
    && decision.blockedPlans.length === 0 && decision.threatsFaced === 0 && decision.decision > 1);
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
    if (decision.endedGame) continue;
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
    threatMoves: mine.filter((decision) => decision.createdPlans.length > 0 || decision.endedGame).length,
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
    } else if (lost && losingRoute(context, seat)) {
      const route = losingRoute(context, seat);
      const last = route.decision;
      const text = planText(state, route.plan);
      list.push({
        seat,
        severity: "high",
        code: "no_defence",
        turn: last ? last.turn : null,
        notation: last ? last.notation : "",
        cells: route.plan.gaps.map((point) => notationOf(state, point)),
        title: "Missed a two-stone route to six",
        titleZh: "漏看了对手两子内连六的路线",
        detail: "Before " + last.notation + " on turn " + last.turn + ", the opponent's " + text.en
          + ". Your move left both the route and its gaps available, and the opponent completed it on turn " + result.turns + ".",
        detailZh: "第 " + last.turn + " 回合落 " + last.notation + " 前，对手的" + text.zh
          + "。实际落子没有占住这些缺口，对手在第 " + result.turns
          + " 回合完成了这条线。应提前破坏这条四子或五子的路线，而不是等到对手已经连成六子。"
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

    if (facts.threatMoves === 0 && facts.decisions >= 6) {
      const peak = facts.peak;
      list.push({
        seat,
        severity: "medium",
        code: "no_serious_threat",
        turn: peak ? peak.turn : null,
        notation: peak ? peak.notation : "",
        title: "Never threatened six",
        titleZh: "始终没有形成连六威胁",
        detail: "No analysed stone left a six-cell route that could be completed with at most two more stones. "
          + (peak ? decisionExplanation(context, peak).en : ""),
        detailZh: "在已复盘的落子中，没有形成一条再补一至两子就能连六的线路。"
          + (peak ? decisionExplanation(context, peak).zh : "")
      });
    }

    if (facts.looseRatio >= 0.4 && facts.decisions >= 8) {
      const worst = mine
        .filter((decision) => decision.bestAxisScore < SCORE_TWO && !decision.blockedPlans.length
          && !decision.threatsFaced && decision.decision > 1)
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
          + facts.loose + "/" + facts.decisions + "）既没有形成两子以上的连接，也没有切断已识别的对手连六路线"
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
        detail: "On turn " + first.turn + ", use " + notationOf(state, first.threatPoint)
          + " instead of " + first.notation + " to stop this immediate six. Check the remaining threats before placing your other stone.",
        detailZh: "第 " + first.turn + " 回合，可把 " + first.notation + " 改为 "
          + notationOf(state, first.threatPoint) + "，先封住这个一子即可连六的点；另一子再处理其他威胁或发展自己的线路。",
        alternative: notationOf(state, first.threatPoint)
      });
    }

    if (facts.threatMoves === 0 && facts.decisions >= 6) {
      const peak = facts.peak;
      list.push({
        seat,
        priority: 3,
        code: "build_threats",
        turn: peak ? peak.turn : null,
        notation: peak ? peak.notation : "",
        title: "Plan both stones around a route to six",
        titleZh: "把每回合两子放在同一进攻计划里",
        detail: (peak ? decisionExplanation(context, peak).en + " " : "")
          + "Find a six-cell route without an opposing stone and count its empty cells. Four stones can already threaten a two-stone finish; two threats alone do not guarantee a win.",
        detailZh: (peak ? decisionExplanation(context, peak).zh : "")
          + "训练时先找一段没有对手棋子的六格线路，再数还缺几子。已有四子就可能在下一回合补两子成六；同时也要数对手能用两子封住多少缺口。",
        alternative: peak && peak.reference ? notationOf(state, peak.reference) : ""
      });
    }

    if (facts.looseRatio >= 0.4 && facts.decisions >= 8) {
      const loose = mine
        .filter((decision) => decision.bestAxisScore < SCORE_TWO && decision.reference
          && !decision.blockedPlans.length && !decision.threatsFaced && decision.decision > 1)
        .sort((a, b) => a.bestAxisScore - b.bestAxisScore)[0];
      if (loose) {
        list.push({
          seat,
          priority: 4,
          code: "connect_stones",
          turn: loose.turn,
          notation: loose.notation,
          title: "Compare the purpose of a disconnected stone",
          titleZh: "复盘散子时，先看这一子要完成什么",
          detail: "Turn " + loose.turn + ": " + loose.notation + " joined no friendly run and did not block an identified route to six. "
            + "The local engine suggests comparing " + notationOf(state, loose.reference)
            + "; check its attack and defence together with your other stone. This is a heuristic reference, not a proven best move.",
          detailZh: "第 " + loose.turn + " 回合的 " + loose.notation
            + " 没有形成连子，也没有切断已识别的连六路线。本地引擎给出的对比落点是 "
            + notationOf(state, loose.reference) + "；复盘时比较它能连接哪条线、封住哪个缺口，并和同回合另一子一起考虑。这是参考走法，尚未证明是唯一最优解。",
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
      const route = losingRoute(context, seat);
      if (route) {
        const text = planText(state, route.plan);
        list.push({
          seat,
          priority: 6,
          code: "study_the_loss",
          turn: route.decision.turn,
          notation: route.decision.notation,
          title: "Revisit the final chance to break the winning route",
          titleZh: "回到最后一次能切断制胜线路的回合",
          detail: "Before " + route.decision.notation + " on turn " + route.decision.turn + ", the opponent's "
            + text.en + ". Occupying at least one of " + formatCellList(state, route.plan.gaps)
            + " would break this route; check the other routes before deciding where to use your remaining stone. This does not prove the whole game was savable.",
          detailZh: "回到第 " + route.decision.turn + " 回合、落 " + route.decision.notation + " 之前：对手的"
            + text.zh + "。可先占 " + formatCellList(state, route.plan.gaps)
            + " 中至少一处，破坏这条线；另一子再检查其他进攻线路。这能切断本次制胜路线，但不代表已经证明整盘能守住。",
          alternative: notationOf(state, route.plan.gaps[0])
        });
      }
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
        title: "Review your strongest developing shape",
        titleZh: "复盘本局最强的进攻形状",
        detail: (peak ? decisionExplanation(context, peak).en + " " : "")
          + "Replay both stones of that turn and count how many gaps the opponent could close with two stones. The local analysis has not established that every move was optimal.",
        detailZh: (peak ? decisionExplanation(context, peak).zh : "")
          + "训练时一起复盘该回合的两子，数一数对手用两子能封住哪些缺口，再考虑是否能换一个方向继续进攻。本地分析未发现的失误仍可能存在。",
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

  const loser = seats.find((seat) => winners.length > 0 && !winners.includes(seat));
  const route = Number.isInteger(loser) ? losingRoute(context, loser) : null;
  const routeText = route ? planText(state, route.plan) : null;
  const takeaway = route
    ? "Review turn " + route.decision.turn + ": before " + route.decision.notation + ", the opponent's "
      + routeText.en + ". This route remained open until the winning turn."
    : "";
  const takeawayZh = route
    ? "本局先看第 " + route.decision.turn + " 回合：落 " + route.decision.notation + " 前，对手的"
      + routeText.zh + "。这条路线一直留到对手获胜，是本局最值得回看的防守节点。"
    : "";

  return {
    version: ANALYSIS_VERSION,
    explanationVersion: 1,
    headline,
    headlineZh,
    resultLine,
    resultLineZh,
    takeaway,
    takeawayZh,
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
