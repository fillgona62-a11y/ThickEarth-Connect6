/**
 * Agent protocol seam.
 *
 * Prompt builders and response parsers for the LLM opponent and the AI coach live
 * in shared/agent-protocol.js (owned by the shared module so the browser can use
 * the same text). Until that module ships — or if its interface differs — this
 * module provides a clean local fallback with the same method signatures. The
 * server always re-validates model output against shared/rules.js and the coach
 * report schema, so a buggy or hostile prompt/parser can never corrupt state.
 */

import { formatCell } from "../shared/rules.js";
import { extractJson } from "./ai-provider.js";
import { createLazyModule } from "./module-loader.js";

export const AGENT_PROTOCOL_VERSION = "thick-earth-agent/v1";

const LANGUAGE_NAMES = Object.freeze({ zh: "Simplified Chinese", en: "English" });
const MAX_MOVE_LOG_LINES = 140;
const MAX_ANALYSIS_ITEMS = 8;

function languageName(language) {
  return LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.zh;
}

function clampText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function boardRows(state) {
  const rows = [];
  for (let y = 0; y < state.boardSize; y += 1) {
    let row = "";
    for (let x = 0; x < state.boardSize; x += 1) {
      const seat = state.cells[y * state.boardSize + x];
      // Seat 0 is falsy, so the emptiness check must be explicit.
      row += seat === null || seat === undefined ? "." : (seat === 0 ? "X" : "O");
    }
    rows.push(row);
  }
  return rows;
}

function playerSummary(state) {
  return state.players.map((player) => ({
    seat: player.seat,
    name: player.name,
    kind: player.kind,
    color: player.color,
    stones: Number.isInteger(player.stones) ? player.stones : 0
  }));
}

function stateSummary(state, legalActions) {
  return {
    phase: state.phase,
    playerCount: state.playerCount,
    currentSeat: state.currentSeat,
    boardSize: state.boardSize,
    winLength: state.winLength ?? 6,
    stonesRemainingThisTurn: state.phase === "play"
      ? Math.max(0, (state.turn <= 1 ? 1 : 2) - (state.placedThisTurn ?? 0))
      : 0,
    boardLegend: "X = black (P1), O = white (P2), . = empty; rows are numbered top to bottom",
    boardRows: boardRows(state),
    players: playerSummary(state),
    legalActions: legalActions.map((action) => ({
      type: "place",
      x: action.x,
      y: action.y,
      notation: formatCell(state, action.x, action.y)
    }))
  };
}

function coachGameContext(game, state) {
  return {
    id: game.id,
    mode: game.mode,
    playerCount: game.playerCount,
    players: state.players.map((player) => ({ seat: player.seat, name: player.name, kind: player.kind })),
    result: state.result,
    metrics: game.metrics,
    createdAt: game.createdAt,
    finishedAt: game.finishedAt
  };
}

function moveLogLines(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return [];
  return moves.slice(0, MAX_MOVE_LOG_LINES).map((move) => {
    const seat = Number.isInteger(move.seat) ? "P" + (move.seat + 1) : "?";
    const turn = move.turn === null || move.turn === undefined ? "-" : String(move.turn);
    return turn + ": " + seat + " " + String(move.notation ?? move.type ?? "");
  });
}

function analysisDigest(analysis) {
  if (!analysis || typeof analysis !== "object") return null;
  const summary = analysis.summary && typeof analysis.summary === "object" ? analysis.summary : {};
  const digest = {
    headline: clampText(summary.headline ?? analysis.summary ?? "", 500),
    resultLine: clampText(summary.resultLine ?? "", 1000),
    keyMoments: [],
    weaknesses: [],
    recommendations: []
  };
  for (const moment of (analysis.keyMoments ?? []).slice(0, MAX_ANALYSIS_ITEMS)) {
    digest.keyMoments.push({
      turn: moment.turn ?? null,
      seat: moment.seat ?? null,
      title: clampText(moment.title, 160),
      detail: clampText(moment.detail, 400),
      weight: Number.isFinite(moment.impact) ? moment.impact : null
    });
  }
  for (const weakness of (analysis.weaknesses ?? []).slice(0, MAX_ANALYSIS_ITEMS)) {
    digest.weaknesses.push({
      seat: weakness.seat ?? null,
      severity: weakness.severity ?? null,
      detail: clampText(weakness.detail, 400)
    });
  }
  for (const recommendation of (analysis.recommendations ?? []).slice(0, MAX_ANALYSIS_ITEMS)) {
    digest.recommendations.push({
      seat: recommendation.seat ?? null,
      priority: recommendation.priority ?? null,
      title: clampText(recommendation.title, 160),
      detail: clampText(recommendation.detail, 400)
    });
  }
  return digest;
}

const MOVE_SYSTEM_PROMPT = [
  "You are an AI player in Connect6 (六子棋), a deterministic two-player placing game on a 19x19 board.",
  "Black (P1) opens with one stone; every later turn places two stones, one stone per reply. First to line up six in a row, column or diagonal wins.",
  "Choose exactly one stone for the player on the move (currentSeat in the supplied state).",
  "Return ONLY a JSON object, with no prose and no markdown:",
  '{"type":"place","x":<0-18>,"y":<0-18>}',
  "The point MUST be one of the supplied legalActions (same coordinates).",
  "x is the zero-based column index (A=0, S=18); y is the zero-based row index (row 1 = 0).",
  "There is no pass, no resignation and no multi-stone action. A single threat is answered for free, so prefer moves that create two threats at once.",
  "Do not explain. Output the JSON object only."
].join("\n");

const COACH_REPORT_SYSTEM_PROMPT = [
  "You are ThickEarth Coach, a grounded post-game analyst for Connect6 (六子棋): two players, 19x19 board, black opens with one stone, every later turn places two stones, six in a row wins.",
  "Base every statement on the supplied game record, final result, move log and local analysis. Never invent moves, line lengths, turns or points.",
  "Return ONLY one JSON object, no markdown, with this shape:",
  "{",
  '  "headline": string (max 160 chars),',
  '  "summary": string (max 2000 chars),',
  '  "strengths": [{"seat": int, "title": string, "detail": string}] (max 4),',
  '  "weaknesses": [{"seat": int, "severity": "high"|"medium"|"low", "title": string, "detail": string, "turn": int?, "cells": string[]?}] (max 6),',
  '  "keyMistakes": [{"seat": int, "turn": int, "actual": string, "better": string, "reason": string, "gain": number?}] (max 6),',
  '  "recommendations": [{"seat": int, "priority": int, "title": string, "detail": string}] (max 6),',
  '  "trainingPlan": string[] (max 5)',
  "}",
  "Rules: seat values must be 0 (black) or 1 (white); keyMistakes turn values must exist in the move log; actual/better are single points in notation like K10 or D4, and better must have been legal at that turn; cells use notation A1-S19.",
  "Keep the training plan concrete and actionable. Do not mention that you are a language model."
].join("\n");

function coachReportUserPrompt(context) {
  return JSON.stringify({
    task: "coach-report",
    language: languageName(context.language),
    game: context.game,
    finalState: stateSummary(context.state, []),
    moveLog: moveLogLines(context.moves),
    localAnalysis: analysisDigest(context.analysis)
  });
}

function coachChatSystemPrompt(context) {
  const report = context.report ?? {};
  return [
    "You are ThickEarth Coach, answering follow-up questions about one finished game.",
    "Use only the supplied coach report, local analysis and game record as evidence; never invent moves, scores or cells.",
    "Reply in plain text (no JSON, no markdown headings), at most 1200 characters.",
    "Write in " + languageName(context.language) + ".",
    "Coach report headline: " + clampText(report.headline ?? "", 200),
    "Coach report summary: " + clampText(report.summary ?? "", 1200),
    "Grounding analysis: " + clampText(analysisDigest(context.analysis)?.resultLine ?? "", 600)
  ].join("\n");
}

function matchLegalAction(legalActions, candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.type !== "place") return null;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  const match = legalActions.find((action) => action.x === x && action.y === y);
  return match ? { type: "place", x: match.x, y: match.y } : null;
}

/** Accepts "K10" and the older "place K10" spelling. */
function actionFromNotation(notation) {
  const match = /^(?:place\s+)?([A-Sa-s])(\d{1,2})$/.exec(String(notation ?? "").trim());
  if (!match) return null;
  return {
    type: "place",
    x: match[1].toUpperCase().charCodeAt(0) - 65,
    y: Number(match[2]) - 1
  };
}

function candidateFromValue(value) {
  if (typeof value === "string") return actionFromNotation(value);
  if (!value || typeof value !== "object") return null;
  if (typeof value.action === "string") return actionFromNotation(value.action);
  if (value.type !== undefined && value.type !== "place") return null;
  const x = Number(value.x ?? value.col ?? value.column);
  const y = Number(value.y ?? value.row);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { type: "place", x, y };
}

function candidatesFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed)) return parsed;
  const candidates = [parsed];
  if (parsed.action !== undefined) candidates.push(parsed.action);
  if (parsed.move !== undefined) candidates.push(parsed.move);
  if (Array.isArray(parsed.actions)) candidates.push(...parsed.actions);
  return candidates;
}

function localParseMoveResponse(text, { state, legalActions }) {
  const parsed = extractJson(text);
  for (const candidate of candidatesFromParsed(parsed)) {
    const action = matchLegalAction(legalActions, candidateFromValue(candidate));
    if (action) return action;
  }
  const textMatch = /\b([A-Sa-s])(\d{1,2})\b/.exec(String(text ?? ""));
  if (textMatch) {
    const action = matchLegalAction(legalActions, actionFromNotation(textMatch[0]));
    if (action) return action;
  }
  return null;
}

function localBuildMoveMessages({ state, legalActions, seat }) {
  return [
    { role: "system", content: MOVE_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({ task: "move", seat: seat ?? state.currentSeat, state: stateSummary(state, legalActions) })
    }
  ];
}

function localBuildMoveRepairMessages({ state, legalActions, seat, previousText }) {
  const messages = localBuildMoveMessages({ state, legalActions, seat });
  messages.push({ role: "assistant", content: clampText(previousText, 800) });
  messages.push({
    role: "user",
    content: "Your previous reply was not one of the legal actions. Reply with ONE JSON action object chosen from legalActions, no prose."
  });
  return messages;
}

function localBuildCoachReportMessages(context) {
  return [
    { role: "system", content: COACH_REPORT_SYSTEM_PROMPT + "\nWrite human-readable text in " + languageName(context.language) + "." },
    { role: "user", content: coachReportUserPrompt(context) }
  ];
}

function localBuildCoachReportRepairMessages(context) {
  const messages = localBuildCoachReportMessages(context);
  messages.push({ role: "assistant", content: clampText(context.previousText, 1500) });
  messages.push({
    role: "user",
    content: "The previous reply was not valid coach-report JSON. Return ONLY the JSON object with the required fields, no markdown."
  });
  return messages;
}

function localParseCoachReportResponse(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.report && typeof parsed.report === "object" && !Array.isArray(parsed.report)) return parsed.report;
  return parsed;
}

function localBuildCoachChatMessages(context) {
  const messages = [{ role: "system", content: coachChatSystemPrompt(context) }];
  for (const message of (context.history ?? []).slice(-8)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    messages.push({ role: message.role, content: clampText(message.content, 1200) });
  }
  messages.push({ role: "user", content: clampText(context.message, 600) });
  return messages;
}

function localBuildCoachChatRepairMessages(context) {
  const messages = localBuildCoachChatMessages(context);
  messages.push({ role: "assistant", content: clampText(context.previousText, 800) });
  messages.push({ role: "user", content: "Reply to the original question with plain text only, no JSON or markdown." });
  return messages;
}

function localParseCoachChatResponse(text) {
  const raw = String(text ?? "").trim();
  if (raw.length === 0) return null;
  const parsed = extractJson(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const reply = parsed.reply ?? parsed.message ?? parsed.content;
    if (typeof reply === "string" && reply.trim().length > 0) return clampText(reply, 4000);
  }
  const withoutFences = raw.replace(/^\x60\x60\x60(?:json)?/i, "").replace(/\x60\x60\x60$/, "").trim();
  return withoutFences.length > 0 ? clampText(withoutFences, 4000) : null;
}

function localBuildConnectionTestMessages() {
  return [
    { role: "system", content: "You are a connectivity check. Reply with the single word OK." },
    { role: "user", content: "Reply with the single word OK." }
  ];
}

function defaultImport() {
  return import("../shared/agent-protocol.js");
}

/**
 * Resolve the shared protocol module when available and prefer it, otherwise use
 * the local fallback. Every parser output is still normalised by this module.
 */
export function createAgentProtocol({ importModule = defaultImport, logger = null } = {}) {
  const lazy = createLazyModule({
    importModule,
    select: (moduleValue) => (moduleValue && typeof moduleValue === "object" ? moduleValue : null),
    label: "shared/agent-protocol.js",
    logger
  });

  async function sharedModule() {
    return lazy.get();
  }

  async function prefer(method, args, fallback) {
    const moduleValue = await sharedModule();
    const candidate = moduleValue?.[method];
    if (typeof candidate === "function") {
      try {
        const result = await candidate(...args);
        if (result !== null && result !== undefined) return result;
      } catch (error) {
        logger?.warn?.("shared/agent-protocol.js " + method + " failed; using the local fallback. (" + (error?.message ?? error) + ")");
      }
    }
    return fallback();
  }

  async function buildMoveMessages(input) {
    return prefer("buildMoveMessages", [input], () => localBuildMoveMessages(input));
  }

  async function buildMoveRepairMessages(input) {
    const shared = await sharedModule();
    if (typeof shared?.buildMoveRepairMessages === "function") {
      try {
        const result = await shared.buildMoveRepairMessages(input);
        if (Array.isArray(result) && result.length > 0) return result;
      } catch (error) {
        logger?.warn?.("shared/agent-protocol.js buildMoveRepairMessages failed; using the local fallback. (" + (error?.message ?? error) + ")");
      }
    }
    return localBuildMoveRepairMessages(input);
  }

  async function parseMoveResponse(text, context) {
    const moduleValue = await sharedModule();
    if (typeof moduleValue?.parseMoveResponse === "function") {
      try {
        const parsed = await moduleValue.parseMoveResponse(text, context);
        const action = matchLegalAction(context.legalActions, candidateFromValue(parsed));
        if (action) return action;
      } catch (error) {
        logger?.warn?.("shared/agent-protocol.js parseMoveResponse failed; using the local fallback. (" + (error?.message ?? error) + ")");
      }
    }
    return localParseMoveResponse(text, context);
  }

  async function buildCoachReportMessages(context) {
    return prefer("buildCoachReportMessages", [context], () => localBuildCoachReportMessages(context));
  }

  async function buildCoachReportRepairMessages(context) {
    const sharedInput = { context, previousText: context?.previousText };
    return prefer("buildCoachReportRepairMessages", [sharedInput], () => localBuildCoachReportRepairMessages(context));
  }

  async function parseCoachReportResponse(text) {
    return prefer("parseCoachReportResponse", [text], () => localParseCoachReportResponse(text));
  }

  async function buildCoachChatMessages(context) {
    return prefer("buildCoachChatMessages", [context], () => localBuildCoachChatMessages(context));
  }

  async function buildCoachChatRepairMessages(context) {
    const sharedInput = { context, previousText: context?.previousText };
    return prefer("buildCoachChatRepairMessages", [sharedInput], () => localBuildCoachChatRepairMessages(context));
  }

  async function parseCoachChatResponse(text) {
    return prefer("parseCoachChatResponse", [text], () => localParseCoachChatResponse(text));
  }

  async function buildConnectionTestMessages() {
    return prefer("buildConnectionTestMessages", [], () => localBuildConnectionTestMessages());
  }

  return {
    version: AGENT_PROTOCOL_VERSION,
    buildMoveMessages,
    buildMoveRepairMessages,
    parseMoveResponse,
    buildCoachReportMessages,
    buildCoachReportRepairMessages,
    parseCoachReportResponse,
    buildCoachChatMessages,
    buildCoachChatRepairMessages,
    parseCoachChatResponse,
    buildConnectionTestMessages
  };
}
