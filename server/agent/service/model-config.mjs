/**
 * Model configuration for hosted tier (contract `docs/plan/cloud-agent-contract.md`, Section 8).
 *
 *   <data directory>/config/ai.json           vendor, API URL, model manifest (`a|b|c`), maxTokens
 *                                             (cap of per-output limit; 0 or omitted = by model),
 *                                             0600
 *   <data directory>/config/keys/custom.key   ciphertext of model Key (PCENC1 wrapper from
 *                                             `server/runners/config-crypt.mjs`), 0600
 *
 * Paths are determined solely by the data directory; does not read `PROMPTCUT_AI_CONFIG` and does
 * not read the user's own `ai.json` on this machine: when the desktop app is installed on the same
 * machine, the two sides remain completely independent.
 * Plaintext of Key exists only in caller memory; this file never prints it or writes it to any
 * other file. Read fresh at the start of each round, so no service restart is needed after entering
 * or changing Key.
 * This file does not reference `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openKey, sealKey, sealedKind } from '../../runners/config-crypt.mjs';
export const RUN_EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const RUN_CREATIVITY = Object.freeze(['low', 'medium', 'high']);
const RUN_OPTION_KEYS = ['model', 'effort', 'creativity'];
export const RUN_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function defaultNormalizeRunOptions(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !RUN_OPTION_KEYS.includes(key))) return undefined;
  const out = {};
  for (const key of RUN_OPTION_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const ok = key === 'model' ? typeof value === 'string' && RUN_MODEL_ID_RE.test(value)
      : key === 'effort' ? RUN_EFFORTS.includes(value) : RUN_CREATIVITY.includes(value);
    if (!ok) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

let customRunOptionsPolicy = null;
export function registerRunOptionsPolicy(fn) {
  customRunOptionsPolicy = typeof fn === 'function' ? fn : null;
}

export function normalizeRunOptions(raw) {
  return customRunOptionsPolicy ? customRunOptionsPolicy(raw) : defaultNormalizeRunOptions(raw);
}

export const MODEL_VENDORS = Object.freeze(['anthropic', 'openai', 'gemini', 'mock']);

export function modelConfigPaths(dataDir) {
  const dir = path.join(dataDir, 'config');
  return { dir, file: path.join(dir, 'ai.json'), keyFile: path.join(dir, 'keys', 'custom.key') };
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Basically a no-op on Windows */ }
  fs.renameSync(tmp, file);
}

/**
 * Read the model configuration used for this round. Returns `{}` if there is no config file;
 * `apiKey` is an empty string when the Key file is missing or cannot be decrypted.
 * @returns {{ vendor?: string, baseUrl?: string, model?: string, maxTokens?: number, apiKey?: string }}
 */
export function readModelConfig(dataDir) {
  const { file, keyFile } = modelConfigPaths(dataDir);
  let api = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    api = parsed && typeof parsed === 'object' && parsed.api && typeof parsed.api === 'object' ? parsed.api : null;
  } catch {
    return {};
  }
  if (!api || !MODEL_VENDORS.includes(api.vendor)) return {};
  let apiKey = '';
  if (api.vendor !== 'mock') {
    try {
      const sealed = fs.readFileSync(keyFile, 'utf8').trim();
      if (sealedKind(sealed) === 'custom') apiKey = openKey(sealed, 'custom') || '';
    } catch { /* Not yet entered */ }
  }
  return {
    vendor: api.vendor,
    baseUrl: typeof api.baseUrl === 'string' ? api.baseUrl : '',
    model: typeof api.model === 'string' ? api.model : '',
    // 0 = not configured; per-output limit is determined by the model (harness/model-limits.mjs, A07 2026-10-22); if configured, it is the cap of the cap
    maxTokens: Number.isSafeInteger(api.maxTokens) && api.maxTokens > 0 ? api.maxTokens : 0,
    apiKey,
  };
}

/** Write configuration; if `key` is provided (non-empty string), wrap and write it to the Key file; `null` means do not touch the Key file */
export function writeModelConfig(dataDir, { vendor, baseUrl = '', model = '', maxTokens = 0 }, key = null) {
  if (!MODEL_VENDORS.includes(vendor)) throw new Error(`Vendor must be one of ${MODEL_VENDORS.join(' / ')}`);
  const { file, keyFile } = modelConfigPaths(dataDir);
  if (typeof key === 'string' && key) writePrivate(keyFile, `${sealKey(key, 'custom')}\n`);
  writePrivate(file, `${JSON.stringify({ v: 1, api: { vendor, baseUrl: String(baseUrl || ''), model: String(model || ''), maxTokens } }, null, 2)}\n`);
}

/** Delete the Key file (keep the configuration) */
export function clearModelKey(dataDir) {
  try { fs.rmSync(modelConfigPaths(dataDir).keyFile, { force: true }); } catch { /* Did not exist in the first place */ }
}

/** Model manifest (`a|b|c` split) */
export function modelListOf(cfg) {
  return String(cfg?.model || '').split('|').map((s) => s.trim()).filter(Boolean);
}

/** Which model will actually be used for this round (same selection policy as `server/runners/api.mjs`: use it if requested and in manifest, otherwise the first in manifest) */
export function pickModel(cfg, asked) {
  const list = modelListOf(cfg);
  return typeof asked === 'string' && list.includes(asked) ? asked : (list[0] || '');
}

/** Whether a round can be started: mock provider does not require Key, others do */
export function modelReady(cfg) {
  if (!cfg || !MODEL_VENDORS.includes(cfg.vendor)) return false;
  return cfg.vendor === 'mock' || !!cfg.apiKey;
}

/** The portion exposed to the page (`GET /v1/info`): excludes URL and Key. `efforts` is clickable thinking effort on the page (excluding "default") */
export function publicModelInfo(cfg, configured = modelReady(cfg)) {
  const models = modelListOf(cfg);
  return { models, defaultModel: models[0] ?? null, configured, efforts: [...RUN_EFFORTS], ...(cfg?.vendor === 'mock' ? { mock: true } : {}) };
}

/**
 * Same as `publicModelInfo(readModelConfig(dir))`, but does not decrypt Key: used by the main
 * service in account mode when reporting `GET /v1/info`.
 * For Key, only checks whether the file exists without opening it (main service does not need
 * plaintext of Key; whether it can be decrypted is reported as `no-model-key` by the task process
 * when starting a round).
 */
export function readPublicModelInfo(dataDir) {
  const { file, keyFile } = modelConfigPaths(dataDir);
  let api = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    api = parsed && typeof parsed === 'object' && parsed.api && typeof parsed.api === 'object' ? parsed.api : null;
  } catch { /* Not yet configured */ }
  if (!api || !MODEL_VENDORS.includes(api.vendor)) return publicModelInfo({}, false);
  const cfg = { vendor: api.vendor, model: typeof api.model === 'string' ? api.model : '' };
  return publicModelInfo(cfg, api.vendor === 'mock' || fs.existsSync(keyFile));
}
