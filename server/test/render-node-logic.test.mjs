/**
 * M2 渲染节点纯逻辑：指纹、能力过滤、候选挑选、plan 任务切分。
 * 跑：node --test server/test/render-node-logic.test.mjs
 *
 * 只照 `docs/plan/render-queue-contract.md` B.1～B.4（下称「契约」）和
 * `docs/plan/distributed-prerender-queue.md` 第 2、2.1、4.3 节写，不看实现。
 * 期望值里的哈希按契约写明的公式用 `node:crypto` 独立算，不借被测函数算期望。
 * 任务 id 同样按契约 A.4 的公式手写，不从 `render-queue` 引 `taskIdOf`，
 * 这样本文件只依赖 `server/render-node/` 的四个模块。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeOs, gpuClassOf, chromeMajorOf, envFingerprintOf, describeEnvironment, resultKeyOf } from '../render-node/fingerprint.mjs';
import { DEFAULT_WEIGHT_POLICY, checkClaimable, filterClaimable } from '../render-node/filter.mjs';
import { rankCandidates, pickCandidate } from '../render-node/pick.mjs';
import { planTaskOf, splitPlan } from '../render-node/split.mjs';
import { cardSampling } from '../card-identity.mjs';

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
// 契约 B.1 的两条公式，独立实现，用来算期望值
const fpOf = (os, gpuClass, chromeMajor) => sha256(`${os}\n${gpuClass}\n${chromeMajor}`).slice(0, 16);
const rkOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- B.1 指纹

test('B.1 normalizeOs: win32/windows → windows, darwin/macos → macos, linux → linux, anything else → other', () => {
  assert.equal(normalizeOs('win32'), 'windows');
  assert.equal(normalizeOs('windows'), 'windows');
  assert.equal(normalizeOs('darwin'), 'macos');
  assert.equal(normalizeOs('macos'), 'macos');
  assert.equal(normalizeOs('linux'), 'linux');
  for (const other of ['freebsd', 'aix', 'sunos', 'android', '']) assert.equal(normalizeOs(other), 'other', other);
});

test('B.1 gpuClassOf: common WebGL strings of each vendor map to five classes', () => {
  const cases = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (NVIDIA)', 'nvidia'],
    ['Quadro P2000/PCIe/SSE2', '', 'nvidia'],
    ['ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (AMD)', 'amd'],
    ['ANGLE (ATI Technologies Inc., Radeon Pro, OpenGL 4.1)', '', 'amd'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'intel'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'Google Inc. (Apple)', 'apple'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google Inc. (Google)', 'software'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa', 'software'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Microsoft)', 'software'],
    ['Generic Software Adapter', '', 'software'],
  ];
  for (const [renderer, vendor, expected] of cases) assert.equal(gpuClassOf(renderer, vendor), expected, `${renderer} | ${vendor}`);
});

test('B.1 gpuClassOf: case-insensitive', () => {
  assert.equal(gpuClassOf('GEFORCE GTX 1080', ''), 'nvidia');
  assert.equal(gpuClassOf('rtx a4000', ''), 'nvidia');
  assert.equal(gpuClassOf('RADEON', ''), 'amd');
  assert.equal(gpuClassOf('INTEL IRIS XE', ''), 'intel');
  assert.equal(gpuClassOf('APPLE M1', ''), 'apple');
  assert.equal(gpuClassOf('SWIFTSHADER', ''), 'software');
  assert.equal(gpuClassOf('LLVMPIPE', ''), 'software');
});

test('B.1 gpuClassOf: renderer and vendor are concatenated and matched together (also recognized when only one side carries a vendor name)', () => {
  assert.equal(gpuClassOf('', 'NVIDIA Corporation'), 'nvidia');
  assert.equal(gpuClassOf('Generic Renderer', 'Intel Inc.'), 'intel');
  assert.equal(gpuClassOf('Generic Renderer', 'Apple Inc.'), 'apple');
  assert.equal(gpuClassOf('Generic Renderer', 'Google SwiftShader'), 'software');
});

test('B.1 gpuClassOf: match order software > nvidia > amd > intel > apple', () => {
  // 1 先于 2：软件渲染字样压过厂商字样
  assert.equal(gpuClassOf('SwiftShader', 'NVIDIA Corporation'), 'software');
  assert.equal(gpuClassOf('llvmpipe', 'AMD'), 'software');
  assert.equal(gpuClassOf('Microsoft Basic Render Driver', 'Intel'), 'software');
  // 2 先于 4、5
  assert.equal(gpuClassOf('NVIDIA GeForce GT 750M', 'Intel Inc.'), 'nvidia');
  assert.equal(gpuClassOf('NVIDIA GeForce GT 750M', 'Apple Inc.'), 'nvidia');
  // 3 先于 4、5（旧款 Mac 上 vendor 是 Apple、renderer 是 AMD）
  assert.equal(gpuClassOf('AMD Radeon Pro 5500M', 'Apple Inc.'), 'amd');
  assert.equal(gpuClassOf('Radeon', 'Intel'), 'amd');
  // 4 先于 5
  assert.equal(gpuClassOf('Intel Iris Plus Graphics', 'Apple Inc.'), 'intel');
});

test('B.1 gpuClassOf: falls back to software when none match', () => {
  assert.equal(gpuClassOf('Mali-G78 MC24', 'ARM'), 'software');
  assert.equal(gpuClassOf('Adreno (TM) 740', 'Qualcomm'), 'software');
  assert.equal(gpuClassOf('', ''), 'software');
});

test('B.1 chromeMajorOf: a version string, a HeadlessChrome/ prefix, or a number all yield the major version; returns 0 when parsing fails', () => {
  assert.equal(chromeMajorOf('138.0.7204.49'), 138);
  assert.equal(chromeMajorOf('HeadlessChrome/138.0.7204.49'), 138);
  assert.equal(chromeMajorOf(138), 138);
  assert.equal(chromeMajorOf('141.0.1.2'), 141);
  for (const bad of ['', 'not a version', undefined, null]) assert.equal(chromeMajorOf(bad), 0, String(bad));
});

test('B.1 envFingerprintOf: 16 lowercase hex digits, equal to the first 16 digits of sha256(os\\ngpuClass\\nchromeMajor)', () => {
  const fp = envFingerprintOf({ os: 'windows', gpuClass: 'nvidia', chromeMajor: 138 });
  assert.match(fp, HEX16);
  assert.equal(fp, fpOf('windows', 'nvidia', 138));
});

test('B.1 envFingerprintOf: deterministic (same input, same output); the result changes when any of the three items changes', () => {
  const base = { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138 };
  const fp = envFingerprintOf(base);
  assert.equal(envFingerprintOf({ ...base }), fp);
  const variants = [
    { ...base, os: 'linux' }, { ...base, gpuClass: 'intel' }, { ...base, chromeMajor: 139 },
  ].map(envFingerprintOf);
  for (const other of variants) { assert.match(other, HEX16); assert.notEqual(other, fp); }
  assert.equal(new Set(variants).size, variants.length);
});

test('B.1 envFingerprintOf: missing items count as \'\' / 0, no throw', () => {
  assert.equal(envFingerprintOf({}), fpOf('', '', 0));
  assert.equal(envFingerprintOf({ os: 'windows', gpuClass: 'nvidia' }), fpOf('windows', 'nvidia', 0));
  assert.equal(envFingerprintOf({ os: 'windows', gpuClass: 'nvidia' }), envFingerprintOf({ os: 'windows', gpuClass: 'nvidia', chromeMajor: 0 }));
  assert.equal(envFingerprintOf({ gpuClass: 'amd', chromeMajor: 138 }), fpOf('', 'amd', 138));
  assert.equal(envFingerprintOf({ os: 'macos', chromeMajor: 138 }), fpOf('macos', '', 138));
});

test('B.1 describeEnvironment: derives { os, gpuClass, chromeMajor, fingerprint } from the platform, the WebGL string and the Chrome version', () => {
  const env = describeEnvironment({
    platform: 'win32',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    vendor: 'Google Inc. (NVIDIA)',
    chromeVersion: 'HeadlessChrome/138.0.7204.49',
  });
  assert.deepEqual(env, { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138, fingerprint: fpOf('windows', 'nvidia', 138) });
  const soft = describeEnvironment({ platform: 'linux', renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', vendor: 'Mesa', chromeVersion: '140.0.1.2' });
  assert.deepEqual(soft, { os: 'linux', gpuClass: 'software', chromeMajor: 140, fingerprint: fpOf('linux', 'software', 140) });
  assert.equal(soft.fingerprint, envFingerprintOf({ os: 'linux', gpuClass: 'software', chromeMajor: 140 }));
});

test('B.1 resultKeyOf: 64 lowercase hex digits, equal to sha256(contentKey\\nenvFingerprint)', () => {
  const fp = fpOf('windows', 'nvidia', 138);
  const key = resultKeyOf('9f3a0000e1', fp);
  assert.match(key, HEX64);
  assert.equal(key, rkOf('9f3a0000e1', fp));
  assert.equal(resultKeyOf('9f3a0000e1', fp), key, 'OK');
});

test('B.1 resultKeyOf: changes with the fingerprint and also with the content key', () => {
  const a = fpOf('windows', 'nvidia', 138), b = fpOf('windows', 'intel', 138);
  const k1 = resultKeyOf('content', a), k2 = resultKeyOf('content', b), k3 = resultKeyOf('content-2', a);
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  for (const k of [k1, k2, k3]) assert.match(k, HEX64);
});

// ---------------------------------------------------------------- B.2 过滤

const FP = fpOf('windows', 'nvidia', 138);
const CV = 'c0de5a';

/** 去掉值为 undefined 的键：夹具里写 `x: undefined` 表示「没有这一项」，不让实现去分辨 in 与 undefined。 */
const clean = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** 造一个 TaskView（契约 A.4）；over 里的 source / requires / weight 浅合并进缺省值。 */
function taskView(over = {}) {
  const { source, requires, weight, ...rest } = over;
  return clean({
    id: 'snapshot:rk:0-59', kind: 'snapshot', tier: 'shared', resultKey: 'rk',
    range: { unit: 'localFrame', from: 0, to: 59 },
    source: clean({ userId: 'u1', tenantId: 't1', projectId: 'p1', projectRev: 1, publisher: { id: 'P' }, publishedAt: 1000, derivedFrom: null, ...source }),
    // M7 D4（filter.mjs 规则 7）：纯浏览器只收共享档的独立卡，切分方在浏览器那一份里写 input.compositing
    input: { compositing: 'independent' },
    weight: clean({ class: 'medium', estMs: null, frames: 60, ...weight }),
    requires: clean({ envFingerprint: FP, codeVersion: CV, ...requires }),
    priority: 10, state: 'open', version: 1, attempts: 0,
    ...rest,
  });
}
function planView(over = {}) {
  const { source, requires, ...rest } = over;
  return taskView({
    id: 'plan:p1@1', kind: 'plan', tier: undefined, resultKey: 'p1@1', range: null,
    weight: { class: 'medium' },
    source, requires: { envFingerprint: undefined, codeVersion: undefined, ...requires }, ...rest,
  });
}
/** 能力全开、与缺省任务完全匹配的节点。 */
function nodeOf(over = {}) {
  const { capabilities, ...rest } = over;
  return clean({
    profile: 'host', userId: 'u1', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {},
    capabilities: clean({ transcode: true, userCards: true, graphCards: true, memoryMB: 4000, ...capabilities }),
    ...rest,
  });
}
function rejected(result, rule, label) {
  assert.equal(result.ok, false, `${label}: should fail`);
  assert.equal(result.rule, rule, `${label}: should be rule ${rule}, got ${result.rule} (${result.reason})`);
  assert.equal(typeof result.reason, 'string', `${label}: reason is a string`);
}
function accepted(result, label) {
  assert.deepEqual(result, { ok: true }, label);
}

test('B.2 shape of DEFAULT_WEIGHT_POLICY', () => {
  assert.deepEqual(DEFAULT_WEIGHT_POLICY, { browser: ['light', 'medium'], pc: { editing: 'own-or-light', idle: 'all' }, host: 'all' });
});

test('B.2 baseline: a node with all capabilities on and all requirements met passes and returns { ok: true }', () => {
  for (const profile of ['host', 'pc', 'browser']) accepted(checkClaimable(taskView(), nodeOf({ profile })), profile);
});

test('B.2 rule 0: browser accepts only tasks of its own user', () => {
  rejected(checkClaimable(taskView({ source: { userId: 'u2' } }), nodeOf({ profile: 'browser', userId: 'u1' })), 0, 'browser, task from another user');
  accepted(checkClaimable(taskView({ source: { userId: 'u1' } }), nodeOf({ profile: 'browser', userId: 'u1' })), 'browser, own task');
});

test('B.2 rule 0: pc / host do not filter by user', () => {
  accepted(checkClaimable(taskView({ source: { userId: 'u2' } }), nodeOf({ profile: 'pc', userId: 'u1' })), 'pc, task from another user');
  accepted(checkClaimable(taskView({ source: { userId: 'u2' } }), nodeOf({ profile: 'host', userId: 'u1' })), 'host, task from another user');
});

test('B.2 rule 0 is checked first: when browser gets a plan task from another user it returns rule 0, not rule 6', () => {
  rejected(checkClaimable(planView({ source: { userId: 'u2' } }), nodeOf({ profile: 'browser', userId: 'u1' })), 0, 'plan from another user');
});

test('B.2 rule 1: an environment fingerprint mismatch fails; passes when the task requires no fingerprint', () => {
  rejected(checkClaimable(taskView({ requires: { envFingerprint: fpOf('linux', 'intel', 138) } }), nodeOf()), 1, 'Fingerprint mismatch');
  accepted(checkClaimable(taskView({ requires: { envFingerprint: undefined } }), nodeOf()), 'No fingerprint required');
});

test('B.2 rule 1: codeVersion not in codeVersions fails; present in it (one of several versions) passes', () => {
  rejected(checkClaimable(taskView({ requires: { codeVersion: 'other' } }), nodeOf()), 1, 'Code version mismatch');
  accepted(checkClaimable(taskView({ requires: { codeVersion: 'v2' } }), nodeOf({ codeVersions: ['v1', 'v2'] })), 'One of several versions');
  accepted(checkClaimable(taskView({ requires: { codeVersion: undefined } }), nodeOf()), 'No code version required');
});

test('B.2 rule 1: fails if any [cardId, version] in cardSources is not available on this machine', () => {
  const requires = { cardSources: { particles: 'builtin:12', text: 'builtin:3' } };
  accepted(checkClaimable(taskView({ requires }), nodeOf({ cardSourceVersions: { particles: ['builtin:11', 'builtin:12'], text: ['builtin:3'] } })), 'All present');
  rejected(checkClaimable(taskView({ requires }), nodeOf({ cardSourceVersions: { particles: ['builtin:11'], text: ['builtin:3'] } })), 1, 'Wrong version');
  rejected(checkClaimable(taskView({ requires }), nodeOf({ cardSourceVersions: { particles: ['builtin:12'] } })), 1, 'A card is missing');
  rejected(checkClaimable(taskView({ requires }), nodeOf({ cardSourceVersions: undefined })), 1, 'The node did not report card source versions');
  accepted(checkClaimable(taskView({ requires: { cardSources: {} } }), nodeOf({ cardSourceVersions: undefined })), 'Empty cardSources');
});

test('B.2 rule 1: a plan task checks only codeVersion (the fingerprint and card source are not checked)', () => {
  // M6b 起 host 不认 plan（规则 6，render-host-contract 第 3、4 节），规则 1 对 plan 的判定改在 pc 节点上测
  const pc = nodeOf({ profile: 'pc' });
  accepted(checkClaimable(planView({ requires: { envFingerprint: fpOf('linux', 'intel', 1) } }), pc), 'plan carries a different fingerprint');
  accepted(checkClaimable(planView({ requires: { cardSources: { particles: 'builtin:99' } } }), pc), 'plan carries card sources that this machine does not have');
  accepted(checkClaimable(planView({ requires: { codeVersion: CV } }), pc), 'plan code version matches');
  rejected(checkClaimable(planView({ requires: { codeVersion: 'other' } }), pc), 1, 'plan code version mismatch');
});

// browser-stream-task.md 第二处：规则 2 改成只看任务自己写的 requires.transcode。切分方的流任务本来就写 transcode: true（split.mjs），
// 所以这里的流任务夹具照它的真实形状带上这一项；没写这一项的流任务不再一律要求转码（给浏览器的单卡流那一份写的是 false）
test('B.2 rule 2: requires.transcode needs transcoding capability (stream tasks from the splitter set it)', () => {
  const noTranscode = nodeOf({ capabilities: { transcode: false } });
  const stream = taskView({ id: 'stream:rk:0-7', kind: 'stream', tier: undefined, range: { unit: 'segment', from: 0, to: 7 }, requires: { transcode: true } });
  rejected(checkClaimable(stream, noTranscode), 2, 'stream without transcoding');
  accepted(checkClaimable(taskView({ id: 'stream:rk:0-7', kind: 'stream', tier: undefined, range: { unit: 'segment', from: 0, to: 7 }, requires: { transcode: false } }), noTranscode), 'stream itself says no transcoding is needed');
  rejected(checkClaimable(taskView({ requires: { transcode: true } }), noTranscode), 2, 'snapshot needs transcoding');
  accepted(checkClaimable(stream, nodeOf({ capabilities: { transcode: true } })), 'stream with transcoding');
  accepted(checkClaimable(taskView({ requires: { transcode: false } }), noTranscode), 'snapshot needs no transcoding');
});

test('B.2 rule 3: userCards / graphCards need the matching capability', () => {
  rejected(checkClaimable(taskView({ requires: { userCards: true } }), nodeOf({ capabilities: { userCards: false } })), 3, 'userCards');
  rejected(checkClaimable(taskView({ requires: { graphCards: true } }), nodeOf({ capabilities: { graphCards: false } })), 3, 'graphCards');
  accepted(checkClaimable(taskView({ requires: { userCards: true, graphCards: true } }), nodeOf()), 'All capabilities present');
  accepted(checkClaimable(taskView({ requires: { userCards: false, graphCards: false } }), nodeOf({ capabilities: { userCards: false, graphCards: false } })), 'Neither is required');
});

test('B.2 rule 4: browser accepts only light / medium', () => {
  const browser = nodeOf({ profile: 'browser' });
  accepted(checkClaimable(taskView({ weight: { class: 'light' } }), browser), 'light');
  accepted(checkClaimable(taskView({ weight: { class: 'medium' } }), browser), 'medium');
  rejected(checkClaimable(taskView({ weight: { class: 'heavy' } }), browser), 4, 'heavy');
});

test('B.2 rule 4: host accepts all', () => {
  for (const cls of ['light', 'medium', 'heavy']) accepted(checkClaimable(taskView({ weight: { class: cls } }), nodeOf({ profile: 'host' })), cls);
});

test('B.2 rule 4: pc accepts all when idle (editing is not true)', () => {
  for (const editing of [false, undefined]) for (const cls of ['light', 'medium', 'heavy'])
    accepted(checkClaimable(taskView({ weight: { class: cls }, source: { projectId: 'other' } }), nodeOf({ profile: 'pc', editing, ownProjectIds: ['p1'] })), `${editing} ${cls}`);
});

test('B.2 rule 4: pc while editing accepts only tasks of its own project or light tasks', () => {
  const pc = nodeOf({ profile: 'pc', editing: true, ownProjectIds: ['p1'] });
  for (const cls of ['light', 'medium', 'heavy']) accepted(checkClaimable(taskView({ weight: { class: cls }, source: { projectId: 'p1' } }), pc), `Own project ${cls}`);
  accepted(checkClaimable(taskView({ weight: { class: 'light' }, source: { projectId: 'p9' } }), pc), 'Other project light');
  rejected(checkClaimable(taskView({ weight: { class: 'medium' }, source: { projectId: 'p9' } }), pc), 4, 'Other project medium');
  rejected(checkClaimable(taskView({ weight: { class: 'heavy' }, source: { projectId: 'p9' } }), pc), 4, 'Other project heavy');
  // 没报 ownProjectIds：没有「自己项目」，只剩 light
  const pcNoOwn = nodeOf({ profile: 'pc', editing: true });
  accepted(checkClaimable(taskView({ weight: { class: 'light' } }), pcNoOwn), 'No ownProjectIds light');
  rejected(checkClaimable(taskView({ weight: { class: 'heavy' } }), pcNoOwn), 4, 'No ownProjectIds heavy');
});

test('B.2 rule 4: missing weight counts as medium', () => {
  const bare = taskView(); delete bare.weight;
  accepted(checkClaimable(bare, nodeOf({ profile: 'browser' })), 'browser accepts medium');
  accepted(checkClaimable(bare, nodeOf({ profile: 'host' })), 'host accepts');
  // 区分 medium 与 light：pc 编辑中、别人的项目，medium 不收
  const other = taskView({ source: { projectId: 'p9' } }); delete other.weight;
  rejected(checkClaimable(other, nodeOf({ profile: 'pc', editing: true, ownProjectIds: ['p1'] })), 4, 'pc while editing: counted as medium, not accepted');
});

test('B.2 rule 4: a null weight counts as medium (A.10a: the queue stores null when weight is omitted)', () => {
  const nul = { ...taskView(), weight: null };
  accepted(checkClaimable(nul, nodeOf({ profile: 'browser' })), 'browser accepts medium');
  accepted(checkClaimable(nul, nodeOf({ profile: 'pc', editing: true, ownProjectIds: ['p1'] })), 'pc while editing, own project');
  const other = { ...taskView({ source: { projectId: 'p9' } }), weight: null };
  rejected(checkClaimable(other, nodeOf({ profile: 'pc', editing: true, ownProjectIds: ['p1'] })), 4, 'pc while editing: other project, counted as medium, not accepted');
  assert.deepEqual(filterClaimable([nul], nodeOf({ profile: 'browser' })).length, 1);
});

test('B.2 rule 4: weightPolicy can be overridden by the node (browser accepts only light)', () => {
  const policy = { ...DEFAULT_WEIGHT_POLICY, browser: ['light'] };
  const browser = nodeOf({ profile: 'browser', weightPolicy: policy });
  accepted(checkClaimable(taskView({ weight: { class: 'light' } }), browser), 'light');
  rejected(checkClaimable(taskView({ weight: { class: 'medium' } }), browser), 4, 'medium');
});

test('B.2 rule 5: requires.memoryMB exceeding capabilities.memoryMB fails; passes when equal or when either side is not a number', () => {
  rejected(checkClaimable(taskView({ requires: { memoryMB: 4001 } }), nodeOf({ capabilities: { memoryMB: 4000 } })), 5, 'Exceeds');
  accepted(checkClaimable(taskView({ requires: { memoryMB: 4000 } }), nodeOf({ capabilities: { memoryMB: 4000 } })), 'Equal');
  accepted(checkClaimable(taskView({ requires: { memoryMB: 900 } }), nodeOf({ capabilities: { memoryMB: undefined } })), 'The node did not report memory');
  accepted(checkClaimable(taskView({ requires: { memoryMB: undefined } }), nodeOf({ capabilities: { memoryMB: 100 } })), 'The task requires no memory');
});

test('B.2 rule 6: for plan tasks, browser does not claim, host does not claim (M6b render-host-contract sections 3 and 4), pc claims', () => {
  rejected(checkClaimable(planView(), nodeOf({ profile: 'browser' })), 6, 'browser');
  accepted(checkClaimable(planView(), nodeOf({ profile: 'pc' })), 'pc');
  rejected(checkClaimable(planView(), nodeOf({ profile: 'host' })), 6, 'host');
});

test('B.2 checks in rule number order and returns the first one that fails', () => {
  // 1 与 5 同时不过 → 1
  rejected(checkClaimable(taskView({ requires: { codeVersion: 'x', memoryMB: 99999 } }), nodeOf()), 1, '1 and 5');
  // 2 与 4 同时不过（browser、stream、heavy）→ 2
  const stream = taskView({ id: 'stream:rk:0-7', kind: 'stream', tier: undefined, range: { unit: 'segment', from: 0, to: 7 }, weight: { class: 'heavy' }, requires: { transcode: true } });
  rejected(checkClaimable(stream, nodeOf({ profile: 'browser', capabilities: { transcode: false } })), 2, '2 and 4');
  // 3 与 5 同时不过 → 3
  rejected(checkClaimable(taskView({ requires: { userCards: true, memoryMB: 99999 } }), nodeOf({ capabilities: { userCards: false } })), 3, '3 and 5');
  // 4 与 5 同时不过 → 4
  rejected(checkClaimable(taskView({ weight: { class: 'heavy' }, requires: { memoryMB: 99999 } }), nodeOf({ profile: 'browser' })), 4, '4 and 5');
  // 1 与 6 同时不过（browser 的 plan、代码版本不符）→ 1
  rejected(checkClaimable(planView({ requires: { codeVersion: 'x' } }), nodeOf({ profile: 'browser' })), 1, '1 and 6');
});

test('B.2 filterClaimable: keeps only those that pass, preserving the original order', () => {
  const node = nodeOf({ profile: 'browser' });
  const tasks = [
    taskView({ id: 'a' }),
    taskView({ id: 'b', weight: { class: 'heavy' } }),
    taskView({ id: 'c', source: { userId: 'u2' } }),
    taskView({ id: 'd', weight: { class: 'light' } }),
    planView({ id: 'e' }),
    taskView({ id: 'f' }),
  ];
  const kept = filterClaimable(tasks, node);
  assert.deepEqual(kept.map(t => t.id), ['a', 'd', 'f']);
  assert.equal(tasks.length, 6, 'The input argument is not modified');
  assert.deepEqual(filterClaimable([], node), []);
});

// ---------------------------------------------------------------- B.3 挑选

/** 挑选只看 id、priority、source.publishedAt、source.projectId。 */
const cand = (id, priority, publishedAt, projectId = 'p1') => taskView({ id, priority, source: { publishedAt, projectId } });
const ids = tasks => tasks.map(t => t.id);

test('B.3 rankCandidates: priority descending → publishedAt ascending → id ascending, returns a new array and does not modify its input', () => {
  const input = [
    cand('z', 10, 5), cand('b', 10, 3), cand('a', 10, 3), cand('x', 50, 9), cand('m', 0, 1), cand('c', 50, 2),
  ];
  const before = ids(input);
  const ranked = rankCandidates(input);
  assert.deepEqual(ids(ranked), ['c', 'x', 'a', 'b', 'z', 'm']);
  assert.notEqual(ranked, input);
  assert.deepEqual(ids(input), before);
});

test('B.3 pickCandidate: an empty array returns null', () => {
  assert.equal(pickCandidate([]), null);
  assert.equal(pickCandidate([], { random: () => 0.5, lastProjectId: 'p1' }), null);
});

test('B.3 pickCandidate: among the top K ranked (default 4), picks floor(random × length) using random', () => {
  // 排名：t1 t2 t3 t4 t5 t6（同优先级，按 publishedAt）
  const tasks = [6, 3, 1, 5, 2, 4].map(n => cand(`t${n}`, 10, n));
  assert.equal(pickCandidate(tasks, { random: () => 0 }).id, 't1');
  assert.equal(pickCandidate(tasks, { random: () => 0.25 }).id, 't2');
  assert.equal(pickCandidate(tasks, { random: () => 0.5 }).id, 't3');
  assert.equal(pickCandidate(tasks, { random: () => 0.999999 }).id, 't4', 'Default K = 4, ranks 5 and 6 are never picked');
  assert.equal(pickCandidate(tasks, { k: 6, random: () => 0.999999 }).id, 't6');
  assert.equal(pickCandidate(tasks, { k: 2, random: () => 0.6 }).id, 't2');
  assert.equal(pickCandidate(tasks, { k: 1, random: () => 0.999999 }).id, 't1');
});

test('B.3 pickCandidate: with fewer than K candidates, picks among all of them', () => {
  const tasks = [cand('b', 10, 2), cand('a', 10, 1)];
  assert.equal(pickCandidate(tasks, { random: () => 0 }).id, 'a');
  assert.equal(pickCandidate(tasks, { random: () => 0.999999 }).id, 'b');
  assert.equal(pickCandidate([cand('only', 0, 0)], { random: () => 0.7 }).id, 'only');
});

test('B.3 pickCandidate: the result is deterministic once random is injected', () => {
  const tasks = [1, 2, 3, 4, 5].map(n => cand(`t${n}`, n % 2 ? 10 : 20, n, `p${n}`));
  const seq = [0.1, 0.9, 0.4, 0.4, 0.75];
  const run = () => seq.map(r => pickCandidate(tasks, { random: () => r, lastProjectId: 'p2' })?.id);
  assert.deepEqual(run(), run());
});

test('B.3 pickCandidate: when lastProjectId is given, only other projects are kept within the same priority (rotation by project)', () => {
  // 排名：A(p1,10) B(p1,10) C(p2,10) D(p1,5)
  const tasks = [cand('D', 5, 0, 'p1'), cand('C', 10, 3, 'p2'), cand('B', 10, 2, 'p1'), cand('A', 10, 1, 'p1')];
  for (const r of [0, 0.3, 0.6, 0.999999]) assert.equal(pickCandidate(tasks, { random: () => r, lastProjectId: 'p1' }).id, 'C', `random=${r}`);
  // 第一名本身不是上次的项目时，它也留在候选里
  const tasks2 = [cand('A', 10, 1, 'p2'), cand('B', 10, 2, 'p1'), cand('C', 10, 3, 'p3')];
  assert.equal(pickCandidate(tasks2, { random: () => 0, lastProjectId: 'p1' }).id, 'A');
  assert.equal(pickCandidate(tasks2, { random: () => 0.5, lastProjectId: 'p1' }).id, 'C');
});

test('B.3 pickCandidate: when other projects exist only at lower priority, no filtering by project', () => {
  // 排名：A(p1,10) B(p2,5)；B 和第一名不同优先级，不算
  const tasks = [cand('A', 10, 1, 'p1'), cand('B', 5, 2, 'p2')];
  assert.equal(pickCandidate(tasks, { random: () => 0, lastProjectId: 'p1' }).id, 'A');
  // 〔裁〕2026-09-28（契约 B.3 第 2 步改写）：只在排头那一个整数名次里挑，更低优先级的 B 不再进候选
  assert.equal(pickCandidate(tasks, { random: () => 0.999999, lastProjectId: 'p1' }).id, 'A');
});

test('B.3 pickCandidate: rotation looks only within the top K; another project at rank K+1 does not count', () => {
  // 前 4 名都是 p1，第 5 名是 p2
  const tasks = [1, 2, 3, 4].map(n => cand(`a${n}`, 10, n, 'p1')).concat(cand('b5', 10, 5, 'p2'));
  assert.equal(pickCandidate(tasks, { random: () => 0, lastProjectId: 'p1' }).id, 'a1');
  assert.equal(pickCandidate(tasks, { random: () => 0.999999, lastProjectId: 'p1' }).id, 'a4');
});

test('B.3 pickCandidate: no filtering when lastProjectId is null', () => {
  const tasks = [cand('A', 10, 1, 'p1'), cand('B', 10, 2, 'p2')];
  assert.equal(pickCandidate(tasks, { random: () => 0, lastProjectId: null }).id, 'A');
  assert.equal(pickCandidate(tasks, { random: () => 0 }).id, 'A');
});

// ---------------------------------------------------------------- B.4 切分

const PROJECT = 'proj-42', REV = 118, ENTRY = 'entry-abc';
const PLAN_ID = `plan:${PROJECT}@${REV}`;

test('B.4 planTaskOf: shape, id and resultKey', () => {
  assert.deepEqual(planTaskOf({ projectId: PROJECT, projectRev: REV }), {
    id: PLAN_ID, kind: 'plan', resultKey: `${PROJECT}@${REV}`, range: null,
    source: { projectId: PROJECT, projectRev: REV }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires: {}, priority: 0,
  });
  const urgent = planTaskOf({ projectId: 'p', projectRev: 3, priority: 100 });
  assert.equal(urgent.priority, 100);
  assert.equal(urgent.id, 'plan:p@3');
  assert.equal(urgent.id, `plan:${urgent.resultKey}`, 'Matches the plan formula of taskIdOf');
});

/** 按 card-cache.mjs 的 plan() 输出造一个 control（只放切分会读到的字段和几个常见字段）。 */
function control({ clipId, cardId, snapshotKey, tier, capabilities, compositing, start = 0, count, withTier = true }) {
  const c = {
    key: `png-${clipId}`, snapshotKey, costKey: `cost-${clipId}`, frameMode: capabilities?.frameMode,
    capabilities, clipId, nodeId: `n:${clipId}`, start, end: start + count / 30, count,
    sampling: cardSampling(start, 30), compositing, cacheable: compositing === 'independent', needPrerendering: false, appearance: {},
  };
  if (withTier) c.tier = tier;
  if (cardId !== undefined) c.cardId = cardId;
  if (clipId === undefined) delete c.clipId;
  if (snapshotKey === undefined) delete c.snapshotKey;
  if (compositing === undefined) delete c.compositing;
  return c;
}
const SHARED_CAPS = { frameMode: 'stateful', compositing: 'independent' };
const LOCAL_CAPS = { frameMode: 'stateful', compositing: 'belowDependent' };

/** 按契约 B.4 的对象字面量算一个快照任务的期望值。 */
function expectSnapshot({ ctl, tier, from, to, priority, cardSources = {}, userCards = false, graphCards = false, weight = { class: 'heavy', estMs: null }, fp = FP, cv = CV }) {
  const contentKey = tier === 'shared' ? ctl.snapshotKey : `${ENTRY}/${ctl.snapshotKey}`;
  const resultKey = rkOf(contentKey, fp);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier, resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId: PROJECT, projectRev: REV, derivedFrom: PLAN_ID },
    input: { clipId: ctl.clipId, cardId: ctl.cardId ?? null, entryKey: tier === 'local' ? ENTRY : null, contentKey, canvasHeavy: false },
    weight: { ...weight, frames: to - from + 1 },
    requires: {
      envFingerprint: fp, codeVersion: cv, cardSources, transcode: false, userCards, graphCards,
      belowDependent: (ctl.compositing ?? ctl.capabilities?.compositing) === 'belowDependent',
    },
    priority,
  };
}
const baseArgs = over => ({
  planTask: planTaskOf({ projectId: PROJECT, projectRev: REV }), entryKey: ENTRY, cardPlan: [], prerenderSet: undefined,
  envFingerprint: FP, codeVersion: CV, ...over,
});
const ranges = tasks => tasks.map(t => [t.range.from, t.range.to]);

test('B.4 splitPlan: when count is exactly a multiple of 60, it is split into whole segments', () => {
  const ctl = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 120 });
  const out = splitPlan(baseArgs({ cardPlan: [ctl] }));
  assert.deepEqual(ranges(out), [[0, 59], [60, 119]]);
  assert.deepEqual(ranges(splitPlan(baseArgs({ cardPlan: [{ ...ctl, count: 60 }] }))), [[0, 59]]);
});

test('B.4 splitPlan: when count is not a multiple of 60, the last segment ends at count-1', () => {
  const ctl = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 130 });
  assert.deepEqual(ranges(splitPlan(baseArgs({ cardPlan: [ctl] }))), [[0, 59], [60, 119], [120, 129]]);
  assert.deepEqual(ranges(splitPlan(baseArgs({ cardPlan: [{ ...ctl, count: 61 }] }))), [[0, 59], [60, 60]]);
  assert.deepEqual(ranges(splitPlan(baseArgs({ cardPlan: [{ ...ctl, count: 59 }] }))), [[0, 58]]);
  assert.deepEqual(ranges(splitPlan(baseArgs({ cardPlan: [{ ...ctl, count: 1 }] }))), [[0, 0]]);
});

test('B.4 splitPlan: constants.SNAPSHOT_SPAN overrides the segment length', () => {
  const ctl = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 60 });
  const out = splitPlan(baseArgs({ cardPlan: [ctl], constants: { SNAPSHOT_SPAN: 25 } }));
  assert.deepEqual(ranges(out), [[0, 24], [25, 49], [50, 59]]);
  assert.deepEqual(out.map(t => t.weight.frames), [25, 25, 10]);
});

test('B.4 splitPlan: content keys, result keys and full task shape of the shared and local tiers', () => {
  const a = control({ clipId: 'clip-a', cardId: 'particles', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 60, start: 2 });
  const b = control({ clipId: 'clip-b', cardId: 'glass', snapshotKey: 'skb', tier: 'local', capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 60, start: 0.5 });
  const out = splitPlan(baseArgs({ cardPlan: [a, b], cardSourceVersions: { particles: 'builtin:12' } }));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], expectSnapshot({ ctl: a, tier: 'shared', from: 0, to: 59, priority: 10, cardSources: { particles: 'builtin:12' } }));
  // 契约 B.4〔c66-host-cards 改〕:本地档画整个场景(内容键里有 entry.key),要这一版全部定制卡的代码
  assert.deepEqual(out[1], expectSnapshot({ ctl: b, tier: 'local', from: 0, to: 59, priority: 10, cardSources: { particles: 'builtin:12' } }));
  // 逐项再核一次关键字段，失败时信息更直观
  assert.equal(out[0].input.contentKey, 'ska');
  assert.equal(out[0].resultKey, rkOf('ska', FP));
  assert.equal(out[0].input.entryKey, null);
  assert.equal(out[1].input.contentKey, `${ENTRY}/skb`);
  assert.equal(out[1].resultKey, rkOf(`${ENTRY}/skb`, FP));
  assert.equal(out[1].input.entryKey, ENTRY);
  assert.equal(out[1].requires.belowDependent, true);
  assert.equal(out[0].requires.belowDependent, false);
  assert.deepEqual(out[1].requires.cardSources, { particles: 'builtin:12' }, 'The local tier requires all custom cards of this version (glass is not in cardSourceVersions, so it is not listed)');
});

test('B.4 splitPlan: resultKey and id change with the environment fingerprint', () => {
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 60 });
  const other = fpOf('linux', 'intel', 138);
  const [x] = splitPlan(baseArgs({ cardPlan: [a] }));
  const [y] = splitPlan(baseArgs({ cardPlan: [a], envFingerprint: other }));
  assert.equal(y.resultKey, rkOf('ska', other));
  assert.notEqual(x.resultKey, y.resultKey);
  assert.notEqual(x.id, y.id);
  assert.equal(y.requires.envFingerprint, other);
  assert.equal(y.id, `snapshot:${y.resultKey}:0-59`);
});

test('B.4 splitPlan: without control.tier, the tier is set by snapshotTier(capabilities) (currently always none, so snapshot task splitting is skipped)', () => {
  // 没有 tier；capabilities 标了 needPrerendering 与 belowDependent → snapshotTier 给 none，splitPlan 不切快照任务
  const c = control({ clipId: 'c', snapshotKey: 'skc', capabilities: { needPrerendering: true, compositing: 'belowDependent' }, count: 10, withTier: false });
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [c] })), []);
  // 没有 tier、stateful + independent → snapshotTier 给 none，同样不切快照任务
  const d = control({ clipId: 'd', snapshotKey: 'skd', capabilities: SHARED_CAPS, count: 10, withTier: false });
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [d] })), []);
});

test('B.4 splitPlan: control.compositing takes precedence over capabilities.compositing', () => {
  const c = control({ clipId: 'c', snapshotKey: 'skc', tier: 'local', capabilities: LOCAL_CAPS, compositing: 'unknown', count: 10 });
  assert.equal(splitPlan(baseArgs({ cardPlan: [c] }))[0].requires.belowDependent, false);
});

test('B.4 splitPlan: a control with no snapshotKey, no clipId, or tier none is skipped', () => {
  const ok = control({ clipId: 'ok', snapshotKey: 'sk-ok', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const noKey = control({ clipId: 'nokey', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const noClip = control({ snapshotKey: 'sk-noclip', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const none = control({ clipId: 'none', snapshotKey: 'sk-none', tier: 'none', capabilities: { frameMode: 'stateless', compositing: 'independent' }, compositing: 'independent', count: 10 });
  const noneDerived = control({ clipId: 'none2', snapshotKey: 'sk-none2', capabilities: { frameMode: 'stateless', compositing: 'independent' }, count: 10, withTier: false });
  const out = splitPlan(baseArgs({ cardPlan: [noKey, noClip, none, ok, noneDerived] }));
  assert.deepEqual(out.map(t => t.input.clipId), ['ok']);
});

test('B.4 splitPlan: in the local tier a control missing entryKey is skipped, while the shared tier is unaffected (A.10a)', () => {
  const shared = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const local = control({ clipId: 'b', snapshotKey: 'skb', tier: 'local', capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 10 });
  for (const entryKey of [undefined, null]) {
    const out = splitPlan(baseArgs({ cardPlan: [local, shared], entryKey }));
    assert.deepEqual(out.map(t => [t.tier, t.input.clipId]), [['shared', 'a']], `entryKey=${entryKey}`);
    assert.equal(out[0].input.entryKey, null);
  }
});

test('B.4 splitPlan: a stream without streamKey is skipped (A.10a)', () => {
  const streams = [
    { topClipId: 'no-key', firstSegment: 0, lastSegment: 7 },
    { streamKey: 's', topClipId: 'top', firstSegment: 0, lastSegment: 7 },
  ];
  assert.deepEqual(splitPlan(baseArgs({ streams })).map(t => t.input.clipId), ['top']);
});

test('B.4 splitPlan: when prerenderSet is given, only the clips in it are split; undefined does not filter; an empty set skips everything', () => {
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const b = control({ clipId: 'b', snapshotKey: 'skb', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [a, b], prerenderSet: new Set(['b']) })).map(t => t.input.clipId), ['b']);
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [a, b], prerenderSet: undefined })).map(t => t.input.clipId), ['a', 'b']);
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [a, b], prerenderSet: new Set() })), []);
});

test('B.4 splitPlan: a segment containing an anchor frame gets priority 50 and the others 10; anchor frames are global frames and are converted to local frames by sampling.firstFrame', () => {
  // a 从 2 秒开始（firstFrame 60），count 120；b 从 0.5 秒开始（firstFrame 15），count 130
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 120, start: 2 });
  const b = control({ clipId: 'b', snapshotKey: 'skb', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 130, start: 0.5 });
  assert.equal(a.sampling.firstFrame, 60);
  assert.equal(b.sampling.firstFrame, 15);
  const out = splitPlan(baseArgs({ cardPlan: [a, b], anchorFrames: [59, 135] }));
  // a：59 → 本地 -1（不在任何段）；135 → 本地 75（[60,119]）
  // b：59 → 本地 44（[0,59]）；135 → 本地 120（[120,129]）
  assert.deepEqual(out.map(t => [t.input.clipId, t.range.from, t.priority]), [
    ['a', 0, 10], ['a', 60, 50],
    ['b', 0, 50], ['b', 60, 10], ['b', 120, 50],
  ]);
});

test('B.4 splitPlan: an anchor frame exactly at the first or last frame of a segment counts; one outside count does not; with no anchor frames all are 10', () => {
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 120, start: 0 });
  const pri = anchorFrames => splitPlan(baseArgs({ cardPlan: [a], anchorFrames })).map(t => t.priority);
  assert.deepEqual(pri([59]), [50, 10], 'Last frame of a segment');
  assert.deepEqual(pri([60]), [10, 50], 'First frame of a segment');
  assert.deepEqual(pri([0]), [50, 10]);
  assert.deepEqual(pri([119]), [10, 50]);
  assert.deepEqual(pri([120, 500]), [10, 10], 'Outside count');
  assert.deepEqual(pri([]), [10, 10]);
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [a] })).map(t => t.priority), [10, 10], 'Default anchorFrames');
});

test('B.4 splitPlan: weightOf / isUserCard / isGraphCard are called per control, and the results go into weight and requires', () => {
  const a = control({ clipId: 'a', cardId: 'particles', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 70 });
  const b = control({ clipId: 'b', cardId: 'user-x', snapshotKey: 'skb', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const seen = [];
  const out = splitPlan(baseArgs({
    cardPlan: [a, b],
    weightOf: c => { seen.push(c.clipId); return c.clipId === 'a' ? { class: 'light', estMs: 1234 } : { class: 'heavy', estMs: null }; },
    isUserCard: c => c.cardId === 'user-x',
    isGraphCard: c => (c.cardId === 'particles' ? 1 : 0),   // 返回真值 / 假值，结果要是布尔
  }));
  assert.ok(seen.includes('a') && seen.includes('b'), 'weightOf receives the control');
  assert.deepEqual(out.map(t => t.weight), [
    { class: 'light', estMs: 1234, frames: 60 }, { class: 'light', estMs: 1234, frames: 10 }, { class: 'heavy', estMs: null, frames: 10 },
  ]);
  assert.deepEqual(out.map(t => [t.requires.userCards, t.requires.graphCards]), [[false, true], [false, true], [true, false]]);
});

test('B.4 splitPlan: the default weightOf gives heavy and estMs null', () => {
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  assert.deepEqual(splitPlan(baseArgs({ cardPlan: [a] }))[0].weight, { class: 'heavy', estMs: null, frames: 10 });
});

test('B.4 splitPlan: cardSources is filled only when the control has a cardId and cardSourceVersions contains it', () => {
  const withSrc = control({ clipId: 'a', cardId: 'particles', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const noSrc = control({ clipId: 'b', cardId: 'text', snapshotKey: 'skb', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const noCard = control({ clipId: 'c', snapshotKey: 'skc', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const out = splitPlan(baseArgs({ cardPlan: [withSrc, noSrc, noCard], cardSourceVersions: { particles: 'builtin:12' } }));
  assert.deepEqual(out.map(t => t.requires.cardSources), [{ particles: 'builtin:12' }, {}, {}]);
  assert.deepEqual(out.map(t => t.input.cardId), ['particles', 'text', null]);
});

test('B.4 splitPlan: source takes only projectId / projectRev of planTask.source, derivedFrom is planTask.id (planTask can be a TaskView)', () => {
  const planTask = {
    ...planTaskOf({ projectId: PROJECT, projectRev: REV }),
    source: { userId: 'u1', tenantId: 't1', projectId: PROJECT, projectRev: REV, publisher: { id: 'P' }, publishedAt: 5, derivedFrom: null },
    state: 'claimed', version: 2, attempts: 0,
  };
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 10 });
  const streams = [{ streamKey: 'stream-1', topClipId: 'top', firstSegment: 0, lastSegment: 3 }];
  for (const t of splitPlan(baseArgs({ planTask, cardPlan: [a], streams })))
    assert.deepEqual(t.source, { projectId: PROJECT, projectRev: REV, derivedFrom: PLAN_ID }, t.id);
});

test('B.4 splitPlan: stream tasks are split into segments by STREAM_SEGMENTS (default 8), with fields per the contract', () => {
  const streams = [
    { streamKey: 'stream-1', topClipId: 'top-1', firstSegment: 0, lastSegment: 15 },   // 恰为 8 的倍数
    { streamKey: 'stream-2', topClipId: 'top-2', firstSegment: 8, lastSegment: 26 },   // 不是
  ];
  const weightCalls = [];
  const out = splitPlan(baseArgs({ streams, weightOf: arg => { weightCalls.push(arg); return { class: 'medium', estMs: 7 }; } }));
  assert.deepEqual(out.map(t => [t.input.contentKey, t.range.from, t.range.to]), [
    ['stream-1', 0, 7], ['stream-1', 8, 15],
    ['stream-2', 8, 15], ['stream-2', 16, 23], ['stream-2', 24, 26],
  ]);
  for (const t of out) {
    const top = t.input.contentKey === 'stream-1' ? 'top-1' : 'top-2';
    const resultKey = rkOf(t.input.contentKey, FP);
    assert.equal(t.id, `stream:${resultKey}:${t.range.from}-${t.range.to}`);
    assert.equal(t.kind, 'stream');
    assert.equal(t.resultKey, resultKey);
    assert.deepEqual(t.range, { unit: 'segment', from: t.range.from, to: t.range.to });
    assert.deepEqual(t.source, { projectId: PROJECT, projectRev: REV, derivedFrom: PLAN_ID });
    assert.deepEqual(t.input, { clipId: top, cardId: null, entryKey: null, contentKey: t.input.contentKey });
    assert.deepEqual(t.weight, { class: 'medium', estMs: 7, frames: (t.range.to - t.range.from + 1) * 15 });
    // M6c X1：流任务另带 requires.capabilities.streams = true
    assert.deepEqual(t.requires, { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } });
    assert.equal(t.priority, 10);
  }
  assert.ok(weightCalls.some(arg => arg && arg.clipId === 'top-1'), 'weightOf is called with { clipId: topClipId }');
  assert.ok(weightCalls.some(arg => arg && arg.clipId === 'top-2'));
});

test('B.4 splitPlan: the segment count of stream tasks can be overridden by constants.STREAM_SEGMENTS; anchor frames do not affect stream task priority', () => {
  const streams = [{ streamKey: 's', topClipId: 'top', firstSegment: 0, lastSegment: 9 }];
  const out = splitPlan(baseArgs({ streams, constants: { STREAM_SEGMENTS: 4 }, anchorFrames: [0, 1, 2, 3, 100] }));
  assert.deepEqual(ranges(out), [[0, 3], [4, 7], [8, 9]]);
  assert.deepEqual(out.map(t => t.weight.frames), [60, 60, 30]);
  assert.deepEqual(out.map(t => t.priority), [10, 10, 10]);
});

test('B.4 splitPlan: output order is snapshots first (cardPlan order, segments ascending), then streams (streams order, segments ascending)', () => {
  const a = control({ clipId: 'a', snapshotKey: 'ska', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 70 });
  const b = control({ clipId: 'b', snapshotKey: 'skb', tier: 'local', capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 130 });
  const streams = [
    { streamKey: 's2', topClipId: 'x', firstSegment: 0, lastSegment: 9 },
    { streamKey: 's1', topClipId: 'y', firstSegment: 0, lastSegment: 3 },
  ];
  const out = splitPlan(baseArgs({ cardPlan: [b, a], streams }));
  assert.deepEqual(out.map(t => [t.kind, t.input.contentKey, t.range.from]), [
    ['snapshot', `${ENTRY}/skb`, 0], ['snapshot', `${ENTRY}/skb`, 60], ['snapshot', `${ENTRY}/skb`, 120],
    ['snapshot', 'ska', 0], ['snapshot', 'ska', 60],
    ['stream', 's2', 0], ['stream', 's2', 8],
    ['stream', 's1', 0],
  ]);
});

test('B.4 splitPlan: the same id appears only once, and the first occurrence is kept', () => {
  // 两个片段用同一张共享快照（同 snapshotKey、shared）：第一个 60 帧，第二个 130 帧
  const first = control({ clipId: 'first', snapshotKey: 'same', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 60 });
  const second = control({ clipId: 'second', snapshotKey: 'same', tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', count: 130 });
  // 同 snapshotKey 但本地档：内容键不同，不算重复
  const local = control({ clipId: 'local', snapshotKey: 'same', tier: 'local', capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 60 });
  const streams = [
    { streamKey: 'st', topClipId: 'x', firstSegment: 0, lastSegment: 7 },
    { streamKey: 'st', topClipId: 'y', firstSegment: 0, lastSegment: 15 },
  ];
  const out = splitPlan(baseArgs({ cardPlan: [first, second, local], streams }));
  assert.equal(new Set(out.map(t => t.id)).size, out.length, 'No duplicate ids');
  assert.deepEqual(out.map(t => [t.input.clipId, t.range.from, t.range.to]), [
    ['first', 0, 59], ['second', 60, 119], ['second', 120, 129],
    ['local', 0, 59],
    ['x', 0, 7], ['y', 8, 15],
  ]);
});

test('B.4 splitPlan: returns an empty array when there is nothing', () => {
  assert.deepEqual(splitPlan(baseArgs({})), []);
});
