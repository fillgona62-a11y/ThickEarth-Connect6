#!/usr/bin/env node
/**
 * Reference external agent for a ThickEarth agent seat.
 *
 * Demonstrates the whole contract in ~150 lines with no dependencies:
 *   1. create a game that contains an agent seat
 *   2. mint a seat token (bearer credential scoped to game + seat)
 *   3. poll /api/agent/game until turn.isMyTurn
 *   4. submit { turnId, action } to /api/agent/actions
 *
 * The move choice here is deliberately dumb (win, block, else grow the strongest
 * shape). Swap chooseAction for a real policy, a search, or an LLM call; nothing
 * else changes.
 *
 * Connect6 places one stone per decision, so a turn spans one or two calls; the
 * loop below simply keeps answering until the game ends.
 *
 *   node agents/example-client.mjs [baseUrl] [--arena]
 */

const args = process.argv.slice(2);
const BASE = args.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:7788";
const ARENA = args.includes("--arena");

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error((payload?.error?.code ?? res.status) + ": " + (payload?.error?.message ?? ""));
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

const STONE_MARKS = ["X", "O"];
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];

function renderBoard(state) {
  const size = state.boardSize;
  const header = "    " + Array.from({ length: size }, (_, x) => String.fromCharCode(65 + x)).join(" ");
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const cells = [];
    for (let x = 0; x < size; x += 1) {
      const seat = state.cells[y * size + x];
      cells.push(typeof seat === "number" ? STONE_MARKS[seat] : ".");
    }
    rows.push(String(y + 1).padStart(2) + "  " + cells.join(" "));
  }
  return [header, ...rows].join("\n");
}

/** Seat at a point, or -1 off the board, or null when the point is empty. */
function seatAt(state, x, y) {
  const size = state.boardSize;
  if (x < 0 || y < 0 || x >= size || y >= size) return -1;
  const value = state.cells[y * size + x];
  return typeof value === "number" ? value : null;
}

/** How strong `seat`'s line through (x, y) would be if that stone were played. */
function axisRun(state, x, y, dx, dy, seat) {
  let length = 1;
  let openEnds = 0;
  for (const sign of [1, -1]) {
    let steps = 0;
    while (seatAt(state, x + dx * sign * (steps + 1), y + dy * sign * (steps + 1)) === seat) steps += 1;
    length += steps;
    if (seatAt(state, x + dx * sign * (steps + 1), y + dy * sign * (steps + 1)) === null) openEnds += 1;
  }
  return length * (1 + openEnds * 0.5);
}

/**
 * Deliberately simple policy: take a six if one exists, block the opponent's six
 * otherwise, then grow the strongest shape. Swap this for a search or an LLM call
 * and the rest of the loop keeps working unchanged.
 */
function chooseAction(state, legalActions, seat) {
  const opponent = 1 - seat;
  const centre = (state.boardSize - 1) / 2;
  let best = null;
  let bestScore = -Infinity;
  for (const action of legalActions) {
    if (action.type !== "place") continue;
    let own = 0;
    let block = 0;
    for (const [dx, dy] of DIRECTIONS) {
      own = Math.max(own, axisRun(state, action.x, action.y, dx, dy, seat));
      block = Math.max(block, axisRun(state, action.x, action.y, dx, dy, opponent));
    }
    const centrality = -(Math.abs(action.x - centre) + Math.abs(action.y - centre)) * 0.01;
    const score = own >= 6 ? 1e6
      : block >= 6 ? 5e5
        : own * 10 + block * 8 + centrality;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best || legalActions[0];
}

async function main() {
  const created = await api("/api/games", {
    method: "POST",
    body: ARENA
      ? { mode: "arena", playerCount: 2, seats: [{ kind: "agent", name: "Agent A" }, { kind: "agent", name: "Agent B", timeLimitMs: 0 }] }
      : { mode: "ai", playerCount: 2, seats: [{ kind: "agent", name: "External Agent" }, { kind: "ai", name: "Local AI", engine: "local", difficulty: "normal" }] }
  });
  const gameId = created.game.id;
  console.log("game", gameId, "mode", created.game.mode);

  const seats = ARENA ? [0, 1] : [0];
  const tokens = {};
  for (const seat of seats) {
    const minted = await api("/api/games/" + gameId + "/seats/" + seat + "/token", { method: "POST" });
    tokens[seat] = minted.token;
    console.log("seat", seat, "token", minted.token.slice(0, 24) + "...");
  }

  let moves = 0;
  let view = await api("/api/agent/game", { token: tokens[seats[0]] });

  while (view.game.status !== "finished" && moves < 400) {
    const seat = view.game.state?.currentSeat;
    if (!seats.includes(seat)) break;

    const mine = await api("/api/agent/game", { token: tokens[seat] });
    if (!mine.turn.isMyTurn) {
      view = mine;
      continue;
    }

    const action = chooseAction(mine.game.state, mine.turn.legalActions, seat);
    try {
      view = await api("/api/agent/actions", {
        method: "POST",
        token: tokens[seat],
        body: { turnId: mine.turn.turnId, action }
      });
    } catch (error) {
      if (error.code === "STALE_TURN" || error.code === "NOT_YOUR_TURN") {
        view = await api("/api/agent/game", { token: tokens[seats[0]] });
        continue;
      }
      throw error;
    }
    moves += 1;
  }

  const final = await api("/api/games/" + gameId);
  console.log("\n" + renderBoard(final.game.state));
  console.log("\nstatus:", final.game.status, "| moves:", moves);
  if (final.game.result) {
    console.log("scores:", JSON.stringify(final.game.result.scores), "| winner seats:", JSON.stringify(final.game.result.winnerSeats));
  }
}

main().catch((error) => {
  console.error("agent failed:", error.message);
  process.exitCode = 1;
});
