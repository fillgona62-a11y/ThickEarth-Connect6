/**
 * AI seat driver. The heuristics themselves live in shared/ai.js, owned by the AI
 * module; the server only calls chooseAiAction and validates the returned action.
 * If shared/ai.js is missing or returns something illegal the server falls back to
 * the first legal action, which keeps games and tests running.
 */

import { getLegalActions } from "../shared/rules.js";
import { createLazyModule } from "./module-loader.js";

export const DEFAULT_TIME_BUDGET_MS = 600;

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
          maxTokens: 400,
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

  return { choose };
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
