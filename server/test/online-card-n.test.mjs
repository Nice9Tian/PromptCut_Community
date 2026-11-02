/**
 * Block N (`docs/plan/online-card-exec-contract.md` section 7, task brief paragraph 2 item 16):
 * server side for browser-only nodes claiming user card and media effect card tasks.
 *
 *   OCN-01 Built-in card splitting and result keys do not change by a single character (compared
 *          one-by-one against literal values before changes)
 *   OCN-02 Environment fingerprints for user cards and media effect cards: runtime version added
 *          on top of the three environment items; never identical to envFingerprint; different
 *          result keys
 *   OCN-03 Document service `node.hello`: runtime version reported by browser node → server
 *          computes cardEnvFingerprint, returned in welcome; self-reported values do not count;
 *          other profiles never have it
 *   OCN-04 Node-side filtering (filter.mjs): user card and media effect card tasks only accept
 *          own tasks, reject transcoding, fingerprint by cardEnvFingerprint, code identity
 *          matches, capability bit present
 *   OCN-05 Splitting (split.mjs): browser copy for user cards and media effect cards (emitted
 *          only if self-reported by page + confirmed by document service), key uses
 *          cardEnvFingerprint; built-in cards unaffected
 *   OCN-06 Queue: pre-filtering and claiming by cardEnvFingerprint; on the same machine, desktop
 *          nodes and browser nodes have different result keys; one layer comes from only one
 *          environment
 *   OCN-07 Manifest plan's input.browser: normalization, signature, inbound validation
 *
 * Run: node --experimental-test-module-mocks --test server/test/online-card-n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitPlan } from '../render-node/split.mjs';
import { checkClaimable, filterClaimable } from '../render-node/filter.mjs';
import {
  describeEnvironment, describeCardEnvironment, cardEnvFingerprintOf, cardRuntimeOf, envFingerprintOf, resultKeyOf,
} from '../render-node/fingerprint.mjs';
import { createRenderQueue, clipsPlanTaskOf, browserCardsOf, browserCardsSig } from '../render-queue/index.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { createDocQueueRig, memberPrincipal, ENV, snapTask, serverFingerprintOf, rk } from './m7-kit.mjs';
import { runBattery } from './online-card-n-battery.mjs';

const RUNTIME = 'ocr1:sucrase@3.35.1:tailwindcss@4.3.3';
const BR_ENV = describeCardEnvironment({ platform: ENV.winNvidiaChrome.platform, renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent, cardRuntime: RUNTIME });
/** Same machine: desktop node (win32, same GPU, same Chrome major version) fingerprint equals browser's envFingerprint */
const DESK_FP = describeEnvironment({ platform: 'win32', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: 'HeadlessChrome/152.0.7977.75' }).fingerprint;
const ENVFP = BR_ENV.fingerprint;
const CARDFP = BR_ENV.cardEnvFingerprint;
const USER = 'zoe@devA';

/* ================================================================== OCN-01 */

test('OCN-01 splitting and result keys of built-in cards are unchanged to the last character: for the eleven split outputs, the task count, digest and each result key match the literal values from before the change one by one', () => {
  const labelMap = { '无浏览器': 'no browser', '浏览器指纹(docservice 给的)': 'browser fingerprint (given by docservice)', '浏览器指纹等于自己': 'browser fingerprint equals its own', 'browser 对象写法': 'browser object form', '锁在第三种环境': 'locked to a third environment', '锁在第三种环境并接手': 'locked to a third environment, with takeover', '预渲染重试档': 'prerender retry lane', '改过源码的内置卡': 'builtinCardWithModifiedSource', '含本地素材': 'includes local media', '有流': 'has streams', '指纹函数': 'fingerprint function' }; // i18n-allow
  const rawGolden = JSON.parse(fs.readFileSync(new URL('./online-card-n-golden.json', import.meta.url), 'utf8'));
  const golden = Object.fromEntries(Object.entries(rawGolden).map(([k, v]) => [labelMap[k] ?? k, v]));
  const now = runBattery();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort(), 'the labels of the comparison cases are complete');
  let keys = 0;
  for (const [label, g] of Object.entries(golden)) {
    assert.equal(now[label].count, g.count, `${label}: task count`);
    assert.deepEqual(now[label].keys, g.keys, `${label}: result keys identical one by one, same order`);
    assert.equal(now[label].digest, g.digest, `${label}: digest of the whole output`);
    keys += g.keys.length;
  }
  console.log(`OCN-01 compared ${Object.keys(golden).length} outputs and ${keys} result keys, all identical to before the change`);
  assert.ok(keys >= 40);
});

/* ================================================================== OCN-02 */

test('OCN-02 cardEnvFingerprint: the three environment fields plus the runtime version; never equal to envFingerprint; result keys differ on the same machine; envFingerprint is unchanged to the last character', () => {
  assert.match(CARDFP, /^[0-9a-f]{16}$/);
  assert.notEqual(CARDFP, ENVFP, 'same machine, same page: the two fingerprints differ');
  // The formula for envFingerprint is the same as before
  assert.equal(ENVFP, envFingerprintOf({ os: BR_ENV.os, gpuClass: BR_ENV.gpuClass, chromeMajor: BR_ENV.chromeMajor }));
  assert.equal(ENVFP, describeEnvironment({ platform: 'Windows', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent }).fingerprint);
  // Desktop nodes do not have a runtime version; on the same machine, its fingerprint is the
  // browser's envFingerprint
  assert.equal(DESK_FP, ENVFP);
  // Runtime version enters the fingerprint; changes if any environment item changes
  const other = describeCardEnvironment({ platform: 'Windows', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent, cardRuntime: 'ocr2:sucrase@3.35.1:tailwindcss@4.3.3' });
  assert.notEqual(other.cardEnvFingerprint, CARDFP, 'when the runtime version changes, the fingerprint changes');
  assert.equal(other.fingerprint, ENVFP, 'but envFingerprint is not affected by the runtime version');
  assert.notEqual(cardEnvFingerprintOf({ os: 'linux', gpuClass: 'software', chromeMajor: 152, cardRuntime: RUNTIME }), CARDFP, 'when the environment changes, the fingerprint changes');
  // Invalid runtime version: no such fingerprint
  for (const bad of [undefined, null, '', ' ', 'a b', 'x'.repeat(129), '中文', 'ocr1;drop', 7, {}]) {
    assert.equal(cardRuntimeOf(bad), null, JSON.stringify(bad));
    assert.equal(cardEnvFingerprintOf({ os: 'windows', gpuClass: 'nvidia', chromeMajor: 152, cardRuntime: bad }), null);
  }
  // On the same machine: desktop node and browser node have different result keys for the same card
  const content = 'c'.repeat(64);
  assert.notEqual(resultKeyOf(content, DESK_FP), resultKeyOf(content, CARDFP));
  // And will not collide with any three-item environment fingerprint (source text has an extra
  // card-runtime: line)
  for (const os of ['windows', 'macos', 'linux', 'other']) for (const gpu of ['nvidia', 'amd', 'intel', 'apple', 'software']) {
    assert.notEqual(envFingerprintOf({ os, gpuClass: gpu, chromeMajor: 152 }), cardEnvFingerprintOf({ os, gpuClass: gpu, chromeMajor: 152, cardRuntime: RUNTIME }));
  }
});

/* ================================================================== OCN-03 */

test('OCN-03 document service node.hello: the runtime version reported by a browser node → cardEnvFingerprint is computed by the server and returned in welcome; a self-reported one does not count; other profiles never have it', () => {
  const rig = createDocQueueRig();
  const browserConn = (id, user = 'zoe') => rig.connect(id, memberPrincipal({ username: user, device: 'devA', role: 'render', owner: 'browser' }));
  const hello = (conn, extra) => rig.ask(conn, { type: 'node.hello', nodeId: `n-${conn}`, profile: 'browser', maxConcurrent: 1, environment: { ...ENV.winNvidiaChrome }, ...extra });

  browserConn('b1');
  const plain = hello('b1', {});
  assert.equal(plain.type, 'node.welcome');
  assert.equal(plain.envFingerprint, serverFingerprintOf(ENV.winNvidiaChrome));
  assert.equal('cardEnvFingerprint' in plain, false, 'no runtime version reported: welcome is identical to before, character for character');

  browserConn('b2');
  const withRt = hello('b2', { cardRuntime: RUNTIME });
  assert.equal(withRt.envFingerprint, plain.envFingerprint, 'envFingerprint is unaffected');
  assert.equal(withRt.cardEnvFingerprint, CARDFP, 'the server computes it from the raw environment values plus the runtime version');

  browserConn('b3');
  const lying = hello('b3', { cardEnvFingerprint: 'f'.repeat(16) });
  assert.equal('cardEnvFingerprint' in lying, false, 'a self-reported cardEnvFingerprint does not count');
  browserConn('b4');
  const lying2 = hello('b4', { cardRuntime: RUNTIME, cardEnvFingerprint: 'f'.repeat(16) });
  assert.equal(lying2.cardEnvFingerprint, CARDFP, 'the self-reported one is overwritten by the server\'s computed one');

  browserConn('b5');
  assert.equal('cardEnvFingerprint' in hello('b5', { cardRuntime: 'bad runtime!' }), false, 'an invalid runtime version is treated as not reported');

  // Other profiles: whatever desktop (pc) and standalone host (host) report, they never have this item
  rig.connect('pc1', memberPrincipal({ username: 'boss', device: 'pc', role: 'render' }));
  const pc = rig.ask('pc1', { type: 'node.hello', nodeId: 'n-pc', profile: 'pc', envFingerprint: DESK_FP, cardRuntime: RUNTIME, cardEnvFingerprint: CARDFP, environment: { ...ENV.winNvidiaChrome } });
  assert.equal(pc.type, 'node.welcome');
  assert.equal('cardEnvFingerprint' in pc, false, 'pc does not have this field');
  rig.connect('pc2', memberPrincipal({ username: 'boss', device: 'pc2', role: 'render' }));
  const noEnv = rig.ask('pc2', { type: 'node.hello', nodeId: 'n-pc2', profile: 'pc', envFingerprint: DESK_FP, cardRuntime: RUNTIME, cardEnvFingerprint: CARDFP });
  assert.equal('cardEnvFingerprint' in noEnv, false, 'without raw environment values the fingerprint cannot be computed: a self-reported one does not count');
  const nodes = rig.describe().nodes;
  assert.equal(nodes.find((n) => n.nodeId === 'n-b2').cardEnvFingerprint, CARDFP, 'visible in the describe diagnostics');
  assert.equal('cardEnvFingerprint' in nodes.find((n) => n.nodeId === 'n-pc'), false);
  assert.equal('cardEnvFingerprint' in nodes.find((n) => n.nodeId === 'n-b1'), false);
});

/* ================================================================== OCN-04 */

const IDENT = 'a1'.repeat(16);
/** A browser task for a user card (fingerprint = cardEnvFingerprint) */
function cardTask(extra = {}) {
  const { requires, input, ...rest } = extra;
  return {
    ...snapTask({ fp: CARDFP, span: 3, projectRev: 7, contentKey: 'ck-user', input: { dual: true, cardId: 'ouc-user', bake: { count: 3, sampling: { firstFrame: 0 } }, ...input },
      requires: { userCards: true, cardSources: { 'ouc-user': IDENT }, ...requires }, ...rest }),
    source: { projectId: 'p1', projectRev: 7, userId: USER },
  };
}
const builtinTask = (extra = {}) => ({ ...snapTask({ fp: ENVFP, span: 3, projectRev: 7, contentKey: 'ck-builtin', ...extra }), source: { projectId: 'p1', projectRev: 7, userId: USER } });
const browserNode = (extra = {}) => ({
  profile: 'browser', nodeId: 'n-br', userId: USER, envFingerprint: ENVFP, cardEnvFingerprint: CARDFP, codeVersions: ['cv-1'],
  capabilities: { transcode: false, streams: false, userCards: true, graphCards: true }, cardSourceVersions: { 'ouc-user': [IDENT] }, ...extra,
});

test('OCN-04 node-side filtering: a pure browser claims tasks of user cards and media effect cards only if the fingerprint (by cardEnvFingerprint), the code identity and the capability bits all match; everything else as before', () => {
  const node = browserNode();
  assert.deepEqual(checkClaimable(cardTask(), node), { ok: true }, 'user card task');
  assert.deepEqual(checkClaimable(cardTask({ requires: { graphCards: true } }), node), { ok: true }, 'user media effect card task (needs both capability bits)');
  assert.deepEqual(checkClaimable(builtinTask(), node), { ok: true }, 'built-in card tasks are still compared by envFingerprint');

  // Fingerprint: user card tasks with envFingerprint are rejected, built-in card tasks with
  // cardEnvFingerprint are rejected
  assert.equal(checkClaimable(cardTask({ fp: ENVFP }), node).reason, 'env-fingerprint', 'a user card task\'s fingerprint is the desktop one (same machine)');
  assert.equal(checkClaimable({ ...cardTask(), requires: { ...cardTask().requires, envFingerprint: DESK_FP } }, node).rule, 1);
  assert.equal(checkClaimable(builtinTask({ fp: CARDFP }), node).reason, 'env-fingerprint', 'built-in card tasks do not use cardEnvFingerprint');
  // Page has no cardEnvFingerprint (legacy queue, invalid runtime version): user card task
  // fingerprint mismatch
  assert.equal(checkClaimable(cardTask(), browserNode({ cardEnvFingerprint: null })).reason, 'env-fingerprint');
  assert.deepEqual(checkClaimable(builtinTask(), browserNode({ cardEnvFingerprint: null })), { ok: true }, 'built-in cards are unaffected');
  // Capability bit (rule 3)
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ capabilities: { userCards: false } })), { ok: false, rule: 3, reason: 'user-cards' });
  assert.deepEqual(checkClaimable(cardTask({ requires: { graphCards: true } }), browserNode({ capabilities: { userCards: true, graphCards: false } })), { ok: false, rule: 3, reason: 'graph-cards' });
  // Card code identity (rule 1): node holds a different version or none at all
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: { 'ouc-user': ['other'] } })), { ok: false, rule: 1, reason: 'card-source' });
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: {} })), { ok: false, rule: 1, reason: 'card-source' });
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: { 'ouc-user': ['other', IDENT] } })), { ok: true }, 'both identities are recognized when reported during a generation switch');
  // Splitter provided no code identity: browser does not accept (user cards always have an identity)
  assert.deepEqual(checkClaimable(cardTask({ requires: { cardSources: {} } }), node), { ok: false, rule: 7, reason: 'card-source-missing' });
  // Unchanged: only accept own (rule 0), reject transcoding (rule 2), reject streams, reject
  // local tier, non-standalone cards, and canvas cards (rule 7), heavy policy (rule 4)
  assert.deepEqual(checkClaimable({ ...cardTask(), source: { projectId: 'p1', projectRev: 7, userId: 'mallory@devB' } }, node), { ok: false, rule: 0, reason: 'other-user' });
  assert.equal(checkClaimable(cardTask({ requires: { transcode: true } }), node).rule, 2, 'tasks that need local transcoding are not claimed');
  // After rule 2 was changed to inspect only requires.transcode written by the task itself
  // (browser-stream-task.md second occurrence), stream tasks not in browser shape are blocked by
  // rule 7 (no input.stream);
  // The splitter's own stream tasks (with transcode: true) are blocked by rule 2 as before
  assert.deepEqual(checkClaimable({ ...cardTask(), kind: 'stream' }, node), { ok: false, rule: 7, reason: 'not-card-stream' }, 'stream tasks are not claimed');
  assert.equal(checkClaimable({ ...cardTask({ requires: { transcode: true } }), kind: 'stream' }, node).rule, 2, 'stream tasks that need local transcoding are not claimed');
  assert.equal(checkClaimable(cardTask({ tier: 'local' }), node).rule, 7);
  assert.equal(checkClaimable(cardTask({ input: { compositing: 'belowDependent' } }), node).reason, 'not-independent');
  assert.equal(checkClaimable(cardTask({ input: { canvasHeavy: true } }), node).reason, 'canvas-heavy');
  assert.equal(checkClaimable(cardTask({ weight: 'heavy' }), node).reason, 'weight');
  // Desktop node unaffected: does not use this field even if present (no cardEnvFingerprint for
  // this rule), user card tasks still compare envFingerprint
  const desk = { profile: 'pc', nodeId: 'n-pc', userId: 'boss@pc', envFingerprint: DESK_FP, cardEnvFingerprint: CARDFP, codeVersions: ['cv-1'], capabilities: { userCards: true, graphCards: true }, cardSourceVersions: { 'ouc-user': [IDENT] }, weightPolicy: { pc: 'all' } };
  assert.equal(checkClaimable(cardTask(), desk).reason, 'env-fingerprint', 'desktop nodes do not use cardEnvFingerprint');
  assert.deepEqual(checkClaimable(cardTask({ fp: DESK_FP }), desk), { ok: true });
  assert.deepEqual(filterClaimable([cardTask(), builtinTask(), cardTask({ fp: ENVFP })], node).length, 2);
});

/* ================================================================== OCN-05 */

const OWN = DESK_FP;
const sk = (ck, fp) => rk(ck, fp);
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: sk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    count: 120, sampling: { firstFrame: 0, step: 1 }, compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra,
  };
}
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
const PAGE = (extra = {}) => ({ cardEnvFingerprint: CARDFP, userCards: true, graphCards: true, cardSources: { 'card-u': IDENT, 'card-g': 'g'.repeat(32) }, ...extra });
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', range: null, source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['u', 'g', 'm'] }, requires: { codeVersion: 'cv-1' }, priority: 'normal' };
function split({ cardPlan, page = PAGE(), docs = [CARDFP], browserFingerprints = [ENVFP], cardSourceVersions = { 'card-u': IDENT, 'card-g': 'g'.repeat(32) }, cardLocks = {} }) {
  return splitPlan({
    planTask, entryKey: 'entry-1', cardPlan, prerenderSet: null, envFingerprint: OWN, codeVersion: 'cv-1', anchorFrames: [0], weightOf,
    cardSourceVersions, isUserCard: (c) => /^(u|g)/.test(c.clipId), isGraphCard: (c) => c.clipId.startsWith('g'),
    browserFingerprints, browserCards: page ? browserCardsOf(page) : null, browserCardEnvFingerprints: docs, cardLocks,
  });
}
const of = (tasks, clipId) => tasks.filter((t) => t.input.clipId === clipId);

test('OCN-05 splitting: the browser copy of user cards and media effect cards builds its key from cardEnvFingerprint (on the same machine its result key differs from the desktop copy\'s); if the conditions are not all met, no extra copy is produced', () => {
  const plan = [control('u'), control('g'), control('m')];
  const tasks = split({ cardPlan: plan });
  // User card: two copies per segment
  const u = of(tasks, 'u');
  assert.equal(u.length, 4, `two segments × two copies:${JSON.stringify(u.map((t) => t.id))}`);
  const deskCopy = u.filter((t) => t.requires.envFingerprint === OWN);
  const brCopy = u.filter((t) => t.requires.envFingerprint === CARDFP);
  assert.equal(deskCopy.length, 2);
  assert.equal(brCopy.length, 2);
  for (const t of deskCopy) assert.equal(t.resultKey, resultKeyOf('ck-u', OWN));
  for (const t of brCopy) assert.equal(t.resultKey, resultKeyOf('ck-u', CARDFP));
  assert.notEqual(resultKeyOf('ck-u', OWN), resultKeyOf('ck-u', CARDFP), 'on the same machine the desktop and browser result keys differ and do not get mixed up');
  for (const t of u) { assert.equal(t.input.dual, true); assert.equal('takeover' in t, false); assert.equal(t.requires.userCards, true); assert.deepEqual(t.requires.cardSources, { 'card-u': IDENT }); }
  for (const t of brCopy) { assert.equal(t.input.compositing, 'independent'); assert.equal(t.input.bake.count, 120); }
  for (const t of deskCopy) assert.equal('bake' in t.input, false, 'the desktop copy does not carry the parameters for generating snapshots in the page');
  // Media effect card: requires both capability bits
  const g = of(tasks, 'g');
  assert.equal(g.length, 4);
  assert.ok(g.every((t) => t.requires.userCards === true && t.requires.graphCards === true));
  assert.equal(g.filter((t) => t.requires.envFingerprint === CARDFP).length, 2);
  // Built-in card m: browser envFingerprint is identical to desktop (same machine), emits only
  // one copy, same as before
  const m = of(tasks, 'm');
  assert.equal(m.length, 2);
  assert.ok(m.every((t) => t.requires.envFingerprint === OWN && t.input.dual !== true));

  // Page did not declare media effect card capability: no browser copy emitted for media effect
  // cards, user cards emitted as usual
  const noGraph = split({ cardPlan: plan, page: PAGE({ graphCards: false }) });
  assert.equal(of(noGraph, 'g').length, 2);
  assert.equal(of(noGraph, 'u').length, 4);
  // Page did not declare user card capability: neither is emitted
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ userCards: false }) }), 'u').length, 2);
  // Code identity mismatch or card missing on page: not emitted
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ cardSources: { 'card-u': 'other', 'card-g': 'g'.repeat(32) } }) }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ cardSources: {} }) }), 'u').length, 2);
  // Splitter itself has no code identity for this card (requires.cardSources is empty): not emitted
  assert.equal(of(split({ cardPlan: plan, cardSourceVersions: {} }), 'u').length, 2);
  // Page did not self-report (legacy page), or document service does not confirm this
  // cardEnvFingerprint (page misreported, node offline): not emitted
  assert.equal(of(split({ cardPlan: plan, page: null }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, docs: [] }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, docs: ['9'.repeat(16)] }), 'u').length, 2);
  // Local tier, canvas card, Lottie, limit exceeded: not emitted as before
  assert.equal(of(split({ cardPlan: [control('u', { tier: 'local' })] }), 'u').every((t) => t.requires.envFingerprint === OWN), true);
  assert.equal(of(split({ cardPlan: [control('u', { capabilities: { compositing: 'independent', canvasHeavy: true } })] }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: [control('u', { snapshotOversize: true })] }), 'u').length, 2);
  // Cards already locked by desktop: emit one copy per lock, no separate browser copy; locked on
  // browser fingerprint: emit one copy per lock with page generate snapshots parameters
  const lockedDesk = of(split({ cardPlan: plan, cardLocks: { 'snapshot:ck-u': OWN } }), 'u');
  assert.equal(lockedDesk.length, 2);
  assert.ok(lockedDesk.every((t) => t.requires.envFingerprint === OWN && t.input.dual !== true));
  const lockedBr = of(split({ cardPlan: plan, cardLocks: { 'snapshot:ck-u': CARDFP } }), 'u');
  assert.equal(lockedBr.length, 2);
  assert.ok(lockedBr.every((t) => t.requires.envFingerprint === CARDFP && t.resultKey === resultKeyOf('ck-u', CARDFP) && t.input.bake?.count === 120));
});

/* ================================================================== OCN-06 */

test('OCN-06 queue: pre-filtering and claiming go by cardEnvFingerprint; on the same machine the desktop and browser copies have different result keys, whoever claims first gets the lock and the other copy is invalidated; the reply to claiming a plan carries the confirmed cardEnvFingerprint', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'pub-page', { userId: USER });
  h.node('pc', 'n-pc', { profile: 'pc', userId: 'boss@pc', watch: ['p1'], hello: { envFingerprint: OWN, codeVersions: ['cv-1'] } });
  h.handle('pc', { type: 'publisher.hello', publisherId: 'pub-pc' });
  h.node('br', 'n-br', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: ENVFP, cardEnvFingerprint: CARDFP, codeVersions: ['cv-1'] } });
  h.node('old', 'n-old', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: ENVFP, codeVersions: ['cv-1'] } });
  // Browser hello response includes cardEnvFingerprint; omitted for unreported and desktop
  const helloOf = (conn) => h.bus.of(conn, 'node.welcome').map((m) => m.cardEnvFingerprint);
  assert.deepEqual([helloOf('br'), helloOf('old'), helloOf('pc')], [[CARDFP], [undefined], [undefined]]);
  assert.equal(h.nodeInfo('n-br').cardEnvFingerprint, CARDFP);

  // Manifest plan: page sends, desktop claims → split → publish two copies (one for desktop, one for browser)
  const plan = clipsPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['u'], codeVersion: 'cv-1', browser: PAGE() });
  h.publish('page', [plan]);
  const claimed = h.claim('pc', plan.id, 1).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(claimed.type, 'task.claimed', JSON.stringify(claimed));
  assert.deepEqual(claimed.browserCardEnvFingerprints, [CARDFP], 'document service confirms: this project has an online browser node of the same user carrying this cardEnvFingerprint');
  assert.deepEqual(claimed.browserFingerprints, [ENVFP]);
  assert.deepEqual(claimed.task.input.browser, browserCardsOf(PAGE()), 'input.browser is handed to the splitter along with the plan');
  const tasks = splitPlan({
    planTask: claimed.task, entryKey: 'entry-1', cardPlan: [control('u')], prerenderSet: null, envFingerprint: OWN, codeVersion: 'cv-1', anchorFrames: [0], weightOf,
    cardSourceVersions: { 'card-u': IDENT }, isUserCard: () => true, browserFingerprints: claimed.browserFingerprints,
    browserCards: browserCardsOf(claimed.task.input.browser), browserCardEnvFingerprints: claimed.browserCardEnvFingerprints,
  });
  assert.equal(tasks.length, 4);
  const res = h.publish('pc', tasks).one('pc', 'task.published').results;
  for (const r of res) assert.equal(r.error, undefined, JSON.stringify(r));

  const opened = (conn) => h.bus.of(conn, 'task.opened').map((m) => m.task).filter((t) => t.kind === 'snapshot');
  const brSeen = opened('br');
  assert.deepEqual(brSeen.map((t) => t.requires.envFingerprint), [CARDFP, CARDFP], 'the browser node sees only the cardEnvFingerprint copy');
  assert.deepEqual(opened('pc').map((t) => t.requires.envFingerprint), [OWN, OWN], 'the desktop node sees only its own copy');
  assert.deepEqual(opened('old'), [], 'an old page that did not report a runtime version cannot see user card tasks');

  // Claim: legacy page claiming browser copy is blocked by fingerprint; desktop claiming browser
  // copy is blocked; browser claim succeeds
  const brTask = brSeen.find((t) => t.range.from === 0);
  assert.equal(h.claim('old', brTask.id, brTask.version).last('old', ['task.claimed', 'task.claim-rejected']).reason, 'fingerprint-mismatch');
  assert.equal(h.claim('pc', brTask.id, brTask.version).last('pc', ['task.claimed', 'task.claim-rejected']).reason, 'fingerprint-mismatch');
  const got = h.claim('br', brTask.id, brTask.version).last('br', ['task.claimed', 'task.claim-rejected']);
  assert.equal(got.type, 'task.claimed', JSON.stringify(got));
  // First to claim gets the lock: locked on cardEnvFingerprint, desktop copy (same lock key,
  // different fingerprint, dual) is invalidated
  const d = h.describe();
  for (const t of tasks.filter((x) => x.requires.envFingerprint === OWN)) {
    const s = d.tasks.find((x) => x.id === t.id);
    assert.deepEqual([s.state, s.lastError], ['failed', 'superseded'], `${t.id}:${JSON.stringify(s)}`);
  }
  const lock = d.locks.find((l) => l.lockKey === 'snapshot:ck-u');
  assert.equal(lock?.envFingerprint, CARDFP, 'this layer comes from the browser environment only');
  // Thereafter, when desktop node republishes desktop copy for this card, it is rejected by lock
  // (no mixed environments)
  const again = h.publish('pc', tasks.filter((x) => x.requires.envFingerprint === OWN).map((t) => ({ ...t, id: t.id }))).one('pc', 'task.published').results;
  assert.ok(again.every((r) => r.error === 'card-locked' && r.lockedBy === CARDFP), JSON.stringify(again));

  // Built-in card tasks unaffected: browser claims by envFingerprint as usual (desktop on same
  // machine also recognizes it, same key on both sides)
  const b = builtinTask();
  h.publish('page', [{ ...b, source: { projectId: 'p1', projectRev: 7 } }]);
  assert.equal(h.claim('br', b.id, 1).last('br', ['task.claimed', 'task.claim-rejected']).type, 'task.claimed');
});

/* ================================================================== OCN-07 */

test('OCN-07 input.browser of a manifest plan: normalized, same content gives the same signature, a change gives a new plan, without it the plan is identical to before character for character; inbound validation', () => {
  const clips = ['c2', 'c1'];
  const base = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips });
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: null }), base, 'without browser: identical character for character');
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { cardEnvFingerprint: 'BAD', cardSources: {} } }), base, 'invalid fingerprint: treated as absent');
  const page = { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { b: 'v-b', a: 'v-a' } };
  const t = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: page });
  assert.notEqual(t.id, base.id, 'with the cards this page can run: a different plan');
  assert.deepEqual(t.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { a: 'v-a', b: 'v-b' } });
  assert.deepEqual(Object.keys(t.input.browser.cardSources), ['a', 'b'], 'card ids in ascending order');
  assert.equal(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, cardSources: { a: 'v-a', b: 'v-b' } } }).id, t.id, 'same content, same signature (independent of key insertion order)');
  assert.notEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, cardSources: { a: 'v-a2', b: 'v-b' } } }).id, t.id, 'a card changes generation: a different plan');
  assert.notEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, graphCards: true } }).id, t.id, 'capabilities changed: a different plan');
  assert.match(t.id, /^plan:p1@3#clips:[0-9a-z]{1,32}$/, 'the signature is still lowercase letters and digits');
  assert.equal(browserCardsSig(browserCardsOf(page)), [CARDFP, 1, 0, 'a=v-a', 'b=v-b'].join('|'));

  // Inbound validation: accepts it, and retains only normalized input.browser
  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  const ok = parse(t);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body.tasks[0].input.browser, t.input.browser);
  const dirty = { ...t, input: { ...t.input, browser: { ...t.input.browser, extra: 1, cardSources: { ...t.input.browser.cardSources, '': 'x', bad: 5, long: 'x'.repeat(200) } } } };
  const cleaned = parse(dirty);
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.body.tasks[0].input.browser, t.input.browser, 'extra fields and invalid card entries are removed');
  const noFp = parse({ ...t, input: { ...t.input, browser: { userCards: true } } });
  assert.equal(noFp.ok, true);
  assert.equal('browser' in noFp.body.tasks[0].input, false, 'an invalid entry is removed entirely, the task is still sent');
  // Prerender retry plan and desktop plan are unaffected
  assert.equal(parse({ ...base, input: { clips: ['c1', 'c2'], browser: page } }).body.tasks[0].input.browser !== undefined, true, 'only manifest plans are normalized');
});
