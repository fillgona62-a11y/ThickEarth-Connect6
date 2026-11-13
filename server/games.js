/**
 * Game service: creation, online rooms, authoritative action handling, AI seat
 * cycling, and the GameView projections consumed by the HTTP layer.
 *
 * Every rule decision goes through shared/rules.js. The service persists the
 * initial state, the current materialized state, the ordered action log, the final
 * result, and playtest metrics for each game.
 */

import { randomBytes, randomInt } from "node:crypto";
import {
  applyAction,
  createGame as createEngineGame,
  getLegalActions,
  normalizeAction,
  PHASES,
  PLAYER_COUNTS,
  playtestMetrics,
  RuleError,
  stonesRemaining
} from "../shared/rules.js";
import { HttpError } from "./http.js";

export const GAME_MODES = Object.freeze(["local", "ai", "selfplay", "arena", "online"]);
export const DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 32;
const MAX_HARDEST_DECISION_LENGTH = 280;
const MAX_AI_ACTIONS = 1000;
const SELFPLAY_TIME_BUDGET_MS = 200;
const DEFAULT_AGENT_TIME_LIMIT_MS = 20_000;
const MAX_AGENT_TIME_LIMIT_MS = 30 * 60 * 1000;
const FALLBACK_DIFFICULTY = "normal";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_LIST_OFFSET = 100000;

export function createGameService({
  repositories,
  ai,
  analysis: analysisEngine,
  aiSettings = null,
  llmEngine = null,
  providerFactory = null,
  logger = null,
  serverMode = "desktop",
  now = Date.now
} = {}) {
  function parseGameMode(value) {
    if (!GAME_MODES.includes(value)) {
      throw new HttpError(400, "INVALID_GAME_MODE", "Mode must be one of: " + GAME_MODES.join(", ") + ".");
    }
    return value;
  }

  function parsePlayerCount(value) {
    const playerCount = Number(value);
    if (!PLAYER_COUNTS.includes(playerCount)) {
      throw new HttpError(400, "INVALID_PLAYER_COUNT", "Connect6 is played by exactly " + PLAYER_COUNTS.join(" or ") + " players.");
    }
    return playerCount;
  }

  function parseDifficulty(value) {
    if (value === undefined || value === null || value === "") return "normal";
    const difficulty = String(value).trim().toLowerCase();
    if (!DIFFICULTIES.includes(difficulty)) {
      throw new HttpError(400, "INVALID_DIFFICULTY", "Difficulty must be easy, normal, or hard.");
    }
    return difficulty;
  }

  function parseSeatName(value, kind, seat) {
    const name = typeof value === "string" ? value.trim() : "";
    if (name.length === 0) {
      const prefix = kind === "ai" ? "AI " : kind === "agent" ? "Agent " : "Player ";
      return prefix + (seat + 1);
    }
    return name.slice(0, MAX_NAME_LENGTH);
  }

  function parseSeatEngine(value, kind) {
    if (value !== undefined && value !== null && value !== "") {
      if (value !== "local" && value !== "llm") {
        throw new HttpError(400, "INVALID_ENGINE", "Seat engine must be local or llm.");
      }
      if (kind !== "ai") {
        if (value === "llm") throw new HttpError(400, "INVALID_ENGINE", "Human seats cannot use the LLM engine.");
        return null;
      }
      return value;
    }
    return kind === "ai" ? "local" : null;
  }

  function assertLlmSeatsConfigured(seats, user) {
    const usesLlm = seats.some((seat) => seat.kind === "ai" && seat.engine === "llm");
    if (!usesLlm) return;
    const stored = aiSettings?.getStored(user.id);
    const ownProvider = stored && aiSettings.isConfigured(stored);
    if (!ownProvider && !aiSettings?.sharedAvailable?.()) {
      throw new HttpError(400, "AI_NOT_CONFIGURED", "Configure an AI provider before using LLM seats.");
    }
  }

  /**
   * Agent seats wait for an external process instead of being driven in-process.
   * timeLimitMs = 0 means "wait forever"; a positive value arms the fallback so a
   * crashed agent cannot stall the game.
   */
  function parseAgentTimeLimit(value) {
    if (value === undefined || value === null || value === "") return DEFAULT_AGENT_TIME_LIMIT_MS;
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_AGENT_TIME_LIMIT_MS) {
      throw new HttpError(400, "INVALID_TIME_LIMIT", "Agent time limit must be between 0 and " + MAX_AGENT_TIME_LIMIT_MS + " ms.");
    }
    return Math.floor(ms);
  }

  function parseSeatConfigs(rawSeats, mode, playerCount, user) {
    if (mode === "online") {
      return Array.from({ length: playerCount }, (_, seat) => ({
        seat,
        name: seat === 0 ? user.displayName.slice(0, MAX_NAME_LENGTH) : "Player " + (seat + 1),
        kind: "human",
        difficulty: null,
        engine: null,
        timeLimitMs: null,
        userId: seat === 0 ? user.id : null
      }));
    }
    const provided = Array.isArray(rawSeats) ? rawSeats : [];
    if (provided.length > playerCount) {
      throw new HttpError(400, "INVALID_SEATS", "Received more seats than playerCount.");
    }
    const seats = [];
    for (let seat = 0; seat < playerCount; seat += 1) {
      const source = provided[seat] && typeof provided[seat] === "object" ? provided[seat] : {};
      const emptySource = provided[seat] === undefined || provided[seat] === null;
      let kind;
      if (mode === "selfplay") {
        kind = "ai";
      } else if (mode === "local") {
        kind = "human";
      } else if (mode === "arena") {
        kind = emptySource ? "agent" : source.kind;
        if (kind !== "agent" && kind !== "ai") {
          throw new HttpError(400, "INVALID_SEAT", "Arena seats must be agent or ai.");
        }
      } else {
        kind = source.kind === undefined ? (seat === 0 ? "human" : "ai") : source.kind;
        if (kind !== "human" && kind !== "ai" && kind !== "agent") {
          throw new HttpError(400, "INVALID_SEAT", "Seat " + (seat + 1) + " must be human, ai, or agent.");
        }
      }
      seats.push({
        seat,
        name: parseSeatName(source.name, kind, seat),
        kind,
        difficulty: kind === "ai" ? parseDifficulty(source.difficulty) : null,
        engine: parseSeatEngine(source.engine, kind),
        timeLimitMs: kind === "agent" ? parseAgentTimeLimit(source.timeLimitMs) : null,
        agentTokenHash: null,
        fallbackCount: 0,
        userId: null
      });
    }
    if (mode === "ai") {
      const hasExternal = seats.some((seat) => seat.kind !== "ai");
      const hasAi = seats.some((seat) => seat.kind === "ai");
      if (!hasExternal || !hasAi) {
        throw new HttpError(400, "INVALID_SEAT_MIX", "AI games need at least one non-AI seat and one AI seat.");
      }
    }
    if (mode === "arena") {
      if (seats.some((seat) => seat.kind === "human")) {
        throw new HttpError(400, "INVALID_SEAT_MIX", "Arena games cannot contain human seats.");
      }
      if (!seats.some((seat) => seat.kind === "agent")) {
        throw new HttpError(400, "INVALID_SEAT_MIX", "Arena games need at least one agent seat.");
      }
    }
    return seats;
  }

  function createRoomCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = "";
      for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!repositories.getGameByRoomCode(code)) return code;
    }
    throw new HttpError(500, "INTERNAL_ERROR", "Could not allocate a room code.");
  }

  function canAccess(row, user, { allowSpectator = true } = {}) {
    if (serverMode === "desktop") return true;
    if (!user) return false;
    if (row.ownerUserId === user.id) return true;
    if (row.seats.some((seat) => seat.userId === user.id)) return true;
    // Online rooms are semi-public: authenticated users may watch as spectators,
    // but spectator rows never appear in that user's game list or playtest data.
    return allowSpectator && row.mode === "online";
  }

  function getRow(gameId) {
    const row = repositories.getGame(gameId);
    if (!row) throw new HttpError(404, "GAME_NOT_FOUND", "Game not found.");
    return row;
  }

  function getGameForUser(gameId, user) {
    const row = getRow(gameId);
    if (!canAccess(row, user)) {
      throw new HttpError(403, "FORBIDDEN", "You do not have access to this game.");
    }
    return row;
  }

  function getPrivateGame(gameId, user) {
    const row = getRow(gameId);
    if (!canAccess(row, user, { allowSpectator: false })) {
      throw new HttpError(403, "FORBIDDEN", "Only game participants can access this resource.");
    }
    return row;
  }

  function buildMetrics(state, startedAt, finishedAt, hardestDecisionNote) {
    const durationMs = startedAt !== null && startedAt !== undefined && finishedAt !== null && finishedAt !== undefined
      ? Math.max(0, finishedAt - startedAt)
      : null;
    return playtestMetrics(state, {
      durationMs,
      startedAt: startedAt ?? null,
      endedAt: finishedAt ?? null,
      hardestDecisionNote: hardestDecisionNote ?? ""
    });
  }

  function applyAndPersist(row, rawAction) {
    let result;
    try {
      result = applyAction(row.currentState, rawAction);
    } catch (error) {
      if (error instanceof RuleError) throw new HttpError(400, error.code, error.message);
      throw error;
    }
    const state = result.state;
    const finished = state.phase === PHASES.FINISHED;
    const timestamp = now();
    const finishedAt = finished ? timestamp : row.finishedAt;
    const entry = result.action;
    const normalizedAction = normalizeAction(entry);
    repositories.transaction(() => {
      const current = repositories.getGame(row.id);
      if (!current || current.currentState.seq !== row.currentState.seq || current.status !== row.status) {
        throw new HttpError(409, "STALE_TURN", "The position changed. Read it again before acting.");
      }
      repositories.insertAction({
        gameId: row.id,
        seq: entry.seq,
        turn: entry.turn ?? null,
        seat: entry.seat ?? null,
        type: entry.type,
        x: normalizedAction.x ?? null,
        y: normalizedAction.y ?? null,
        notation: entry.notation,
        action: normalizedAction,
        createdAt: timestamp
      });
      repositories.updateGame(row.id, {
        status: state.phase,
        currentState: state,
        finishedAt,
        result: finished ? state.result : null,
        metrics: finished
          ? buildMetrics(state, row.startedAt ?? row.createdAt, finishedAt, row.metrics?.hardestDecisionNote ?? "")
          : null
      });
    });
  }

  function llmProviderFor(ownerId, gameId) {
    // Personal settings win. Only when that player has none do we borrow the
    // server-wide provider; A (bring your own key) and C (shared) coexist.
    let settings = aiSettings.getForMove(ownerId);
    let billingUserId = ownerId;
    if (!settings) {
      const shared = aiSettings.getSharedForMove?.();
      if (shared) {
        settings = shared.settings;
        billingUserId = shared.userId;
      }
    }
    if (!settings) return null;
    try {
      return { settings, provider: providerFactory(settings, { gameId, requestingUserId: ownerId }), billingUserId };
    } catch (error) {
      logger?.warn?.("The LLM provider could not be created; using the local engine. (" + (error?.message ?? error) + ")");
      return null;
    }
  }

  async function tryLlmSeatMove(row, state, seat) {
    if (!aiSettings || !llmEngine || !providerFactory) return null;
    const resolved = llmProviderFor(row.ownerUserId, row.id);
    if (!resolved) return null;
    try {
      const result = await llmEngine.choose(state, {
        seat,
        provider: resolved.provider
      });
      return result?.action ?? null;
    } catch (error) {
      logger?.warn?.("The LLM seat move failed; using the local engine. (" + (error?.message ?? error) + ")");
      return null;
    }
  }

  /** One provider call for both stones of a turn. Returns [first, second] or null. */
  async function tryLlmSeatTurn(row, state, seat) {
    if (!aiSettings || !llmEngine || !providerFactory) return null;
    const resolved = llmProviderFor(row.ownerUserId, row.id);
    if (!resolved) return null;
    try {
      const actions = await llmEngine.chooseTurn(state, {
        seat,
        provider: resolved.provider
      });
      return actions.length > 0 ? actions : null;
    } catch (error) {
      logger?.warn?.("The LLM two-stone turn failed; falling back to per-stone calls. (" + (error?.message ?? error) + ")");
      return null;
    }
  }

  async function chooseAiSeatAction(row, state, seat, { timeBudgetMs, skipLlm = false } = {}) {
    const seatConfig = row.seats[seat] ?? {};
    const difficulty = seatConfig.difficulty ?? "normal";
    if (!skipLlm && seatConfig.engine === "llm") {
      const llmAction = await tryLlmSeatMove(row, state, seat);
      if (llmAction) return llmAction;
    }
    return ai.chooseAction(state, {
      difficulty,
      seed: state.seq + 1,
      ...(timeBudgetMs === undefined ? {} : { timeBudgetMs })
    });
  }

  const aiRuns = new Map();
  function advanceAi(gameId, options = {}) {
    const previous = aiRuns.get(gameId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => runAi(gameId, options)).finally(() => {
      if (aiRuns.get(gameId) === work) aiRuns.delete(gameId);
    });
    aiRuns.set(gameId, work);
    return work;
  }

  async function runAi(gameId, { timeBudgetMs, onProgress = null } = {}) {
    // A two-stone turn is fetched in one LLM call; the second stone waits here
    // until the first has been applied and re-validated against the new board.
    let pending = null;
    // If the batched call times out, the rest of this turn must NOT fall back to
    // two more per-stone LLM calls — that would be slower than doing nothing.
    let llmFailedTurn = null;
    const report = () => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress();
      } catch (error) {
        logger?.warn?.("AI progress broadcast failed. (" + (error?.message ?? error) + ")");
      }
    };
    for (let step = 0; step < MAX_AI_ACTIONS; step += 1) {
      const row = getRow(gameId);
      if (row.status === "finished" || row.currentState.phase === PHASES.FINISHED) return;
      const state = row.currentState;
      const currentSeat = state.currentSeat;
      const current = currentSeat === null ? null : state.players[currentSeat];
      if (!current || current.kind !== "ai") return;

      let action = null;
      if (pending && pending.seat === currentSeat && pending.expectedSeq === state.seq) {
        const match = getLegalActions(state).find((candidate) =>
          candidate.type === pending.action.type
          && candidate.x === pending.action.x
          && candidate.y === pending.action.y);
        action = match ?? null;
        pending = null;
      }
      const seatConfig = row.seats[currentSeat] ?? {};
      const llmFailed = llmFailedTurn !== null
        && llmFailedTurn.seat === currentSeat && llmFailedTurn.turn === state.turn;
      if (!action && !llmFailed && seatConfig.kind === "ai" && seatConfig.engine === "llm"
        && stonesRemaining(state) === 2 && (state.placedThisTurn ?? 0) === 0) {
        const pair = await tryLlmSeatTurn(row, state, currentSeat);
        if (pair) {
          action = pair[0];
          if (pair.length === 2) {
            pending = { seat: currentSeat, expectedSeq: state.seq + 1, action: pair[1] };
          } else {
            // Only one usable point came back. Place it, and let the local
            // engine fill the second stone instantly — no second LLM call.
            llmFailedTurn = { seat: currentSeat, turn: state.turn };
          }
        } else {
          llmFailedTurn = { seat: currentSeat, turn: state.turn };
        }
      }
      if (!action) {
        action = await chooseAiSeatAction(row, state, currentSeat, {
          timeBudgetMs,
          skipLlm: llmFailed || (llmFailedTurn !== null
            && llmFailedTurn.seat === currentSeat && llmFailedTurn.turn === state.turn)
        });
      }
      if (!action) {
        logger?.error?.("The AI has no action to choose for game " + gameId + ".");
        return;
      }
      const latest = repositories.getGame(gameId);
      if (!latest) return;
      if (latest.currentState.seq !== state.seq || latest.status !== row.status) {
        pending = null;
        continue;
      }
      try {
        applyAndPersist(row, action);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400) throw error;
        const fallback = getLegalActions(state)[0];
        if (!fallback) throw error;
        logger?.warn?.("The AI action was rejected (" + error.code + "); applying the first legal action.");
        applyAndPersist(row, fallback);
      }
      report();
    }
    logger?.error?.("AI auto-play exceeded the safety limit for game " + gameId + ".");
  }

  async function create(input, user) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
    }
    const mode = parseGameMode(input.mode);
    const playerCount = parsePlayerCount(input.playerCount);
    const seats = parseSeatConfigs(input.seats, mode, playerCount, user);
    assertLlmSeatsConfigured(seats, user);
    const state = createEngineGame({
      playerCount,
      players: seats.map((seat) => ({ name: seat.name, kind: seat.kind }))
    });
    const createdAt = now();
    const game = {
      id: "g_" + randomBytes(8).toString("hex"),
      roomCode: createRoomCode(),
      mode,
      status: mode === "online" ? "lobby" : state.phase,
      playerCount,
      hostUserId: user.id,
      ownerUserId: user.id,
      createdAt,
      startedAt: mode === "online" ? null : createdAt,
      finishedAt: null,
      initialState: state,
      currentState: state,
      seats,
      result: null,
      metrics: null,
      analysis: null
    };
    repositories.insertGame(game);
    if (mode === "selfplay") await advanceAi(game.id, { timeBudgetMs: SELFPLAY_TIME_BUDGET_MS });
    else if (mode !== "online") await advanceAi(game.id);
    return getRow(game.id);
  }

  function list(user, query = {}) {
    const mode = query.mode === undefined || query.mode === null || query.mode === ""
      ? null
      : parseGameMode(query.mode);
    const limit = parseBoundedInteger(query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
    const offset = parseBoundedInteger(query.offset, 0, 0, MAX_LIST_OFFSET, "offset");
    const rows = repositories.listGames(mode).filter((row) => canAccess(row, user, { allowSpectator: false }));
    return {
      games: rows.slice(offset, offset + limit).map(buildGameSummary),
      total: rows.length
    };
  }

  function join(input, user) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
    }
    const roomCode = String(input.roomCode ?? "").trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(roomCode)) {
      throw new HttpError(400, "INVALID_ROOM_CODE", "Enter a four-letter room code.");
    }
    const row = repositories.getGameByRoomCode(roomCode);
    if (!row || row.mode !== "online") {
      throw new HttpError(404, "GAME_NOT_FOUND", "No room with that code was found.");
    }
    if (row.seats.some((seat) => seat.userId === user.id)) return row;
    if (row.status !== "lobby") {
      throw new HttpError(409, "GAME_ALREADY_STARTED", "That room has already started.");
    }
    const openSeat = row.seats.find((seat) => !seat.userId);
    if (!openSeat) throw new HttpError(409, "ROOM_FULL", "That room is full.");
    const displayName = user.displayName.slice(0, MAX_NAME_LENGTH);
    const seats = row.seats.map((seat) => (
      seat.seat === openSeat.seat ? { ...seat, name: displayName, userId: user.id } : seat
    ));
    repositories.updateGame(row.id, {
      seats,
      initialState: withSeatNames(row.initialState, seats),
      currentState: withSeatNames(row.currentState, seats)
    });
    return getRow(row.id);
  }

  function start(gameId, user) {
    const row = getGameForUser(gameId, user);
    if (row.mode !== "online") {
      throw new HttpError(409, "INVALID_GAME_STATE", "Only online games use a lobby.");
    }
    if (row.hostUserId !== user.id) {
      throw new HttpError(403, "NOT_HOST", "Only the host can start this game.");
    }
    if (row.status !== "lobby") {
      throw new HttpError(409, "GAME_ALREADY_STARTED", "This game has already started.");
    }
    if (row.seats.some((seat) => !seat.userId)) {
      throw new HttpError(409, "SEATS_NOT_FILLED", "All seats must be filled before the game starts.");
    }
    repositories.updateGame(row.id, { status: PHASES.PLAY, startedAt: now() });
    return getRow(row.id);
  }

  async function submitAction(gameId, user, rawAction, { onProgress = null } = {}) {
    const row = getGameForUser(gameId, user);
    if (row.status === "lobby") {
      throw new HttpError(409, "GAME_NOT_STARTED", "The host has not started this game yet.");
    }
    if (row.status === "finished" || row.currentState.phase === PHASES.FINISHED) {
      throw new HttpError(409, "GAME_FINISHED", "This game is already finished.");
    }
    const state = row.currentState;
    const currentSeat = state.currentSeat;
    if (row.mode === "online") {
      const viewerSeat = row.seats.findIndex((seat) => seat.userId === user.id);
      if (viewerSeat === -1) {
        throw new HttpError(403, "FORBIDDEN", "Only seated players can act in an online game.");
      }
      if (viewerSeat !== currentSeat) {
        throw new HttpError(409, "NOT_YOUR_TURN", "It is not your turn.");
      }
    } else {
      const player = currentSeat === null ? null : state.players[currentSeat];
      if (!player || player.kind !== "human") {
        throw new HttpError(409, "NOT_YOUR_TURN", "It is not a human-controlled turn.");
      }
    }
    applyAndPersist(row, rawAction);
    // Show the human stone immediately, then each AI stone as it lands, instead
    // of freezing the board for the whole LLM turn.
    if (typeof onProgress === "function") {
      try { onProgress(); } catch (error) {
        logger?.warn?.("Move progress broadcast failed. (" + (error?.message ?? error) + ")");
      }
    }
    await advanceAi(row.id, { onProgress });
    return getRow(row.id);
  }

  // ---- Agent seats -------------------------------------------------------
  //
  // An agent seat is played by an external process over /api/agent/*. The server
  // never drives it in-process (advanceAi only serves kind === "ai"), so the turn
  // simply waits. Every submission is still validated here against shared/rules.js,
  // and the turn id keeps a slow reply from landing on a later position.

  function assertAgentSeat(row, seat) {
    const config = row.seats?.[seat];
    if (!config || config.kind !== "agent") {
      throw new HttpError(409, "NOT_AGENT_SEAT", "Seat " + (seat + 1) + " is not an agent seat.");
    }
    return config;
  }

  function assertSeatToMove(row, seat) {
    if (row.status === "lobby") {
      throw new HttpError(409, "GAME_NOT_STARTED", "This game has not started yet.");
    }
    if (row.status === "finished" || row.currentState.phase === PHASES.FINISHED) {
      throw new HttpError(409, "GAME_FINISHED", "This game is already finished.");
    }
    const state = row.currentState;
    if (state.currentSeat !== seat) {
      throw new HttpError(409, "NOT_YOUR_TURN", "It is not this seat's turn.");
    }
    return state;
  }

  function setAgentSeatToken(gameId, seat, tokenHash) {
    const row = getRow(gameId);
    assertAgentSeat(row, seat);
    repositories.updateGame(row.id, {
      seats: row.seats.map((entry, index) => (index === seat ? { ...entry, agentTokenHash: tokenHash } : entry))
    });
    return getRow(row.id);
  }

  async function submitAgentAction(gameId, seat, rawAction, { turnId } = {}) {
    const row = getRow(gameId);
    assertAgentSeat(row, seat);
    const state = assertSeatToMove(row, seat);
    if (!Number.isSafeInteger(turnId) || turnId < 0) {
      throw new HttpError(400, "INVALID_TURN_ID", "A non-negative integer turnId is required.");
    }
    if (turnId !== state.seq) {
      throw new HttpError(409, "STALE_TURN", "Turn " + turnId + " is not current; the position moved to turn " + state.seq + ".");
    }
    applyAndPersist(row, rawAction);
    await advanceAi(row.id);
    return getRow(row.id);
  }

  /**
   * Deadline fallback. Only fires when the seat is still the one on the clock and
   * the turn has not advanced, so a late timer can never overwrite a real move.
   */
  async function applyAgentTimeout(gameId, { seat, turnId } = {}) {
    const row = repositories.getGame(gameId);
    if (!row) return null;
    const config = row.seats?.[seat];
    if (!config || config.kind !== "agent") return null;
    const state = row.currentState;
    if (row.status === "lobby" || row.status === "finished" || state.phase === PHASES.FINISHED) return null;
    if (state.currentSeat !== seat) return null;
    if (turnId !== undefined && Number(turnId) !== state.seq) return null;
    const legal = getLegalActions(state);
    if (legal.length === 0) return null;
    let chosen = null;
    try {
      chosen = findLegalAction(legal, await ai.chooseAction(state, {
        difficulty: FALLBACK_DIFFICULTY,
        seed: state.seq + 1
      }));
    } catch (error) {
      logger?.warn?.("The agent fallback engine failed to choose an action. (" + (error?.message ?? error) + ")");
    }
    if (!chosen) chosen = legal[0];
    const latest = repositories.getGame(gameId);
    if (!latest || latest.currentState.seq !== state.seq || latest.status !== row.status) return null;
    logger?.warn?.("Agent seat " + (seat + 1) + " missed the deadline in game " + row.id + "; playing a fallback action.");
    repositories.updateGame(row.id, {
      seats: latest.seats.map((entry, index) => (
        index === seat ? { ...entry, fallbackCount: (entry.fallbackCount ?? 0) + 1 } : entry
      ))
    });
    applyAndPersist(row, chosen);
    await advanceAi(row.id);
    return getRow(row.id);
  }

  function buildAgentTurnView(row, seat, { deadlineAt = null } = {}) {
    const state = row.currentState;
    const playable = row.status !== "lobby" && row.status !== "finished" && state.phase !== PHASES.FINISHED;
    const isMyTurn = playable && state.currentSeat === seat;
    return {
      turnId: state.seq,
      seat,
      isMyTurn,
      // Connect6 counts one decision as one stone, so a turn can span two
      // decisions. Agents use these two fields to know how much of the turn
      // is left without having to re-derive the rule themselves.
      stonesRemainingThisTurn: isMyTurn ? stonesRemaining(state) : 0,
      placedThisTurn: state.placedThisTurn ?? 0,
      legalActions: isMyTurn ? getLegalActions(state) : [],
      timeLimitMs: row.seats?.[seat]?.timeLimitMs ?? null,
      deadlineAt: isMyTurn ? deadlineAt : null
    };
  }

  function setHardestDecision(gameId, user, note) {
    const row = getPrivateGame(gameId, user);
    if (typeof note !== "string") {
      throw new HttpError(400, "INVALID_NOTE", "The note must be a string.");
    }
    const trimmed = note.trim();
    if (trimmed.length > MAX_HARDEST_DECISION_LENGTH) {
      throw new HttpError(400, "NOTE_TOO_LONG", "The note must be at most " + MAX_HARDEST_DECISION_LENGTH + " characters.");
    }
    const metrics = buildMetrics(row.currentState, row.startedAt ?? row.createdAt, row.finishedAt, trimmed);
    repositories.updateGame(row.id, { metrics });
    return metrics;
  }

  function getAnalysis(gameId, user) {
    return getGameForUser(gameId, user).analysis;
  }

  async function generateAnalysis(gameId, user) {
    const row = getPrivateGame(gameId, user);
    if (row.status === "lobby") {
      throw new HttpError(409, "GAME_NOT_STARTED", "The game has not started yet.");
    }
    const analysis = await analysisEngine.generate(row.currentState, { metrics: row.metrics });
    repositories.updateGame(row.id, { analysis });
    return analysis;
  }

  function deleteGame(gameId, user) {
    const row = getGameForUser(gameId, user);
    if (serverMode === "web" && row.hostUserId !== user.id) {
      throw new HttpError(403, "FORBIDDEN", "Only the host can delete this game.");
    }
    repositories.deleteGame(row.id);
    return row;
  }

  function listCompleted(user) {
    return repositories.listGames(null).filter((row) =>
      row.status === "finished" && canAccess(row, user, { allowSpectator: false }));
  }

  function listActions(gameId) {
    return repositories.listActions(gameId);
  }

  function setAgentDeadline(gameId, seat, turnId, deadlineAt) {
    const row = getRow(gameId);
    if (row.currentState.seq !== turnId || row.currentState.currentSeat !== seat) return;
    repositories.updateGame(gameId, { seats: row.seats.map((entry, index) => (
      index === seat ? { ...entry, deadlineSeq: turnId, deadlineAt } : entry
    )) });
  }

  function describeViewer(row, user) {
    const state = row.currentState;
    const isHost = row.hostUserId === user?.id;
    if (row.mode === "online") {
      const seat = row.seats.findIndex((candidate) => candidate.userId && candidate.userId === user?.id);
      if (seat === -1) return { control: "spectator", seat: null, canAct: false, isHost };
      const canAct = (row.status === "setup" || row.status === "play") && state.currentSeat === seat;
      return { control: "seat", seat, canAct, isHost };
    }
    const currentSeat = state.currentSeat;
    const current = currentSeat === null ? null : state.players[currentSeat];
    const canAct = (row.status === "setup" || row.status === "play") && current !== null && current.kind === "human";
    return { control: "local", seat: canAct ? currentSeat : null, canAct, isHost };
  }

  function buildGameView(row, user) {
    const state = row.currentState;
    const viewer = describeViewer(row, user);
    const players = state.players.map((player, seat) => ({
      seat,
      name: player.name,
      kind: player.kind,
      color: player.color,
      engine: player.kind === "ai" ? row.seats[seat]?.engine ?? "local" : null,
      timeLimitMs: player.kind === "agent" ? row.seats[seat]?.timeLimitMs ?? null : null,
      fallbackCount: player.kind === "agent" ? row.seats[seat]?.fallbackCount ?? 0 : null,
      userId: row.seats[seat]?.userId ?? null,
      isViewer: row.mode === "online" ? viewer.seat === seat : player.kind === "human"
    }));
    const finished = row.status === "finished";
    return {
      id: row.id,
      roomCode: row.roomCode,
      mode: row.mode,
      status: row.status,
      playerCount: row.playerCount,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      hostId: row.hostUserId,
      players,
      viewer,
      state: row.status === "lobby" ? null : state,
      legalActions: viewer.canAct ? getLegalActions(state) : [],
      result: finished ? state.result : null,
      metrics: finished ? row.metrics : null
    };
  }

  function buildGameSummary(row) {
    const state = row.currentState;
    const result = state.result;
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      playerCount: row.playerCount,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      players: state.players.map((player, seat) => ({
        seat,
        name: player.name,
        kind: player.kind,
        color: player.color,
        engine: player.kind === "ai" ? row.seats[seat]?.engine ?? "local" : null
      })),
      result: result
        ? {
            scores: result.scores,
            winnerSeats: result.winnerSeats,
            endReason: result.endReason,
            winningLineLength: Array.isArray(result.line) ? result.line.length : 0,
            turns: result.turns,
            decisions: result.decisions
          }
        : null
    };
  }

  return {
    create,
    list,
    get: getGameForUser,
    getPrivate: getPrivateGame,
    setAgentDeadline,
    join,
    start,
    submitAction,
    submitAgentAction,
    applyAgentTimeout,
    setAgentSeatToken,
    buildAgentTurnView,
    deleteGame,
    setHardestDecision,
    getAnalysis,
    generateAnalysis,
    listCompleted,
    listActions,
    buildGameView,
    buildGameSummary
  };
}

function findLegalAction(legal, action) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") return null;
  const match = legal.find((candidate) => (
    candidate.type === action.type && candidate.x === action.x && candidate.y === action.y
  ));
  return match ?? null;
}

function withSeatNames(state, seats) {
  const next = structuredClone(state);
  for (const seat of seats) {
    const player = next.players[seat.seat];
    if (player) player.name = seat.name;
  }
  return next;
}

function parseBoundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_QUERY", "Query parameter " + label + " must be an integer between " + min + " and " + max + ".");
  }
  return parsed;
}
