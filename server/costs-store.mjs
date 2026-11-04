/**
 * Local archive of K1 probe records (`out/card-costs.json`).
 *
 * The core storage lives here, while the HTTP surface is in `server/vite-plugin-costs.ts`.
 * Splitting them allows `server/test/costs.test.mjs` to directly test "deduplication by
 * (identityKey, device) / flag preservation" without starting a dev server.
 *
 * # Keys
 *
 * `(identityKey, device)`. `identityKey` already incorporates fps, card parameters, source version,
 * review table, and clip length (`src/render/cardCostKey.mjs`), so only `device` is added here:
 * after switching machines, switching GPUs, or changing shared WebGL routes, the execution time
 * of the same card is completely different and must be re-measured (target K/K1).
 * `device` is calculated on the page side (UA + WebGL `UNMASKED_RENDERER_WEBGL` + only one stage
 * (legacy field name, see `src/render/costDevice.mjs`) / `offscreenGl` / `glRoute`),
 * and the server uses it as an opaque string without parsing it.
 *
 * # Why `demoted` / `pinnedHeavy` must be sticky
 *
 * These two flags are not written by probes: `demoted` is K6 runtime downgrade (accumulated playback
 * timeouts reclassify a light card as a heavy card), and `pinnedHeavy` is manually pinned. When the
 * probe re-tests the same card, the reported record does not contain these two fields at all;
 * overwriting literally would erase downgrade records on every re-test: K1's "skip only if record
 * exists and demoted !== true" would therefore always hit, and downgraded cards would never get new
 * benchmark results. Therefore: **if a new record does not explicitly carry this field, keep the old
 * one**; if explicitly carried (even if `false`), use the new one.
 *
 * # Write strategy
 *
 * Write to a temp file in the same directory first, then rename: the two processes (editor +
 * prerender) each write their own replica, but PUT requests within the same process may be
 * concurrent, and a half-written JSON would cause the next `loadCosts` to read an empty file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveTuning } from '../src/render/pipelineTuning.mjs';

const FILE_NAME = 'card-costs.json';
const TUNING_FILE_NAME = 'pipeline-tuning.json';

/** Where records are saved. During development `dataDir` is `<root>/out`; in release packages PROMPTCUT_DATA_DIR points to %LOCALAPPDATA% */
export function costsDir(root) {
  return process.env.PROMPTCUT_DATA_DIR || path.join(root, 'out');
}
export function costsPath(root) {
  return path.join(costsDir(root), FILE_NAME);
}

/**
 * Override values for K2 adjustable coefficients (`out/pipeline-tuning.json`).
 * **No such file = use all defaults.**
 *
 * Why return via the same path as cost records: `planPipelines` is computed once each in the page
 * and prerender processes; both ends must use **the same coefficients**, otherwise they cannot
 * compute the same table (task brief K2 "Adjustable coefficients"). Since both ends already need
 * to fetch `costs`, opening another endpoint would only introduce an extra window where
 * "one end gets the new coefficients while the other still has the old ones".
 *
 * What is returned is **the clamped** version, not the verbatim text in the file: clamping rules
 * live in `pipelineTuning.mjs`. Clamping once on each end naturally yields the same result,
 * but clamping before sending reduces the possibility that "one end forgets to clamp".
 */
export function tuningPath(root) {
  return path.join(costsDir(root), TUNING_FILE_NAME);
}

/** Read overrides and clamp. Missing / corrupted / non-object files are treated as "no overrides" and return defaults: this should not prevent the editor from starting */
export function loadTuning(root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(tuningPath(root), 'utf8'));
  } catch {
    return resolveTuning(null);
  }
  return resolveTuning(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
}

/**
 * Write overrides (`PUT /api/data/costs/tuning`). R4a only implemented reading: changing
 * coefficients required manually editing this file, and "tuning without modifying code" is only
 * halfway there without a write entry point (task brief K2 "Adjustable coefficients").
 *
 * **What is written to disk is the clamped version**, not the verbatim request payload:
 * `loadTuning` also returns the clamped version. Keeping both sides consistent prevents
 * discrepancies like "file says 100 but returns 4" from failing to reconcile. The write strategy
 * matches cost records: write a temporary file first, then rename (a half-written JSON would
 * cause the next `loadTuning` to read an empty file).
 *
 * Passing `null` (or a non-object) = **clear overrides and use all defaults**: deletes the file
 * rather than writing default values into it. "No such file = use all defaults" is explicitly
 * stated in K2; leaving a file with equivalent values would only make people assume someone
 * tuned it.
 */
export function saveTuning(root, overrides) {
  const file = tuningPath(root);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    try { fs.rmSync(file, { force: true }); } catch { /* If deletion fails, ignore it; the next write will overwrite it */ }
    return resolveTuning(null);
  }
  const tuning = resolveTuning(overrides);
  writeAtomic(file, JSON.stringify(tuning, null, 2));
  return tuning;
}

const keyOf = (record) => `${record.identityKey}\u0000${record.device}`;

/** Must have at least both halves of the key to be saved; remaining fields are handled by the page side, and the server does not validate values */
export function validRecord(record) {
  return !!record && typeof record === 'object'
    && typeof record.identityKey === 'string' && record.identityKey !== ''
    && typeof record.device === 'string' && record.device !== '';
}

/** Flags unknown to the probe that can only be preserved (K6 downgrade / manually pinned) */
export const STICKY_FLAGS = ['demoted', 'pinnedHeavy'];

/** Read all records. Missing / corrupted files are treated as empty tables: re-measuring with the probe will restore them, and it should not prevent the editor from starting */
export function loadCosts(root) {
  let text;
  try {
    text = fs.readFileSync(costsPath(root), 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.costs) ? data.costs : [];
  return list.filter(validRecord);
}

/** Pure-function upsert: applies `incoming` onto `existing` and returns a new table. Does not touch disk, shared between tests and plugins */
export function mergeCosts(existing, incoming) {
  const byKey = new Map();
  for (const record of existing ?? []) if (validRecord(record)) byKey.set(keyOf(record), record);
  let added = 0, updated = 0;
  for (const record of incoming ?? []) {
    if (!validRecord(record)) continue;
    const key = keyOf(record);
    const old = byKey.get(key);
    const next = { ...record };
    if (old) {
      for (const flag of STICKY_FLAGS) {
        if (!Object.prototype.hasOwnProperty.call(record, flag) && Object.prototype.hasOwnProperty.call(old, flag)) next[flag] = old[flag];
      }
      updated++;
    } else {
      added++;
    }
    byKey.set(key, next);
  }
  return { costs: [...byKey.values()], added, updated };
}

/**
 * Back off and retry when rename encounters these errors: on Windows, while the target file is being
 * read by another process (both editor and prerender processes read this cost record), `rename`
 * intermittently hits EPERM / EBUSY / EACCES (verified in T9 round 2 testing: creator writing pinned
 * record hit `EPERM: rename card-costs.json.*.tmp`). Other errors are not retried.
 */
export const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
/** Maximum retry count and per-retry wait (ms, retry n waits n × step; total maximum ~0.9 s) */
export const RENAME_RETRIES = 8;
export const RENAME_BACKOFF_MS = 25;

/** Synchronous short wait: the storage interface is synchronous, only used during rename retries */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.includes(err?.code)) throw err;
      pause(RENAME_BACKOFF_MS * (attempt + 1));
    }
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* Failing to delete the temporary file is not treated as a failure */ }
    throw err;
  }
}

/** Persisted upsert. Returns `{ costs, added, updated, count }` */
export function upsertCosts(root, records) {
  const merged = mergeCosts(loadCosts(root), records);
  writeAtomic(costsPath(root), JSON.stringify({ version: 1, costs: merged.costs }));
  return { ...merged, count: merged.costs.length };
}

/**
 * Filtering for `GET /api/data/costs?device=&mode=`: both conditions are individually optional;
 * if omitted, no filtering is applied (allowing debug and audit scripts to inspect the full table).
 *
 * `mode` (`'dev' | 'build'`, added in R1) records **which kind of server it was measured on**.
 * Task brief 3.1: the desktop app runs directly on the vite dev server and does not read `dist/`
 * at all, so dispatch uses records from the **current runtime mode**: dev apps only look at
 * dev records, while the future online browser mode (build artifacts) will only look at build records.
 * Records before R1 do not have this field; they were all measured in dev mode, so
 * **missing fields are always treated as `'dev'`**.
 *
 * The deduplication key is still only `(identityKey, device)` (see file header), and `mode` is
 * also appended into the `device` string by the probe, so results from both modes occupy separate
 * entries without overwriting each other, retaining both sets.
 */
export function filterCosts(costs, device, mode) {
  let list = costs ?? [];
  if (device) list = list.filter((record) => record.device === device);
  if (mode) list = list.filter((record) => (record.mode ?? 'dev') === mode);
  return list;
}
