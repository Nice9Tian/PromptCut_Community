/**
 * Cost record module (semantics `docs/semantics/mechanism/document-service.md` "Cost Records",
 * `mechanism/rendering.md` "Bounds Search and Cost Records";
 * contract `docs/plan/c10-contract.md` Section 3, branch `claude/c10-cost`).
 *
 * After the desktop app and all online browsers finish measuring a card, they write its live render
 * single-frame duration here (user decision, 2026-10-07); online pages with only a single stage read
 * all records of this project upon opening, sort cards by duration, and run bounds search
 * (`src/render/boundarySearch.mjs`). Stores only duration, not bytes.
 *
 * # Keys and values
 *
 * - Key: `(identityKey, envFingerprint)`. `identityKey` is card identity (`cardCostKey` in
 *   `src/render/cardCostKey.mjs`: parameters, source code version, frame rate, review table,
 *   clip duration), which originally excludes the measuring machine; `envFingerprint` is the
 *   fingerprint of the measurement environment, sharing the same scheme as the prerender output key
 *   (`server/render-node/fingerprint.mjs`: OS, base GPU category, Chrome major version).
 * - Value: `stepMs` (live render single-frame duration, the number fed into classify as heavy),
 *   `samples` (sample frame count), `measuredAt` (measurement timestamp, ms),
 *   `mode` (build mode `'dev'` / `'build'`).
 * - **Only the latest entry is kept for the same key**: compared by `measuredAt`, incoming entries
 *   replace existing ones only if they are not older (last arrival wins at the same timestamp).
 *   This ensures old records backfilled when the desktop app connects to a shared project do not
 *   overwrite freshly measured records from others.
 *
 * # Protocol (all requests can include `reqId`, echoed back in responses)
 *
 *   cost.put  { projectId, records: [{ identityKey, stepMs, samples, measuredAt, mode }], environment? | envFingerprint? }
 *     → cost.stored { projectId, envFingerprint, count, added, updated, ignored }
 *     One of two environments: `environment` is the raw value `{ platform, userAgent, renderer, vendor }`
 *     reported by the page (`src/editor/pageEnvironment.mjs`), used here to compute fingerprint via
 *     `describeEnvironment`: pages report only raw values and never compute it themselves, keeping
 *     normalization rules in a single place; `envFingerprint` is the precomputed 16-character lowercase
 *     hex (used by callers on the Node side). `ignored` is the count of records older than existing
 *     entries that were not replaced.
 *
 *   cost.list { projectId, environment? }
 *     → cost.listing { projectId, records: [{ identityKey, envFingerprint, stepMs, samples, measuredAt, mode }], truncated, envFingerprint? }
 *     Returns all records for this project (sorted by identityKey, envFingerprint). When `environment`
 *     is provided, returns its fingerprint alongside: bounds search uses it as the key for local
 *     measurement results ("card identity + local environment fingerprint"), without needing to
 *     recompute it in the page.
 *
 *   Error: `error { reason }`, where `reason` is `bad-message` (invalid shape, nothing persisted),
 *   `forbidden` (not a member of this project), `too-large` (writing too much at once, or project
 *   records full), `unsupported` (unrecognized type).
 *
 * # Permissions and isolation
 *
 * Like the content store, an instance is spawned per project space (`spaces.mjs`, `bundleForSpace`
 * in `shared-service.mjs`); spaces are completely isolated from each other.
 * In a shared project space, only this project is recognized: `projectId` must equal the space name
 * (the project in connection credentials), otherwise `forbidden`: only members can read and write
 * this project's records. Only local identity can enter `local` space, where records are stored
 * separately by `projectId` without additional restrictions.
 *
 * # Storage
 *
 * Each project has an append log `costs/<projectId>` (sharing the same space store as the content
 * store), replayed upon first use and maintained only in memory thereafter.
 * Every log record carries `projectId`, used to filter during replay (Windows filenames are
 * case-insensitive; see `store/index.mjs`).
 */
import { createMemoryStore } from '../store/index.mjs';
import { describeEnvironment } from '../../render-node/fingerprint.mjs';
import { LOCAL_SPACE } from '../spaces.mjs';
import { tr } from '../../i18n.mjs';

export const COSTS_MODULE = 'costs';

/** Three-tier numbers (`mechanism/document-service.md` "Cost Records") */
export const COSTS_LIMITS = Object.freeze({
  /** Maximum number of records per `cost.put` */
  MAX_PUT: 500,
  /** Max records per project (cards × environments; at limit, only existing keys can be replaced) */
  MAX_RECORDS: 20_000,
  /** Records per `cost.list`; includes `truncated: true` if exceeded, newest to oldest by timestamp */
  MAX_LIST: 5_000,
  /** Reasonable upper bound for single-frame duration (ms); treated as malformed shape if exceeded */
  MAX_STEP_MS: 600_000,
  /** Upper bound on sample frame count */
  MAX_SAMPLES: 1_000_000,
});

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const MODES = new Set(['dev', 'build']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}
const bad = (detail) => { throw new Refused('bad-message', detail); };

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId is invalid');
  return v;
}

/** Raw environment reported by page → fingerprint; throws bad-message if shape is invalid */
function fingerprintOfEnvironment(env) {
  if (!isObj(env)) bad('environment must be an object');
  for (const k of ['platform', 'userAgent', 'renderer', 'vendor']) {
    if (env[k] !== undefined && (typeof env[k] !== 'string' || env[k].length > 1024)) bad(`environment.${k} must be a string of at most 1024 characters`);
  }
  return describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
}

/** Environment at write time: exactly one of `environment` or `envFingerprint` must be provided */
function envOfPut(msg) {
  const hasEnv = msg.environment !== undefined;
  const hasFp = msg.envFingerprint !== undefined;
  if (hasEnv === hasFp) bad('Provide exactly one of environment and envFingerprint');
  if (hasFp) {
    if (typeof msg.envFingerprint !== 'string' || !FINGERPRINT_RE.test(msg.envFingerprint)) bad('envFingerprint must be 16 lowercase hex digits');
    return msg.envFingerprint;
  }
  return fingerprintOfEnvironment(msg.environment);
}

/** Shape of a single record; keeps only recognized fields */
function checkRecord(r, i) {
  const at = `records[${i}]`;
  if (!isObj(r)) bad(tr("{0} must be an object", at));
  if (typeof r.identityKey !== 'string' || !IDENTITY_RE.test(r.identityKey)) bad(`${at}.identityKey is invalid`);
  if (typeof r.stepMs !== 'number' || !Number.isFinite(r.stepMs) || r.stepMs < 0 || r.stepMs > COSTS_LIMITS.MAX_STEP_MS) bad(`${at}.stepMs must be a number from 0 to ${COSTS_LIMITS.MAX_STEP_MS}`);
  if (!Number.isSafeInteger(r.samples) || r.samples < 1 || r.samples > COSTS_LIMITS.MAX_SAMPLES) bad(`${at}.samples must be an integer from 1 to ${COSTS_LIMITS.MAX_SAMPLES}`);
  if (typeof r.measuredAt !== 'number' || !Number.isFinite(r.measuredAt) || r.measuredAt <= 0) bad(`${at}.measuredAt must be a positive number (millisecond timestamp)`);
  if (!MODES.has(r.mode)) bad(`${at}.mode must be dev / build`);
  return { identityKey: r.identityKey, stepMs: r.stepMs, samples: r.samples, measuredAt: r.measuredAt, mode: r.mode };
}

const keyOf = (identityKey, envFingerprint) => `${identityKey}\u0000${envFingerprint}`;
const streamOf = (projectId) => `costs/${projectId}`;

/** External record representation (omits internal fields such as writer) */
const publicOf = (r) => ({ identityKey: r.identityKey, envFingerprint: r.envFingerprint, stepMs: r.stepMs, samples: r.samples, measuredAt: r.measuredAt, mode: r.mode });

/**
 * @param {object} [options]
 * @param {string} [options.space] Which space this instance belongs to (space name in `spaces.mjs`);
 *   defaults to `local`
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[] }} [options.store]
 *   Defaults to in-memory store
 * @param {() => number} [options.now] Timestamp received by server (recorded in log only, not used
 *   in "latest" comparison); defaults to `ctx.now()`
 * @param {object} [options.limits] Overrides items in `COSTS_LIMITS` (for testing)
 */
export function costsModule({ space = LOCAL_SPACE, store = createMemoryStore(), now, limits = {} } = {}) {
  const L = { ...COSTS_LIMITS, ...limits };
  /** projectId → Map<key, record>; replayed from log upon first use */
  const projects = new Map();
  /** connId → principal */
  const principals = new Map();

  function tableOf(projectId) {
    let table = projects.get(projectId);
    if (table) return table;
    table = new Map();
    for (const rec of store.read(streamOf(projectId))) {
      if (!isObj(rec) || rec.projectId !== projectId || typeof rec.identityKey !== 'string' || typeof rec.envFingerprint !== 'string') continue;
      const key = keyOf(rec.identityKey, rec.envFingerprint);
      const prev = table.get(key);
      if (prev && prev.measuredAt > rec.measuredAt) continue;
      table.set(key, rec);
    }
    projects.set(projectId, table);
    return table;
  }

  /** Only members read/write project records: in shared space, projectId must match the space name */
  function checkAccess(connId, projectId) {
    const principal = principals.get(connId);
    if (!principal || principal.scope === 'admin') throw new Refused('forbidden', tr("This connection cannot read or write cost records"));
    if (space !== LOCAL_SPACE && projectId !== space) throw new Refused('forbidden', tr("Only members of this project can read or write its cost records"));
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function put(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    checkAccess(connId, projectId);
    const envFingerprint = envOfPut(msg);
    if (!Array.isArray(msg.records) || msg.records.length < 1) bad('records must be a non-empty array');
    if (msg.records.length > L.MAX_PUT) throw new Refused('too-large', `At most ${L.MAX_PUT} records can be written at a time`);
    // Validate the whole batch first; if any entry is invalid, persist nothing
    const records = msg.records.map(checkRecord);
    const table = tableOf(projectId);
    let added = 0, updated = 0, ignored = 0;
    const at = typeof now === 'function' ? now() : ctx.now();
    const fresh = records.filter((r) => !table.has(keyOf(r.identityKey, envFingerprint)));
    if (table.size + new Set(fresh.map((r) => r.identityKey)).size > L.MAX_RECORDS) throw new Refused('too-large', tr("The cost records of this project are full ({0} records)", L.MAX_RECORDS));
    for (const r of records) {
      const key = keyOf(r.identityKey, envFingerprint);
      const prev = table.get(key);
      if (prev && prev.measuredAt > r.measuredAt) { ignored++; continue; }
      const rec = { projectId, ...r, envFingerprint, at };
      // Append to log before updating memory: state remains unchanged on disk failure, core returns internal
      store.append(streamOf(projectId), rec);
      table.set(key, rec);
      if (prev) updated++; else added++;
    }
    reply(ctx, connId, { type: 'cost.stored', projectId, envFingerprint, count: table.size, added, updated, ignored }, reqId);
  }

  function list(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    checkAccess(connId, projectId);
    const envFingerprint = msg.environment === undefined ? undefined : fingerprintOfEnvironment(msg.environment);
    const all = [...tableOf(projectId).values()];
    let shown = all;
    const truncated = all.length > L.MAX_LIST;
    if (truncated) shown = [...all].sort((a, b) => b.measuredAt - a.measuredAt).slice(0, L.MAX_LIST);
    const records = shown.map(publicOf).sort((a, b) => byCodeUnit(a.identityKey, b.identityKey) || byCodeUnit(a.envFingerprint, b.envFingerprint));
    const out = { type: 'cost.listing', projectId, records, truncated };
    if (envFingerprint !== undefined) out.envFingerprint = envFingerprint;
    reply(ctx, connId, out, reqId);
  }

  const HANDLERS = { 'cost.put': put, 'cost.list': list };

  return {
    name: COSTS_MODULE,
    types: ['cost.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The cost records module does not support this message' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        throw err;
      }
    },

    describe() {
      let records = 0;
      for (const table of projects.values()) records += table.size;
      return { projects: projects.size, records };
    },
  };
}

export const createCostsModule = costsModule;
export default costsModule;
