/**
 * For testing only, must not be referenced by production code.
 *
 * Shared fixtures for the three C6.4 artifact tests (`artifact-dedup` / `artifact-push` /
 * `artifact-adopt`), following the style of `artifact-transfer.test.mjs` in C6.2:
 *
 *   - Environment and fingerprint: `OWN_ENV` (the two FramePipelines' own environments),
 *     `TASK_FP` (the task's lock fingerprint, intentionally different from it);
 *   - Tasks (TaskView, shapes of B.4 / E.5 / E.9 / F.1): `snapshotTask`, `streamTask`;
 *     `dirKeyOf`, `manifestKey`, `refOf`;
 *   - Snapshots: `htmlOf`, `bigHtml`, `dataImageHtml`, `seedSnapshots`; streams:
 *     `writeStreamFixture` (manually crafted in the format of `frame-stream.mjs`);
 *   - Frame store: `makeRoots(FramePipeline)` creates temporary frame stores and pipelines,
 *     `cleanup()` closes pipelines and deletes directories;
 *   - Services: `startServices(harness)` starts the asset service (memory, port 0) and document
 *     service (content store, memory, port 0), returning `{ srv, client, docs, content, cleanup }`;
 *   - Other: `unpack` (return value of `collect*`), `wire` (JSON round-trip), `filesOf`,
 *     `watchEntry`, `staged`, `range`.
 *
 * References `frame-stream.mjs` (for `segmentSignature`), so dynamically import this file after
 * the test file runs `mock.module` on `bakery/index.mjs`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { segmentSignature } from '../frame-stream.mjs';
import { describeEnvironment, resultKeyOf } from '../render-node/fingerprint.mjs';
import { startContentService, connectContent } from './fake-manifest-env.mjs';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha16 = (buf) => sha256(buf).slice(0, 16);
export const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
export const wire = (v) => JSON.parse(JSON.stringify(v));

export const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
export const TASK_FP = describeEnvironment({
  platform: 'Win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)',
  chromeVersion: 'HeadlessChrome/138.0.7204.49',
}).fingerprint;
assert.notEqual(TASK_FP, OWN_ENV.fingerprint);

export const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };
export const LOCAL_CAPS = { compositing: 'belowDependent', frameMode: 'stateful' };
export const CANVAS_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true };

export function snapshotTask({ tier = 'shared', contentKey, entryKey = null, from, to, clipId = 'clip-x', fp = TASK_FP }) {
  const inputKey = tier === 'local' ? `${entryKey}/${contentKey}` : contentKey;
  const resultKey = resultKeyOf(inputKey, fp);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier, resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: tier === 'local' ? entryKey : null, contentKey: inputKey },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: tier === 'local' },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}
/**
 * On-disk key for shared tier = result key; local tier = resultKeyOf(content key stripped of
 * entryKey prefix, task lock fingerprint) (E.9)
 */
export const dirKeyOf = (task) => (task.tier === 'local'
  ? resultKeyOf(task.input.contentKey.slice(task.input.entryKey.length + 1), task.requires.envFingerprint)
  : task.resultKey);

export function streamTask({ streamKey, contentKey, from, to, clipId = 'clip-s', fp = TASK_FP }) {
  return {
    id: `stream:${streamKey}:${from}-${to}`, kind: 'stream', resultKey: streamKey,
    range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: null, contentKey },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}

/** Content store manifest key: `<resultKey>:<from>-<to>` (Section 1 of the contract) */
export const manifestKey = (task) => `${task.resultKey}:${task.range.from}-${task.range.to}`;
/** Manifest kind: snapshot → snapshot-manifest, stream → render-manifest */
export const manifestKind = (task) => (task.kind === 'stream' ? 'render-manifest' : 'snapshot-manifest');
/** Sink ref (C6.2 Section 11 Item 3: includes task input and requires) */
export const refOf = (t) => ({ resultKey: t.resultKey, kind: t.kind, tier: t.kind === 'stream' ? null : t.tier, range: t.range, input: t.input, requires: t.requires });
export const metaOf = (t) => ({ taskId: t.id, nodeId: 'node-1', token: 1 });

export const htmlOf = (n, tag = 'A') => `<div data-pc-scene="" data-f="${n}">${tag} frame ${n} ${'·'.repeat(n % 7)}</div>`;
export const bigHtml = (n = 0) => `<div data-pc-scene="" data-f="${n}">${'x'.repeat(310 * 1024)}</div>`;
/**
 * One frame of HTML where `data:image` accounts for approximately `share` (measured by
 * `dataImageBytes` in `scripts/archive/probes/snapshot-size-probe.mjs` (probe archived 2026-10-23,
 * the algorithm is copied here and unaffected): number of characters matching
 * `data:image/<type>;base64,<base64>`, divided by total UTF-8 bytes of the full frame).
 */
export function dataImageHtml(n, share, total = 8000) {
  const img = Math.round(total * share);
  const uri = `data:image/png;base64,${'A'.repeat(Math.max(1, img - 'data:image/png;base64,'.length - 1))}${String.fromCharCode(66 + (n % 20))}`;
  const head = `<div data-pc-scene="" data-f="${n}"><img src="`;
  const tail = `">`;
  const pad = Math.max(0, total - head.length - uri.length - tail.length - 6);
  return `${head}${uri}${tail}${'p'.repeat(pad)}</div>`;
}
/**
 * Same algorithm as `dataImageBytes` in `scripts/archive/probes/snapshot-size-probe.mjs`
 * (archived 2026-10-23) (copied, does not reference probe)
 */
const DATA_IMG = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
export const dataImageBytes = (s) => { let n = 0; for (const m of (s || '').match(DATA_IMG) || []) n += m.length; return n; };

/**
 * Write `frames` into the pipeline frame store (via `commitSnapshots`, the sole entry point for
 * writing snapshots)
 */
export async function seedSnapshots(pipeline, task, frames, { html = htmlOf, tag = 'A', capabilities, clipId } = {}) {
  const caps = capabilities ?? (task.tier === 'local' ? LOCAL_CAPS : SHARED_CAPS);
  const items = frames.map((n) => ({ localFrame: n, html: html(n, tag) }));
  return pipeline.snapshots().commitSnapshots({
    tier: task.tier, entryKey: task.input.entryKey ?? undefined, key: dirKeyOf(task), clipId: clipId ?? task.input.clipId, capabilities: caps, items,
  });
}

/** Return value of `collect*` (C6.2 Section 11 Item 1: `{ result, readBlob }`) */
export function unpack(out) {
  assert.ok(out && typeof out === 'object', 'collect* must return an object');
  const direct = out.v !== undefined || out.kind !== undefined;
  const result = direct ? out : out.result;
  const readBlob = direct ? out.readBlob : (out.readBlob ?? out.result?.readBlob);
  assert.ok(result && typeof result === 'object', 'Cannot get the manifest (result)');
  assert.equal(typeof readBlob, 'function', 'collect* must also provide readBlob(hash)');
  return { result: wire(result), readBlob, raw: result };
}

export async function filesOf(dir) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return {}; }
  const out = {};
  for (const name of names.sort()) {
    const st = await fs.stat(path.join(dir, name));
    if (st.isFile()) out[name] = await fs.readFile(path.join(dir, name));
  }
  return out;
}

/** Recursively list all files in a directory tree: { relativePath: Buffer } */
export async function treeOf(dir) {
  const out = {};
  const walk = async (d, rel) => {
    let items = [];
    try { items = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(p, r);
      else out[r] = await fs.readFile(p);
    }
  };
  await walk(dir, '');
  return out;
}

export const A_ENCODER = 'h264_nvenc';
export const B_ENCODER = 'libx264';

/**
 * Manually construct a stream under root following the `frame-stream.mjs` format (bytes are
 * synthetic, not real fMP4). Returns { manifest, files, dir }
 */
export async function writeStreamFixture(root, { streamKey, segments, encoder = A_ENCODER, seed = 1, originFrame = 0, lastFrame }) {
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const bound = { x: 0, y: 0, w: 64, h: 64 };
  const tight = { x: 8, y: 8, w: 48, h: 48 };
  const init1 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init1-${seed}`).digest()]);
  const id1 = sha16(init1);
  const files = { [`init-${id1}.mp4`]: init1 };
  const manifest = {
    // `originFrame`: this stream's own first frame (segment indexing starts from it); results
    // without it in manifest are rejected elsewhere (`streamAdoption`)
    // `lastFrame` (written only if provided): this stream's own last frame, included in manifest
    // header when pushing (used to truncate the 8-segment bucket boundary when writing to content store)
    version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['clip-s'], fps: 30, originFrame, ...(Number.isInteger(lastFrame) ? { lastFrame } : {}), bound, offset: { x: 32, y: 32 }, tight,
    inits: { [id1]: { codec: 'avc1.64001f', width: 48, height: 96, timescale: 15360, rect: tight, encoder, bytes: init1.length } },
    segments: {},
  };
  for (const n of segments) {
    const bytes = Buffer.concat([Buffer.from('....moof'), crypto.createHash('sha512').update(`seg-${seed}-${n}`).digest(), Buffer.alloc(200 + n, n)]);
    const file = `${n}-${sha16(bytes)}.m4s`;
    files[file] = bytes;
    manifest.segments[n] = {
      file, init: id1, stride: 1, samples: 15, bytes: bytes.length, encodeMs: 20, tailMs: 5,
      sig: segmentSignature({ streamKey, segment: n, stride: 1, encoder, rect: tight }), dropped: [], at: 1,
    };
  }
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(dir, name), buf);
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
  return { manifest, files, dir };
}

/**
 * Create temporary frame stores and pipelines. `make(root, { interactive })` creates a
 * FramePipeline (injects environment, does not probe), and `root()` creates a temporary directory.
 * `cleanup()` shuts down all pipelines and deletes all directories.
 */
export function makeRoots(FramePipeline, prefix = 'pc-c64-lib-') {
  const roots = [];
  const pipelines = [];
  return {
    async root() { const r = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(r); return r; },
    make(root, { interactive = false } = {}) {
      const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive });
      pipelines.push(p);
      return p;
    },
    async cleanup() {
      await Promise.allSettled(pipelines.map((p) => p.close()));
      await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
    },
  };
}

/** Stream producer: connect read port, set encoder name (does not probe, does not start workers) */
export function producerOf(pipeline, encoder = B_ENCODER) {
  const p = pipeline.streamProducer();
  assert.ok(p, 'cannot get the stream producer (streamProducer(), which exists only on a pipeline with interactive: true)');
  p.attachRoute();
  p.encoderName = encoder;
  return p;
}

/**
 * Attach an entry and a page session to the pipeline: used to check whether the session receives
 * the layer after publishing
 */
export function watchEntry(pipeline, entry) {
  pipeline.entries.set(entry.key, entry);
  const seen = [];
  pipeline.ready.subscribe('page', (m) => seen.push(m));
  pipeline.ready.adopt('page', entry.key, 1);
  return { entry, seen, layers: () => seen.filter((m) => m.type === 'layer') };
}
export const staged = (pipeline, kind, key) => pipeline.ready.stagedKeys().find((s) => s.kind === kind && s.key === key) ?? null;

/**
 * Asset service (memory, port 0) + document service (content store, memory, port 0).
 * `newClient(base)` is provided by caller (individual test cases fail if client.mjs cannot be loaded).
 */
export async function startServices(harness, newClient) {
  const srv = await harness.serve();
  let docs = null;
  let client, content;
  try {
    client = newClient(srv.base);
    docs = await startContentService();
    ({ content } = await connectContent(docs));
  } catch (err) {
    // Even when the module under test fails to load, shut down started services; otherwise
    // the process does not exit
    await docs?.cleanup();
    await srv.close();
    throw err;
  }
  return {
    srv, client, docs, content,
    /** Connect an additional content store client (another machine) */
    async another(user = 'node-b') { return (await connectContent(docs, { user })).content; },
    async cleanup() { await docs.cleanup(); await srv.close(); },
  };
}
