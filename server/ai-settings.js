/**
 * AI settings: validation, presets, safe views, credential encryption, and usage
 * quota lookups.
 *
 * API keys are write-only. They are encrypted with the secret store before they
 * reach SQLite and only their last four characters are ever exposed. Base URLs are
 * validated here (SSRF guard) before they are stored or used by the provider.
 */

import { keyHint } from "./ai-secret.js";
import { isMockBaseUrl, listPresets, MOCK_BASE_URL, normalizeBaseUrl } from "./ai-provider.js";
import { HttpError } from "./http.js";

export const DEFAULT_AI_SETTINGS = Object.freeze({
  enabled: false,
  provider: "custom",
  baseUrl: "",
  model: "",
  temperature: 0.2,
  maxOutputTokens: 1200,
  maxMovesPerGame: 40,
  monthlyCallLimit: 500
});

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL_PATTERN = /^[^\s]{1,128}$/;
const API_KEY_PATTERN = /^\S{8,512}$/;
const MAX_BASE_URL_LENGTH = 1024;

export function startOfMonth(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function normalizeHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

/**
 * True for loopback, RFC1918, link-local, CGNAT, multicast, IPv6 unique-local and
 * single-label hostnames. Used to keep web deployments from reaching internal
 * services through the provider base URL.
 */
export function isPrivateOrReservedHost(hostname) {
  const host = normalizeHost(hostname);
  if (host.length === 0 || host === "0.0.0.0" || host === "::") return true;
  if (isLoopbackHost(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return true;
  }
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    if (host.startsWith("::ffff:")) return isPrivateOrReservedHost(host.slice(7));
    return false;
  }
  return !host.includes(".");
}

export function validateBaseUrl(value, { mode = "desktop" } = {}) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return "";
  if (raw.length > MAX_BASE_URL_LENGTH) {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL is too long.");
  }
  if (isMockBaseUrl(raw)) {
    if (raw !== MOCK_BASE_URL) {
      throw new HttpError(400, "INVALID_BASE_URL", "Only mock://local is supported for the mock provider.");
    }
    return MOCK_BASE_URL;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "INVALID_BASE_URL", "Enter a valid http(s) base URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL must not contain a query string or fragment.");
  }
  if (mode === "web" && url.protocol !== "https:") {
    throw new HttpError(400, "INVALID_BASE_URL", "Web deployments require an https base URL.");
  }
  if (mode === "desktop" && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new HttpError(400, "INVALID_BASE_URL", "Plain http is only allowed for loopback model servers.");
  }
  if (mode === "web" && isPrivateOrReservedHost(url.hostname)) {
    throw new HttpError(400, "INVALID_BASE_URL", "Private or reserved hosts are not allowed in web deployments.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.length === 0 || path === "/") {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL must include the API version prefix, for example https://api.deepseek.com/v1.");
  }
  return url.origin + path;
}

function parseBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_" + field.toUpperCase(), field + " must be a boolean.");
  }
  return value;
}

function parseProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new HttpError(400, "INVALID_PROVIDER", "Provider must be a short lowercase identifier.");
  }
  return provider;
}

function parseModel(value) {
  const model = String(value ?? "").trim();
  if (model.length === 0) return "";
  if (!MODEL_PATTERN.test(model)) {
    throw new HttpError(400, "INVALID_MODEL", "Model must be 1-128 non-whitespace characters.");
  }
  return model;
}

function parseNumber(value, { field, code, min, max, integer = false }) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new HttpError(400, code, field + " must be " + (integer ? "an integer" : "a number") + " between " + min + " and " + max + ".");
  }
  return number;
}

function parseApiKey(value) {
  const apiKey = String(value ?? "").trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new HttpError(400, "INVALID_API_KEY", "API keys must be 8-512 characters with no whitespace.");
  }
  return apiKey;
}

function defaultSettings(userId, now) {
  return {
    userId,
    enabled: DEFAULT_AI_SETTINGS.enabled,
    provider: DEFAULT_AI_SETTINGS.provider,
    baseUrl: DEFAULT_AI_SETTINGS.baseUrl,
    model: DEFAULT_AI_SETTINGS.model,
    apiKeyEncrypted: null,
    keyHint: null,
    temperature: DEFAULT_AI_SETTINGS.temperature,
    maxOutputTokens: DEFAULT_AI_SETTINGS.maxOutputTokens,
    maxMovesPerGame: DEFAULT_AI_SETTINGS.maxMovesPerGame,
    monthlyCallLimit: DEFAULT_AI_SETTINGS.monthlyCallLimit,
    createdAt: now,
    updatedAt: now
  };
}

export function createAiSettingsService({ repositories, secretStore, mode = "desktop", logger = null, now = Date.now } = {}) {
  function getStored(userId) {
    return repositories.getAiSettings(userId) ?? defaultSettings(userId, now());
  }

  function decryptStoredKey(stored) {
    if (!stored.apiKeyEncrypted) return null;
    return secretStore.decrypt(stored.apiKeyEncrypted);
  }

  function monthUsage(userId) {
    return repositories.sumAiUsageSince(userId, startOfMonth(now()));
  }

  function isConfigured(stored) {
    return Boolean(stored.enabled && stored.apiKeyEncrypted && stored.baseUrl && stored.model);
  }

  function safeView(userId) {
    const stored = getStored(userId);
    const hasKey = Boolean(decryptStoredKey(stored));
    const usage = monthUsage(userId);
    return {
      enabled: stored.enabled,
      configured: isConfigured(stored),
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      model: stored.model,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      maxMovesPerGame: stored.maxMovesPerGame,
      monthlyCallLimit: stored.monthlyCallLimit,
      hasKey,
      keyHint: hasKey ? stored.keyHint ?? "" : "",
      usage: {
        monthCalls: usage.calls,
        monthInputTokens: usage.inputTokens,
        monthOutputTokens: usage.outputTokens
      },
      presets: listPresets()
    };
  }

  function updateSettings(userId, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
    }
    const current = getStored(userId);
    const next = { ...current };
    if ("enabled" in body) next.enabled = parseBoolean(body.enabled, "enabled");
    if ("provider" in body) next.provider = parseProvider(body.provider);
    if ("baseUrl" in body) next.baseUrl = validateBaseUrl(body.baseUrl, { mode });
    if ("model" in body) next.model = parseModel(body.model);
    if ("temperature" in body) {
      next.temperature = parseNumber(body.temperature, { field: "Temperature", code: "INVALID_TEMPERATURE", min: 0, max: 2 });
    }
    if ("maxOutputTokens" in body) {
      next.maxOutputTokens = parseNumber(body.maxOutputTokens, { field: "Max output tokens", code: "INVALID_MAX_OUTPUT_TOKENS", min: 1, max: 32768, integer: true });
    }
    if ("maxMovesPerGame" in body) {
      next.maxMovesPerGame = parseNumber(body.maxMovesPerGame, { field: "Max LLM moves per game", code: "INVALID_MAX_MOVES", min: 0, max: 500, integer: true });
    }
    if ("monthlyCallLimit" in body) {
      next.monthlyCallLimit = parseNumber(body.monthlyCallLimit, { field: "Monthly call limit", code: "INVALID_MONTHLY_CALL_LIMIT", min: 0, max: 1000000, integer: true });
    }
    let apiKeyEncrypted = current.apiKeyEncrypted;
    let hint = current.keyHint;
    if (body.clearKey === true) {
      apiKeyEncrypted = null;
      hint = null;
    }
    if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== "") {
      const apiKey = parseApiKey(body.apiKey);
      apiKeyEncrypted = secretStore.encrypt(apiKey);
      hint = keyHint(apiKey);
    }
    repositories.upsertAiSettings({
      ...next,
      apiKeyEncrypted,
      keyHint: hint,
      createdAt: current.createdAt,
      updatedAt: now()
    });
    logger?.info?.("AI settings updated for user " + userId + ".");
    return safeView(userId);
  }

  function clearKey(userId) {
    const current = getStored(userId);
    if (current.apiKeyEncrypted) repositories.deleteAiSettingsKey(userId, now());
    return safeView(userId);
  }

  function resolveForUse(userId, { status = 409 } = {}) {
    const stored = getStored(userId);
    // Missing credentials are reported as "not configured" even when the feature
    // toggle is off, so the UI can point at the settings screen first.
    if (!stored.baseUrl || !stored.model || !stored.apiKeyEncrypted) {
      throw new HttpError(status, "AI_NOT_CONFIGURED", "Configure an AI provider, model, and API key first.");
    }
    if (!stored.enabled) {
      throw new HttpError(status, "AI_DISABLED", "AI features are disabled in AI settings.");
    }
    const apiKey = decryptStoredKey(stored);
    if (!apiKey) {
      throw new HttpError(status, "AI_NOT_CONFIGURED", "The stored API key could not be decrypted; re-enter it in AI settings.");
    }
    return {
      userId,
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      model: stored.model,
      apiKey,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      maxMovesPerGame: stored.maxMovesPerGame,
      monthlyCallLimit: stored.monthlyCallLimit
    };
  }

  function getForMove(userId) {
    try {
      return resolveForUse(userId);
    } catch (error) {
      if (error instanceof HttpError) {
        logger?.warn?.("LLM seat fell back to the local engine: " + error.code + ".");
        return null;
      }
      throw error;
    }
  }

  function assertQuota(userId) {
    const stored = getStored(userId);
    const usage = monthUsage(userId);
    if (usage.calls >= stored.monthlyCallLimit) {
      throw new HttpError(429, "AI_QUOTA_EXCEEDED", "The monthly AI call limit has been reached.");
    }
    return usage;
  }

  function resolveTestCandidate(userId, body) {
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
    }
    const input = body ?? {};
    const stored = getStored(userId);
    const provider = "provider" in input ? parseProvider(input.provider) : stored.provider;
    const baseUrl = "baseUrl" in input ? validateBaseUrl(input.baseUrl, { mode }) : stored.baseUrl;
    const model = "model" in input ? parseModel(input.model) : stored.model;
    let apiKey = decryptStoredKey(stored);
    if (input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== "") {
      apiKey = parseApiKey(input.apiKey);
    }
    if (baseUrl.length === 0 || model.length === 0 || !apiKey) {
      throw new HttpError(400, "AI_NOT_CONFIGURED", "Provide a base URL, model, and API key before testing the provider.");
    }
    return {
      userId,
      provider,
      baseUrl,
      model,
      apiKey,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      maxMovesPerGame: stored.maxMovesPerGame,
      monthlyCallLimit: stored.monthlyCallLimit
    };
  }

  function coachConfig(userId) {
    const stored = getStored(userId);
    return {
      configured: isConfigured(stored),
      enabled: stored.enabled,
      hasKey: Boolean(stored.apiKeyEncrypted)
    };
  }

  function recordUsage({ userId, gameId = null, kind, provider = null, model = null, inputTokens = 0, outputTokens = 0 }) {
    repositories.insertAiUsage({
      userId,
      gameId,
      kind,
      provider,
      model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      createdAt: now()
    });
  }

  return {
    getStored,
    safeView,
    updateSettings,
    clearKey,
    resolveForUse,
    resolveTestCandidate,
    getForMove,
    assertQuota,
    monthUsage,
    coachConfig,
    recordUsage,
    isConfigured,
    startOfMonth
  };
}
