/**
 * Agent seats: seat-scoped capability tokens and the deadline fallback timer.
 *
 * A token is a bearer credential for exactly one (game, seat) pair. The raw token
 * is returned once at mint time and only its SHA-256 digest is stored in the game
 * row, so a database leak cannot be replayed as a seat. The token carries the game
 * id and seat so the server can resolve it in O(1) without scanning every game.
 *
 * The deadline scheduler exists because an external process can crash, get rate
 * limited, or simply never answer. Without it a single stuck agent would freeze the
 * game forever. It arms one timer per game, only while the seat on the clock is an
 * agent seat with a positive time limit, and the fallback re-checks the turn id
 * before touching the position.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AGENT_TOKEN_PREFIX = "teagent";

const GAME_ID_PATTERN = /^g_[A-Za-z0-9]+$/;
const MAX_SEAT_INDEX = 3;

export function hashAgentToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function mintAgentToken(gameId, seat) {
  const secret = randomBytes(24).toString("base64url");
  const token = [AGENT_TOKEN_PREFIX, gameId, String(seat), secret].join(".");
  return { token, hash: hashAgentToken(token) };
}

/**
 * Structural parse only. Never proves the token is valid for the seat; callers must
 * still compare the digest against the stored hash via agentTokenMatches.
 */
export function parseAgentToken(token) {
  if (typeof token !== "string" || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, gameId, rawSeat, secret] = parts;
  if (prefix !== AGENT_TOKEN_PREFIX) return null;
  if (!GAME_ID_PATTERN.test(gameId)) return null;
  const seat = Number(rawSeat);
  if (!Number.isInteger(seat) || seat < 0 || seat > MAX_SEAT_INDEX) return null;
  if (typeof secret !== "string" || secret.length < 16) return null;
  return { gameId, seat };
}

export function agentTokenMatches(token, storedHash) {
  if (typeof storedHash !== "string" || storedHash.length !== 64) return false;
  const actual = Buffer.from(hashAgentToken(token), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createAgentDeadlineScheduler({
  games,
  onTimeout = null,
  logger = null,
  now = Date.now
} = {}) {
  const timers = new Map();

  function cancel(gameId) {
    const entry = timers.get(gameId);
    if (!entry) return;
    clearTimeout(entry.timer);
    timers.delete(gameId);
  }

  function deadlineFor(gameId, seat) {
    const entry = timers.get(gameId);
    if (!entry) return null;
    if (seat !== undefined && entry.seat !== seat) return null;
    return entry.deadlineAt;
  }

  /**
   * Re-arms the timer for the current position. Safe to call on every read: it
   * cancels the previous timer and only creates one when an agent seat is on the
   * clock. timeLimitMs = 0 means the seat waits indefinitely and gets no timer.
   */
  function schedule(row) {
    if (!row || !row.id) return;
    cancel(row.id);
    if (row.status === "lobby" || row.status === "finished") return;
    const state = row.currentState;
    const seat = state?.currentSeat;
    if (!Number.isInteger(seat)) return;
    const config = row.seats?.[seat];
    if (!config || config.kind !== "agent") return;
    const limit = Number(config.timeLimitMs ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const turnId = state.seq;
    const deadlineAt = now() + limit;
    const timer = setTimeout(() => {
      timers.delete(row.id);
      void fire(row.id, seat, turnId);
    }, limit);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(row.id, { timer, seat, turnId, deadlineAt });
  }

  async function fire(gameId, seat, turnId) {
    try {
      const row = await games.applyAgentTimeout(gameId, { seat, turnId });
      if (!row) return;
      schedule(row);
      if (typeof onTimeout === "function") onTimeout(row);
    } catch (error) {
      logger?.error?.("Agent deadline fallback failed for game " + gameId + ". (" + (error?.message ?? error) + ")");
    }
  }

  function cancelAll() {
    for (const gameId of [...timers.keys()]) cancel(gameId);
  }

  return { schedule, cancel, cancelAll, deadlineFor };
}
