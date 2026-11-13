import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server/index.js";
import { openDatabase, createRepositories } from "../server/db.js";
import { createGameService } from "../server/games.js";
import { createAgentDeadlineScheduler } from "../server/agent-seats.js";

const logger = { info() {}, warn() {}, error() {} };
const seats = [{ kind: "agent", timeLimitMs: 0 }, { kind: "agent", timeLimitMs: 0 }];
async function withServer(run) {
  const server = await startServer({ mode: "desktop", host: "127.0.0.1", port: 0, dbPath: ":memory:", logger });
  const base = "http://127.0.0.1:" + server.port;
  async function call(path, { body, token, method = body ? "POST" : "GET" } = {}) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  try { await run(call, base); } finally { await server.close(); }
}

test("agent actions require an integer position id and old tokens stop working after rotation", async () => {
  await withServer(async (call) => {
    const game = (await call("/api/games", { body: { mode: "arena", playerCount: 2, seats } })).body.game;
    const path = "/api/games/" + game.id + "/seats/0/token";
    const token = (await call(path, { method: "POST" })).body.token;
    for (const turnId of [undefined, null, "0", -1, 0.5]) {
      const result = await call("/api/agent/actions", { token, body: { turnId, action: { type: "place", x: 9, y: 9 } } });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "INVALID_TURN_ID");
    }
    const rotated = (await call(path, { method: "POST" })).body.token;
    assert.equal((await call("/api/agent/game", { token })).status, 403);
    assert.equal((await call("/api/agent/actions", { token: rotated, body: { turnId: 0, action: { type: "place", x: 9, y: 9 } } })).status, 200);
  });
});

test("agent SSE sends subsequent seat turns and rotation closes the old stream", async () => {
  await withServer(async (call, base) => {
    const game = (await call("/api/games", { body: { mode: "arena", playerCount: 2, seats } })).body.game;
    const mint = "/api/games/" + game.id + "/seats/0/token";
    const black = (await call(mint, { method: "POST" })).body.token;
    const white = (await call("/api/games/" + game.id + "/seats/1/token", { method: "POST" })).body.token;
    const controller = new AbortController();
    const response = await fetch(base + "/api/agent/events", { headers: { Authorization: "Bearer " + black }, signal: controller.signal });
    const reader = response.body.getReader();
    let buffer = "";
    async function nextTurn(seq) {
      const deadline = setTimeout(() => controller.abort(), 2500);
      try {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (frame.startsWith("event: turn\n")) {
              const event = JSON.parse(frame.split("data: ")[1]);
              if (event.turnId === seq) return event;
            }
          } else {
            const chunk = await reader.read();
            assert.equal(chunk.done, false, "event stream ended early");
            buffer += new TextDecoder().decode(chunk.value);
          }
        }
      } finally { clearTimeout(deadline); }
    }
    try {
      assert.equal((await nextTurn(0)).isMyTurn, true);
      await call("/api/agent/actions", { token: black, body: { turnId: 0, action: { type: "place", x: 9, y: 9 } } });
      assert.equal((await nextTurn(1)).isMyTurn, false);
      await call("/api/agent/actions", { token: white, body: { turnId: 1, action: { type: "place", x: 10, y: 9 } } });
      await call("/api/agent/actions", { token: white, body: { turnId: 2, action: { type: "place", x: 10, y: 10 } } });
      assert.equal((await nextTurn(3)).isMyTurn, true);
      await call(mint, { method: "POST" });
      // Drain any already delivered frames and observe the server closing this token's stream.
      while (!(await reader.read()).done) {}
    } finally { controller.abort(); }
  });
});

test("reading an unchanged position never extends the agent deadline", () => {
  let now = 1000;
  const scheduler = createAgentDeadlineScheduler({ games: {}, now: () => now });
  try {
    const row = { id: "test", status: "play", currentState: { seq: 0, currentSeat: 0 }, seats: [{ kind: "agent", timeLimitMs: 20000 }] };
    scheduler.schedule(row);
    const deadline = scheduler.deadlineFor(row.id, 0);
    now += 5000;
    scheduler.schedule(row);
    assert.equal(scheduler.deadlineFor(row.id, 0), deadline);
    row.currentState.seq = 1;
    scheduler.schedule(row);
    assert.equal(scheduler.deadlineFor(row.id, 0), now + 20000);
  } finally { scheduler.cancelAll(); }
});

test("agent deadline survives a server restart without adding a fresh allowance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thickearth-deadline-"));
  const options = { mode: "desktop", host: "127.0.0.1", port: 0, dbPath: join(directory, "test.db"), logger };
  let server = await startServer(options);
  try {
    let base = "http://127.0.0.1:" + server.port;
    const response = await fetch(base + "/api/games", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "arena", playerCount: 2, seats: [{ kind: "agent", timeLimitMs: 20000 }, seats[1]] }) });
    const game = (await response.json()).game;
    const minted = await fetch(base + "/api/games/" + game.id + "/seats/0/token", { method: "POST" });
    const token = (await minted.json()).token;
    const get = async () => (await (await fetch(base + "/api/agent/game", { headers: { Authorization: "Bearer " + token } })).json()).turn.deadlineAt;
    const before = await get();
    await server.close();
    server = await startServer(options);
    base = "http://127.0.0.1:" + server.port;
    assert.equal(await get(), before);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a late timeout computation cannot overwrite a real agent move or increment fallback count", async () => {
  const db = openDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    let resolveChoice;
    const games = createGameService({ repositories, ai: { chooseAction: () => new Promise((resolve) => { resolveChoice = resolve; }) }, logger });
    const game = await games.create({ mode: "arena", playerCount: 2, seats }, { id: "owner", displayName: "owner" });
    const timeout = games.applyAgentTimeout(game.id, { seat: 0, turnId: 0 });
    await games.submitAgentAction(game.id, 0, { type: "place", x: 9, y: 9 }, { turnId: 0 });
    resolveChoice({ type: "place", x: 0, y: 0 });
    assert.equal(await timeout, null);
    const row = repositories.getGame(game.id);
    assert.equal(row.currentState.seq, 1);
    assert.equal(row.currentState.cells[0], null);
    assert.equal(row.seats[0].fallbackCount, 0);
  } finally { db.close(); }
});
