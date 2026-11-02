/**
 * Pushing and pulling prerender artifacts (C6.2, `docs/plan/artifact-transfer-contract.md`
 * sections 3-6, section 11).
 *
 * Two kinds of queue task artifacts, HTML snapshots (shared tier, local tier) and track streams
 * (init + segments), are pushed to the asset service by content hash (snapshots into `snap`,
 * streams into `px`), and the task manifest of "which chunks make up this segment" is placed in
 * `result` of `task.complete`, sent to subscribers along with `task.done`; subscribers pull chunks
 * according to the manifest, persist them via existing write functions, and publish them into the
 * ready index.
 *
 *   Push side: `collectSnapshotResult` / `collectStreamResult` reads the manifest from the local
 *              frame store, and `pushResult` `put`s chunks one by one; `createAssetSink` wraps
 *              these two steps into the artifact store (`sink`) of `render-queue-contract.md` D.1.
 *   Pull side: `applyResult`: snapshots are persisted via `SnapshotStore.commitSnapshots` and then
 *              published via `pipeline.adoptResult`; streams are persisted and published via
 *              `pipeline.streamProducer().adoptSegments`. **Only these two write functions write
 *              files**, otherwise `index.json` / `stream.json` will not match disk
 *              (`cloud-task.md` A3b).
 *
 * X7 (`docs/plan/m6c-contract.md`): snapshot manifests can additionally carry **PNG cache** frames
 * for this segment (`pngs`, see `collectSnapshotResult`), with chunks pushed into `px`; the pull
 * side writes them as-is into the local PNG cache (`controls/<key>/mov/frames/` in `CardFrameCache`),
 * so the full-frame channel for `?preview=legacy` no longer draws placeholders for cards produced
 * by remote nodes. Manifests without `pngs` behave as before and are not retried with local
 * prerendering.
 *
 * C6.4 (`docs/plan/manifest-contract.md` sections 1 and 3): the manifest for each segment is
 * additionally written into the document service content store (`snapshot-manifest` /
 * `render-manifest`, key `<resultKey>:<from>-<to>`); the sink queries it to deduplicate before
 * starting work. The content store client (`ContentClient`, `put` / `get` / `list`) is likewise
 * passed in by the caller.
 *
 * The asset service client (`createAssetClient` in `server/asset-store/client.mjs`) is passed in by
 * the caller and is not imported here: only its two methods `put(ns, bytes, { ext })` /
 * `get(ns, hash)` are used (contract section 2).
 *
 * This module imports `snapshot-store.mjs` (which brings dependencies), so it is placed under
 * `server/` rather than `server/render-node/` (D1 gatekeeper).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rangeHas } from './snapshot-store.mjs';
import { clipInputSig } from '../src/render/layerInputSig.mjs';
import { streamInputSig } from '../src/render/streamInputSig.mjs';
import { isStreamOrigin } from '../src/render/streamSegments.mjs';
import { streamBucketManifest, streamBucketRanges, streamLastSegmentOf, STREAM_BUCKET_SEGMENTS } from '../src/render/streamBuckets.mjs';
import { snapshotTier } from './snapshot-tier.mjs';
import { MovFrameStore, signatureMatches } from './frame-mov.mjs';
import { readRenderRecord } from './png-record.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { SMALL_SUFFIX } from './bakery/small-bitmap.mjs';
import { kindOfTier, wireSnapshotKey } from './ready-index.mjs';
import { QUEUE_DEFAULTS } from './render-queue/constants.mjs';
import { isSparseStreamTask } from './render-queue/messages.mjs';
import { createExportFramesSink, isExportFramesTask } from './export-frames.mjs';

/** Manifest version (`v` in contract section 3) */
export const RESULT_VERSION = 1;
/**
 * Maximum manifest JSON size limit: throws an error if exceeded, not truncated (contract section 3)
 */
export const RESULT_MAX_BYTES = 256 * 1024;
/** Asset service namespace (contract section 1) */
export const SNAP_NS = 'snap';
export const PX_NS = 'px';
/** Number of chunks pushed / pulled concurrently */
const TRANSFER_CONCURRENCY = 4;
/**
 * When pulling snapshots, `commitSnapshots` once every this many frames accumulated (writes
 * index.json once per batch)
 */
const APPLY_BATCH = 8;

const KEY_RE = /^[a-f0-9]{64}$/;
/**
 * Keys usable as directory names (the result key of a shared tier is the directory name): path
 * separators are forbidden; `.` / `..` are forbidden
 */
const SAFE_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) && value !== '.' && value !== '..';
const sha256 = data => createHash('sha256').update(data).digest('hex');

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/**
 * Runs a set of async tasks with limited concurrency, returning the shape of `Promise.allSettled`
 * (order preserved)
 */
async function settleLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = { status: 'fulfilled', value: await work(items[i], i) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * Byte length of manifest JSON; throws `code: 'result-too-large'` if exceeding the limit (not
 * truncated, contract section 11, item 7)
 */
export function assertResultSize(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > RESULT_MAX_BYTES) throw fail(`Task manifest is ${bytes} bytes, over the limit of ${RESULT_MAX_BYTES}`, { code: 'result-too-large', bytes, retryable: false });
  return bytes;
}

const rangeOf = task => {
  const from = task?.range?.from, to = task?.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw fail(`Invalid task range: ${JSON.stringify(task?.range ?? null)}`, { retryable: false });
  return { from, to };
};

/* ======================================================================== *
 * Snapshots: task → on-disk location (E.9)
 * ======================================================================== */

/**
 * Where a snapshot task lands in the local frame store: `{ tier, entryKey, dirKey }`, returns null
 * if unrecognized (do not guess, contract section 11, item 3).
 *
 *   - Shared tier: `dirKey = resultKey`;
 *   - Local tier (E.9): `dirKey = resultKeyOf(content key without "<entryKey>/" prefix,
 *     task lock fingerprint)`, `entryKey = input.entryKey`, content key is `input.contentKey`,
 *     lock fingerprint is `requires.envFingerprint`. Returns null if any item is missing (or
 *     content key does not start with `<entryKey>/`).
 */
export function snapshotLocation(task) {
  const tier = task?.tier;
  if (tier === 'shared') return safeKey(task.resultKey) ? { tier, entryKey: null, dirKey: task.resultKey } : null;
  if (tier !== 'local') return null;
  const entryKey = task.input?.entryKey;
  const contentKey = task.input?.contentKey;
  const fp = task.requires?.envFingerprint;
  if (!safeKey(entryKey) || typeof contentKey !== 'string' || typeof fp !== 'string' || !fp) return null;
  const prefix = `${entryKey}/`;
  if (!contentKey.startsWith(prefix) || contentKey.length === prefix.length) return null;
  return { tier, entryKey, dirKey: resultKeyOf(contentKey.slice(prefix.length), fp) };
}

/**
 * On-disk location `{ tier, entryKey, dirKey }` directly provided by the caller: only recognized
 * if the shape matches; otherwise returns null (falls back to recomputing from the task)
 */
function checkLocation(location, tier) {
  if (!location || typeof location !== 'object') return null;
  const t = location.tier ?? tier;
  if (t === 'shared') return safeKey(location.dirKey) ? { tier: t, entryKey: null, dirKey: location.dirKey } : null;
  if (t === 'local') return safeKey(location.dirKey) && safeKey(location.entryKey) ? { tier: t, entryKey: location.entryKey, dirKey: location.dirKey } : null;
  return null;
}

/* ======================================================================== *
 * Manifests in the content store (C6.4, `manifest-contract.md` section 1)
 * ======================================================================== */

/**
 * Task kind → content store kind: snapshots `snapshot-manifest`, streams `render-manifest`; others
 * return null
 */
export function manifestKindOf(kind) {
  if (kind === 'snapshot') return 'snapshot-manifest';
  if (kind === 'stream') return 'render-manifest';
  return null;
}

/**
 * Manifest key in the content store: `<resultKey>:<from>-<to>`, i.e. task id without the `kind:`
 * prefix; returns null if anything is missing
 */
export function manifestKeyOf(ref) {
  const key = ref?.resultKey;
  const from = ref?.range?.from, to = ref?.range?.to;
  if (typeof key !== 'string' || !key || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return `${key}:${from}-${to}`;
}

/**
 * Whether the manifest retrieved from the content store can be used for this segment: `v`, `kind`,
 * `resultKey`, and `range` all match; snapshots additionally check the shape of `frames`, and
 * streams additionally check the fields required by `streamAdoption` (`header.clipIds`,
 * `header.originFrame`). Unrecognized fields are ignored (C6.2 section 3).
 */
export function manifestMatches(body, ref) {
  if (!body || typeof body !== 'object' || body.v !== RESULT_VERSION) return false;
  if (body.kind !== ref?.kind || body.resultKey !== ref?.resultKey) return false;
  if (body.range?.from !== ref?.range?.from || body.range?.to !== ref?.range?.to) return false;
  if (body.kind === 'snapshot') {
    if (!Array.isArray(body.frames)) return false;
    // c10a section 9: when `small` is present, its shape is the same as `frames`
    if (body.small !== undefined && !(Array.isArray(body.small) && body.small.every(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1]))))) return false;
    return body.frames.every(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1])));
  }
  if (body.kind === 'stream') {
    if (!body.header || !Array.isArray(body.header.clipIds) || !isStreamOrigin(body.header.originFrame)) return false;
    if (!body.segments || typeof body.segments !== 'object' || !body.inits || typeof body.inits !== 'object') return false;
    return true;
  }
  return false;
}

/**
 * The prerender small-size table in the manifest (`[[localFrame, hash, bytes], …]`); returns an
 * empty array if missing or incorrectly shaped
 */
export function smallFramesOf(result) {
  if (!Array.isArray(result?.small)) return [];
  return result.small.filter(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1])));
}

/* ======================================================================== *
 * c10a section 9: layer table for online pages (an entry of kind
 * `snapshot-manifest` in the content store, key `layers:<project id>`)
 * ======================================================================== */

/**
 * Key prefix for layer tables in the content store. It belongs to the same kind as segment
 * manifests (`snapshot-manifest`), with a colon prefix in the key so it will not collide with
 * `<resultKey>:<from>-<to>`
 */
export const LAYER_MAP_PREFIX = 'layers:';
/**
 * Layer table version. v 2 (C10 contract section 5, section 18 item 3): each layer adds
 * `contentKey` (environment-independent content key of the shared tier) and `envFingerprint`
 * (fingerprint of the environment that produced this layer). Online pages only recognize v 2 layers
 * with both items present; the lowest tier recognizes both v 1 and v 2 (`usableLayer` in
 * `src/render/snapshotSource.ts`).
 * v 3 (M7 contract D12, section 13 ruling): each layer additionally carries
 * `candidates: [{ envFingerprint, resultKey, key, dirKey }]`: after the splitter emits duplicate
 * keys, a layer may have two sets of keys (the splitter's own and the pure browser's), and which
 * one is alive is determined by the page based on `task.done` and the manifest; the v 2 fields on
 * the layer equal the first candidate, so pages reading v 2 can still use it as usual (treated as a
 * single candidate).
 * [ruling] stale-layer: v 3 layers may additionally carry `inputSig` (signature of the clip input
 * that generated this layer, `src/render/layerInputSig.mjs`). No version number bump: older pages do
 * not read this item and paste as before; newer pages encountering layers without this item
 * (written by older nodes) also paste as before.
 * Track streams (`docs/plan/browser-stream-task.md` part 5): v 3 layer tables can additionally
 * carry a `streams` table (`layerStreamsOf`), one row per stream. Likewise no version number bump:
 * older pages only read `layers` and ignore unrecognized fields; when there are no streams, this
 * item is omitted, keeping the layer table verbatim with earlier versions.
 */
export const LAYER_MAP_VERSION = 3;
export const layerMapKeyOf = projectId => (typeof projectId === 'string' && projectId ? LAYER_MAP_PREFIX + projectId : null);

/**
 * Layer table for a card plan version: the online page lacks a prerender process and cannot
 * compute keys for heavy cards (keys contain the render node's environment fingerprint and a hash
 * of snapshot code); written by the render node according to this version it claimed (the page does
 * not compute keys, C10 contract Section 5). Each item:
 *   `{ clipId, kind: 'html' | 'local', key(key on the ready index wire), tier, resultKey(first half of
 *      manifest key), dirKey, entryKey, firstFrame, count, contentKey(content key for shared tier),
 *      envFingerprint(environment that produced this layer) }`
 * This layer table is the only place where `contentKey` and `envFingerprint` take their final shape
 * (C10 contract Section 18, Item 3). Layers where these two items cannot be retrieved are still
 * listed; the online page treats them as "no prerender output".
 * Segments are split the same way as pushes and queue fine-grained tasks: one segment every `span`
 * frames starting from local frame 0, with the last segment up to `count - 1`, and manifest key
 * `<resultKey>:<from>-<to>`. Only lists cards that are in the prerender set and produce snapshots
 * (`picked` is provided by the caller).
 *
 * Candidates for v 3 (M7 D12): `candidatesOf(control)` returns the fingerprints that actually
 * produced keys during this card's most recent split (in publication order, collected by
 * `splitCandidatesOf`); candidates for the shared tier = these fingerprints, supplemented with this
 * layer's own fingerprint (those that haven't appeared are placed last); the v 2 field on the layer
 * takes the first candidate.
 * When `candidatesOf` is not provided or returns empty, there is only one candidate (itself), same
 * as v 2. The local tier has only one candidate (itself; a pure browser does not produce a local tier).
 */
export function layerMapOf(entry, { picked = () => true, fingerprint = null, span = QUEUE_DEFAULTS.SNAPSHOT_SPAN, now = Date.now(), candidatesOf = null,
  streams = null, streamCandidatesOf = null, streamSegments = QUEUE_DEFAULTS.STREAM_SEGMENTS } = {}) {
  const project = entry?.project ?? {};
  const layers = [];
  for (const control of entry?.cardPlan ?? []) {
    if (!control?.clipId || !control.snapshotKey || !picked(control.clipId)) continue;
    const tier = control.tier || null;
    const kind = kindOfTier(tier);
    if (!kind) continue;
    const key = wireSnapshotKey(tier, entry.key, control.snapshotKey);
    if (!key) continue;
    let resultKey = control.snapshotKey;
    const fp = typeof (control.envFingerprint ?? fingerprint) === 'string' && (control.envFingerprint ?? fingerprint) ? (control.envFingerprint ?? fingerprint) : null;
    if (tier === 'local') {
      if (!fp) continue;
      resultKey = resultKeyOf(`${entry.key}/${control.contentKey ?? control.snapshotKey}`, fp);
    }
    const firstFrame = Number(control.sampling?.firstFrame);
    const count = Number(control.count);
    if (!Number.isInteger(firstFrame) || !Number.isInteger(count) || count < 1) continue;
    const contentKey = typeof control.contentKey === 'string' && control.contentKey ? control.contentKey : null;
    const own = fp ? { envFingerprint: fp, resultKey, key, dirKey: control.snapshotKey } : null;
    let candidates = own ? [own] : [];
    if (tier === 'shared' && contentKey && typeof candidatesOf === 'function') {
      let listed = [];
      try { listed = candidatesOf(control) ?? []; } catch { listed = []; }
      const fps = [...new Set([...(Array.isArray(listed) ? listed : []), ...(fp ? [fp] : [])].filter(x => typeof x === 'string' && x))];
      candidates = fps.map(f => {
        if (own && f === fp) return own;
        const rk = resultKeyOf(contentKey, f);
        return { envFingerprint: f, resultKey: rk, key: wireSnapshotKey('shared', entry.key, rk), dirKey: rk };
      });
    }
    const primary = candidates[0] ?? { envFingerprint: fp, resultKey, key, dirKey: control.snapshotKey };
    // [ruling] stale-layer: input signature (`src/render/layerInputSig.mjs`): the clip input of the version
    // that generated this layer. The page computes the same signature based on the current project;
    // if it does not match, the layer has stale parameters and is not pasted (C10 contract Section 9).
    // If it cannot be computed (the clip is not in this version of the project), omit this item and the
    // page pastes it as before
    const inputSig = clipInputSig(project, control.clipId);
    layers.push({ clipId: control.clipId, kind, key: primary.key, tier, resultKey: primary.resultKey, dirKey: primary.dirKey,
      entryKey: tier === 'local' ? entry.key : null, firstFrame, count, contentKey, envFingerprint: primary.envFingerprint, candidates,
      ...(inputSig ? { inputSig } : {}) });
  }
  const streamRows = layerStreamsOf(entry, { streams, fingerprint, candidatesOf: streamCandidatesOf, segmentsPerTask: streamSegments });
  return {
    v: LAYER_MAP_VERSION, kind: 'layer-map', projectId: project.id ?? null, entryKey: entry?.key ?? null,
    fps: Number(project.fps) || 30, width: Number(project.width) || null, height: Number(project.height) || null,
    span, at: now, layers,
    ...(streamRows.length ? { streams: streamRows } : {}),
  };
}

/**
 * Key prefix for stream candidates in split candidate records
 * (`FramePipeline.recordSplitCandidates`) in the layer table: stream content keys and card
 * content keys are tracked separately
 */
export const STREAM_CANDIDATE_PREFIX = 'stream:';
export const streamCandidateKey = contentKey => (typeof contentKey === 'string' && contentKey ? STREAM_CANDIDATE_PREFIX + contentKey : null);

/**
 * The `streams` table of the layer table (`docs/plan/browser-stream-task.md` Section 5): one row
 * per track stream in this version; the online page uses it to locate stream manifests (content
 * store `render-manifest`, key `<resultKey>:<from>-<to>`, one part every `segmentsPerTask` segments
 * starting from segment 0, with the last part up to `lastSegment`, split the same way as
 * `render-node/split.mjs` and the push queue). Each row:
 *
 *   `{ topClipId, clipIds, kind: 'card' | 'group' | 'below', plane: 'local' | 'stage', contentKey,
 *      candidates: [{ envFingerprint, resultKey }], originFrame, lastSegment, segmentsPerTask, inputSig? }`
 *
 *   - `originFrame`: this stream's own first frame (project frame number). Segments are 15 frames
 *     each starting from it (`src/render/streamSegments.mjs`), and the page converts the playhead's
 *     frame number to a segment number using it. `firstSegment` is **no longer written** in the row
 *     (it is always 0) [ruling]: pages prior to the segmenting rule change recognized `firstSegment`
 *     and looked up segments by project frame number; reading a new row would paste frames
 *     misaligned. By omitting this item, parsing in old pages skips this row (treating the card as
 *     having no stream), while new pages only recognize rows with `originFrame`;
 *
 *   - Below-dependent streams (`kind: 'below'`, `docs/plan/prerender-products-contract.md` Section 5.2):
 *     `clipIds` contains only the target card, and `plane` is `stage`; lower layers factored into
 *     the key are not listed in this row: the page finds lower layers on its own based on the current
 *     project to compute `inputSig` (it can recognize even if an extra lower layer was added). When
 *     the `planStreams` toggle is off, there are no such streams, and this table is verbatim
 *     identical to before; pages reading this table skip any row with an unrecognized `kind`;
 *
 *   - `streams` is the result of `planStreams` in `frame-stream.mjs` (precomputed and passed in by
 *     caller: requires budget, code version, environment fingerprint; not imported here). When two
 *     clips share a single stream (same card, identical parameters and in point), `planStreams`
 *     returns two items, and here there are also two rows, with different `topClipId` but identical keys;
 *   - `candidates` follows the snapshot layer approach: `candidatesOf(spec)` returns the fingerprints
 *     that actually produced keys during this stream's most recent split (in publication order,
 *     collected by `splitStreamCandidatesOf`), supplemented with the stream's own fingerprint
 *     (`spec.envFingerprint`, or `fingerprint` if absent; those that haven't appeared are placed
 *     last). Result key = content key × fingerprint. When a stream is marked `ownCandidate: false`
 *     (the split only produced keys for other fingerprints and this machine does not produce it
 *     itself, which is what the online page's manifest plan produces for the browser), its own
 *     fingerprint is not added, and candidates consist only of those that actually produced keys
 *     during split. Streams for which not even one candidate can be found (no fingerprints at all)
 *     are not listed;
 *   - `inputSig`: this stream's input signature (`src/render/streamInputSig.mjs`); the page computes
 *     the same signature based on the current project and will not play if it does not match. Omit
 *     if it cannot be computed.
 * Items with an invalid shape are skipped without throwing.
 */
export function layerStreamsOf(entry, { streams = null, fingerprint = null, candidatesOf = null, segmentsPerTask = QUEUE_DEFAULTS.STREAM_SEGMENTS } = {}) {
  const project = entry?.project ?? {};
  const per = Math.max(1, Math.floor(Number(segmentsPerTask) || 0) || QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const str = x => (typeof x === 'string' && x ? x : null);
  const out = [];
  for (const spec of Array.isArray(streams) ? streams : []) {
    const contentKey = str(spec?.contentKey);
    const clipIds = Array.isArray(spec?.clipIds) ? spec.clipIds.filter(id => typeof id === 'string' && id) : [];
    if (!contentKey || !clipIds.length || clipIds.length !== spec.clipIds.length) continue;
    const topClipId = str(spec.topClipId) ?? clipIds[clipIds.length - 1];
    const kind = spec.kind === 'group' ? 'group' : spec.kind === 'card' ? 'card' : spec.kind === 'below' ? 'below' : null;
    const plane = spec.plane === 'stage' ? 'stage' : spec.plane === 'local' ? 'local' : null;
    // Below-dependent streams have only the target card as a member and use stage coordinates;
    // omit those with invalid shapes
    if (kind === 'below' && (clipIds.length !== 1 || plane !== 'stage')) continue;
    const firstSegment = Number(spec.firstSegment), lastSegment = Number(spec.lastSegment), originFrame = spec.originFrame;
    // Segments count from this stream's own first frame, and `firstSegment` is always 0;
    // omit those that are not (plans prior to the segmenting rule change)
    if (!kind || !plane || !isStreamOrigin(originFrame) || firstSegment !== 0 || !Number.isInteger(lastSegment) || lastSegment < 0) continue;
    // `ownCandidate: false`: for streams where splitting produced keys for other fingerprints and
    // this machine does not produce them (`FramePipeline.issuedStreamSpecs`), candidates only list
    // fingerprints that actually produced keys during splitting
    const own = spec.ownCandidate === false ? null : str(spec.envFingerprint) ?? str(fingerprint);
    let listed = [];
    if (typeof candidatesOf === 'function') {
      try { listed = candidatesOf(spec) ?? []; } catch { listed = []; }
    }
    const fps = [...new Set([...(Array.isArray(listed) ? listed : []), ...(own ? [own] : [])].filter(x => typeof x === 'string' && x))];
    if (!fps.length) continue;
    const candidates = fps.map(f => ({ envFingerprint: f, resultKey: resultKeyOf(contentKey, f) }));
    const inputSig = streamInputSig(project, { clipIds, kind });
    out.push({ topClipId, clipIds, kind, plane, contentKey, candidates, originFrame, lastSegment, segmentsPerTask: per, ...(inputSig ? { inputSig } : {}) });
  }
  return out;
}

/**
 * Fine-grained tasks successfully published in a split → fingerprints that actually produced
 * keys for each shared-tier card (M7 D12, used for writing layer table v 3 candidates):
 * `Map<contentKey, envFingerprint[]>`, fingerprints in publication order (splitter's own comes
 * first). Only collects shared-tier snapshot tasks with content keys and fingerprints.
 */
export function splitCandidatesOf(tasks) {
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.kind !== 'snapshot' || t.tier !== 'shared') continue;
    const ck = t.input?.contentKey;
    const fp = t.requires?.envFingerprint;
    if (typeof ck !== 'string' || !ck || typeof fp !== 'string' || !fp) continue;
    const list = out.get(ck) ?? [];
    if (!list.includes(fp)) list.push(fp);
    out.set(ck, list);
  }
  return out;
}

/**
 * Same as `splitCandidatesOf`, but collects track stream tasks (used for candidates in the layer
 * table `streams` table): `Map<streamContentKey, envFingerprint[]>`, with fingerprints in publication
 * order (splitter's own comes first). Only inspects fields common to stream tasks: `kind: 'stream'`,
 * `input.contentKey`, and `requires.envFingerprint`.
 */
export function splitStreamCandidatesOf(tasks) {
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.kind !== 'stream') continue;
    const ck = t.input?.contentKey;
    const fp = t.requires?.envFingerprint;
    if (typeof ck !== 'string' || !ck || typeof fp !== 'string' || !fp) continue;
    const list = out.get(ck) ?? [];
    if (!list.includes(fp)) list.push(fp);
    out.set(ck, list);
  }
  return out;
}

/**
 * Closed interval `[from, to]`: one segment every `span` from `first` .. `last`, with the last
 * segment up to `last` (same formula as `spans` in `render-node/split.mjs`)
 */
export function spansOf(first, last, span) {
  const out = [];
  const step = Math.max(1, Math.floor(Number(span) || 0));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += step) out.push([from, Math.min(last, from + step - 1)]);
  return out;
}

/**
 * `canvasHeavy`: checks `opts.canvasHeavy`, then `task.input.canvasHeavy` (when it is a boolean),
 * and falls back to false if neither is present (Section 11, Item 2)
 */
function canvasHeavyOf(task, opts) {
  if (typeof opts?.canvasHeavy === 'boolean') return opts.canvasHeavy;
  if (typeof task?.input?.canvasHeavy === 'boolean') return task.input.canvasHeavy;
  return false;
}

/* ======================================================================== *
 * Push side
 * ======================================================================== */

/** Reads chunks by "hash → file": passed to `readBlob` of `pushResult` */
const blobReader = files => async hash => {
  const file = files.get(hash);
  if (!file) throw fail(`The manifest has no chunk ${hash}`);
  // Track stream chunks have already been read into memory when listing the manifest
  // (see `collectStreamResult`): what gets pushed are the bytes from the moment the manifest was listed
  if (Buffer.isBuffer(file)) return file;
  return fs.readFile(file);
};

/**
 * Manifest for snapshot tasks (Contract Section 3, `SnapshotResult`): reads `frames` and `oversize`
 * from `index.json`, then reads corresponding frame files to compute hashes. Only lists frames
 * within this task's range that have already been written to disk (including oversized ones), in
 * ascending frame order.
 * Returns `{ result, readBlob }` (Section 11, Item 1).
 */
export async function collectSnapshotResult(pipeline, task, opts = {}) {
  if (task?.kind !== undefined && task.kind !== 'snapshot') throw fail(`Not a snapshot task: ${task.kind}`, { retryable: false });
  // C6.4: segments in the push queue carry their own on-disk location (`unit.dirKey` / `unit.entryKey`),
  // passed in via `opts.location`, and are no longer back-calculated per E.9
  const loc = checkLocation(opts?.location, task?.tier) ?? snapshotLocation(task);
  if (!loc) throw fail(`Cannot determine where to store the snapshot task result: ${task?.resultKey} (a local tier needs input.entryKey, input.contentKey, requires.envFingerprint)`, { code: 'unknown-location', retryable: false });
  const { from, to } = rangeOf(task);
  // c10a Section 9: this batch's prerender small size might still be generating (`writeSmallSnapshots`
  // in `frame-pipeline.mjs`); wait for it to settle before listing the manifest: pushing both tiers
  // together is required for this segment to be considered complete. This only waits without rendering
  // (proceeds immediately if none are generating)
  try { await pipeline.whenSmallSettled?.(); } catch { /* Small size failure does not block original size */ }
  const store = pipeline.snapshots();
  const target = { tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey };
  const index = await store.snapshotIndex(target);
  const dir = store.dir(target);
  const files = new Map();
  const frames = [];
  for (let f = from; f <= to; f++) {
    if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) continue;
    const file = path.join(dir, `${f}.html`);
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    const hash = sha256(buf);
    frames.push([f, hash, buf.length]);
    files.set(hash, file);
  }
  /*
   * c10a Section 9: hash table for prerender small size (`<localFrame>.small.webp`, WebP) is tracked
   * separately from `frames` of the original size: small size readiness cannot be treated as original
   * size readiness. Only lists frames whose original size is also within this segment; if there are
   * none, omit this item entirely (manifest remains verbatim identical to C6.4).
   */
  const small = [];
  for (const [f] of frames) {
    const file = path.join(dir, `${f}${SMALL_SUFFIX}`);
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    if (!buf.length) continue;
    const hash = sha256(buf);
    small.push([f, hash, buf.length]);
    files.set(hash, file);
  }
  let result = {
    v: RESULT_VERSION, kind: 'snapshot', tier: loc.tier,
    resultKey: task.resultKey, dirKey: loc.dirKey, entryKey: loc.tier === 'local' ? loc.entryKey : null,
    range: { from, to },
    canvasHeavy: canvasHeavyOf(task, opts),
    frames,
    ...(small.length ? { small } : {}),
  };
  assertResultSize(result);
  // X7: PNG cached frames for this segment. It is merely an attachment for the legacy full-frame
  // channel: omitted if including it causes the manifest to exceed size limits, and snapshots are
  // delivered as usual
  const pngs = await collectPngFrames(pipeline, loc, from, to, files);
  if (pngs.length) {
    const withPngs = { ...result, pngs };
    try { assertResultSize(withPngs); result = withPngs; } catch { /* Exceeds limit: omit PNG */ }
  }
  return { result, readBlob: blobReader(files) };
}

/* ======================================================================== *
 * X7: PNG cached frames attached to snapshot segment
 * ======================================================================== */

const pad6 = n => String(n).padStart(6, '0');
/** Card's PNG cache key (`key` of `CardFrameCache.plan`, result key, 64-character hex) */
const PNG_KEY_RE = KEY_RE;

/**
 * Which cards on this machine have PNG caches belonging to this snapshot on-disk location: among
 * live entries, controls that are `cacheable` (only they have PNG caches), have the same tier, and
 * whose shared key is this directory key (also recognizes its own `ownSnapshotKey` if the lock
 * changed keys). Returns `[{ key, cache, fps }]`, deduplicated by key.
 * When the same card is placed multiple times in the project, they share a single snapshot, but each
 * placement has its own PNG (the key includes position, aspect ratio, and `clipId`); list all of them.
 */
function pngSourcesFor(pipeline, loc) {
  const out = new Map();
  const entries = pipeline?.entries instanceof Map ? pipeline.entries.values() : [];
  for (const entry of entries) {
    if (!entry?.cardCache || !Array.isArray(entry.cardPlan)) continue;
    if (loc.tier === 'local' && entry.key !== loc.entryKey) continue;
    for (const control of entry.cardPlan) {
      if (!control?.cacheable || !PNG_KEY_RE.test(String(control.key))) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== loc.tier) continue;
      if (control.snapshotKey !== loc.dirKey && control.ownSnapshotKey !== loc.dirKey) continue;
      if (!out.has(control.key)) out.set(control.key, { key: control.key, cache: entry.cardCache, fps: Number(entry.project?.fps) || 30 });
    }
  }
  return [...out.values()];
}

/**
 * `pngs` in the manifest: `[{ key, fps, frames: [[localFrame, hash, bytes], …] }]`. Only lists
 * **valid** frames in the local PNG cache (`MovFrameStore.valid`: producer's capture matches card
 * key, and fully transparent frames are reconfirmed), in ascending frame order; bytes are raw as
 * on disk (including production records in PNG), hash is computed from raw data, and files are
 * recorded in `files` for `readBlob`. After reading, verify again against the record in the bytes:
 * the editor and prerender process share this directory, and files might have been replaced after
 * `valid`.
 */
async function collectPngFrames(pipeline, loc, from, to, files) {
  const out = [];
  for (const { key, cache, fps } of pngSourcesFor(pipeline, loc)) {
    let store, expected;
    try {
      store = await cache.store(key);
      expected = cache.expected(key);
      const wanted = [];
      for (let f = from; f <= to; f++) wanted.push(f);
      await store.hydrate(wanted);
    } catch { continue; }
    const frames = [];
    for (let f = from; f <= to; f++) {
      if (!store.valid(f, expected)) continue;
      const file = path.join(store.frameDir, `${pad6(f)}.png`);
      let buf;
      try { buf = await fs.readFile(file); } catch { continue; }
      const record = readRenderRecord(buf);
      if (!record?.signature || !signatureMatches(record.signature, expected)) continue;
      const hash = sha256(buf);
      frames.push([f, hash, buf.length]);
      files.set(hash, file);
    }
    if (frames.length) out.push({ key, fps, frames });
  }
  return out;
}

/**
 * Stream store directory structure matches `StreamStore` in `frame-stream.mjs`:
 * `<storeRoot>/streams/<streamKey>/`
 */
const streamDir = (pipeline, key) => path.join(pipeline.root, 'streams', key);

/**
 * Manifest of a stream in the stream store: reads `stream.json` directly from disk (saved by
 * producer after writing each segment)
 */
async function readStreamManifest(pipeline, key) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(streamDir(pipeline, key), 'stream.json'), 'utf8'));
    return manifest?.streamKey === key ? manifest : null;
  } catch { return null; }
}

/**
 * Manifest for track stream tasks (Contract Section 3, `StreamResult`): reads `stream.json`, lists
 * segments already produced in this task's range and their used inits; reads files for each chunk to
 * compute hashes. A segment's `encoder` takes the `encoder` of the init it uses (Section 11, Item 6).
 * Returns `{ result, readBlob }`. `opts` is currently unused, kept for symmetry with snapshots.
 */
export async function collectStreamResult(pipeline, task, opts = {}) {
  void opts;
  if (task?.kind !== undefined && task.kind !== 'stream') throw fail(`Not a track stream task: ${task.kind}`, { retryable: false });
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`Invalid resultKey for track stream task: ${key}`, { retryable: false });
  const { from, to } = rangeOf(task);
  const manifest = await readStreamManifest(pipeline, key);
  if (!manifest) throw fail(`This machine has no manifest for this stream: ${key}`, { code: 'no-stream-manifest' });
  const dir = streamDir(pipeline, key);
  const files = new Map();
  const inits = {};
  const segments = {};
  /*
   * Chunk bytes are kept in memory (only a few segments and head files in this task's range; reading
   * them once is needed anyway to compute hashes) and are not re-read from paths when pushing:
   * sparse version tasks and full density tasks for the same stream run concurrently on this machine
   * (identical result keys and directories); when the full density pass replaces a segment, old sparse
   * segment files are deleted after `REPLACED_DELETE_MS` (5 seconds) (`storeSegment` in
   * `frame-stream.mjs`). If a sparse task finishes listing the manifest and takes longer than 5 seconds
   * to push, re-reading by path results in ENOENT (production issue 2026-10-21:
   * `push-failed:ENOENT …/4-<hash>.m4s`, pushed 6/7). Pushing the bytes from the moment the manifest was
   * listed ensures the asset service receives them by hash, matching manifest and chunks consistently
   * without being affected by subsequent replacements.
   */
  const readHashed = async file => {
    const buf = await fs.readFile(file);
    const hash = sha256(buf);
    files.set(hash, buf);
    return { hash, bytes: buf.length };
  };
  for (let n = from; n <= to; n++) {
    const seg = manifest.segments?.[n];
    if (!seg?.file || !seg.init) continue;
    const initMeta = manifest.inits?.[seg.init];
    if (!initMeta) continue;
    let segBlob;
    try { segBlob = await readHashed(path.join(dir, seg.file)); } catch { continue; }
    if (!inits[seg.init]) {
      let initBlob;
      try { initBlob = await readHashed(path.join(dir, `init-${seg.init}.mp4`)); } catch { continue; }
      inits[seg.init] = { hash: initBlob.hash, bytes: initBlob.bytes, codec: initMeta.codec ?? null, width: initMeta.width ?? null, height: initMeta.height ?? null,
        timescale: initMeta.timescale ?? null, rect: initMeta.rect ?? null, encoder: initMeta.encoder ?? null };
    }
    // `box`: position rectangle of this segment (plane coordinates; measured when producing sparse version),
    // only included if present in the manifest
    segments[n] = { hash: segBlob.hash, bytes: segBlob.bytes, init: seg.init, stride: seg.stride, samples: seg.samples,
      sig: seg.sig ?? null, encoder: initMeta.encoder ?? null, ...(seg.box !== undefined ? { box: seg.box } : {}) };
  }
  // `lastFrame`: the stream's own last frame (project frame number), used when writing manifests to
  // calculate the whole stream's last segment and write by buckets (`src/render/streamBuckets.mjs`).
  // Takes `input.stream.lastFrame` from the task (the copy provided by the splitter for the browser,
  // carried by export bitmaps), or falls back to `stream.json` in the stream store (written by producer
  // per stream plan); if neither is present (streams written to disk by older nodes), omit it and
  // truncate buckets to task range when writing manifest
  const origin = isStreamOrigin(manifest.originFrame) ? manifest.originFrame : null;
  const span = task?.input?.stream;
  const taskLast = span && (span.originFrame === undefined || span.originFrame === origin) ? span.lastFrame : undefined;
  const lastFrame = [taskLast, manifest.lastFrame].find(v => Number.isInteger(v) && origin !== null && v >= origin) ?? null;
  const result = {
    v: RESULT_VERSION, kind: 'stream', resultKey: key, range: { from, to },
    // `originFrame`: the stream's own first frame (segments count from it). Omit if absent from the
    // manifest (written to disk before the segmenting rule change); such results are rejected elsewhere
    header: { kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
      ...(origin !== null ? { originFrame: origin } : {}), ...(lastFrame !== null ? { lastFrame } : {}), bound: manifest.bound,
      offset: manifest.offset ?? null, tight: manifest.tight ?? null },
    inits, segments,
  };
  assertResultSize(result);
  return { result, readBlob: blobReader(files) };
}

/** Chunks to push in manifest: `[{ ns, hash, ext }]`, deduplicated */
function resultBlocks(result) {
  const out = new Map();
  if (result?.kind === 'snapshot') {
    for (const [, hash] of result.frames ?? []) out.set(hash, { ns: SNAP_NS, hash, ext: 'html' });
    // c10a Section 9: prerender small size is a pixel artifact, goes into `px`
    for (const [, hash] of smallFramesOf(result)) if (!out.has(hash)) out.set(hash, { ns: PX_NS, hash, ext: 'webp' });
    // X7: attached PNG cached frames are pixel artifacts, go into `px`
    for (const item of validPngs(result)) for (const [, hash] of item.frames) if (!out.has(hash)) out.set(hash, { ns: PX_NS, hash, ext: 'png' });
  } else if (result?.kind === 'stream') {
    for (const meta of Object.values(result.inits ?? {})) out.set(meta.hash, { ns: PX_NS, hash: meta.hash, ext: 'mp4' });
    for (const seg of Object.values(result.segments ?? {})) out.set(seg.hash, { ns: PX_NS, hash: seg.hash, ext: 'm4s' });
  } else throw fail(`Unknown manifest kind: ${result?.kind}`, { retryable: false });
  for (const { hash } of out.values()) if (!KEY_RE.test(String(hash))) throw fail(`Invalid hash in the manifest: ${hash}`, { retryable: false });
  return [...out.values()];
}

/**
 * Calls `client.put` once for each chunk in the manifest (snapshots go into `snap`, streams into
 * `px`; `put` itself skips chunks that already exist on the asset service). Returns
 * `{ result, uploaded, skipped, bytes }` only when all succeed; throws if any chunk fails (first
 * error, with `stats`: push progress).
 * `onBlock({ blocks, pushed, bytes })` (optional, diagnostics): reports total blocks once at push
 * start, then reports after each block is pushed (`bytes` is the number of bytes pushed).
 */
export async function pushResult(client, result, readBlob, { onBlock } = {}) {
  if (!result || result.v !== RESULT_VERSION) throw fail('Unknown task manifest', { retryable: false });
  if (typeof readBlob !== 'function') throw fail('pushResult requires readBlob', { retryable: false });
  assertResultSize(result);
  const blocks = resultBlocks(result);
  let uploaded = 0, skipped = 0, bytesDone = 0;
  const tell = () => { try { onBlock?.({ blocks: blocks.length, pushed: uploaded + skipped, bytes: bytesDone }); } catch { /* Errors in diagnostic callbacks do not affect push */ } };
  tell();
  const settled = await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash, ext }) => {
    const bytes = await readBlob(hash);
    if (!bytes || sha256(bytes) !== hash) throw fail(`Content of chunk ${hash} does not match the manifest (the local file was modified after the manifest)`);
    const put = await client.put(ns, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { ext });
    if (put?.hash && put.hash !== hash) throw fail(`The hash ${put.hash} returned by the asset service differs from ${hash} in the manifest`);
    if (put?.uploaded) uploaded++; else skipped++;
    bytesDone += bytes.length;
    tell();
  });
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) {
    const reason = failed.reason;
    const stats = { blocks: blocks.length, pushed: uploaded + skipped, failed: settled.filter(item => item.status === 'rejected').length, bytes: bytesDone };
    if (reason && typeof reason === 'object') { try { reason.stats = stats; } catch { /* Frozen error object */ } }
    throw reason;
  }
  return { result, uploaded, skipped, bytes: bytesDone };
}

/**
 * Whether this stream task requires full-density segments: sparse stream tasks
 * (`input.density: 'sparse'`) accept any version per segment (sparse or full density), while other
 * stream tasks (full-density tasks, references without density) require every segment to be full
 * density. Returns false if not a stream.
 */
export const wantsDenseStream = ref => ref?.kind === 'stream' && !isSparseStreamTask(ref);
const sparseSegment = seg => Number(seg?.stride) > 1;

/**
 * Merges with the existing copy in the content store before writing stream manifest (same key:
 * identical result key and range), **without downgrade**:
 *   - When a segment in the new manifest is sparse but the existing segment is full density: keep
 *     existing (sparse stream task arrived late; another node already caught up with full density);
 *   - Segments missing in the new manifest but present in existing manifest: keep them (streaming
 *     manifests written during production only list segments already produced locally);
 *   - Use new for the rest. Kept segments are brought over along with their head files;
 *   - When a new segment lacks a position rectangle (`box`, measured only in the sparse pass) while
 *     the existing segment has one: carry it over (position rectangle remains after catching up to
 *     full density).
 * If the existing manifest does not match (not a stream, different key or range, invalid shape),
 * use new as-is. Returns `next` itself when nothing can be retained.
 */
export function mergeStreamResult(existing, next) {
  if (next?.kind !== 'stream' || !existing || typeof existing !== 'object' || existing.kind !== 'stream') return next;
  if (existing.v !== next.v || existing.resultKey !== next.resultKey) return next;
  if (existing.range?.from !== next.range?.from || existing.range?.to !== next.range?.to) return next;
  if (!existing.segments || typeof existing.segments !== 'object' || !existing.inits || typeof existing.inits !== 'object') return next;
  const segments = { ...(next.segments ?? {}) }, inits = { ...(next.inits ?? {}) };
  let kept = 0;
  for (const [n, old] of Object.entries(existing.segments)) {
    const init = old && typeof old === 'object' ? existing.inits[old.init] : null;
    if (!init || !KEY_RE.test(String(old.hash)) || !KEY_RE.test(String(init.hash))) continue;
    const cur = segments[n];
    if (cur && (!sparseSegment(cur) || sparseSegment(old))) {
      if (cur.box === undefined && old.box !== undefined) { segments[n] = { ...cur, box: old.box }; kept++; }
      continue;
    }
    segments[n] = old;
    if (!inits[old.init]) inits[old.init] = init;
    kept++;
  }
  return kept ? { ...next, inits, segments } : next;
}

/**
 * Whether local frame store covers this segment (snapshots: `frames ∪ oversize` covers every frame;
 * streams: every segment and its init are in the manifest, and full density tasks also require every
 * segment to be full density)
 */
async function coversRange(pipeline, ref) {
  const { from, to } = rangeOf(ref);
  if (ref.kind === 'snapshot') {
    const loc = snapshotLocation(ref);
    if (!loc) return false;
    const index = await pipeline.snapshots().snapshotIndex({ tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey });
    for (let f = from; f <= to; f++) if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) return false;
    return true;
  }
  if (ref.kind === 'stream') {
    if (!KEY_RE.test(String(ref.resultKey))) return false;
    const manifest = await readStreamManifest(pipeline, ref.resultKey);
    if (!manifest) return false;
    const dense = wantsDenseStream(ref);
    for (let n = from; n <= to; n++) {
      const seg = manifest.segments?.[n];
      if (!seg?.file || !manifest.inits?.[seg.init]) return false;
      if (dense && sparseSegment(seg)) return false;
    }
    return true;
  }
  return false;
}

/**
 * c10a Section 9 "Task completion condition: both tiers pushed successfully": every original-size
 * frame listed in the snapshot manifest also has a small-size counterpart.
 * Only required when the pipeline has small tier enabled (`pipeline.smallTierEnabled()`: push queue
 * configured, `PROMPTCUT_SMALL_TIER=0` not set); streams have no small size (Section 1), so always
 * true.
 */
export function smallComplete(result) {
  if (result?.kind !== 'snapshot') return true;
  const have = new Set(smallFramesOf(result).map(([f]) => f));
  return (result.frames ?? []).every(([f]) => have.has(f));
}
const wantsSmall = (pipeline, ref) => ref?.kind === 'snapshot' && typeof pipeline?.smallTierEnabled === 'function' && pipeline.smallTierEnabled() === true;

/**
 * Whether manifest lists every frame / segment in `range`; for `dense` (full-density stream tasks,
 * `wantsDenseStream`), each segment must also be full density
 */
function resultComplete(result, { dense = false } = {}) {
  const { from, to } = result.range;
  if (result.kind === 'snapshot') {
    const have = new Set(result.frames.map(([f]) => f));
    for (let f = from; f <= to; f++) if (!have.has(f)) return false;
    return true;
  }
  for (let n = from; n <= to; n++) {
    const seg = result.segments?.[n];
    if (!seg || !result.inits?.[seg.init]) return false;
    if (dense && sparseSegment(seg)) return false;
  }
  return true;
}

/**
 * Whether every chunk in the manifest exists on the asset service (calls `client.has` for each;
 * considered missing if any is missing or query fails)
 */
export async function blocksPresent(client, result) {
  if (typeof client?.has !== 'function') return false;
  let blocks;
  try { blocks = resultBlocks(result); } catch { return false; }
  let present = 0;
  let missing = false;
  await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash }) => {
    if (missing) return;
    let ok = false;
    try { ok = (await client.has(ns, hash)) === true; } catch { ok = false; }
    if (ok) present++; else missing = true;
  });
  return !missing && present === blocks.length;
}

/**
 * For diagnostics: chunk status on asset service in manifest `{ total, present, missing, errors, sample, error }`,
 * queries all without stopping early (only used when `has` returns false, where the subsequent path
 * rerenders the whole segment, so querying multiple times is not costly). `sample` contains hash
 * prefixes of the first two missing chunks, and `error` is the reason for the first failed query.
 */
async function blocksStatus(client, result) {
  if (typeof client?.has !== 'function') return { total: null, present: 0, missing: null, errors: 0, sample: [], error: 'client-has-missing' };
  let blocks;
  try { blocks = resultBlocks(result); } catch (error) { return { total: null, present: 0, missing: null, errors: 0, sample: [], error: String(error?.message ?? error).slice(0, 120) }; }
  let present = 0, errors = 0, firstError = null;
  const sample = [];
  await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash }) => {
    try {
      if ((await client.has(ns, hash)) === true) { present++; return; }
    } catch (error) {
      errors++;
      firstError ??= `${error?.code ?? error?.status ?? ''} ${String(error?.message ?? error)}`.trim().slice(0, 160);
    }
    if (sample.length < 2) sample.push(`${ns}/${hash.slice(0, 12)}`);
  });
  return { total: blocks.length, present, missing: blocks.length - present, errors, sample, error: firstError };
}

/**
 * For diagnostics: why manifest retrieved from content store cannot be used for this segment
 * (when `manifestMatches` returns false): first mismatched field
 */
function manifestMismatch(body, ref) {
  if (!body || typeof body !== 'object') return 'no-body';
  if (body.v !== RESULT_VERSION) return `v:${body.v}`;
  if (body.kind !== ref?.kind) return `kind:${body.kind}`;
  if (body.resultKey !== ref?.resultKey) return `resultKey:${String(body.resultKey).slice(0, 16)}`;
  if (body.range?.from !== ref?.range?.from || body.range?.to !== ref?.range?.to) return `range:${body.range?.from}-${body.range?.to}`;
  return `shape:${body.kind}`;
}

/**
 * Before writing stream manifest into content store, merges with the existing copy
 * (`mergeStreamResult`, without downgrade); uses new as-is if content store is unreadable,
 * unavailable, or exceeds size limits after merging. Snapshot manifests are returned as-is.
 */
export async function mergedForWrite(content, result) {
  if (result?.kind !== 'stream' || typeof content?.get !== 'function') return result;
  const kind = manifestKindOf(result.kind), key = manifestKeyOf(result);
  if (!kind || !key) return result;
  let existing = null;
  try { existing = (await content.get(kind, key))?.body ?? null; } catch { return result; }
  const merged = mergeStreamResult(existing, result);
  if (merged === result) return result;
  try { assertResultSize(merged); } catch { return result; }
  return merged;
}

async function writeSingleManifest(content, result, log = () => {}) {
  const kind = manifestKindOf(result?.kind);
  const key = manifestKeyOf(result);
  if (!content || typeof content.put !== 'function' || !kind || !key) return false;
  result = await mergedForWrite(content, result);
  try {
    assertResultSize(result);
  } catch (error) {
    safeLog(log, 'manifest.too-large', { kind, key, bytes: error?.bytes ?? null });
    return false;
  }
  try {
    await content.put(kind, key, result);
    return true;
  } catch (error) {
    safeLog(log, 'manifest.put-failed', { kind, key, code: error?.code ?? null, reason: error?.reason ?? null, message: String(error?.message ?? error) });
    return false;
  }
}

/**
 * Writes the manifest for a segment into the content store. Only logs and returns false on write
 * failure or when the manifest exceeds size limits (C6.4 Section 3: content store manifests are
 * only for future reuse).
 *
 * Track streams are additionally written as "8 segments per bucket" (`src/render/streamBuckets.mjs`,
 * the read side only looks up by bucket): the bucket end is capped at the **last segment of the whole
 * stream**, converted from `originFrame` / `lastFrame` in the manifest `header` (written by
 * `collectStreamResult`); if omitted from the manifest, falls back to `task` (optional, the task for
 * this segment) `input.stream`; if neither is present, truncates to task range. Thus, when task
 * `[0, 59]` is not the end of the stream, its last bucket is `56-63`, writing to the same key as
 * task `[60, 124]`, and both sides are merged into a single copy via `mergedForWrite`.
 */
export async function writeManifest(content, result, log = () => {}, task = null) {
  const kind = manifestKindOf(result?.kind);
  if (!content || typeof content.put !== 'function' || !kind || !result) return false;
  let ok = await writeSingleManifest(content, result, log);
  if (result.kind !== 'stream') return ok;
  const { from, to } = result.range ?? {};
  const lastSegment = streamLastSegmentOf(result.header) ?? streamLastSegmentOf(task?.input?.stream);
  for (const bucket of streamBucketRanges(from, to, lastSegment)) {
    if (bucket.from === from && bucket.to === to) continue;
    if (!(await writeSingleManifest(content, streamBucketManifest(result, bucket), log))) ok = false;
  }
  return ok;
}

function safeLog(log, event, fields) {
  try { log?.(event, fields); } catch { /* Logging errors do not affect pushing */ }
}

/**
 * Artifact sink for D.1 (`sink`), asset service implementation (C6.2 contract section 4,
 * section 11 items 3 and 7; C6.4 `manifest-contract.md` section 3).
 *
 *   - `has(ref, { report }?)`:
 *       1. Local frame store covers entire `range`: must also be complete on asset service to count
 *          as present (semantics "nodes push artifacts to asset service first, then report
 *          completion to document service", `docs/archive/agent-reports/AGENT-sink-has.md`). List
 *          manifest from local frame store, `pushResult` processes chunk by chunk "check chunks
 *          first, skip if already present", missing chunks are pushed using local bytes (no
 *          rerender); once completely pushed, write manifest to content store and return true; if
 *          catch-up push errors, return false (log `sink.has-push-failed`), pass to execution →
 *          `put` pushes again. `report` matches `put`, reported once per chunk during catch-up
 *          push (nodes compute progress from this); local covers original size, but small size is
 *          enabled and missing (frames pulled from another node's manifest: `applyResult` does not
 *          pull small size): only accept manifests in content store where **both tiers are
 *          complete** and chunks exist on asset service (return true, record it); otherwise return
 *          false, handing off to executor to fill in small size from local original size
 *          (`docs/archive/agent-reports/AGENT-xnode-dedup.md`);
 *       2. `content` provided: look up manifest in content store by `<resultKey>:<from>-<to>`.
 *          Manifest exists, manifest covers entire segment, and every chunk in manifest exists on
 *          asset service (one by one `client.has`); all three conditions met → true, and record
 *          manifest in sink (`resultFor` returns it);
 *       3. Otherwise → false. Before returning false, log a `sink.has-miss { reason, covered, … }`
 *          line (diagnostics, no behavior change): `reason` is `no-content` / `no-key` /
 *          `manifest-get-failed` / `manifest-missing` / `manifest-mismatch` (with `field`) /
 *          `manifest-incomplete` (with `listed`) / `blocks-missing` (with `total`, `present`,
 *          `missing`, `errors`, `sample`) / `local-small-missing`; local coverage with
 *          catch-up push errors still logs `sink.has-push-failed`.
 *   - `resultFor(ref)`: get manifest after `has` returns true (placed in `result` when M5b
 *     local-node completes via deduplication). If covered locally, computed on the fly by
 *     `collect*`; if found in content store, return the recorded copy; return null if neither.
 *   - `put({ ...ref, artifacts, meta })`: `artifacts` is ignored in this stage, bytes are based on
 *     local frame store. Run `collect*` then `pushResult`; return `{ complete: true, result }`
 *     after all chunks are pushed; return `{ complete: false }` if manifest misses frames, any chunk
 *     push fails, or manifest exceeds 256 KiB. On push success, if `content` was provided, write
 *     manifest to content store; write failures only log, without affecting response.
 *
 * `ref` carries task `input` and `requires` (passed as-is by M5b local-node). Local tier relies
 * on them to compute persistence key per E.9; if missing, `has` returns false, `put` returns
 * `{ complete: false }`, no guessing. `canvasHeavy` takes `ref.input.canvasHeavy`.
 */
/** Returned by asset service: "host render service artifacts reached capacity limit" */
export const SERVICE_QUOTA = 'service-quota';
/** Error thrown by asset client after exhausting 5xx retries: `status === 507` and `body.error === 'service-quota'` */
export const isServiceQuotaError = (error) => error?.status === 507 && error?.body?.error === SERVICE_QUOTA;

export function createAssetSink({ pipeline, client, content = null, log = () => {} }) {
  if (!pipeline) throw new Error('createAssetSink needs a pipeline');
  if (!client) throw new Error('createAssetSink needs an asset client');
  /** Manifest looked up from content store: manifest key → manifest */
  const remembered = new Map();
  const collect = ref => (ref?.kind === 'snapshot' ? collectSnapshotResult(pipeline, ref) : collectStreamResult(pipeline, ref));
  // Dedicated export frame-by-frame bitmap tasks (`export-frames.mjs`; a stream task type,
  // `input.exportFrames` is truthy) follow a different path: its frames are not in stream store,
  // and manifest has a different shape
  const exportFrames = createExportFramesSink({ root: pipeline.root, client, content, log });
  /**
   * Check whether manifest for this segment in content store can be used directly as result:
   * manifest exists, matches, covers entire segment, small size is fully listed (when `requireSmall`),
   * and all chunks exist on asset service. If usable, returns `{ ok: true, body }` and records it
   * (`resultFor` returns it); if not usable, returns `{ ok: false, reason, fields }` (the reason
   * for `sink.has-miss`).
   */
  async function lookup(ref, { requireSmall }) {
    if (!content || typeof content.get !== 'function') return { ok: false, reason: 'no-content', fields: {} };
    const kind = manifestKindOf(ref?.kind);
    const key = manifestKeyOf(ref);
    if (!kind || !key) return { ok: false, reason: 'no-key', fields: {} };
    const direct = await lookupKey(ref, kind, key, { requireSmall });
    if (direct.ok || ref?.kind !== 'stream') return direct;
    // No usable key for the task itself: search track stream by buckets (buckets written by tasks
    // of other shapes, such as full-stream sparse stream tasks or another split method); if not
    // completely found, return the above reason as usual
    return (await lookupBuckets(ref, kind, key, { requireSmall })) ?? direct;
  }

  /** Whether the manifest with key `key` in content store can be used as result for `ref` segment (see `lookup`) */
  async function lookupKey(ref, kind, key, { requireSmall }) {
    let item;
    try {
      item = await content.get(kind, key);
    } catch (error) {
      safeLog(log, 'manifest.get-failed', { kind, key, code: error?.code ?? null, message: String(error?.message ?? error) });
      return { ok: false, reason: 'manifest-get-failed', fields: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 160) } };
    }
    const body = item?.body;
    if (!item || body === undefined) return { ok: false, reason: 'manifest-missing', fields: {} };
    if (!manifestMatches(body, ref)) return { ok: false, reason: 'manifest-mismatch', fields: { field: manifestMismatch(body, ref) } };
    if (!resultComplete(body, { dense: wantsDenseStream(ref) })) {
      const listed = body.kind === 'snapshot' ? body.frames.length : Object.keys(body.segments ?? {}).length;
      return { ok: false, reason: 'manifest-incomplete', fields: { listed } };
    }
    if (requireSmall && !smallComplete(body)) return { ok: false, reason: 'no-small', fields: { small: smallFramesOf(body).length } };
    if (!(await blocksPresent(client, body))) {
      let status;
      try { status = await blocksStatus(client, body); } catch (error) { status = { error: String(error?.message ?? error).slice(0, 160) }; }
      return { ok: false, reason: 'blocks-missing', fields: status };
    }
    remembered.set(key, body);
    return { ok: true, body };
  }

  /**
   * Look up track streams by "8 segments per bucket" (`src/render/streamBuckets.mjs`, same rule as
   * `writeManifest`): take one copy per bucket, inspect only segments falling within task range,
   * and assemble into manifest for this segment; counts only if complete (full-density tasks also
   * require all to be full density) and all chunks exist on asset service. Bucket end truncated to
   * last segment of entire stream: takes task `input.stream`, or if not provided takes
   * `header.lastFrame` of already fetched buckets; when neither is known, only the end of the
   * bucket exceeding task end is uncertain, try possible ends one by one (try full 8 segments first,
   * then from task end forward). Returns null if assembly fails.
   */
  async function lookupBuckets(ref, kind, key, { requireSmall }) {
    const { from, to } = ref.range ?? {};
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
    const step = STREAM_BUCKET_SEGMENTS;
    const dense = wantsDenseStream(ref);
    let lastSegment = streamLastSegmentOf(ref.input?.stream);
    const segments = {}, inits = {};
    let header = null;
    for (let b = Math.floor(from / step) * step; b <= to; b += step) {
      const full = b + step - 1;
      const ends = lastSegment !== null ? [Math.min(Math.max(lastSegment, to), full)]
        : full <= to ? [full]
        : [full, ...Array.from({ length: full - to }, (_, i) => to + i)];
      let body = null;
      for (const end of ends) {
        if (b === from && end === to) continue; // Task's own key, already checked above
        let item;
        try { item = await content.get(kind, `${ref.resultKey}:${b}-${end}`); } catch { item = null; }
        if (item?.body !== undefined && manifestMatches(item.body, { kind: 'stream', resultKey: ref.resultKey, range: { from: b, to: end } })) { body = item.body; break; }
      }
      if (!body) return null;
      header ??= body.header;
      if (lastSegment === null) lastSegment = streamLastSegmentOf(body.header);
      for (let n = Math.max(from, b); n <= Math.min(to, full); n++) {
        const seg = body.segments[n];
        const init = seg ? body.inits[seg.init] : null;
        if (!seg || !init || (dense && sparseSegment(seg))) return null;
        segments[n] = seg;
        inits[seg.init] = init;
      }
    }
    const combined = { v: RESULT_VERSION, kind: 'stream', resultKey: ref.resultKey, range: { from, to }, header, inits, segments };
    if (!resultComplete(combined, { dense }) || (requireSmall && !smallComplete(combined))) return null;
    if (!(await blocksPresent(client, combined))) return null;
    remembered.set(key, combined);
    return { ok: true, body: combined };
  }
  return {
    async has(ref, { report } = {}) {
      if (isExportFramesTask(ref)) return exportFrames.has(ref);
      /** Log a `sink.has-miss` line before returning false (why deduplication was skipped; diagnostics, no behavior change) */
      const miss = (reason, fields = {}) => {
        safeLog(log, 'sink.has-miss', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), kind: ref?.kind ?? null, range: ref?.range ?? null, reason, ...fields });
        return false;
      };
      /*
       * c10a section 9: when small size is enabled, if local frame store covers entire segment but this
       * segment still lacks small size, local copy is not considered present. At this time, only accept
       * manifests in content store where **both tiers are complete** and chunks exist on asset service
       * (AGENT-xnode-dedup: a segment produced by another node where this machine pulled only original
       * size per manifest, `applyResult` does not pull small size, should deduplicate when claimed by
       * this machine after restart); if manifest lacks small size, hand off to executor to fill in small
       * size from local original size and push again (without rerendering original size). Do not accept
       * manifests lacking small size: that is likely written by local push queue while rendering,
       * original size complete but small size missing; accepting it leaves this segment permanently
       * lacking small size.
       */
      let covered = false;
      try { covered = await coversRange(pipeline, ref); } catch { covered = false; /* Treat as not present locally */ }
      if (covered) {
        let collected;
        try { collected = await collect(ref); } catch { collected = null; }
        if (collected && resultComplete(collected.result, { dense: wantsDenseStream(ref) }) && (!wantsSmall(pipeline, ref) || smallComplete(collected.result))) {
          // Present locally, must also be complete on asset service: when a claim is lost midway
          // through pushing and re-claimed by itself, missing chunks are completed here, otherwise other
          // members cannot retrieve by manifest
          const tell = (fields) => { try { report?.(fields); } catch { /* Errors in diagnostic callbacks do not affect push */ } };
          tell({ stage: 'has-push' });
          try {
            const pushed = await pushResult(client, collected.result, collected.readBlob, { onBlock: (p) => tell(p) });
            if (content) await writeManifest(content, collected.result, log, ref);
            if (pushed.uploaded > 0) {
              safeLog(log, 'sink.has-pushed', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null, uploaded: pushed.uploaded, skipped: pushed.skipped });
            }
            return true;
          } catch (error) {
            safeLog(log, 'sink.has-push-failed', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null,
              code: error?.code ?? error?.status ?? null, message: String(error?.message ?? error).slice(0, 200), ...(error?.stats ?? {}) });
            return false;
          }
        }
        // Covered locally, but manifest is incomplete (missing small size, c10a section 9): only
        // accept manifests in content store with both tiers complete (see above), otherwise hand off to
        // executor to fill in and push
        if (collected && wantsSmall(pipeline, ref)) {
          const found = await lookup(ref, { requireSmall: true });
          if (found.ok) return true;
          if (found.reason === 'blocks-missing') return miss('blocks-missing', { covered: true, ...found.fields });
          return miss('local-small-missing', { covered: true, manifest: found.reason, ...found.fields });
        }
      }
      const found = await lookup(ref, { requireSmall: false });
      return found.ok ? true : miss(found.reason, { covered, ...found.fields });
    },
    async resultFor(ref) {
      if (isExportFramesTask(ref)) return exportFrames.resultFor(ref);
      try {
        if (await coversRange(pipeline, ref)) {
          const { result } = await collect(ref);
          if (resultComplete(result, { dense: wantsDenseStream(ref) }) && (!wantsSmall(pipeline, ref) || smallComplete(result))) return result;
          // Local copy lacks small size: `has` accepted the one in content store with both tiers
          // complete (recorded), return it
        }
      } catch { /* Fall back to recorded manifest */ }
      const key = manifestKeyOf(ref);
      return key && remembered.has(key) ? remembered.get(key) : null;
    },
    /**
     * Second argument (optional, diagnostics): `report({ stage, blocks, pushed, bytes })`: `stage` is
     * `collect` (list manifest) / `push` (push chunks); reported once after each chunk is pushed
     * during push. When not fully received, response also includes `reason` (why) and `stats`
     * (`{ blocks, pushed, bytes, ms }`), and logs a `sink.incomplete` line; when fully received,
     * response includes `stats`.
     */
    async put(ref, { report } = {}) {
      if (isExportFramesTask(ref)) return exportFrames.put(ref, { report });
      const started = Date.now();
      const tell = (fields) => { try { report?.(fields); } catch { /* Errors in diagnostic callbacks do not affect push */ } };
      let progress = { blocks: null, pushed: 0, bytes: 0 };
      let stage = 'collect';
      const stats = () => ({ ...progress, ms: Date.now() - started });
      const incomplete = (reason, extra = {}) => {
        const out = { complete: false, reason, stats: stats() };
        safeLog(log, 'sink.incomplete', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, reason, ...out.stats, ...extra });
        return out;
      };
      try {
        if (ref?.kind !== 'snapshot' && ref?.kind !== 'stream') return incomplete('bad-kind');
        tell({ stage: 'collect' });
        const collected = await collect(ref);
        if (!resultComplete(collected.result, { dense: wantsDenseStream(ref) })) {
          const listed = ref.kind === 'snapshot' ? collected.result.frames.length : Object.keys(collected.result.segments ?? {}).length;
          return incomplete('range-missing', { listed });
        }
        // c10a section 9: considered complete only when both tiers push successfully; returns
        // incomplete if small size is missing, node hands back as retryable failure, filled in when redone
        if (wantsSmall(pipeline, ref) && !smallComplete(collected.result)) {
          safeLog(log, 'sink.small-incomplete', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null,
            frames: collected.result.frames.length, small: smallFramesOf(collected.result).length });
          return incomplete('small-missing', { frames: collected.result.frames.length, small: smallFramesOf(collected.result).length });
        }
        stage = 'push';
        tell({ stage });
        await pushResult(client, collected.result, collected.readBlob, {
          onBlock: (p) => { progress = p; tell(p); },
        });
        if (content) await writeManifest(content, collected.result, log, ref);
        return { complete: true, result: collected.result, stats: stats() };
      } catch (error) {
        // Asset service says host render service artifacts reached capacity limit (507 `service-quota`,
        // `docs/plan/hosted-render-contract.md` section 6): retrying is useless, throw as non-retryable
        // failure; node pauses claiming accordingly (`render-node/host.mjs`)
        if (isServiceQuotaError(error)) {
          safeLog(log, 'sink.service-quota', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, ...stats() });
          throw Object.assign(new Error(SERVICE_QUOTA), { code: SERVICE_QUOTA, status: 507, retryable: false });
        }
        const code = error?.code ?? error?.status ?? null;
        return incomplete(`${stage}-failed${code !== null ? `:${String(code).slice(0, 40)}` : ''}`, { message: String(error?.message ?? error).slice(0, 200) });
      }
    },
  };
}

/* ======================================================================== *
 * Pull side
 * ======================================================================== */

function checkSnapshotResult(result) {
  const bad = why => { throw fail(`Invalid snapshot manifest: ${why}`, { retryable: false }); };
  if (result.tier !== 'shared' && result.tier !== 'local') bad(`tier = ${result.tier}`);
  if (!safeKey(result.dirKey)) bad('dirKey');
  if (result.tier === 'local' && !safeKey(result.entryKey)) bad('Local tier is missing entryKey');
  const { from, to } = result.range ?? {};
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  if (!Array.isArray(result.frames)) bad('frames');
  for (const item of result.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] < from || item[0] > to || !KEY_RE.test(String(item[1]))) bad(`Frame ${JSON.stringify(item)}`);
  }
}

/**
 * Pull a range of artifacts into local frame store per task manifest and publish (contract
 * section 5). Returns `{ written, skipped, fetched }` (section 11 item 8): frame / segment count
 * actually persisted to disk, skipped because already present locally, and chunk count downloaded
 * from asset service (including init).
 *
 *   Snapshot: frames already in local `index.json` (`frames` or `oversize`) are not downloaded;
 *             rest are pulled from `snap` by hash, persisted in batches via `commitSnapshots`
 *             (oversize determined by itself), finally published via `pipeline.adoptResult`. If a
 *             chunk cannot be fetched (404) or is corrupted: fetched chunks are persisted and
 *             published normally, then throw overall error (leaves no half files).
 *   Stream:   ask producer which chunks are needed first (`adoptionNeeds`), pull only those chunks
 *             from `px`, hand to `adoptSegments` to persist and publish; segments corresponding
 *             to unfetchable chunks are not accepted, rest accepted as usual, then throw overall
 *             error. If no producer on pipeline (`streamProducer()` returns null, i.e.
 *             `interactive: false` or already closed), throw `code: 'no-stream-producer'`.
 */
export async function applyResult(pipeline, client, result) {
  if (!result || typeof result !== 'object' || result.v !== RESULT_VERSION) throw fail('Unknown task manifest', { retryable: false });
  if (result.kind === 'snapshot') return applySnapshotResult(pipeline, client, result);
  if (result.kind === 'stream') return applyStreamResult(pipeline, client, result);
  throw fail(`Unknown manifest kind: ${result.kind}`, { retryable: false });
}

async function fetchBlock(client, ns, hash) {
  const buf = await client.get(ns, hash);
  if (buf === null || buf === undefined) throw fail(`Chunk ${ns}/${hash} is not on the asset service`, { code: 'blob-missing', status: 404 });
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sha256(bytes) !== hash) throw fail(`Content of chunk ${ns}/${hash} does not match its hash`, { code: 'blob-corrupt' });
  return bytes;
}

async function applySnapshotResult(pipeline, client, result) {
  checkSnapshotResult(result);
  const store = pipeline.snapshots();
  const entryKey = result.tier === 'local' ? result.entryKey : null;
  const target = { tier: result.tier, entryKey, key: result.dirKey };
  const index = await store.snapshotIndex(target);
  const seen = new Set();
  const want = [];
  for (const item of result.frames) {
    if (seen.has(item[0])) continue;
    seen.add(item[0]);
    if (rangeHas(index.frames, item[0]) || rangeHas(index.oversize, item[0])) continue;
    want.push(item);
  }
  const skipped = seen.size - want.length;
  const capabilities = { canvasHeavy: result.canvasHeavy === true };
  let written = 0, fetched = 0, failure = null;
  for (let i = 0; i < want.length && !failure; i += APPLY_BATCH) {
    const batch = want.slice(i, i + APPLY_BATCH);
    const settled = await settleLimited(batch, TRANSFER_CONCURRENCY, ([, hash]) => fetchBlock(client, SNAP_NS, hash));
    const items = [];
    settled.forEach((item, k) => {
      if (item.status === 'rejected') { failure ||= item.reason; return; }
      fetched++;
      const html = item.value.toString('utf8');
      // Snapshots written to disk as UTF-8 text (`commitSnapshots` convention): chunks whose
      // decoded-and-re-encoded bytes do not match original bytes are rejected
      if (!Buffer.from(html, 'utf8').equals(item.value)) { failure ||= fail(`Snapshot chunk ${batch[k][1]} is not valid UTF-8`, { code: 'blob-corrupt' }); return; }
      items.push({ localFrame: batch[k][0], html });
    });
    if (items.length) {
      // `adopted: true`: this batch of frames was pulled from asset service; C6.4 push hook uses
      // this to avoid enqueuing them to push queue (snapshot store itself ignores this field)
      await store.commitSnapshots({ ...target, clipId: null, capabilities, items, adopted: true });
      written += items.length;
    }
  }
  await pipeline.adoptResult(result);
  // X7: if manifest carries PNG cache frames, fetch them together. Unfetchable or mismatched
  // chunks only increment count without failing persistence of this snapshot segment (PNG is only
  // material for legacy channel)
  const png = await applyPngFrames(pipeline, client, result);
  fetched += png.fetched;
  if (failure) throw failure;
  return png.listed ? { written, skipped, fetched, png } : { written, skipped, fetched };
}

/**
 * Items in manifest `pngs` with matching shapes (skip incorrect items and incorrect frames,
 * preventing whole segment from failing: unrecognized / invalid attachments treated as "ignored"):
 * key is 64-bit hex; frame number is in `range`, hash is 64-bit hex; keep only the first entry for
 * the same frame of the same key.
 */
function validPngs(result) {
  if (!Array.isArray(result?.pngs)) return [];
  const { from, to } = result.range ?? {};
  const out = [];
  const keys = new Set();
  for (const item of result.pngs) {
    if (!item || typeof item !== 'object' || !PNG_KEY_RE.test(String(item.key)) || keys.has(item.key) || !Array.isArray(item.frames)) continue;
    keys.add(item.key);
    const seen = new Set();
    const frames = [];
    for (const frame of item.frames) {
      if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || frame[0] < from || frame[0] > to || !KEY_RE.test(String(frame[1])) || seen.has(frame[0])) continue;
      seen.add(frame[0]);
      frames.push(frame);
    }
    const fps = Number(item.fps);
    if (frames.length) out.push({ key: item.key, fps: Number.isFinite(fps) && fps > 0 ? fps : 30, frames });
  }
  return out;
}

/**
 * Which `MovFrameStore` this machine uses to write PNG cache for this key: if an entry's card plan
 * uses this key, use that entry's `CardFrameCache.store(key)` (same instance as legacy channel
 * and `renderState`); if none, open another in the same directory (`controls/<key>/`, same as
 * `CardFrameCache.store`), as this directory is already shared across processes, and
 * `MovFrameStore` reads disk on every lookup. `expected` is the output record recognized when
 * this machine looks up this key: local capture plus card key.
 */
async function pngTargetFor(pipeline, key, fps) {
  const entries = pipeline?.entries instanceof Map ? pipeline.entries.values() : [];
  for (const entry of entries) {
    if (!entry?.cardCache || !Array.isArray(entry.cardPlan)) continue;
    if (!entry.cardPlan.some(control => control?.key === key)) continue;
    return { store: await entry.cardCache.store(key), expected: entry.cardCache.expected(key) };
  }
  const store = new MovFrameStore({ dir: path.join(pipeline.root, 'controls', key), fps });
  await store.ready;
  const capture = typeof pipeline?.captureCode === 'function' ? pipeline.captureCode() || undefined : undefined;
  return { store, expected: { capture, cards: key } };
}

/**
 * X7 pull: for each PNG key and each frame in manifest:
 *   1. If this frame is already valid locally (`valid`, per local capture and card key), skip and
 *      do not download;
 *   2. Otherwise pull from `px`, verify sha256;
 *   3. Output record in bytes must be from PNG metadata and match the record recognized locally
 *      (same frame capture code, same card key); reject if mismatched (local lookup would also
 *      treat it as non-existent; accepting it would only lead to eviction);
 *   4. Persist as-is via `MovFrameStore.put`, including render passes recorded by peer (fully
 *      transparent frames already reconfirmed by peer are no longer treated as pending
 *      confirmation locally).
 * Returns `{ listed, written, skipped, fetched, mismatched, failed }` (frame counts; `fetched` is
 * downloaded chunk count).
 */
async function applyPngFrames(pipeline, client, result) {
  const stats = { listed: 0, written: 0, skipped: 0, fetched: 0, mismatched: 0, failed: 0 };
  for (const { key, fps, frames } of validPngs(result)) {
    stats.listed += frames.length;
    let target;
    try { target = await pngTargetFor(pipeline, key, fps); } catch { stats.failed += frames.length; continue; }
    const { store, expected } = target;
    try { await store.hydrate(frames.map(([f]) => f)); } catch { /* Treat as not present locally */ }
    const want = frames.filter(([f]) => {
      if (store.valid(f, expected)) { stats.skipped++; return false; }
      return true;
    });
    const settled = await settleLimited(want, TRANSFER_CONCURRENCY, ([, hash]) => fetchBlock(client, PX_NS, hash));
    for (let i = 0; i < want.length; i++) {
      const item = settled[i];
      if (item.status === 'rejected') { stats.failed++; continue; }
      stats.fetched++;
      const bytes = item.value;
      const record = readRenderRecord(bytes);
      if (!record?.signature || record.signature.cards !== key || !signatureMatches(record.signature, expected)) { stats.mismatched++; continue; }
      try {
        await store.put(want[i][0], bytes, record.signature, { renders: Number(record.renders) || 1 });
        stats.written++;
      } catch { stats.failed++; }
    }
  }
  return stats;
}

async function applyStreamResult(pipeline, client, result) {
  const producer = typeof pipeline?.streamProducer === 'function' ? pipeline.streamProducer() : null;
  if (!producer) throw fail('This prerender instance has no track stream producer (interactive: false or already closed), so it cannot receive stream manifests', { code: 'no-stream-producer', retryable: false });
  const needs = await producer.adoptionNeeds(result);
  const wanted = new Set(needs.segments);
  const settled = await settleLimited(needs.hashes, TRANSFER_CONCURRENCY, hash => fetchBlock(client, PX_NS, hash));
  const blobs = new Map();
  let fetched = 0, failure = null;
  settled.forEach((item, i) => {
    if (item.status === 'rejected') { failure ||= item.reason; return; }
    fetched++;
    blobs.set(needs.hashes[i], item.value);
  });
  // Only pass segments missing locally and with complete bytes to adoptSegments (it skips
  // writing entirely if chunks are missing)
  const segments = {};
  let total = 0;
  for (const [n, seg] of Object.entries(result.segments ?? {})) {
    total++;
    if (!wanted.has(Number(n)) || !blobs.has(seg.hash)) continue;
    const initHash = result.inits?.[seg.init]?.hash;
    if (initHash && needs.hashes.includes(initHash) && !blobs.has(initHash)) continue;
    segments[n] = seg;
  }
  const adopted = Object.keys(segments).length
    ? await producer.adoptSegments({ ...result, segments }, blobs)
    : { written: 0, skipped: 0 };
  if (failure) throw failure;
  return { written: adopted.written, skipped: adopted.skipped + (total - wanted.size), fetched };
}
