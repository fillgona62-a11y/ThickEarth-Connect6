/**
 * Account and session handling for web mode.
 *
 * Passwords are hashed with scrypt and a per-user salt. Session tokens are random
 * 256-bit values; only their SHA-256 digest is stored, so a database leak does not
 * expose live credentials. Desktop mode uses a local viewer and never calls in here
 * for authentication, though the same service can still create sessions.
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const scryptAsync = promisify(scryptCallback);

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 });
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 32;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url")
  ].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || r < 1 || p < 1) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = Buffer.from(await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem }));
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address.");
  }
  return email;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, "INVALID_PASSWORD", "Password must be between " + MIN_PASSWORD_LENGTH + " and " + MAX_PASSWORD_LENGTH + " characters.");
  }
  return password;
}

function validateDisplayName(value) {
  const displayName = String(value ?? "").trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new HttpError(400, "INVALID_DISPLAY_NAME", "Display name must be between 1 and " + MAX_DISPLAY_NAME_LENGTH + " characters.");
  }
  return displayName;
}

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

export function createAuthService({ repositories, sessionTtlMs = DEFAULT_SESSION_TTL_MS, logger = null } = {}) {
  function createSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const createdAt = Date.now();
    repositories.deleteExpiredSessions(createdAt);
    repositories.createSession({
      tokenHash: hashToken(token),
      userId,
      createdAt,
      expiresAt: createdAt + sessionTtlMs
    });
    return { token, maxAgeSeconds: Math.floor(sessionTtlMs / 1000) };
  }

  function resolveSession(token) {
    if (typeof token !== "string" || token.length === 0) return null;
    const tokenHash = hashToken(token);
    const session = repositories.findSession(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      repositories.deleteSession(tokenHash);
      return null;
    }
    const user = repositories.findUserById(session.userId);
    if (!user) {
      repositories.deleteSession(tokenHash);
      return null;
    }
    return publicUser(user);
  }

  function destroySession(token) {
    if (typeof token !== "string" || token.length === 0) return;
    repositories.deleteSession(hashToken(token));
  }

  async function register({ email, password, displayName } = {}) {
    const normalizedEmail = validateEmail(email);
    const normalizedPassword = validatePassword(password);
    const normalizedName = validateDisplayName(displayName);
    if (repositories.findUserByEmail(normalizedEmail)) {
      throw new HttpError(409, "EMAIL_TAKEN", "An account with that email already exists.");
    }
    const user = {
      id: "user_" + randomBytes(8).toString("hex"),
      email: normalizedEmail,
      displayName: normalizedName,
      passwordHash: await hashPassword(normalizedPassword),
      createdAt: Date.now()
    };
    try {
      repositories.createUser(user);
    } catch (error) {
      if (repositories.findUserByEmail(normalizedEmail)) {
        throw new HttpError(409, "EMAIL_TAKEN", "An account with that email already exists.");
      }
      throw error;
    }
    logger?.info?.("Registered user " + user.id + ".");
    return publicUser(user);
  }

  async function login({ email, password } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const passwordValue = String(password ?? "");
    const user = normalizedEmail.length === 0 ? null : repositories.findUserByEmail(normalizedEmail);
    if (!user) {
      // Burn comparable time so unknown emails cannot be distinguished by timing.
      await hashPassword(passwordValue);
      throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    const valid = await verifyPassword(passwordValue, user.passwordHash);
    if (!valid) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    return publicUser(user);
  }

  return { register, login, createSession, resolveSession, destroySession };
}

/**
 * In-memory sliding-window limiter for failed login attempts.
 * Keyed by client address and email so one attacker cannot lock out a whole site.
 */
export function createLoginRateLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000, maxTrackedKeys = 10000 } = {}) {
  const MAX_TRACKED_KEYS = maxTrackedKeys;
  const attempts = new Map();

  function prune(now) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  return {
    check(key) {
      const entry = attempts.get(key);
      if (!entry) {
        if (attempts.size >= MAX_TRACKED_KEYS) prune(Date.now());
        return attempts.size >= MAX_TRACKED_KEYS ? Math.ceil(windowMs / 1000) : null;
      }
      const now = Date.now();
      if (entry.resetAt <= now) {
        attempts.delete(key);
        return null;
      }
      if (entry.count < maxAttempts) return null;
      return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    },
    recordFailure(key) {
      const now = Date.now();
      prune(now);
      const entry = attempts.get(key);
      if (!entry) {
        // Bound memory: an attacker cycling emails cannot grow the map without limit.
        if (attempts.size >= MAX_TRACKED_KEYS) return;
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    reset(key) {
      attempts.delete(key);
    }
  };
}
