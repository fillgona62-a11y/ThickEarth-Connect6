/**
 * HTTP application factory. Wires persistence, authentication, game service,
 * realtime events, and static assets into a single request handler.
 *
 * The factory is transport-agnostic: server/index.js owns the node:http server and
 * lifecycle, while the desktop shell can reuse createApplication or startServer
 * in-process. Static assets go through an injectable loader so the SEA build can
 * serve embedded files.
 */

import { readFileSync } from "node:fs";
import {
  BOARD_SIZE,
  FIRST_TURN_STONES,
  PLAYER_COUNTS,
  RULESET_VERSION,
  STONES_PER_TURN,
  WIN_LENGTH,
  RuleError
} from "../shared/rules.js";
import { createAgentProtocol } from "./agent-protocol.js";
import {
  agentTokenMatches,
  createAgentDeadlineScheduler,
  mintAgentToken,
  parseAgentToken
} from "./agent-seats.js";
import { createAiEngine, createLlmMoveEngine } from "./ai.js";
import { createProvider, DEFAULT_TIMEOUT_MS, testConnection } from "./ai-provider.js";
import { createAiSettingsService } from "./ai-settings.js";
import { createSecretStore } from "./ai-secret.js";
import { createAnalysisEngine } from "./analysis.js";
import {
  createAuthService,
  createLoginRateLimiter,
  normalizeEmail
} from "./auth.js";
import { createCoachService } from "./coach.js";
import { createRepositories, openDatabase } from "./db.js";
import { AiProviderError } from "./errors.js";
import { EXPORT_FORMATS, renderGameExport } from "./export.js";
import { createGameService } from "./games.js";
import {
  applyBaseHeaders,
  assertAllowedOrigin,
  clientAddress,
  DEFAULT_BODY_LIMIT,
  HttpError,
  parseCookies,
  readJsonBody,
  readOptionalJsonBody,
  sendJson,
  sendNoContent,
  sendText,
  serializeCookie,
  SESSION_COOKIE_NAME
} from "./http.js";
import { completedGamesToCsv, summarizeCompletedGames } from "./playtest.js";
import { createRealtimeHub } from "./realtime.js";
import { createStaticHandler } from "./static.js";

export const APP_NAME = "ThickEarth";

/** package.json is the single source of truth for the version the UI displays. */
function readPackageVersion() {
  try {
    const file = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export const APP_VERSION =
  process.env.APP_VERSION ?? process.env.THICK_EARTH_VERSION ?? readPackageVersion() ?? "0.0.0";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 10;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function createApplication(options = {}) {
  const mode = options.mode === undefined ? "desktop" : options.mode;
  if (mode !== "desktop" && mode !== "web") {
    throw new Error("APP_MODE must be 'desktop' or 'web'.");
  }
  const logger = normalizeLogger(options.logger);
  const dbPath = options.dbPath ?? ":memory:";
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);
  // Administrator identity is granted by server configuration, never by the
  // registration endpoint. Idempotent: applied on every startup.
  const adminEnv = options.env ?? process.env;
  const adminId = String(adminEnv.ADMIN_USER_ID ?? "").trim();
  const adminEmail = String(adminEnv.ADMIN_USER_EMAIL ?? "").trim().toLowerCase();
  if (adminId) repositories.setUserAdmin(adminId, true);
  else if (adminEmail) {
    const admin = repositories.findUserByEmail(adminEmail);
    if (admin) repositories.setUserAdmin(admin.id, true);
  }
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const secureCookies = options.secureCookies === undefined ? mode === "web" : Boolean(options.secureCookies);
  const publicOrigin = options.publicOrigin ?? null;
  const trustProxy = options.trustProxy === undefined ? Boolean(publicOrigin) : Boolean(options.trustProxy);
  const localViewer = { id: "local", email: null, displayName: "Local Player", createdAt: Date.now() };
  let lastDesktopHeartbeatAt = Date.now();
  if (mode === "desktop") {
    // Keep a real users row for the local viewer so foreign keys (AI settings,
    // sessions) and per-user preferences work in desktop mode too.
    repositories.ensureUser({
      id: localViewer.id,
      email: "local@desktop.invalid",
      displayName: localViewer.displayName,
      passwordHash: "",
      createdAt: localViewer.createdAt
    });
  }

  const secretStore = createSecretStore({
    dbPath,
    secret: options.aiSecret ?? null,
    env: options.env ?? process.env,
    logger
  });
  const aiSettings = createAiSettingsService({
    repositories,
    secretStore,
    mode,
    logger,
    now: options.now,
    env: options.env ?? process.env
  });
  const agentProtocol = createAgentProtocol({ logger });
  const providerEnv = options.aiMock
    ? { ...process.env, THICK_EARTH_AI_MOCK: "1" }
    : (options.env ?? process.env);
  const providerOptions = {
    fetchImpl: options.fetchImpl ?? null,
    mode,
    timeoutMs: options.aiTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    logger,
    env: providerEnv
  };
  const providerFactory = (providerSettings, context = {}) => {
    const provider = createProvider(providerSettings, providerOptions);
    return {
      ...provider,
      complete: (call) => aiSettings.withUsage(providerSettings, {
        ...context, kind: call.kind === "coach-report" ? "coach" : call.kind === "coach-chat" ? "chat" : call.kind
      }, () => provider.complete(call))
    };
  };
  const llmEngine = createLlmMoveEngine({ protocol: agentProtocol, logger, maxAttempts: 1 });

  const auth = createAuthService({ repositories, sessionTtlMs, logger });
  const loginLimiter = createLoginRateLimiter({
    maxAttempts: options.loginMaxAttempts ?? DEFAULT_LOGIN_MAX_ATTEMPTS,
    windowMs: options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS
  });
  const authLimiter = createLoginRateLimiter({ maxAttempts: 60, windowMs: DEFAULT_LOGIN_WINDOW_MS });
  const registrationLimiter = createLoginRateLimiter({ maxAttempts: 10, windowMs: DEFAULT_LOGIN_WINDOW_MS });
  const apiLimiter = createLoginRateLimiter({ maxAttempts: 1200, windowMs: 60_000 });
  const ai = options.ai ?? createAiEngine({ logger });
  const analysisEngine = options.analysis ?? createAnalysisEngine({ logger });
  const realtime = createRealtimeHub({ logger });
  const games = createGameService({
    repositories,
    ai,
    analysis: analysisEngine,
    aiSettings,
    llmEngine,
    providerFactory,
    logger,
    serverMode: mode,
    now: options.now
  });
  const coach = createCoachService({
    repositories,
    aiSettings,
    providerFactory,
    protocol: agentProtocol,
    analysis: analysisEngine,
    logger,
    now: options.now
  });
  const agentDeadlines = createAgentDeadlineScheduler({
    games,
    logger,
    now: options.now,
    onTimeout: (row) => broadcastGameState(row.id)
  });
  const staticHandler = createStaticHandler({
    staticDir: options.staticDir ?? null,
    sharedDir: options.sharedDir ?? null,
    assetLoader: options.assetLoader ?? null,
    logger
  });
  // Restore deadlines after a restart, including games without an attached browser.
  for (const row of repositories.listGames()) agentDeadlines.schedule(row);

  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return ctx.user;
  }

  function requireAdmin(ctx) {
    const user = requireUser(ctx);
    if (!user.isAdmin) throw new HttpError(403, "FORBIDDEN", "Administrator access required.");
    return user;
  }

  function checkRate(limiter, key) {
    const retryAfter = limiter.check(key);
    if (retryAfter !== null) throw new HttpError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
      headers: { "Retry-After": String(retryAfter) }
    });
    limiter.recordFailure(key);
  }

  function privateGame(ctx, gameId) {
    return games.getPrivate(gameId, requireUser(ctx));
  }

  function eventAuthorization(req, agent = false) {
    return () => {
      try { return agent ? Boolean(requireAgent(req)) : Boolean(resolveUser(req)); }
      catch { return false; }
    };
  }

  function resolveUser(req) {
    if (mode === "desktop") return localViewer;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) return null;
    return auth.resolveSession(token);
  }

  function startUserSession(res, userId) {
    const session = auth.createSession(userId);
    res.setHeader(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE_NAME, session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookies })
    );
  }

  function clearUserSession(res) {
    res.setHeader(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE_NAME, "", { maxAgeSeconds: 0, secure: secureCookies })
    );
  }

  function broadcastGameState(gameId) {
    const row = repositories.getGame(gameId);
    if (!row) {
      realtime.closeGame(gameId);
      return;
    }
    // Re-arm the agent deadline even when nobody is watching: a stuck agent must
    // never freeze a game just because no SSE client is attached.
    agentDeadlines.schedule(row);
    if (realtime.subscriberCount(gameId) === 0) return;
    realtime.publish(gameId, "state", (client) => games.buildGameView(row, client.user));
    realtime.publish(
      gameId,
      "turn",
      (client) => games.buildAgentTurnView(row, client.seat, { deadlineAt: agentDeadlines.deadlineFor(row.id, client.seat) }),
      (client) => Number.isInteger(client.seat)
    );
  }

  // ---- Route handlers -----------------------------------------------------

  function handleConfig(ctx) {
    sendJson(ctx.res, 200, {
      app: APP_NAME,
      version: APP_VERSION,
      mode,
      features: { auth: mode === "web", online: true, llm: true, agentSeats: true },
      rules: {
        version: RULESET_VERSION,
        boardSize: BOARD_SIZE,
        winLength: WIN_LENGTH,
        stonesPerTurn: STONES_PER_TURN,
        firstTurnStones: FIRST_TURN_STONES,
        playerCounts: [...PLAYER_COUNTS]
      }
    });
  }

  function handleHealth(ctx) {
    sendJson(ctx.res, 200, { ok: true, time: Date.now() });
  }

  function handleDesktopHeartbeat(ctx) {
    if (mode !== "desktop") {
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    }
    lastDesktopHeartbeatAt = Date.now();
    sendNoContent(ctx.res);
  }

  function handleDesktopStatus(ctx) {
    if (mode !== "desktop") {
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    }
    sendJson(ctx.res, 200, {
      ok: true,
      lastHeartbeatAt: lastDesktopHeartbeatAt,
      now: Date.now()
    });
  }

  async function handleRegister(ctx) {
    if (mode !== "web") throw new HttpError(403, "AUTH_DISABLED", "Authentication is only available in web mode.");
    checkRate(registrationLimiter, clientAddress(ctx.req, { trustProxy }));
    const body = await readJsonBody(ctx.req, bodyLimit);
    const user = await auth.register(body ?? {});
    startUserSession(ctx.res, user.id);
    sendJson(ctx.res, 201, { user });
  }

  async function handleLogin(ctx) {
    if (mode !== "web") throw new HttpError(403, "AUTH_DISABLED", "Authentication is only available in web mode.");
    checkRate(authLimiter, clientAddress(ctx.req, { trustProxy }));
    const body = await readJsonBody(ctx.req, bodyLimit);
    const email = normalizeEmail(body?.email);
    const limiterKey = clientAddress(ctx.req, { trustProxy }) + "|" + email;
    const retryAfter = loginLimiter.check(limiterKey);
    if (retryAfter !== null) {
      throw new HttpError(429, "RATE_LIMITED", "Too many login attempts. Try again later.", {
        headers: { "Retry-After": String(retryAfter) }
      });
    }
    let user;
    try {
      user = await auth.login({ email: body?.email, password: body?.password });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) loginLimiter.recordFailure(limiterKey);
      throw error;
    }
    loginLimiter.reset(limiterKey);
    startUserSession(ctx.res, user.id);
    sendJson(ctx.res, 200, { user });
  }

  function handleLogout(ctx) {
    const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) auth.destroySession(token);
    clearUserSession(ctx.res);
    sendNoContent(ctx.res);
  }

  function handleMe(ctx) {
    if (mode === "desktop") {
      sendJson(ctx.res, 200, { authenticated: true, user: localViewer, mode });
      return;
    }
    sendJson(ctx.res, 200, ctx.user
      ? { authenticated: true, user: ctx.user, mode }
      : { authenticated: false, user: null, mode });
  }

  function handleListGames(ctx) {
    const user = requireUser(ctx);
    const query = Object.fromEntries(ctx.url.searchParams.entries());
    sendJson(ctx.res, 200, games.list(user, query));
  }

  async function handleCreateGame(ctx) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    const row = await games.create(body, user);
    agentDeadlines.schedule(row);
    sendJson(ctx.res, 201, { game: games.buildGameView(row, user) });
  }

  async function handleJoinGame(ctx) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    const row = games.join(body, user);
    broadcastGameState(row.id);
    sendJson(ctx.res, 200, { game: games.buildGameView(row, user) });
  }

  function handleGetGame(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = games.get(gameId, user);
    agentDeadlines.schedule(row);
    sendJson(ctx.res, 200, { game: games.buildGameView(row, user) });
  }

  function handleDeleteGame(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = games.deleteGame(gameId, user);
    realtime.closeGame(row.id);
    sendNoContent(ctx.res);
  }

  function handleStartGame(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = games.start(gameId, user);
    broadcastGameState(row.id);
    sendJson(ctx.res, 200, { game: games.buildGameView(row, user) });
  }

  async function handleSubmitAction(ctx, [gameId]) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    if (!body || typeof body !== "object" || body.action === undefined) {
      throw new HttpError(400, "INVALID_ACTION", "Request body must contain an action.");
    }
    const row = await games.submitAction(gameId, user, body.action, {
      onProgress: () => broadcastGameState(gameId)
    });
    broadcastGameState(row.id);
    sendJson(ctx.res, 200, { game: games.buildGameView(row, user) });
  }

  // ---- Agent seats -------------------------------------------------------

  function handleMintAgentToken(ctx, [gameId, seat]) {
    const user = requireUser(ctx);
    const row = games.get(gameId, user);
    const seatNumber = Number(seat);
    if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= row.playerCount) {
      throw new HttpError(400, "INVALID_SEAT", "Seat must be an integer between 0 and " + (row.playerCount - 1) + ".");
    }
    if (mode === "web" && row.hostUserId !== user.id) {
      throw new HttpError(403, "NOT_HOST", "Only the host can mint an agent token.");
    }
    const minted = mintAgentToken(row.id, seatNumber);
    games.setAgentSeatToken(row.id, seatNumber, minted.hash);
    realtime.closeSeat(row.id, seatNumber);
    sendJson(ctx.res, 201, {
      seat: seatNumber,
      token: minted.token,
      tokenType: "Bearer",
      hint: "Store this now: only the digest is kept, so it cannot be recovered."
    });
  }

  function requireAgent(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || header.length === 0) {
      throw new HttpError(401, "AGENT_TOKEN_REQUIRED", "Send Authorization: Bearer <agent token>.");
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) {
      throw new HttpError(401, "AGENT_TOKEN_REQUIRED", "Send Authorization: Bearer <agent token>.");
    }
    const token = match[1];
    const parsed = parseAgentToken(token);
    if (!parsed) {
      throw new HttpError(401, "AGENT_TOKEN_INVALID", "The agent token is malformed.");
    }
    const row = repositories.getGame(parsed.gameId);
    if (!row) {
      throw new HttpError(401, "AGENT_TOKEN_INVALID", "The agent token does not belong to a game on this server.");
    }
    const config = row.seats?.[parsed.seat];
    if (!config || config.kind !== "agent" || !agentTokenMatches(token, config.agentTokenHash)) {
      throw new HttpError(403, "FORBIDDEN", "The agent token is not valid for that seat.");
    }
    return { row, seat: parsed.seat };
  }

  function agentPayload(row, seat) {
    return {
      game: games.buildGameView(row, localViewer),
      turn: games.buildAgentTurnView(row, seat, { deadlineAt: agentDeadlines.deadlineFor(row.id, seat) })
    };
  }

  function handleAgentGame(ctx) {
    const { row, seat } = requireAgent(ctx.req);
    agentDeadlines.schedule(row);
    sendJson(ctx.res, 200, agentPayload(row, seat));
  }

  async function handleAgentAction(ctx) {
    requireAgent(ctx.req);
    const body = await readJsonBody(ctx.req, bodyLimit);
    if (!body || typeof body !== "object" || body.action === undefined) {
      throw new HttpError(400, "INVALID_ACTION", "Request body must contain an action.");
    }
    const { row, seat } = requireAgent(ctx.req);
    const updated = await games.submitAgentAction(row.id, seat, body.action, { turnId: body.turnId });
    broadcastGameState(updated.id);
    sendJson(ctx.res, 200, agentPayload(updated, seat));
  }

  function handleAgentEvents(ctx) {
    const { row, seat } = requireAgent(ctx.req);
    agentDeadlines.schedule(row);
    const res = ctx.res;
    const client = realtime.subscribe(row.id, { user: localViewer, res, seat, isAuthorized: eventAuthorization(ctx.req, true) });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    realtime.send(client, "state", games.buildGameView(row, localViewer));
    realtime.send(client, "turn", games.buildAgentTurnView(row, seat, {
      deadlineAt: agentDeadlines.deadlineFor(row.id, seat)
    }));
  }

  function handleEvents(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = games.get(gameId, user);
    const res = ctx.res;
    const client = realtime.subscribe(row.id, { user, res, isAuthorized: eventAuthorization(ctx.req) });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    realtime.send(client, "state", games.buildGameView(row, user));
  }

  function handleExport(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = games.get(gameId, user);
    const format = (ctx.url.searchParams.get("format") ?? "json").toLowerCase();
    if (!EXPORT_FORMATS.includes(format)) {
      throw new HttpError(400, "INVALID_FORMAT", "Format must be one of: " + EXPORT_FORMATS.join(", ") + ".");
    }
    const rendered = renderGameExport(row, games.listActions(row.id), format);
    const filename = "thickearth-" + row.id + "." + rendered.extension;
    sendText(ctx.res, 200, rendered.body, rendered.contentType, {
      "Content-Disposition": "attachment; filename=\"" + filename + "\"",
      "Cache-Control": "no-store"
    });
  }

  async function handleHardestDecision(ctx, [gameId]) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    const metrics = games.setHardestDecision(gameId, user, body?.note);
    sendJson(ctx.res, 200, { metrics });
  }

  function handleGetAnalysis(ctx, [gameId]) {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, { analysis: games.getAnalysis(gameId, user) });
  }

  async function handleGenerateAnalysis(ctx, [gameId]) {
    const user = requireUser(ctx);
    privateGame(ctx, gameId);
    const analysis = await games.generateAnalysis(gameId, user);
    realtime.publish(gameId, "analysis", analysis);
    sendJson(ctx.res, 200, { analysis });
  }

  function handleGetAiSettings(ctx) {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, {
      ...aiSettings.safeView(user.id),
      sharedAvailable: aiSettings.sharedAvailable?.() ?? false
    });
  }

  function adminSharedView() {
    return {
      enabled: aiSettings.isSharedEnabled(),
      available: aiSettings.sharedAvailable?.() ?? false
    };
  }

  function handleGetAdminShared(ctx) {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, adminSharedView());
  }

  async function handlePutAdminShared(ctx) {
    const admin = requireAdmin(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    if (!body || typeof body !== "object" || typeof body.enabled !== "boolean") {
      throw new HttpError(400, "INVALID_BODY", "enabled must be a boolean.");
    }
    aiSettings.setSharedEnabled(body.enabled, admin.id);
    logger?.info?.("Shared LLM " + (body.enabled ? "enabled" : "disabled") + " by " + admin.id + ".");
    sendJson(ctx.res, 200, adminSharedView());
  }

  async function handleUpdateAiSettings(ctx) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    sendJson(ctx.res, 200, aiSettings.updateSettings(user.id, body));
  }

  function handleDeleteAiKey(ctx) {
    const user = requireUser(ctx);
    aiSettings.clearKey(user.id);
    sendNoContent(ctx.res);
  }

  async function handleTestAiProvider(ctx) {
    const user = requireUser(ctx);
    const body = await readOptionalJsonBody(ctx.req, bodyLimit);
    const candidate = aiSettings.resolveTestCandidate(user.id, body);
    aiSettings.assertQuota(user.id);
    let result;
    try {
      result = await aiSettings.withUsage(candidate, { kind: "test", requestingUserId: user.id }, () => testConnection(candidate, {
        ...providerOptions,
        buildTestMessages: () => agentProtocol.buildConnectionTestMessages()
      }));
    } catch (error) {
      throw mapAiProviderError(error, logger);
    }
    sendJson(ctx.res, 200, {
      ok: true,
      latencyMs: result.latencyMs,
      model: result.model,
      sample: result.sample
    });
  }

  function handleGetCoach(ctx, [gameId]) {
    const user = requireUser(ctx);
    const row = privateGame(ctx, gameId);
    sendJson(ctx.res, 200, coach.getCoach(user, row));
  }

  async function handleGenerateCoach(ctx, [gameId]) {
    const user = requireUser(ctx);
    const body = await readOptionalJsonBody(ctx.req, bodyLimit);
    const row = privateGame(ctx, gameId);
    const result = await coach.generate(user, row, {
      force: body?.force === true,
      language: parseLanguage(body?.language)
    });
    sendJson(ctx.res, 200, result);
  }

  async function handleCoachMessage(ctx, [gameId]) {
    const user = requireUser(ctx);
    const body = await readJsonBody(ctx.req, bodyLimit);
    const row = privateGame(ctx, gameId);
    const result = await coach.chat(user, row, {
      message: body?.message,
      language: parseLanguage(body?.language)
    });
    sendJson(ctx.res, 200, result);
  }

  function handlePlaytestSummary(ctx) {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, summarizeCompletedGames(games.listCompleted(user)));
  }

  function handlePlaytestExport(ctx) {
    const user = requireUser(ctx);
    const format = (ctx.url.searchParams.get("format") ?? "csv").toLowerCase();
    if (format !== "csv") throw new HttpError(400, "INVALID_FORMAT", "Only csv is supported for playtest export.");
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = "thickearth-playtest-" + date + ".csv";
    sendText(ctx.res, 200, completedGamesToCsv(games.listCompleted(user)), "text/csv; charset=utf-8", {
      "Content-Disposition": "attachment; filename=\"" + filename + "\"",
      "Cache-Control": "no-store"
    });
  }

  // ---- Routing and request pipeline --------------------------------------

  const router = createRouter();
  router.add("GET", "/api/config", handleConfig);
  router.add("GET", "/api/health", handleHealth);
  router.add("POST", "/api/desktop/heartbeat", handleDesktopHeartbeat);
  router.add("GET", "/api/desktop/status", handleDesktopStatus);
  router.add("POST", "/api/auth/register", handleRegister);
  router.add("POST", "/api/auth/login", handleLogin);
  router.add("POST", "/api/auth/logout", handleLogout);
  router.add("GET", "/api/auth/me", handleMe);
  router.add("GET", "/api/games", handleListGames);
  router.add("POST", "/api/games", handleCreateGame);
  router.add("POST", "/api/games/join", handleJoinGame);
  router.add("GET", "/api/games/:gameId", handleGetGame);
  router.add("DELETE", "/api/games/:gameId", handleDeleteGame);
  router.add("POST", "/api/games/:gameId/start", handleStartGame);
  router.add("POST", "/api/games/:gameId/actions", handleSubmitAction);
  router.add("POST", "/api/games/:gameId/seats/:seat/token", handleMintAgentToken);
  router.add("GET", "/api/games/:gameId/events", handleEvents);
  router.add("GET", "/api/games/:gameId/export", handleExport);
  router.add("POST", "/api/games/:gameId/hardest-decision", handleHardestDecision);
  router.add("GET", "/api/games/:gameId/analysis", handleGetAnalysis);
  router.add("POST", "/api/games/:gameId/analysis", handleGenerateAnalysis);
  router.add("GET", "/api/ai/settings", handleGetAiSettings);
  router.add("GET", "/api/admin/shared-llm", handleGetAdminShared);
  router.add("PUT", "/api/admin/shared-llm", handlePutAdminShared);
  router.add("PUT", "/api/ai/settings", handleUpdateAiSettings);
  router.add("POST", "/api/ai/test", handleTestAiProvider);
  router.add("DELETE", "/api/ai/key", handleDeleteAiKey);
  router.add("GET", "/api/games/:gameId/coach", handleGetCoach);
  router.add("POST", "/api/games/:gameId/coach", handleGenerateCoach);
  router.add("POST", "/api/games/:gameId/coach/messages", handleCoachMessage);
  router.add("GET", "/api/playtest/summary", handlePlaytestSummary);
  router.add("GET", "/api/playtest/export", handlePlaytestExport);
  router.add("GET", "/api/agent/game", handleAgentGame);
  router.add("POST", "/api/agent/actions", handleAgentAction);
  router.add("GET", "/api/agent/events", handleAgentEvents);

  async function handleApiRequest(req, res, url) {
    res.setHeader("Cache-Control", "no-store");
    if (mode === "desktop") {
      let host;
      try { host = new URL("http://" + req.headers.host); } catch { throw new HttpError(403, "FORBIDDEN_ORIGIN", "Invalid host."); }
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)
          || Number(host.port || 80) !== req.socket.localPort) {
        throw new HttpError(403, "FORBIDDEN_ORIGIN", "Only the local application host is allowed.");
      }
    }
    if (mode === "desktop" || (req.method !== "GET" && req.method !== "HEAD")) {
      assertAllowedOrigin(req, { publicOrigin: mode === "web" ? publicOrigin : null });
    }
    checkRate(apiLimiter, clientAddress(req, { trustProxy }));
    const method = req.method === "HEAD" ? "GET" : req.method;
    const matched = router.match(method, url.pathname);
    if (!matched) {
      const allowed = router.allowedMethods(url.pathname);
      if (allowed.length > 0) {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { headers: { Allow: allowed.join(", ") } });
      }
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    }
    const ctx = { req, res, url, user: resolveUser(req) };
    await matched.handler(ctx, matched.params);
  }

  async function handleRequest(req, res) {
    applyBaseHeaders(res, { secureCookies });
    res.headOnly = req.method === "HEAD";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await handleApiRequest(req, res, url);
      } else {
        if (req.method !== "GET" && req.method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
        }
        await staticHandler.handle(req, res, url.pathname);
      }
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // The socket is already gone.
        }
        return;
      }
      handleError(res, error, logger);
    }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    agentDeadlines.cancelAll();
    realtime.closeAll();
    db.close();
  }

  return {
    handler: handleRequest,
    close,
    mode,
    getLastDesktopHeartbeatAt: () => lastDesktopHeartbeatAt
  };
}

function handleError(res, error, logger) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } }, error.headers ?? {});
    return;
  }
  if (error instanceof RuleError) {
    sendJson(res, 400, { error: { code: error.code, message: error.message } });
    return;
  }
  logger.error("Unhandled request error: " + (error?.stack ?? String(error)));
  sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "An internal server error occurred." } });
}

function normalizeLogger(logger) {
  if (logger && typeof logger === "object") {
    return {
      info: typeof logger.info === "function" ? (...args) => logger.info(...args) : noop,
      warn: typeof logger.warn === "function" ? (...args) => logger.warn(...args) : noop,
      error: typeof logger.error === "function" ? (...args) => logger.error(...args) : noop
    };
  }
  return {
    info: (...args) => console.info("[thickearth]", ...args),
    warn: (...args) => console.warn("[thickearth]", ...args),
    error: (...args) => console.error("[thickearth]", ...args)
  };
}

function noop() {}

function mapAiProviderError(error, logger) {
  if (error instanceof HttpError) return error;
  if (error instanceof AiProviderError) {
    const code = error.code === "AI_INVALID_RESPONSE" ? "AI_INVALID_RESPONSE" : "AI_PROVIDER_ERROR";
    logger?.warn?.("AI provider request failed with " + code + ": " + error.message);
    return new HttpError(
      502,
      code,
      code === "AI_INVALID_RESPONSE"
        ? "The AI provider returned an unreadable response."
        : "The AI provider request failed."
    );
  }
  return error;
}

function parseLanguage(value) {
  if (value === undefined || value === null || value === "") return "zh";
  if (value === "zh" || value === "en") return value;
  throw new HttpError(400, "INVALID_LANGUAGE", "Language must be zh or en.");
}

function createRouter() {
  const routes = [];

  function add(method, matcher, handler) {
    routes.push({ method, matcher: compileMatcher(matcher), handler });
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.matcher, pathname);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }

  function allowedMethods(pathname) {
    const methods = new Set();
    for (const route of routes) {
      if (matchPath(route.matcher, pathname)) methods.add(route.method);
    }
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods];
  }

  return { add, match, allowedMethods };
}

function compileMatcher(matcher) {
  if (matcher instanceof RegExp) return matcher;
  const pattern = matcher
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "([A-Za-z0-9_]+)" : escapeRegExp(segment)))
    .join("\\/");
  return new RegExp("^" + pattern + "$");
}

function matchPath(matcher, pathname) {
  const result = matcher.exec(pathname);
  return result ? result.slice(1) : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}
