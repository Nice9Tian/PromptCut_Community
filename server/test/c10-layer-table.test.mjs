/**
 * C10 层表与环境（`docs/plan/c10-contract.md` 第 5 节；语义 `product/rendering.md`「不同环境的结果不混用」）。
 * 跑：node --test server/test/c10-layer-table.test.mjs
 *
 *   C10-LT-01 层表带共享档的内容键与产出环境的指纹，对得上的层回这两样（页面按它找清单）；
 *   C10-LT-02 缺内容键或缺环境指纹的层（节点代码版本对不上）按「没有预渲染结果」处理：回空、不抛；
 *   C10-LT-03 层表坏了（null、字符串、没有 layers、layers 里混着坏项）：回空、不抛，好的那一层照常；
 *   C10-LT-04 层表里没有这一层：回空；
 *   C10-LT-05 一层只取一种环境：同一层在层表里出现两种指纹时，回的只有一种，且每次相同（或按对不上回空）；
 *   C10-LT-06 页面不算键：层表所在的模块不引 `resultKeyOf`、`snapshotCode`、`cardCostKey`（分布式队列设计 Q1）。
 *
 * 假设见 `c10-kit.mjs` 的 K4。实现不在时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layerGate, layerEntry, layerTable, importRepo, repoPath } from './c10-kit.mjs';

const gate = layerGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

async function refFn() {
  const mod = await importRepo(gate.file);
  return (table, clipId) => {
    const r = mod[gate.name](table, clipId);
    assert.ok(!(r instanceof Promise), `假设 K4：${gate.name} 应是同步的纯函数`);
    return r ?? null;
  };
}

const FP_A = 'env-a'.padEnd(64, 'a');
const FP_B = 'env-b'.padEnd(64, 'b');
const CK = (id) => `ck-${id}`.padEnd(64, '0');

it('C10-LT-01 对得上的层回内容键与环境指纹', async () => {
  const ref = await refFn();
  const table = layerTable([layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A }), layerEntry({ clipId: 'h2', contentKey: CK('h2'), envFingerprint: FP_B })]);
  const r1 = ref(table, 'h1');
  assert.ok(r1, 'h1 在层表里');
  assert.equal(r1.contentKey, CK('h1'));
  assert.equal(r1.envFingerprint, FP_A);
  assert.equal(ref(table, 'h2').envFingerprint, FP_B);
});

it('C10-LT-02 缺内容键或缺环境指纹的层按「没有预渲染结果」处理，不抛', async () => {
  const ref = await refFn();
  const noFp = layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: undefined });
  delete noFp.envFingerprint;
  const noCk = layerEntry({ clipId: 'h2', contentKey: undefined, envFingerprint: FP_A });
  delete noCk.contentKey;
  const table = layerTable([noFp, noCk, layerEntry({ clipId: 'h3', contentKey: '', envFingerprint: FP_A })]);
  for (const id of ['h1', 'h2', 'h3']) assert.equal(ref(table, id), null, `${id} 对不上，应回空`);
});

it('C10-LT-03 层表坏了回空、不抛；坏项旁边的好层照常', async () => {
  const ref = await refFn();
  for (const bad of [null, undefined, 'x', 42, {}, { layers: 'x' }, { layers: [null, 3, 'y'] }, []]) {
    assert.equal(ref(bad, 'h1'), null, `层表 ${JSON.stringify(bad)} 应回空`);
  }
  const mixed = layerTable([null, 7, { clipId: 5 }, layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A })]);
  assert.equal(ref(mixed, 'h1')?.envFingerprint, FP_A);
});

it('C10-LT-04 层表里没有这一层：回空', async () => {
  const ref = await refFn();
  assert.equal(ref(layerTable([layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A })]), 'nope'), null);
});

it('C10-LT-05 一层只取一种环境：同一层出现两种指纹时只回一种、每次相同（或回空）', async () => {
  const ref = await refFn();
  const table = layerTable([
    layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A }),
    layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_B }),
  ]);
  const a = ref(table, 'h1');
  const b = ref(table, 'h1');
  if (a === null) {
    assert.equal(b, null);
    return;
  }
  assert.equal(typeof a.envFingerprint, 'string');
  assert.ok([FP_A, FP_B].includes(a.envFingerprint));
  assert.equal(b.envFingerprint, a.envFingerprint, '同一份层表每次回同一种环境');
  assert.ok(!Array.isArray(a.envFingerprints) || a.envFingerprints.length <= 1, '不混两种环境');
});

it('C10-LT-06 页面不算键：层表所在的模块不引 resultKeyOf、snapshotCode、cardCostKey', () => {
  const src = fs.readFileSync(repoPath(gate.file), 'utf8');
  for (const name of ['resultKeyOf', 'snapshotCode', 'cardCostKey']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(src), false, `${gate.file} 里出现了 ${name}（页面不移植键的计算）`);
  }
});
