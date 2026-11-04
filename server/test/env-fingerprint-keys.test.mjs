/**
 * M4: Environment fingerprint into result key (contract `docs/plan/render-queue-contract.md`
 * Section E, test table E.7 F1–F8).
 * Run: node --experimental-test-module-mocks --test server/test/env-fingerprint-keys.test.mjs
 *
 * Written strictly to contract Section E (and B.1, B.4 referenced by it), design
 * `distributed-prerender-queue.md` 2.1, and `mechanism/rendering.md` semantics "Do not mix results
 * from different environments", without looking at implementation. Assertions follow the contract.
 *
 * Conventions:
 *   - `resultKeyOf` imported from `server/render-node/fingerprint.mjs` (contract E.3 requires
 *     production code to import from there as well); also independently calculated once using
 *     `node:crypto` following contract B.1 formula for cross-checking.
 *   - `server/bakery/environment.mjs` is a new module in M4, imported dynamically on demand in F7,
 *     so that if it does not exist, only F7 fails without affecting other test cases.
 *   - Fake page in F7 / F8 actually executes the function passed to `evaluate`: first rebuilds
 *     function source into a new function following Puppeteer's approach (so the function must be
 *     self-contained), then runs in a fake `document` / WebGL environment. This way tests do not
 *     rely on the specific shape of evaluate return values (not specified by contract), only on
 *     DOM / WebGL calls specified in the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describeEnvironment, envFingerprintOf, gpuClassOf, chromeMajorOf, normalizeOs, resultKeyOf } from '../render-node/fingerprint.mjs';
import { CardFrameCache, cardControlPngPath } from '../card-cache.mjs';
import { planStreams, StreamStore } from '../frame-stream.mjs';
import { SnapshotStore, snapshotDir } from '../snapshot-store.mjs';
import { planTaskOf, splitPlan } from '../render-node/split.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
// Two formulas from contract B.1, implemented independently
const fpOf = (osName, gpuClass, chromeMajor) => sha256(`${osName}\n${gpuClass}\n${chromeMajor}`).slice(0, 16);
const rkOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// Routing regex (today's syntax in `server/vite-plugin-frames.ts` and
// `server/frame-stream.mjs`; contract Section E: routing regex unchanged)
const SNAPSHOT_ROUTE = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/;
const CONTROL_ROUTE = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/;
const STREAM_ROUTE = /^\/stream\/([a-f0-9]{64})\/(manifest|init\/([a-f0-9]{16})|seg\/(\d{1,7}-[a-f0-9]{16}\.m4s))$/;

/* ------------------------------------------------------------------ Real probe string */

const CHROME_138 = 'HeadlessChrome/138.0.7204.49';
const UA_138 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.7204.49 Safari/537.36';
const GPU = {
  swiftshader: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', vendor: 'Google Inc. (Google)' },
  nvidia: { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' },
  amd: { renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (AMD)' },
  intel: { renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (Intel)' },
  apple: { renderer: 'Apple M2', vendor: 'Apple' },
};

// Two environments: prerender process SwiftShader (Windows, Chrome 138), and a Mac (Apple GPU, Chrome 139)
const ENV_A = describeEnvironment({ platform: 'win32', ...GPU.swiftshader, chromeVersion: CHROME_138 });
const ENV_B = describeEnvironment({ platform: 'darwin', ...GPU.apple, chromeVersion: 'HeadlessChrome/139.0.7258.5' });
const FP_A = ENV_A.fingerprint;
const FP_B = ENV_B.fingerprint;

/* ------------------------------------------------------------------ A browserPlan */

const PROJECT = {
  id: 'm4-env', fps: 30, width: 1920, height: 1080, duration: 4, style: {}, media: [],
  tracks: [
    { id: 't1', clips: [{ id: 'clip-a', cardId: 'demo-a', start: 0, end: 3, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
    { id: 't2', clips: [{ id: 'clip-c', cardId: 'demo-c', start: 0.5, end: 2 }] },
    { id: 't3', clips: [{ id: 'clip-b', cardId: 'glass', start: 0, end: 1 }] },
  ],
};
const SHARED = { compositing: 'independent', frameMode: 'stateful' };
const LOCAL = { compositing: 'belowDependent', frameMode: 'stateful' };
/** graph received by plan() of card-cache.mjs (same shape as card-cache.test.mjs): two shared-tier cards, one local-tier card */
const GRAPH = {
  definitions: [],
  nodes: [
    { id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { ...SHARED }, inputs: {} },
    { id: 'n-c', adapter: 'chrome', cardId: 'demo-c', capabilities: { ...SHARED }, inputs: {} },
    { id: 'n-b', adapter: 'chrome', cardId: 'glass', capabilities: { ...LOCAL }, inputs: {} },
  ],
  outputs: [
    { nodeId: 'n-a', clipId: 'clip-a', start: 0, end: 3, opacity: 1, frame: { x: 0, y: 0, w: 640, h: 360 } },
    { nodeId: 'n-c', clipId: 'clip-c', start: 0.5, end: 2, opacity: 1 },
    { nodeId: 'n-b', clipId: 'clip-b', start: 0, end: 1, opacity: 1 },
  ],
};
const ENTRY_KEY = sha256('m4-env-entry');   // entry.key is 64-character hex (frameIdentity)
const UNUSED_ROOT = path.join(os.tmpdir(), 'pc-m4-env-unused');   // plan() does not touch the disk

const cacheWith = (envFingerprint, root = UNUSED_ROOT, project = PROJECT) => new CardFrameCache({ root, project, envFingerprint });
const planWith = (envFingerprint, graph = GRAPH) => cacheWith(envFingerprint).plan(graph);
const byClip = (plan, clipId) => plan.find(c => c.clipId === clipId);
const entryOf = cardPlan => ({ key: ENTRY_KEY, project: PROJECT, cardPlan });
const withTmp = async (prefix, fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

/* ================================================================== F1 */

test('F1 fingerprint extraction from real strings: SwiftShader / NVIDIA / AMD / Intel / Apple classification, Chrome major version, stable fingerprint that differs when any of the three items differs', () => {
  assert.equal(gpuClassOf(GPU.swiftshader.renderer, GPU.swiftshader.vendor), 'software', 'the ANGLE string of SwiftShader');
  assert.equal(gpuClassOf(GPU.nvidia.renderer, GPU.nvidia.vendor), 'nvidia');
  assert.equal(gpuClassOf(GPU.amd.renderer, GPU.amd.vendor), 'amd');
  assert.equal(gpuClassOf(GPU.intel.renderer, GPU.intel.vendor), 'intel');
  assert.equal(gpuClassOf('Apple M2', ''), 'apple', '`Apple M2` → apple');
  assert.equal(gpuClassOf('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'Google Inc. (Apple)'), 'apple');
  // Other real variants
  assert.equal(gpuClassOf('ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3623)', 'Google Inc. (NVIDIA)'), 'nvidia', 'D3D11 with a driver version');
  assert.equal(gpuClassOf('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)'), 'intel');
  assert.equal(gpuClassOf('Google SwiftShader', 'Google Inc.'), 'software');
  assert.equal(gpuClassOf('llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa'), 'software');
  assert.equal(gpuClassOf('Microsoft Basic Render Driver', 'Microsoft'), 'software');
  assert.equal(gpuClassOf('', ''), 'software', 'WebGL unavailable: two empty strings → software');

  assert.equal(chromeMajorOf(CHROME_138), 138);
  assert.equal(chromeMajorOf(UA_138), 138, 'a full UA must not take the 5 from the leading Mozilla/5.0');
  assert.equal(chromeMajorOf('138.0.7204.49'), 138);
  assert.equal(chromeMajorOf(138), 138);
  assert.equal(chromeMajorOf(''), 0);

  const base = { os: 'windows', gpuClass: 'software', chromeMajor: 138 };
  const fp = envFingerprintOf(base);
  assert.match(fp, HEX16);
  assert.equal(fp, envFingerprintOf({ ...base }), 'the same input gives a stable fingerprint');
  assert.equal(fp, fpOf('windows', 'software', 138), 'consistent with the formula in contract B.1');
  assert.notEqual(fp, envFingerprintOf({ ...base, os: 'linux' }), 'different os');
  assert.notEqual(fp, envFingerprintOf({ ...base, gpuClass: 'nvidia' }), 'different gpuClass');
  assert.notEqual(fp, envFingerprintOf({ ...base, chromeMajor: 139 }), 'different chromeMajor');

  // Compute all at once from raw probe values
  assert.deepEqual(ENV_A, { os: 'windows', gpuClass: 'software', chromeMajor: 138, fingerprint: fpOf('windows', 'software', 138) });
  assert.deepEqual(describeEnvironment({ platform: 'win32', ...GPU.nvidia, chromeVersion: UA_138 }),
    { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138, fingerprint: fpOf('windows', 'nvidia', 138) });
  assert.equal(ENV_B.os, normalizeOs('darwin'));
  assert.equal(ENV_B.gpuClass, 'apple');
  assert.notEqual(FP_A, FP_B);

  // resultKeyOf: 64-character hex, per formula
  assert.equal(resultKeyOf('content', FP_A), rkOf('content', FP_A));
  assert.match(resultKeyOf('content', FP_A), HEX64);
  assert.notEqual(resultKeyOf('content', FP_A), resultKeyOf('content', FP_B));
});

/* ================================================================== F2 */

test('F2 the same card in two environments: the same browserPlan, two fingerprints → contentKey is the same while snapshotKey and key differ, snapshotKey === resultKeyOf(contentKey, fp)', () => {
  const a = byClip(planWith(FP_A), 'clip-a');
  const b = byClip(planWith(FP_B), 'clip-a');
  assert.ok(a && b, 'plan contains clip-a');

  // Content identity recognizes only content: identical across both environments
  assert.equal(typeof a.contentKey, 'string');
  assert.equal(a.contentKey, b.contentKey, 'contentKey is independent of the environment');
  assert.equal(typeof a.cacheContentKey, 'string');
  assert.equal(a.cacheContentKey, b.cacheContentKey, 'cacheContentKey is independent of the environment');

  // Result key multiplied by fingerprint: strictly different across both environments
  assert.notEqual(a.snapshotKey, b.snapshotKey, 'snapshotKey is isolated per environment');
  assert.notEqual(a.key, b.key, 'PNG cache key (key) is isolated per environment');

  // Equation
  assert.equal(a.snapshotKey, resultKeyOf(a.contentKey, FP_A));
  assert.equal(b.snapshotKey, resultKeyOf(b.contentKey, FP_B));
  assert.equal(a.key, resultKeyOf(a.cacheContentKey, FP_A));
  assert.equal(b.key, resultKeyOf(b.cacheContentKey, FP_B));
  assert.equal(a.envFingerprint, FP_A);
  assert.equal(b.envFingerprint, FP_B);
});

test('F2 remaining details: holds for every control; costKey and the other fields do not change with the fingerprint; the same fingerprint twice gives identical results; the function form behaves like the string form; 64 hex digits, and the route regex still matches', () => {
  const planA = planWith(FP_A);
  const planB = planWith(FP_B);
  assert.equal(planA.length, 3);
  assert.deepEqual(planA.map(c => c.clipId), planB.map(c => c.clipId));
  for (let i = 0; i < planA.length; i++) {
    const a = planA[i], b = planB[i];
    const label = a.clipId;
    for (const k of ['contentKey', 'cacheContentKey', 'snapshotKey', 'key']) {
      assert.match(a[k], HEX64, `${label}.${k} is 64 hex digits`);
      assert.match(b[k], HEX64, `${label}.${k} is 64 hex digits`);
    }
    assert.equal(a.contentKey, b.contentKey, `${label} contentKey`);
    assert.equal(a.cacheContentKey, b.cacheContentKey, `${label} cacheContentKey`);
    assert.notEqual(a.snapshotKey, b.snapshotKey, `${label} snapshotKey`);
    assert.notEqual(a.key, b.key, `${label} key`);
    assert.equal(a.snapshotKey, resultKeyOf(a.contentKey, FP_A), `${label} snapshotKey equality`);
    assert.equal(a.snapshotKey, rkOf(a.contentKey, FP_A), `${label} snapshotKey matches the formula in contract B.1`);
    assert.equal(a.key, resultKeyOf(a.cacheContentKey, FP_A), `${label} key equality`);
    assert.equal(b.key, rkOf(b.cacheContentKey, FP_B), `${label} key matches the formula in contract B.1`);
    assert.notEqual(a.contentKey, a.snapshotKey, `${label} the content key is not the result key`);
    // costKey is not multiplied by fingerprint; remaining fields unchanged
    assert.equal(a.costKey, b.costKey, `${label} costKey is not multiplied by the fingerprint`);
    const rest = ({ key, snapshotKey, envFingerprint, ...others }) => others;
    assert.deepEqual(rest(a), rest(b), `${label} all fields are identical except key / snapshotKey / envFingerprint`);
  }
  // Ji-2: tier is always none after removing per-card snapshots
  assert.equal(byClip(planA, 'clip-b').tier, 'none');

  // Computing twice with same fingerprint is identical; function form matches string form
  assert.deepEqual(planWith(FP_A), planA);
  assert.deepEqual(planWith(() => FP_A), planA);

  // Routing regex (contract: result key remains 64-character hex, routing unchanged)
  const a = byClip(planA, 'clip-a');
  const local = byClip(planA, 'clip-b');
  assert.match(`/snapshot/html/${a.snapshotKey}/0`, SNAPSHOT_ROUTE);
  assert.match(`/snapshot/local/${ENTRY_KEY}/${local.snapshotKey}/0`, SNAPSHOT_ROUTE);
  assert.match(`/control/${a.key}/0`, CONTROL_ROUTE);
});

/* ================================================================== F3 */

test('F3 plan() throws when there is no fingerprint (undefined, \'\', function returning null), and the error message contains "environment fingerprint"', () => {
  const noFingerprint = err => err instanceof Error && /environment fingerprint/.test(err.message);
  const cases = [
    ['not passed', new CardFrameCache({ root: UNUSED_ROOT, project: PROJECT })],
    ['undefined', cacheWith(undefined)],
    ["''", cacheWith('')],
    ['() => null', cacheWith(() => null)],
    ['() => undefined', cacheWith(() => undefined)],
    ["() => ''", cacheWith(() => '')],
    ['non-string 12345', cacheWith(12345)],
    ['function returns a non-string', cacheWith(() => 12345)],
  ];
  for (const [label, cache] of cases) assert.throws(() => cache.plan(GRAPH), noFingerprint, label);
});

test('F3 the fingerprint is resolved at the start of plan(): an empty browserPlan throws too; the function form is resolved on every plan() call', () => {
  const noFingerprint = err => err instanceof Error && /environment fingerprint/.test(err.message);
  // Contract E.3 "parsed once at start of plan(); throws if not a non-empty string":
  // regardless of whether cards exist
  assert.throws(() => cacheWith(undefined).plan({ nodes: [], outputs: [] }), noFingerprint, 'empty graph');
  assert.throws(() => cacheWith(() => null).plan(null), noFingerprint, 'browserPlan is null');
  // Function form: no fingerprint at construct time, available later
  // (FramePipeline's `() => this.envFingerprint`)
  let fp = null;
  const cache = cacheWith(() => fp);
  assert.throws(() => cache.plan(GRAPH), noFingerprint, 'fingerprint not determined yet');
  fp = FP_A;
  const plan = cache.plan(GRAPH);
  assert.equal(byClip(plan, 'clip-a').envFingerprint, FP_A);
  assert.deepEqual(plan, planWith(FP_A), 'once determined, it is the same as passing the string directly');
});

/* ================================================================== F4 */

test('F4 stream: the same entry with two fingerprints → same contentKey, different streamKey, and streamKey = resultKeyOf(contentKey, fp); single-card streams and group streams; no fingerprint returns []', () => {
  const entry = entryOf(planWith(FP_A));
  for (const budget of [6, 1]) {
    const kind = budget === 1 ? 'group' : 'card';
    const underA = planStreams(entry, { budget, codeVersion: 'cv', envFingerprint: FP_A });
    const underB = planStreams(entry, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    // Fixture has another below-dependent card: when classified as heavy, it has its own stream
    // (`kind: below`, ordered last), key also isolated by environment
    assert.equal(underA.filter((s) => s.kind !== 'below').length, budget === 1 ? 1 : 2, `${kind}: stream count`);
    assert.deepEqual(underA.filter((s) => s.kind === 'below').map((s) => s.clipIds.length), underA.some((s) => s.kind === 'below') ? [1] : []);
    assert.equal(underB.length, underA.length);
    for (let i = 0; i < underA.length; i++) {
      const a = underA[i], b = underB[i];
      assert.equal(a.kind, a.kind === 'below' ? b.kind : kind);
      assert.deepEqual(a.clipIds, b.clipIds);
      assert.match(a.contentKey, HEX64);
      assert.equal(a.contentKey, b.contentKey, `${kind} ${a.clipIds}: contentKey does not depend on the fingerprint`);
      assert.notEqual(a.streamKey, b.streamKey, `${kind} ${a.clipIds}: streamKey is isolated per environment`);
      assert.equal(a.streamKey, resultKeyOf(a.contentKey, FP_A));
      assert.equal(b.streamKey, resultKeyOf(b.contentKey, FP_B));
      assert.equal(a.envFingerprint, FP_A);
      assert.equal(b.envFingerprint, FP_B);
      assert.match(`/stream/${a.streamKey}/manifest`, STREAM_ROUTE, 'stream route regex still matches');
    }
  }
  for (const envFingerprint of [undefined, '', null]) {
    assert.deepEqual(planStreams(entry, { codeVersion: 'cv', envFingerprint }), [], `envFingerprint = ${JSON.stringify(envFingerprint)}`);
  }
  assert.deepEqual(planStreams(entry, {}), [], 'envFingerprint not passed');
});

test('F4 stream: the contentKey computed from each environment\'s own plan() output (whose member result keys differ) is still the same: the member key is the content key', () => {
  const entryA = entryOf(planWith(FP_A));
  const entryB = entryOf(planWith(FP_B));
  for (const budget of [6, 1]) {
    const specsA = planStreams(entryA, { budget, codeVersion: 'cv', envFingerprint: FP_A });
    const specsB = planStreams(entryB, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    assert.ok(specsA.length > 0);
    assert.deepEqual(specsA.map(s => s.contentKey), specsB.map(s => s.contentKey), `budget ${budget}: contentKey is the same`);
    for (let i = 0; i < specsA.length; i++) {
      assert.notEqual(specsA[i].streamKey, specsB[i].streamKey);
      assert.equal(specsA[i].streamKey, resultKeyOf(specsA[i].contentKey, FP_A));
      assert.equal(specsB[i].streamKey, resultKeyOf(specsB[i].contentKey, FP_B));
    }
    // Also consistent with "same cardPlan with swapped fingerprint"
    const sameEntry = planStreams(entryA, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    assert.deepEqual(sameEntry.map(s => s.streamKey), specsB.map(s => s.streamKey), `budget ${budget}: determined only by content and fingerprint`);
  }
});

/* ================================================================== F5 */

test('F5 on-disk isolation: the shared tier, local tier, PNG cache and stream directory of the two environments are pairwise different; a snapshot written by one environment cannot be read by the other', () => withTmp('pc-m4-f5-', async root => {
  const planA = planWith(FP_A), planB = planWith(FP_B);
  const sharedA = byClip(planA, 'clip-a'), sharedB = byClip(planB, 'clip-a');
  const localA = byClip(planA, 'clip-b'), localB = byClip(planB, 'clip-b');
  const [streamA] = planStreams(entryOf(planA), { codeVersion: 'cv', envFingerprint: FP_A });
  const [streamB] = planStreams(entryOf(planB), { codeVersion: 'cv', envFingerprint: FP_B });
  const streams = new StreamStore(path.join(root, 'streams'));

  const dirs = {
    sharedA: snapshotDir(root, { tier: 'shared', key: sharedA.snapshotKey }),
    sharedB: snapshotDir(root, { tier: 'shared', key: sharedB.snapshotKey }),
    localA: snapshotDir(root, { tier: 'local', entryKey: ENTRY_KEY, key: localA.snapshotKey }),
    localB: snapshotDir(root, { tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey }),
    pngA: path.join(root, 'controls', sharedA.key),
    pngB: path.join(root, 'controls', sharedB.key),
    streamA: path.join(root, 'streams', streamA.streamKey),
    streamB: path.join(root, 'streams', streamB.streamKey),
  };
  assert.equal(new Set(Object.values(dirs)).size, 8, `the eight directories are pairwise different: ${JSON.stringify(dirs, null, 1)}`);
  assert.equal(streams.dir(streamA.streamKey), dirs.streamA, 'the StreamStore directory is streams/<streamKey>');
  assert.notEqual(cardControlPngPath(root, sharedA.key, 0), cardControlPngPath(root, sharedB.key, 0));

  // Shared tier / local tier: written by A, unreadable by B
  const store = new SnapshotStore(root);
  const put = (ctl, tier, html) => store.commitSnapshots({ tier, entryKey: tier === 'local' ? ENTRY_KEY : undefined, key: ctl.snapshotKey,
    clipId: ctl.clipId, capabilities: ctl.capabilities, items: [{ localFrame: 0, html }] });
  await put(sharedA, 'shared', '<p>A shared</p>');
  await put(localA, 'local', '<p>A local</p>');
  assert.equal(await store.readSnapshot({ tier: 'shared', key: sharedA.snapshotKey, localFrame: 0 }), '<p>A shared</p>');
  assert.equal(await store.readSnapshot({ tier: 'shared', key: sharedB.snapshotKey, localFrame: 0 }), null, 'B cannot read A\'s shared-tier snapshot');
  assert.equal((await store.snapshotIndex({ tier: 'shared', key: sharedB.snapshotKey })).count, 0);
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: ENTRY_KEY, key: localA.snapshotKey, localFrame: 0 }), '<p>A local</p>');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey, localFrame: 0 }), null, 'B cannot read A\'s local-tier snapshot');
  assert.equal((await store.snapshotIndex({ tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey })).count, 0);

  // Streams: manifest stored by A, unreadable with B's key; disk scan only mounts A's key
  await streams.save({ streamKey: streamA.streamKey, kind: 'card', plane: 'local', clipIds: streamA.clipIds, fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {},
    segments: { 0: { file: '0-0123456789abcdef.m4s', init: '0123456789abcdef', stride: 1, samples: 15 } } });
  const fresh = new StreamStore(path.join(root, 'streams'));
  assert.equal(await fresh.load(streamB.streamKey), null, 'B cannot read A\'s stream');
  assert.equal((await fresh.load(streamA.streamKey))?.streamKey, streamA.streamKey);
  assert.deepEqual((await fresh.scan()).map(s => s.key), [streamA.streamKey]);
}));

test('F5 on-disk isolation: the standalone card PNG cache is isolated per environment, and samples written by environment A are not available to environment B', () => withTmp('pc-m4-f5-png-', async root => {
  // Small aspect ratio, same baseline as card-cache.test.mjs (sample PNG matches aspect ratio)
  const project = { fps: 30, width: 16, height: 8, style: {} };
  const graph = { definitions: [], nodes: [{ id: 'card', adapter: 'chrome', cardId: 'demo', capabilities: { compositing: 'independent', need_prerendering: false }, inputs: {} }],
    outputs: [{ nodeId: 'card', clipId: 'clip', start: 1.01, end: 1.2, opacity: 1, frame: { x: 0 } }] };
  const png = new PNG({ width: 16, height: 8 });
  png.data.fill(255);
  const painted = PNG.sync.write(png);
  const cacheA = cacheWith(FP_A, root, project);
  const cacheB = cacheWith(FP_B, root, project);
  try {
    const [ctlA] = cacheA.plan(graph);
    const [ctlB] = cacheB.plan(graph);
    assert.notEqual(ctlA.key, ctlB.key);
    assert.equal(ctlA.cacheContentKey, ctlB.cacheContentKey);
    const frame = ctlA.sampling.firstFrame;
    await cacheA.put(ctlA.key, 0, painted);
    const seenByA = await cacheA.renderState([ctlA], [frame]);
    assert.match(seenByA.frames.clip?.[frame] ?? '', new RegExp(`/api/frames/control/${ctlA.key}/0`), 'A can read its own');
    const seenByB = await cacheB.renderState([ctlB], [frame]);
    assert.equal(seenByB.frames.clip, undefined, 'B cannot read A\'s PNG sample');
    assert.equal(await cacheB.hasComplete({ ...ctlB, count: 1 }), false);
  } finally { await Promise.all([cacheA.close(), cacheB.close()]); }
}));

/* ================================================================== F6 */

test('F6 splitPlan fed with real plan() output: shared-tier resultKey === snapshotKey, stream resultKey === streamKey, local tier per E.5; task ids of the two fingerprints are disjoint', () => {
  const planTask = planTaskOf({ projectId: 'proj-m4', projectRev: 7 });
  const split = fp => {
    const cardPlan = planWith(fp);
    const streams = planStreams(entryOf(cardPlan), { codeVersion: 'cv', envFingerprint: fp });
    const tasks = splitPlan({ planTask, entryKey: ENTRY_KEY, cardPlan, prerenderSet: undefined, streams, envFingerprint: fp, codeVersion: 'cv' });
    return { cardPlan, streams, tasks };
  };
  const A = split(FP_A), B = split(FP_B);
  for (const [fp, { cardPlan, streams, tasks }] of [[FP_A, A], [FP_B, B]]) {
    const shared = tasks.filter(t => t.kind === 'snapshot' && t.tier === 'shared');
    const local = tasks.filter(t => t.kind === 'snapshot' && t.tier === 'local');
    const stream = tasks.filter(t => t.kind === 'stream');
    assert.equal(shared.length, 0, 'Ji-2: snapshots were removed, so the real splitPlan path no longer splits out fine-grained snapshot tasks');
    assert.equal(local.length, 0, 'Ji-2: no longer splits out fine-grained local-tier snapshot tasks');
    assert.ok(stream.length >= 2, 'stream tasks');
    for (const t of stream) {
      const spec = streams.find(s => s.topClipId === t.input.clipId);
      assert.ok(spec, `stream task ${t.id} finds its spec`);
      assert.equal(t.resultKey, spec.streamKey, 'stream task resultKey === spec.streamKey');
      assert.equal(t.input.contentKey, spec.contentKey, 'stream task content key = spec.contentKey');
    }
    for (const t of tasks) {
      assert.equal(t.requires.envFingerprint, fp);
      assert.match(t.resultKey, HEX64);
      assert.equal(t.id, `${t.kind}:${t.resultKey}:${t.range.from}-${t.range.to}`);
    }
  }
  const idsA = new Set(A.tasks.map(t => t.id));
  const overlap = B.tasks.map(t => t.id).filter(id => idsA.has(id));
  assert.deepEqual(overlap, [], 'the task id sets split out for the two fingerprints are disjoint');
  // Identical content: tasks on both sides correspond one-to-one by content key
  assert.deepEqual(A.tasks.map(t => [t.kind, t.input.contentKey, t.range.from, t.range.to]),
    B.tasks.map(t => [t.kind, t.input.contentKey, t.range.from, t.range.to]));
});

/* ================================================================== Fake Chrome for F7 / F8 */

const GL_CONST = { VENDOR: 0x1F00, RENDERER: 0x1F01 };
const DEBUG_INFO = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };

/**
 * Fake DOM + WebGL. `contexts`: which types getContext provides; `debugInfo`: whether
 * WEBGL_debug_renderer_info exists. When debugInfo exists, gl.RENDERER / VENDOR only returns
 * masked strings; reading a masked string indicates UNMASKED_* was not used.
 */
function fakeGpu({ renderer = '', vendor = '', contexts = ['webgl2', 'webgl'], debugInfo = true } = {}) {
  const log = { canvases: 0, contextsTried: [], lost: 0, appended: 0 };
  const gl = {
    ...GL_CONST,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return debugInfo ? { ...DEBUG_INFO } : null;
      if (name === 'WEBGL_lose_context') return { loseContext() { log.lost++; }, restoreContext() {} };
      return null;
    },
    getParameter(p) {
      if (debugInfo && p === DEBUG_INFO.UNMASKED_RENDERER_WEBGL) return renderer;
      if (debugInfo && p === DEBUG_INFO.UNMASKED_VENDOR_WEBGL) return vendor;
      if (p === GL_CONST.RENDERER) return debugInfo ? 'WebKit WebGL' : renderer;
      if (p === GL_CONST.VENDOR) return debugInfo ? 'WebKit' : vendor;
      return null;
    },
  };
  const append = () => { log.appended++; };
  const document = {
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'canvas') return { appendChild: append };
      log.canvases++;
      return { width: 300, height: 150, getContext(type) { log.contextsTried.push(type); return contexts.includes(type) ? gl : null; } };
    },
    body: { appendChild: append, append },
    documentElement: { appendChild: append, append },
  };
  return { document, log };
}

/** Rebuild function source into a new function following Puppeteer's approach (closure variables invisible), executed in fake DOM */
function rebuild(fn) {
  const text = fn.toString();
  const attempts = [`(${text})`, `(function ${text})`, `(async function ${text.replace(/^async\s+/, '')})`];
  for (const source of attempts) {
    try { return new Function(`return ${source}`)(); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  throw new Error(`the function received by evaluate cannot be rebuilt from its source: ${text.slice(0, 80)}`);
}

function fakePage(gpu, { evaluate } = {}) {
  const calls = [];
  const page = {
    calls,
    async evaluate(fn, ...args) {
      calls.push(fn);
      if (evaluate) return evaluate(fn, ...args);
      if (typeof fn !== 'function') throw new TypeError('the fake page only accepts functions');
      const run = rebuild(fn);
      const had = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
      Object.defineProperty(globalThis, 'document', { value: gpu.document, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'window', { value: { document: gpu.document }, configurable: true, writable: true });
      try { return await run(...args); }
      finally {
        for (const [name, desc] of Object.entries(had)) {
          if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
        }
      }
    },
  };
  return page;
}

function fakeBrowser(version = CHROME_138) {
  const browser = { calls: 0, async version() { browser.calls++; return typeof version === 'function' ? version() : version; } };
  return browser;
}

const never = () => new Promise(() => {});
const loadEnvironmentModule = () => import('../bakery/environment.mjs');

/* ================================================================== F7 */

test('F7 probeBrowserEnvironment happy path: version() + a self-contained function reads UNMASKED_*, hands the result to describeEnvironment, detected: true', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const gpu = fakeGpu(GPU.nvidia);
  const browser = fakeBrowser(CHROME_138);
  const page = fakePage(gpu);
  const env = await probeBrowserEnvironment({ browser, page }, { platform: 'linux', timeoutMs: 2000 });
  const expected = describeEnvironment({ platform: 'linux', ...GPU.nvidia, chromeVersion: CHROME_138 });
  assert.equal(env.os, 'linux');
  assert.equal(env.gpuClass, 'nvidia');
  assert.equal(env.chromeMajor, 138);
  assert.equal(env.fingerprint, expected.fingerprint);
  assert.match(env.fingerprint, HEX16);
  assert.equal(env.renderer, GPU.nvidia.renderer, 'reads UNMASKED_RENDERER_WEBGL, not the masked gl.RENDERER');
  assert.equal(env.vendor, GPU.nvidia.vendor);
  assert.equal(env.chromeVersion, CHROME_138);
  assert.equal(env.detected, true);
  // evaluate receives a function; canvas not mounted to document; try webgl2 first;
  // release context after reading
  assert.equal(browser.calls, 1);
  assert.ok(page.calls.length >= 1);
  assert.ok(page.calls.every(fn => typeof fn === 'function'), 'evaluate receives functions');
  assert.ok(gpu.log.canvases >= 1, 'a canvas was created');
  assert.equal(gpu.log.appended, 0, 'the canvas is not attached to the document');
  assert.equal(gpu.log.contextsTried[0], 'webgl2', 'try webgl2 first');
  assert.ok(gpu.log.lost >= 1, 'release the context with WEBGL_lose_context');
});

test('F7 probeBrowserEnvironment: with only webgl, or without the debug extension, reads gl.RENDERER / VENDOR; SwiftShader is classified as software as-is, with no special case', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  // If webgl2 is unavailable, fall back to webgl
  const onlyWebgl = fakeGpu({ ...GPU.intel, contexts: ['webgl'] });
  const env1 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(onlyWebgl) }, { platform: 'win32', timeoutMs: 2000 });
  assert.deepEqual(onlyWebgl.log.contextsTried.slice(0, 2), ['webgl2', 'webgl']);
  assert.equal(env1.gpuClass, 'intel');
  assert.equal(env1.renderer, GPU.intel.renderer);
  assert.equal(env1.detected, true);
  // Without WEBGL_debug_renderer_info: read gl.RENDERER / gl.VENDOR
  const masked = fakeGpu({ ...GPU.amd, debugInfo: false });
  const env2 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(masked) }, { platform: 'win32', timeoutMs: 2000 });
  assert.equal(env2.renderer, GPU.amd.renderer);
  assert.equal(env2.vendor, GPU.amd.vendor);
  assert.equal(env2.gpuClass, 'amd');
  assert.equal(env2.detected, true);
  // Chrome used for prerender (--disable-gpu + SwiftShader): resolves to software
  const swift = fakeGpu(GPU.swiftshader);
  const env3 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(swift) }, { platform: 'win32', timeoutMs: 2000 });
  assert.equal(env3.gpuClass, 'software');
  assert.equal(env3.fingerprint, ENV_A.fingerprint);
  assert.equal(env3.detected, true);
});

test('F7 probeBrowserEnvironment: no WebGL → two empty strings, software, detected is still true', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const gpu = fakeGpu({ renderer: 'should-not-be-read', vendor: 'x', contexts: [] });
  const env = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(gpu) }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(env.renderer, '');
  assert.equal(env.vendor, '');
  assert.equal(env.gpuClass, 'software');
  assert.equal(env.chromeMajor, 138);
  assert.equal(env.detected, true, 'failing to get a WebGL context still counts as a successful probe');
  assert.equal(env.fingerprint, describeEnvironment({ platform: 'linux', renderer: '', vendor: '', chromeVersion: CHROME_138 }).fingerprint);
});

test('F7 probeBrowserEnvironment: version() throws / evaluate throws / times out → does not throw, missing items are treated as empty, detected: false', { timeout: 15000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const fpWith = (renderer, vendor, chromeVersion) => describeEnvironment({ platform: 'linux', renderer, vendor, chromeVersion }).fingerprint;

  // version() throws: WebGL item as usual, Chrome version treated as null (major version 0)
  const failingBrowser = { async version() { throw new Error('browser gone'); } };
  const e1 = await probeBrowserEnvironment({ browser: failingBrowser, page: fakePage(fakeGpu(GPU.nvidia)) }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(e1.detected, false);
  assert.equal(e1.chromeMajor, 0);
  assert.ok(!e1.chromeVersion, 'chromeVersion treated as empty');
  assert.equal(e1.gpuClass, 'nvidia');
  assert.equal(e1.fingerprint, fpWith(GPU.nvidia.renderer, GPU.nvidia.vendor, ''));

  // evaluate throws: GPU item treated as null (→ software), version as usual
  const throwingPage = fakePage(null, { evaluate: async () => { throw new Error('Execution context was destroyed'); } });
  const e2 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: throwingPage }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(e2.detected, false);
  assert.ok(!e2.renderer && !e2.vendor, 'renderer / vendor treated as empty');
  assert.equal(e2.gpuClass, 'software');
  assert.equal(e2.chromeMajor, 138);
  assert.equal(e2.fingerprint, fpWith('', '', CHROME_138));
  assert.equal(typeof throwingPage.calls[0], 'function', 'evaluate receives functions');

  // evaluate never returns: abort after timeoutMs
  const hangingPage = fakePage(null, { evaluate: never });
  const t0 = Date.now();
  const e3 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: hangingPage }, { platform: 'linux', timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 3000, `a timeout must give up promptly (took ${Date.now() - t0} ms)`);
  assert.equal(e3.detected, false);
  assert.equal(e3.gpuClass, 'software');
  assert.equal(e3.chromeMajor, 138);
  assert.equal(e3.fingerprint, fpWith('', '', CHROME_138));

  // version() never returns
  const hangingBrowser = { version: never };
  const t1 = Date.now();
  const e4 = await probeBrowserEnvironment({ browser: hangingBrowser, page: fakePage(fakeGpu(GPU.intel)) }, { platform: 'linux', timeoutMs: 50 });
  assert.ok(Date.now() - t1 < 3000, `a timeout must give up promptly (took ${Date.now() - t1} ms)`);
  assert.equal(e4.detected, false);
  assert.equal(e4.chromeMajor, 0);
  assert.match(e4.fingerprint, HEX16);

  // Both steps fail: still yields a fingerprint, does not throw
  const e5 = await probeBrowserEnvironment({ browser: failingBrowser, page: throwingPage }, { platform: 'linux', timeoutMs: 50 });
  assert.equal(e5.detected, false);
  assert.equal(e5.fingerprint, fpWith('', '', ''));
});

/* ================================================================== F8 */

const PIPELINE_PROJECT = { id: 'm4-pipeline', fps: 30, width: 1920, height: 1080, duration: 4, style: {}, media: [], tracks: [] };
const fakeBakery = (gpuStrings = GPU.nvidia, version = CHROME_138) => {
  const browser = fakeBrowser(version);
  const page = fakePage(fakeGpu(gpuStrings));
  return { browser, page, probes: () => browser.calls + page.calls.length };
};

test('F8 FramePipeline: when environment is injected at construction, it does not probe, cardCache.plan uses it, and it is visible in diagnostics', { timeout: 15000 }, () => withTmp('pc-m4-f8-inject-', async root => {
  const environment = describeEnvironment({ platform: 'linux', ...GPU.nvidia, chromeVersion: 'HeadlessChrome/140.0.1.2' });
  const pipeline = new FramePipeline({ root, origin: () => '', environment });
  assert.deepEqual(pipeline.environment, environment);
  assert.equal(pipeline.envFingerprint, environment.fingerprint);
  const bakery = fakeBakery(GPU.amd);
  const got = await pipeline.ensureEnvironment(bakery);
  assert.equal(bakery.probes(), 0, 'no probing when injected');
  assert.deepEqual(got, environment);
  assert.deepEqual(pipeline.environment, environment);
  assert.deepEqual(pipeline.diagnostics().environment, environment, 'diagnostics().environment is visible');

  const entry = await pipeline.entry(PIPELINE_PROJECT);
  const [control] = entry.cardCache.plan(GRAPH);
  assert.equal(control.envFingerprint, environment.fingerprint, 'entry.cardCache uses the injected fingerprint');
  assert.equal(control.snapshotKey, resultKeyOf(control.contentKey, environment.fingerprint));
  assert.equal(control.key, resultKeyOf(control.cacheContentKey, environment.fingerprint));
}));

test('F8 FramePipeline.ensureEnvironment: null until settled; concurrent calls probe only once; the result never changes once settled; cardCache produces keys from the settled fingerprint', { timeout: 15000 }, () => withTmp('pc-m4-f8-probe-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  assert.equal(pipeline.environment, null, 'null until settled');
  assert.equal(pipeline.envFingerprint, null);
  assert.equal(pipeline.diagnostics().environment, null);

  // Fingerprint not settled yet: entry's cardCache.plan throws "environment fingerprint" (E.2 + E.3)
  const entry = await pipeline.entry(PIPELINE_PROJECT);
  assert.throws(() => entry.cardCache.plan(GRAPH), err => /environment fingerprint/.test(err?.message));

  // Three concurrent calls, probes only once
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bakery = fakeBakery(GPU.nvidia, async () => { await gate; return CHROME_138; });
  const pending = [pipeline.ensureEnvironment(bakery), pipeline.ensureEnvironment(bakery), pipeline.ensureEnvironment(bakery)];
  release();
  const results = await Promise.all(pending);
  assert.equal(bakery.browser.calls, 1, 'version() is called only once');
  assert.equal(bakery.page.calls.length, 1, 'evaluate is called only once');
  const expected = describeEnvironment({ platform: process.platform, ...GPU.nvidia, chromeVersion: CHROME_138 });
  for (const r of results) assert.equal(r?.fingerprint, expected.fingerprint);
  assert.equal(pipeline.environment.fingerprint, expected.fingerprint);
  assert.equal(pipeline.environment.gpuClass, 'nvidia');
  assert.equal(pipeline.environment.os, normalizeOs(process.platform));
  assert.equal(pipeline.environment.detected, true);
  assert.equal(pipeline.envFingerprint, expected.fingerprint);
  assert.deepEqual(pipeline.diagnostics().environment, pipeline.environment);

  // cardCache of the same entry now produces keys with this fingerprint
  // (`() => this.envFingerprint` resolved during plan())
  const [control] = entry.cardCache.plan(GRAPH);
  assert.equal(control.envFingerprint, expected.fingerprint);
  assert.equal(control.snapshotKey, resultKeyOf(control.contentKey, expected.fingerprint));

  // Immutable for lifetime: calling again with bakery of different GPU does not probe, result unchanged
  const before = structuredClone(pipeline.environment);
  const other = fakeBakery(GPU.amd, 'HeadlessChrome/150.0.0.0');
  const again = await pipeline.ensureEnvironment(other);
  assert.equal(other.probes(), 0, 'no more probing once settled');
  assert.deepEqual(again, before);
  assert.deepEqual(pipeline.environment, before);
}));

test('F8 FramePipeline.ensureEnvironment: a detected: false result also never changes once settled', { timeout: 15000 }, () => withTmp('pc-m4-f8-undetected-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  const broken = {
    browser: { calls: 0, async version() { broken.browser.calls++; throw new Error('no browser'); } },
    page: fakePage(null, { evaluate: async () => { throw new Error('no page'); } }),
  };
  const first = await pipeline.ensureEnvironment(broken);
  assert.equal(first?.detected, false);
  assert.match(pipeline.envFingerprint ?? '', HEX16, 'a failed probe still settles on a fingerprint');
  const fixed = structuredClone(pipeline.environment);
  assert.equal(fixed.detected, false);

  const good = fakeBakery(GPU.nvidia);
  const second = await pipeline.ensureEnvironment(good);
  assert.equal(good.probes(), 0, 'the failed result is settled too and there is no more probing (so the key does not change midway within the same process)');
  assert.deepEqual(second, fixed);
  assert.deepEqual(pipeline.environment, fixed);
  assert.deepEqual(pipeline.diagnostics().environment, fixed);
}));

test('F8 FramePipeline.ensureEnvironment: when bakery lacks browser or page, it does not probe and does not settle a fingerprint', { timeout: 15000 }, () => withTmp('pc-m4-f8-partial-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  const full = fakeBakery(GPU.intel);
  for (const [label, bakery] of [['page only', { page: full.page }], ['browser only', { browser: full.browser }], ['null', null], ['undefined', undefined], ['empty object', {}]]) {
    const got = await pipeline.ensureEnvironment(bakery);
    assert.equal(got ?? null, null, `${label}: returns this.environment(null)`);
    assert.equal(pipeline.environment, null, `${label}: does not settle`);
    assert.equal(pipeline.envFingerprint, null);
  }
  assert.equal(full.probes(), 0, 'no probing if either one is missing');
  // Probes only when real bakery arrives
  const env = await pipeline.ensureEnvironment(full);
  assert.equal(full.probes(), 2, 'version() and evaluate once each');
  assert.equal(env?.gpuClass, 'intel');
  assert.equal(pipeline.environment?.gpuClass, 'intel');
}));
