/**
 * 卡片级指纹锁：节点这一侧（契约 `docs/plan/render-queue-contract.md` F.2 与 F.7 第 5 条，
 * 测试表 F.5 的 N1～N5、F.7 第 6 条的 N6）。
 * 跑：node --experimental-test-module-mocks --test server/test/card-lock-node.test.mjs
 *
 * 只照契约 F.2、F.7 以及它引用的 B.1、B.4、B.5、D、E.5 写，不看实现。
 *
 *   N1  `normalizeOs` 的前缀映射；用真实页面串算指纹
 *   N2  `splitPlan` 的 `cardLocks`
 *   N3  `splitPlan` 的 `takeover`（布尔 / Set / 函数）
 *   N4  节点会话收到 `card-locked` 丢候选、不重试
 *   N5  `createLocalNode` 把 `PlanContext.cardLocks` / `takeover` 原样交给切分（M3 的环回与假件，真队列）
 *   N6  `createLocalNode` 发布被拒建后照锁指纹重发、等回包才完成 plan、`takeoverLocked`、最多重来 2 轮
 *
 * 结果键、指纹按 B.1 的公式用 `node:crypto` 自己算，任务 id 按 A.4 自己算，不借实现。
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
/** M7 契约 D2（`docs/plan/m7-contract.md` 第 13 节）给 card-locked 的回包加了 lockIdleMs / lockedByProfile / lockUndone；这里只比 F.7 定的那几项 */
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

test('N1 normalizeOs：页面上报的 navigator.platform / userAgentData.platform 按前缀归类（小写后比）', () => {
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
  // 大小写
  assert.equal(normalizeOs('WIN32'), 'windows');
  assert.equal(normalizeOs('MACINTEL'), 'macos');
});

test('N1 normalizeOs：旧映射不变，其余输入照旧 other', () => {
  assert.equal(normalizeOs('win32'), 'windows');
  assert.equal(normalizeOs('windows'), 'windows');
  assert.equal(normalizeOs('darwin'), 'macos');
  assert.equal(normalizeOs('macos'), 'macos');
  assert.equal(normalizeOs('linux'), 'linux');
  for (const other of ['freebsd', 'aix', 'sunos', 'android', 'Android', 'iPhone', 'iPad', 'CrOS', 'OpenBSD', 'Chrome OS', 'x11', '', 'ewin', 'amac', 'unix']) {
    assert.equal(normalizeOs(other), 'other', JSON.stringify(other));
  }
});

test('N1 用真实页面串算指纹：navigator.platform + WebGL 串 + 完整 UA', () => {
  const win = describeEnvironment({ platform: 'Win32', ...GPU.nvidia, chromeVersion: UA.win });
  assert.deepEqual(win, { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138, fingerprint: fpOf('windows', 'nvidia', 138) });
  const mac = describeEnvironment({ platform: 'MacIntel', ...GPU.apple, chromeVersion: UA.mac });
  assert.deepEqual(mac, { os: 'macos', gpuClass: 'apple', chromeMajor: 139, fingerprint: fpOf('macos', 'apple', 139) },
    'Mac UA 里的「Mac OS X 10_15_7」不能被当成版本号');
  const linux = describeEnvironment({ platform: 'Linux x86_64', ...GPU.intel, chromeVersion: UA.linux });
  assert.deepEqual(linux, { os: 'linux', gpuClass: 'intel', chromeMajor: 140, fingerprint: fpOf('linux', 'intel', 140) });
  // userAgentData.platform 与 navigator.platform 得到同一个指纹
  assert.equal(describeEnvironment({ platform: 'Windows', ...GPU.nvidia, chromeVersion: UA.win }).fingerprint, win.fingerprint);
  assert.equal(describeEnvironment({ platform: 'macOS', ...GPU.apple, chromeVersion: UA.mac }).fingerprint, mac.fingerprint);
  // Edge 的 UA 里 Chrome 主版本同样是 138
  assert.equal(describeEnvironment({ platform: 'Win32', ...GPU.nvidia, chromeVersion: UA.edge }).fingerprint, win.fingerprint);
  // 页面与预渲染进程：同 OS、同 Chrome 主版本，但一个走 GPU、一个走 SwiftShader → 指纹不同
  const prerender = describeEnvironment({ platform: 'win32', ...GPU.swiftshader, chromeVersion: 'HeadlessChrome/138.0.7204.49' });
  assert.equal(prerender.gpuClass, 'software');
  assert.notEqual(prerender.fingerprint, win.fingerprint);
  // 同一种环境（页面 Win32 + SwiftShader + Chrome 138）与预渲染进程指纹相同：前缀映射让两边对得上
  assert.equal(describeEnvironment({ platform: 'Win32', ...GPU.swiftshader, chromeVersion: UA.win }).fingerprint, prerender.fingerprint);
});

/* ================================================================== N2 / N3 夹具（照 render-node-logic.test.mjs 的写法） */

const FP = fpOf('windows', 'software', 138);    // 本节点（切分节点）
const X = fpOf('macos', 'apple', 139);           // 锁定方
const Y = fpOf('linux', 'amd', 140);            // 另一个锁定方（诱饵键用它，写错锁键就会出别的键）
const CV = 'c0de5a';
const PROJECT = 'proj-7', REV = 3, ENTRY = 'entry-xyz';
const PLAN_ID = `plan:${PROJECT}@${REV}`;
const SHARED_CAPS = { frameMode: 'stateful', compositing: 'independent' };
const LOCAL_CAPS = { frameMode: 'stateful', compositing: 'belowDependent' };

/** 按 card-cache.mjs 的 plan() 输出（E.3，带 contentKey）造一个 control */
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
/** 没有 contentKey 字段的旧形状（M2 夹具）：snapshotKey 当内容键 */
const OLD = control({ clipId: 'old', contentKey: 'ck-old', tier: 'shared', capabilities: SHARED_CAPS, count: 10, withContentKey: false });
const STREAM = { streamKey: rkOf('sk-1', FP), contentKey: 'sk-1', topClipId: 'top', firstSegment: 0, lastSegment: 9 };
const STREAM_OLD = { streamKey: 'sk-old', topClipId: 'top2', firstSegment: 0, lastSegment: 3 };

const baseArgs = over => ({
  planTask: planTaskOf({ projectId: PROJECT, projectRev: REV }), entryKey: ENTRY,
  cardPlan: [A, B, C, D, OLD], prerenderSet: undefined, streams: [STREAM, STREAM_OLD],
  envFingerprint: FP, codeVersion: CV, cardSourceVersions: { particles: 'builtin:12' }, ...over,
});

/** 某个任务的 input.contentKey（E.5）与锁键（F.2） */
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

/** 把「按本节点指纹出的任务」换成「按指纹 fp 出的任务」：只动 resultKey、id、requires.envFingerprint */
function rekeyed(task, fp) {
  const resultKey = rkOf(task.input.contentKey, fp);
  return { ...task, resultKey, id: `${task.kind}:${resultKey}:${task.range.from}-${task.range.to}`, requires: { ...task.requires, envFingerprint: fp } };
}

test('N2 splitPlan 不给 cardLocks（缺省 {}）或给空表：与 E.5 完全相同；锁键就是 `${kind}:${input.contentKey}`', () => {
  const plain = splitPlan(baseArgs());
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: {} })), plain);
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: new Map() })), plain);
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: {}, takeover: false })), plain);
  const groups = byLock(plain);
  assert.deepEqual(sorted(groups.keys()), sorted(Object.values(LK)), '每张卡、每条流一个锁键；本地档带 entryKey/');
  for (const t of plain) {
    assert.equal(t.requires.envFingerprint, FP);
    assert.equal(t.resultKey, rkOf(t.input.contentKey, FP));
    assert.equal('takeover' in t, false, '不锁不接手时没有 takeover 字段');
  }
  assert.equal(groups.get(LK.a)[0].resultKey, A.snapshotKey, 'E.5：共享档 resultKey === control.snapshotKey');
  assert.equal(groups.get(LK.stream)[0].resultKey, STREAM.streamKey, 'E.5：流 resultKey === streamKey');
});

for (const [shape, wrap] of [['普通对象', o => o], ['Map', o => new Map(Object.entries(o))]]) {
  test(`N2 splitPlan 带 cardLocks（${shape}）：被别的指纹锁定的卡按锁指纹出键与 requires；同指纹、没锁的照旧；本地档的锁键带 entryKey/`, () => {
    const plain = splitPlan(baseArgs());
    const locks = {
      [LK.a]: X,                       // 被别的环境锁定
      [LK.b]: FP,                      // 锁在自己的指纹上
      [LK.d]: X,                       // 本地档，锁键带 entryKey/
      [LK.stream]: X,                  // 流
      [LK.old]: X,                     // 旧形状：snapshotKey 当内容键
      // 不该命中的：本地档不带 entryKey/ 的键、kind 不对的键、按结果键而不是内容键写的键
      [`snapshot:${D.contentKey}`]: Y,
      ['snapshot:sk-1']: Y,
      [`snapshot:${C.snapshotKey}`]: Y,
    };
    const out = splitPlan(baseArgs({ cardLocks: wrap(locks) }));
    assert.equal(out.length, plain.length, '任务个数不变');
    const lockedKeys = new Set([LK.a, LK.d, LK.stream, LK.old]);
    for (let i = 0; i < plain.length; i++) {
      const p = plain[i], t = out[i];
      const lk = `${p.kind}:${p.input.contentKey}`;
      if (lockedKeys.has(lk)) {
        assert.deepEqual(t, rekeyed(p, X), `${lk}：按锁指纹出键，requires.envFingerprint = X，其余字段不变`);
        assert.equal(t.resultKey, rkOf(p.input.contentKey, X));
        assert.equal(t.input.contentKey, p.input.contentKey, 'input.contentKey 不变');
        assert.equal('takeover' in t, false);
      } else {
        assert.deepEqual(t, p, `${lk}：没被别的指纹锁定，照 E.5`);
      }
    }
    // 输出顺序照 B.4：先快照（cardPlan 顺序、段升序）后流
    assert.deepEqual(out.map(t => t.input.clipId), plain.map(t => t.input.clipId));
  });
}

test('N2 补充：锁定方的剩余帧只给同指纹节点（requires.envFingerprint = X 让规则 1 生效），任务 id 与锁定方自己切出来的相同', () => {
  const lockedByX = splitPlan(baseArgs({ cardLocks: { [LK.a]: X } })).filter(t => t.input.clipId === 'a');
  // 锁定方（指纹 X）自己切同一张卡
  const byXItself = splitPlan(baseArgs({ envFingerprint: X, cardPlan: [A], streams: [] }));
  assert.deepEqual(lockedByX.map(t => t.id), byXItself.map(t => t.id), '两边切出的任务 id 相同，队列里合并成同一批任务');
  assert.deepEqual(lockedByX.map(t => t.requires.envFingerprint), byXItself.map(() => X));
});

/* ================================================================== N3 */

const TAKEOVER_FORMS = [
  ['布尔 true（全部接手）', () => true, [LK.a, LK.d, LK.stream]],
  ['Set（只接手 a 和流）', () => new Set([LK.a, LK.stream]), [LK.a, LK.stream]],
  ['函数（只接手本地档 d）', calls => lk => { calls.push(lk); return lk === LK.d; }, [LK.d]],
];

for (const [label, make, taken] of TAKEOVER_FORMS) {
  test(`N3 splitPlan 带 takeover（${label}）：命中的被锁卡按本节点指纹出键、每个任务带 takeover: true；没命中的照 N2`, () => {
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
        assert.deepEqual(t, { ...p, takeover: true }, `${lk}：接手，按本节点指纹出键、带 takeover: true`);
        assert.equal(t.takeover, true);
        assert.equal(t.requires.envFingerprint, FP);
      } else if (locks[lk] && locks[lk] !== FP) {
        assert.deepEqual(t, rekeyed(p, X), `${lk}：被锁但不接手，照 N2`);
      } else {
        assert.deepEqual(t, p, `${lk}：没锁或锁在自己指纹上，照 E.5、不带 takeover`);
        assert.equal('takeover' in t, false);
      }
    }
    if (calls.length) {
      for (const lk of calls) assert.equal(typeof lk, 'string', '函数收到的是锁键');
      assert.ok(calls.includes(LK.d), '函数对被锁的卡调用，参数是锁键');
    }
  });
}

test('N3 补充：takeover 只作用于被别的指纹锁定的卡；缺省 false 等于不接手', () => {
  const locks = { [LK.a]: X };
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: false })));
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: new Set() })));
  assert.deepEqual(splitPlan(baseArgs({ cardLocks: locks })), splitPlan(baseArgs({ cardLocks: locks, takeover: () => false })));
  // 没有锁时 takeover: true 不给任何任务加字段
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

test('N4 节点会话收到 claim-rejected card-locked：丢掉这个候选、清掉在飞的认领，之后不再重试它', () => {
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
  assert.deepEqual(claims1.map(m => m.id), [locked.id], '先认领优先级高的');
  sent.length = 0;

  session.receive({ type: 'task.claim-rejected', epoch: EPOCH, id: locked.id, reason: 'card-locked', state: 'open', version: 1, lockedBy: X });
  assert.ok(!session.known().some(k => k.id === locked.id), '被锁的候选从本地视图里去掉');
  assert.deepEqual(started, []);

  // 在飞的认领已清：下一次 tick 能认领别的；被锁的那个不再出现
  for (let i = 0; i < 5; i++) {
    t += 1000;
    session.tick();
  }
  const claims2 = sent.filter(m => m.type === 'task.claim');
  assert.deepEqual(claims2.map(m => m.id), [other.id], '只认领另一个，一次；不重试被锁的');
  assert.equal(sent.filter(m => m.type === 'task.claim' && m.id === locked.id).length, 0);
});

test('N4 补充：被锁的候选之后若又被 task.opened 推来（锁变了），照常可以再认领', () => {
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
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, '没有别的候选：不发认领');
  session.receive({ type: 'task.opened', epoch: EPOCH, task: locked });
  t += 1000;
  session.tick();
  assert.deepEqual(sent.filter(m => m.type === 'task.claim').map(m => m.id), [locked.id]);
});

/* ================================================================== N5 / N6：进程内（照 render-queue-inproc.test.mjs 的拓扑） */

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

/** 标题（共享档 130 帧 → 3 段）、下三分之一（共享档 70 帧 → 2 段）、毛玻璃（本地档 45 帧 → 1 段）、一条流（12 段 → 2 个任务） */
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
 * 按 B.4 / E.5 / F.2 自己算这份 PlanContext 切出的细任务：`fpFor(lockKey)` 给出每个锁键出键用的指纹，
 * `takeoverFor(lockKey)` 为真时任务带 `takeover: true`。
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
    // 稀疏流整条流一个任务(rr-motion-preempt 规则);满密度任务按 8 段切分
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

  /** `wrapSend(message, send)`：包一层端点的 send，测试可以在节点的消息进队列之前插一手 */
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
  throw new Error('消息往返不收敛');
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
  assert.fail(`超过 ${maxSteps} 步仍未满足条件；queue.describe()：\n${JSON.stringify(rig.queue.describe(), null, 1)}`);
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
  assert.deepEqual(rig.lb.errors().map(e => String(e?.stack ?? e)), [], '端点处理器抛出了异常');
  assert.deepEqual(rig.lb.nonJson(), [], '有消息不能 JSON 往返');
  assert.deepEqual(rig.out('error').map(e => [e.connId, e.message]), [], '队列回过 error');
  assert.deepEqual(rig.sink.misuse(), []);
  assert.deepEqual(unhandled.slice(unhandledBefore).map(e => String(e?.stack ?? e)), [], '有未处理的 Promise 拒绝');
}

const claimsOf = rig => rig.out('task.claimed').map(e => ({ connId: e.connId, id: e.message.id, task: e.message.task }));
const allDone = (rig, page, ids) => () => ids.every(id => page.doneCount(id) >= 1) && rig.nodes.every(n => n.local.running().length === 0);

/** 每个 id：页面恰好一条 task.done、队列恰好确认一次完成 */
function assertCompletedOnce(rig, page, ids) {
  const completed = new Map();
  for (const e of rig.out('task.completed')) completed.set(e.message.id, (completed.get(e.message.id) ?? 0) + 1);
  for (const id of ids) {
    assert.equal(page.doneCount(id), 1, `${id}：页面应恰好收到一条 task.done`);
    assert.equal(completed.get(id) ?? 0, 1, `${id}：应恰好完成一次`);
  }
}

/* ================================================================== N5 */

test('N5 createLocalNode 把 PlanContext.cardLocks 交给切分：被锁的卡照锁指纹出键，只被同指纹节点做完；其余照切分节点的指纹', async () => {
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
  assert.equal(exp.filter(t => t.lockKey === titleLockKey()).length, 3, '标题卡 3 段');
  const ids = [planId, ...exp.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  assert.deepEqual(sorted(page.done(planId).result.derived), sorted(exp.map(t => t.id)), 'plan 的 derived 是切出的全部 id');
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  const claims = claimsOf(rig);
  for (const t of exp) {
    const c = claims.filter(x => x.id === t.id);
    assert.equal(c.length, 1, `${t.id} 恰好认领一次`);
    assert.equal(fpOfConn.get(c[0].connId), t.fp, `${t.lockKey}：只被指纹 ${t.fp} 的节点认领`);
    assert.equal(c[0].task.requires.envFingerprint, t.fp);
    assert.ok(rig.sink.holds(c[0].task.resultKey, c[0].task.range), t.id);
  }
  for (const e of rig.inbound('task.claim')) {
    const t = exp.find(x => x.id === e.message.id);
    if (t) assert.equal(fpOfConn.get(e.connId), t.fp, `指纹不同的节点尝试认领 ${e.message.id}`);
  }
  // 发布的细任务里没有 takeover 字段
  for (const e of rig.inbound('task.publish').filter(e => e.connId === a1.connId)) {
    for (const t of e.message.tasks) assert.equal('takeover' in t, false, t.id);
  }
  hygiene(rig, before);
});

test('N5 createLocalNode 把 PlanContext.takeover 交给切分：被锁的卡按本节点指纹出键、带 takeover 发布，本节点指纹的节点做完', async () => {
  const before = unhandled.length;
  const locks = { [titleLockKey()]: FP_B };
  const rig = createRig({ planContext: task => planContextFor(task.source.projectId, { cardLocks: locks, takeover: new Set([titleLockKey()]) }) });
  const page = rig.addPage('page');
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 1 });
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 3 });
  b1.idle = false;                     // plan 由 a1 认领
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
    assert.ok(p, `${t.id} 发布过`);
    if (t.takeover) assert.equal(p.takeover, true, `${t.id}：接手的卡带 takeover: true`);
    else assert.equal('takeover' in p, false, `${t.id}：其余不带`);
  }
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  for (const c of claimsOf(rig)) {
    if (c.id === planId) continue;
    assert.equal(fpOfConn.get(c.connId), FP_A, `${c.id} 应由 FP_A 节点认领`);
  }
  hygiene(rig, before);
});

/* ================================================================== N6（F.7 第 5 条） */

/** 页面先用 card.lock 把标题卡锁给 FP_B（页面测量推过的帧入库的情形）；切分节点 FP_A 不知道这把锁 */
async function lockedTitleScene({ extra = {}, wrapSend } = {}) {
  const rig = createRig({ planContext: task => planContextFor(task.source.projectId) });
  const page = rig.addPage('page');
  page.ep.send({ type: 'card.lock', kind: 'snapshot', contentKey: titleLockKey().slice('snapshot:'.length), envFingerprint: FP_B });
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 1, extra, wrapSend });
  a1.local.start();
  await settle(rig);
  assert.ok(page.inbox.some(m => m.type === 'card.locked' && m.granted === true), '页面锁住了标题卡');
  page.publishPlan('p1', 1);
  return { rig, page, a1, planId: planIdOf('p1', 1) };
}

test('N6 拒建后照锁指纹重发：只重发被拒的那张卡；plan 等到回包才完成，derived 是最终发布成功的全部 id；细任务继承页面订阅，由锁定方指纹的节点做完', async () => {
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

  // 两次发布：第一次全部（标题卡按 FP_A、被拒建），第二次只有标题卡、按 FP_B
  const pubs = rig.inbound('task.publish').filter(e => e.connId === a1.connId);
  assert.equal(pubs.length, 2, '先发一次，被拒建后重发一次');
  const [first, second] = pubs;
  const titleA = expectedDerived(planContextFor('p1'), () => FP_A).filter(t => t.lockKey === titleLockKey());
  assert.deepEqual(sorted(first.message.tasks.map(t => t.id)), sorted([...exp.filter(t => t.lockKey !== titleLockKey()), ...titleA].map(t => t.id)));
  const titleB = exp.filter(t => t.lockKey === titleLockKey());
  assert.deepEqual(sorted(second.message.tasks.map(t => t.id)), sorted(titleB.map(t => t.id)), '只重发锁键在被拒结果里的任务');
  for (const t of second.message.tasks) {
    assert.equal(t.requires.envFingerprint, FP_B);
    assert.equal('takeover' in t, false, '缺省 takeoverLocked: false，照锁定方指纹重发，不带 takeover');
  }
  // 发布带 reqId；第一次的回包里标题卡是 card-locked
  for (const p of pubs) assert.ok(typeof p.message.reqId === 'string' || Number.isFinite(p.message.reqId), '派生任务的 task.publish 带 reqId');
  const reply = reqId => rig.out('task.published').find(e => e.connId === a1.connId && e.message.reqId === reqId);
  const r1 = reply(first.message.reqId), r2 = reply(second.message.reqId);
  assert.ok(r1 && r2, '两次发布都有回包');
  for (const t of titleA) {
    assert.deepEqual(f7(r1.message.results.find(r => r.id === t.id)), { id: t.id, error: 'card-locked', lockedBy: FP_B });
  }
  assert.ok(r2.message.results.every(r => r.created === true && !('error' in r)));

  // plan 在第二次回包之后才完成
  const planComplete = rig.inbound('task.complete').find(e => e.message.id === planId);
  assert.ok(planComplete.index > r2.index, 'plan 等最后一次发布的回包后才 complete');
  assert.deepEqual(sorted(planComplete.message.result.derived), sorted(exp.map(t => t.id)), 'derived 是最终发布成功的全部 id');

  // 继承页面订阅：重发的细任务订阅者里有页面，source.userId 是页面的
  const view = new Map(rig.queue.describe().tasks.map(t => [t.id, t]));
  for (const t of titleB) assert.ok(view.get(t.id).subscribers.includes(page.publisherId), `${t.id} 继承了页面订阅`);
  // 由锁定方指纹的节点做完
  const fpOfConn = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  for (const c of claimsOf(rig).filter(c => titleB.some(t => t.id === c.id))) {
    assert.equal(fpOfConn.get(c.connId), FP_B);
    assert.equal(c.task.source.userId, 'u1');
  }
  // 队列里没有留下 FP_A 的标题卡死任务
  for (const t of titleA) assert.equal(view.get(t.id), undefined, `${t.id} 被拒建，不在表里`);
  hygiene(rig, before);
});

for (const [label, takeoverLocked] of [['布尔 true', true], ['函数', (lockKey, lockedBy) => lockKey.startsWith('snapshot:') && lockedBy === FP_B]]) {
  test(`N6 takeoverLocked（${label}）：拒建后按本节点指纹带 takeover 重发，锁转给本节点指纹，本节点指纹的节点做完`, async () => {
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
    assert.deepEqual(sorted(pubs[1].message.tasks.map(t => t.id)), sorted(titleIds), '重发的是标题卡、按本节点指纹（与第一次同 id）');
    for (const t of pubs[1].message.tasks) assert.equal(t.takeover, true, '重发带 takeover: true');
    const lock = rig.queue.describe().locks?.find(l => l.lockKey === titleLockKey());
    assert.equal(lock?.envFingerprint, FP_A, '锁转给本节点指纹');
    assert.equal(lock?.source, 'takeover');
    if (typeof takeoverLocked === 'function') assert.deepEqual(seen, [[titleLockKey(), FP_B]], '函数收到 (lockKey, lockedBy)');
    const planDone = page.done(planId);
    assert.deepEqual(sorted(planDone.result.derived), sorted(exp.map(t => t.id)));
    hygiene(rig, before);
  });
}

test('N6 最多重来 2 轮：锁每轮都被别的环境抢走时，第 3 次被拒就放弃，发 plan-relocked 事件；plan 照样完成，derived 只含发布成功的', async () => {
  const before = unhandled.length;
  const ck = titleLockKey().slice('snapshot:'.length);
  let flips = 0;
  let page;
  // 切分节点每发一次 task.publish，页面抢先（同一条环回、先入队先处理）把标题卡的锁接手到一个新指纹
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
  assert.equal(pubs.length, 3, '首发 1 次 + 重来 2 轮');
  const ev = a1.eventsOf('plan-relocked');
  assert.equal(ev.length >= 1, true, '发 plan-relocked 事件');
  const last = ev.at(-1);
  assert.equal(last.id, planId);
  assert.ok(Array.isArray(last.gaveUp) && last.gaveUp.length > 0, 'gaveUp 列出放弃的项');
  assert.ok(Array.isArray(last.lockKeys) && last.lockKeys.includes(titleLockKey()), 'lockKeys 含标题卡的锁键');
  assert.deepEqual(sorted(page.done(planId).result.derived), sorted(exp.map(t => t.id)), 'derived 只含最终发布成功的');
  // 剩下的细任务照常完成
  const ids = exp.map(t => t.id);
  rig.addNode('node-a2', { fp: FP_A, seed: 2 }).local.start();
  await drive(rig, allDone(rig, page, ids));
  hygiene(rig, before);
});
