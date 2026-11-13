/**
 * OpenAI-compatible Chat Completions provider adapter.
 *
 * All provider traffic goes through this module: base URL validation is enforced
 * by ai-settings.js, requests carry the decrypted key in the Authorization header,
 * responses are size-capped and time-limited, and every failure is normalised into
 * an AiProviderError that never contains credentials.
 *
 * A deterministic in-process mock provider is used when THICK_EARTH_AI_MOCK=1 or
 * the configured base URL is mock://local; it never touches the network.
 */

import { AiProviderError } from "./errors.js";
import { createProviderFetch } from "./ai-network.js";

export const AI_PRESETS = Object.freeze([
  { id: "deepseek", label: "DeepSeek", labelZh: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { id: "bailian", label: "Alibaba Bailian (Qwen)", labelZh: "阿里百炼（Qwen）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "zhipu", label: "Zhipu GLM", labelZh: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "siliconflow", label: "SiliconFlow", labelZh: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  { id: "openai", label: "OpenAI", labelZh: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "custom", label: "Custom", labelZh: "自定义", baseUrl: "", model: "" }
]);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const MOCK_BASE_URL = "mock://local";

export function listPresets() {
  return AI_PRESETS.map((preset) => ({ ...preset }));
}

export function isMockBaseUrl(baseUrl) {
  return typeof baseUrl === "string" && (baseUrl === MOCK_BASE_URL || baseUrl.startsWith("mock://"));
}

export function isMockMode(settings, env = process.env) {
  return isMockBaseUrl(settings?.baseUrl) || env.THICK_EARTH_AI_MOCK === "1";
}

export function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl ?? "").trim();
  if (value === MOCK_BASE_URL) return value;
  return value.replace(/\/+$/, "");
}

/**
 * Extract the first JSON value from model output. Handles plain JSON, fenced
 * markdown blocks and JSON embedded in prose.
 */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fenced = /\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i.exec(trimmed);
  const candidates = fenced ? [fenced[1].trim(), trimmed] : [trimmed];
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate);
    if (direct !== null) return direct;
    const embedded = scanForJson(candidate);
    if (embedded !== null) return embedded;
  }
  return null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scanForJson(text) {
  for (let start = 0; start < text.length; start += 1) {
    const character = text[start];
    if (character !== "{" && character !== "[") continue;
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

function findBalancedEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      const open = stack.pop();
      if ((character === "}" && open !== "{") || (character === "]" && open !== "[")) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: message.role === "assistant" || message.role === "system" ? message.role : "user",
      content: typeof message.content === "string" ? message.content : String(message.content ?? "")
    }))
    .filter((message) => message.content.length > 0);
}

async function readBodyWithinLimit(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new AiProviderError("AI_INVALID_RESPONSE", "AI provider response exceeded the size limit.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) {
      throw new AiProviderError("AI_INVALID_RESPONSE", "AI provider response exceeded the size limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone.
      }
      throw new AiProviderError("AI_INVALID_RESPONSE", "AI provider response exceeded the size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? "").length / 4));
}

function firstLine(text, maxLength = 120) {
  const line = String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
  return line.slice(0, maxLength);
}

function mockCoachReport(mockContext) {
  const analysis = mockContext?.analysis ?? {};
  const summary = analysis.summary ?? {};
  const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  const weaknesses = Array.isArray(analysis.weaknesses) ? analysis.weaknesses : [];
  const headline = typeof summary.headline === "string" && summary.headline.length > 0
    ? summary.headline
    : "Mock coach report";
  const summaryText = typeof summary.resultLine === "string" && summary.resultLine.length > 0
    ? summary.resultLine
    : "This mock report is generated from the local analysis.";
  const report = {
    headline,
    summary: summaryText,
    strengths: recommendations.slice(0, 3).map((item) => ({
      seat: Number.isInteger(item?.seat) ? item.seat : 0,
      title: firstLine(item?.title ?? "Stable expansion"),
      detail: firstLine(item?.detail ?? "The local analysis found no measured flaw in this area.", 400)
    })),
    weaknesses: weaknesses.slice(0, 3).map((item) => ({
      seat: Number.isInteger(item?.seat) ? item.seat : 0,
      severity: ["high", "medium", "low"].includes(item?.severity) ? item.severity : "medium",
      title: "Measured weakness",
      detail: firstLine(item?.detail ?? "The local analysis reported an inefficiency.", 400)
    })),
    keyMistakes: recommendations
      .filter((item) => item?.alternative && Number.isInteger(item.alternative.turn))
      .slice(0, 3)
      .map((item) => ({
        seat: Number.isInteger(item?.seat) ? item.seat : 0,
        turn: item.alternative.turn,
        actual: String(item.alternative.actual ?? ""),
        better: String(item.alternative.better ?? ""),
        reason: firstLine(item?.detail ?? "A better legal move existed.", 400),
        gain: Number.isFinite(item.alternative.gain) ? item.alternative.gain : 0
      })),
    recommendations: recommendations.slice(0, 3).map((item) => ({
      seat: Number.isInteger(item?.seat) ? item.seat : 0,
      priority: Number.isInteger(item?.priority) ? item.priority : 1,
      title: firstLine(item?.title ?? "Improve the position"),
      detail: firstLine(item?.detail ?? "Review the measured key moments.", 400)
    })),
    trainingPlan: [
      "Review the local analysis key moments for this game.",
      "Practice one setup decision and compare it with the measured best camp.",
      "Play another game and focus on keeping the frontier open."
    ]
  };
  return report;
}

function mockCompletion({ messages, kind, model, mockContext }) {
  let text;
  if (kind === "test") {
    text = "OK";
  } else if (kind === "move") {
    const legalActions = Array.isArray(mockContext?.legalActions) ? mockContext.legalActions : [];
    text = JSON.stringify({ action: legalActions[0] ?? { type: "pass" } });
  } else if (kind === "coach-report") {
    text = JSON.stringify(mockCoachReport(mockContext));
  } else if (kind === "coach-chat") {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const headline = mockContext?.report?.headline ? " (" + mockContext.report.headline + ")" : "";
    text = "Mock coach" + headline + ": " + (lastUser ? "about \"" + firstLine(lastUser.content, 160) + "\" — " : "") +
      "the grounded answer is in the coach report and local analysis for this game.";
  } else {
    text = "OK";
  }
  const inputChars = messages.reduce((total, message) => total + message.content.length, 0);
  return {
    text,
    usage: { inputTokens: Math.max(1, Math.ceil(inputChars / 4)), outputTokens: estimateTokens(text) },
    model: model || "mock-model",
    latencyMs: 0,
    provider: "mock",
    mocked: true
  };
}

export function createProvider(settings, {
  fetchImpl = null,
  mode = "web",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  logger = null,
  env = process.env
} = {}) {
  const providerFetch = fetchImpl ?? createProviderFetch({ mode });
  const baseUrl = normalizeBaseUrl(settings?.baseUrl);
  const model = String(settings?.model ?? "").trim();
  const apiKey = String(settings?.apiKey ?? "");
  const mocked = isMockMode(settings, env);
  const providerName = String(settings?.provider ?? "custom");
  // DeepSeek turns thinking ON by default (effort high), and max_tokens covers
  // the chain of thought too. On a short move request all tokens go to
  // reasoning_content and `content` comes back empty. Only move calls need the
  // fast path; coach reports still benefit from thinking.
  const thinkingSwitch = /api\.deepseek\.com/i.test(baseUrl);

  async function complete({ messages, kind = "generic", maxTokens = null, temperature = null, mockContext = null, timeoutMs: callTimeoutMs = null }) {
    const cleanMessages = sanitizeMessages(messages);
    if (cleanMessages.length === 0) {
      throw new AiProviderError("AI_INVALID_REQUEST", "Provider request has no usable messages.");
    }
    if (mocked) return mockCompletion({ messages: cleanMessages, kind, model, mockContext });
    const startedAt = Date.now();
    const controller = new AbortController();
    const budget = Number.isFinite(callTimeoutMs) && callTimeoutMs > 0 ? callTimeoutMs : timeoutMs;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new AiProviderError("AI_PROVIDER_ERROR", "The AI provider request timed out.", { retryable: true }));
    }, budget);
    let response;
    let bodyText;
    try {
      response = await Promise.race([providerFetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model,
          messages: cleanMessages,
          temperature: temperature ?? (Number.isFinite(settings?.temperature) ? settings.temperature : 0.2),
          max_tokens: maxTokens ?? (Number.isInteger(settings?.maxOutputTokens) ? settings.maxOutputTokens : 1200),
          stream: false,
          ...(thinkingSwitch && kind === "move" ? { thinking: { type: "disabled" } } : {})
        }),
        signal: controller.signal,
        redirect: "error"
      }), timeout]);
      if (response.status >= 300 && response.status < 400) {
        controller.abort();
        throw new AiProviderError("AI_PROVIDER_ERROR", "Provider redirects are not allowed.");
      }
      bodyText = await Promise.race([readBodyWithinLimit(response, maxResponseBytes), timeout]);
    } catch (error) {
      controller.abort();
      if (error instanceof AiProviderError) throw error;
      if (error?.name === "AbortError") {
        throw new AiProviderError("AI_PROVIDER_ERROR", "The AI provider request timed out.", { retryable: true });
      }
      throw new AiProviderError("AI_PROVIDER_ERROR", "The AI provider request failed.", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      logger?.warn?.("AI provider returned HTTP " + response.status + " for " + providerName + ".");
      throw new AiProviderError("AI_PROVIDER_ERROR", "The AI provider returned HTTP " + response.status + ".", { retryable: true });
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new AiProviderError("AI_INVALID_RESPONSE", "The AI provider returned a non-JSON response.");
    }
    const message = payload?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      const choice = payload?.choices?.[0] ?? {};
      const reasoning = typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0;
      throw new AiProviderError("AI_INVALID_RESPONSE",
        "The AI provider returned an empty response. (finish_reason=" + (choice.finish_reason ?? "unknown")
        + ", reasoning=" + reasoning + ", completion_tokens=" + (payload?.usage?.completion_tokens ?? "?") + ")");
    }
    return {
      text: content,
      usage: {
        inputTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? Number(payload.usage.prompt_tokens) : 0,
        outputTokens: Number.isFinite(payload?.usage?.completion_tokens) ? Number(payload.usage.completion_tokens) : 0
      },
      model: typeof payload?.model === "string" && payload.model.length > 0 ? payload.model : model,
      latencyMs: Date.now() - startedAt,
      provider: providerName,
      mocked: false
    };
  }

  return { complete, model, mocked, baseUrl };
}

export async function testConnection(settings, options = {}) {
  const provider = createProvider(settings, options);
  const messages = typeof options.buildTestMessages === "function"
    ? await options.buildTestMessages()
    : [
        { role: "system", content: "You are a connectivity check. Reply with the single word OK." },
        { role: "user", content: "Reply with the single word OK." }
      ];
  const startedAt = Date.now();
  // 16 tokens is not enough for providers that think before answering: the whole
  // budget can go to reasoning, leaving `content` empty and the check failing
  // even though the key and model are fine.
  const completion = await provider.complete({ messages, kind: "test", maxTokens: 256, temperature: 0, mockContext: null });
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    model: completion.model,
    sample: String(completion.text).trim().slice(0, 80),
    usage: completion.usage
  };
}
