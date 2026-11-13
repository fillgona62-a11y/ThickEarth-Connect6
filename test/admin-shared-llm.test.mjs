/**
 * Administrator identity and the persisted shared-LLM switch.
 * Identity comes from server configuration only; the toggle must survive a
 * restart and must never be reachable by an ordinary account.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server/index.js";

const logger = { info() {}, warn() {}, error() {} };

async function withServer(options, run) {
  const server = await startServer({
    mode: "web", secureCookies: false, port: 0, host: "127.0.0.1",
    dbPath: ":memory:", logger, ...options
  });
  const base = "http://127.0.0.1:" + server.port;
  async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  try { await run(call); } finally { await server.close(); }
}

const register = async (call, email, name) => {
  const result = await call("/api/auth/register", {
    method: "POST",
    body: { email, password: "audit-password", displayName: name }
  });
  assert.equal(result.status, 201);
  return result.cookie;
};

const llmGame = {
  mode: "ai", playerCount: 2,
  seats: [{ kind: "human", name: "Guest" }, { kind: "ai", name: "LLM", engine: "llm" }]
};

test("admin is granted by server config, toggles the shared switch, and it persists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "te-admin-"));
  const dbPath = join(directory, "site.db");
  const adminEnv = {
    ADMIN_USER_EMAIL: "owner@example.com",
    AI_SHARED_LLM: "1",
    AI_SHARED_USER_EMAIL: "owner@example.com"
  };
  let ownerCookie;
  let guestCookie;

  // Pass 1: create the accounts before the admin configuration is applied.
  await withServer({ dbPath }, async (call) => {
    ownerCookie = await register(call, "owner@example.com", "Owner");
    guestCookie = await register(call, "guest@example.com", "Guest");
    const saved = await call("/api/ai/settings", {
      method: "PUT", cookie: ownerCookie,
      body: {
        enabled: true, provider: "custom", baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-flash", apiKey: "audit-shared-key"
      }
    });
    assert.equal(saved.status, 200);
  });

  // Pass 2: restart with the same database; startup grants the admin flag.
  await withServer({ dbPath, env: adminEnv }, async (call) => {
    const owner = await call("/api/auth/me", { cookie: ownerCookie });
    assert.equal(owner.body.user.isAdmin, true);
    const guest = await call("/api/auth/me", { cookie: guestCookie });
    assert.equal(guest.body.user.isAdmin, false);

    assert.equal((await call("/api/admin/shared-llm", { cookie: guestCookie })).status, 403);
    assert.equal((await call("/api/admin/shared-llm", {
      method: "PUT", cookie: guestCookie, body: { enabled: false }
    })).status, 403);
    assert.equal((await call("/api/admin/shared-llm", { method: "PUT", body: { enabled: false } })).status, 401);

    const before = await call("/api/admin/shared-llm", { cookie: ownerCookie });
    assert.equal(before.status, 200);
    assert.equal(before.body.enabled, true);
    assert.equal(before.body.available, true);

    assert.equal((await call("/api/admin/shared-llm", {
      method: "PUT", cookie: ownerCookie, body: { enabled: "no" }
    })).status, 400);

    const off = await call("/api/admin/shared-llm", {
      method: "PUT", cookie: ownerCookie, body: { enabled: false }
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);

    // With sharing off, a player without a key can no longer open an LLM seat.
    const blocked = await call("/api/games", { method: "POST", cookie: guestCookie, body: llmGame });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, "AI_NOT_CONFIGURED");
  });

  // Pass 3: the switch is still off after another restart, and can be re-enabled.
  await withServer({ dbPath, env: adminEnv }, async (call) => {
    const state = await call("/api/admin/shared-llm", { cookie: ownerCookie });
    assert.equal(state.body.enabled, false);

    const on = await call("/api/admin/shared-llm", {
      method: "PUT", cookie: ownerCookie, body: { enabled: true }
    });
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.available, true);

    const game = await call("/api/games", { method: "POST", cookie: guestCookie, body: llmGame });
    assert.equal(game.status, 201);
  });

  rmSync(directory, { recursive: true, force: true });
});

test("registration cannot self-grant administrator rights", async () => {
  await withServer({ env: { ADMIN_USER_EMAIL: "nobody@example.com" } }, async (call) => {
    const cookie = await register(call, "regular@example.com", "Regular");
    const me = await call("/api/auth/me", { cookie });
    assert.equal(me.body.user.isAdmin, false);
    assert.equal((await call("/api/admin/shared-llm", { cookie })).status, 403);
  });
});
