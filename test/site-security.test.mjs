import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLoginRateLimiter } from "../server/auth.js";
import { clientAddress } from "../server/http.js";
import { startServer, resolveRuntimeOptions } from "../server/index.js";
import { createProvider } from "../server/ai-provider.js";
import { createProviderFetch, createPublicLookup, isPrivateOrReservedHost, validateBaseUrl } from "../server/ai-network.js";
import { createAiSettingsService } from "../server/ai-settings.js";
import { createSecretStore } from "../server/ai-secret.js";
import { openDatabase, createRepositories } from "../server/db.js";
import { createGameService } from "../server/games.js";
import { completedGamesToCsv } from "../server/playtest.js";

const logger = { info() {}, warn() {}, error() {} };
async function withServer(options, run) {
  const server = await startServer({ mode: "web", secureCookies: false, port: 0, host: "127.0.0.1", dbPath: ":memory:", logger, ...options });
  const base = "http://127.0.0.1:" + server.port;
  async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  }
  try { await run(call, base); } finally { await server.close(); }
}
async function register(call, name) {
  const result = await call("/api/auth/register", { method: "POST", body: { email: name + "@example.com", password: "audit-password", displayName: name } });
  assert.equal(result.status, 201);
  return { ...result.body.user, cookie: result.cookie };
}
const config = (name) => ({ enabled: true, provider: "custom", baseUrl: "https://" + name + ".example/v1", model: name + "-model", apiKey: "audit-" + name + "-key" });

test("desktop rejects foreign origins, simple JSON posts and rebound hosts", async () => {
  await withServer({ mode: "desktop" }, async (call, base) => {
    const foreign = await call("/api/ai/test", { method: "POST", headers: { Origin: "https://foreign.example", "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(foreign.status, 403);
    assert.equal((await call("/api/games", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    const reboundStatus = await new Promise((resolve, reject) => {
      get(base + "/api/config", { headers: { Host: "rebound.example" } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await call("/api/config", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    const own = await call("/api/ai/settings");
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("cache-control"), "no-store");
    assert.match(own.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });
  assert.throws(() => resolveRuntimeOptions({ mode: "desktop", host: "0.0.0.0" }), /loopback/);
});

test("a changed provider prefix cannot receive a stored key through test or save", async () => {
  const sent = [];
  await withServer({ mode: "desktop", fetchImpl: async (url, options) => {
    sent.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  } }, async (call) => {
    assert.equal((await call("/api/ai/settings", { method: "PUT", body: config("owner") })).status, 200);
    assert.equal((await call("/api/ai/test", { method: "POST", body: { baseUrl: "https://other.example/v1" } })).status, 400);
    assert.equal(sent.length, 0);
    assert.equal((await call("/api/ai/test", { method: "POST", body: {} })).status, 200);
    assert.equal(sent[0].authorization, "Bearer audit-owner-key");
    const changed = await call("/api/ai/settings", { method: "PUT", body: { baseUrl: "https://owner.example/v2" } });
    assert.equal(changed.body.hasKey, false);
    assert.equal(changed.body.configured, false);
  });
});

test("all signed-in users can borrow the pinned LLM; personal settings take priority and stay isolated", async () => {
  const env = { AI_SHARED_LLM: "1" };
  const calls = [];
  await withServer({ env, fetchImpl: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{ type: "place", x: 0, y: 0 }, { type: "place", x: 1, y: 0 }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  } }, async (call) => {
    const owner = await register(call, "owner");
    const guest = await register(call, "guest");
    const personal = await register(call, "personal");
    await call("/api/ai/settings", { method: "PUT", cookie: owner.cookie, body: config("shared") });
    // Enabling sharing without pinning an account must not select a visitor's credential.
    assert.equal((await call("/api/ai/settings", { cookie: guest.cookie })).body.sharedAvailable, false);
    env.AI_SHARED_USER_ID = owner.id;
    const settings = (await call("/api/ai/settings", { cookie: guest.cookie })).body;
    assert.equal(settings.sharedAvailable, true);
    assert.equal(settings.hasKey, false);
    assert.equal(settings.baseUrl, "");
    assert.equal(settings.keyHint, "");
    assert.equal(JSON.stringify(settings).includes("audit-shared-key"), false);
    async function play(user) {
      const created = await call("/api/games", { method: "POST", cookie: user.cookie, body: { mode: "ai", playerCount: 2, seats: [{ kind: "human" }, { kind: "ai", engine: "llm" }] } });
      assert.equal(created.status, 201);
      const result = await call("/api/games/" + created.body.game.id + "/actions", { method: "POST", cookie: user.cookie, body: { action: { type: "place", x: 9, y: 9 } } });
      assert.equal(result.status, 200);
      assert.equal(result.body.game.state.seq, 3);
    }
    await play(guest);
    assert.equal(calls.at(-1).authorization, "Bearer audit-shared-key");
    await call("/api/ai/settings", { method: "PUT", cookie: personal.cookie, body: config("personal") });
    await play(personal);
    assert.equal(calls.at(-1).authorization, "Bearer audit-personal-key");
    assert.equal((await call("/api/ai/settings", { cookie: owner.cookie })).body.usage.monthCalls, 1);
    assert.equal((await call("/api/ai/settings", { cookie: personal.cookie })).body.usage.monthCalls, 1);
    await call("/api/ai/key", { method: "DELETE", cookie: personal.cookie });
    await play(personal);
    assert.equal(calls.at(-1).authorization, "Bearer audit-shared-key");
    assert.equal((await call("/api/ai/settings")).status, 401);
    assert.equal((await call("/api/games", { method: "POST", body: { mode: "ai", playerCount: 2 } })).status, 401);
    const outsider = await register(call, "outsider");
    const privateGame = await call("/api/games", { method: "POST", cookie: owner.cookie, body: { mode: "local", playerCount: 2 } });
    assert.equal((await call("/api/games/" + privateGame.body.game.id, { cookie: outsider.cookie })).status, 403);
  });
});

test("online play starts and spectators cannot access coach conversations or mutate notes", async () => {
  await withServer({}, async (call) => {
    const host = await register(call, "host");
    const guest = await register(call, "player");
    const watcher = await register(call, "watcher");
    const created = await call("/api/games", { method: "POST", cookie: host.cookie, body: { mode: "online", playerCount: 2 } });
    const id = created.body.game.id;
    await call("/api/games/join", { method: "POST", cookie: guest.cookie, body: { roomCode: created.body.game.roomCode } });
    assert.equal((await call("/api/games/" + id + "/start", { method: "POST", cookie: watcher.cookie })).status, 403);
    const start = await call("/api/games/" + id + "/start", { method: "POST", cookie: host.cookie });
    assert.equal(start.status, 200);
    assert.equal(start.body.game.status, "play");
    assert.equal((await call("/api/games/" + id, { cookie: watcher.cookie })).status, 200);
    for (const [suffix, method, body] of [["/coach", "GET"], ["/coach", "POST", {}], ["/coach/messages", "POST", { message: "private" }], ["/hardest-decision", "POST", { note: "overwrite" }], ["/analysis", "POST", {}]]) {
      assert.equal((await call("/api/games/" + id + suffix, { method, body, cookie: watcher.cookie })).status, 403);
    }
    assert.equal((await call("/api/games/" + id + "/actions", { method: "POST", cookie: host.cookie, body: { action: { type: "place", x: 9, y: 9 } } })).status, 200);
    assert.equal((await call("/api/games/" + id + "/actions", { method: "POST", cookie: guest.cookie, body: { action: { type: "place", x: 10, y: 9 } } })).status, 200);
  });
});

test("reserved IPv4, IPv6 and mapped addresses are rejected; socket lookup rejects private DNS answers", async () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:7f00:1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "metadata.internal"]) {
    assert.equal(isPrivateOrReservedHost(host), true, host);
    const urlHost = host.includes(":") ? "[" + host + "]" : host;
    assert.throws(() => validateBaseUrl("https://" + urlHost + "/v1", { mode: "web" }));
  }
  assert.equal(validateBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(isPrivateOrReservedHost("2606:4700:4700::1111"), false);
  const lookup = (addresses) => new Promise((resolve) => createPublicLookup((host, options, callback) => callback(null, addresses))("provider.example", { all: true }, (error, result) => resolve({ error, result })));
  assert.ok((await lookup([{ address: "127.0.0.1", family: 4 }])).error);
  assert.ok((await lookup([{ address: "1.1.1.1", family: 4 }, { address: "10.1.1.1", family: 4 }])).error);
  assert.deepEqual((await lookup([{ address: "1.1.1.1", family: 4 }])).result, [{ address: "1.1.1.1", family: 4 }]);
});

test("native provider transport validates socket DNS and exchanges local provider JSON without redirecting", async () => {
  let lookups = 0;
  const webFetch = createProviderFetch({ mode: "web", lookupImpl(host, options, callback) {
    lookups += 1;
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  } });
  await assert.rejects(webFetch("https://provider.example/v1/chat/completions"), /private or reserved/);
  assert.equal(lookups, 1);
  const requests = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, key: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith("/redirect/")) {
      res.writeHead(302, { Location: "/v1/chat/completions" });
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    }
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  try {
    const origin = "http://127.0.0.1:" + mock.address().port;
    const provider = createProvider({ ...config("native"), baseUrl: origin + "/v1" }, { mode: "desktop", env: {} });
    const completed = await provider.complete({ messages: [{ role: "user", content: "test" }] });
    assert.equal(completed.text, "OK");
    assert.deepEqual(completed.usage, { inputTokens: 3, outputTokens: 1 });
    assert.equal(requests[0].key, "Bearer audit-native-key");
    assert.equal(JSON.parse(requests[0].body).model, "native-model");
    await assert.rejects(createProviderFetch({ mode: "desktop" })(origin + "/redirect/chat/completions"), /redirects/);
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider timeout covers a stalled response body and redirects cannot receive credentials", async () => {
  let signal;
  const stalled = createProvider(config("timeout"), { timeoutMs: 30, fetchImpl: async (url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
  } });
  await assert.rejects(stalled.complete({ messages: [{ role: "user", content: "test" }] }), /timed out/);
  assert.equal(signal.aborted, true);
  const redirect = createProvider(config("redirect"), { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error");
    return new Response(null, { status: 302, headers: { Location: "https://other.example" } });
  } });
  await assert.rejects(redirect.complete({ messages: [{ role: "user", content: "test" }] }), /redirects/);
});

test("usage is reserved before concurrent calls, failures count, and shared borrowers have an independent allowance", async () => {
  const db = openDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    for (const id of ["owner", "borrower"]) repositories.ensureUser({ id, email: id + "@example.com", displayName: id, passwordHash: "", createdAt: 1 });
    const settingsService = createAiSettingsService({ repositories, secretStore: createSecretStore(), env: { AI_MAX_CONCURRENT: "1", AI_SHARED_MAX_CALLS_PER_USER: "1" } });
    settingsService.updateSettings("owner", { ...config("quota"), monthlyCallLimit: 2 });
    const settings = settingsService.resolveForUse("owner");
    let complete;
    const first = settingsService.withUsage(settings, { requestingUserId: "borrower", gameId: "test", kind: "move" }, () => new Promise((resolve) => { complete = resolve; }));
    await assert.rejects(settingsService.withUsage(settings, { requestingUserId: "owner", kind: "test" }, () => assert.fail("must not call provider")), { code: "AI_QUOTA_EXCEEDED" });
    complete({ model: "test", usage: { inputTokens: 4, outputTokens: 2 } });
    await first;
    await assert.rejects(settingsService.withUsage(settings, { requestingUserId: "borrower", kind: "move" }, () => assert.fail("borrower budget exceeded")), { code: "AI_QUOTA_EXCEEDED" });
    await assert.rejects(settingsService.withUsage(settings, { requestingUserId: "owner", kind: "test" }, async () => { throw new Error("network failure"); }), /network failure/);
    await assert.rejects(settingsService.withUsage(settings, { requestingUserId: "owner", kind: "test" }, () => assert.fail("monthly budget exceeded")), { code: "AI_QUOTA_EXCEEDED" });
    assert.equal(repositories.sumAiUsageSince("owner", 0).calls, 2);
    assert.equal(repositories.sumAiUsageSince("owner", 0).inputTokens, 4);
  } finally { db.close(); }
});

test("coach transcripts are isolated between participants and exported notes cannot become formulas", async () => {
  const db = openDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const service = createGameService({ repositories, ai: { chooseAction: async () => null } });
    const game = await service.create({ mode: "local", playerCount: 2 }, { id: "owner", displayName: "owner" });
    for (const userId of ["owner", "other"]) repositories.insertCoachMessage({ gameId: game.id, userId, role: "user", content: userId + " secret", inputTokens: 0, outputTokens: 0, createdAt: 1 });
    assert.deepEqual(repositories.listCoachMessages(game.id, 10, "owner").map((row) => row.content), ["owner secret"]);
    assert.deepEqual(repositories.listCoachMessages(game.id, 10, "other").map((row) => row.content), ["other secret"]);
    const csv = completedGamesToCsv([{ ...game, status: "finished", metrics: { hardestDecisionNote: '=HYPERLINK("https://foreign.example")' } }]);
    assert.match(csv, /'=HYPERLINK/);
  } finally { db.close(); }
});

test("a full limiter cannot erase existing failures and spoofed forwarding headers cannot reset the client address", () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 1, maxTrackedKeys: 1 });
  limiter.recordFailure("blocked");
  limiter.recordFailure("new-address");
  assert.ok(limiter.check("blocked") > 0);
  assert.ok(limiter.check("new-address") > 0);
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.1.1.1" }, socket: { remoteAddress: "8.8.8.8" } }, { trustProxy: true }), "8.8.8.8");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8" }, socket: { remoteAddress: "127.0.0.1" } }, { trustProxy: true }), "8.8.8.8");
});

test("an existing version-two database upgrades without losing games or provider credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thickearth-migration-"));
  const path = join(directory, "old.db");
  let db = openDatabase(path);
  try {
    const repositories = createRepositories(db);
    repositories.ensureUser({ id: "owner", email: "owner@example.com", displayName: "owner", passwordHash: "hash", createdAt: 1 });
    const settings = createAiSettingsService({ repositories, secretStore: createSecretStore({ secret: "audit-stable-secret" }) });
    settings.updateSettings("owner", config("owner"));
    const game = await createGameService({ repositories, ai: { chooseAction: async () => null } }).create({ mode: "local", playerCount: 2 }, { id: "owner", displayName: "owner" });
    db.exec("DROP INDEX idx_ai_usage_requester_time; ALTER TABLE ai_usage DROP COLUMN requested_by_user_id; PRAGMA user_version = 2;");
    db.close(); db = openDatabase(path);
    const migrated = createRepositories(db);
    assert.equal(migrated.getGame(game.id).currentState.seq, 0);
    assert.equal(createAiSettingsService({ repositories: migrated, secretStore: createSecretStore({ secret: "audit-stable-secret" }) }).resolveForUse("owner").apiKey, "audit-owner-key");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
