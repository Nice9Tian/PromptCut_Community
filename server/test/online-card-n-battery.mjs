/**
 * 仅供测试。块 N(`docs/plan/online-card-exec-contract.md` 第 7 节)「内置卡的结果键与切分一个字不变」的对照用例。
 *
 * 一组固定输入喂给 `splitPlan` 与指纹函数,收齐每份输出;测试把每一份输出的摘要、以及每个任务的结果键,
 * 与**改动之前**(起点提交 3820592c)的代码跑出来的字面值逐个比对。
 * 里面没有任何用户卡、素材效果卡、`browserCards`:全是内置卡的老形状,所以改前改后必须逐字相同。
 */
import crypto from 'node:crypto';
import { splitPlan } from '../render-node/split.mjs';
import { describeEnvironment, envFingerprintOf, resultKeyOf } from '../render-node/fingerprint.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const OWN = describeEnvironment({ platform: 'win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)', chromeVersion: 'HeadlessChrome/138.0.7204.49' }).fingerprint;
const BR = describeEnvironment({ platform: 'Windows', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (Intel)', chromeVersion: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }).fingerprint;
const THIRD = '3333333333333333';

const sk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: sk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    count: 130, sampling: { firstFrame: 0, step: 1 }, compositing: 'independent', capabilities: { compositing: 'independent' },
    ...extra,
  };
}
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', range: null, source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['a', 'b', 'c', 'd', 'e'] }, requires: { codeVersion: 'cv-1' }, priority: 'normal' };

const cards = () => [
  control('a'),
  control('b', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
  control('c', { tier: 'local', compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
  control('d', { cardId: 'lottie-x' }),
  control('e', { snapshotOversize: true }),
];

/** 每一项:`[标签, splitPlan 的输入]` */
export function batteryInputs() {
  const base = { planTask, entryKey: 'entry-1', cardPlan: cards(), prerenderSet: null, envFingerprint: OWN, codeVersion: 'cv-1', anchorFrames: [0, 70], weightOf };
  return [
    ['无浏览器', { ...base }],
    ['浏览器指纹(docservice 给的)', { ...base, browserFingerprints: [BR] }],
    ['浏览器指纹等于自己', { ...base, browserFingerprints: [OWN] }],
    ['browser 对象写法', { ...base, browser: { nodeId: 'n-br', envFingerprint: BR } }],
    ['锁在第三种环境', { ...base, browserFingerprints: [BR], cardLocks: { 'snapshot:ck-a': THIRD } }],
    ['锁在第三种环境并接手', { ...base, browserFingerprints: [BR], cardLocks: { 'snapshot:ck-a': THIRD }, takeover: true }],
    ['预渲染重试档', { ...base, browserFingerprints: [BR], lane: 'backfill' }],
    ['改过源码的内置卡', { ...base, browserFingerprints: [BR], cardSourceVersions: { 'card-a': 'ver-a' } }],
    ['含本地素材', { ...base, browserFingerprints: [BR], localMedia: 'node-1', usesLocalMedia: (c) => c.clipId === 'a' }],
    ['有流', { ...base, browserFingerprints: [BR], streams: [{ streamKey: sk('st', OWN), contentKey: 'st', topClipId: 'bg', firstSegment: 0, lastSegment: 11 }] }],
  ];
}

/** → `{ [标签]: { digest, keys: [每个任务的 resultKey…](去重、保序), count } }` */
export function runBattery() {
  const out = {};
  for (const [label, input] of batteryInputs()) {
    const tasks = splitPlan(input);
    const keys = [...new Set(tasks.map((t) => t.resultKey))];
    out[label] = { count: tasks.length, digest: sha256(JSON.stringify(tasks)), keys };
  }
  out['指纹函数'] = {
    count: 3,
    digest: sha256(JSON.stringify([OWN, BR, envFingerprintOf({ os: 'linux', gpuClass: 'software', chromeMajor: 152 }), resultKeyOf('x', OWN)])),
    keys: [OWN, BR],
  };
  return out;
}
