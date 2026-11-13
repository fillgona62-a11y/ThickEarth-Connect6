/**
 * Encryption helpers for write-only AI provider credentials.
 *
 * API keys are encrypted at rest with AES-256-GCM. The key-encryption key is
 * derived from AI_SECRET when supplied, otherwise from a random secret created
 * once beside the SQLite database as ".ai-secret". Plaintext keys are never
 * logged, returned by the API, or written to the database.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SECRET_CONTEXT = "thickearth-ai-key-v1";
const SECRET_FILE_NAME = ".ai-secret";
const MIN_SECRET_LENGTH = 16;

function deriveKey(secret) {
  return createHash("sha256").update(SECRET_CONTEXT + ":" + secret, "utf8").digest();
}

function readSecretFile(filePath, logger) {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (value.length >= MIN_SECRET_LENGTH) return value;
    logger?.warn?.("The stored AI secret file is too short; creating a new secret.");
  } catch (error) {
    logger?.warn?.("The stored AI secret file could not be read; creating a new secret. (" + (error?.message ?? error) + ")");
  }
  return null;
}

function writeSecretFile(filePath, secret) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, secret + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the file stays user-private.
  }
}

export function createSecretStore({ dbPath = ":memory:", secret = null, env = process.env, logger = null } = {}) {
  const configuredSecret = typeof secret === "string" && secret.length > 0
    ? secret
    : (typeof env.AI_SECRET === "string" && env.AI_SECRET.length > 0 ? env.AI_SECRET : null);
  let secretSource = "environment";
  let secretValue = configuredSecret;

  if (!secretValue) {
    const persistent = typeof dbPath === "string" && dbPath.length > 0 && dbPath !== ":memory:";
    if (persistent) {
      const filePath = join(dirname(dbPath), SECRET_FILE_NAME);
      secretValue = readSecretFile(filePath, logger);
      if (!secretValue) {
        secretValue = randomBytes(KEY_BYTES).toString("hex");
        writeSecretFile(filePath, secretValue);
        secretSource = "file";
        logger?.info?.("Created a new AI secret file beside the database.");
      } else {
        secretSource = "file";
      }
    } else {
      secretValue = randomBytes(KEY_BYTES).toString("hex");
      secretSource = "ephemeral";
    }
  }
  logger?.info?.("AI credential secret loaded from " + secretSource + ".");

  const encryptionKey = deriveKey(secretValue);

  function encrypt(plaintext) {
    const value = String(plaintext ?? "");
    if (value.length === 0) throw new Error("Cannot encrypt an empty credential.");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, encryptionKey, iv);
    cipher.setAAD(Buffer.from(SECRET_CONTEXT, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  function decrypt(payload) {
    if (typeof payload !== "string" || payload.length === 0) return null;
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    try {
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      const ciphertext = Buffer.from(parts[3], "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      const decipher = createDecipheriv(CIPHER, encryptionKey, iv);
      decipher.setAAD(Buffer.from(SECRET_CONTEXT, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return plaintext.length > 0 ? plaintext : null;
    } catch {
      // A secret rotation or a corrupted value makes the stored key unusable.
      logger?.warn?.("A stored AI credential could not be decrypted; treating it as missing.");
      return null;
    }
  }

  return { encrypt, decrypt };
}

export function keyHint(apiKey) {
  const value = String(apiKey ?? "");
  return value.length >= 4 ? value.slice(-4) : "****";
}
