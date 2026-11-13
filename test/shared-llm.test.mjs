/**
 * The server-wide LLM provider is opt-in. When enabled, players without their
 * own AI settings borrow the shared encrypted credential; when disabled, the
 * original per-user behaviour is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createAiSettingsService } from "../server/ai-settings.js";

const OWNER = "user_owner";
const CONFIGURED = {
  userId: OWNER,
  enabled: true,
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiKeyEncrypted: "encrypted-blob",
  keyHint: "abcd",
  temperature: 0.2,
  maxOutputTokens: 1200,
  maxMovesPerGame: 40,
  monthlyCallLimit: 500,
  createdAt: 1,
  updatedAt: 1
};

function fixture(env = {}) {
  const repositories = {
    getAiSettings: (id) => (id === OWNER ? { ...CONFIGURED } : null),
    firstConfiguredAiSettingsUserId: () => OWNER,
    sumAiUsageSince: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 })
  };
  const secretStore = { decrypt: () => "sk-plain", encrypt: (value) => "enc:" + value };
  const service = createAiSettingsService({ repositories, secretStore, env, now: () => 1000 });
  return { service, repositories };
}

test("shared provider is off unless AI_SHARED_LLM is set", () => {
  const { service } = fixture({});
  assert.equal(service.sharedAvailable(), false);
  assert.equal(service.getSharedForMove(), null);
});

test("shared provider resolves the encrypted credential without exposing it", () => {
  const { service } = fixture({ AI_SHARED_LLM: "1" });
  assert.equal(service.sharedAvailable(), true);
  const shared = service.getSharedForMove();
  assert.equal(shared.userId, OWNER);
  assert.equal(shared.settings.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(shared.settings.model, "deepseek-flash");
  assert.equal(shared.settings.apiKey, "sk-plain");
});

test("AI_SHARED_USER_ID pins the source instead of auto-discovering it", () => {
  const { service, repositories } = fixture({ AI_SHARED_LLM: "true", AI_SHARED_USER_ID: OWNER });
  let autoUsed = false;
  repositories.firstConfiguredAiSettingsUserId = () => {
    autoUsed = true;
    return null;
  };
  assert.equal(service.sharedAvailable(), true);
  assert.equal(autoUsed, false);
});

test("a disabled or key-less shared row does not advertise availability", () => {
  const { service, repositories } = fixture({ AI_SHARED_LLM: "1" });
  repositories.getAiSettings = () => ({ ...CONFIGURED, enabled: false });
  assert.equal(service.sharedAvailable(), false);
  assert.equal(service.getSharedForMove(), null);
});
