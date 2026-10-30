/**
 * M7-T：D12 层表 v3（每层带候选：切分方自己的、浏览器的；页面按 task.done 与清单认定哪一份活着）与读旧 v2 的兼容。
 * 依据：`docs/plan/m7-contract.md` 第 13 节 D12 裁定「层表 v 2 升 v 3；读旧 v 2 的页面当『一个候选』处理」。
 * 假设见 `m7-kit.mjs` 的 K9。v2 兼容那一条现在就跑（守回归）；v3 的在门后面。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-layer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importRepo, rk, layerV3Gate, gateOpts } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const CK = 'ck-m1';

const snapshotSource = () => importRepo('src/render/snapshotSource.ts');

const candidate = (fp) => ({ resultKey: rk(CK, fp), envFingerprint: fp, key: `wire-${fp.slice(0, 4)}` });
/** v3 的一层：层上的 resultKey / envFingerprint / key 等于第一个候选（K9） */
function v3Layer(candidates, clipId = 'clip-m1') {
  const first = candidates[0];
  return { clipId, kind: 'html', key: first.key, tier: 'shared', resultKey: first.resultKey, dirKey: first.resultKey, entryKey: null,
    firstFrame: 0, count: 120, contentKey: CK, envFingerprint: first.envFingerprint, candidates };
}
const table = (v, layers) => ({ v, kind: 'layer-map', projectId: 'p1', entryKey: null, fps: 30, span: 60, at: 0, layers });
const v2Layer = (clipId = 'clip-m1') => ({ clipId, kind: 'html', key: 'wire-v2', tier: 'shared', resultKey: rk(CK, OWN), dirKey: rk(CK, OWN), entryKey: null,
  firstFrame: 0, count: 120, contentKey: CK, envFingerprint: OWN });

/** 回的这一层的 (resultKey, envFingerprint, key) 必须同出一个候选（不混） */
function assertWholeCandidate(ref, candidates) {
  const hit = candidates.find((c) => c.resultKey === ref.resultKey);
  assert.ok(hit, `回的 resultKey 不是任何候选：${JSON.stringify(ref)}`);
  assert.equal(ref.envFingerprint, hit.envFingerprint, '指纹与结果键要同出一个候选');
  assert.equal(ref.key, hit.key, '线上键与结果键要同出一个候选');
}

test('D12 读旧 v2：当「一个候选」，给不给 alive 都照旧回那一层（回归）', async () => {
  const { layerRefOf } = await snapshotSource();
  const t = table(2, [v2Layer()]);
  const plain = layerRefOf(t, 'clip-m1');
  assert.ok(plain, 'v2 普通档照旧能用');
  assert.equal(plain.resultKey, rk(CK, OWN));
  for (const alive of [new Set(), new Set(['something-else']), new Set([rk(CK, OWN)])]) {
    const ref = layerRefOf(t, 'clip-m1', { alive });
    assert.equal(ref?.resultKey, rk(CK, OWN), `v2 不看 alive：${JSON.stringify(ref)}`);
    assert.equal(ref.envFingerprint, OWN);
  }
});

test('D12 v3：认定浏览器那份活着，就整份用浏览器的（结果键、指纹、线上键）', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const cands = [candidate(OWN), candidate(BR)];
  const t = table(3, [v3Layer(cands)]);
  const ref = layerRefOf(t, 'clip-m1', { alive: new Set([rk(CK, BR)]) });
  assert.ok(ref, 'v3 选得出');
  assert.equal(ref.resultKey, rk(CK, BR));
  assert.equal(ref.envFingerprint, BR);
  assertWholeCandidate(ref, cands);
  assert.equal(ref.contentKey, CK);
});

test('D12 v3：认定切分方那份活着，就用切分方的；认不出时要么 null、要么整份一个候选，绝不混', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const cands = [candidate(OWN), candidate(BR)];
  const t = table(3, [v3Layer(cands)]);
  const own = layerRefOf(t, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.equal(own?.resultKey, rk(CK, OWN));
  assertWholeCandidate(own, cands);
  for (const opts of [{}, { alive: new Set() }]) {
    const ref = layerRefOf(t, 'clip-m1', opts);
    if (ref !== null && ref !== undefined) assertWholeCandidate(ref, cands);
  }
  // 候选顺序反过来（层上字段等于浏览器那份），认定切分方活着，也要整份切到切分方
  const rev = table(3, [v3Layer([candidate(BR), candidate(OWN)])]);
  const r2 = layerRefOf(rev, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.equal(r2?.resultKey, rk(CK, OWN));
  assertWholeCandidate(r2, cands);
});

test('D12 v3：只有一个候选时当 v2 用（不必等认定）；候选坏了的层不回', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const single = table(3, [v3Layer([candidate(OWN)])]);
  const ref = layerRefOf(single, 'clip-m1');
  assert.equal(ref?.resultKey, rk(CK, OWN));
  assert.equal(ref.envFingerprint, OWN);
  // 候选缺指纹：普通档不能用（与 v2 缺指纹同一口径）
  const broken = table(3, [v3Layer([{ resultKey: rk(CK, OWN), envFingerprint: null, key: 'w' }])]);
  const b = layerRefOf(broken, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.ok(b === null || b === undefined, `缺指纹的候选不该回：${JSON.stringify(b)}`);
});
