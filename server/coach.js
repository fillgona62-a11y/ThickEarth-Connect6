/**
 * AI coach: grounded post-game reports and follow-up chat over the configured
 * OpenAI-compatible provider.
 *
 * Model output is treated as untrusted: every report is parsed, schema-validated,
 * capped and cross-checked against the stored action log and rules engine before it
 * is cached or returned. All provider calls are quota-checked and recorded.
 */

import { formatCell, getLegalActions, replayActions } from "../shared/rules.js";
import { AiProviderError } from "./errors.js";
import { HttpError } from "./http.js";

export const COACH_REPORT_VERSION = "thick-earth-coach/v1";
export const MAX_CHAT_MESSAGE_LENGTH = 600;
export const MAX_TRANSCRIPT_MESSAGES = 50;

const MAX = Object.freeze({
  headline: 160,
  summary: 2000,
  strengthTitle: 120,
  strengthDetail: 400,
  weaknessTitle: 120,
  weaknessDetail: 500,
  mistakeText: 80,
  mistakeReason: 500,
  recommendationTitle: 120,
  recommendationDetail: 500,
  trainingStep: 240
});

const ARRAY_CAPS = Object.freeze({ strengths: 4, weaknesses: 6, keyMistakes: 6, recommendations: 6, trainingPlan: 5 });
const SEVERITIES = new Set(["high", "medium", "low"]);
const CELL_PATTERN = /^[A-S](1[0-9]|[1-9])$/;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapProviderFailure(error, logger) {
  if (error instanceof HttpError) return error;
  if (error instanceof AiProviderError) {
    const code = error.code === "AI_INVALID_RESPONSE" ? "AI_INVALID_RESPONSE" : "AI_PROVIDER_ERROR";
    logger?.warn?.("AI provider call failed with " + code + ": " + error.message);
    const message = code === "AI_INVALID_RESPONSE"
      ? "The AI provider returned an unreadable response."
      : "The AI provider request failed.";
    return new HttpError(502, code, message);
  }
  return error;
}

function gameContext(game) {
  return {
    id: game.id,
    mode: game.mode,
    playerCount: game.playerCount,
    players: game.currentState.players.map((player) => ({ seat: player.seat, name: player.name, kind: player.kind })),
    result: game.currentState.result,
    metrics: game.metrics,
    createdAt: game.createdAt,
    finishedAt: game.finishedAt
  };
}

function toClientMessage(row) {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.createdAt };
}

export function createCoachService({
  repositories,
  aiSettings,
  providerFactory,
  protocol,
  analysis,
  logger = null,
  now = Date.now
} = {}) {
  async function localAnalysisFor(game) {
    if (game.analysis?.summary?.explanationVersion === 1) return game.analysis;
    try {
      return await analysis.generate(game.currentState, { metrics: game.metrics });
    } catch (error) {
      logger?.warn?.("Local analysis was unavailable for coach grounding. (" + (error?.message ?? error) + ")");
      return null;
    }
  }

  function assertFinished(game) {
    if (game.status !== "finished" || game.currentState?.phase !== "finished") {
      throw new HttpError(409, "GAME_NOT_FINISHED", "The game must be finished before a coach report can be generated.");
    }
  }

  function listMessages(gameId, userId, limit = MAX_TRANSCRIPT_MESSAGES) {
    return repositories.listCoachMessages(gameId, limit, userId).map(toClientMessage);
  }

  function getCoach(user, game) {
    const stored = repositories.getCoachReport(game.id);
    return {
      report: stored?.status === "ready" ? stored.report : null,
      messages: listMessages(game.id, user.id),
      config: aiSettings.coachConfig(user.id)
    };
  }

  async function stateBeforeMove(game, moves, index) {
    if (index === -1) return null;
    try {
      return replayActions(game.initialState, moves.slice(0, index).map((move) => move.action));
    } catch (error) {
      logger?.warn?.("Coach report replay failed. (" + (error?.message ?? error) + ")");
      return null;
    }
  }

  async function normalizeReport(raw, { game, moves }) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const playerCount = game.playerCount;
    const seatValid = (seat) => Number.isInteger(seat) && seat >= 0 && seat < playerCount;
    const turns = new Set(moves.map((move) => move.turn).filter((turn) => Number.isInteger(turn)));
    const headline = cleanText(raw.headline, MAX.headline);
    const summary = cleanText(raw.summary, MAX.summary);
    if (headline.length === 0 || summary.length === 0) return null;

    const strengths = [];
    for (const entry of Array.isArray(raw.strengths) ? raw.strengths : []) {
      if (!entry || typeof entry !== "object") continue;
      const title = cleanText(entry.title, MAX.strengthTitle);
      const detail = cleanText(entry.detail, MAX.strengthDetail);
      if (!seatValid(entry.seat) || title.length === 0) continue;
      strengths.push({ seat: entry.seat, title, detail });
      if (strengths.length >= ARRAY_CAPS.strengths) break;
    }

    const weaknesses = [];
    for (const entry of Array.isArray(raw.weaknesses) ? raw.weaknesses : []) {
      if (!entry || typeof entry !== "object") continue;
      const title = cleanText(entry.title, MAX.weaknessTitle);
      const detail = cleanText(entry.detail, MAX.weaknessDetail);
      if (!seatValid(entry.seat) || title.length === 0) continue;
      const weakness = {
        seat: entry.seat,
        severity: SEVERITIES.has(entry.severity) ? entry.severity : "medium",
        title,
        detail
      };
      if (Number.isInteger(entry.turn) && turns.has(entry.turn)) weakness.turn = entry.turn;
      if (Array.isArray(entry.cells)) {
        const cells = entry.cells
          .filter((cell) => typeof cell === "string" && CELL_PATTERN.test(cell))
          .slice(0, 6);
        if (cells.length > 0) weakness.cells = cells;
      }
      weaknesses.push(weakness);
      if (weaknesses.length >= ARRAY_CAPS.weaknesses) break;
    }

    const keyMistakes = [];
    for (const entry of Array.isArray(raw.keyMistakes) ? raw.keyMistakes : []) {
      if (!entry || typeof entry !== "object") continue;
      if (!seatValid(entry.seat) || !Number.isInteger(entry.turn) || !turns.has(entry.turn)) continue;
      const actual = cleanText(entry.actual, MAX.mistakeText);
      const better = cleanText(entry.better, MAX.mistakeText);
      const reason = cleanText(entry.reason, MAX.mistakeReason);
      if (actual.length === 0 || reason.length === 0) continue;
      // A turn can contain two stones: validate against the actual stone and
      // its own board snapshot, rather than always using the turn's first one.
      const index = moves.findIndex((move) => move.turn === entry.turn && move.seat === entry.seat
        && move.action?.type === "place"
        && formatCell(game.currentState, move.action.x, move.action.y) === actual.toUpperCase());
      if (index === -1) continue;
      const mistake = { seat: entry.seat, turn: entry.turn, actual, reason };
      if (better.length > 0) {
        const stateBefore = await stateBeforeMove(game, moves, index);
        if (stateBefore) {
          const legal = getLegalActions(stateBefore);
          const parsedBetter = await protocol.parseMoveResponse(better, { state: stateBefore, legalActions: legal });
          if (parsedBetter) {
            mistake.better = formatCell(stateBefore, parsedBetter.x, parsedBetter.y);
          }
        }
      }
      const gain = finiteNumber(entry.gain);
      if (gain !== null) mistake.gain = gain;
      keyMistakes.push(mistake);
      if (keyMistakes.length >= ARRAY_CAPS.keyMistakes) break;
    }

    const recommendations = [];
    for (const entry of Array.isArray(raw.recommendations) ? raw.recommendations : []) {
      if (!entry || typeof entry !== "object") continue;
      const title = cleanText(entry.title, MAX.recommendationTitle);
      const detail = cleanText(entry.detail, MAX.recommendationDetail);
      if (!seatValid(entry.seat) || title.length === 0 || detail.length === 0) continue;
      const priority = finiteNumber(entry.priority);
      recommendations.push({
        seat: entry.seat,
        priority: priority === null ? 1 : Math.trunc(priority),
        title,
        detail
      });
      if (recommendations.length >= ARRAY_CAPS.recommendations) break;
    }

    const trainingPlan = [];
    for (const step of Array.isArray(raw.trainingPlan) ? raw.trainingPlan : []) {
      const text = cleanText(step, MAX.trainingStep);
      if (text.length === 0) continue;
      trainingPlan.push(text);
      if (trainingPlan.length >= ARRAY_CAPS.trainingPlan) break;
    }

    return { headline, summary, strengths, weaknesses, keyMistakes, recommendations, trainingPlan };
  }

  async function generate(user, game, { force = false, language = "zh" } = {}) {
    assertFinished(game);
    const existing = repositories.getCoachReport(game.id);
    if (existing?.status === "ready" && !force) {
      return { cached: true, report: existing.report };
    }
    const settings = aiSettings.resolveForCoach(user.id);
    aiSettings.assertQuota(settings.userId);
    const moves = repositories.listActions(game.id);
    const localAnalysis = await localAnalysisFor(game);
    const baseContext = {
      game: gameContext(game),
      state: game.currentState,
      moves,
      analysis: localAnalysis,
      maxOutputTokens: settings.maxOutputTokens,
      language
    };
    const provider = providerFactory(settings, { gameId: game.id, requestingUserId: user.id });
    let inputTokens = 0;
    let outputTokens = 0;
    let previousText = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      aiSettings.assertQuota(settings.userId);
      const messages = attempt === 1
        ? await protocol.buildCoachReportMessages(baseContext)
        : await protocol.buildCoachReportRepairMessages({ ...baseContext, previousText });
      let completion;
      try {
        completion = await provider.complete({
          messages,
          kind: "coach-report",
          maxTokens: settings.maxOutputTokens,
          mockContext: { game: baseContext.game, analysis: localAnalysis, metrics: game.metrics }
        });
      } catch (error) {
        throw mapProviderFailure(error, logger);
      }
      inputTokens += completion.usage.inputTokens;
      outputTokens += completion.usage.outputTokens;
      previousText = completion.text;
      const parsed = await protocol.parseCoachReportResponse(completion.text);
      const normalized = parsed ? await normalizeReport(parsed, { game, moves }) : null;
      if (normalized) {
        const generatedAt = now();
        const report = {
          version: COACH_REPORT_VERSION,
          source: "llm",
          provider: settings.provider,
          model: completion.model ?? settings.model,
          generatedAt,
          ...normalized,
          usage: { inputTokens, outputTokens }
        };
        repositories.upsertCoachReport({
          gameId: game.id,
          userId: user.id,
          status: "ready",
          source: "llm",
          provider: settings.provider,
          model: report.model,
          report,
          error: null,
          inputTokens,
          outputTokens,
          createdAt: existing?.createdAt ?? generatedAt,
          updatedAt: generatedAt
        });
        logger?.info?.("Coach report generated for game " + game.id + ".");
        return { cached: false, report };
      }
      logger?.warn?.("Coach report attempt " + attempt + " failed validation for game " + game.id + ".");
    }
    throw new HttpError(502, "AI_INVALID_RESPONSE", "The AI provider did not return a valid coach report.");
  }

  async function chat(user, game, { message, language = "zh" } = {}) {
    if (typeof message !== "string") {
      throw new HttpError(400, "INVALID_MESSAGE", "Message must be a string.");
    }
    const content = message.trim();
    if (content.length === 0 || content.length > MAX_CHAT_MESSAGE_LENGTH) {
      throw new HttpError(400, "INVALID_MESSAGE", "Message must be between 1 and " + MAX_CHAT_MESSAGE_LENGTH + " characters.");
    }
    assertFinished(game);
    const stored = repositories.getCoachReport(game.id);
    if (!stored || stored.status !== "ready") {
      throw new HttpError(409, "COACH_REPORT_REQUIRED", "Generate a coach report before asking follow-up questions.");
    }
    const settings = aiSettings.resolveForCoach(user.id);
    aiSettings.assertQuota(settings.userId);
    const localAnalysis = await localAnalysisFor(game);
    const history = repositories.listCoachMessages(game.id, 8, user.id);
    const baseContext = {
      game: gameContext(game),
      state: game.currentState,
      report: stored.report,
      analysis: localAnalysis,
      history,
      message: content,
      language
    };
    const provider = providerFactory(settings, { gameId: game.id, requestingUserId: user.id });
    let inputTokens = 0;
    let outputTokens = 0;
    let previousText = "";
    let reply = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      aiSettings.assertQuota(settings.userId);
      const messages = attempt === 1
        ? await protocol.buildCoachChatMessages(baseContext)
        : await protocol.buildCoachChatRepairMessages({ ...baseContext, previousText });
      let completion;
      try {
        completion = await provider.complete({
          messages,
          kind: "coach-chat",
          maxTokens: Math.min(settings.maxOutputTokens, 1200),
          mockContext: { game: baseContext.game, analysis: localAnalysis, report: stored.report }
        });
      } catch (error) {
        throw mapProviderFailure(error, logger);
      }
      inputTokens += completion.usage.inputTokens;
      outputTokens += completion.usage.outputTokens;
      previousText = completion.text;
      reply = await protocol.parseCoachChatResponse(completion.text);
      if (reply) break;
      logger?.warn?.("Coach chat attempt " + attempt + " returned no usable reply for game " + game.id + ".");
    }
    if (!reply) {
      throw new HttpError(502, "AI_INVALID_RESPONSE", "The AI provider did not return a usable chat reply.");
    }
    const createdAt = now();
    repositories.transaction(() => {
      repositories.insertCoachMessage({
        gameId: game.id,
        userId: user.id,
        role: "user",
        content,
        inputTokens: 0,
        outputTokens: 0,
        createdAt
      });
      repositories.insertCoachMessage({
        gameId: game.id,
        userId: user.id,
        role: "assistant",
        content: reply,
        inputTokens,
        outputTokens,
        createdAt: createdAt + 1
      });
    });
    return {
      reply,
      messages: listMessages(game.id, user.id),
      usage: { inputTokens, outputTokens }
    };
  }

  return { getCoach, generate, chat };
}
