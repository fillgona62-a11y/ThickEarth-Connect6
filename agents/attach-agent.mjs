#!/usr/bin/env node
/**
 * Minimal agent that attaches to a game you already created in the browser.
 *
 * Use this when the game and the seat already exist, and you copied the token
 * from the "Agent seat" panel (it is shown exactly once):
 *
 *   node agents/attach-agent.mjs <gameId> <token> [baseUrl]
 *
 * Everything below the `EDIT THIS` marker is plumbing you can leave alone.
 * The only function worth replacing is chooseMove() — put your policy, a
 * search, or an LLM call in there and the loop keeps working.
 *
 * Contract reference: docs/AGENT-SEAT.md
 */

import { agentBaseUrl, agentRequest } from "./http-client.mjs";

const [gameArg, secondArg, thirdArg] = process.argv.slice(2);
const tokenArg = secondArg && !secondArg.startsWith("http") ? secondArg : process.env.THICK_EARTH_AGENT_TOKEN;
if (!gameArg || !tokenArg) {
  console.error("usage: node agents/attach-agent.mjs <gameId> [token] [baseUrl] (or set THICK_EARTH_AGENT_TOKEN)");
  process.exit(1);
}
const BASE = agentBaseUrl(thirdArg ?? (secondArg?.startsWith("http") ? secondArg : "http://127.0.0.1:7788"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = (path, options = {}) => agentRequest(BASE, path, { ...options, token: tokenArg });

// ---------------------------------------------------------------------------
// EDIT THIS: given the position, return one legal action ({ type, x, y }).
//
// state.cells is a flat row-major array of length boardSize * boardSize:
//   cells[y * boardSize + x] is a seat number, or null for an empty point.
// legalActions is the list the server will accept right now.
//
// The default below just plays near the centre, so it is easy to see the
// plumbing working before you add any real thinking.
// ---------------------------------------------------------------------------
function chooseMove({ state, legalActions, seat }) {
  const centre = (state.boardSize - 1) / 2;
  const distance = (action) => Math.abs(action.x - centre) + Math.abs(action.y - centre);
  const places = legalActions.filter((action) => action.type === "place");
  return places.slice().sort((a, b) => distance(a) - distance(b))[0] ?? legalActions[0];
}
// ---------------------------------------------------------------------------

const cellName = (action) => String.fromCharCode(65 + action.x) + (action.y + 1);

async function main() {
  for (;;) {
    let view;
    try {
      view = await api("/api/agent/game");
    } catch (error) {
      if (error.code === "AGENT_TOKEN_INVALID" || error.code === "FORBIDDEN") throw error;
      await sleep(500);
      continue;
    }

    if (view.game.id !== gameArg) throw new Error("The token belongs to a different game.");

    if (view.game.status === "finished") {
      console.log("\n" + view.game.status);
      if (view.game.result) {
        console.log("scores:", JSON.stringify(view.game.result.scores),
          "| winner seats:", JSON.stringify(view.game.result.winnerSeats));
      }
      return;
    }

    const { turn } = view;
    if (!turn.isMyTurn) {
      await sleep(400);
      continue;
    }

    const action = chooseMove({ state: view.game.state, legalActions: turn.legalActions, seat: turn.seat });
    if (!action) {
      console.error("no legal action returned by chooseMove; stopping");
      return;
    }

    try {
      await api("/api/agent/actions", { method: "POST", body: { turnId: turn.turnId, action } });
      console.log("seat " + turn.seat + " plays", cellName(action),
        "| owed after this stone:", turn.stonesRemainingThisTurn - 1);
    } catch (error) {
      // A stale turnId means the board moved on. Re-read instead of retrying.
      if (error.code === "STALE_TURN" || error.code === "NOT_YOUR_TURN") {
        await sleep(200);
        continue;
      }
      throw error;
    }
  }
}

main().catch((error) => {
  console.error("agent failed:", error.message);
  process.exitCode = 1;
});
