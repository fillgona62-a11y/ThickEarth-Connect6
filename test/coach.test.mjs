import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server/index.js";
import { createProvider } from "../server/ai-provider.js";

const logger = { info() {}, warn() {}, error() {} };
const settings = (name) => ({
  enabled: true, provider: "custom", baseUrl: "https://" + name + ".example/v1",
  model: name + "-model", apiKey: "test-" + name + "-key", monthlyCallLimit: 20
});
const report = {
  headline: "回看白方第六回合的防守", summary: "黑方在 F10 连成六子。",
  strengths: [], weaknesses: [], recommendations: [], trainingPlan: ["复盘 F10 的防守。"],
  keyMistakes: [
    { seat: 1, turn: 2, actual: "L1", better: "K1", reason: "比较同回合两子的作用。" },
    { seat: 0, turn: 2, actual: "L1", reason: "错误的落子方，应被过滤。" },
    { seat: 1, turn: 2, actual: "S19", reason: "不存在的实际落点，应被过滤。" }
  ]
};

async function withServer(options, work) {
  const server = await startServer({
    mode: "web", secureCookies: false, port: 0, host: "127.0.0.1", logger, ...options
  });
  async function call(path, { method = "GET", body, cookie } = {}) {
    const response = await fetch("http://127.0.0.1:" + server.port + path, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null,
      cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  try { await work(call); } finally { await server.close(); }
}

test("coach reports and chat share the administrator's model, quota and persisted switch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connect6-coach-"));
  const dbPath = join(directory, "site.db");
  const env = { ADMIN_USER_EMAIL: "owner@example.com" };
  let ownerCookie;
  let guestCookie;
  let gameId;
  let repairNeeded = true;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, authorization: options.headers.Authorization, body });
    const isReport = body.messages[0].content.includes("post-game report");
    let content = isReport ? JSON.stringify(report) : "先检查 F10 的连六威胁，再决定另一子的落点。";
    if (isReport && repairNeeded) { repairNeeded = false; content = "incomplete report"; }
    return new Response(JSON.stringify({ choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  };
  try {
    await withServer({ dbPath, env, fetchImpl }, async (call) => {
      for (const name of ["owner", "guest"]) {
        const registered = await call("/api/auth/register", { method: "POST",
          body: { email: name + "@example.com", password: "test-password", displayName: name } });
        assert.equal(registered.status, 201);
        if (name === "owner") ownerCookie = registered.cookie;
        else guestCookie = registered.cookie;
      }
      await call("/api/ai/settings", { method: "PUT", cookie: ownerCookie, body: settings("shared") });
      // An unconfigured borrower's personal budget must not block the shared model.
      await call("/api/ai/settings", { method: "PUT", cookie: guestCookie, body: { monthlyCallLimit: 0 } });
      const created = await call("/api/games", { method: "POST", cookie: guestCookie,
        body: { mode: "local", playerCount: 2, seats: [{ kind: "human" }, { kind: "human" }] } });
      assert.equal(created.status, 201);
      gameId = created.body.game.id;
      for (const [x, y] of [[0, 9], [10, 0], [11, 0], [1, 9], [2, 9], [10, 1], [11, 1],
        [3, 9], [4, 9], [10, 2], [11, 2], [5, 9]]) {
        const moved = await call("/api/games/" + gameId + "/actions", { method: "POST", cookie: guestCookie,
          body: { action: { type: "place", x, y } } });
        assert.equal(moved.status, 200);
      }
    });
    await withServer({ dbPath, env, fetchImpl }, async (call) => {
      const path = "/api/games/" + gameId + "/coach";
      assert.equal((await call("/api/admin/shared-llm", { method: "PUT", cookie: guestCookie,
        body: { enabled: true } })).status, 403);
      assert.equal((await call("/api/admin/shared-llm", { method: "PUT", cookie: ownerCookie,
        body: { enabled: true } })).body.available, true);
      const config = (await call(path, { cookie: guestCookie })).body.config;
      assert.equal(config.configured, true);
      assert.equal(config.source, "shared");
      assert.equal(config.hasKey, false);
      assert.equal(JSON.stringify(config).includes("test-shared-key"), false);
      assert.equal(JSON.stringify(config).includes("shared.example"), false);
      const generated = await call(path, { method: "POST", cookie: guestCookie, body: {} });
      assert.equal(generated.status, 200);
      assert.equal(generated.body.report.source, "llm");
      assert.equal(generated.body.report.model, "shared-model");
      assert.equal(calls.length, 2, "invalid first response is repaired once");
      assert.equal(calls[0].authorization, "Bearer test-shared-key");
      assert.ok(calls[1].body.messages.some((message) => message.content === "incomplete report"));
      assert.equal(generated.body.report.keyMistakes.length, 1, "fabricated turns/seats/cells are removed");
      assert.equal(generated.body.report.keyMistakes[0].better, undefined, "the first stone is occupied before the second stone");
      const chatted = await call(path + "/messages", { method: "POST", cookie: guestCookie, body: { message: "应该防哪里？" } });
      assert.equal(chatted.status, 200);
      assert.match(chatted.body.reply, /F10/);
      assert.equal((await call("/api/ai/settings", { cookie: ownerCookie })).body.usage.monthCalls, 3);
      assert.equal((await call("/api/ai/settings", { cookie: guestCookie })).body.usage.monthCalls, 0);
      assert.equal((await call(path, { method: "POST", body: {} })).status, 401);
    });
    await withServer({ dbPath, env, fetchImpl }, async (call) => {
      const path = "/api/games/" + gameId + "/coach";
      assert.equal((await call(path, { cookie: guestCookie })).body.config.source, "shared", "source survives restart without AI_SHARED_USER_ID");
      await call("/api/ai/settings", { method: "PUT", cookie: guestCookie, body: settings("personal") });
      assert.equal((await call(path, { method: "POST", cookie: guestCookie, body: { force: true } })).status, 200);
      assert.equal(calls.at(-1).authorization, "Bearer test-personal-key");
      await call("/api/admin/shared-llm", { method: "PUT", cookie: ownerCookie, body: { enabled: false } });
      assert.equal((await call(path, { method: "POST", cookie: guestCookie, body: { force: true } })).status, 200);
      assert.equal(calls.at(-1).authorization, "Bearer test-personal-key");
      await call("/api/ai/key", { method: "DELETE", cookie: guestCookie });
      assert.equal((await call(path, { cookie: guestCookie })).body.config.configured, false);
      const count = calls.length;
      assert.equal((await call(path, { method: "POST", cookie: guestCookie, body: { force: true } })).status, 409);
      assert.equal((await call(path + "/messages", { method: "POST", cookie: guestCookie, body: { message: "继续" } })).status, 409);
      assert.equal(calls.length, count, "disabled sharing never sends the shared credential");
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("DeepSeek coach output and connection tests reserve their token budget for visible content", async () => {
  const provider = createProvider({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", apiKey: "test-key" }, {
    env: {}, fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const content = request.thinking?.type === "disabled" ? "OK" : "";
      return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "reasoning uses the token budget" } }] }));
    }
  });
  for (const kind of ["coach-report", "coach-chat", "test"]) {
    const completion = await provider.complete({ kind, messages: [{ role: "user", content: "Reply OK" }] });
    assert.equal(completion.text, "OK");
  }
});
