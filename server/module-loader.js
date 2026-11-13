/**
 * Lazily loads an optional ESM module and caches the selected export.
 *
 * shared/ai.js and shared/analysis.js are owned by other parts of the project and
 * may not exist yet while the server is being developed. Failures are throttled so
 * the server retries occasionally and picks the module up as soon as it appears,
 * without paying a failed-import cost on every request.
 */
export function createLazyModule({ importModule, select, label = "Optional module", retryMs = 2000, logger = null }) {
  let loaded = null;
  let lastFailureAt = 0;
  let pending = null;

  async function get() {
    if (loaded) return loaded;
    if (pending) return pending;
    const now = Date.now();
    if (lastFailureAt !== 0 && now - lastFailureAt < retryMs) return null;
    pending = (async () => {
      try {
        const moduleValue = await importModule();
        const selected = select(moduleValue);
        if (selected !== null && selected !== undefined) {
          loaded = selected;
          logger?.info?.(label + " loaded.");
          return loaded;
        }
        lastFailureAt = Date.now();
        logger?.warn?.(label + " does not export the expected interface; using fallback behavior.");
        return null;
      } catch (error) {
        lastFailureAt = Date.now();
        logger?.warn?.(label + " is unavailable; using fallback behavior. (" + (error?.message ?? error) + ")");
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return { get };
}
