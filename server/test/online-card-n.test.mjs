/**
 * 块 N(`docs/plan/online-card-exec-contract.md` 第 7 节,任务书第二段第 16 条):纯浏览器节点认领用户卡与素材效果卡任务的服务端一侧。
 *
 *   OCN-01 内置卡的切分与结果键一个字不变(与改动之前的字面值逐个比)
 *   OCN-02 用户卡、素材效果卡的环境指纹:在环境三项之外加运行时版本;与 envFingerprint 永不相同;结果键不同
 *   OCN-03 文档服务 `node.hello`:浏览器节点报的运行时版本 → 服务端算 cardEnvFingerprint、welcome 带回;自报的不作数;别的 profile 一律没有
 *   OCN-04 节点侧过滤(filter.mjs):用户卡、素材效果卡任务只认本人的、不要转码的、指纹按 cardEnvFingerprint、代码身份对得上、能力位在
 *   OCN-05 切分(split.mjs):用户卡、素材效果卡的浏览器那一份(页面自报 + 文档服务确认才出),键用 cardEnvFingerprint;内置卡不受影响
 *   OCN-06 队列:前置过滤与认领按 cardEnvFingerprint;同一台机器上桌面节点与浏览器节点的结果键不同、一层只出自一种环境
 *   OCN-07 清单计划的 input.browser:规整、签名、入站校验
 *
 * 跑:node --experimental-test-module-mocks --test server/test/online-card-n.test.mjs
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
/** 同一台机器:桌面节点(win32、同显卡、同 Chrome 主版本)的指纹等于浏览器的 envFingerprint */
const DESK_FP = describeEnvironment({ platform: 'win32', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: 'HeadlessChrome/152.0.7977.75' }).fingerprint;
const ENVFP = BR_ENV.fingerprint;
const CARDFP = BR_ENV.cardEnvFingerprint;
const USER = 'zoe@devA';

/* ================================================================== OCN-01 */

test('OCN-01 内置卡的切分与结果键一个字不变:十一份切分输出的任务数、摘要、每个结果键与改动之前的字面值逐个相同', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('./online-card-n-golden.json', import.meta.url), 'utf8'));
  const now = runBattery();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort(), '对照用例的标签齐全');
  let keys = 0;
  for (const [label, g] of Object.entries(golden)) {
    assert.equal(now[label].count, g.count, `${label}:任务数`);
    assert.deepEqual(now[label].keys, g.keys, `${label}:结果键逐个相同、顺序相同`);
    assert.equal(now[label].digest, g.digest, `${label}:整份输出的摘要`);
    keys += g.keys.length;
  }
  console.log(`OCN-01 比对了 ${Object.keys(golden).length} 份输出、${keys} 个结果键,全部与改动之前相同`);
  assert.ok(keys >= 40);
});

/* ================================================================== OCN-02 */

test('OCN-02 cardEnvFingerprint:环境三项加运行时版本;与 envFingerprint 永不相同;同一台机器上结果键不同;envFingerprint 一个字不变', () => {
  assert.match(CARDFP, /^[0-9a-f]{16}$/);
  assert.notEqual(CARDFP, ENVFP, '同一台机器、同一个页面:两个指纹不同');
  // envFingerprint 的公式与原来相同
  assert.equal(ENVFP, envFingerprintOf({ os: BR_ENV.os, gpuClass: BR_ENV.gpuClass, chromeMajor: BR_ENV.chromeMajor }));
  assert.equal(ENVFP, describeEnvironment({ platform: 'Windows', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent }).fingerprint);
  // 桌面节点没有运行时版本这一项,同一台机器上它的指纹就是浏览器的 envFingerprint
  assert.equal(DESK_FP, ENVFP);
  // 运行时版本进指纹;环境任一项变了也变
  const other = describeCardEnvironment({ platform: 'Windows', renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent, cardRuntime: 'ocr2:sucrase@3.35.1:tailwindcss@4.3.3' });
  assert.notEqual(other.cardEnvFingerprint, CARDFP, '运行时版本变了,指纹变');
  assert.equal(other.fingerprint, ENVFP, '但 envFingerprint 不受运行时版本影响');
  assert.notEqual(cardEnvFingerprintOf({ os: 'linux', gpuClass: 'software', chromeMajor: 152, cardRuntime: RUNTIME }), CARDFP, '环境变了,指纹变');
  // 不合格的运行时版本:没有这个指纹
  for (const bad of [undefined, null, '', ' ', 'a b', 'x'.repeat(129), '中文', 'ocr1;drop', 7, {}]) {
    assert.equal(cardRuntimeOf(bad), null, JSON.stringify(bad));
    assert.equal(cardEnvFingerprintOf({ os: 'windows', gpuClass: 'nvidia', chromeMajor: 152, cardRuntime: bad }), null);
  }
  // 同一台机器上:桌面节点与浏览器节点对同一张卡的结果键不同
  const content = 'c'.repeat(64);
  assert.notEqual(resultKeyOf(content, DESK_FP), resultKeyOf(content, CARDFP));
  // 且不会撞上任何三项环境的指纹(原文多一行 card-runtime:)
  for (const os of ['windows', 'macos', 'linux', 'other']) for (const gpu of ['nvidia', 'amd', 'intel', 'apple', 'software']) {
    assert.notEqual(envFingerprintOf({ os, gpuClass: gpu, chromeMajor: 152 }), cardEnvFingerprintOf({ os, gpuClass: gpu, chromeMajor: 152, cardRuntime: RUNTIME }));
  }
});

/* ================================================================== OCN-03 */

test('OCN-03 文档服务 node.hello:浏览器节点报的运行时版本 → cardEnvFingerprint 由服务端算、welcome 带回;自报的不作数;别的 profile 一律没有', () => {
  const rig = createDocQueueRig();
  const browserConn = (id, user = 'zoe') => rig.connect(id, memberPrincipal({ username: user, device: 'devA', role: 'render', owner: 'browser' }));
  const hello = (conn, extra) => rig.ask(conn, { type: 'node.hello', nodeId: `n-${conn}`, profile: 'browser', maxConcurrent: 1, environment: { ...ENV.winNvidiaChrome }, ...extra });

  browserConn('b1');
  const plain = hello('b1', {});
  assert.equal(plain.type, 'node.welcome');
  assert.equal(plain.envFingerprint, serverFingerprintOf(ENV.winNvidiaChrome));
  assert.equal('cardEnvFingerprint' in plain, false, '没报运行时版本:welcome 与原来一字不差');

  browserConn('b2');
  const withRt = hello('b2', { cardRuntime: RUNTIME });
  assert.equal(withRt.envFingerprint, plain.envFingerprint, 'envFingerprint 不受影响');
  assert.equal(withRt.cardEnvFingerprint, CARDFP, '服务端按原始环境值加运行时版本算');

  browserConn('b3');
  const lying = hello('b3', { cardEnvFingerprint: 'f'.repeat(16) });
  assert.equal('cardEnvFingerprint' in lying, false, '自报 cardEnvFingerprint 不作数');
  browserConn('b4');
  const lying2 = hello('b4', { cardRuntime: RUNTIME, cardEnvFingerprint: 'f'.repeat(16) });
  assert.equal(lying2.cardEnvFingerprint, CARDFP, '自报的被服务端算的盖掉');

  browserConn('b5');
  assert.equal('cardEnvFingerprint' in hello('b5', { cardRuntime: 'bad runtime!' }), false, '不合格的运行时版本当没报');

  // 别的 profile:桌面(pc)与独立主机(host)报什么都没有这一项
  rig.connect('pc1', memberPrincipal({ username: 'boss', device: 'pc', role: 'render' }));
  const pc = rig.ask('pc1', { type: 'node.hello', nodeId: 'n-pc', profile: 'pc', envFingerprint: DESK_FP, cardRuntime: RUNTIME, cardEnvFingerprint: CARDFP, environment: { ...ENV.winNvidiaChrome } });
  assert.equal(pc.type, 'node.welcome');
  assert.equal('cardEnvFingerprint' in pc, false, 'pc 没有这一项');
  rig.connect('pc2', memberPrincipal({ username: 'boss', device: 'pc2', role: 'render' }));
  const noEnv = rig.ask('pc2', { type: 'node.hello', nodeId: 'n-pc2', profile: 'pc', envFingerprint: DESK_FP, cardRuntime: RUNTIME, cardEnvFingerprint: CARDFP });
  assert.equal('cardEnvFingerprint' in noEnv, false, '没有原始环境值就算不出指纹:自报的不作数');
  const nodes = rig.describe().nodes;
  assert.equal(nodes.find((n) => n.nodeId === 'n-b2').cardEnvFingerprint, CARDFP, 'describe 诊断里看得到');
  assert.equal('cardEnvFingerprint' in nodes.find((n) => n.nodeId === 'n-pc'), false);
  assert.equal('cardEnvFingerprint' in nodes.find((n) => n.nodeId === 'n-b1'), false);
});

/* ================================================================== OCN-04 */

const IDENT = 'a1'.repeat(16);
/** 一个用户卡的浏览器那份任务(指纹 = cardEnvFingerprint) */
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

test('OCN-04 节点侧过滤:纯浏览器认领用户卡与素材效果卡的任务——指纹按 cardEnvFingerprint、代码身份与能力位都对得上;其余照旧', () => {
  const node = browserNode();
  assert.deepEqual(checkClaimable(cardTask(), node), { ok: true }, '用户卡任务');
  assert.deepEqual(checkClaimable(cardTask({ requires: { graphCards: true } }), node), { ok: true }, '用户素材效果卡任务(两个能力位都要)');
  assert.deepEqual(checkClaimable(builtinTask(), node), { ok: true }, '内置卡任务照旧比 envFingerprint');

  // 指纹:用户卡任务拿 envFingerprint 的不收,内置卡任务拿 cardEnvFingerprint 的不收
  assert.equal(checkClaimable(cardTask({ fp: ENVFP }), node).reason, 'env-fingerprint', '用户卡任务指纹是桌面那份(同一台机器)');
  assert.equal(checkClaimable({ ...cardTask(), requires: { ...cardTask().requires, envFingerprint: DESK_FP } }, node).rule, 1);
  assert.equal(checkClaimable(builtinTask({ fp: CARDFP }), node).reason, 'env-fingerprint', '内置卡任务不用 cardEnvFingerprint');
  // 页面没有 cardEnvFingerprint(旧队列、运行时版本不合格):用户卡任务的指纹对不上
  assert.equal(checkClaimable(cardTask(), browserNode({ cardEnvFingerprint: null })).reason, 'env-fingerprint');
  assert.deepEqual(checkClaimable(builtinTask(), browserNode({ cardEnvFingerprint: null })), { ok: true }, '内置卡不受影响');
  // 能力位(规则 3)
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ capabilities: { userCards: false } })), { ok: false, rule: 3, reason: 'user-cards' });
  assert.deepEqual(checkClaimable(cardTask({ requires: { graphCards: true } }), browserNode({ capabilities: { userCards: true, graphCards: false } })), { ok: false, rule: 3, reason: 'graph-cards' });
  // 卡片代码身份(规则 1):节点手里是另一版、或根本没有
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: { 'ouc-user': ['other'] } })), { ok: false, rule: 1, reason: 'card-source' });
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: {} })), { ok: false, rule: 1, reason: 'card-source' });
  assert.deepEqual(checkClaimable(cardTask(), browserNode({ cardSourceVersions: { 'ouc-user': ['other', IDENT] } })), { ok: true }, '换代期间两个身份都报时认得');
  // 切分方没给代码身份:浏览器不接(用户卡一定有身份)
  assert.deepEqual(checkClaimable(cardTask({ requires: { cardSources: {} } }), node), { ok: false, rule: 7, reason: 'card-source-missing' });
  // 不变的:只认本人的(规则 0)、不要转码的(规则 2)、不认流、不认本地档与非独立卡与画布卡(规则 7)、重度策略(规则 4)
  assert.deepEqual(checkClaimable({ ...cardTask(), source: { projectId: 'p1', projectRev: 7, userId: 'mallory@devB' } }, node), { ok: false, rule: 0, reason: 'other-user' });
  assert.equal(checkClaimable(cardTask({ requires: { transcode: true } }), node).rule, 2, '要本机转码的不认领');
  // 规则 2 改成只看任务自己写的 requires.transcode(browser-stream-task.md 第二处)之后,不是浏览器形状的流任务由规则 7 挡(没有 input.stream);
  // 切分方自己的流任务(写了 transcode: true)照旧被规则 2 挡
  assert.deepEqual(checkClaimable({ ...cardTask(), kind: 'stream' }, node), { ok: false, rule: 7, reason: 'not-card-stream' }, '流任务不认领');
  assert.equal(checkClaimable({ ...cardTask({ requires: { transcode: true } }), kind: 'stream' }, node).rule, 2, '要本机转码的流任务不认领');
  assert.equal(checkClaimable(cardTask({ tier: 'local' }), node).rule, 7);
  assert.equal(checkClaimable(cardTask({ input: { compositing: 'belowDependent' } }), node).reason, 'not-independent');
  assert.equal(checkClaimable(cardTask({ input: { canvasHeavy: true } }), node).reason, 'canvas-heavy');
  assert.equal(checkClaimable(cardTask({ weight: 'heavy' }), node).reason, 'weight');
  // 桌面节点不受影响:有这个字段也不用它(没有这条规则的 cardEnvFingerprint),用户卡任务照旧比 envFingerprint
  const desk = { profile: 'pc', nodeId: 'n-pc', userId: 'boss@pc', envFingerprint: DESK_FP, cardEnvFingerprint: CARDFP, codeVersions: ['cv-1'], capabilities: { userCards: true, graphCards: true }, cardSourceVersions: { 'ouc-user': [IDENT] }, weightPolicy: { pc: 'all' } };
  assert.equal(checkClaimable(cardTask(), desk).reason, 'env-fingerprint', '桌面节点不用 cardEnvFingerprint');
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

test('OCN-05 切分:用户卡、素材效果卡的浏览器那一份用 cardEnvFingerprint 出键(同一台机器上与桌面那份的结果键不同);条件不齐一份都不多出', () => {
  const plan = [control('u'), control('g'), control('m')];
  const tasks = split({ cardPlan: plan });
  // 用户卡:每段两份
  const u = of(tasks, 'u');
  assert.equal(u.length, 4, `两段 × 两份:${JSON.stringify(u.map((t) => t.id))}`);
  const deskCopy = u.filter((t) => t.requires.envFingerprint === OWN);
  const brCopy = u.filter((t) => t.requires.envFingerprint === CARDFP);
  assert.equal(deskCopy.length, 2);
  assert.equal(brCopy.length, 2);
  for (const t of deskCopy) assert.equal(t.resultKey, resultKeyOf('ck-u', OWN));
  for (const t of brCopy) assert.equal(t.resultKey, resultKeyOf('ck-u', CARDFP));
  assert.notEqual(resultKeyOf('ck-u', OWN), resultKeyOf('ck-u', CARDFP), '同一台机器上桌面与浏览器的结果键不同、不串');
  for (const t of u) { assert.equal(t.input.dual, true); assert.equal('takeover' in t, false); assert.equal(t.requires.userCards, true); assert.deepEqual(t.requires.cardSources, { 'card-u': IDENT }); }
  for (const t of brCopy) { assert.equal(t.input.compositing, 'independent'); assert.equal(t.input.bake.count, 120); }
  for (const t of deskCopy) assert.equal('bake' in t.input, false, '桌面那份不带页面生成快照的参数');
  // 素材效果卡:两个能力位都要
  const g = of(tasks, 'g');
  assert.equal(g.length, 4);
  assert.ok(g.every((t) => t.requires.userCards === true && t.requires.graphCards === true));
  assert.equal(g.filter((t) => t.requires.envFingerprint === CARDFP).length, 2);
  // 内置卡 m:浏览器的 envFingerprint 与桌面相同(同一台机器),只出一份,与原来相同
  const m = of(tasks, 'm');
  assert.equal(m.length, 2);
  assert.ok(m.every((t) => t.requires.envFingerprint === OWN && t.input.dual !== true));

  // 页面没声明素材效果卡能力:素材效果卡不出浏览器那份,用户卡照出
  const noGraph = split({ cardPlan: plan, page: PAGE({ graphCards: false }) });
  assert.equal(of(noGraph, 'g').length, 2);
  assert.equal(of(noGraph, 'u').length, 4);
  // 页面没声明用户卡能力:都不出
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ userCards: false }) }), 'u').length, 2);
  // 代码身份对不上、页面没有这张卡:不出
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ cardSources: { 'card-u': 'other', 'card-g': 'g'.repeat(32) } }) }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, page: PAGE({ cardSources: {} }) }), 'u').length, 2);
  // 切分方自己手里没有这张卡的代码身份(requires.cardSources 空):不出
  assert.equal(of(split({ cardPlan: plan, cardSourceVersions: {} }), 'u').length, 2);
  // 页面没自报(旧页面),或文档服务不确认这个 cardEnvFingerprint(页面谎报、节点已下线):不出
  assert.equal(of(split({ cardPlan: plan, page: null }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, docs: [] }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: plan, docs: ['9'.repeat(16)] }), 'u').length, 2);
  // 本地档、画布卡、Lottie、超限:照旧不出
  assert.equal(of(split({ cardPlan: [control('u', { tier: 'local' })] }), 'u').every((t) => t.requires.envFingerprint === OWN), true);
  assert.equal(of(split({ cardPlan: [control('u', { capabilities: { compositing: 'independent', canvasHeavy: true } })] }), 'u').length, 2);
  assert.equal(of(split({ cardPlan: [control('u', { snapshotOversize: true })] }), 'u').length, 2);
  // 已被桌面锁住的卡:照锁出一份,不另出浏览器那份;锁在浏览器指纹上的:照锁出一份且带页面生成快照的参数
  const lockedDesk = of(split({ cardPlan: plan, cardLocks: { 'snapshot:ck-u': OWN } }), 'u');
  assert.equal(lockedDesk.length, 2);
  assert.ok(lockedDesk.every((t) => t.requires.envFingerprint === OWN && t.input.dual !== true));
  const lockedBr = of(split({ cardPlan: plan, cardLocks: { 'snapshot:ck-u': CARDFP } }), 'u');
  assert.equal(lockedBr.length, 2);
  assert.ok(lockedBr.every((t) => t.requires.envFingerprint === CARDFP && t.resultKey === resultKeyOf('ck-u', CARDFP) && t.input.bake?.count === 120));
});

/* ================================================================== OCN-06 */

test('OCN-06 队列:前置过滤与认领按 cardEnvFingerprint;同一台机器上桌面与浏览器的两份结果键不同,谁先认领谁得锁、另一份作废;认领 plan 的回包带确认过的 cardEnvFingerprint', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'pub-page', { userId: USER });
  h.node('pc', 'n-pc', { profile: 'pc', userId: 'boss@pc', watch: ['p1'], hello: { envFingerprint: OWN, codeVersions: ['cv-1'] } });
  h.handle('pc', { type: 'publisher.hello', publisherId: 'pub-pc' });
  h.node('br', 'n-br', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: ENVFP, cardEnvFingerprint: CARDFP, codeVersions: ['cv-1'] } });
  h.node('old', 'n-old', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: ENVFP, codeVersions: ['cv-1'] } });
  // 浏览器 hello 的回包带 cardEnvFingerprint;没报的、桌面的都没有
  const helloOf = (conn) => h.bus.of(conn, 'node.welcome').map((m) => m.cardEnvFingerprint);
  assert.deepEqual([helloOf('br'), helloOf('old'), helloOf('pc')], [[CARDFP], [undefined], [undefined]]);
  assert.equal(h.nodeInfo('n-br').cardEnvFingerprint, CARDFP);

  // 清单计划:页面发、桌面认领 → 切分 → 发布两份(桌面一份、浏览器一份)
  const plan = clipsPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['u'], codeVersion: 'cv-1', browser: PAGE() });
  h.publish('page', [plan]);
  const claimed = h.claim('pc', plan.id, 1).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(claimed.type, 'task.claimed', JSON.stringify(claimed));
  assert.deepEqual(claimed.browserCardEnvFingerprints, [CARDFP], '文档服务确认:本项目有同一用户的在线浏览器节点带着这个 cardEnvFingerprint');
  assert.deepEqual(claimed.browserFingerprints, [ENVFP]);
  assert.deepEqual(claimed.task.input.browser, browserCardsOf(PAGE()), 'input.browser 随计划交到切分方');
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
  assert.deepEqual(brSeen.map((t) => t.requires.envFingerprint), [CARDFP, CARDFP], '浏览器节点只看见 cardEnvFingerprint 那份');
  assert.deepEqual(opened('pc').map((t) => t.requires.envFingerprint), [OWN, OWN], '桌面节点只看见自己那份');
  assert.deepEqual(opened('old'), [], '没报运行时版本的旧页面看不见用户卡任务');

  // 认领:旧页面认领浏览器那份被指纹挡下;桌面认领浏览器那份被挡下;浏览器认领成功
  const brTask = brSeen.find((t) => t.range.from === 0);
  assert.equal(h.claim('old', brTask.id, brTask.version).last('old', ['task.claimed', 'task.claim-rejected']).reason, 'fingerprint-mismatch');
  assert.equal(h.claim('pc', brTask.id, brTask.version).last('pc', ['task.claimed', 'task.claim-rejected']).reason, 'fingerprint-mismatch');
  const got = h.claim('br', brTask.id, brTask.version).last('br', ['task.claimed', 'task.claim-rejected']);
  assert.equal(got.type, 'task.claimed', JSON.stringify(got));
  // 谁先认领谁得锁:锁在 cardEnvFingerprint 上,桌面那份(同一把锁键、另一个指纹、dual)作废
  const d = h.describe();
  for (const t of tasks.filter((x) => x.requires.envFingerprint === OWN)) {
    const s = d.tasks.find((x) => x.id === t.id);
    assert.deepEqual([s.state, s.lastError], ['failed', 'superseded'], `${t.id}:${JSON.stringify(s)}`);
  }
  const lock = d.locks.find((l) => l.lockKey === 'snapshot:ck-u');
  assert.equal(lock?.envFingerprint, CARDFP, '这一层只出自浏览器这一种环境');
  // 此后桌面节点对这张卡再发布桌面那份会被锁拒绝(不混环境)
  const again = h.publish('pc', tasks.filter((x) => x.requires.envFingerprint === OWN).map((t) => ({ ...t, id: t.id }))).one('pc', 'task.published').results;
  assert.ok(again.every((r) => r.error === 'card-locked' && r.lockedBy === CARDFP), JSON.stringify(again));

  // 内置卡的任务不受影响:浏览器照旧按 envFingerprint 认领(同一台机器的桌面也认得,两边键是同一个)
  const b = builtinTask();
  h.publish('page', [{ ...b, source: { projectId: 'p1', projectRev: 7 } }]);
  assert.equal(h.claim('br', b.id, 1).last('br', ['task.claimed', 'task.claim-rejected']).type, 'task.claimed');
});

/* ================================================================== OCN-07 */

test('OCN-07 清单计划的 input.browser:规整、同内容同签名、变了换计划、不带时与原来逐字相同;入站校验', () => {
  const clips = ['c2', 'c1'];
  const base = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips });
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: null }), base, '不带 browser:逐字相同');
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { cardEnvFingerprint: 'BAD', cardSources: {} } }), base, '指纹不合格:当没有');
  const page = { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { b: 'v-b', a: 'v-a' } };
  const t = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: page });
  assert.notEqual(t.id, base.id, '带了本页能运行的卡:另一个计划');
  assert.deepEqual(t.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { a: 'v-a', b: 'v-b' } });
  assert.deepEqual(Object.keys(t.input.browser.cardSources), ['a', 'b'], '卡片 id 升序');
  assert.equal(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, cardSources: { a: 'v-a', b: 'v-b' } } }).id, t.id, '同内容同签名(与键的写入顺序无关)');
  assert.notEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, cardSources: { a: 'v-a2', b: 'v-b' } } }).id, t.id, '某张卡换代:另一个计划');
  assert.notEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips, browser: { ...page, graphCards: true } }).id, t.id, '能力变了:另一个计划');
  assert.match(t.id, /^plan:p1@3#clips:[0-9a-z]{1,32}$/, '签名仍是小写字母与数字');
  assert.equal(browserCardsSig(browserCardsOf(page)), [CARDFP, 1, 0, 'a=v-a', 'b=v-b'].join('|'));

  // 入站校验:收它,并只留规整过的 input.browser
  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  const ok = parse(t);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body.tasks[0].input.browser, t.input.browser);
  const dirty = { ...t, input: { ...t.input, browser: { ...t.input.browser, extra: 1, cardSources: { ...t.input.browser.cardSources, '': 'x', bad: 5, long: 'x'.repeat(200) } } } };
  const cleaned = parse(dirty);
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.body.tasks[0].input.browser, t.input.browser, '多余字段、不合格的卡片项被去掉');
  const noFp = parse({ ...t, input: { ...t.input, browser: { userCards: true } } });
  assert.equal(noFp.ok, true);
  assert.equal('browser' in noFp.body.tasks[0].input, false, '不合格的整项去掉,任务照发');
  // 预渲染重试计划、桌面 plan 不受影响
  assert.equal(parse({ ...base, input: { clips: ['c1', 'c2'], browser: page } }).body.tasks[0].input.browser !== undefined, true, '清单计划才规整');
});
