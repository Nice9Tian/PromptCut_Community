/**
 * For testing and in-process integration only; production code must not reference it.
 *
 * In-memory artifact sink (`sink` in D.1, D.3 of contract `docs/plan/render-queue-contract.md`).
 * Implemented by asset service starting in M5; semantics see `mechanism/asset-service.md`
 * "Push first, confirm everything received, then report completion" and design 4.4
 * "Before starting work, ask asset service if this segment already exists".
 *
 *   sink.has({ resultKey, kind, tier, range })                         → Promise<boolean>
 *   sink.put({ resultKey, kind, tier, range, artifacts, meta })        → Promise<{ complete: boolean }>
 *
 * A segment = a range of a result key (`resultKey` + `range.from` to `range.to`). Content-addressed:
 * pushing the same segment again does not overwrite the copy fully received the first time;
 * it is only recorded in push history.
 *
 * Additional interfaces for testing:
 *   entries()           fully received segments:
 *                       [{ resultKey, kind, tier, range, artifacts, meta }], in order of completion
 *   seed({ resultKey, range, kind?, tier? })   preset a segment as fully received (meta is null)
 *   failNextPut(n)      next n put calls return { complete: false }, not stored
 *   putCount(resultKey) how many times put was called for this result key (including incomplete ones)
 *   puts()              records of all puts: [{ resultKey, range, meta, complete }]
 *   hasCalls()          records of all has calls: [{ resultKey, range, answer }]
 *   misuse()            calls violating D.1 (missing resultKey / range, meta missing fields):
 *                       test asserts empty
 *   holds(resultKey, range)   every unit in this range has been received (synchronous)
 *   stores(resultKey, range)  whether this item (result key + range) is stored (synchronous;
 *                             track streams are also stored by "8 segments per bucket", rules
 *                             same as `writeManifest`, with bucket end truncated to the last
 *                             segment of the entire stream converted from task `input.stream`,
 *                             `src/render/streamBuckets.mjs`)
 *
 * `has` answers per unit: considered present only if every segment in the task range (every frame
 * of a snapshot) has been received (full density tasks also require the full density version),
 * same as lookup in `createAssetSink`.
 *
 * All methods settle immediately (returning a fulfilled Promise) without depending on any timer.
 */

import { streamBucketRanges, streamLastSegmentOf } from '../../src/render/streamBuckets.mjs';

const segmentKey = (resultKey, range) => `${resultKey}#${range.from}-${range.to}`;

const clone = value => (value === undefined ? undefined : structuredClone(value));
/** Whether this call is for a sparse stream task (the ref given by task-runner carries task `input`) */
const sparseRef = args => args?.kind === 'stream' && args?.input?.density === 'sparse';

function badArgs(what, args) {
  if (!args || typeof args !== 'object') return `${what}: args is not an object`;
  if (typeof args.resultKey !== 'string' || args.resultKey === '') return `${what}: resultKey must be a non-empty string`;
  const r = args.range;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.from) || !Number.isInteger(r.to)) return `${what}: range must have integer from / to`;
  return null;
}

export function createArtifactSink() {
  /**
   * segmentKey → a fully received segment (track streams additionally store one entry per
   * "8 segments per bucket", same as `writeManifest`)
   */
  const stored = new Map();
  /**
   * Which version was received for each unit (stream segment, snapshot frame) of each result key:
   * `<resultKey>#<n>` → 'dense' | 'sparse'.
   * `has` answers based on it (same as lookup in `createAssetSink`: checks only segments in task
   * range, without checking whether segments of other tasks in the bucket are complete)
   */
  const covered = new Map();
  const putLog = [];
  const hasLog = [];
  const misuse = [];
  let failing = 0;

  const cover = (resultKey, range, sparse) => {
    for (let n = range.from; n <= range.to; n++) {
      const k = `${resultKey}#${n}`;
      if (!sparse || !covered.has(k)) covered.set(k, sparse ? 'sparse' : 'dense');
    }
  };
  const coversAll = (resultKey, range, sparseOk) => {
    for (let n = range.from; n <= range.to; n++) {
      const got = covered.get(`${resultKey}#${n}`);
      if (!got || (!sparseOk && got === 'sparse')) return false;
    }
    return true;
  };

  function has(args) {
    const bad = badArgs('has', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const answer = coversAll(args.resultKey, args.range, sparseRef(args));
    hasLog.push({ resultKey: args.resultKey, range: clone(args.range), answer });
    return Promise.resolve(answer);
  }

  function put(args) {
    const bad = badArgs('put', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const { resultKey, kind, tier, range, artifacts, meta } = args;
    // D.1: meta = { taskId, nodeId, token }, for accounting (Section 7 of design, "Node Trust")
    if (!meta || typeof meta.taskId !== 'string' || typeof meta.nodeId !== 'string' || !Number.isInteger(meta.token)) {
      misuse.push(`put: meta must be { taskId: string, nodeId: string, token: int }, got ${JSON.stringify(meta)}`);
    }
    let complete = true;
    if (failing > 0) {
      failing -= 1;
      complete = false;
    }
    putLog.push({ resultKey, range: clone(range), meta: clone(meta), complete });
    const sparse = sparseRef(args);
    if (complete) {
      cover(resultKey, range, sparse);
      // Track stream: the task's own range, plus each distinct bucket in "8 segments per bucket"
      // (the bucket end is truncated to the last segment of the entire stream calculated from task
      // `input.stream`)
      const ranges = [{ from: range.from, to: range.to }];
      if (kind === 'stream') {
        const lastSegment = streamLastSegmentOf(args.input?.stream);
        for (const b of streamBucketRanges(range.from, range.to, lastSegment)) if (b.from !== range.from || b.to !== range.to) ranges.push(b);
      }
      for (const r of ranges) {
        const key = segmentKey(resultKey, r);
        if (!stored.has(key) || (stored.get(key).sparse === true && !sparse)) {
          stored.set(key, { resultKey, kind, tier, range: clone(r), artifacts: clone(artifacts), meta: clone(meta), ...(sparse ? { sparse: true } : {}) });
        }
      }
    }
    return Promise.resolve({ complete });
  }

  return {
    has,
    put,
    entries: () => [...stored.values()].map(entry => clone(entry)),
    seed({ resultKey, range, kind = null, tier = null }) {
      const bad = badArgs('seed', { resultKey, range });
      if (bad) throw new TypeError(bad);
      const key = segmentKey(resultKey, range);
      if (!stored.has(key)) stored.set(key, { resultKey, kind, tier, range: clone(range), artifacts: null, meta: null });
      cover(resultKey, range, false);
    },
    failNextPut(n = 1) {
      if (!Number.isInteger(n) || n < 0) throw new TypeError('failNextPut: n must be a non-negative integer');
      failing += n;
    },
    putCount: resultKey => putLog.filter(p => p.resultKey === resultKey).length,
    puts: () => putLog.map(p => clone(p)),
    hasCalls: () => hasLog.map(h => clone(h)),
    misuse: () => misuse.slice(),
    /**
     * Whether this segment was fully received (synchronous, for assertions): every unit in this
     * range has been received
     */
    holds: (resultKey, range) => coversAll(resultKey, range, true),
    /**
     * Whether this item (result key + range, including bucket writes) exists in the content store
     * (synchronous, for assertions)
     */
    stores: (resultKey, range) => stored.has(segmentKey(resultKey, range)),
  };
}
