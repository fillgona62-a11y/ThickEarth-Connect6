/**
 * Small typed error used by the AI provider adapter. The HTTP layer maps it onto
 * the standard { error: { code, message } } envelope without leaking credentials.
 */
export class AiProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}
