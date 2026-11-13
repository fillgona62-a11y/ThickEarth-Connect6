/**
 * Game record exports. JSON is the canonical machine-readable record (initial
 * state + ordered actions + final state + result + metrics), Markdown is an
 * annotated human-readable record, and plain text is a compact notation log.
 *
 * Exports work for in-progress games too; the status and finalState show how far
 * the game has advanced.
 */

import { formatCell } from "../shared/rules.js";

export const EXPORT_FORMATS = Object.freeze(["json", "md", "txt"]);

const CONTENT_TYPES = Object.freeze({
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8"
});

export function renderGameExport(row, actions, format = "json") {
  if (format === "json") {
    return {
      body: JSON.stringify(buildJsonRecord(row, actions), null, 2) + "\n",
      contentType: CONTENT_TYPES.json,
      extension: "json"
    };
  }
  if (format === "md") {
    return { body: renderMarkdown(row, actions), contentType: CONTENT_TYPES.md, extension: "md" };
  }
  return { body: renderText(row, actions), contentType: CONTENT_TYPES.txt, extension: "txt" };
}

function buildJsonRecord(row, actions) {
  const state = row.currentState;
  return {
    formatVersion: 1,
    exportedAt: Date.now(),
    game: {
      id: row.id,
      roomCode: row.roomCode,
      mode: row.mode,
      status: row.status,
      playerCount: row.playerCount,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      hostId: row.hostUserId,
      players: state.players.map((player, seat) => ({
        seat,
        name: player.name,
        kind: player.kind,
        engine: row.seats[seat]?.engine ?? null,
        fallbackCount: row.seats[seat]?.fallbackCount ?? 0,
        timeLimitMs: row.seats[seat]?.timeLimitMs ?? null,
        color: player.color,
        userId: row.seats[seat]?.userId ?? null
      }))
    },
    rules: {
      version: state.ruleSetVersion,
      boardSize: state.boardSize,
      winLength: state.winLength,
      stonesPerTurn: state.options?.stonesPerTurn ?? null,
      firstTurnStones: state.options?.firstTurnStones ?? null
    },
    initialState: row.initialState,
    actions: actions.map((action) => action.action),
    moves: actions.map(toMove),
    finalState: state,
    result: state.result ?? null,
    metrics: row.metrics ?? null
  };
}

function toMove(action) {
  return {
    seq: action.seq,
    turn: action.turn,
    seat: action.seat,
    type: action.type,
    x: action.x,
    y: action.y,
    notation: action.notation
  };
}

function renderMarkdown(row, actions) {
  const state = row.currentState;
  const result = state.result;
  const moves = actions.map(toMove);
  const lines = [
    "# Connect6 game record — " + row.id,
    "",
    "- Room code: " + row.roomCode,
    "- Mode: " + row.mode,
    "- Status: " + row.status,
    "- Players: " + row.playerCount,
    "- Created: " + formatTimestamp(row.createdAt),
    "- Started: " + formatTimestamp(row.startedAt),
    "- Finished: " + formatTimestamp(row.finishedAt),
    "- Ruleset: " + state.ruleSetVersion + " on a " + state.boardSize + "x" + state.boardSize
      + " board, " + (state.winLength ?? 6) + " in a row wins",
    "",
    "## Seats",
    "",
    "| Seat | Name | Colour | Kind | Stones |",
    "|---:|---|---|---|---:|"
  ];
  for (const player of state.players) {
    const seat = player.seat;
    lines.push("| " + (seat + 1) + " | " + tableCell(player.name) + " | " + (player.color ?? "—")
      + " | " + player.kind + " | " + (Number.isInteger(player.stones) ? player.stones : 0) + " |");
  }
  lines.push("", "## Move log", "");
  if (moves.length === 0) {
    lines.push("_No actions recorded yet._");
  } else {
    lines.push("| # | Turn | Seat | Point |");
    lines.push("|---:|---:|---|---|");
    for (const move of moves) {
      lines.push("| " + move.seq + " | " + (move.turn ?? "—") + " | " + seatLabel(move.seat)
        + " | " + tableCell(move.notation) + " |");
    }
  }
  lines.push("", "## Final position", "", "```", renderBoardBlock(state), "```");
  lines.push("", "## Result", "");
  if (result) {
    lines.push("- End reason: " + result.endReason);
    lines.push("- Stones: " + (result.stoneCounts ?? []).map((count, seat) => "P" + (seat + 1) + " " + count).join(", "));
    lines.push("- Winner: " + (result.winnerSeats.length > 0 ? result.winnerSeats.map((seat) => "P" + (seat + 1)).join(", ") : "none (draw)"));
    if (Array.isArray(result.line) && result.line.length > 0) {
      lines.push("- Winning line: " + result.line.length + " in a row ("
        + result.line.map((point) => formatCell(state, point.x, point.y)).join(" ") + ")");
    }
    lines.push("- Turns: " + result.turns + " (" + result.decisions + " decisions)");
  } else {
    lines.push("Game in progress.");
  }
  lines.push("", "## Playtest metrics", "");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  const metrics = row.metrics;
  if (metrics) {
    lines.push("| Duration | " + formatDuration(metrics.durationMs) + " |");
    lines.push("| Turns | " + metrics.turns + " |");
    lines.push("| Decisions | " + metrics.decisions + " |");
    lines.push("| Stones by seat | " + (metrics.stoneCounts ?? []).join(" / ") + " |");
    lines.push("| Decisions by seat | " + (metrics.decisionsPerSeat ?? []).join(" / ") + " |");
    lines.push("| Winning line length | " + (metrics.winningLineLength ?? 0) + " |");
  } else {
    lines.push("| Status | Not available yet |");
  }
  lines.push("", "## Hardest decision", "");
  lines.push(metrics?.hardestDecisionNote ? metrics.hardestDecisionNote : "_Not recorded._");
  const analysisText = describeAnalysis(row.analysis);
  if (analysisText) lines.push("", "## Local analysis", "", analysisText);
  return lines.join("\n") + "\n";
}

/**
 * Local analysis payloads may carry either a plain summary string (placeholder)
 * or a structured summary object from shared/analysis.js. Render both into text.
 */
function describeAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return "";
  if (typeof analysis.summary === "string") return analysis.summary;
  if (analysis.summary && typeof analysis.summary === "object") {
    return [analysis.summary.headline, analysis.summary.resultLine]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n\n");
  }
  return "";
}

function renderText(row, actions) {
  const state = row.currentState;
  const result = state.result;
  const lines = [
    "# Connect6 game " + row.id,
    "# mode=" + row.mode + " status=" + row.status + " players=" + row.playerCount,
    "# created=" + formatTimestamp(row.createdAt) + " finished=" + formatTimestamp(row.finishedAt),
    "# ruleset=" + state.ruleSetVersion + " board=" + state.boardSize + "x" + state.boardSize
      + " win=" + (state.winLength ?? 6),
    "# seats: " + state.players.map((player) => (player.seat + 1) + "=" + player.name
      + "(" + (player.color ?? "?") + "," + player.kind + ")").join(" ")
  ];
  if (actions.length === 0) {
    lines.push("# no actions recorded");
  } else {
    lines.push("");
    for (const move of actions) {
      lines.push(move.seq + ". T" + (move.turn ?? "?") + " " + seatLabel(move.seat) + " " + move.notation);
    }
  }
  lines.push("");
  if (result) {
    lines.push(
      "# result: end=" + result.endReason +
      " stones=" + (result.stoneCounts ?? []).map((count, seat) => "P" + (seat + 1) + ":" + count).join(",") +
      " winners=" + result.winnerSeats.map((seat) => "P" + (seat + 1)).join(",") +
      " line=" + (Array.isArray(result.line) ? result.line.length : 0) +
      " turns=" + result.turns + " decisions=" + result.decisions
    );
  } else {
    lines.push("# result: game in progress");
  }
  if (row.metrics?.hardestDecisionNote) lines.push("# hardest decision: " + row.metrics.hardestDecisionNote);
  return lines.join("\n") + "\n";
}

/**
 * Printable final position: column header, row numbers, X for black, O for white.
 * Included in the Markdown export so a record can be read without re-importing it.
 */
function renderBoardBlock(state) {
  const size = state.boardSize;
  const columns = [];
  for (let x = 0; x < size; x += 1) columns.push(String.fromCharCode(65 + x));
  const out = ["    " + columns.join(" ")].concat([""]);
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      const seat = state.cells[y * size + x];
      row.push(seat === null || seat === undefined ? "." : (seat === 0 ? "X" : "O"));
    }
    out.push(String(y + 1).padStart(2, " ") + "  " + row.join(" "));
  }
  return out.join("\n");
}

function seatLabel(seat) {
  return seat === null || seat === undefined ? "—" : "P" + (seat + 1);
}

function formatTimestamp(ms) {
  return ms === null || ms === undefined ? "—" : new Date(ms).toISOString();
}

function formatDuration(ms) {
  if (typeof ms !== "number") return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? minutes + "m " + (seconds % 60) + "s" : seconds + "s";
}

function tableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
