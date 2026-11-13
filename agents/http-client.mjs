/** Shared transport for reference agents; credentials stay on the configured server. */
import { isLoopbackHost } from "../server/ai-network.js";

export function agentBaseUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === "http:" && !isLoopbackHost(url.hostname))) {
    throw new Error("Use HTTPS for remote agents; HTTP is allowed only on loopback.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function agentRequest(base, path, { method = "GET", body, token } = {}) {
  const response = await fetch(base + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Agent response exceeded the size limit."); }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error((payload?.error?.code ?? response.status) + ": " + (payload?.error?.message ?? ""));
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}
