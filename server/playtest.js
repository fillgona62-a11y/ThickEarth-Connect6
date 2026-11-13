/**
 * Playtest aggregation for completed games: JSON summary, CSV export, and the
 * per-game metrics fallback used when a record predates stored metrics.
 *
 * The shapes here describe Connect6: one number per decision (a single stone),
 * one per turn (one or two stones by the same seat), and the length of the
 * winning run. CSV deliberately contains game ids and gameplay metrics only;
 * player account identifiers are not exported.
 */

import { playtestMetrics } from "../shared/rules.js";

const CSV_COLUMNS = Object.freeze([
  ["game_id", (row) => row.id],
  ["mode", (row) => row.mode],
  ["board_size", (row, metrics) => metrics.boardSize],
  ["win_length", (row, metrics) => metrics.winLength ?? ""],
  ["started_at", (row, metrics) => toIso(metrics.startedAt)],
  ["ended_at", (row, metrics) => toIso(metrics.endedAt)],
  ["duration_ms", (row, metrics) => metrics.durationMs],
  ["turns", (row, metrics) => metrics.turns],
  ["decisions", (row, metrics) => metrics.decisions],
  ["stones_by_seat", (row, metrics) => joinNumbers(metrics.stoneCounts)],
  ["decisions_by_seat", (row, metrics) => joinNumbers(metrics.decisionsPerSeat)],
  ["winning_line_length", (row, metrics) => metrics.winningLineLength],
  ["end_reason", (row, metrics) => metrics.endReason],
  ["winner_seats", (row, metrics) => joinNumbers(metrics.winnerSeats)],
  ["agent_fallbacks_by_seat", (row) => joinNumbers((row.seats ?? []).map((seat) => seat.fallbackCount ?? 0))],
  ["hardest_decision_note", (row, metrics) => metrics.hardestDecisionNote ?? ""]
]);

export function metricsForRow(row) {
  if (row.metrics) return row.metrics;
  if (!row.currentState) return null;
  const startedAt = row.startedAt ?? null;
  const endedAt = row.finishedAt ?? null;
  return playtestMetrics(row.currentState, {
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null
  });
}

export function summarizeCompletedGames(rows) {
  const completed = rows.filter((row) => row.status === "finished");
  const totals = {
    turns: 0,
    decisions: 0,
    stones: 0,
    winningLineLength: 0
  };
  const endReasons = {};
  const buckets = new Map();
  let durationSum = 0;
  let durationCount = 0;
  let firstPlayerWins = 0;
  let noteCount = 0;
  let counted = 0;
  let lineSum = 0;
  let lineCount = 0;

  for (const row of completed) {
    const metrics = metricsForRow(row);
    if (!metrics) continue;
    counted += 1;
    totals.turns += metrics.turns ?? 0;
    totals.decisions += metrics.decisions ?? 0;
    totals.stones += metrics.totalStones ?? sum(metrics.stoneCounts);
    if (typeof metrics.durationMs === "number") {
      durationSum += metrics.durationMs;
      durationCount += 1;
    }
    if (typeof metrics.winningLineLength === "number" && metrics.winningLineLength > 0) {
      totals.winningLineLength += metrics.winningLineLength;
      lineSum += metrics.winningLineLength;
      lineCount += 1;
    }
    endReasons[metrics.endReason] = (endReasons[metrics.endReason] ?? 0) + 1;
    if (Array.isArray(metrics.winnerSeats) && metrics.winnerSeats.includes(0)) firstPlayerWins += 1;
    if (metrics.hardestDecisionNote) noteCount += 1;

    const key = String(metrics.playerCount ?? 2);
    const bucket = buckets.get(key) ?? { games: 0, durationSum: 0, durationCount: 0, decisions: 0 };
    bucket.games += 1;
    bucket.decisions += metrics.decisions ?? 0;
    if (typeof metrics.durationMs === "number") {
      bucket.durationSum += metrics.durationMs;
      bucket.durationCount += 1;
    }
    buckets.set(key, bucket);
  }

  const byPlayerCount = {};
  for (const [key, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byPlayerCount[key] = {
      games: bucket.games,
      averageDurationMs: bucket.durationCount > 0 ? Math.round(bucket.durationSum / bucket.durationCount) : null,
      averageDecisions: round(bucket.decisions / bucket.games)
    };
  }

  return {
    generatedAt: Date.now(),
    ruleSet: "connect6",
    gameCount: counted,
    totals,
    averages: {
      turns: counted > 0 ? round(totals.turns / counted) : 0,
      decisions: counted > 0 ? round(totals.decisions / counted) : 0,
      stones: counted > 0 ? round(totals.stones / counted) : 0,
      durationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
      winningLineLength: lineCount > 0 ? round(lineSum / lineCount, 2) : null
    },
    byPlayerCount,
    endReasons,
    firstPlayerWinRate: counted > 0 ? round(firstPlayerWins / counted, 3) : 0,
    noteCount
  };
}

export function completedGamesToCsv(rows) {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows) {
    if (row.status !== "finished") continue;
    const metrics = metricsForRow(row);
    if (!metrics) continue;
    lines.push(CSV_COLUMNS.map(([, read]) => escapeCsv(read(row, metrics))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function sum(values) {
  return Array.isArray(values) ? values.reduce((total, value) => total + value, 0) : 0;
}

function joinNumbers(values) {
  return Array.isArray(values) ? values.join(";") : "";
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toIso(ms) {
  return typeof ms === "number" ? new Date(ms).toISOString() : "";
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const text = /^[\s]*[=+@-]|^[\t\r\n]/.test(raw) ? "'" + raw : raw;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
