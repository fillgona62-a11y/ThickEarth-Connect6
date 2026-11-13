/**
 * Post-game local analysis driver. shared/analysis.js provides grounded analysis
 * when it is present; otherwise a structured placeholder is stored so the API
 * contract remains stable. No network or LLM calls are made here.
 */

import { createLazyModule } from "./module-loader.js";

function defaultImport() {
  return import("../shared/analysis.js");
}

export function createAnalysisEngine({ importModule = defaultImport, logger = null } = {}) {
  const lazy = createLazyModule({
    importModule,
    select: (moduleValue) => moduleValue?.analyzeGame,
    label: "shared/analysis.js",
    logger
  });

  async function generate(state, { metrics = null } = {}) {
    const analyzeGame = await lazy.get();
    if (analyzeGame) {
      try {
        const analysis = await analyzeGame(state, { metrics });
        if (analysis && typeof analysis === "object") return analysis;
        logger?.warn?.("shared/analysis.js returned an invalid analysis; storing a placeholder.");
      } catch (error) {
        logger?.warn?.("Analysis generation failed; storing a placeholder. (" + (error?.message ?? error) + ")");
      }
    }
    return createPlaceholderAnalysis(state, metrics);
  }

  return { generate };
}

function createPlaceholderAnalysis(state, metrics) {
  const result = state?.result ?? null;
  const scores = Array.isArray(result?.scores) ? result.scores : [];
  const summary = result
    ? "Game finished; scores " + scores.map((score, seat) => "P" + (seat + 1) + " " + score).join(", ") + "."
    : "Local analysis of the position so far.";
  return {
    engine: "local-placeholder",
    generatedAt: Date.now(),
    summary,
    keyMoments: [],
    weaknesses: [],
    recommendations: [],
    metrics: metrics ?? null
  };
}
