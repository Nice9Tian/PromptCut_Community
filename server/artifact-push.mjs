/**
 * Unconditional push queue for prerender outputs (C6.4, Section 4 of `docs/plan/manifest-contract.md`;
 * `cloud-task.md` A3b, A5).
 *
 * Outputs produced by the local prerender process itself, including those that do not go through
 * the render queue, are queued here by segment (in 1:1 correspondence with queue fine-grained task
 * splits), pushed in the background to the asset service, and this segment's manifest is then
 * written to the document service content store. Other machines can look up the manifest by key
 * and pull chunks by hash, without needing to prerender again (cross-machine retrieval, Section 5).
 *
 *   Enqueue: `enqueue(unit, priority)`. `unit = { kind: 'snapshot' | 'stream', tier?, resultKey, dirKey?, entryKey?, range, canvasHeavy? }`;
 *         if the same segment (`<kind>:<resultKey>:<from>-<to>`) is already in the queue, it is
 *         not duplicated, only merging priorities; if the segment currently being pushed is
 *         enqueued again, push it once more after it finishes (pushing reads the old frame store,
 *         so newly written frames must be caught up).
 *   Priority: smaller numbers are pushed first: 0 `normal`, 1 `low`, 2 `lowest`. Take the lower
 *         priority of card level (caller-given `priority`, plus what can be inferred from this
 *         segment: stream, local tier, `canvasHeavy` are all at least 1) and chunk level (over
 *         half the bytes in this segment are `data:image` → 1; has oversized frames → 2). Chunk
 *         level is computed by reading the frame store before this segment's turn (`oversize` in
 *         `index.json`, `data:image` proportion in frame files).
 *   Execution: run `concurrency` segments concurrently; each segment does `collect*` → `pushResult`
 *         → `content.put` manifest. Failed segments are retried with exponential backoff (5 s, 30 s,
 *         120 s, then every 10 min) without giving up. Segments whose manifest exceeds 256 KiB can
 *         never be written to the content store, and are dropped after logging. If a segment's
 *         key directory is no longer in the frame store (evicted by limit or deleted by
 *         "clear cache", `frame-library-storage.mjs`), check once each before push, when push
 *         yields nothing, and on push failure; if absent, drop it, log `push.evicted`, and do not
 *         retry (storage plan `docs/plan/storage-plan.md`).
 *   Persistence: `<dir>/push-queue.json` (`dir` is the frame store root), written back via `atomic`
 *         on each enqueue and completion; read back on restart to resume pushing; completed segments
 *         are not kept in the file.
 *
 * Pushing runs in the background, and prerendering frames does not wait for it; Chrome is not
 * opened here, and no rendering is performed. Both the asset service client (`createAssetClient`)
 * and the content store client (`createContentClient`) are passed in by the caller.
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { atomic } from './frame-mov.mjs';
import { rangeHas } from './snapshot-store.mjs';
import { collectSnapshotResult, collectStreamResult, pushResult, manifestKindOf, manifestKeyOf, assertResultSize, layerMapKeyOf, mergedForWrite } from './artifact-transfer.mjs';
import { sharedBandwidthGate } from './bandwidth-gate.mjs';

/** Priority: smaller numbers are pushed first */
export const PUSH_PRIORITY = Object.freeze({ normal: 0, low: 1, lowest: 2 });
const PRIORITY_NAMES = ['normal', 'low', 'lowest'];
/** Backoff on failure: wait 5 s, 30 s, 120 s after failures 1, 2, 3, then 10 min each time thereafter */
export const PUSH_BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
/** Maximum number of segments held in memory when range cannot be determined (drop oldest when full) */
export const PUSH_DEFERRED_MAX = 5000;
/** Queue file name (under frame store root) */
export const PUSH_QUEUE_FILE = 'push-queue.json';
const FILE_VERSION = 1;

const KEY_RE = /^[a-f0-9]{64}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) && value !== '.' && value !== '..';

/**
 * How many bytes `data:image` occupies in an HTML segment. Algorithm copies `dataImageBytes`
 * from `scripts/probes/snapshot-size-probe.mjs` (counted by matched string length; these strings
 * are all ASCII, so length is byte count). Does not import the probe.
 */
const DATA_IMG = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
export const dataImageBytes = s => { let n = 0; for (const m of (s || '').match(DATA_IMG) || []) n += m.length; return n; };

/** `'normal' | 'low' | 'lowest' | 0 | 1 | 2` → 0-2; unrecognized values become 0 */
export function priorityOf(value) {
  if (typeof value === 'string') {
    const at = PRIORITY_NAMES.indexOf(value);
    return at >= 0 ? at : 0;
  }
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0;
}

/** Segment identifier: same format as render task id (`<kind>:<resultKey>:<from>-<to>`) */
export function unitId(unit) {
  return `${unit.kind}:${unit.resultKey}:${unit.range.from}-${unit.range.to}`;
}

/** Validate and normalize a segment; returns null if invalid (no guessing) */
export function normalizeUnit(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const { kind, resultKey } = unit;
  const from = unit.range?.from, to = unit.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  if (kind === 'stream') {
    if (!KEY_RE.test(String(resultKey))) return null;
    return { kind, resultKey, range: { from, to } };
  }
  if (kind !== 'snapshot' || !safeKey(resultKey)) return null;
  const tier = unit.tier ?? 'shared';
  if (tier === 'shared') {
    const dirKey = unit.dirKey ?? resultKey;
    if (!safeKey(dirKey)) return null;
    return { kind, tier, resultKey, dirKey, entryKey: null, range: { from, to }, canvasHeavy: unit.canvasHeavy === true };
  }
  if (tier !== 'local' || !safeKey(unit.dirKey) || !safeKey(unit.entryKey)) return null;
  return { kind, tier, resultKey, dirKey: unit.dirKey, entryKey: unit.entryKey, range: { from, to }, canvasHeavy: unit.canvasHeavy === true };
}

/** Card-level lower bound identifiable from this segment: stream, local tier, `canvasHeavy` are at least `low` (A5; streams are always 1) */
function unitFloor(unit) {
  if (unit.kind === 'stream') return PUSH_PRIORITY.low;
  if (unit.tier === 'local' || unit.canvasHeavy) return PUSH_PRIORITY.low;
  return PUSH_PRIORITY.normal;
}

/**
 * Chunk-level priority (A3b): oversized frames exist → 2; `data:image` bytes account for over half
 * of total HTML bytes → 1; otherwise 0. Only checks snapshots; streams return 0 (a stream's
 * card-level priority is already 1). Treated as 0 if unreadable, without blocking the push.
 */
export async function blockPriorityOf(pipeline, unit) {
  if (unit.kind !== 'snapshot') return PUSH_PRIORITY.normal;
  const store = pipeline.snapshots();
  const target = { tier: unit.tier, entryKey: unit.tier === 'local' ? unit.entryKey : undefined, key: unit.dirKey };
  const index = await store.snapshotIndex(target);
  const { from, to } = unit.range;
  for (let f = from; f <= to; f++) if (rangeHas(index.oversize, f)) return PUSH_PRIORITY.lowest;
  let total = 0, images = 0;
  for (let f = from; f <= to; f++) {
    if (!rangeHas(index.frames, f)) continue;
    const html = await store.readSnapshot({ ...target, localFrame: f });
    if (html === null) continue;
    total += Buffer.byteLength(html, 'utf8');
    images += dataImageBytes(html);
  }
  return total > 0 && images * 2 > total ? PUSH_PRIORITY.low : PUSH_PRIORITY.normal;
}

/**
 * Key directory of this segment in the frame store: snapshots = `snapshots().dir(...)` (shared tier
 * `controls-html/<dirKey>`, local tier `controls-local/<entryKey>/<dirKey>`); streams =
 * `<frame-store>/streams/<resultKey>`. Returns null if unable to compute (assumes it exists).
 */
export function unitDirOf(pipeline, unit) {
  try {
    if (unit.kind === 'stream') return typeof pipeline?.root === 'string' && pipeline.root ? path.join(pipeline.root, 'streams', unit.resultKey) : null;
    const dir = pipeline?.snapshots?.()?.dir?.({ tier: unit.tier, entryKey: unit.tier === 'local' ? unit.entryKey : undefined, key: unit.dirKey });
    return typeof dir === 'string' && dir ? dir : null;
  } catch { return null; }
}

/**
 * Whether this segment's key directory is no longer present (evicted by frame store capacity cap,
 * or deleted by "Clear cache", `frame-library-storage.mjs`). Only confirmed ENOENT counts as missing;
 * other errors (permission denied, locked) do not count, retrying as usual.
 */
export async function unitEvicted(pipeline, unit) {
  const dir = unitDirOf(pipeline, unit);
  if (!dir) return false;
  try { await fsSync.promises.lstat(dir); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline` (uses its frame store `snapshots()` and `root`)
 * @param {any} options.client  Asset service client (`put` / `has` / `get`)
 * @param {any} [options.content]  Content store client (`put` / `get` / `list`); if omitted, only
 *        pushes chunks without writing manifests
 * @param {string} [options.dir]  Directory where queue file resides, defaults to frame store root
 *        `pipeline.root`
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.concurrency]  How many segments to push concurrently, defaults to 2
 * @param {number[]} [options.backoff]  Backoff table, defaults to `PUSH_BACKOFF_MS` (last entry is
 *        reused indefinitely)
 * @param {number} [options.settleMs]  How long a segment settles after its last enqueue before
 *        pushing, defaults to 0 (pass a positive value in wiring to avoid pushing while rendering)
 * @param {{ now?: () => number, setTimeout?: Function, clearTimeout?: Function }} [options.clock]
 *        Injected clock (testing)
 * @param {() => number} [options.now]  Same as `clock.now`
 * @param {Function} [options.setTimeout]  Same as `clock.setTimeout`
 * @param {Function} [options.clearTimeout]  Same as `clock.clearTimeout`
 * @param {boolean} [options.attach]  Attached to `pipeline.pushQueue` after creation (pipeline
 *        hooks only recognize this one), defaults to true
 * @param {any} [options.gate]  Bandwidth gate (C6.6, `bandwidth-gate.mjs`), defaults to the one
 *        shared by this process; `false` to disconnect.
 *        Artifacts never wait on the gate, only registering "pushing" and "how many segments are
 *        waiting to push", putting the asset upload queue behind them
 * @param {{ accepts(unit: object): boolean | null, acceptsProject(projectId: string): boolean | null, describe?(): any } | null} [options.scope]
 *        Only pushes bound projects (`push-scope.mjs`): on enqueue, determines whether this
 *        segment belongs to a bound project; those that do not are not enqueued (kept locally);
 *        those that cannot be determined (null, bound project document id has not arrived yet) are
 *        held in memory first and re-evaluated during `rescope()` (holds up to
 *        `PUSH_DEFERRED_MAX` segments). Layer tables are likewise evaluated by project id.
 *        Omitted = unlimited (original behavior). Segments read back from the queue file on
 *        restart are not re-evaluated (files are partitioned by project directory)
 */
export function createPushQueue({
  pipeline, client, content = null, dir, log = () => {}, concurrency = 2,
  backoff = PUSH_BACKOFF_MS, settleMs = 0, clock = null,
  now: nowOpt, setTimeout: setTimeoutOpt, clearTimeout: clearTimeoutOpt, attach = true, gate: gateOpt, scope = null,
} = /** @type {any} */ ({})) {
  if (!pipeline) throw new TypeError('createPushQueue needs a pipeline');
  if (!client || typeof client.put !== 'function') throw new TypeError('createPushQueue needs an asset client');
  const now = nowOpt ?? clock?.now ?? (() => Date.now());
  const setTimer = setTimeoutOpt ?? clock?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = clearTimeoutOpt ?? clock?.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  const lanes = Math.max(1, Math.floor(Number(concurrency) || 1));
  const delays = Array.isArray(backoff) && backoff.length ? backoff.map(ms => Math.max(0, Number(ms) || 0)) : [...PUSH_BACKOFF_MS];
  const settle = Math.max(0, Number(settleMs) || 0);
  const root = dir ?? pipeline.root;
  const file = typeof root === 'string' && root ? path.join(root, PUSH_QUEUE_FILE) : null;
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect pushing */ } };

  /**
   * id → item. item = { id, unit, priority (card-level), block (block-level, null = not yet
   * computed), seq, attempts, nextAt, readyAt, inflight, again }
   */
  const items = new Map();
  let seq = 0;
  let running = false;
  let stopped = false;
  let timer = null;
  let timerAt = Infinity;
  let pumping = false;
  let pumpAgain = false;
  let pumpQueued = false;
  const inflight = new Set();
  const waiters = [];
  const counters = { enqueued: 0, merged: 0, pushed: 0, failures: 0, uploaded: 0, skipped: 0, manifests: 0, dropped: 0, restored: 0, layerMaps: 0,
    outOfScope: 0, layerMapsOutOfScope: 0, deferredDropped: 0, evicted: 0 };
  /**
   * Segments whose scope cannot be determined and are held temporarily: id → { unit, priority }
   * (in memory only; in enqueue order, drops the oldest when full)
   */
  const deferred = new Map();
  /** Scope evaluation: true enqueued, false not enqueued, null held; always true if scope is omitted */
  const judge = unit => {
    if (!scope || typeof scope.accepts !== 'function') return true;
    try { const v = scope.accepts(unit); return v === true ? true : v === false ? false : null; } catch { return false; }
  };
  let outOfScopeLogged = 0;
  const noteOutOfScope = unit => {
    counters.outOfScope++;
    // Other projects write while rendering and arrive once per batch: only log the first few entries
    // and one every 500 entries thereafter
    if (outOfScopeLogged < 3 || counters.outOfScope % 500 === 0) {
      outOfScopeLogged++;
      say('push.out-of-scope', { id: unitId(unit), count: counters.outOfScope });
    }
  };
  let lastError = null;

  const effective = item => Math.max(item.priority, unitFloor(item.unit), item.block ?? 0);

  // Bandwidth gate (C6.6): registers "how many segments are waiting to push": those pushing, waiting
  // for their turn, and settling all count; those in backoff do not count (failed segments do not
  // block assets)
  const gate = gateOpt === false ? null : (gateOpt ?? sharedBandwidthGate());
  let unregisterDemand = () => {};

  /* ---------------- Persistence ---------------- */

  /**
   * Writebacks are chained into a single chain (contract section 9, item 1): `pending` is the write
   * queued at the end of the chain that has not started yet: it only takes a snapshot of the queue
   * when it begins, so all changes before it begins are written together by it, and any caller
   * invoking `persist()` during this time receives it. Writes that have already started accept no new
   * changes; subsequent changes are scheduled separately. Thus each promise returned by `persist()`
   * resolves only after a write that "included the state at the moment of the call" completes.
   */
  let chain = Promise.resolve();
  let pending = null;
  const snapshotFile = () => JSON.stringify({
    v: FILE_VERSION,
    items: [...items.values()].sort((a, b) => a.seq - b.seq).map(item => ({ unit: item.unit, priority: item.priority, attempts: item.attempts })),
  });
  const persist = () => {
    if (!file) return Promise.resolve();
    if (pending) return pending;
    const write = chain.then(async () => {
      if (pending === write) pending = null;
      // Snapshots are taken synchronously here (when the write begins); subsequent changes belong to
      // the next write
      try { await atomic(file, snapshotFile()); }
      catch (error) { say('push.persist-failed', { message: String(error?.message ?? error) }); }
    });
    pending = write;
    chain = write;
    return write;
  };

  const restore = () => {
    if (!file) return;
    let saved = null;
    try { saved = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return; }
    if (!saved || saved.v !== FILE_VERSION || !Array.isArray(saved.items)) return;
    for (const record of saved.items) {
      const unit = normalizeUnit(record?.unit);
      if (!unit) continue;
      const id = unitId(unit);
      if (items.has(id)) continue;
      items.set(id, { id, unit, priority: priorityOf(record.priority), block: null, seq: seq++, attempts: Math.max(0, Math.floor(Number(record.attempts) || 0)),
        nextAt: 0, readyAt: 0, inflight: false, again: false });
      counters.restored++;
    }
  };
  restore();

  /* ---------------- Scheduling ---------------- */

  const settleWaiters = () => {
    if (items.size) return;
    for (const resolve of waiters.splice(0)) resolve();
  };

  const schedule = () => {
    if (!running || pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => { pumpQueued = false; void pump(); });
  };

  const armTimer = () => {
    if (!running) return;
    let next = Infinity;
    for (const item of items.values()) {
      if (item.inflight) continue;
      const at = Math.max(item.nextAt, item.readyAt);
      if (at < next) next = at;
    }
    const t = now();
    if (next === Infinity || next <= t) {
      if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
      return;
    }
    if (timer !== null && timerAt === next) return;
    if (timer !== null) clearTimer(timer);
    timerAt = next;
    timer = setTimer(() => { timer = null; timerAt = Infinity; schedule(); }, next - t);
    timer?.unref?.();
  };

  const eligible = (item, t) => !item.inflight && item.nextAt <= t && item.readyAt <= t;

  async function pump() {
    if (!running) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        // Block-level priority is computed before this segment's turn (reads the frame store); once
        // computed it is not recomputed until it is enqueued again
        for (const item of [...items.values()]) {
          if (!running) return;
          if (item.block !== null || !eligible(item, now())) continue;
          try { item.block = await blockPriorityOf(pipeline, item.unit); }
          catch { item.block = PUSH_PRIORITY.normal; }
        }
        while (running && inflight.size < lanes) {
          const t = now();
          let best = null;
          for (const item of items.values()) {
            if (!eligible(item, t) || item.block === null) continue;
            if (!best || effective(item) < effective(best) || (effective(item) === effective(best) && item.seq < best.seq)) best = item;
          }
          if (!best) break;
          run(best);
        }
      } while (pumpAgain && running);
    } finally {
      pumping = false;
      armTimer();
    }
  }

  function run(item) {
    item.inflight = true;
    item.again = false;
    const endGate = gate ? gate.beginArtifact() : () => {};
    const work = pushOne(item).finally(() => {
      endGate();
      inflight.delete(work);
      item.inflight = false;
      schedule();
    });
    inflight.add(work);
  }

  /**
   * The key directory was evicted: this segment has nothing left to push locally, so drop it, do not
   * retry, and do not block other segments in the queue. Logs only record the first few entries and
   * one every 100 entries thereafter (a single eviction may remove many segments).
   */
  let evictedLogged = 0;
  function dropEvicted(item) {
    counters.evicted++;
    if (evictedLogged < 3 || counters.evicted % 100 === 0) {
      evictedLogged++;
      say('push.evicted', { id: item.id, count: counters.evicted });
    }
    finish(item, { dropped: true });
  }

  async function pushOne(item) {
    const { unit } = item;
    const priority = PRIORITY_NAMES[effective(item)];
    if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
    try {
      const task = { kind: unit.kind, tier: unit.tier, resultKey: unit.resultKey, range: unit.range, input: { canvasHeavy: unit.canvasHeavy === true } };
      const collected = unit.kind === 'snapshot'
        ? await collectSnapshotResult(pipeline, task, { location: { tier: unit.tier, entryKey: unit.entryKey, dirKey: unit.dirKey }, canvasHeavy: unit.canvasHeavy === true })
        : await collectStreamResult(pipeline, task);
      const { result } = collected;
      const empty = result.kind === 'snapshot' ? !result.frames.length : !Object.keys(result.segments ?? {}).length;
      if (empty) {
        // Nothing exists in the frame store for this segment (cleared, or what was enqueued was merely
        // an empty segment exceeding the actual length): nothing to push, do not write an empty manifest
        if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
        finish(item, { dropped: true });
        say('push.empty', { id: item.id });
        return;
      }
      const pushed = await pushResult(client, result, collected.readBlob);
      counters.uploaded += pushed.uploaded;
      counters.skipped += pushed.skipped;
      if (content && typeof content.put === 'function') {
        assertResultSize(result);
        // Merge the stream manifest first with the existing copy in the content store (no downgrade:
        // full-density segments filled by other nodes and segments not yet produced locally are preserved)
        await content.put(manifestKindOf(result.kind), manifestKeyOf(result), await mergedForWrite(content, result));
        counters.manifests++;
      }
      counters.pushed++;
      say('push.done', { id: item.id, priority, uploaded: pushed.uploaded, skipped: pushed.skipped });
      finish(item, {});
    } catch (error) {
      const code = error?.code ?? error?.reason ?? null;
      lastError = { id: item.id, code, message: String(error?.message ?? error), at: now() };
      if (code === 'result-too-large' || code === 'too-large') {
        // Can never be written to the content store (section 1); retrying is also useless
        say('push.too-large', { id: item.id, bytes: error?.bytes ?? null });
        counters.dropped++;
        finish(item, { dropped: true });
        return;
      }
      // Key directory evicted halfway through pushing (file unreadable, stream manifest missing):
      // drop it, do not retry indefinitely as a failure
      if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
      counters.failures++;
      item.attempts++;
      const delay = delays[Math.min(item.attempts - 1, delays.length - 1)];
      item.nextAt = now() + delay;
      say('push.retry', { id: item.id, attempts: item.attempts, delayMs: delay, code, message: lastError.message });
      void persist();
    }
  }

  /**
   * A segment finished pushing (or was dropped): if it was re-enqueued while pushing, keep it to push
   * again; otherwise dequeue
   */
  function finish(item, { dropped = false } = {}) {
    if (item.again && !dropped) {
      item.again = false;
      item.attempts = 0;
      item.nextAt = 0;
      item.block = null;
    } else {
      items.delete(item.id);
    }
    void persist();
    settleWaiters();
  }

  /* ---------------- c10a section 9: layer table for online pages ---------------- */

  /**
   * The latest layer table (`layerMapOf` in `artifact-transfer.mjs`), last write wins: batches for
   * 300 ms before writing; on failure, retries using the same backoff table; if a newer one arrives
   * in the meantime, only the newer one is written. Same kind as segment manifests
   * (`snapshot-manifest`), key `layers:<project id>`. If the content is identical (excluding `at`),
   * it is not rewritten.
   */
  let layerMap = null;
  let layerMapTimer = null;
  let layerMapAttempts = 0;
  let layerMapWritten = '';
  let layerMapFlying = false;
  const layerMapSig = body => { try { const { at, ...rest } = body; void at; return JSON.stringify(rest); } catch { return ''; } };
  const armLayerMap = ms => {
    if (layerMapTimer !== null) clearTimer(layerMapTimer);
    layerMapTimer = setTimer(() => { layerMapTimer = null; void flushLayerMap(); }, ms);
    layerMapTimer?.unref?.();
  };
  async function flushLayerMap() {
    if (layerMapFlying || !layerMap || stopped) return;
    const job = layerMap;
    const sig = `${job.key}
${layerMapSig(job.body)}`;
    if (sig === layerMapWritten) { if (layerMap === job) layerMap = null; return; }
    layerMapFlying = true;
    try {
      await content.put('snapshot-manifest', job.key, job.body);
      layerMapWritten = sig;
      layerMapAttempts = 0;
      counters.layerMaps++;
      if (layerMap === job) layerMap = null;
      say('push.layer-map', { key: job.key, layers: job.body?.layers?.length ?? 0 });
    } catch (error) {
      layerMapAttempts++;
      say('push.layer-map-retry', { key: job.key, attempts: layerMapAttempts, message: String(error?.message ?? error) });
      if (layerMap === job) armLayerMap(delays[Math.min(layerMapAttempts - 1, delays.length - 1)]);
    } finally {
      layerMapFlying = false;
      if (layerMap && layerMap !== job) armLayerMap(0);
    }
  }

  /* ---------------- External ---------------- */

  const queue = {
    get client() { return client; },
    get content() { return content; },
    get file() { return file; },
    /**
     * Enqueue (contract section 9, item 1). Enqueueing itself takes effect synchronously (if the same
     * segment is already in the queue, only its priority is merged); the returned promise resolves
     * only after the queue file writeback containing this enqueue completes. Hooks do not `await` it;
     * tests and callers that need to confirm persistence `await` it. Ineligible segments are not
     * enqueued, returning an already resolved promise (logs an entry).
     * @returns {Promise<void>}
     */
    enqueue(unit, priority = PUSH_PRIORITY.normal) {
      const normalized = normalizeUnit(unit);
      if (!normalized) { say('push.bad-unit', { unit: unit ?? null }); return Promise.resolve(); }
      const id = unitId(normalized);
      const level = priorityOf(priority);
      // Only push bound projects: segments already in the queue are not re-evaluated (evaluated on
      // enqueue); those not in the queue evaluate scope first
      if (!items.has(id)) {
        const verdict = judge(normalized);
        if (verdict === false) { deferred.delete(id); noteOutOfScope(normalized); return Promise.resolve(); }
        if (verdict === null) {
          const held = deferred.get(id);
          deferred.delete(id);
          deferred.set(id, { unit: held?.unit.canvasHeavy && normalized.kind === 'snapshot' ? { ...normalized, canvasHeavy: true } : normalized,
            priority: Math.max(level, held?.priority ?? 0) });
          while (deferred.size > PUSH_DEFERRED_MAX) { deferred.delete(deferred.keys().next().value); counters.deferredDropped++; }
          return Promise.resolve();
        }
        deferred.delete(id);
      }
      const t = now();
      const existing = items.get(id);
      if (existing) {
        existing.priority = Math.max(existing.priority, level);
        if (normalized.kind === 'snapshot' && normalized.canvasHeavy) existing.unit.canvasHeavy = true;
        existing.readyAt = settle ? t + settle : 0;
        existing.block = null;
        if (existing.inflight) existing.again = true;
        counters.merged++;
        const saved = persist();
        schedule();
        return saved;
      }
      items.set(id, { id, unit: normalized, priority: level, block: null, seq: seq++, attempts: 0, nextAt: 0, readyAt: settle ? t + settle : 0, inflight: false, again: false });
      counters.enqueued++;
      const saved = persist();
      schedule();
      return saved;
    },
    start() {
      if (running) return;
      running = true;
      stopped = false;
      if (gate) {
        unregisterDemand();
        unregisterDemand = gate.artifactDemand(() => {
          const t = now();
          let n = 0;
          for (const item of items.values()) if (item.inflight || item.nextAt <= t) n++;
          return n;
        });
      }
      schedule();
    },
    /**
     * Stop dispatching new work and return after the queue file finishes writing. **Does not wait for
     * segments being pushed**: they may be stuck on the network (W4 stops when segments being pushed
     * get stuck); they finish up on their own later: dequeued on success, kept in the file on failure,
     * both written back as usual; no subsequent segments are dispatched. Unfinished segments in the
     * queue remain in the file and resume pushing on the next rebuild.
     */
    async stop() {
      running = false;
      stopped = true;
      unregisterDemand();
      unregisterDemand = () => {};
      if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
      if (layerMapTimer !== null) { clearTimer(layerMapTimer); layerMapTimer = null; }
      await persist();
      for (const resolve of waiters.splice(0)) resolve();
    },
    /**
     * c10a section 9: write a layer table (last write wins, batches for 300 ms; see above). Returns
     * false if content store is omitted or project has no id.
     * @returns {boolean}
     */
    putLayerMap(projectId, body) {
      const key = layerMapKeyOf(projectId);
      if (!content || typeof content.put !== 'function' || !key || !body) return false;
      // Only write layer tables for bound projects (do not write if indeterminate: rewritten during
      // catch-up push once the project document id is known)
      if (scope && typeof scope.acceptsProject === 'function') {
        let v = null;
        try { v = scope.acceptsProject(projectId); } catch { v = false; }
        if (v !== true) { counters.layerMapsOutOfScope++; return false; }
      }
      layerMap = { key, body };
      armLayerMap(300);
      return true;
    },
    /** Reschedule immediately once (used in tests or after callers advance the clock) */
    poke() { schedule(); },
    /**
     * Re-evaluate scope for held segments (called after the bound project's document id arrives):
     * those that belong are enqueued, those that do not are dropped, and those still indeterminate
     * remain held. Returns `{ queued, dropped, held }`.
     */
    rescope() {
      let queued = 0, dropped = 0;
      for (const [id, held] of [...deferred]) {
        const verdict = judge(held.unit);
        if (verdict === null) continue;
        deferred.delete(id);
        if (verdict === false) { dropped++; noteOutOfScope(held.unit); continue; }
        void queue.enqueue(held.unit, held.priority);
        queued++;
      }
      if (queued || dropped) say('push.rescope', { queued, dropped, held: deferred.size });
      return { queued, dropped, held: deferred.size };
    },
    /** Wait for the queue to empty (all pushed or dropped); stopped queues return immediately */
    drain() {
      if (!items.size || stopped) return Promise.resolve();
      return new Promise(resolve => waiters.push(resolve));
    },
    stats() {
      const byPriority = { normal: 0, low: 0, lowest: 0 };
      let backingOff = 0;
      const t = now();
      for (const item of items.values()) {
        byPriority[PRIORITY_NAMES[effective(item)]]++;
        if (!item.inflight && item.nextAt > t) backingOff++;
      }
      return { running, pending: items.size - inflight.size, inflight: inflight.size, backingOff, byPriority, ...counters, deferred: deferred.size, lastError,
        scope: scope && typeof scope.describe === 'function' ? scope.describe() : null,
        items: [...items.values()].sort((a, b) => a.seq - b.seq).map(item => ({ id: item.id, priority: PRIORITY_NAMES[effective(item)], attempts: item.attempts, inflight: item.inflight })) };
    },
  };
  if (attach !== false) pipeline.pushQueue = queue;
  return queue;
}
