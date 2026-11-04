/**
 * For testing only; must not be imported by production code.
 *
 * Shared utilities for M7 contract tests (M7-T, `server/test/m7-*.test.mjs`). Based solely on
 * version 1 of `docs/plan/m7-contract.md` (Sections 3-5, Section 10 acceptance check, as ruled by
 * the lead session in Section 13) and `docs/plan/render-queue-contract.md`; the test author did
 * not inspect implementation branches (`claude/rq-m7-queue`, future page node branches).
 *
 * Module paths, function names, parameters, and response shapes not fixed by the contract are all
 * centralized in this file; during integration, reconcile only by modifying here, without changing
 * test criteria. Each assumption is marked as "K<n>", listed under the same numbers in report
 * `docs/archive/agent-reports/AGENT-rq-m7-tests.md`.
 *
 * # What to do when implementations are absent (gates)
 *
 * Each test group begins by calling `*Gate()` in this file: statically inspects source files to
 * see if implementation markers (a field name, an export name) have appeared, without importing
 * or executing. If absent, marks the test group as a `node:test` skip, with the reason stating
 * "which file, missing which marker". Gates only check "whether implementation is present", not
 * "whether it is correct": as soon as the marker appears, the test case actually runs, and fails
 * immediately if shapes do not match (reconciled by the integrator modifying this file), without
 * being silently skipped. Therefore, before M7 integration, the `npm test` skip count will include
 * these; after integration, all these gates must be open.
 *
 * Agreements already in code (E5 two layers, B2 node-side filtering, plan-profile, reading layer
 * table v2) have no gates and run now to guard against regressions.
 *
 * # Assumptions
 *
 *   K1  General: `.ts` modules are imported in Node via the resolve hook in
 *       `src/testing/registerTs.mjs` (same practice as existing unit tests); the gate's "export
 *       name" is found statically via `export function|const|let|class <name>` or
 *       `export { … <name> … }`, taking any name from the candidate list.
 *   K2  D9 Credential ownership: render tickets carry `owner: { kind: 'browser' }`, and the
 *       principal on the connection has the shape `{ userId: '<username>@<device>', tenantId,
 *       scope: 'member', role: 'render', owner: { kind: 'browser' } }` (same shape as
 *       `memberPrincipal` in `server/auth/handshake.mjs`, only with an additional owner kind).
 *       `normalizeOwner({ kind: 'browser' })` in `server/auth/protocol.mjs` returns
 *       `{ kind: 'browser' }`, and returns null if extra keys are present. For such connections,
 *       the queue module (`server/docservice/modules/render-queue.mjs` or queue core, either of the
 *       two layers): if `profile` in `node.hello` is not `'browser'`, returns
 *       `{ type: 'error', reason: 'forbidden' }` (same rejection shape as `mayRegisterNode`), and
 *       the node is not registered; after `nodeId` is checked in for the first time, it is bound
 *       to its `userId`; check-ins using the same `nodeId` from a different `userId` (regardless of
 *       owner) likewise return `error forbidden`, without affecting the original node. Gate:
 *       `.owner` appears in either of the two files.
 *   K3  D10 Fingerprint computed by server: for browser-owned connections, `node.hello` carries
 *       `environment: { platform, userAgent, renderer, vendor }` (raw values of `pageEnvironment()`);
 *       the server computes the fingerprint per
 *       `describeEnvironment({ platform, renderer, vendor, chromeVersion: userAgent })` (same
 *       conversion as the route for storing measurement frames `vite-plugin-frames.ts`), records it
 *       into the node, and returns this value in `node.welcome.envFingerprint`; the self-reported
 *       `envFingerprint` in hello does not count for such connections. Gate: `describeEnvironment`
 *       appears in either of the two files.
 *       Server interpretation of D14 (inference of this test author; see report "Matters requiring
 *       lead session decisions"): if a non-Chromium UA checks in, this node will not claim a single
 *       snapshot task (either check-in is rejected, or claiming is never granted; both are accepted).
 *   K4  D1 Queue side: fine-grained tasks carry `input.dual: true`; when a lock key is locked for
 *       the first time upon claim, any task with the same lock key, different fingerprint,
 *       `input.dual === true`, and still `open` transitions to `failed` with
 *       `lastError: 'superseded'` (visible via `describe()`), without counting attempts; tasks
 *       without dual remain unchanged. Gate: `dual` appears in `queue.mjs`.
 *   K5  D2 Queue side: claim responses for `card-locked` (`task.claim-rejected`) and publish
 *       responses (`results[i]` in `task.published`) additionally carry `lockIdleMs` (current
 *       time - lock's `touchedAt`) and `lockedByProfile` (the profile of the node that claimed
 *       when the lock was created); `task.progress` also refreshes `touchedAt` (visible via
 *       `describe().locks[i].touchedAt`). Gate: `lockIdleMs` appears in `queue.mjs`.
 *   K6  D1 Splitter side: `splitPlan` in `server/render-node/split.mjs` reads browser intent from
 *       `planTask.input.browser` (`{ nodeId, envFingerprint }`) (tests also pass a copy via the option
 *       of the same name `browser`; reading either is acceptable). Cards the browser can handle =
 *       shared tier, `weightOf(control).class` is light / medium, `compositing`
 *       (`control.compositing ?? control.capabilities.compositing`) is `'independent'`, neither a
 *       user card nor a media effect card, not in `cardSourceVersions`, and not locked to a third
 *       environment. Two copies are emitted per segment for such cards: one for the splitter
 *       fingerprint and one for the browser fingerprint, both with `input.dual: true` and neither
 *       carrying `takeover`; the browser copy's `input.bake` is an object with two keys `count`
 *       and `sampling`, with `input.compositing === 'independent'`. Result key is computed
 *       self-sufficiently per Contract B.1: `sha256(contentKey + '\n' + fp)`. Gate: `dual` appears
 *       in `split.mjs`.
 *   K7  D4 Node side: `checkClaimable` in `server/render-node/filter.mjs` accepts only snapshot
 *       tasks with `input.compositing === 'independent'` for pure browser nodes. Gate: `compositing`
 *       appears in `filter.mjs`.
 *   K8  D2 Splitter-side decision: one of `IDLE_TAKEOVER_FILES` exports a pure function (one of
 *       `IDLE_TAKEOVER_NAMES`), `fn(lockKey, lockedBy, { lockIdleMs, lockedByProfile })` → boolean:
 *       takes over only when `lockIdleMs > 30000` (`CARD_LOCK_IDLE_MS` in `server/card-lock.mjs`);
 *       does not take over if `lockIdleMs` is absent. Used by `createLocalNode({ takeoverLocked })`.
 *   K9  D12 Layer table v3: page-side reading remains `layerRefOf(table, clipId, opts)` in
 *       `src/render/snapshotSource.ts`; a v3 layer has the shape
 *       `{ clipId, kind, key, resultKey, firstFrame, count, contentKey, envFingerprint, candidates: [{ resultKey, envFingerprint, key }] }`
 *       (`resultKey` / `envFingerprint` / `key` on the layer equal the first candidate, so the
 *       old reading method still works); `opts.alive` is the set of result keys considered alive
 *       (`Set<string>`, derived from `task.done` and manifest). The selected candidate is
 *       returned in its entirety (`resultKey`, `envFingerprint`, `key` all originate from the same
 *       candidate), returning null when unrecognized; a v2 table is treated as "one candidate":
 *       returns that layer as before regardless of whether `alive` is present. Gate: 3 appears in
 *       `KNOWN_LAYER_MAP_VERSIONS`.
 *   K10 Whether page node can be enabled (Section 2 "Conditions for acting as a node", D14, D16,
 *       identity): one of `ELIGIBILITY_FILES` exports a pure function (one of `ELIGIBILITY_NAMES`),
 *       `fn({ online, codeVersion, phone, lowest, stageLayout: 'dual' | 'single', userAgent, member, measured })`
 *       → boolean (starting 2026-10-22, the previous tier parameter was replaced with phone identity
 *       `phone` and lowest tier `lowest`), or `{ ok | eligible: boolean, reason? }`.
 *   K11 Page node arrangement (Sections 2 and 4; D6, D8, D10 page side): one of `NODE_FILES` exports
 *       a factory (one of `NODE_FACTORY_NAMES`), `factory(deps)`, `deps` = `{ nodeId, projectId,
 *       userId, codeVersion, environment, now, isIdle(), send(message), keptProject(rev) → project
 *       | null (confirmed version retained at publish time), fetchSnapshot(rev) → Promise<project
 *       | null> (project.snapshot.get), bakeFrame({ task, project, localFrame, signal }) →
 *       Promise<{ hash, bytes, htmlGz? }>, finishTask({ task, frames }) → Promise<object> }`;
 *       returned object: `start()` (sends `node.hello` and `queue.watch`), `receive(message)`
 *       (messages received on render connection), `tick()` (tick for claiming and lease renewal),
 *       `yieldFor(cause)` (`cause` ∈ `'play' | 'drag' | 'urgent' | 'hidden'`, name taken from one of
 *       `NODE_METHODS.yieldFor`), `stop()`. Queue messages follow the shape in Section A of
 *       `render-queue-contract.md` (`task.claim { id, expectVersion }`,
 *       `task.release { id, token, reason }`, `task.progress { id, token, done }`,
 *       `task.complete { id, token, result? }`).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createRouter } from '../docservice/router.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { describeEnvironment } from '../render-node/fingerprint.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));
const textOf = (rel) => (exists(rel) ? fs.readFileSync(repoPath(rel), 'utf8') : '');

/* ------------------------------------------------------------------ Gates (K1) */

let tsHook = null;
export async function importRepo(rel) {
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
    tsHook ??= import(repoUrl('src/testing/registerTs.mjs'));
    await tsHook;
  }
  return import(repoUrl(rel));
}

/** Statically exported names of a source file */
export function staticExports(rel) {
  const names = new Set();
  const src = textOf(rel);
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}
export function findExport(files, names) {
  for (const file of files) {
    const got = staticExports(file);
    for (const name of names) if (got.has(name)) return { file, name };
  }
  return null;
}
export function pickMethod(obj, names) {
  for (const n of names) if (obj && typeof obj[n] === 'function') return n;
  return null;
}

const SKIP_TAIL = '(M7 implementation not integrated yet; once integrated it automatically becomes a real run)';
/** Implementation is considered present only when a marker (string or regex) appears in the source file */
function markerGate(files, marker, what) {
  const hit = files.find((f) => (marker instanceof RegExp ? marker.test(textOf(f)) : textOf(f).includes(marker)));
  return hit ? { ok: true, file: hit } : { ok: false, reason: `Implementation missing: no ${what} in ${files.join(', ')} ${SKIP_TAIL}` };
}
function exportGate(files, names) {
  const hit = findExport(files, names);
  if (hit) return { ok: true, ...hit };
  const present = files.filter(exists);
  const where = present.length ? `File ${present.join(', ')} exists, but does not export ${names.join(' / ')}` : `None of the files ${files.join(', ')} exist`;
  return { ok: false, reason: `Implementation missing: ${where} ${SKIP_TAIL}` };
}
/** `test(name, gateOpts(gate), fn)`: skip and state reason if gate is not open */
export const gateOpts = (gate) => (gate.ok ? {} : { skip: gate.reason });

const QUEUE_FILE = 'server/render-queue/queue.mjs';
const MODULE_FILE = 'server/docservice/modules/render-queue.mjs';
export const ownerGate = () => markerGate([MODULE_FILE, QUEUE_FILE], /\.owner\b/, '`.owner` (K2, D9 profile and nodeId are bound to the credential)');
export const authOwnerGate = () => markerGate(['server/auth/protocol.mjs'], /kind\s*===\s*'browser'/, "`kind === 'browser'` (K2, normalizeOwner accepts browser)");
export const serverFpGate = () => markerGate([MODULE_FILE, QUEUE_FILE], 'describeEnvironment', '`describeEnvironment` (K3, D10 the fingerprint is computed by the server)');
export const queueDualGate = () => markerGate([QUEUE_FILE], 'dual', '`dual` (K4, D1 invalidates the other copy when the lock is created)');
export const lockIdleGate = () => markerGate([QUEUE_FILE], 'lockIdleMs', '`lockIdleMs` (K5, D2 lock idle)');
export const splitDualGate = () => markerGate(['server/render-node/split.mjs'], 'dual', '`dual` (K6, D1 keys issued for both copies)');
export const filterIndependentGate = () => markerGate(['server/render-node/filter.mjs'], 'compositing', '`compositing` (K7, D4 accepts only independent cards)');
export const layerV3Gate = () => markerGate(['src/render/snapshotSource.ts'], /KNOWN_LAYER_MAP_VERSIONS[^=]*=\s*\[[^\]]*\b3\b/, 'KNOWN_LAYER_MAP_VERSIONS contains 3 (K9, layer table v3)');

/* K8 */
export const IDLE_TAKEOVER_FILES = [
  'server/render-node/local-node.mjs', 'server/render-node/lock-idle.mjs', 'server/render-node/takeover.mjs',
  'server/render-node/split.mjs', 'server/card-lock.mjs', 'server/queue-publish.mjs', 'server/prerender-executor.mjs',
];
export const IDLE_TAKEOVER_NAMES = ['idleLockTakeover', 'takeoverIdleLock', 'shouldTakeoverLock', 'lockIdleTakeover', 'takeoverWhenIdle', 'takeoverIfIdle'];
export const idleTakeoverGate = () => exportGate(IDLE_TAKEOVER_FILES, IDLE_TAKEOVER_NAMES);

/* K10 */
export const ELIGIBILITY_FILES = [
  'src/online/browserNode.ts', 'src/online/renderNode.ts', 'src/online/nodeEligibility.ts', 'src/online/pageNode.ts',
  'src/editor/browserNode.ts', 'src/editor/sync/browserNode.ts', 'src/online/browserNodeGate.ts',
];
export const ELIGIBILITY_NAMES = ['browserNodeEligibility', 'nodeEligibility', 'canBeNode', 'mayBeNode', 'browserNodeAllowed', 'judgeBrowserNode', 'canServeAsNode'];
export const eligibilityGate = () => exportGate(ELIGIBILITY_FILES, ELIGIBILITY_NAMES);
export function normalizeEligible(r) {
  if (typeof r === 'boolean') return r;
  if (r && typeof r === 'object') {
    if (typeof r.ok === 'boolean') return r.ok;
    if (typeof r.eligible === 'boolean') return r.eligible;
  }
  throw new Error(`Assumption K10: response from which node eligibility cannot be recognized: ${JSON.stringify(r)}`);
}

/* K11 */
export const NODE_FILES = [
  'src/online/browserNode.ts', 'src/online/renderNode.ts', 'src/online/pageNode.ts', 'src/editor/browserNode.ts',
  'src/editor/sync/browserNode.ts', 'src/online/browserRenderNode.ts',
];
export const NODE_FACTORY_NAMES = ['createBrowserNode', 'createPageNode', 'createBrowserRenderNode', 'createOnlineNode'];
export const NODE_METHODS = {
  start: ['start', 'begin', 'open'],
  receive: ['receive', 'onMessage', 'handle'],
  tick: ['tick', 'step'],
  yieldFor: ['yieldFor', 'giveWay', 'yield', 'standDown'],
  stop: ['stop', 'dispose', 'close'],
};
export const browserNodeGate = () => exportGate(NODE_FILES, NODE_FACTORY_NAMES);

/* ------------------------------------------------------------------ Fingerprints and keys */

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
/** Contract B.1: result key = sha256(contentKey \n fp) */
export const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp ?? ''}`);

export const UA = Object.freeze({
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
});
/** Raw values of `pageEnvironment()` (K3) */
export const ENV = Object.freeze({
  winNvidiaChrome: Object.freeze({ platform: 'Windows', userAgent: UA.chrome, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' }),
  winNvidiaFirefox: Object.freeze({ platform: 'Win32', userAgent: UA.firefox, renderer: 'NVIDIA GeForce GTX 980, or similar', vendor: 'Mozilla' }),
  macSafari: Object.freeze({ platform: 'MacIntel', userAgent: UA.safari, renderer: 'Apple GPU', vendor: 'Apple Inc.' }),
});
/** K3: Server-expected fingerprint (same conversion as route for storing measurement frames) */
export const serverFingerprintOf = (env) => describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;

/* ------------------------------------------------------------------ Tasks */

export const taskIdOf = ({ kind, resultKey, range }) => (kind === 'plan' ? `plan:${resultKey}` : `${kind}:${resultKey}:${range.from}-${range.to}`);

/** A segment of shared-tier snapshot task (Contract A.4 shape, self-computed id) */
export function snapTask({
  projectId = 'p1', projectRev = 1, contentKey = 'ck-1', fp, seg = 0, span = 60, weight = 'medium', tier = 'shared',
  input = {}, requires = {}, priority, derivedFrom,
} = {}) {
  const from = seg * span;
  const range = { unit: 'localFrame', from, to: from + span - 1 };
  const resultKey = rk(contentKey, fp);
  const t = {
    id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier, resultKey, range,
    source: { projectId, projectRev, ...(derivedFrom !== undefined ? { derivedFrom } : {}) },
    input: { clipId: `clip-${contentKey}`, cardId: 'motion', entryKey: null, contentKey, canvasHeavy: false, compositing: 'independent', ...input },
    weight: { class: weight, estMs: null, frames: span },
    requires: { envFingerprint: fp, codeVersion: 'cv-1', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, ...requires },
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}
export function streamTask({ projectId = 'p1', projectRev = 1, contentKey = 'st-1', fp, seg = 0 } = {}) {
  const from = seg * 8;
  const range = { unit: 'segment', from, to: from + 7 };
  const resultKey = rk(contentKey, fp);
  return {
    id: taskIdOf({ kind: 'stream', resultKey, range }), kind: 'stream', resultKey, range,
    source: { projectId, projectRev },
    input: { clipId: 'clip-bg', cardId: null, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: 120 },
    requires: { envFingerprint: fp, codeVersion: 'cv-1', cardSources: {}, transcode: true, capabilities: { streams: true } },
  };
}
/** Manifest plan (shape in C10 Section 18 Item 9) */
export function clipsPlan({ projectId = 'p1', projectRev = 1, sig = 'abc123', clips = ['clip-a'], input = {} } = {}) {
  const resultKey = `${projectId}@${projectRev}#clips:${sig}`;
  return {
    id: `plan:${resultKey}`, kind: 'plan', resultKey, range: null, source: { projectId, projectRev },
    input: { clips, ...input }, weight: { class: 'medium', estMs: null, frames: null }, requires: { codeVersion: 'cv-1' }, priority: 'normal',
  };
}

/* ------------------------------------------------------------------ Document service + queue module + queue */

/** Principal of member connection (K2). When `owner` is `'browser'`, it is a browser-owned render connection */
export function memberPrincipal({ username, device, role = 'render', owner = null, projectId = 'p1' }) {
  return {
    userId: `${username}@${device}`, tenantId: projectId, scope: 'member', username, deviceId: device, deviceName: device,
    creator: false, role, conversation: null, owner: owner === 'browser' ? { kind: 'browser' } : owner === 'user' ? { kind: 'user' } : null,
  };
}

/**
 * Real route + real queue module + real queue, no network started, fake clock (following
 * `createDocQueueRig` in `m6c-kit.mjs`).
 * Inboxes partitioned by connId, storing messages after JSON round-trip.
 */
export function createDocQueueRig({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const now = () => t;
  const inbox = new Map();
  const router = createRouter({
    now,
    write: (connId, text) => {
      if (!inbox.has(connId)) inbox.set(connId, []);
      inbox.get(connId).push(JSON.parse(text));
    },
  });
  let mod = null;
  const q = createRenderQueue({
    now, ...(constants ? { constants } : {}),
    send: (connId, message) => {
      let opts;
      if (typeof mod?.outbound === 'function') {
        opts = mod.outbound(connId, message);
        if (opts === null) return;
      }
      router.send(connId, message, opts);
    },
  });
  mod = renderQueueModule(q, {});
  router.mount(mod);
  let seq = 0;
  const rig = {
    q, router, mod, now,
    advance(ms) { t += ms; },
    tick() { router.tick(); },
    connect(connId, principal) { router.connect(connId, principal); },
    send(connId, message) { router.dispatch(connId, JSON.stringify(message)); },
    /** Send a message with reqId, return response with same reqId (returns undefined if none) */
    ask(connId, message) {
      const reqId = `r${++seq}`;
      rig.send(connId, { ...message, reqId });
      return rig.inbox(connId).find((m) => m.reqId === reqId);
    },
    inbox: (connId) => inbox.get(connId) ?? [],
    of: (connId, type) => (inbox.get(connId) ?? []).filter((m) => (Array.isArray(type) ? type.includes(m.type) : m.type === type)),
    clear(connId) { if (connId === undefined) inbox.clear(); else inbox.set(connId, []); },
    describe: () => q.describe(),
  };
  return rig;
}

/* ------------------------------------------------------------------ In-process: queue + node session */

/**
 * Synchronous direct connection: queue's send delivers by connId to registered recipient
 * function; also records all messages received on each connection
 */
export function createDirectQueue({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const routes = new Map();
  const log = new Map();
  const q = createRenderQueue({
    now: () => t, ...(constants ? { constants } : {}),
    send: (connId, message) => {
      const m = JSON.parse(JSON.stringify(message));
      if (!log.has(connId)) log.set(connId, []);
      log.get(connId).push(m);
      routes.get(connId)?.(m);
    },
  });
  return {
    q,
    now: () => t,
    advance(ms) { t += ms; },
    route(connId, fn) { routes.set(connId, fn); },
    log: (connId) => log.get(connId) ?? [],
  };
}

/* ------------------------------------------------------------------ Async */

/**
 * Yield several macro-task turns (not a timing assertion: only waits for scheduled Promise chains
 * to finish, without affecting order even on a busy machine)
 */
export async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
/** Promise that can be settled from the outside */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
