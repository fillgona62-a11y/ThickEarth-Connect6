/** Functional evaluation of the shipped clients, isolated from the user's database. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startServer } from "../server/index.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await startServer({ mode: "desktop", host: "127.0.0.1", port: 0, dbPath: ":memory:", logger: { info() {}, warn() {}, error() {} } });
const base = "http://127.0.0.1:" + server.port;
const samples = [];
async function call(path, body) {
  const response = await fetch(base + path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, path + " failed with " + response.status);
  return response.json();
}
function sample(label, game, elapsedMs) {
  assert.equal(game.status, "finished", label + " did not finish");
  const fallbackCount = game.players.reduce((total, player) => total + (player.fallbackCount ?? 0), 0);
  assert.equal(fallbackCount, 0, "evaluation must not contain fallback actions");
  samples.push({ client: label, status: game.status, decisions: game.state.seq, winnerSeats: game.result.winnerSeats, fallbackCount, elapsedMs: Math.round(elapsedMs) });
}
try {
  for (const arena of [false, true]) {
    const start = performance.now();
    const { stdout } = await execute(process.execPath, ["agents/example-client.mjs", base, ...(arena ? ["--arena"] : [])], { cwd: root, timeout: 30000 });
    const id = /game (g_[a-zA-Z0-9]+)/.exec(stdout)?.[1];
    assert.ok(id);
    sample(arena ? "example-client: two agents" : "example-client: vs local normal", (await call("/api/games/" + id)).game, performance.now() - start);
  }
  const created = await call("/api/games", { mode: "ai", playerCount: 2, seats: [{ kind: "agent", timeLimitMs: 20000 }, { kind: "ai", engine: "local", difficulty: "normal" }] });
  const response = await fetch(base + "/api/games/" + created.game.id + "/seats/0/token", { method: "POST" });
  const token = (await response.json()).token;
  const start = performance.now();
  await execute(process.execPath, ["agents/attach-agent.mjs", created.game.id, base], { cwd: root, timeout: 30000, env: { ...process.env, THICK_EARTH_AGENT_TOKEN: token } });
  sample("attach-agent: default policy vs local normal", (await call("/api/games/" + created.game.id)).game, performance.now() - start);
  const report = { evaluatedAt: new Date().toISOString(), scope: "Functional samples of the shipped clients, not a statistical strength rating or evaluation of an external LLM.", samples };
  mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../artifacts/agent-evaluation.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await server.close(); }
