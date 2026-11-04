import type { ApiVendor } from "./types";
import { tr } from "../i18n/index.ts";

/**
 * Encrypted distribution of LLM API configurations.
 *
 * The distributor fills in baseUrl / key / model locally, encrypts using the recipient's "local
 * identifier" as the passphrase, producing a long text starting with PCAI1.; the recipient pastes
 * it in, software computes the same identifier locally, automatically decrypts and writes it into
 * the configuration.
 *
 * What it protects against: ciphertext remains encrypted while sent via email or chat; forwarded to
 * a third party, it cannot be decrypted because their machine code differs.
 * What it does not protect against: the recipient themselves. Their software must obtain the
 * plaintext key to call the API, so if determined they can always retrieve it. This setup is "bound
 * to a specified machine + encrypted in transit", not confidential from the recipient.
 */

/** Ciphertext prefix, doubling as version. Changing algorithm changes prefix; old ciphertext is still recognized */
const PREFIX = "PCAI1.";

/** Additional data bound into AES-GCM: ciphertext cannot be decrypted if reused for other purposes */
const AAD = "PromptCut-api-share-v1";

const SALT_BYTES = 16;
const IV_BYTES = 12;

/** PBKDF2 rounds. The identifier has only 100 bits of entropy; rounds raise the cost of brute force */
const DEFAULT_ITERATIONS = 600_000;

export interface SharedApiConfig {
  vendor: ApiVendor;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** Note left by distributor for recipient, displayed upon import */
  note?: string;
  /** Optional expiration time (millisecond timestamp); rejected on import once expired */
  expiresAt?: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Passphrase normalization.
 *
 * Identifiers are copied by humans from chat windows, so inputs starting with PCM- are corrected:
 * strip separators, unify to uppercase, and fix common handwriting/transcription typos (O→0, I/L→1,
 * U→V; these characters are not in Crockford Base32, so their presence is always a typo).
 *
 * Custom passphrases (not starting with PCM) are used as-is: casing and symbols are significant.
 */
export function normalizePassword(input: string): string {
  const text = String(input ?? "").trim();
  if (!/^PCM/i.test(text)) return text;
  return text
    .toUpperCase()
    .replace(/^PCM/, "")
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt configuration into a long string that can be sent directly to the recipient */
export async function encryptConfig(
  config: SharedApiConfig,
  password: string,
  { iterations = DEFAULT_ITERATIONS }: { iterations?: number } = {},
): Promise<string> {
  const pass = normalizePassword(password);
  if (!pass) throw new Error(tr("Enter the encryption passphrase (the other side's machine ID, or a passphrase you agreed on)"));
  if (!config.apiKey?.trim()) throw new Error(tr("Enter the API key"));

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(pass, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(config));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(AAD) },
      key,
      plaintext,
    ),
  );

  // Write rounds into header: increasing default later still lets old ciphertext decrypt with its own rounds
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, iterations, false);
  const blob = new Uint8Array(header.length + salt.length + iv.length + cipher.length);
  blob.set(header, 0);
  blob.set(salt, header.length);
  blob.set(iv, header.length + salt.length);
  blob.set(cipher, header.length + salt.length + iv.length);
  return PREFIX + base64urlEncode(blob);
}

/** Check if a text resembles our ciphertext (paste box uses it to decide whether to auto-import) */
export function looksLikeShareBlob(text: string): boolean {
  return text.replace(/\s+/g, "").startsWith(PREFIX);
}

/** Decrypt ciphertext. Bad passphrase, modified content, or partial paste all yield the same "cannot decrypt" */
export async function decryptConfig(blob: string, password: string): Promise<SharedApiConfig> {
  // Chat apps insert newlines and spaces into long text; strip them all first
  const text = String(blob ?? "").replace(/\s+/g, "");
  if (!text.startsWith(PREFIX)) throw new Error(tr("This text is not a PromptCut config string (it should start with PCAI1.)"));

  let raw: Uint8Array;
  try {
    raw = base64urlDecode(text.slice(PREFIX.length));
  } catch {
    throw new Error(tr("The string format is wrong, it may not have been copied in full"));
  }
  const minimum = 4 + SALT_BYTES + IV_BYTES + 16; // 16 = GCM auth tag
  if (raw.length < minimum) throw new Error(tr("The string was truncated, ask the other side to resend the full content"));

  const iterations = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false);
  // Do not run rounds from ciphertext if it is large enough to freeze the browser
  if (iterations < 10_000 || iterations > 5_000_000) throw new Error(tr("The string header is abnormal, refusing to parse"));

  const salt = raw.slice(4, 4 + SALT_BYTES);
  const iv = raw.slice(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
  const cipher = raw.slice(4 + SALT_BYTES + IV_BYTES);

  const key = await deriveKey(normalizePassword(password), salt, iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(AAD) },
      key,
      cipher as BufferSource,
    );
  } catch {
    throw new Error(tr("Can't decrypt: the passphrase (machine ID) doesn't match, or the string was modified"));
  }

  let parsed: SharedApiConfig;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error(tr("The string was decrypted, but the content is not a valid config"));
  }
  if (!parsed || typeof parsed !== "object" || !parsed.apiKey) {
    throw new Error(tr("The string was decrypted, but it contains no API key"));
  }
  if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
    throw new Error(tr("This config expired on {0}, ask the distributor for a new one", new Date(parsed.expiresAt).toLocaleDateString()));
  }
  return parsed;
}
