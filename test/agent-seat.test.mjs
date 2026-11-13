/**
 * Agent seat contract tests. Each case boots a real server on an ephemeral port
 * with a throwaway SQLite file, so nothing touches the user's real database.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "thickearth-test-")), "test.db");
}

async function withServer(run) {
  const instance = await startServer({
    mode: "desktop",
    host: "127.0.0.1",
    port: 0,
    dbPath: tempDbPath(),
    logger: silentLogger
  });
  try {
    await run("http://127.0.0.1:" + instance.port);
  } finally {
    await instance.close();
  }
}

async function call(base, path, { method = "GET", body, token } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createAgentGame(base, seats, { mode = "ai", playerCount = 2 } = {}) {
  const created = await call(base, "/api/games", { method: "POST", body: { mode, playerCount, seats } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.game;
}

async function mint(base, gameId, seat) {
  const minted = await call(base, "/api/games/" + gameId + "/seats/" + seat + "/token", { method: "POST" });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return minted.body.token;
}

const AGENT_SEATS = [
  { kind: "agent", name: "External Agent" },
  { kind: "ai", name: "Local AI", engine: "local", difficulty: "normal" }
];

/** Drives every agent seat to the end of the game and returns the final view. */
async function driveToEnd(base, gameId, seatTokens) {
  const tokens = Object.values(seatTokens);
  let view = (await call(base, "/api/agent/game", { token: tokens[0] })).body;
  let moves = 0;
  while (view.game.status !== "finished" && moves < 400) {
    const seat = view.game.state?.currentSeat;
    const token = seatTokens[seat];
    assert.ok(token, "expected an agent token for seat " + seat);
    const mine = (await call(base, "/api/agent/game", { token })).body;
    if (!mine.turn.isMyTurn) {
      view = mine;
      continue;
    }
    assert.ok(mine.turn.legalActions.length > 0, "an active turn must expose legal actions");
    const submitted = await call(base, "/api/agent/actions", {
      method: "POST",
      token,
      body: { turnId: mine.turn.turnId, action: mine.turn.legalActions[0] }
    });
    if (submitted.status === 200) {
      view = submitted.body;
      moves += 1;
      continue;
    }
    const code = submitted.body?.error?.code;
    if (submitted.status === 409 && (code === "STALE_TURN" || code === "NOT_YOUR_TURN")) {
      view = (await call(base, "/api/agent/game", { token: tokens[0] })).body;
      continue;
    }
    assert.fail("unexpected submit response " + submitted.status + " " + JSON.stringify(submitted.body));
  }
  return { view, moves };
}

test("agent seats are created and the turn view exposes the seat contract", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, AGENT_SEATS);
    assert.equal(game.players[0].kind, "agent");
    assert.equal(game.players[0].timeLimitMs, 20000);
    assert.equal(game.players[1].kind, "ai");

    const token = await mint(base, game.id, 0);
    assert.match(token, /^teagent\.g_/);

    const view = await call(base, "/api/agent/game", { token });
    assert.equal(view.status, 200);
    assert.equal(view.body.turn.seat, 0);
    assert.equal(view.body.turn.isMyTurn, true);
    assert.ok(view.body.turn.legalActions.length > 0);
    assert.ok(Number.isInteger(view.body.turn.turnId));
    assert.ok(view.body.turn.deadlineAt > Date.now());
  });
});

test("missing and forged tokens are rejected", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, AGENT_SEATS);
    const token = await mint(base, game.id, 0);

    const missing = await call(base, "/api/agent/game");
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, "AGENT_TOKEN_REQUIRED");

    const garbage = await call(base, "/api/agent/game", { token: "not-a-token" });
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.error.code, "AGENT_TOKEN_INVALID");

    const forged = await call(base, "/api/agent/game", { token: "teagent." + game.id + ".0." + "a".repeat(32) });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, "FORBIDDEN");

    const valid = await call(base, "/api/agent/game", { token });
    assert.equal(valid.status, 200);
  });
});

test("ai seats cannot be turned into agent seats", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, AGENT_SEATS);
    const response = await call(base, "/api/games/" + game.id + "/seats/1/token", { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "NOT_AGENT_SEAT");
  });
});

test("a token is scoped to its own game and seat", async () => {
  await withServer(async (base) => {
    const first = await createAgentGame(base, AGENT_SEATS);
    const second = await createAgentGame(base, AGENT_SEATS);
    const token = await mint(base, first.id, 0);

    const before = (await call(base, "/api/games/" + second.id)).body.game.state.seq;
    const ownView = (await call(base, "/api/agent/game", { token })).body;
    const submitted = await call(base, "/api/agent/actions", {
      method: "POST",
      token,
      body: { turnId: ownView.turn.turnId, action: ownView.turn.legalActions[0] }
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.game.id, first.id, "the token must only ever address its own game");

    const after = (await call(base, "/api/games/" + second.id)).body.game.state.seq;
    assert.equal(after, before, "the other game must be untouched");
  });
});

test("stale turn ids are refused so a slow reply cannot land on a later position", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, AGENT_SEATS);
    const token = await mint(base, game.id, 0);
    const view = (await call(base, "/api/agent/game", { token })).body;
    const action = view.turn.legalActions[0];

    const stale = await call(base, "/api/agent/actions", {
      method: "POST",
      token,
      body: { turnId: view.turn.turnId + 7, action }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "STALE_TURN");

    const fresh = await call(base, "/api/agent/actions", {
      method: "POST",
      token,
      body: { turnId: view.turn.turnId, action }
    });
    assert.equal(fresh.status, 200);
  });
});

test("a silent agent is carried forward by the deadline fallback", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, [
      { kind: "agent", name: "Mute Agent", timeLimitMs: 200 },
      { kind: "ai", name: "Local AI", engine: "local" }
    ]);
    const before = (await call(base, "/api/games/" + game.id)).body.game.state.seq;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = (await call(base, "/api/games/" + game.id)).body.game;
    assert.ok(after.state.seq > before, "the fallback must advance the position");
    assert.ok(after.players[0].fallbackCount >= 1, "the fallback must be recorded on the seat");
  });
});

test("an agent plays a complete game against the local AI", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, AGENT_SEATS);
    const token = await mint(base, game.id, 0);
    const { view, moves } = await driveToEnd(base, game.id, { 0: token });
    assert.equal(view.game.status, "finished");
    assert.ok(moves > 5, "a full game needs more than a few moves");
    assert.equal(view.game.players[0].fallbackCount, 0, "a responsive agent never uses the fallback");
    assert.ok(Array.isArray(view.game.result.scores));
  });
});

test("arena mode lets two external agents play each other", async () => {
  await withServer(async (base) => {
    const game = await createAgentGame(base, [{ kind: "agent" }, { kind: "agent" }], { mode: "arena" });
    assert.deepEqual(game.players.map((player) => player.kind), ["agent", "agent"]);
    const seatZero = await mint(base, game.id, 0);
    const seatOne = await mint(base, game.id, 1);
    const { view } = await driveToEnd(base, game.id, { 0: seatZero, 1: seatOne });
    assert.equal(view.game.status, "finished");
    assert.ok(view.game.result.scores.length === 2);
  });
});

test("seat composition is validated per mode", async () => {
  await withServer(async (base) => {
    const humanInArena = await call(base, "/api/games", {
      method: "POST",
      body: { mode: "arena", playerCount: 2, seats: [{ kind: "human" }, { kind: "agent" }] }
    });
    assert.equal(humanInArena.status, 400);
    assert.equal(humanInArena.body.error.code, "INVALID_SEAT");

    const noAgentInArena = await call(base, "/api/games", {
      method: "POST",
      body: { mode: "arena", playerCount: 2, seats: [{ kind: "ai" }, { kind: "ai" }] }
    });
    assert.equal(noAgentInArena.status, 400);
    assert.equal(noAgentInArena.body.error.code, "INVALID_SEAT_MIX");

    const noAiInAiMode = await call(base, "/api/games", {
      method: "POST",
      body: { mode: "ai", playerCount: 2, seats: [{ kind: "agent" }, { kind: "agent" }] }
    });
    assert.equal(noAiInAiMode.status, 400);
    assert.equal(noAiInAiMode.body.error.code, "INVALID_SEAT_MIX");
  });
});
