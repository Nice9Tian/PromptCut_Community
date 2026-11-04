/**
 * Per-card fingerprint lock: node side (contract `docs/plan/render-queue-contract.md` F.2 and F.7
 * item 5, test table F.5 N1-N5, F.7 item 6 N6).
 * Run: node --experimental-test-module-mocks --test server/test/card-lock-node.test.mjs
 *
 * Written strictly against contracts F.2, F.7, and their referenced B.1, B.4, B.5, D, and E.5,
 * without looking at the implementation.
 *
 *   N1  Prefix mapping of `normalizeOs`; compute fingerprints using real page strings
 *   N2  `cardLocks` of `splitPlan`
 *   N3  `takeover` of `splitPlan` (boolean / Set / function)
 *   N4  Node session drops candidate upon receiving `card-locked`, no retries
 *   N5  `createLocalNode` passes `PlanContext.cardLocks` / `takeover` as-is to splitting
 *       (M3 loopback and dummy files, real queue)
 *   N6  `createLocalNode` resends by lock fingerprint after publishing is rejected, waits for
 *       response before completing plan, `takeoverLocked`, at most 2 retry rounds
 *
 * Result keys and fingerprints are computed independently with `node:crypto` following formulas
 * in B.1, task id computed per A.4, without borrowing from the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeOs, describeEnvironment } from '../render-node/fingerprint.mjs';
import { planTaskOf, splitPlan } from '../render-node/split.mjs';
import { createNodeSession } from '../render-node/session.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';
import { createFakeExecutor, createTimerClock } from './fake-render-executor.mjs';

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const fpOf = (os, gpuClass, chromeMajor) => sha256(`${os}\n${gpuClass}\n${chromeMajor}`).slice(0, 16);
const rkOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const sorted = list => [...list].sort();
/**
 * M7 contract D2 (Section 13 of `docs/plan/m7-contract.md`) added lockIdleMs / lockedByProfile /
 * lockUndone to card-locked responses; here only comparing items specified in F.7
 */
const f7 = r => { if (r == null) return r; const { lockIdleMs, lockedByProfile, lockUndone, ...rest } = r; return rest; };

/* ================================================================== N1 */

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.3351.65',
};
const GPU = {
  nvidia: { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' },
  apple: { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', vendor: 'Google Inc. (Apple)' },
  intel: { renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', vendor: 'Google Inc. (Intel)' },
  swiftshader: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', vendor: 'Google Inc. (Google)' },
};

test('N1 normalizeOs: navigator.platform / userAgentData.platform reported by the page are classified by prefix (compared after lowercasing)', () => {
  // navigator.platform
  assert.equal(normalizeOs('Win32'), 'windows');
  assert.equal(normalizeOs('Win64'), 'windows');
  assert.equal(normalizeOs('MacIntel'), 'macos');
  assert.equal(normalizeOs('Linux x86_64'), 'linux');
  assert.equal(normalizeOs('Linux aarch64'), 'linux');
  // userAgentData.platform
  assert.equal(normalizeOs('Windows'), 'windows');
  assert.equal(normalizeOs('macOS'), 'macos');
  assert.equal(normalizeOs('Linux'), 'linux');
  // Case sensitivity
  assert.equal(normalizeOs('WIN32'), 'windows');
  assert.equal(normalizeOs('MACINTEL'), 'macos');
});

test('N1 normalizeOs: the old mapping is unchanged, the remaining inputs are still classified as other', () => {
  assert.equal(normalizeOs('win32'), 'windows');
  assert.equal(normalizeOs('windows'), 'windows');
  assert.equal(normalizeOs('darwin'), 'macos');
  assert.equal(normalizeOs('macos'), 'macos');
  assert.equal(normalizeOs('linux'), 'linux');
  for (const other of ['freebsd', 'aix', 'sunos', 'android', 'Android', 'iPhone', 'iPad', 'CrOS', 'OpenBSD', 'Chrome OS', 'x11', '', 'ewin', 'amac', 'unix']) {
    assert.equal(normalizeOs(other), 'other', JSON.stringify(other));
  }
});

test('N1 compute the fingerprint from real page strings: navigator.platform + WebGL string + full UA', () => {
  const win = describeEnvironment({ platform: 'Win32', ...GPU.nvidia, chromeVersion: UA.win });
  assert.deepEqual(win, { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138, fingerprint: fpOf('windows', 'nvidia', 138) });
  const mac = describeEnvironment({ platform: 'MacIntel', ...GPU.apple, chromeVersion: UA.mac });
  assert.deepEqual(mac, { os: 'macos', gpuClass: 'apple', chromeMajor: 139, fingerprint: fpOf('macos', 'apple', 139) },
    '"Mac OS X 10_15_7" in a Mac UA must not be treated as a version number');
  const linux = describeEnvironment({ platform: 'Linux x86_64', ...GPU.intel, chromeVersion: UA.linux });
  assert.deepEqual(linux, { os: 'linux', gpuClass: 'intel', chromeMajor: 140, fingerprint: fpOf('linux', 'intel', 140) });
  // userAgentData.platform and navigator.platform yield the same fingerprint
  assert.equal(describeEnvironment({ platform: 'Windows', ...GPU.nvidia, chromeVersion: UA.win }).fingerprint, win.fingerprint);
  assert.equal(describeEnvironment({ platform: 'macOS', ...GPU.apple, chromeVersion: UA.mac }).fingerprint, mac.fingerprint);
  // Chrome major version in Edge UA is also 138
  assert.equal(describeEnvironment({ platform: 'Win32', ...GPU.nvidia, chromeVersion: UA.edge }).fingerprint, win.fingerprint);
  // Page and prerender process: same OS, same major Chrome version, but one uses GPU and one uses
  // SwiftShader → different fingerprints
  const prerender = describeEnvironment({ platform: 'win32', ...GPU.swiftshader, chromeVersion: 'HeadlessChrome/138.0.7204.49' });
  assert.equal(prerender.gpuClass, 'software');
  assert.notEqual(prerender.fingerprint, win.fingerprint);
  // The same environment (page Win32 + SwiftShader + Chrome 138) has the same fingerprint as the
  // prerender process: prefix mapping matches the two sides
  assert.equal(describeEnvironment({ platform: 'Win32', ...GPU.swiftshader, chromeVersion: UA.win }).fingerprint, prerender.fingerprint);
});

/* ================================================================== N2 / N3 fixtures (patterned after render-node-logic.test.mjs) */

const FP = fpOf('windows', 'software', 138);    // This node (splitter node)
const X = fpOf('macos', 'apple', 139);           // Locking party
const Y = fpOf('linux', 'amd', 140);            // Another locking party (decoy keys use this; writing the wrong lock key produces a different key)
const CV = 'c0de5a';
const PROJECT = 'proj-7', REV = 3, ENTRY = 'entry-xyz';
const PLAN_ID = `plan:${PROJECT}@${REV}`;
const SHARED_CAPS = { frameMode: 'stateful', compositing: 'independent' };
const LOCAL_CAPS = { frameMode: 'stateful', compositing: 'belowDependent' };

/** Create a control following the plan() output of card-cache.mjs (E.3, with contentKey) */
function control({ clipId, cardId, contentKey, tier, capabilities, count, start = 0, withContentKey = true }) {
  const c = {
    key: `png-${clipId}`, snapshotKey: rkOf(contentKey, FP), costKey: `cost-${clipId}`, frameMode: capabilities.frameMode,
    tier, capabilities, clipId, nodeId: `n:${clipId}`, start, end: start + count / 30, count,
    sampling: { firstFrame: Math.ceil(start * 30 - 1e-9), fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing: capabilities.compositing, cacheable: capabilities.compositing === 'independent', needPrerendering: false, appearance: {},
    envFingerprint: FP,
  };
  if (withContentKey) { c.contentKey = contentKey; c.cacheContentKey = `cc-${contentKey}`; }
  if (cardId !== undefined) c.cardId = cardId;
  return c;
}

const A = control({ clipId: 'a', cardId: 'particles', contentKey: 'ck-a', tier: 'shared', capabilities: SHARED_CAPS, count: 70 });
const B = control({ clipId: 'b', contentKey: 'ck-b', tier: 'shared', capabilities: SHARED_CAPS, count: 30 });
const C = control({ clipId: 'c', contentKey: 'ck-c', tier: 'shared', capabilities: SHARED_CAPS, count: 30 });
const D = control({ clipId: 'd', contentKey: 'ck-d', tier: 'local', capabilities: LOCAL_CAPS, count: 30 });
/** Legacy shape without a contentKey field (M2 fixture): snapshotKey serves as the content key */
const OLD = control({ clipId: 'old', contentKey: 'ck-old', tier: 'shared', capabilities: SHARED_CAPS, count: 10, withContentKey: false });
const STREAM = { streamKey: rkOf('sk-1', FP), contentKey: 'sk-1', topClipId: 'top', firstSegment: 0, lastSegment: 9 };
const STREAM_OLD = { streamKey: 'sk-old', topClipId: 'top2', firstSegment: 0, lastSegment: 3 };

const baseArgs = over => ({
  planTask: planTaskOf({ projectId: PROJECT, projectRev: REV }), entryKey: ENTRY,
  cardPlan: [A, B, C, D, OLD], prerenderSet: undefined, streams: [STREAM, STREAM_OLD],
  envFingerprint: FP, codeVersion: CV, cardSourceVersions: { particles: 'builtin:12' }, ...over,
});

/** input.contentKey (E.5) and lock key (F.2) for a task */
const contentKeyOf = ctl => (ctl.tier === 'local' ? `${ENTRY}/${ctl.contentKey ?? ctl.snapshotKey}` : (ctl.contentKey ?? ctl.snapshotKey));
const LK = {
  a: `snapshot:${contentKeyOf(A)}`, b: `snapshot:${contentKeyOf(B)}`, c: `snapshot:${contentKeyOf(C)}`,
  d: `snapshot:${contentKeyOf(D)}`, old: `snapshot:${contentKeyOf(OLD)}`,
  stream: 'stream:sk-1', streamOld: 'stream:sk-old',
};
const byLock = tasks => {
  const map = new Map();
  for (const t of tasks) {
    const lk = `${t.kind}:${t.input.contentKey}`;
    if (!map.has(lk)) map.set(lk, []);
    map.get(lk).push(t);
  }
  return map;
};

/**
 * Replace "tasks generated with this node's fingerprint" with "tasks generated with fingerprint
 * fp": only modify resultKey, id, and requires.envFingerprint
 */
function rekeyed(task, fp) {
  const resultKey = rkOf(task.input.contentKey, fp);
  return { ...task, resultKey, id: `${task.kind}:${resultKey}:${task.range.from}-${task.range.to}`, requires: { ...task.requires, envFingerprint: fp } };
}

test('N2 splitPlan without cardLocks (default {}) or with an empty table: exactly the same as E.5; the lock key is `${kind}:${input.contentKey}`', () => {
  const plain = splitPlan(baseArgs());
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: {} })), plain);
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: new Map() })), plain);
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: {}, takeover: false })), plain);
  const groups = byLock(plain);
  assert.deepEqual(sorted(groups.keys()), sorted(Object.values(LK)), 'one lock key per card and per stream; the local tier carries entryKey/');
  for (const t of plain) {
    assert.equal(t.requires.envFingerprint, FP);
    assert.equal(t.resultKey, rkOf(t.input.contentKey, FP));
    assert.equal('takeover' in t, false, 'no takeover field when there is no lock and no takeover');
  }
  assert.equal(groups.get(LK.a)[0].resultKey, A.snapshotKey, 'E.5: shared tier resultKey === control.snapshotKey');
  assert.equal(groups.get(LK.stream)[0].resultKey, STREAM.streamKey, 'E.5: stream resultKey === streamKey');
});

for (const [shape, wrap] of [['plain object', o => o], ['Map', o => new Map(Object.entries(o))]]) {
  test(`N2 splitPlan with cardLocks (${shape}): a card locked by another fingerprint has its key and requires derived from the lock fingerprint; cards with the same fingerprint or without a lock stay as before; the lock key of the local tier carries entryKey/`, () => {
    const plain = splitPlan(baseArgs());
    const locks = {
      [LK.a]: X,                       // Locked by another environment
      [LK.b]: FP,                      // Locked to own fingerprint
      [LK.d]: X,                       // Local tier, lock key contains entryKey/
      [LK.stream]: X,                  // Stream
      [LK.old]: X,                     // Legacy shape: snapshotKey serves as the content key
      // Should not hit: local tier keys without entryKey/, keys with the wrong kind, keys written with
      // result keys instead of content keys
      [`snapshot:${D.contentKey}`]: Y,
      ['snapshot:sk-1']: Y,
      [`snapshot:${C.snapshotKey}`]: Y,
    };
    const out = splitPlan(baseArgs({ cardLocks: wrap(locks) }));
    assert.equal(out.length, plain.length, 'the number of tasks is unchanged');
    const lockedKeys = new Set([LK.a, LK.d, LK.stream, LK.old]);
    for (let i = 0; i < plain.length; i++) {
      const p = plain[i], t = out[i];
      const lk = `${p.kind}:${p.input.contentKey}`;
      if (lockedKeys.has(lk)) {
        assert.deepEqual(t, rekeyed(p, X), `${lk}: key derived from the lock fingerprint, requires.envFingerprint = X, other fields unchanged`);
        assert.equal(t.resultKey, rkOf(p.input.contentKey, X));
        assert.equal(t.input.contentKey, p.input.contentKey, 'input.contentKey is unchanged');
        assert.equal('takeover' in t, false);
      } else {
        assert.deepEqual(t, p, `${lk}: not locked by another fingerprint, follows E.5`);
      }
    }
    // Output order follows B.4: snapshots first (cardPlan order, segment ascending), then streams
    assert.deepEqual(out.map(t => t.input.clipId), plain.map(t => t.input.clipId));
  });
}

test('N2 addendum: the remaining frames of the lock owner go only to nodes with the same fingerprint (requires.envFingerprint = X makes rule 1 apply), and the task ids are the same as those the lock owner splits out itself', () => {
  const lockedByX = splitPlan(baseArgs({ cardLocks: { [LK.a]: X } })).filter(t => t.input.clipId === 'a');
  // The locking party (fingerprint X) splits the same card itself
  const byXItself = splitPlan(baseArgs({ envFingerprint: X, cardPlan: [A], streams: [] }));
  assert.deepEqual(lockedByX.map(t => t.id), byXItself.map(t => t.id), 'both sides split out the same task ids, so they merge into the same set of tasks in the queue');
  assert.deepEqual(lockedByX.map(t => t.requires.envFingerprint), byXItself.map(() => X));
});

/* ================================================================== N3 */

const TAKEOVER_FORMS = [
  ['boolean true (take over all)', () => true, [LK.a, LK.d, LK.stream]],
  ['Set (take over only a and the stream)', () => new Set([LK.a, LK.stream]), [LK.a, LK.stream]],
  ['function (take over only local tier d)', calls => lk => { calls.push(lk); return lk === LK.d; }, [LK.d]],
];

for (const [label, make, taken] of TAKEOVER_FORMS) {
  test(`N3 splitPlan with takeover (${label}): matched locked cards have their keys derived from the fingerprint of this node and every task carries takeover: true; unmatched ones follow N2`, () => {
    const plain = splitPlan(baseArgs());
    const locks = { [LK.a]: X, [LK.b]: FP, [LK.d]: X, [LK.stream]: X };
    const calls = [];
    const out = splitPlan(baseArgs({ cardLocks: locks, takeover: make(calls) }));
    assert.equal(out.length, plain.length);
    const takenSet = new Set(taken);
    for (let i = 0; i < plain.length; i++) {
      const p = plain[i], t = out[i];
      const lk = `${p.kind}:${p.input.contentKey}`;
      if (takenSet.has(lk)) {
        assert.deepEqual(t, { ...p, takeover: true }, `${lk}: taken over, key derived from the fingerprint of this node, with takeover: true`);
        assert.equal(t.takeover, true);
        assert.equal(t.requires.envFingerprint, FP);
      } else if (locks[lk] && locks[lk] !== FP) {
        assert.deepEqual(t, rekeyed(p, X), `${lk}: locked but not taken over, follows N2`);
      } else {
        assert.deepEqual(t, p, `${lk}: not locked, or locked on its own fingerprint, follows E.5 and carries no takeover`);
        assert.equal('takeover' in t, false);
      }
    }
    if (calls.length) {
      for (const lk of calls) assert.equal(typeof lk, 'string', 'the function receives the lock key');
      assert.ok(calls.includes(LK.d), 'the function is called for the locked card, with the lock key as its argument');
    }
  });
}

test('N3 addendum: takeover applies only to cards locked by another fingerprint; the default false means no takeover', () => {
  const locks = { [LK.a]: X };
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: false })));
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: new Set() })));
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: () => false })));
  // When there is no lock, takeover: true does not add fields to any task
  for (const t of splitPlan(baseArgs({ takeover: true }))) assert.equal('takeover' in t, false, t.id);
});

/* ================================================================== N4 */

const NODE = Object.freeze({
  profile: 'host', userId: 'u1', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {},
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 8000 },
});
const EPOCH = 'epoch-n4';

function view(name, { priority = 10, version = 1 } = {}) {
  return {
    id: `snapshot:${name}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: name,
    range: { unit: 'localFrame', from: 0, to: 59 },
    source: { userId: 'u1', tenantId: 't1', projectId: 'p1', projectRev: 1, publisher: { id: 'P' }, publishedAt: 1, derivedFrom: null },
    input: { clipId: `clip-${name}`, contentKey: `ck-${name}` }, weight: { class: 'medium', estMs: null, frames: 60 },
    requires: { envFingerprint: FP, codeVersion: CV }, priority, state: 'open', version, attempts: 0,
  };
}

test('N4 the node session receives claim-rejected card-locked: drops this candidate, clears the in-flight claim, and does not retry it afterwards', () => {
  let t = 1000;
  const sent = [], started = [];
  const session = createNodeSession({
    nodeId: 'node-1', node: NODE, send: m => sent.push(m), now: () => t, random: () => 0,
    onTask: task => started.push(task.id), onLost: () => {},
  });
  session.start();
  const locked = view('locked', { priority: 90 }), other = view('other', { priority: 10 });
  session.receive({ type: 'queue.snapshot', epoch: EPOCH, tasks: [locked, other] });
  sent.length = 0;

  session.tick();
  const claims1 = sent.filter(m => m.type === 'task.claim');
  assert.deepEqual(claims1.map(m => m.id), [locked.id], 'claim the higher-priority one first');
  sent.length = 0;

  session.receive({ type: 'task.claim-rejected', epoch: EPOCH, id: locked.id, reason: 'card-locked', state: 'open', version: 1, lockedBy: X });
  assert.ok(!session.known().some(k => k.id === locked.id), 'the locked candidate is removed from the local view');
  assert.deepEqual(started, []);

  // In-flight claims are cleared: the next tick can claim others; the locked one no longer appears
  for (let i = 0; i < 5; i++) {
    t += 1000;
    session.tick();
  }
  const claims2 = sent.filter(m => m.type === 'task.claim');
  assert.deepEqual(claims2.map(m => m.id), [other.id], 'claims only the other one, once; does not retry the locked one');
  assert.equal(sent.filter(m => m.type === 'task.claim' && m.id === locked.id).length, 0);
});

test('N4 addendum: if the locked candidate is pushed again by task.opened later (the lock changed), it can be claimed again as usual', () => {
  let t = 1000;
  const sent = [];
  const session = createNodeSession({ nodeId: 'node-1', node: NODE, send: m => sent.push(m), now: () => t, random: () => 0, onTask: () => {}, onLost: () => {} });
  session.start();
  const locked = view('locked');
  session.receive({ type: 'queue.snapshot', epoch: EPOCH, tasks: [locked] });
  session.tick();
  session.receive({ type: 'task.claim-rejected', epoch: EPOCH, id: locked.id, reason: 'card-locked', state: 'open', version: 1, lockedBy: X });
  sent.length = 0;
  t += 1000;
  session.tick();
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'no other candidates: no claim is sent');
  session.receive({ type: 'task.opened', epoch: EPOCH, task: locked });
  t += 1000;
  session.tick();
  assert.deepEqual(sent.filter(m => m.type === 'task.claim').map(m => m.id), [locked.id]);
});

/* ================================================================== N5 / N6: in-process (following the topology of render-queue-inproc.test.mjs) */

const FP_A = '0123456789abcdef';
const FP_B = 'fedcba9876543210';
const STEP_MS = 250;
const FPS = 30;

const unhandled = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function planTaskInput(projectId, projectRev) {
  return {
    id: `plan:${projectId}@${projectRev}`, kind: 'plan', resultKey: `${projectId}@${projectRev}`, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null }, requires: {}, priority: 0,
  };
}
const planIdOf = (projectId, projectRev) => `plan:${projectId}@${projectRev}`;

function inprocControl({ clipId, cardId, label, capabilities, start, count }) {
  const compositing = capabilities.compositing;
  const tier = capabilities.frameMode !== 'stateful' ? 'none' : compositing === 'independent' ? 'shared' : 'local';
  return {
    key: sha256(`png:${label}`), snapshotKey: sha256(`snap:${label}`), costKey: sha256(`cost:${label}`),
    frameMode: capabilities.frameMode, tier, capabilities, clipId, nodeId: `n:${clipId}`,
    start, end: start + count / FPS, count,
    sampling: { firstFrame: Math.ceil(start * FPS - 1e-9), fps: { numerator: FPS, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing, cacheable: compositing === 'independent', needPrerendering: false,
    appearance: { frame: null, opacity: 1, width: 1920, height: 1080 }, cardId,
  };
}

/**
 * Title (shared tier 130 frames → 3 segments), lower third (shared tier 70 frames → 2 segments),
 * frosted glass (local tier 45 frames → 1 segment), one stream (12 segments → 2 tasks)
 */
function planContextFor(salt = 'p1', extra = {}) {
  const stateful = { frameMode: 'stateful', compositing: 'independent' };
  return {
    entryKey: sha256(`entry:${salt}`),
    cardPlan: [
      inprocControl({ clipId: 'clip-title', cardId: 'particles', label: `${salt}:title`, capabilities: stateful, start: 0, count: 130 }),
      inprocControl({ clipId: 'clip-lower', cardId: 'lowerThird', label: `${salt}:lower`, capabilities: stateful, start: 1, count: 70 }),
      inprocControl({ clipId: 'clip-glass', cardId: 'glass', label: `${salt}:glass`, capabilities: { frameMode: 'stateful', compositing: 'belowDependent' }, start: 2, count: 45 }),
    ],
    streams: [{ streamKey: sha256(`stream:${salt}`), topClipId: 'clip-video', firstSegment: 0, lastSegment: 11 }],
    cardSourceVersions: { particles: 'builtin:12', lowerThird: 'builtin:3' },
    weightOf: () => ({ class: 'medium', estMs: null }),
    ...extra,
  };
}
const titleLockKey = (salt = 'p1') => `snapshot:${sha256(`snap:${salt}:title`)}`;

/**
 * Compute fine-grained tasks split from this PlanContext following B.4 / E.5 / F.2:
 * `fpFor(lockKey)` provides the fingerprint used to generate keys for each lock key,
 * and when `takeoverFor(lockKey)` is true, the task includes `takeover: true`.
 */
function expectedDerived(ctx, fpFor, takeoverFor = () => false) {
  const out = [];
  for (const c of ctx.cardPlan) {
    const contentKey = c.tier === 'shared' ? c.snapshotKey : `${ctx.entryKey}/${c.snapshotKey}`;
    const lockKey = `snapshot:${contentKey}`;
    const fp = fpFor(lockKey);
    const resultKey = rkOf(contentKey, fp);
    for (let from = 0; from < c.count; from += 60) {
      const to = Math.min(c.count - 1, from + 59);
      out.push({ id: `snapshot:${resultKey}:${from}-${to}`, lockKey, fp, takeover: takeoverFor(lockKey), clipId: c.clipId });
    }
  }
  for (const s of ctx.streams) {
    const lockKey = `stream:${s.streamKey}`;
    const fp = fpFor(lockKey);
    const resultKey = rkOf(s.streamKey, fp);
    // Sparse stream has one task for the entire stream (rr-motion-preempt rule); full density tasks
    // are split by 8 segments
    out.push({ id: `stream:${resultKey}:${s.firstSegment}-${s.lastSegment}:sparse`, lockKey, fp, takeover: takeoverFor(lockKey), clipId: s.topClipId });
    for (let from = s.firstSegment; from <= s.lastSegment; from += 8) {
      const to = Math.min(s.lastSegment, from + 7);
      out.push({ id: `stream:${resultKey}:${from}-${to}`, lockKey, fp, takeover: takeoverFor(lockKey), clipId: s.topClipId });
    }
  }
  return out;
}

const CARD_VERSIONS = { particles: ['builtin:12'], lowerThird: ['builtin:3'] };
const pcNode = fp => ({
  profile: 'pc', userId: 'u9', envFingerprint: fp, codeVersions: [CV], cardSourceVersions: CARD_VERSIONS,
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
});

function createRig({ planContext }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-cl' });
  lb.attach(queue);
  const sink = createArtifactSink();
  const exec = createFakeExecutor({ clock, planContext });
  const nodes = [];

  function addPage(name, { publisherId = `page-${name}` } = {}) {
    const ep = lb.connect(`conn-${name}`, { userId: 'u1', tenantId: 't1' });
    const inbox = [];
    ep.onMessage(m => { inbox.push(m); });
    ep.send({ type: 'publisher.hello', publisherId });
    return {
      ep, inbox, publisherId, connId: ep.connId,
      publishPlan(projectId, projectRev) { ep.send({ type: 'task.publish', tasks: [planTaskInput(projectId, projectRev)] }); },
      doneCount: id => inbox.filter(m => m.type === 'task.done' && m.id === id).length,
      done: id => inbox.find(m => m.type === 'task.done' && m.id === id),
    };
  }

  /**
   * `wrapSend(message, send)`: wraps endpoint send so tests can intervene before node messages
   * enter the queue
   */
  function addNode(nodeId, { fp, seed = 1, wrapSend, extra = {} } = {}) {
    const inner = lb.connect(`conn-${nodeId}`, { userId: 'u9', tenantId: 't1' });
    const endpoint = wrapSend
      ? { get connId() { return inner.connId; }, send: m => wrapSend(m, x => inner.send(x)), onMessage: h => inner.onMessage(h), close: () => inner.close(), get closed() { return inner.closed; } }
      : inner;
    const rec = { nodeId, connId: inner.connId, fp, idle: true, events: [] };
    rec.local = createLocalNode({
      nodeId, node: pcNode(fp), endpoint, now: clock.now, random: seeded(seed), isIdle: () => rec.idle, maxConcurrent: 1,
      codeVersion: CV, executor: exec.forNode(nodeId), sink, onEvent: e => { rec.events.push(e); }, ...extra,
    });
    rec.eventsOf = type => rec.events.filter(e => e.type === type);
    nodes.push(rec);
    return rec;
  }

  const logOf = (dir, type) => lb.log().map((e, index) => ({ ...e, index })).filter(e => e.dir === dir && e.message.type === type);
  return { clock, lb, queue, sink, exec, nodes, addPage, addNode, out: type => logOf('out', type), inbound: type => logOf('in', type) };
}

async function settle(rig) {
  for (let round = 0; round < 1_000; round++) {
    rig.lb.flush();
    await new Promise(resolve => setImmediate(resolve));
    if (rig.lb.pending() === 0) {
      await new Promise(resolve => setImmediate(resolve));
      if (rig.lb.pending() === 0) return;
    }
  }
  throw new Error('message round trips do not converge');
}

async function drive(rig, until, { maxSteps = 3_000 } = {}) {
  for (let step = 0; step < maxSteps; step++) {
    await settle(rig);
    for (const n of rig.nodes) n.local.tick();
    await settle(rig);
    rig.queue.tick();
    await settle(rig);
    if (until()) return step;
    rig.clock.advance(STEP_MS);
  }
  assert.fail(`condition still not met after more than ${maxSteps} steps; queue.describe():\n${JSON.stringify(rig.queue.describe(), null, 1)}`);
}

async function coast(rig, steps = 30) {
  for (let i = 0; i < steps; i++) {
    await settle(rig);
    for (const n of rig.nodes) n.local.tick();
    await settle(rig);
    rig.queue.tick();
    await settle(rig);
    rig.clock.advance(STEP_MS);
  }
}

function hygiene(rig, unhandledBefore) {
  assert.deepEqual(rig.lb.errors().map(e => String(e?.stack ?? e)), [], 'the endpoint handler threw an exception');
  assert.deepEqual(rig.lb.nonJson(), [], 'some message cannot round-trip through JSON');
  assert.deepEqual(rig.out('error').map(e => [e.connId, e.message]), [], 'the queue replied with an error');
  assert.deepEqual(rig.sink.misuse(), []);
  assert.deepEqual(unhandled.slice(unhandledBefore).map(e => String(e?.stack ?? e)), [], 'there are unhandled Promise rejections');
}

const claimsOf = rig => rig.out('task.claimed').map(e => ({ connId: e.connId, id: e.message.id, task: e.message.task }));
const allDone = (rig, page, ids) => () => ids.every(id => page.doneCount(id) >= 1) && rig.nodes.every(n => n.local.running().length === 0);

/** For each id: the page gets exactly one task.done, and the queue confirms completion once */
function assertCompletedOnce(rig, page, ids) {
  const completed = new Map();
  for (const e of rig.out('task.completed')) completed.set(e.message.id, (completed.get(e.message.id) ?? 0) + 1);
  for (const id of ids) {
    assert.equal(page.doneCount(id), 1, `${id}: the page should receive exactly one task.done`);
    assert.equal(completed.get(id) ?? 0, 1, `${id}: should complete exactly once`);
  }
}

/* ================================================================== N5 */

test('N5 createLocalNode passes PlanContext.cardLocks to the split: locked cards are keyed by the lock fingerprint and completed only by nodes with the same fingerprint; the rest use the fingerprint of the splitting node', async () => {
  const before = unhandled.length;
  const locks = new Map([[titleLockKey(), FP_B]]);
  const rig = createRig({ planContext: task => planContextFor(task.source.projectId, { cardLocks: locks }) });
  const page = rig.addPage('page');
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 1 });
  a1.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  await drive(rig, () => claimsOf(rig).some(c => c.id === planId));
  const a2 = rig.addNode('node-a2', { fp: FP_A, seed: 2 });
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 3 });
  a2.local.start();
  b1.local.start();

  const exp = expectedDerived(planContextFor('p1'), lk => (lk === titleLockKey() ? FP_B : FP_A));
  assert.equal(exp.filter(t => t.lockKey === titleLockKey()).length, 3, 'title card, 3 segments');
  const ids = [planId, ...exp.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  assert.deepEqual(sorted(page.done(planId).result.derived), sorted(exp.map(t => t.id)), 'derived of the plan is all the ids that were split out');
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  const claims = claimsOf(rig);
  for (const t of exp) {
    const c = claims.filter(x => x.id === t.id);
    assert.equal(c.length, 1, `${t.id} is claimed exactly once`);
    assert.equal(fpOfConn.get(c[0].connId), t.fp, `${t.lockKey}: claimed only by nodes with fingerprint ${t.fp}`);
    assert.equal(c[0].task.requires.envFingerprint, t.fp);
    assert.ok(rig.sink.holds(c[0].task.resultKey, c[0].task.range), t.id);
  }
  for (const e of rig.inbound('task.claim')) {
    const t = exp.find(x => x.id === e.message.id);
    if (t) assert.equal(fpOfConn.get(e.connId), t.fp, `a node with a different fingerprint tried to claim ${e.message.id}`);
  }
  // Published fine-grained tasks contain no takeover field
  for (const e of rig.inbound('task.publish').filter(e => e.connId === a1.connId)) {
    for (const t of e.message.tasks) assert.equal('takeover' in t, false, t.id);
  }
  hygiene(rig, before);
});

test('N5 createLocalNode passes PlanContext.takeover to the split: locked cards have their keys derived from the fingerprint of this node and are published with takeover, and are completed by nodes with that same fingerprint', async () => {
  const before = unhandled.length;
  const locks = { [titleLockKey()]: FP_B };
  const rig = createRig({ planContext: task => planContextFor(task.source.projectId, { cardLocks: locks, takeover: new Set([titleLockKey()]) }) });
  const page = rig.addPage('page');
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 1 });
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 3 });
  b1.idle = false;                     // plan is claimed by a1
  a1.local.start();
  b1.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  await drive(rig, () => claimsOf(rig).some(c => c.id === planId));
  b1.idle = true;

  const exp = expectedDerived(planContextFor('p1'), () => FP_A, lk => lk === titleLockKey());
  const ids = [planId, ...exp.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);
  assertCompletedOnce(rig, page, ids);

  const published = rig.inbound('task.publish').filter(e => e.connId === a1.connId).flatMap(e => e.message.tasks);
  for (const t of exp) {
    const p = published.find(x => x.id === t.id);
    assert.ok(p, `${t.id} was published`);
    if (t.takeover) assert.equal(p.takeover, true, `${t.id}: a taken-over card carries takeover: true`);
    else assert.equal('takeover' in p, false, `${t.id}: the rest do not carry it`);
  }
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  for (const c of claimsOf(rig)) {
    if (c.id === planId) continue;
    assert.equal(fpOfConn.get(c.connId), FP_A, `${c.id} should be claimed by a FP_A node`);
  }
  hygiene(rig, before);
});

/* ================================================================== N6 (F.7 item 5) */

/**
 * The page first uses card.lock to lock the title card to FP_B (the case where frames pushed by
 * page measurement are stored); splitter node FP_A does not know about this lock
 */
async function lockedTitleScene({ extra = {}, wrapSend } = {}) {
  const rig = createRig({ planContext: task => planContextFor(task.source.projectId) });
  const page = rig.addPage('page');
  page.ep.send({ type: 'card.lock', kind: 'snapshot', contentKey: titleLockKey().slice('snapshot:'.length), envFingerprint: FP_B });
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 1, extra, wrapSend });
  a1.local.start();
  await settle(rig);
  assert.ok(page.inbox.some(m => m.type === 'card.locked' && m.granted === true), 'the page locked the title card');
  page.publishPlan('p1', 1);
  return { rig, page, a1, planId: planIdOf('p1', 1) };
}

test('N6 after a creation rejection, republish with the lock fingerprint: only the rejected card is republished; the plan completes only once the reply arrives, and derived is all the ids that were finally published successfully; fine-grained tasks inherit the page subscription and are completed by nodes with the fingerprint of the lock owner', async () => {
  const before = unhandled.length;
  const { rig, page, a1, planId } = await lockedTitleScene();
  await drive(rig, () => claimsOf(rig).some(c => c.id === planId));
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 3 });
  const a2 = rig.addNode('node-a2', { fp: FP_A, seed: 2 });
  b1.local.start();
  a2.local.start();

  const exp = expectedDerived(planContextFor('p1'), lk => (lk === titleLockKey() ? FP_B : FP_A));
  const ids = [planId, ...exp.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);
  assertCompletedOnce(rig, page, ids);

  // Published twice: first time all (title card uses FP_A, creation rejected), second time title
  // card only, using FP_B
  const pubs = rig.inbound('task.publish').filter(e => e.connId === a1.connId);
  assert.equal(pubs.length, 2, 'publish once first, then republish once after the creation is rejected');
  const [first, second] = pubs;
  const titleA = expectedDerived(planContextFor('p1'), () => FP_A).filter(t => t.lockKey === titleLockKey());
  assert.deepEqual(sorted(first.message.tasks.map(t => t.id)), sorted([...exp.filter(t => t.lockKey !== titleLockKey()), ...titleA].map(t => t.id)));
  const titleB = exp.filter(t => t.lockKey === titleLockKey());
  assert.deepEqual(sorted(second.message.tasks.map(t => t.id)), sorted(titleB.map(t => t.id)), 'only the tasks whose lock key is in the rejection result are republished');
  for (const t of second.message.tasks) {
    assert.equal(t.requires.envFingerprint, FP_B);
    assert.equal('takeover' in t, false, 'default takeoverLocked: false, republish with the fingerprint of the lock owner, without takeover');
  }
  // Publish includes reqId; in the first response, the title card is card-locked
  for (const p of pubs) assert.ok(typeof p.message.reqId === 'string' || Number.isFinite(p.message.reqId), 'task.publish of derived tasks carries reqId');
  const reply = reqId => rig.out('task.published').find(e => e.connId === a1.connId && e.message.reqId === reqId);
  const r1 = reply(first.message.reqId), r2 = reply(second.message.reqId);
  assert.ok(r1 && r2, 'both publishes got a reply');
  for (const t of titleA) {
    assert.deepEqual(f7(r1.message.results.find(r => r.id === t.id)), { id: t.id, error: 'card-locked', lockedBy: FP_B });
  }
  assert.ok(r2.message.results.every(r => r.created === true && !('error' in r)));

  // plan completes only after the second response
  const planComplete = rig.inbound('task.complete').find(e => e.message.id === planId);
  assert.ok(planComplete.index > r2.index, 'the plan completes only after the reply to the last publish');
  assert.deepEqual(sorted(planComplete.message.result.derived), sorted(exp.map(t => t.id)), 'derived is all the ids that were finally published successfully');

  // Inherit page subscription: resent fine-grained tasks include the page in subscribers,
  // source.userId is the page's
  const view = new Map(rig.queue.describe().tasks.map(t => [t.id, t]));
  for (const t of titleB) assert.ok(view.get(t.id).subscribers.includes(page.publisherId), `${t.id} inherited the page subscription`);
  // Completed by the node with the locking party's fingerprint
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  for (const c of claimsOf(rig).filter(c => titleB.some(t => t.id === c.id))) {
    assert.equal(fpOfConn.get(c.connId), FP_B);
    assert.equal(c.task.source.userId, 'u1');
  }
  // No dead tasks for FP_A's title card remain in the queue
  for (const t of titleA) assert.equal(view.get(t.id), undefined, `${t.id} had its creation rejected and is not in the table`);
  hygiene(rig, before);
});

for (const [label, takeoverLocked] of [['boolean true', true], ['function', (lockKey, lockedBy) => lockKey.startsWith('snapshot:') && lockedBy === FP_B]]) {
  test(`N6 takeoverLocked (${label}): after a creation rejection, republish with takeover using the fingerprint of this node, the lock is transferred to that fingerprint, and nodes with that fingerprint complete it`, async () => {
    const before = unhandled.length;
    const seen = [];
    const option = typeof takeoverLocked === 'function' ? (lk, by) => { seen.push([lk, by]); return takeoverLocked(lk, by); } : takeoverLocked;
    const { rig, page, a1, planId } = await lockedTitleScene({ extra: { takeoverLocked: option } });
    const exp = expectedDerived(planContextFor('p1'), () => FP_A);
    const ids = [planId, ...exp.map(t => t.id)];
    await drive(rig, allDone(rig, page, ids));
    await coast(rig);
    assertCompletedOnce(rig, page, ids);

    const pubs = rig.inbound('task.publish').filter(e => e.connId === a1.connId);
    assert.equal(pubs.length, 2);
    const titleIds = exp.filter(t => t.lockKey === titleLockKey()).map(t => t.id);
    assert.deepEqual(sorted(pubs[1].message.tasks.map(t => t.id)), sorted(titleIds), 'the republished tasks are the title card, keyed by the fingerprint of this node (same ids as the first time)');
    for (const t of pubs[1].message.tasks) assert.equal(t.takeover, true, 'the republish carries takeover: true');
    const lock = rig.queue.describe().locks?.find(l => l.lockKey === titleLockKey());
    assert.equal(lock?.envFingerprint, FP_A, 'the lock is transferred to the fingerprint of this node');
    assert.equal(lock?.source, 'takeover');
    if (typeof takeoverLocked === 'function') assert.deepEqual(seen, [[titleLockKey(), FP_B]], 'the function receives (lockKey, lockedBy)');
    const planDone = page.done(planId);
    assert.deepEqual(sorted(planDone.result.derived), sorted(exp.map(t => t.id)));
    hygiene(rig, before);
  });
}

test('N6 at most 2 retry rounds: when another environment takes the lock away in every round, give up on the 3rd rejection and emit a plan-relocked event; the plan still completes, and derived contains only those published successfully', async () => {
  const before = unhandled.length;
  const ck = titleLockKey().slice('snapshot:'.length);
  let flips = 0;
  let page;
  // Each time the splitter node sends task.publish, the page preempts (same loopback, FIFO) to
  // take over the title card lock to a new fingerprint
  const wrapSend = (message, send) => {
    if (message.type === 'task.publish' && page) {
      flips += 1;
      page.ep.send({ type: 'card.lock', kind: 'snapshot', contentKey: ck, envFingerprint: `c0c0c0c0c0c0c0${String(flips).padStart(2, '0')}`, takeover: true });
    }
    send(message);
  };
  const scene = await lockedTitleScene({ wrapSend });
  page = scene.page;
  const { rig, a1, planId } = scene;
  const exp = expectedDerived(planContextFor('p1'), () => FP_A).filter(t => t.lockKey !== titleLockKey());
  await drive(rig, () => page.doneCount(planId) >= 1);
  const pubs = rig.inbound('task.publish').filter(e => e.connId === a1.connId);
  assert.equal(pubs.length, 3, '1 initial publish + 2 retry rounds');
  const ev = a1.eventsOf('plan-relocked');
  assert.equal(ev.length >= 1, true, 'emit a plan-relocked event');
  const last = ev.at(-1);
  assert.equal(last.id, planId);
  assert.ok(Array.isArray(last.gaveUp) && last.gaveUp.length > 0, 'gaveUp lists the items given up on');
  assert.ok(Array.isArray(last.lockKeys) && last.lockKeys.includes(titleLockKey()), 'lockKeys contains the lock key of the title card');
  assert.deepEqual(sorted(page.done(planId).result.derived), sorted(exp.map(t => t.id)), 'derived contains only those finally published successfully');
  // Remaining fine-grained tasks complete as usual
  const ids = exp.map(t => t.id);
  rig.addNode('node-a2', { fp: FP_A, seed: 2 }).local.start();
  await drive(rig, allDone(rig, page, ids));
  hygiene(rig, before);
});
