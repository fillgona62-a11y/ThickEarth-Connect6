/**
 * HTTP primitives shared by the API routes: typed errors, JSON body parsing,
 * response helpers, cookie handling, and request metadata.
 */

export const SESSION_COOKIE_NAME = "te_session";
export const DEFAULT_BODY_LIMIT = 64 * 1024;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

/**
 * An error that maps directly onto an HTTP error response.
 * Contract: { "error": { "code": "...", "message": "..." } }
 */
export class HttpError extends Error {
  constructor(status, code, message, { headers = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function applyBaseHeaders(res, { secureCookies = false } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=5184000");
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  if (res.headOnly) res.end();
  else res.end(body);
}

export function sendText(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  if (res.headOnly) res.end();
  else res.end(body);
}

export function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, extraHeaders);
  res.end();
}

/**
 * Reads a JSON request body with a hard byte limit.
 * Throws HttpError(400) for malformed JSON and HttpError(413) for oversized bodies.
 */
export function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the " + limit + " byte limit."));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the " + limit + " byte limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (size === 0) {
        reject(new HttpError(400, "INVALID_JSON", "Request body is required."));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    req.on("error", () => fail(new HttpError(400, "INVALID_REQUEST", "Request body could not be read.")));
  });
}

/**
 * Reads an optional JSON body: an empty request body resolves to {} so endpoints
 * whose payload is entirely optional (for example { force: true }) can be called
 * with no body.
 */
export function readOptionalJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  const declared = Number(req.headers["content-length"]);
  const hasBody = (Number.isFinite(declared) && declared > 0) || typeof req.headers["transfer-encoding"] === "string";
  if (!hasBody) {
    req.resume();
    return Promise.resolve({});
  }
  return readJsonBody(req, limit);
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string" || header.length === 0) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAgeSeconds, secure = false, sameSite = "Lax", path = "/" } = {}) {
  const parts = [name + "=" + value, "Path=" + path, "HttpOnly", "SameSite=" + sameSite];
  if (maxAgeSeconds !== undefined) parts.push("Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds)));
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Rejects cross-site state-changing requests in web mode.
 * Non-browser clients that omit Origin are allowed; browsers always send it for
 * unsafe methods, so a mismatch means the request came from another site.
 */
export function assertAllowedOrigin(req, { publicOrigin = null } = {}) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
  if (publicOrigin) {
    let expected;
    try {
      expected = new URL(publicOrigin);
    } catch {
      throw new HttpError(500, "INTERNAL_ERROR", "PUBLIC_ORIGIN is not a valid URL.");
    }
    if (parsed.origin !== expected.origin) {
      throw new HttpError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
    }
    return;
  }
  const host = req.headers.host;
  if (!host || parsed.host !== host) {
    throw new HttpError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
}

export function clientAddress(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
