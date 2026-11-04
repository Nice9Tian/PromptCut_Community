import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sealKey, openKey, sealedKind, KEY_KINDS, SECRET_KINDS } from './runners/config-crypt.mjs';
import { tr } from './i18n.mjs';

/**
 * AI configuration (ai.json) + two key files.
 *
 * API keys are **no longer written in ai.json**; instead, each is stored in its own file in the
 * same directory as ai.json:
 *   keys/custom.key: Key filled in by the user in "Custom API", the PCENC1. wrapper scheme
 *   keys/router.key: Key imported via "PromptCut Router" distribution string, the PCRTR1. wrapper scheme
 * The two paths have different auth tags, AAD, and prefixes; decrypting with the wrong path yields
 * an empty string, preventing accidental mix-ups. `api.source` in ai.json records **which path is
 * currently active** ("custom" / "router" / ""); in-process `api.apiKey` is always the decrypted
 * plaintext of the currently active path, so downstream (providers, publicConfig) needs no changes.
 *
 * "Clear key" in the settings window deletes the corresponding file (clearKey); if the deleted
 * key is the currently active path, source is cleared as well, equivalent to "no key set".
 *
 * Older versions wrote ciphertext directly into api.apiKey in ai.json: when encountered, treat it
 * as the custom path, move it to keys/custom.key on the next config write, and leave nothing in ai.json.
 */

function getConfigPath() {
  if (process.env.PROMPTCUT_AI_CONFIG) {
    return process.env.PROMPTCUT_AI_CONFIG;
  }
  const appData = process.env.LOCALAPPDATA || os.homedir();
  return path.join(appData, 'promptcut', 'ai.json');
}

/** File path for a given key path (aside from the two chat paths, individual feature keys are also stored here; see readSecret at the end of the file) */
export function keyFilePath(kind) {
  if (!SECRET_KINDS.includes(kind)) throw new Error(tr("Key type must be one of {0}", SECRET_KINDS.join(' / ')));
  return path.join(path.dirname(getConfigPath()), 'keys', `${kind}.key`);
}

function readKeyFile(kind) {
  try {
    const sealed = fs.readFileSync(keyFilePath(kind), 'utf8').trim();
    // The file must contain ciphertext for **this path**; plaintext or ciphertext from the other path is not accepted
    if (sealedKind(sealed) !== kind) return '';
    return openKey(sealed, kind);
  } catch {
    return '';
  }
}

function writeKeyFile(kind, plain) {
  const file = keyFilePath(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600: the passphrase for the ciphertext is the **local** machine code; another user on the
  // same machine could deduce it, so do not let them read the ciphertext.
  // The mode of writeFileSync only takes effect on creation; existing files need an additional chmod.
  // (chmod is basically a no-op on Windows; this step is for POSIX.)
  fs.writeFileSync(file, sealKey(plain, kind) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / insufficient permissions, does not affect functionality */ }
}

function getDefaults() {
  return {
    version: 1,
    defaultProvider: null,
    toolProtocol: false,
    /**
     * Maximum number of model round-trips in a single run when "deep autonomy" is enabled. **0 = unlimited**,
     * in which case it only stops if the user clicks stop, the model finalizes on its own, or repeated
     * operation detection intercepts it. When deep autonomy is disabled, this value has no effect,
     * falling back to each path's own standard limit (harness 48 rounds / text protocol 8 rounds).
     */
    deepAutoRounds: 300,
    /**
     * Quota circuit breaker for CLI drivers (Claude Code / Codex): aborts this path once any usage
     * window reaches thresholdPercent; re-checks in the background for every additional checkEveryBytes
     * bytes of context. See server/runners/quota.mjs.
     */
    quota: { enabled: true, thresholdPercent: 80, checkEveryBytes: 262144 },
    api: {
      vendor: 'anthropic',
      baseUrl: '',
      apiKey: '',
      /** Which path the currently active Key comes from: custom / router / "" (not set) */
      source: '',
      model: '',
      /** Cap on the single-output limit; 0 = use the model's maximum limit (user decision, 2026-10-22, "default to maximum", `server/harness/model-limits.mjs`) */
      maxTokens: 0,
      /**
       * Connection configurations for each of the two paths: custom API manually entered, and imported
       * via Router distribution string. Previously there was only one copy of vendor / baseUrl / model;
       * importing Router would overwrite manually entered values, and vice versa; now each is stored
       * separately. The three fields above mirror the **currently active path** (synchronized on each
       * readConfig), and downstream (runner, panel model selector) still reads api.model. model uses |
       * to separate multiple choices.
       */
      profiles: {
        custom: { vendor: 'anthropic', baseUrl: '', model: '' },
        router: { vendor: 'anthropic', baseUrl: '', model: '' },
      },
    },
    // Available model list for each of the three CLIs, same convention as api.model: separated by |.
    // The model selector on the panel reads from here; if left empty, only the "Default" item exists.
    cliModels: {
      claude: 'opus|sonnet|haiku',
      codex: 'gpt-5.6-terra|gpt-5.6-sol',
      agy: ''
    }
  };
}

/** Raw ai.json on disk (with default values merged), Key field is not decrypted */
function readRaw() {
  const p = getConfigPath();
  const defs = getDefaults();
  try {
    if (!fs.existsSync(p)) return defs;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = deepMerge(defs, parsed, true);
    // Old configs saved Codex model list as empty string; fill presets on read so existing installs see them.
    if (!String(parsed?.cliModels?.codex ?? '').trim()) {
      merged.cliModels.codex = defs.cliModels.codex;
    }
    if (!merged.api || typeof merged.api !== 'object' || Array.isArray(merged.api)) {
      merged.api = defs.api;
    }
    /*
     * profiles must also have a type check fallback, and each path must be guarded individually.
     *
     * The principle of this file is "never 500 even if ai.json cannot be parsed": the try/catch
     * above catches JSON parsing. But when profiles is written as null, an array, or missing either
     * router or custom, the JSON is valid, crashing later: in syncProfile, `cfg.api.profiles[face]`
     * evaluates to undefined, and reading `prof.model` on the next line throws a TypeError, which is
     * already outside this try block: the result is the entire AI settings API returns 500, and users
     * do not even get a chance to go in and fix the configuration. Manually editing ai.json or upgrading
     * from older versions could both encounter this.
     */
    const profs = merged.api.profiles;
    if (!profs || typeof profs !== 'object' || Array.isArray(profs)) {
      merged.api.profiles = deepMerge(defs.api.profiles, {}, true);
    } else {
      for (const face of ['router', 'custom']) {
        const one = profs[face];
        if (!one || typeof one !== 'object' || Array.isArray(one)) profs[face] = { ...defs.api.profiles[face] };
      }
    }
    // Whether source was ever written: after clearing keys, persist writes "", which is "truly not set";
    // older versions of ai.json had no such field at all, and only then is scanning both path files allowed.
    merged.api.hasSource = typeof parsed?.api?.source === 'string';
    if (!KEY_KINDS.includes(merged.api.source)) merged.api.source = '';
    return merged;
  } catch {
    return defs;
  }
}

/** Legacy Key in ai.json (from older versions). Only recognizes ciphertext or plaintext for the custom path */
function legacyKey(raw) {
  const v = raw.api.apiKey;
  if (!v || typeof v !== 'string') return '';
  const kind = sealedKind(v);
  if (kind && kind !== 'custom') return '';
  return openKey(v, 'custom');
}

export function readConfig() {
  const cfg = readRaw();
  let source = cfg.api.source;
  let key = source ? readKeyFile(source) : '';
  if (!key) {
    // No file (or file does not match this path): check if ai.json has one left over from older versions
    const legacy = legacyKey(cfg);
    if (legacy) { key = legacy; source = 'custom'; }
    else if (!source && !cfg.api.hasSource) {
      // source was never written, but a file for one path exists: custom takes priority (user-entered one)
      for (const kind of KEY_KINDS) {
        const k = readKeyFile(kind);
        if (k) { key = k; source = kind; break; }
      }
    }
  }
  // Persisted to disk is ciphertext, plaintext in-process: downstream (providers, publicConfig) needs no change
  cfg.api.apiKey = key;
  cfg.api.source = key ? source : '';
  delete cfg.api.hasSource;
  syncProfile(cfg);
  return cfg;
}

const PROFILE_FIELDS = ['vendor', 'baseUrl', 'model'];

/**
 * Set api.vendor / baseUrl / model to the profile of the currently active path.
 * Older versions of ai.json had no profiles: those three fields were the only copy. Move them
 * into the current path first (treated as custom if no Key is set), then mirror them back:
 * not a single character of old configurations is lost.
 */
function syncProfile(cfg) {
  const face = cfg.api.source === 'router' ? 'router' : 'custom';
  const prof = cfg.api.profiles[face];
  const empty = !prof.model && !prof.baseUrl && prof.vendor === 'anthropic';
  if (empty && (cfg.api.model || cfg.api.baseUrl || cfg.api.vendor !== 'anthropic')) {
    for (const k of PROFILE_FIELDS) prof[k] = cfg.api[k];
  }
  for (const k of PROFILE_FIELDS) cfg.api[k] = prof[k];
}

function checkProfilePatch(patch, where) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(tr("{0} must be an object", where));
  if (patch.vendor !== undefined && !['anthropic', 'openai', 'gemini'].includes(patch.vendor)) throw new Error(tr("vendor must be anthropic / openai / gemini"));
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string') throw new Error(tr("{0}.baseUrl must be a string", where));
    if (patch.baseUrl !== '' && !patch.baseUrl.startsWith('http://') && !patch.baseUrl.startsWith('https://')) throw new Error(tr("baseUrl must be an http(s) address or empty"));
  }
  if (patch.model !== undefined && typeof patch.model !== 'string') throw new Error(tr("{0}.model must be a string", where));
}

function deepMerge(target, source, reading = false) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in target) && !reading) {
      continue;
    }
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key], reading);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** Write in-memory configuration back to ai.json (Key is not included, only source is kept) */
function persist(cfg) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const onDisk = { ...cfg, api: { ...cfg.api } };
  delete onDisk.api.apiKey;
  fs.writeFileSync(p, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows / insufficient permissions, does not affect functionality */ }
}

export function writeConfig(partial) {
  const current = readConfig();
  const newConfig = deepMerge(current, partial, false);

  /*
   * Connection configurations are stored in two paths. Top-level vendor / baseUrl / model
   * (legacy style) are written to the **target path**: with source, it is that path (Router imports
   * go here); without source, it is the currently active path; if no Key is set, it counts as custom.
   * Explicitly provided profiles.custom / profiles.router are written independently, unaffected
   * by source: both the Custom tab and Router tab in the settings window use this format without
   * overwriting each other.
   */
  if (partial.api) {
    const legacy = {};
    for (const k of PROFILE_FIELDS) if (partial.api[k] !== undefined) legacy[k] = partial.api[k];
    if (Object.keys(legacy).length) {
      checkProfilePatch(legacy, 'api');
      const targetSource = partial.api.source !== undefined && partial.api.source !== '' ? partial.api.source : current.api.source;
      const face = targetSource === 'router' ? 'router' : 'custom';
      Object.assign(newConfig.api.profiles[face], legacy);
    }
    if (partial.api.profiles !== undefined) {
      const incoming = partial.api.profiles;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error(tr("api.profiles must be an object"));
      for (const face of KEY_KINDS) {
        if (incoming[face] === undefined) continue;
        checkProfilePatch(incoming[face], `api.profiles.${face}`);
        for (const k of PROFILE_FIELDS) if (incoming[face][k] !== undefined) newConfig.api.profiles[face][k] = incoming[face][k];
      }
    }
  }

  if (partial.defaultProvider !== undefined) {
    if (!['claude', 'agy', 'codex', 'api', null].includes(partial.defaultProvider)) {
      throw new Error(tr("defaultProvider must be claude, agy, codex, api or null"));
    }
    newConfig.defaultProvider = partial.defaultProvider;
  }

  /*
   * Three ways to specify Key:
   *   apiKey: "…"   writes to path specified by source (custom if omitted), and switches to that path;
   *   apiKey: null  clears the currently active path (file is deleted as well);
   *   apiKey: "" / missing Key leaves it unchanged, only allowing switching source alone
   *                 (that path must have a file).
   */
  let source = current.api.source;
  let key = current.api.apiKey;
  const wantSource = partial.api && partial.api.source !== undefined ? partial.api.source : undefined;
  if (wantSource !== undefined && wantSource !== '' && !KEY_KINDS.includes(wantSource)) {
    throw new Error(tr("api.source must be one of {0}", KEY_KINDS.join(' / ')));
  }
  if (partial.api && partial.api.apiKey !== undefined) {
    if (partial.api.apiKey === null) {
      if (source) removeKeyFile(source);
      key = ''; source = '';
    } else if (partial.api.apiKey !== '') {
      const kind = wantSource || 'custom';
      if (typeof partial.api.apiKey !== 'string') throw new Error(tr("apiKey must be a string"));
      writeKeyFile(kind, partial.api.apiKey);
      key = partial.api.apiKey; source = kind;
    }
  } else if (wantSource !== undefined && wantSource !== source) {
    const k = wantSource ? readKeyFile(wantSource) : '';
    if (wantSource && !k) throw new Error(tr("No key has been saved for {0} yet", wantSource));
    key = k; source = wantSource;
  }
  // Key left in ai.json from older versions: move into the file, no longer kept in ai.json
  if (source === 'custom' && key && !fs.existsSync(keyFilePath('custom'))) writeKeyFile('custom', key);
  newConfig.api.apiKey = key;
  newConfig.api.source = key ? source : '';

  if (partial.api && partial.api.maxTokens !== undefined) {
    const val = parseInt(partial.api.maxTokens, 10);
    if (!isNaN(val) && val > 0) {
      newConfig.api.maxTokens = val;
    } else {
      newConfig.api.maxTokens = current.api.maxTokens;
    }
  }

  if (partial.cliModels !== undefined) {
    const incoming = partial.cliModels;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new Error(tr("cliModels must be an object"));
    }
    for (const key of ['claude', 'codex', 'agy']) {
      if (incoming[key] === undefined) continue;
      if (typeof incoming[key] !== 'string') throw new Error(tr("cliModels.{0} must be a string", key));
      newConfig.cliModels[key] = incoming[key];
    }
  }

  if (partial.toolProtocol !== undefined) {
    newConfig.toolProtocol = !!partial.toolProtocol;
  }

  if (partial.deepAutoRounds !== undefined) {
    const v = Number(partial.deepAutoRounds);
    // 0 means "unlimited", which is a valid value, so the lower bound is 0 instead of 1. The upper bound
    // of 100000 is only to prevent slips; reaching that would have been stopped by duplicate operation
    // detection or the user.
    if (!Number.isFinite(v) || v < 0 || v > 100000) throw new Error(tr("deepAutoRounds must be an integer from 0 to 100000 (0 = unlimited rounds)"));
    newConfig.deepAutoRounds = Math.round(v);
  }

  if (partial.quota !== undefined) {
    const q = partial.quota;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error(tr("quota must be an object"));
    const next = { ...(newConfig.quota || {}) };
    if (q.enabled !== undefined) next.enabled = !!q.enabled;
    if (q.thresholdPercent !== undefined) {
      const v = Number(q.thresholdPercent);
      if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error(tr("quota.thresholdPercent must be a percentage from 1 to 100"));
      next.thresholdPercent = Math.round(v);
    }
    if (q.checkEveryBytes !== undefined) {
      const v = Number(q.checkEveryBytes);
      if (!Number.isFinite(v) || v < 16384) throw new Error(tr("quota.checkEveryBytes must be at least 16384 (16KB)"));
      next.checkEveryBytes = Math.round(v);
    }
    newConfig.quota = next;
  }

  // The top-level three fields follow the currently active path
  syncProfile(newConfig);
  persist(newConfig);
  return newConfig;
}

function removeKeyFile(kind) {
  try { fs.rmSync(keyFilePath(kind), { force: true }); } catch { /* Ignore if absent */ }
}

/**
 * "Clear keys": delete the key file for a path. If the deleted one happens to be the currently
 * active path, the configuration falls back to "Key not set". Any Key left in ai.json from older
 * versions is also wiped (when clearing custom); otherwise it would reappear when read back.
 */
export function clearKey(kind) {
  if (!KEY_KINDS.includes(kind)) throw new Error(tr("Key type must be one of {0}", KEY_KINDS.join(' / ')));
  const cfg = readConfig();
  removeKeyFile(kind);
  if (cfg.api.source === kind) { cfg.api.apiKey = ''; cfg.api.source = ''; }
  persist(cfg);
  return cfg;
}

/** Whether a path has a Key stored (prefix can be checked without decrypting, but also verifies if it decrypts) */
function keyState(kind) {
  const k = readKeyFile(kind);
  return { set: k.length > 0, last4: k.length >= 4 ? k.slice(-4) : '' };
}

export function publicConfig() {
  const cfg = readConfig();
  const apiKey = cfg.api.apiKey || '';
  cfg.api.apiKey = {
    set: apiKey.length > 0,
    last4: apiKey.length >= 4 ? apiKey.slice(-4) : ''
  };
  // Status of each path: Router and Custom tabs in settings window display independently without interference
  cfg.keys = { custom: keyState('custom'), router: keyState('router') };
  // When legacy Keys are still in ai.json and not yet moved: the custom tab must also see them
  if (cfg.api.source === 'custom' && !cfg.keys.custom.set) cfg.keys.custom = { ...cfg.api.apiKey };
  return cfg;
}

/*
 * Keys for other features (such as voiceover API Key) also follow this pattern: stored in
 * keys/<kind>.key just like chat API keys, also 0600, also wrapped with config-crypt, and treated
 * as not set if the prefix does not match. Each uses its own kind and cannot decrypt each other;
 * they are not chat sources, do not enter api.source, and clearKey does not touch them.
 */
export function readSecret(kind) {
  return readKeyFile(kind);
}

export function writeSecret(kind, plain) {
  writeKeyFile(kind, plain);
}

export function removeSecret(kind) {
  removeKeyFile(kind);
}

/**
 * The address entered for the chat API "custom" path extracts only protocol + host
 * (https://example.com/v1 → https://example.com). Other endpoints under the same API (such as
 * voiceover's /minimax/v1/…) use this as default when no address is specified. Reads raw
 * configuration without decrypting Key.
 */
export function apiOrigin() {
  const raw = readRaw();
  const u = raw.api?.profiles?.custom?.baseUrl || raw.api?.baseUrl || '';
  try { return u ? new URL(u).origin : ''; } catch { return ''; }
}
