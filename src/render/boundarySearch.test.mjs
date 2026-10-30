/**
 * 界限搜索（`boundarySearch.mjs`；语义 `mechanism/rendering.md`「界限搜索与成本记录」）。用例 BS-C01～BS-C11。
 * 跑：node --test src/render/boundarySearch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundarySearch, classifyWithBoundary, createMemoryCostStore, localCostKey, maxMeasurements, median, representativeCosts,
  BOUNDARY_MARGIN, BOUNDARY_EXTRA_MAX,
} from './boundarySearch.mjs';

const B = 1000 / 30 * 0.7; // 23.33 ms
const key = (i) => `card${String(i).padStart(3, '0')}`;

/** n 张卡：共享记录按 i 递增；本机实测 = local(i) */
function fixture(n, local, { reps = (i) => i + 1 } = {}) {
  const records = [];
  for (let i = 0; i < n; i++) records.push({ identityKey: key(i), stepMs: reps(i) });
  const calls = [];
  const measure = async (k) => {
    calls.push(k);
    const i = Number(k.slice(4));
    const ms = local(i);
    return ms === null ? null : { stepMs: ms, samples: 16 };
  };
  return { keys: records.map((r) => r.identityKey), records, measure, calls };
}

test('BS-C01 代表耗时取中位数（多条记录来自不同环境，偶数个取中间两个的平均）', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), undefined);
  const reps = representativeCosts([
    { identityKey: 'a', stepMs: 10 }, { identityKey: 'a', stepMs: 2 }, { identityKey: 'a', stepMs: 7 },
    { identityKey: 'b', stepMs: 5 }, { identityKey: 'b', stepMs: 9 },
    { identityKey: 'c', stepMs: Number.NaN },
  ]);
  assert.deepEqual([...reps.entries()].sort(), [['a', 7], ['b', 7]]);
});

test('BS-C02 二分找到第一张跑不动的卡：它和更耗时的全判重，更省的全判轻', async () => {
  // 本机比共享记录慢 2 倍：rep = i+1，本机 = 2(i+1)；B = 23.33 → i ≤ 10 跑得动（22 ms），i = 11 起跑不动
  const n = 40;
  const f = fixture(n, (i) => 2 * (i + 1));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, margin: 0, extraMax: 0 });
  assert.equal(r.boundary, 11);
  for (let i = 0; i < n; i++) assert.equal(r.heavy.has(key(i)), i >= 11, key(i));
  assert.equal(r.light.size + r.heavy.size, n);
  assert.ok(r.measurements <= Math.ceil(Math.log2(n + 1)), `二分测了 ${r.measurements} 次`);
  assert.equal(r.threshold, 12, '界限那张卡的代表耗时');
});

test('BS-C03 余量：界限两侧各多测 1 张；测量次数不超过 ⌈log₂(n+1)⌉ + 2 + extraMax，约 log₂(n) + 2', async () => {
  for (const n of [1, 2, 3, 7, 8, 20, 63, 64, 100, 257]) {
    for (const cut of [0, 1, Math.floor(n / 3), n - 1, n]) {
      const f = fixture(n, (i) => (i < cut ? 5 : 50));
      const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
      assert.equal(r.boundary, cut, `n=${n} cut=${cut}`);
      assert.ok(r.measurements <= maxMeasurements(n), `n=${n} cut=${cut}: ${r.measurements} > ${maxMeasurements(n)}`);
      assert.ok(r.measurements <= Math.ceil(Math.log2(n + 1)) + 2 * BOUNDARY_MARGIN + BOUNDARY_EXTRA_MAX);
      // 余量真的测了：界限两侧（在范围内的）都有实测
      if (cut > 0) assert.ok(r.measured.has(key(cut - 1)), `n=${n} cut=${cut}：省的一侧紧挨界限的那张测过`);
      if (cut < n) assert.ok(r.measured.has(key(cut)), `n=${n} cut=${cut}：界限那张测过`);
    }
  }
  assert.equal(maxMeasurements(100), 7 + 2 + 2);
  assert.equal(maxMeasurements(0), 0);
});

test('BS-C04 实测与排序矛盾时以实测为准、界限随之挪动（重的一侧测出跑得动）', async () => {
  // 本机：i ≤ 7 跑得动、8 跑不动、9 其实跑得动（排序错了）、10 起跑不动。二分停在 8；
  // 余量测重的一侧最近的没测过的 9 —— 跑得动，界限挪到 10，再测 10（跑不动）才停
  const local = (i) => (i <= 7 || i === 9 ? 5 : 60);
  const f = fixture(16, local);
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
  assert.equal(r.boundary, 10);
  assert.ok(r.heavy.has(key(8)), '8 实测跑不动，仍判重');
  assert.ok(r.light.has(key(9)), '9 实测跑得动，判轻');
  for (let i = 10; i < 16; i++) assert.ok(r.heavy.has(key(i)), key(i));
  for (let i = 0; i < 8; i++) assert.ok(r.light.has(key(i)), key(i));
  assert.ok(r.measured.has(key(9)) && r.measured.has(key(10)));
  assert.ok(r.measurements <= maxMeasurements(16));
});

test('BS-C05 省的一侧测出跑不动：界限挪到它，比它贵又没测的卡一起判重', async () => {
  // 本机：3 跑不动（排序错了）、5 起跑不动。二分停在 5；余量测省的一侧最近的没测过的 3 —— 跑不动，
  // 界限挪到 3，接着测 2（跑得动）才停；重的一侧再测 7
  const local = (i) => (i === 3 || i >= 5 ? 40 : 4);
  const f = fixture(8, local);
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, margin: 1, extraMax: 2 });
  assert.equal(r.boundary, 3);
  assert.ok(r.heavy.has(key(3)));
  assert.ok(r.light.has(key(4)), '4 测过、跑得动：按实测判轻');
  assert.ok(r.light.has(key(0)) && r.light.has(key(1)) && r.light.has(key(2)));
  for (const i of [5, 6, 7]) assert.ok(r.heavy.has(key(i)));
  for (const [k, v] of r.measured) assert.equal(r.heavy.has(k), v.ms > B, k);
  assert.deepEqual(f.calls, [key(4), key(6), key(5), key(3), key(2), key(7)], '测量顺序：二分 3 次、省的一侧 2 次、重的一侧 1 次');
});

test('BS-C06 没有成本记录的卡按重卡、不测；一张记录都没有时一次都不测、全判重', async () => {
  const f = fixture(5, () => 1);
  const r = await boundarySearch({ keys: [...f.keys, 'newcard', 'other'], records: f.records, budgetMs: B, measure: f.measure });
  assert.ok(r.heavy.has('newcard') && r.heavy.has('other'));
  assert.deepEqual(r.unrecorded, ['newcard', 'other']);
  assert.ok(!f.calls.includes('newcard'));
  const none = fixture(0, () => 1);
  const r2 = await boundarySearch({ keys: ['x', 'y'], records: [], budgetMs: B, measure: none.measure });
  assert.equal(r2.measurements, 0);
  assert.deepEqual([...r2.heavy].sort(), ['x', 'y']);
  assert.equal(r2.light.size, 0);
});

test('BS-C07 本地复用：测过的按「卡片身份 + 本机环境指纹」存下，下次打开一次都不再测，判定相同', async () => {
  const store = createMemoryCostStore();
  const f = fixture(50, (i) => (i < 20 ? 10 : 30));
  const first = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, store, envFingerprint: 'fp0123456789abcd' });
  assert.ok(first.measurements > 0);
  assert.equal(store.size(), first.measurements, '每次实测存一条');
  const rec = await store.getCost(localCostKey(key(first.trace[0].index), 'fp0123456789abcd'));
  assert.equal(rec.envFingerprint, 'fp0123456789abcd');
  assert.ok(localCostKey('abc', 'fp') === 'abc|fp');
  const again = fixture(50, () => { throw new Error('不该再测'); });
  const second = await boundarySearch({ keys: again.keys, records: again.records, budgetMs: B, measure: again.measure, store, envFingerprint: 'fp0123456789abcd' });
  assert.equal(second.measurements, 0, '第二次打开不测');
  assert.deepEqual([...second.heavy].sort(), [...first.heavy].sort());
  // 换了环境（指纹不同）：键对不上，要重测
  const other = fixture(50, (i) => (i < 20 ? 10 : 30));
  const third = await boundarySearch({ keys: other.keys, records: other.records, budgetMs: B, measure: other.measure, store, envFingerprint: 'ffffffffffffffff' });
  assert.ok(third.measurements > 0);
});

test('BS-C08 测量失败按跑不动算、不存；COST_SCALE 乘在实测上', async () => {
  const store = createMemoryCostStore();
  const f = fixture(4, (i) => (i === 1 ? null : 10));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, store, margin: 1, extraMax: 0 });
  if (r.measured.has(key(1))) {
    assert.ok(r.heavy.has(key(1)));
    assert.equal(await store.getCost(localCostKey(key(1), '')), undefined, '失败的不存');
  }
  const g = fixture(4, () => 15);
  const scaled = await boundarySearch({ keys: g.keys, records: g.records, budgetMs: B, measure: g.measure, scale: 2 });
  assert.equal(scaled.light.size, 0, '15 × 2 = 30 > 23.3，全判重');
});

test('BS-C09 搜索之后来的新卡不再测：按代表耗时落在界限哪一侧判，测过的按实测，没记录的算重', async () => {
  const f = fixture(10, (i) => (i < 4 ? 5 : 50));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
  const records = [...f.records, { identityKey: 'cheapNew', stepMs: 1.5 }, { identityKey: 'dearNew', stepMs: 9 }];
  const c = classifyWithBoundary(r, [...f.keys, 'cheapNew', 'dearNew', 'noRecord'], records);
  assert.ok(c.light.has('cheapNew'));
  assert.ok(c.heavy.has('dearNew'));
  assert.ok(c.heavy.has('noRecord'));
  for (let i = 0; i < 10; i++) assert.equal(c.heavy.has(key(i)), r.heavy.has(key(i)), key(i));
});

test('BS-C10 同一张卡在项目里出现多次只判一次；代表耗时相同时按 identityKey 定序（结果稳定）', async () => {
  const records = [{ identityKey: 'b', stepMs: 5 }, { identityKey: 'a', stepMs: 5 }, { identityKey: 'c', stepMs: 5 }];
  const calls = [];
  const measure = async (k) => { calls.push(k); return { stepMs: k === 'a' ? 5 : 50 }; };
  const r = await boundarySearch({ keys: ['a', 'b', 'a', 'c', 'b'], records, budgetMs: B, measure });
  assert.deepEqual(r.order.map((o) => o.key), ['a', 'b', 'c']);
  assert.ok(r.light.has('a') && r.heavy.has('b') && r.heavy.has('c'));
  assert.equal(new Set(calls).size, calls.length, '一张卡最多测一次');
});

test('BS-C11 没有记录的卡逐张实测（measureUnrecorded，在线页面一律给）：跑得动的判轻、跑不动或测不出的判重，本地复用照样命中', async () => {
  const store = createMemoryCostStore();
  const f = fixture(6, (i) => i + 1);
  const local = { newLight: 5, newHeavy: 40, newFail: null };
  const measure = async (k) => (k in local ? (local[k] === null ? null : { stepMs: local[k], samples: 16 }) : f.measure(k));
  const calls = [];
  const spy = async (k) => { calls.push(k); return measure(k); };
  const keys = [...f.keys, 'newLight', 'newHeavy', 'newFail'];
  const r = await boundarySearch({ keys, records: f.records, budgetMs: B, measure: spy, store, envFingerprint: 'fp', measureUnrecorded: true });
  assert.ok(r.light.has('newLight'), '本机 5 ms:判轻');
  assert.ok(r.heavy.has('newHeavy'), '本机 40 ms:判重');
  assert.ok(r.heavy.has('newFail'), '测不出来:按跑不动算');
  for (const k of ['newLight', 'newHeavy', 'newFail']) assert.ok(calls.includes(k), `${k} 测了`);
  assert.deepEqual(r.unrecorded, ['newFail', 'newHeavy', 'newLight']);
  // 一张记录都没有:全部逐张实测
  const none = await boundarySearch({ keys: ['x', 'y'], records: [], budgetMs: B, measure: async (k) => ({ stepMs: k === 'x' ? 1 : 99, samples: 16 }), measureUnrecorded: true });
  assert.equal(none.measurements, 2);
  assert.deepEqual([...none.light], ['x']);
  assert.deepEqual([...none.heavy], ['y']);
  // 第二次打开:本地复用命中,不再测
  const again = [];
  const r2 = await boundarySearch({ keys, records: f.records, budgetMs: B, measure: async (k) => { again.push(k); return measure(k); }, store, envFingerprint: 'fp', measureUnrecorded: true });
  assert.ok(!again.includes('newLight') && !again.includes('newHeavy'), '测出来的存下了');
  assert.ok(again.includes('newFail'), '测不出来的不存,下次再测');
  assert.ok(r2.light.has('newLight'));
});
