/**
 * For testing only; production code must not reference this.
 *
 * Common kit for C10 contract tests (`server/test/c10-*.test.mjs`). Based solely on
 * `docs/plan/c10-contract.md` v1 (sections 2-12) and the semantics it references; the test authors
 * did not inspect the implementation (`claude/c10-browser`, `claude/c10-ui`, plus C10a and HT-a
 * not yet merged into main).
 *
 * All module paths, function names, parameters, and response shapes not fixed by the contract are
 * centralized in this file; when reconciling during integration, only this file is modified, never
 * the test assertions. Each assumption is labeled as "Assumption K<n>", and listed under the same
 * numbers in the report `docs/archive/agent-reports/AGENT-c10-tests.md`.
 *
 * # What to do when an implementation is absent (gates)
 *
 * At the start of each test suite, `*Gate()` in this file statically checks whether the interface
 * exists (reads source files, looks for `export` names, without importing): if absent, marks the
 * suite as `node:test` skip, stating "which file does not exist, which name did not appear" as the
 * reason.
 * Gates only check "whether the implementation exists", not "whether the implementation is
 * correct": once the name appears, the test case actually runs, and fails directly if shapes do not
 * match (reconciled by the integrator modifying this file), never silently skipped. Therefore,
 * before C10 integration, `npm test` skip counts will include these extra skips; after C10
 * integration, all these gates must be open (skip counts return to the pre-integration baseline).
 *
 * # Assumptions
 *
 *   K1  General: The `.ts` modules under test are imported in Node via the resolution hooks in
 *       `src/testing/registerTs.mjs` (matching existing unit tests), so these modules must not touch
 *       `window` or `document` upon import (if touched, make the dependency lazy). Gates rely on
 *       statically finding `export` names: `export function|const|let|class|async function <name>`
 *       or `export { … <name> … }`; any name matching the candidate list is accepted.
 *
 *   K2  In-page snapshot store L2 (contract section 4):
 *       - File is the first existing one from `L2_FILES`; open function is one of `L2_OPEN_NAMES`,
 *         invoked as `await open(opts)`,
 *         `opts = { indexedDB, deviceMemory, estimate, now }` (as of 2026-10-22, soft limits are
 *         allocated based on the environment, and the previous tier parameter was removed):
 *         `indexedDB` is the factory (tests pass an in-memory stub, also installed onto globals),
 *         `estimate` is `() => Promise<{ quota, usage }>` (also installed as
 *         `navigator.storage.estimate`), and `now` is a millisecond clock;
 *       - Methods on the returned object (names picked from candidates, see `L2_METHODS`):
 *         `putBlock(key, bytes, type)` (`key` shaped like `snap/<hash>` or `px/<hash>`, `bytes` is
 *         Uint8Array), `getBlock(key)` (returns `{ bytes, type }`, raw bytes directly, or
 *         `undefined` / `null`), `putCost(key, record)`, `getCost(key)`,
 *         `putRange(layerKey, from, to)`, `subscribe(cb)` (invoked immediately on write to `ranges`;
 *         returns unsubscribe function), `close()` (optional); async methods return Promises;
 *       - Chunks in the store can be recognized: records in the `snapshots` store have some string
 *         field in their key or value equal to `putBlock`'s `key`;
 *       - The two soft limit values (256 MiB, 64 MiB) are exported from the L2 module as numeric
 *         constants (unrestricted names, may be wrapped in an object).
 *   K3  Frame swap per tick (contract section 6):
 *       - `SWAP_MS` (= 3) is exported from one of `BEAT_FILES`; from the same file set, a pure
 *         function is exported (name chosen from `BEAT_FIT_NAMES`),
 *         `fn({ fps, occupiedMs, layers, swapMs })` → `{ swap: string[], placeholder: string[] }`
 *         (also accepts `swapped` / `placeholders`), where `swapMs` defaults to `SWAP_MS`; can
 *         additionally take `deadMs` (tick duration or budget minus occupied time);
 *       - `src/editor/snapshotFeed.ts` exports a switch (name chosen from `BEAT_SWITCH_NAMES`),
 *         where after `switch(true)` delivery during playback is not throttled to 33 ms, but
 *         remains throttled while paused; `switch(false)` (desktop) behaves as before. Gate:
 *         `SWAP_MS` appears.
 *   K4  Layer table (contract section 5): one of `LAYER_FILES` exports a pure function (name
 *       chosen from `LAYER_REF_NAMES`), `fn(table, clipId)`:
 *       Layer table has the shape
 *       `{ v: 2, kind: 'layer-map', layers: [{ clipId, kind, key, resultKey, firstFrame, count, contentKey, envFingerprint, … }] }`
 *       (`layerEntry` / `layerTable`, updated during integration to match the actual shape of
 *       `layerMapOf`);
 *       on a match, returns an object containing at least `contentKey` and `envFingerprint`
 *       (identical to the layer table record); on mismatch (missing content key, missing
 *       fingerprint, corrupted layer table, missing layer), returns `null` / `undefined` without
 *       throwing.
 *   K5  Runtime config for two stages (contract section 2): one of `STAGE_FILES` exports
 *       - Parser function (one of `STAGE_PARSE_NAMES`): `fn(config)`, where `config` is the parsed
 *         object `{ stageOrigins: [origin A, origin B] }` from `/editor/` runtime config or its
 *         JSON string; returns `{ A, B }` (also accepts a two-element array), or `null` if
 *         unreadable or invalid, without throwing;
 *       - Decision function (one of `STAGE_DECIDE_NAMES`): `fn({ single, origins, handshake })`
 *         (as of 2026-10-22, `single` = stage gate stopped at the first level, previously tier),
 *         where `handshake` is `'ok' | 'failed'`; returns `'dual' | 'single'` (also accepts boolean:
 *         true = dual stage).
 *   K6  Page publishing plan (contract section 7): one of `PLAN_FILES` exports a factory (one of
 *       `PLAN_FACTORY_NAMES`), `factory({ endpoint, debounceMs? })`, where `endpoint` matches the
 *       `createWsEndpoint` shape (`send(msg) → boolean`, `onMessage(handler)`);
 *       methods on the returned object include `measured({ projectId, projectRev })` (measurement
 *       settled), `changed({ projectId, projectRev })` (project changed), and `dispose()`, with
 *       names picked from candidates (`PLAN_METHODS`). Debouncing uses global `setTimeout` (tests
 *       use `mock.timers` to advance time).
 *       Outbound messages are render queue `task.publish` (recognized by `parseInbound` in
 *       `server/render-queue/messages.mjs`), `tasks[0]` is `plan`, and the portion of `resultKey`
 *       before `#clips:` is `<projectId>@<projectRev>` (integration reconciliation: page sends
 *       manifest plan, factory also receives `clips`, checks in before publishing; see
 *       `planFactoryDeps`).
 *   K7  User cards and media effect cards (contract section 9, user changed semantics, 2026-09-29):
 *       the online toggle reuses `setOnlineBrowserMode(true)` from
 *       `src/render/placeholderHost.ts`; user cards = registry `isUserCardId` (cards present in
 *       `userCardSources().fileOf`, or cards synced via `setSyncedUserCards`), media effect
 *       cards = definition has `card` as a function (same check as `unsupportedHere`); when online,
 *       `planFeed` in `snapshotFeed.ts` treats them all as heavy cards, selecting frames and
 *       reporting gaps as usual, and `deliverSnapshots` retrieves bytes as usual; paused state
 *       "exact" does not hold for them. Gate: C10-UI copy appears (K8).
 *   K8  Grayed-out and offline copy (contract section 10, section 17 table A): copy is written as
 *       literals in non-test source files under `src/` (the grayed-out template is searched in two
 *       parts: "Online browser mode is not currently supported" and ", please use PromptCut on
 *       your computer."). Gate: any of `C10_UI_MARKERS` appears.
 *   K9  `/api` ratchet (contract section 10): manifest file
 *       `server/test/c10a-online-api-paths.json` (the C10a approach), shaped like
 *       `{ paths: [...] }`; baseline is `server/test/c10-api-ratchet-baseline.json` (copied from
 *       `claude/c10a-integ@5b2fccc`). Gate: manifest file exists.
 *   K10 Offline backup (contract section 10): one of `BACKUP_FILES` exports a factory (one of
 *       `BACKUP_FACTORY_NAMES`), `factory({ download })`, where `download(filename, text)` is
 *       optional; methods on the returned object include `save(backup)`, `list()`, and
 *       `download(index)` (names picked from `BACKUP_METHODS`). Downloads go through the
 *       `download` callback, or through `document.createElement('a')` +
 *       `URL.createObjectURL(blob)` + `click()`, both accepted. `backup` is `LocalBackup` from
 *       `src/store/docsync.ts`.
 *   K11 L5 merge distribution (contract section 11): handled by `assetServiceMiddleware` in
 *       `server/asset-service.ts`, path `/api/asset/merge/<projectId>/<sharedKey>` (under asset
 *       service base `…/api/asset`). Gate: `merge` appears in the source file.
 *   K12 Per-frame export ticket renewal (contract section 12): one of `RENEW_FILES` exports a
 *       factory (one of `RENEW_FACTORY_NAMES`), `factory({ fetchTicket, now })`, where
 *       `fetchTicket()` returns `Promise<{ ticket, exp } | null>` (`exp` millisecond timestamp);
 *       methods on the returned object include `start()` (fetches the first ticket, returns
 *       Promise), `ticket()` (synchronously returns current ticket), and `stop()`; early renewal
 *       based on time limits uses global `setTimeout`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));
export const MiB = 1024 * 1024;

/** Installs `.ts` resolution hooks (K1). Repeated calls are harmless */
let tsHook = null;
export function useTs() {
  tsHook ??= import(repoUrl('src/testing/registerTs.mjs'));
  return tsHook;
}
export async function importRepo(rel) {
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) await useTs();
  return import(repoUrl(rel));
}

/* ------------------------------------------------------------------ Statically find exports (K1) */

const exportCache = new Map();
/** Statically exported names of a source file */
export function staticExports(rel) {
  if (exportCache.has(rel)) return exportCache.get(rel);
  let names = new Set();
  if (exists(rel)) {
    const src = fs.readFileSync(repoPath(rel), 'utf8');
    for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const seg = part.trim().replace(/^type\s+/, '');
        if (!seg) continue;
        const as = seg.split(/\s+as\s+/);
        names.add((as[1] ?? as[0]).trim());
      }
    }
  }
  exportCache.set(rel, names);
  return names;
}

/** Find first file in a set exporting one of candidate names: returns `{ file, name }` or null */
export function findExport(files, names) {
  for (const file of files) {
    const got = staticExports(file);
    for (const name of names) if (got.has(name)) return { file, name };
  }
  return null;
}

/** First candidate name that is a function on the object */
export function pickMethod(obj, names) {
  for (const n of names) if (obj && typeof obj[n] === 'function') return n;
  return null;
}

/** Skip reason: which file, which name (task brief "state the reason") */
export function missingWhat(files, names) {
  const present = files.filter(exists);
  const fileText = present.length ? `File ${present.join(', ')} exists, but` : `Files ${files.join(', ')} do not exist,`;
  return `${fileText} none of ${names.join(' / ')} is exported`;
}
export const skipReason = (what) => `Interface missing: ${what} (C10 implementation not integrated; becomes a real run automatically once integrated)`;

/** Non-test `src/` source files (`.ts`, `.tsx`, `.mjs`, `.js`), cached once */
let srcFilesCache = null;
export function srcSourceFiles() {
  if (srcFilesCache) return srcFilesCache;
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'testing') continue;
        walk(p);
      } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.(mjs|ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(repoPath('src'));
  srcFilesCache = out.map((p) => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
  return srcFilesCache;
}
/** Non-test source files containing this literal text */
export const srcFilesContaining = (needle) => srcSourceFiles().filter((f) => f.text.includes(needle)).map((f) => f.rel);

/** Settle a Promise within a time limit, otherwise throw an error (fails the test case instead of hanging the entire file when the implementation hangs) */
export function within(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: did not settle within ${ms} ms (hung? are the transaction's error / abort handlers wired up?)`)), ms); }),
  ]);
}

/** Replace a global (`navigator` is a read-only getter in Node, use defineProperty); returns restore function */
export function stubGlobal(name, value) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (saved) Object.defineProperty(globalThis, name, saved);
    else delete globalThis[name];
  };
}

/* ================================================================== K2 L2 */

export const L2_FILES = [
  'src/online/l2.ts', 'src/online/l2Store.ts', 'src/online/snapshotStore.ts', 'src/online/snapshotDb.ts',
  'src/online/pageStore.ts', 'src/online/pageCache.ts', 'src/render/l2Store.ts', 'src/render/snapshotStore.ts',
];
export const L2_OPEN_NAMES = ['openL2', 'openL2Store', 'openSnapshotStore', 'openSnapshotDb', 'openPageStore', 'createL2', 'createL2Store', 'createSnapshotStore'];
export const L2_METHODS = {
  putBlock: ['putBlock', 'putSnapshot', 'writeBlock', 'storeBlock', 'put'],
  getBlock: ['getBlock', 'getSnapshot', 'readBlock', 'loadBlock', 'get'],
  putCost: ['putCost', 'writeCost', 'setCost', 'saveCost'],
  getCost: ['getCost', 'readCost', 'loadCost'],
  putRange: ['putRange', 'markRange', 'writeRange', 'setRange', 'addRange'],
  subscribe: ['subscribeReady', 'onReady', 'subscribe', 'onRange'],
  close: ['close', 'dispose'],
};
/** Section 4 of the contract */
export const L2_TABLES = ['costs', 'ranges', 'snapshots'];
/** Soft limit allocated by environment (from 2026-10-22; originally 256 / 64 MiB by tier): 10% of quota clamped to [min, max]; if quota unavailable, by memory (GiB × 32 MiB, clamped to 64-256 MiB); fallback if neither */
export const L2_SOFT_LIMIT = { min: 32 * MiB, max: 1024 * MiB, fallback: 128 * MiB, memoryMin: 64 * MiB, memoryMax: 256 * MiB };
export const L2_RECLAIM = { min: 16 * MiB, max: 64 * MiB };
/** "10% of remaining quota" */
export const l2Limit = ({ remaining }) => Math.min(remaining, Math.max(L2_SOFT_LIMIT.min, Math.min(L2_SOFT_LIMIT.max, 0.1 * remaining)));

export function l2Gate() {
  const hit = findExport(L2_FILES, L2_OPEN_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(L2_FILES, L2_OPEN_NAMES)) };
}

/** Open L2, and adapt methods to a uniform shape by candidate names (K2) */
export async function openL2(gate, { indexedDB, deviceMemory, estimate, now = () => Date.now() }) {
  const mod = await importRepo(gate.file);
  const store = await within(mod[gate.name]({ indexedDB, deviceMemory, estimate, now }), 5000, `L2 ${gate.name}() open`);
  if (!store || typeof store !== 'object') throw new Error(`Assumption K2: ${gate.name}() did not return an object`);
  const m = {};
  for (const [k, names] of Object.entries(L2_METHODS)) m[k] = pickMethod(store, names);
  for (const k of ['putBlock', 'getBlock', 'putCost', 'getCost', 'putRange', 'subscribe']) {
    if (!m[k]) throw new Error(`Assumption K2: ${k} not found on the L2 object (candidates ${L2_METHODS[k].join(' / ')}); available methods: ${Object.keys(store).join(', ')}`);
  }
  const call = (k, ...args) => within(store[m[k]](...args), 5000, `L2 ${m[k]}()`);
  return {
    raw: store,
    module: mod,
    putBlock: (key, bytes, type = 'text/html') => call('putBlock', key, bytes, type),
    async getBlock(key) {
      const v = await call('getBlock', key);
      if (v === undefined || v === null) return null;
      if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
      if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
      if (typeof v === 'object' && 'bytes' in v) return v.bytes;
      return v;
    },
    putCost: (key, rec) => call('putCost', key, rec),
    getCost: (key) => call('getCost', key),
    putRange: (layerKey, from, to) => call('putRange', layerKey, from, to),
    subscribe: (cb) => store[m.subscribe](cb),
    close: () => (m.close ? store[m.close]() : undefined),
  };
}

/** A 64-bit hex content hash */
export const hashOf = (i, salt = 'a') => (salt + String(i).padStart(8, '0')).padEnd(64, '0').replace(/[^0-9a-f]/g, 'e').slice(0, 64);
export const snapKey = (i, salt) => `snap/${hashOf(i, salt)}`;

/** Total length of byte classes embedded in value (chunk byte count) */
export function bytesIn(v, depth = 0) {
  if (v === null || v === undefined || depth > 4) return 0;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  if (typeof v !== 'object') return 0;
  let s = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) s += bytesIn(x, depth + 1);
  return s;
}

/** Whether string recognizes this chunk: equals `snap/<hash>`, or ends with `<hash>` (store only keeps hash, or with other prefix) */
const strMatches = (s, needle) => typeof s === 'string' && (s === needle || s.endsWith(needle.split('/').pop()));
/** Whether value contains a string that recognizes this chunk */
function hasString(v, needle, depth = 0) {
  if (typeof v === 'string') return strMatches(v, needle);
  if (!v || typeof v !== 'object' || depth > 4 || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => hasString(x, needle, depth + 1));
}
const keyMatches = (k, needle) => strMatches(k, needle) || (Array.isArray(k) && k.some((x) => keyMatches(x, needle)));

/** The L2 store in stub (contract: one store) */
export function l2DbName(factory) {
  const names = factory.dbNames();
  return names.length === 1 ? names[0] : null;
}
/** Records recognizing this chunk in `snapshots` table (K2) */
export function blockRecords(factory, key) {
  const db = l2DbName(factory);
  if (!db) return [];
  return factory.records(db, 'snapshots').filter((r) => keyMatches(r.key, key) || hasString(r.value, key));
}
/** Sum of byte counts of all chunks in `snapshots` table */
export function storedBlockBytes(factory) {
  const db = l2DbName(factory);
  if (!db) return 0;
  return factory.records(db, 'snapshots').reduce((s, r) => s + bytesIn(r.value), 0);
}
/** Write to a chunk in transaction log */
export const putsOf = (factory, key) => factory.log.flatMap((tx) => tx.ops.filter((o) => o.store === 'snapshots' && (o.op === 'put' || o.op === 'add') && keyMatches(o.key, key)).map((o) => ({ tx, op: o })));

/** All numeric values appearing in module exports (including one object layer) */
export function exportedNumbers(mod) {
  const out = [];
  for (const v of Object.values(mod)) {
    if (typeof v === 'number') out.push(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const x of Object.values(v)) if (typeof x === 'number') out.push(x);
  }
  return out;
}

/* ================================================================== K3 Frame switch by tick */

export const BEAT_FILES = [
  'src/render/pipelinePlan.mjs', 'src/render/beatSwap.mjs', 'src/render/beatSwap.ts', 'src/editor/snapshotFeed.ts',
  'src/editor/beatSwap.ts', 'src/online/beatSwap.ts', 'src/online/beatBudget.ts', 'src/render/swapBudget.mjs',
];
export const BEAT_FIT_NAMES = ['fitBeatSwaps', 'planBeatSwaps', 'beatSwapPlan', 'fitSwaps', 'fitSwapBudget', 'swapBudget'];
export const BEAT_SWITCH_NAMES = ['setBeatSwap', 'setPerBeatSwap', 'setOnlineBeatSwap', 'setSwapEveryBeat', 'setBeatSwapMode'];
export const SWAP_MS_DEFAULT = 3;

export function beatGate() {
  const hit = findExport(BEAT_FILES, ['SWAP_MS']);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(BEAT_FILES, ['SWAP_MS'])) };
}
export function beatFitOf() {
  return findExport(BEAT_FILES, BEAT_FIT_NAMES);
}
/** Uniformly returns `{ swap, placeholder, deadMs? }` */
export function normalizeFit(r) {
  if (!r || typeof r !== 'object') throw new Error(`Assumption K3: the frame-swap selection function did not return an object: ${JSON.stringify(r)}`);
  const swap = r.swap ?? r.swapped ?? r.fit;
  const placeholder = r.placeholder ?? r.placeholders ?? r.over;
  if (!Array.isArray(swap) || !Array.isArray(placeholder)) throw new Error(`Assumption K3: the response must have two arrays, swap / placeholder: ${JSON.stringify(r)}`);
  return { swap: [...swap], placeholder: [...placeholder], deadMs: r.deadMs };
}

/* ================================================================== K4 Layer table */

export const LAYER_FILES = [
  'src/render/snapshotSource.ts', 'src/render/onlineSnapshotSource.ts', 'src/online/onlineSnapshotSource.ts',
  'src/online/layerTable.ts', 'src/online/layers.ts', 'src/render/layerTable.ts', 'src/render/layerMap.ts', 'src/online/layerMap.ts',
];
export const LAYER_REF_NAMES = ['layerRefOf', 'resolveLayer', 'usableLayer', 'layerEntryOf', 'pickLayerEntry', 'layerSourceOf'];
export function layerGate() {
  const hit = findExport(LAYER_FILES, LAYER_REF_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(LAYER_FILES, LAYER_REF_NAMES)) };
}
/**
 * One layer in the layer table (K4). Integration reconciliation (`claude/c10-integ`, 2026-09-28):
 * real shape written by render nodes, namely `layerMapOf` in `server/artifact-transfer.mjs`
 * (layer table v 2, contract Section 18, Clause 3): each layer is `{ clipId, kind: 'html' | 'local',
 * key, tier, resultKey, dirKey, entryKey, firstFrame, count, contentKey, envFingerprint }`;
 * `parseLayerMap` on the page requires `kind`, `key`, `resultKey`, `firstFrame`, and `count` present.
 */
export const layerEntry = ({ clipId, contentKey, envFingerprint, resultKey = `r-${clipId}` }) => ({
  clipId, kind: 'html', key: `k-${clipId}`, tier: 'snapshot', resultKey, dirKey: resultKey, entryKey: null,
  firstFrame: 0, count: 300, contentKey, envFingerprint,
});
/** Full layer table (K4): shape of `layerMapOf`, with `v: 2` and `kind: 'layer-map'` (unrecognized `v` or missing `kind` treated as absent) */
export const layerTable = (layers) => ({ v: 2, kind: 'layer-map', projectId: 'proj-c10', entryKey: null, fps: 30, span: 60, at: 0, layers });

/* ================================================================== K5 Stage */

export const STAGE_FILES = [
  'src/online/stageOrigins.ts', 'src/online/stageConfig.ts', 'src/online/runtimeConfig.ts', 'src/online/stages.ts',
  'src/online/config.ts', 'src/editor/previewMode.ts', 'src/editor/stageOrigins.ts',
];
export const STAGE_PARSE_NAMES = ['parseStageOrigins', 'stageOriginsFromConfig', 'readStageOrigins', 'stageOriginsOf'];
export const STAGE_DECIDE_NAMES = ['stageLayout', 'chooseStageLayout', 'decideStages', 'stageLayoutOf', 'pickStageLayout'];
export function stageGate() {
  const hit = findExport(STAGE_FILES, STAGE_PARSE_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(STAGE_FILES, STAGE_PARSE_NAMES)) };
}
export function normalizeOrigins(r) {
  if (r === null || r === undefined) return null;
  if (Array.isArray(r)) return r.length === 2 ? { A: r[0], B: r[1] } : r;
  return r;
}
export function normalizeLayout(r) {
  if (r === true || r === 'dual') return 'dual';
  if (r === false || r === 'single') return 'single';
  if (r && typeof r === 'object') {
    if (r.dual === true || r.layout === 'dual' || r.mode === 'dual') return 'dual';
    if (r.dual === false || r.layout === 'single' || r.mode === 'single') return 'single';
  }
  throw new Error(`Assumption K5: cannot recognize the stage selection response: ${JSON.stringify(r)}`);
}

/* ================================================================== K6 Publish plan */

export const PLAN_FILES = [
  'src/online/planPublisher.ts', 'src/online/publishPlan.ts', 'src/online/plan.ts', 'src/online/planTask.ts',
  'src/editor/sync/planPublisher.ts', 'src/editor/sync/publishPlan.ts', 'src/editor/planPublisher.ts',
];
export const PLAN_FACTORY_NAMES = ['createPlanPublisher', 'planPublisher', 'createOnlinePlanPublisher', 'startPlanPublisher'];
export const PLAN_METHODS = {
  measured: ['measured', 'markMeasured', 'setMeasured', 'onMeasured', 'measureSettled'],
  changed: ['changed', 'projectChanged', 'onProjectChange', 'notifyChange', 'update'],
  dispose: ['dispose', 'stop', 'close'],
};
export function planGate() {
  const hit = findExport(PLAN_FILES, PLAN_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(PLAN_FILES, PLAN_FACTORY_NAMES)) };
}

/*
 * K6 integration reconciliation (`claude/c10-integ`, 2026-09-28; per contract Section 18, Clause 9
 * [ruling] and the reconciliation table in `AGENT-c10-browser.md`):
 *   - What the page publishes is a "manifest plan": `plan`, `resultKey` =
 *     `<projectId>@<projectRev>#clips:<manifest-signature>` (not bare `<projectId>@<projectRev>`);
 *     `parseInbound` recognizes it, and the segment before `#clips:` remains
 *     `<projectId>@<projectRev>`. Tests compare this segment (`planKeyBase`) when checking result keys.
 *   - Publisher needs to know clip manifest classified as heavy by page: factory parameters add
 *     `clips: () => string[]`; do not publish if manifest is empty. Tests provide a fixed manifest
 *     (`PLAN_TEST_CLIPS`).
 *   - Before publishing, check in with `publisher.hello` and await `publisher.welcome` per render
 *     queue protocol (`server/render-queue/queue.mjs`). Mock connection in tests only simulates
 *     responses to `task.publish`, so wrap a layer here: forward check-in messages to mock
 *     connection as usual (returns false if disconnected, consistent with mock connection), this
 *     layer provides `publisher.welcome` for response, and mock connection does not forward
 *     responses to check-in upstream. `task.publish` and its responses pass through as-is, unchanged.
 */
export const PLAN_TEST_CLIPS = ['clip-h1', 'clip-h2'];
const CLIPS_MARK = '#clips:';
/** Segment before `#clips:` in result key (K6) */
export const planKeyBase = (resultKey) => (typeof resultKey === 'string' && resultKey.includes(CLIPS_MARK) ? resultKey.slice(0, resultKey.indexOf(CLIPS_MARK)) : resultKey);

/** Publisher factory parameters (K6): `endpoint` wrapped with check-in response, plus clip manifest */
export function planFactoryDeps({ endpoint, ...rest }) {
  const handlers = [];
  const helloIds = new Set();
  endpoint.onMessage((m) => {
    if (m && m.reqId !== undefined && helloIds.has(String(m.reqId))) return; // Mock connection does not forward responses to check-in upstream
    for (const h of handlers) h(m);
  });
  const wrapped = {
    send(msg) {
      if (msg?.type !== 'publisher.hello') return endpoint.send(msg);
      if (msg.reqId !== undefined) helloIds.add(String(msg.reqId));
      if (!endpoint.send(msg)) return false;
      queueMicrotask(() => { for (const h of handlers) h({ type: 'publisher.welcome', reqId: msg.reqId, publisherId: msg.publisherId }); });
      return true;
    },
    onMessage(h) { handlers.push(h); return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }; },
  };
  return { ...rest, endpoint: wrapped, clips: () => PLAN_TEST_CLIPS };
}

/* ================================================================== K7 / K8 C10-UI */

/** Section 17 Table A (original contract) */
export const TABLE_A = [
  // After the UI source code was changed to English (displayed via tr()), the UI strings in Table A
  // follow the original English text; pageFlag.ts is still in Chinese, so those two strings remain
  // unchanged.
  'No network connection at the moment.',
  "Can't connect to the server, please try again later. Your changes stay on this page for now and will be submitted automatically once the connection is restored.",
  "Can't connect to the asset service, so original-size media and prerender output can't be displayed for now.",
  'Connection restored. Submitting the changes made while offline…',
  'All changes made while offline have been submitted.',
  // Offline persistent notice split into two sentences depending on whether changes were saved ([ruling: 2026-10-22 lead session], original "Currently offline with unsaved changes. Closing the page will lose these operations." invalidated)
  "Currently offline. Your changes are saved on this machine and will be merged back into the project once you're back online.",
  'Currently offline. Your changes exist only on this page and will be lost when you close it.',
  'Online browser mode does not yet support',
  ', please use PromptCut on your computer.',
];
export const C10_UI_MARKERS = [', please use PromptCut on your computer.', "Currently offline. Your changes are saved on this machine and will be merged back into the project once you're back online."];
/** Section 9: merged into icon, no separate error */
export const DROPPED_TEXTS = ['This mode does not yet support audio media effect cards that take media input', 'This mode does not yet support custom cards',
  // (user decision, 2026-10-21): "Neither case has 'local PC assisted rendering'"; stage icon and timeline badge removed together
  'Local PC render helper required'];
export function uiGate() {
  const hits = C10_UI_MARKERS.flatMap(srcFilesContaining);
  return hits.length ? { ok: true, files: hits } : { ok: false, reason: skipReason(`The non-test source files in src/ do not contain "${C10_UI_MARKERS.join('" or "')}" from Table A`) };
}

/* ================================================================== K9 Ratchet */

export const RATCHET_FILE = 'server/test/c10a-online-api-paths.json';
export const RATCHET_BASELINE = 'server/test/c10-api-ratchet-baseline.json';
export function ratchetGate() {
  return exists(RATCHET_FILE) ? { ok: true } : { ok: false, reason: skipReason(`${RATCHET_FILE} does not exist (the ratchet manifest of C10a is still on claude/c10a-integ and has not reached main)`) };
}

/* ================================================================== K10 Backup */

export const BACKUP_FILES = [
  'src/online/backups.ts', 'src/online/backup.ts', 'src/online/offlineBackup.ts', 'src/online/localBackups.ts',
  'src/editor/sync/onlineBackups.ts', 'src/editor/sync/backupDownload.ts', 'src/editor/sync/memoryBackups.ts',
];
export const BACKUP_FACTORY_NAMES = ['createOnlineBackups', 'createBackupSink', 'onlineBackupSink', 'createMemoryBackups', 'createOnlineBackupSink'];
export const BACKUP_METHODS = {
  save: ['save', 'saveBackup', 'add', 'push'],
  list: ['list', 'items', 'all', 'backups'],
  download: ['download', 'downloadBackup', 'offerDownload'],
};
export function backupGate() {
  const hit = findExport(BACKUP_FILES, BACKUP_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(BACKUP_FILES, BACKUP_FACTORY_NAMES)) };
}

/* ================================================================== K11 Merge distribution */

export function mergeGate() {
  const src = exists('server/asset-service.ts') ? fs.readFileSync(repoPath('server/asset-service.ts'), 'utf8') : '';
  return /\bmerge\b/.test(src) ? { ok: true } : { ok: false, reason: skipReason('No merge route appears in server/asset-service.ts') };
}
export const MERGE_PATH = (projectId, key) => `/api/asset/merge/${projectId}/${key}`;

/* ================================================================== K12 Renewal */

export const RENEW_FILES = [
  'src/export/ticketRenewal.ts', 'src/export/tickets.ts', 'src/export/renewTicket.ts', 'src/export/ticketRenewer.ts',
  'src/online/ticketRenewal.ts', 'src/online/tickets.ts', 'src/online/ticketRenewer.ts', 'src/export/originals.ts',
];
export const RENEW_FACTORY_NAMES = ['createTicketRenewer', 'keepTicketFresh', 'createTicketKeeper', 'renewingTicket'];
export const RENEW_METHODS = {
  start: ['start', 'ready', 'init'],
  ticket: ['ticket', 'current', 'get'],
  stop: ['stop', 'dispose', 'close'],
};
export function renewGate() {
  const hit = findExport(RENEW_FILES, RENEW_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(RENEW_FILES, RENEW_FACTORY_NAMES)) };
}
