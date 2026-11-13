/**
 * Server entrypoint and reusable start factory.
 *
 *   startServer({ mode: "desktop", port: 0, dbPath })
 *     -> { server, port, host, mode, close() }
 *
 * The desktop SEA shell imports startServer and owns the window lifecycle; tests
 * start it on an ephemeral port with a temporary database. The module only runs
 * the standalone entrypoint when executed directly (npm start / node server/index.js).
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "./app.js";

const DEFAULT_WEB_PORT = 8080;
const DEFAULT_DESKTOP_PORT = 0;

export function resolveRuntimeOptions(options = {}, env = process.env) {
  const mode = resolveMode(options.mode ?? env.APP_MODE);
  const host = options.host ?? env.HOST ?? (mode === "desktop" ? "127.0.0.1" : "0.0.0.0");
  if (mode === "desktop" && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Desktop mode must bind to a loopback address. Use APP_MODE=web for a public server.");
  }
  const port = options.port ?? parsePort(env.PORT, mode === "desktop" ? DEFAULT_DESKTOP_PORT : DEFAULT_WEB_PORT);
  const dbPath = options.dbPath ?? env.DB_PATH ?? defaultDatabasePath(mode, env);
  const publicOrigin = options.publicOrigin ?? env.PUBLIC_ORIGIN ?? null;
  const secureCookies = options.secureCookies ?? parseBoolean(env.COOKIE_SECURE, mode === "web");
  const staticDir = options.staticDir !== undefined ? options.staticDir : defaultDirectory("../web");
  const sharedDir = options.sharedDir !== undefined ? options.sharedDir : defaultDirectory("../shared");
  return {
    mode,
    host,
    port,
    dbPath,
    publicOrigin,
    secureCookies,
    staticDir,
    sharedDir,
    assetLoader: options.assetLoader,
    logger: options.logger,
    trustProxy: options.trustProxy,
    sessionTtlMs: options.sessionTtlMs,
    bodyLimit: options.bodyLimit,
    ai: options.ai,
    analysis: options.analysis,
    aiSecret: options.aiSecret,
    fetchImpl: options.fetchImpl,
    aiMock: options.aiMock,
    aiTimeoutMs: options.aiTimeoutMs,
    env: options.env
  };
}

export async function startServer(options = {}) {
  const resolved = resolveRuntimeOptions(options);
  const app = createApplication(resolved);
  const server = createServer(app.handler);
  server.on("clientError", (error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  try {
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(resolved.port, resolved.host, () => {
        server.off("error", onError);
        resolvePromise();
      });
    });
  } catch (error) {
    app.close();
    throw error;
  }
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : resolved.port;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    app.close();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
  return {
    server,
    port,
    host: resolved.host,
    mode: resolved.mode,
    close,
    getLastDesktopHeartbeatAt: () => app.getLastDesktopHeartbeatAt?.() ?? Date.now()
  };
}

function resolveMode(value) {
  if (value === undefined || value === null || value === "") return "desktop";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "desktop" || normalized === "web") return normalized;
  throw new Error("APP_MODE must be 'desktop' or 'web'.");
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  throw new Error("Expected a boolean value, received: " + value);
}

function defaultDatabasePath(mode, env) {
  if (mode === "web") return resolve(env.DATA_DIR ?? "data", "thickearth.db");
  const base = process.platform === "win32"
    ? env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), "AppData", "Local")
    : env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "ThickEarth", "thickearth.db");
}

function defaultDirectory(relativePath) {
  try {
    const directory = fileURLToPath(new URL(relativePath + "/", import.meta.url));
    return existsSync(directory) ? directory : null;
  } catch {
    return null;
  }
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function runMain() {
  const instance = await startServer();
  const displayHost = instance.host === "0.0.0.0" || instance.host === "::" ? "127.0.0.1" : instance.host;
  console.log("[thickearth] listening on http://" + displayHost + ":" + instance.port + " (mode: " + instance.mode + ")");
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[thickearth] received " + signal + "; shutting down");
    instance.close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[thickearth] shutdown failed:", error);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (isMainModule()) {
  runMain().catch((error) => {
    console.error("[thickearth] failed to start:", error);
    process.exitCode = 1;
  });
}
