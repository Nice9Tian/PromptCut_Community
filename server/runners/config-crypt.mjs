/**
 * Encrypt API Key on disk.
 *
 * Uses the same envelope (PBKDF2-SHA256 + AES-256-GCM) as the distribution string, with the
 * passphrase swapped for the local machine fingerprint and AAD swapped for the dedicated on-disk
 * string: so distribution strings and on-disk ciphertext cannot decrypt each other by mistake.
 *
 * Keys from the two sources each use a separate **prefix + AAD + passphrase tag**, isolated from
 * each other:
 *   - `custom`: Key filled in by the user under "Custom API", prefix PCENC1. (legacy version,
 *     kept for compatibility);
 *   - `router`: Key imported from "PromptCut Router" distribution string, prefix PCRTR1..
 * Using the router scheme to decrypt a custom ciphertext (or vice versa) yields an empty string:
 * treated as "no Key set", rather than using the other channel's Key. Key files for both paths are
 * also stored separately (see ai-config.mjs).
 *
 * What it guards against are accidents like "plaintext lying around in files": sync drives,
 * backups, accidental commits, screenshots, or someone casually opening your config folder when
 * borrowing your computer. It **cannot stop** anyone who can run code on this machine as your
 * identity: the passphrase is calculated by the machine itself, and derivation logic is shipped
 * with the software, so running it once yields the key. For stronger security, use OS-managed key
 * solutions such as Windows DPAPI / macOS Keychain.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { machineFingerprint } from "./machine-id.mjs";

/**
 * Identifier for each Key channel. Changing algorithms changes the prefix; legacy ciphertext is
 * still recognized
 */
const SCHEMES = {
  custom: { prefix: "PCENC1.", aad: Buffer.from("PromptCut-config-at-rest-v1"), label: "PromptCut-at-rest" },
  router: { prefix: "PCRTR1.", aad: Buffer.from("PromptCut-router-at-rest-v1"), label: "PromptCut-router-at-rest" },
  // Gateway token for voiceover (voice_generate). Not the same key as chat API Key, and cannot be
  // used as a chat source
  voice: { prefix: "PCVOC1.", aad: Buffer.from("PromptCut-voice-at-rest-v1"), label: "PromptCut-voice-at-rest" },
};
/**
 * Two sources for the chat API (api.source in ai.json can only take these two).
 * Hardcoded rather than Object.keys(SCHEMES): ai-config treats it as an allowlist of
 * "valid sources"; mixing in the voice token would make it a selectable chat source.
 */
export const KEY_KINDS = ["custom", "router"];

/**
 * All Key types that can be saved to disk (two chat sources + feature-specific ones like
 * voiceover). Key files in ai-config are validated against it
 */
export const SECRET_KINDS = Object.keys(SCHEMES);

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;

function scheme(kind) {
  const s = SCHEMES[kind];
  if (!s) throw new Error(`Unknown key type: ${kind}`);
  return s;
}

/**
 * Derivation results are cached by (tag, salt). readConfig() is called on every request;
 * without caching, it would run 600,000 rounds of PBKDF2 each time, significantly slowing
 * endpoints.
 */
const keyCache = new Map();

function deriveKey(label, salt, iterations) {
  const cacheKey = `${label}:${salt.toString("hex")}:${iterations}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = pbkdf2Sync(`${label}|${machineFingerprint()}`, salt, iterations, 32, "sha256");
    // Can only have "the current config" and "the previous one just changed"; will not grow long
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** Which channel's ciphertext this value belongs to; returns null if not ciphertext */
export function sealedKind(value) {
  if (typeof value !== "string") return null;
  for (const [kind, s] of Object.entries(SCHEMES)) {
    if (value.startsWith(s.prefix)) return kind;
  }
  return null;
}

/** Whether this value is already encrypted (either channel) */
export function isSealed(value) {
  return sealedKind(value) !== null;
}

/**
 * Plaintext Key → on-disk ciphertext. Empty values are returned as-is, without wrapping an empty
 * string
 */
export function sealKey(plain, kind = "custom") {
  const s = scheme(kind);
  if (!plain) return "";
  if (sealedKind(plain) === kind) return plain;
  if (isSealed(plain)) throw new Error("Ciphertext from the other path cannot have its label changed directly, decrypt it first and then seal it again");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(s.label, salt, ITERATIONS), iv);
  cipher.setAAD(s.aad);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(ITERATIONS, 0);
  return s.prefix + Buffer.concat([header, salt, iv, body, cipher.getAuthTag()]).toString("base64url");
}

/**
 * On-disk ciphertext → plaintext Key.
 *
 * Returns as-is if not ciphertext: legacy configurations store plaintext, and upgrading must not
 * lose the user's Key; returns an empty string instead of throwing if decryption fails: configs
 * copied when moving to another machine should behave as "no Key set", prompting the user to fill
 * it in again rather than causing a 500 error on the settings endpoint.
 * Also returns an empty string if it is ciphertext from the **other channel**: custom and router
 * cannot be mixed.
 */
export function openKey(sealed, kind = "custom") {
  const s = scheme(kind);
  if (!sealed) return "";
  const found = sealedKind(sealed);
  if (found === null) return String(sealed);
  if (found !== kind) return "";
  try {
    const raw = Buffer.from(sealed.slice(s.prefix.length), "base64url");
    if (raw.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES) return "";
    const iterations = raw.readUInt32BE(0);
    if (iterations < 10_000 || iterations > 5_000_000) return "";
    const salt = raw.subarray(4, 4 + SALT_BYTES);
    const iv = raw.subarray(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
    const body = raw.subarray(4 + SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(s.label, salt, iterations), iv);
    decipher.setAAD(s.aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
