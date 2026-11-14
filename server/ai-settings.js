/**
 * AI settings: validation, presets, safe views, credential encryption, and usage
 * quota lookups.
 *
 * API keys are write-only. They are encrypted with the secret store before they
 * reach SQLite and only their last four characters are ever exposed. Base URLs are
 * validated here (SSRF guard) before they are stored or used by the provider.
 */

import { keyHint } from "./ai-secret.js";
import { listPresets } from "./ai-provider.js";
import { validateBaseUrl } from "./ai-network.js";
export { validateBaseUrl, isLoopbackHost, isPrivateOrReservedHost } from "./ai-network.js";
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

export function startOfMonth(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
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

export function createAiSettingsService({ repositories, secretStore, mode = "desktop", logger = null, now = Date.now, env = process.env } = {}) {
  const activeCalls = new Map();
  const activeRequesters = new Map();
  const concurrencyLimit = positiveLimit(env.AI_MAX_CONCURRENT, 4);
  const sharedUserLimit = positiveLimit(env.AI_SHARED_MAX_CALLS_PER_USER, 100);
  const requesterConcurrencyLimit = positiveLimit(env.AI_MAX_CONCURRENT_PER_USER, 2);
  // Optional server-wide provider. When enabled, a player with no AI settings of
  // their own borrows this account's provider for LLM seats. The key is still
  // read from the encrypted row — no plaintext credential is stored anywhere.
  const envSharedDefault = ["1", "true", "yes"].includes(String(env.AI_SHARED_LLM ?? "").toLowerCase());
  const SHARED_SWITCH_KEY = "shared_llm_enabled";

  // Persisted in site_settings so an administrator's toggle survives a restart.
  // The environment variable only supplies the initial value for a fresh DB.
  function isSharedEnabled() {
    const stored = repositories.getSiteSetting?.(SHARED_SWITCH_KEY);
    if (stored === null || stored === undefined) return envSharedDefault;
    return stored === "1" || stored === "true";
  }

  function setSharedEnabled(enabled, sourceUserId = null) {
    if (enabled && sourceUserId) {
      // Only the administrator endpoint supplies this ID. Sharing always uses
      // the model that administrator deliberately configured, never a visitor's.
      resolveForUse(sourceUserId);
      repositories.setSiteSetting?.("shared_llm_user_id", sourceUserId, now());
    }
    repositories.setSiteSetting?.(SHARED_SWITCH_KEY, enabled ? "1" : "0", now());
  }

  function sharedUserId() {
    if (!isSharedEnabled()) return null;
    const selected = repositories.getSiteSetting?.("shared_llm_user_id");
    if (selected) return selected;
    const explicit = String(env.AI_SHARED_USER_ID ?? "").trim();
    if (explicit) return explicit;
    const email = String(env.AI_SHARED_USER_EMAIL ?? "").trim().toLowerCase();
    if (email) return repositories.findUserByEmail(email)?.id ?? null;
    // Public sites must pin the administrator's account, never the first visitor's key.
    return mode === "desktop" ? (repositories.firstConfiguredAiSettingsUserId?.() ?? null) : null;
  }

  function sharedAvailable() {
    const id = sharedUserId();
    return id ? Boolean(getForMove(id)) : false;
  }

  function getSharedForMove() {
    const id = sharedUserId();
    if (!id) return null;
    const settings = getForMove(id);
    return settings ? { userId: id, settings } : null;
  }

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
      configured: isConfigured(stored) && hasKey,
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      model: stored.model,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      maxMovesPerGame: stored.maxMovesPerGame,
      monthlyCallLimit: stored.monthlyCallLimit,
      hasKey,
      sharedAvailable: sharedAvailable(),
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
    const endpointChanged = next.baseUrl !== current.baseUrl;
    let apiKeyEncrypted = endpointChanged ? null : current.apiKeyEncrypted;
    let hint = endpointChanged ? null : current.keyHint;
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

  // Use the same personal-first, shared-second route as an LLM opponent.
  // The returned userId remains the credential owner so withUsage bills the
  // correct account and applies the requesting user's shared allowance.
  function resolveForCoach(userId) {
    try {
      return resolveForUse(userId);
    } catch (error) {
      if (!(error instanceof HttpError) || !["AI_NOT_CONFIGURED", "AI_DISABLED"].includes(error.code)) throw error;
      const shared = getSharedForMove();
      if (shared) return shared.settings;
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
    let apiKey = baseUrl === stored.baseUrl ? decryptStoredKey(stored) : null;
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
    let resolved = null;
    try {
      resolved = resolveForCoach(userId);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
    return {
      configured: Boolean(resolved),
      enabled: Boolean(resolved),
      hasKey: Boolean(decryptStoredKey(stored)),
      source: resolved ? (resolved.userId === userId ? "personal" : "shared") : null,
      model: resolved?.model ?? null
    };
  }

  function recordUsage({ userId, gameId = null, kind, provider = null, model = null, inputTokens = 0, outputTokens = 0 }) {
    return repositories.insertAiUsage({
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

  async function withUsage(settings, { gameId = null, requestingUserId = settings.userId, kind }, work) {
    const billedTo = settings.userId;
    const used = repositories.sumAiUsageSince(billedTo, startOfMonth(now()));
    const concurrent = activeCalls.get(billedTo) ?? 0;
    const requesterConcurrent = activeRequesters.get(requestingUserId) ?? 0;
    if (used.calls >= settings.monthlyCallLimit || concurrent >= concurrencyLimit
        || requesterConcurrent >= requesterConcurrencyLimit
        || (kind === "move" && repositories.countAiUsage(billedTo, gameId, "move") >= settings.maxMovesPerGame)
        || (billedTo !== requestingUserId && repositories.countRequestedUsage(requestingUserId, startOfMonth(now())) >= sharedUserLimit)) {
      throw new HttpError(429, "AI_QUOTA_EXCEEDED", "AI call or concurrency allowance reached.");
    }
    // Reserve synchronously before any await: concurrent requests and failed calls consume allowance too.
    const usageId = repositories.insertAiUsage({
      userId: billedTo, requestedByUserId: requestingUserId, gameId, kind,
      provider: settings.provider, model: settings.model, createdAt: now()
    });
    activeCalls.set(billedTo, concurrent + 1);
    activeRequesters.set(requestingUserId, requesterConcurrent + 1);
    try {
      const result = await work();
      repositories.completeAiUsage(usageId, result);
      return result;
    } finally {
      const remaining = (activeCalls.get(billedTo) ?? 1) - 1;
      if (remaining) activeCalls.set(billedTo, remaining);
      else activeCalls.delete(billedTo);
      const requesterRemaining = (activeRequesters.get(requestingUserId) ?? 1) - 1;
      if (requesterRemaining) activeRequesters.set(requestingUserId, requesterRemaining);
      else activeRequesters.delete(requestingUserId);
    }
  }

  return {
    getStored,
    safeView,
    updateSettings,
    clearKey,
    resolveForUse,
    resolveForCoach,
    resolveTestCandidate,
    getForMove,
    isSharedEnabled,
    setSharedEnabled,
    sharedAvailable,
    getSharedForMove,
    assertQuota,
    monthUsage,
    coachConfig,
    recordUsage,
    withUsage,
    isConfigured,
    startOfMonth
  };
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1_000_000 ? number : fallback;
}
