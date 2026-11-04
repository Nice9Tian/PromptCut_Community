import { createHash } from 'node:crypto';

/**
 * Render node environment fingerprint and result key (Design 2.1, Contract B.1).
 *
 * Deterministic pixel differences in font hinting and antialiasing across different hardware cause
 * consecutive frames rendered in different environments to flicker when spliced together. Therefore,
 * **do not assume cross-environment interchangeability**: fine-grained task result key = content
 * key × environment fingerprint.
 *
 *   envFingerprint = first 16 hex characters of sha256(`${os}\n${gpuClass}\n${chromeMajor}`)
 *   resultKey      = 64 hex characters of sha256(`${contentKey}\n${envFingerprint}`)
 *
 * Result keys share the same shape as existing shared keys, local tier keys, and stream keys
 * (64-character lowercase hex), requiring no change to routing regexes. Computed once at node startup
 * via `describeEnvironment`, reported in `node.hello`.
 *
 * Pure function: does not read environment variables, does no I/O; missing items are treated as empty
 * values, never throws.
 */

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `process.platform`, normalized name, or platform string reported by page → `windows` | `macos` |
 * `linux` | `other` (case-insensitive).
 *
 * Matches exactly first (`win32` / `windows`, `darwin` / `macos`, `linux`), then supplements three
 * prefix rules (Contract F.2): `win…` → windows, `mac…` → macos, `linux…` → linux. Prefixes are to
 * recognize page `navigator.platform` (`Win32`, `MacIntel`, `Linux x86_64`) and
 * `userAgentData.platform` (`Windows`, `macOS`, `Linux`), so the page and local prerender process
 * compute the same `os` on the same machine.
 */
export function normalizeOs(platform) {
  const name = String(platform ?? '').trim().toLowerCase();
  if (name === 'win32' || name === 'windows') return 'windows';
  if (name === 'darwin' || name === 'macos') return 'macos';
  if (name === 'linux') return 'linux';
  if (name.startsWith('win')) return 'windows';
  if (name.startsWith('mac')) return 'macos';
  if (name.startsWith('linux')) return 'linux';
  return 'other';
}

/*
 * Matching table for basic GPU categories, **order indicates priority**: software rasterization
 * comes first (ANGLE's SwiftShader strings also contain vendor names); unrecognized entries are
 * ultimately treated as `software`: conservative, no hardware acceleration.
 * `ati ` includes a space to avoid false matching words like `corporation`.
 */
const GPU_RULES = [
  ['software', ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render']],
  ['nvidia', ['nvidia', 'geforce', 'quadro', 'rtx']],
  ['amd', ['amd', 'radeon', 'ati ']],
  ['intel', ['intel']],
  ['apple', ['apple']],
];

/**
 * WebGL UNMASKED_RENDERER / UNMASKED_VENDOR → `nvidia` | `amd` | `intel` | `apple` | `software`.
 * Both strings are concatenated with a space and matched together, case-insensitive.
 */
export function gpuClassOf(renderer, vendor) {
  const text = `${renderer ?? ''} ${vendor ?? ''}`.toLowerCase();
  for (const [gpuClass, needles] of GPU_RULES) {
    if (needles.some(needle => text.includes(needle))) return gpuClass;
  }
  return 'software';
}

/**
 * Chrome major version: `'138.0.7204.49'`, `'HeadlessChrome/138.0…'`, full UA, `138` → 138;
 * unparseable → 0. If string contains `Chrome/` / `Chromium/`, take the number following it (full
 * UA starts with `Mozilla/5.0`, so first number cannot be taken); otherwise take first number.
 */
export function chromeMajorOf(version) {
  if (typeof version === 'number') return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
  const text = String(version ?? '');
  const match = /(?:chrome|chromium)\/(\d+)/i.exec(text) ?? /(\d+)/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : 0;
}

/**
 * Whether the UA reported by the page is Chromium-based (M7 Contract D14: Phase 1 only acts as
 * a browser-only node on Chromium-based browsers).
 * `chromeMajorOf` takes the first number for UAs without `Chrome/`; Firefox and Safari both yield 5,
 * colliding fingerprints where frames from two different engines could be spliced into the same layer,
 * so such browsers do not serve as nodes. Recognizes `Chrome/<number>`, `Chromium/<number>`,
 * `HeadlessChrome/<number>` (Chromium derivatives such as Edge and Opera include this); Chrome /
 * Firefox / Edge on iOS (`CriOS`, `FxiOS`, `EdgiOS`) are WebKit, not counted.
 */
export function isChromiumUserAgent(userAgent) {
  const ua = String(userAgent ?? '');
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(ua) || /\bFirefox\//.test(ua)) return false;
  return /\b(?:HeadlessChrome|Chrome|Chromium)\/\d+/.test(ua);
}

/** Environment fingerprint: 16-character lowercase hex. If any of the three items is missing, treated as `''` / `0`. */
export function envFingerprintOf({ os, gpuClass, chromeMajor } = {}) {
  return sha256(`${os ?? ''}\n${gpuClass ?? ''}\n${chromeMajor ?? 0}`).slice(0, 16);
}

/** Computes all at once from raw probed values: `{ os, gpuClass, chromeMajor, fingerprint }`. */
export function describeEnvironment({ platform, renderer, vendor, chromeVersion } = {}) {
  const os = normalizeOs(platform);
  const gpuClass = gpuClassOf(renderer, vendor);
  const chromeMajor = chromeMajorOf(chromeVersion);
  return { os, gpuClass, chromeMajor, fingerprint: envFingerprintOf({ os, gpuClass, chromeMajor }) };
}

/** Result key for fine-grained tasks: content key (shared key / local tier key / stream key) multiplied by environment fingerprint, 64-character lowercase hex. */
export function resultKeyOf(contentKey, envFingerprint) {
  return sha256(`${contentKey ?? ''}\n${envFingerprint ?? ''}`);
}

/**
 * Online card runtime version string (`src/online/cardRuntime/version.ts`, like
 * `ocr1:sucrase@3.35.1:tailwindcss@4.3.3`): raw value reported by page, only safe characters
 * accepted, length is limited; any unqualified value is treated as not reported (→ no
 * `cardEnvFingerprint`, browser node does not claim user cards or media effect cards).
 */
export const CARD_RUNTIME_MAX = 128;
const CARD_RUNTIME_RE = /^[A-Za-z0-9._@:+\-]+$/;
export function cardRuntimeOf(value) {
  if (typeof value !== 'string' || value === '' || value.length > CARD_RUNTIME_MAX || !CARD_RUNTIME_RE.test(value)) return null;
  return value;
}

/**
 * Environment fingerprint for user cards and media effect cards (contract for online execution
 * of user cards and media effect cards `docs/plan/online-card-exec-contract.md` sections 5 and 7,
 * Block N): When a browser-only node executes user cards or media effect cards, the visual output
 * depends not only on the OS, GPU class, and Chrome major version, but also on the transpiler and
 * loading rules in the online page; therefore, in addition to the three items in `envFingerprintOf`,
 * the "online card runtime version" is added to compute the digest.
 *
 *   cardEnvFingerprint = first 16 hex characters of sha256(`${os}\n${gpuClass}\n${chromeMajor}\ncard-runtime:${cardRuntime}`)
 *
 * The trailing line includes the `card-runtime:` prefix, so the plain text for the digest is never
 * the same as `envFingerprintOf` (three lines); thus on the same machine, desktop nodes (which lack
 * this item) and browser nodes will not produce the same result key for user cards and media effect
 * cards. `envFingerprint` and the result keys for built-in cards remain completely unchanged.
 * `cardRuntime` unqualified (`cardRuntimeOf` returns null) returns `null`: without this item, this
 * fingerprint does not exist.
 */
export function cardEnvFingerprintOf({ os, gpuClass, chromeMajor, cardRuntime } = {}) {
  const runtime = cardRuntimeOf(cardRuntime);
  if (runtime === null) return null;
  return sha256(`${os ?? ''}\n${gpuClass ?? ''}\n${chromeMajor ?? 0}\ncard-runtime:${runtime}`).slice(0, 16);
}

/**
 * Computes environment fingerprint for user cards and media effect cards all at once from raw probed
 * values: includes one additional `cardRuntime` beyond `describeEnvironment`; returns
 * `{ os, gpuClass, chromeMajor, fingerprint, cardRuntime, cardEnvFingerprint }` (last two items
 * are `null` when there is no qualified `cardRuntime`).
 */
export function describeCardEnvironment({ platform, renderer, vendor, chromeVersion, cardRuntime } = {}) {
  const env = describeEnvironment({ platform, renderer, vendor, chromeVersion });
  const runtime = cardRuntimeOf(cardRuntime);
  return { ...env, cardRuntime: runtime, cardEnvFingerprint: cardEnvFingerprintOf({ os: env.os, gpuClass: env.gpuClass, chromeMajor: env.chromeMajor, cardRuntime: runtime }) };
}
