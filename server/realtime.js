import { HttpError } from "./http.js";

/**
 * Server-Sent Events hub. Game views are viewer-specific, so a broadcast calls a
 * per-subscriber payload factory rather than sending one shared payload.
 */
export function createRealtimeHub({ pingIntervalMs = 25_000, logger = null } = {}) {
  const subscribersByGame = new Map();
  const timer = setInterval(() => {
    for (const subscribers of subscribersByGame.values()) {
      for (const client of subscribers) writeEvent(client, "ping", { time: Date.now() });
    }
  }, pingIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  function writeEvent(client, event, data) {
    if (client.isAuthorized && !client.isAuthorized()) {
      unsubscribe(client);
      client.res.end();
      return;
    }
    try {
      if (!client.res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
          && client.res.writableLength > 256 * 1024) {
        // A reconnecting client receives a fresh snapshot; do not buffer unbounded history.
        unsubscribe(client);
        client.res.destroy();
      }
    } catch (error) {
      logger?.warn?.("Dropping an SSE client after a write failure. (" + (error?.message ?? error) + ")");
      unsubscribe(client);
    }
  }

  function unsubscribe(client) {
    const subscribers = subscribersByGame.get(client.gameId);
    if (!subscribers) return;
    subscribers.delete(client);
    if (subscribers.size === 0) subscribersByGame.delete(client.gameId);
  }

  function subscribe(gameId, { user, res, seat = null, isAuthorized = null }) {
    const identity = Number.isInteger(seat) ? "agent:" + seat : "user:" + user?.id;
    const existing = subscribersByGame.get(gameId);
    if (existing?.size >= 128 || [...(existing ?? [])].filter((entry) => entry.identity === identity).length >= 8
        || [...subscribersByGame.values()].reduce((sum, clients) => sum + clients.size, 0) >= 1024) {
      throw new HttpError(429, "RATE_LIMITED", "Too many event streams.");
    }
    const client = { gameId, user, res, seat, isAuthorized, identity };
    let subscribers = subscribersByGame.get(gameId);
    if (!subscribers) {
      subscribers = new Set();
      subscribersByGame.set(gameId, subscribers);
    }
    subscribers.add(client);
    res.on("close", () => unsubscribe(client));
    res.on("error", () => unsubscribe(client));
    return client;
  }

  /**
   * Broadcasts one event to every subscriber of a game. The payload is built per
   * subscriber because game views are viewer-specific. An optional filter drops
   * subscribers that should not receive the event at all (for example seat-scoped
   * turn events only go to agent seat connections).
   */
  function publish(gameId, event, dataOrFactory, filter = null) {
    const subscribers = subscribersByGame.get(gameId);
    if (!subscribers) return;
    for (const client of [...subscribers]) {
      if (typeof filter === "function" && !filter(client)) continue;
      let data;
      try {
        data = typeof dataOrFactory === "function" ? dataOrFactory(client) : dataOrFactory;
      } catch (error) {
        logger?.error?.("Failed to build an SSE payload. (" + (error?.message ?? error) + ")");
        continue;
      }
      writeEvent(client, event, data);
    }
  }

  function send(client, event, data) {
    writeEvent(client, event, data);
  }

  function closeGame(gameId) {
    const subscribers = subscribersByGame.get(gameId);
    if (!subscribers) return;
    for (const client of subscribers) {
      try {
        client.res.end();
      } catch {
        // The socket is already gone; nothing to close.
      }
    }
    subscribersByGame.delete(gameId);
  }

  function closeAll() {
    clearInterval(timer);
    for (const gameId of [...subscribersByGame.keys()]) closeGame(gameId);
  }

  function closeSeat(gameId, seat) {
    for (const client of [...(subscribersByGame.get(gameId) ?? [])]) {
      if (client.seat === seat) {
        unsubscribe(client);
        client.res.end();
      }
    }
  }

  return { subscribe, publish, send, closeGame, closeSeat, closeAll, subscriberCount: (gameId) => subscribersByGame.get(gameId)?.size ?? 0 };
}
