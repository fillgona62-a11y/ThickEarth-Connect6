/**
 * AI seat driver. The heuristics themselves live in shared/ai.js, owned by the AI
 * module; the server only calls chooseAiAction and validates the returned action.
 * If shared/ai.js is missing or returns something illegal the server falls back to
 * the first legal action, which keeps games and tests running.
 */

import { getLegalActions } from "../shared/rules.js";
import { createLazyModule } from "./module-loader.js";

export const DEFAULT_TIME_BUDGET_MS = 600;

// Playing strength is explicitly secondary to responsiveness here. A move call
// gets one short round-trip; anything slower falls back to the local engine.
export const LLM_MOVE_TIMEOUT_MS = Number(process.env.THICK_EARTH_LLM_MOVE_TIMEOUT_MS) || 2500;
export const LLM_MOVE_MAX_TOKENS = 256;

function defaultImport() {
  return import("../shared/ai.js");
}

export function createAiEngine({ importModule = defaultImport, logger = null, timeBudgetMs = DEFAULT_TIME_BUDGET_MS } = {}) {
  const lazy = createLazyModule({
    importModule,
    select: (moduleValue) => moduleValue?.chooseAiAction,
    label: "shared/ai.js",
    logger
  });

  async function chooseAction(state, { difficulty = "normal", seed = 1, timeBudgetMs: budget = timeBudgetMs } = {}) {
    const legal = getLegalActions(state);
    if (legal.length === 0) return null;
    const chooseAiAction = await lazy.get();
    if (chooseAiAction) {
      try {
        const action = await chooseAiAction(state, {
          difficulty,
          seat: state.currentSeat,
          timeBudgetMs: budget,
          seed
        });
        const match = matchLegalAction(legal, action);
        if (match) return match;
        logger?.warn?.("The AI returned an action outside the legal action space; using the first legal action.");
      } catch (error) {
        logger?.warn?.("The AI failed to choose an action; using the first legal action. (" + (error?.message ?? error) + ")");
      }
    }
    return legal[0];
  }

  return { chooseAction };
}

/**
 * LLM move engine: builds the protocol prompt, calls the provider, parses and
 * validates the reply, and retries once with a repair prompt. The caller owns
 * quota checks and usage recording through the injected callbacks, so every real
 * provider call is counted even when the model returns an illegal action.
 */
export function createLlmMoveEngine({ protocol, logger = null, maxAttempts = 2 } = {}) {
  async function choose(state, { seat = state.currentSeat, provider, beforeCall = null, onProviderCall = null } = {}) {
    const legalActions = getLegalActions(state);
    if (legalActions.length === 0) return { action: null, attempts: 0 };
    const context = { state, legalActions, seat };
    let previousText = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (typeof beforeCall === "function" && (await beforeCall(attempt)) === false) {
        return { action: null, attempts: attempt - 1, budgetExhausted: true };
      }
      const messages = attempt === 1
        ? await protocol.buildMoveMessages(context)
        : await protocol.buildMoveRepairMessages({ ...context, previousText });
      let completion;
      try {
        completion = await provider.complete({
          messages,
          kind: "move",
          maxTokens: LLM_MOVE_MAX_TOKENS,
          timeoutMs: LLM_MOVE_TIMEOUT_MS,
          mockContext: { legalActions, seat }
        });
      } catch (error) {
        logger?.warn?.("LLM move provider call failed; using the local engine. (" + (error?.message ?? error) + ")");
        return { action: null, attempts: attempt, failed: true };
      }
      if (typeof onProviderCall === "function") await onProviderCall(completion, attempt);
      const action = await protocol.parseMoveResponse(completion.text, { state, legalActions });
      if (action) return { action, attempts: attempt, model: completion.model, usage: completion.usage };
      previousText = completion.text;
      logger?.warn?.("LLM returned no legal action (attempt " + attempt + "); retrying.");
    }
    return { action: null, attempts: maxAttempts, invalid: true };
  }

  /**
   * Ask for both stones of a Connect6 turn in ONE provider round-trip.
   * Connect6 places two stones per turn, so calling choose() twice per turn
   * doubles the network latency for no benefit — the second stone only needs to
   * be a different legal point. The caller still applies and validates each
   * stone separately through shared/rules.js.
   */
  async function chooseTurn(state, { seat = state.currentSeat, provider, beforeCall = null, onProviderCall = null } = {}) {
    const legalActions = getLegalActions(state);
    if (legalActions.length < 2) return [];
    const context = { state, legalActions, seat };
    let previousText = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (typeof beforeCall === "function" && (await beforeCall(attempt)) === false) return [];
      const base = await protocol.buildTurnMessages(context);
      const messages = attempt === 1
        ? base
        : [...base,
            { role: "assistant", content: previousText },
            { role: "user", content: "That reply did not contain two distinct legal points. Reply with exactly one JSON object: {\"actions\":[{\"type\":\"place\",\"x\":9,\"y\":9},{\"type\":\"place\",\"x\":10,\"y\":9}],\"reason\":\"short reason\"}." }];
      let completion;
      try {
        completion = await provider.complete({
          messages,
          kind: "move",
          maxTokens: LLM_MOVE_MAX_TOKENS,
          timeoutMs: LLM_MOVE_TIMEOUT_MS,
          mockContext: { legalActions, seat }
        });
      } catch (error) {
        logger?.warn?.("LLM turn provider call failed; using the local engine. (" + (error?.message ?? error) + ")");
        return [];
      }
      if (typeof onProviderCall === "function") await onProviderCall(completion, attempt);
      const actions = await protocol.parseTurnResponse(completion.text, { state, legalActions });
      if (process.env.THICK_EARTH_LLM_DEBUG === "1") {
        logger?.warn?.("LLM turn raw reply: " + String(completion.text).slice(0, 600));
      }
      // One usable point is still better than nothing: the caller places it and
      // fills the missing stone locally. Strength is explicitly secondary.
      if (actions.length > 0) return actions;
      previousText = completion.text;
      logger?.warn?.("LLM returned no usable turn stone (attempt " + attempt + "); retrying.");
    }
    return [];
  }

  return { choose, chooseTurn };
}

function matchLegalAction(legal, action) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") return null;
  const match = legal.find((candidate) => {
    if (candidate.type !== action.type) return false;
    if (candidate.type === "pass") return true;
    return candidate.x === action.x && candidate.y === action.y;
  });
  return match ?? null;
}
