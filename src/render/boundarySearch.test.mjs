/**
 * Bounds search (`boundarySearch.mjs`; semantics `mechanism/rendering.md`
 * "Bounds search and cost records"). Test cases BS-C01-BS-C11.
 * Run: node --test src/render/boundarySearch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundarySearch, classifyWithBoundary, createMemoryCostStore, localCostKey, maxMeasurements, median, representativeCosts,
  BOUNDARY_MARGIN, BOUNDARY_EXTRA_MAX,
} from './boundarySearch.mjs';

const B = 1000 / 30 * 0.7; // 23.33 ms
const key = (i) => `card${String(i).padStart(3, '0')}`;

/** n cards: shared records increase with i; local measurement = local(i) */
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

test('BS-C01 representative time is the median (multiple records come from different environments, for an even count take the average of the middle two)', () => {
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

test('BS-C02 binary search finds the first card that cannot keep up: it and all costlier ones are judged heavy, all cheaper ones light', async () => {
  // Local machine is 2x slower than shared records: rep = i+1, local = 2(i+1);
  // B = 23.33 → i ≤ 10 can run (22 ms), cannot run from i = 11 onwards
  const n = 40;
  const f = fixture(n, (i) => 2 * (i + 1));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, margin: 0, extraMax: 0 });
  assert.equal(r.boundary, 11);
  for (let i = 0; i < n; i++) assert.equal(r.heavy.has(key(i)), i >= 11, key(i));
  assert.equal(r.light.size + r.heavy.size, n);
  assert.ok(r.measurements <= Math.ceil(Math.log2(n + 1)), `binary search measured ${r.measurements} times`);
  assert.equal(r.threshold, 12, 'representative time of the threshold card');
});

test('BS-C03 margin: measure 1 extra card on each side of the threshold; measurement count does not exceed ⌈log₂(n+1)⌉ + 2 + extraMax, about log₂(n) + 2', async () => {
  for (const n of [1, 2, 3, 7, 8, 20, 63, 64, 100, 257]) {
    for (const cut of [0, 1, Math.floor(n / 3), n - 1, n]) {
      const f = fixture(n, (i) => (i < cut ? 5 : 50));
      const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
      assert.equal(r.boundary, cut, `n=${n} cut=${cut}`);
      assert.ok(r.measurements <= maxMeasurements(n), `n=${n} cut=${cut}: ${r.measurements} > ${maxMeasurements(n)}`);
      assert.ok(r.measurements <= Math.ceil(Math.log2(n + 1)) + 2 * BOUNDARY_MARGIN + BOUNDARY_EXTRA_MAX);
      // Margin was actually measured: both sides of the boundary (within range) have actual measurements
      if (cut > 0) assert.ok(r.measured.has(key(cut - 1)), `n=${n} cut=${cut}: the card right next to the threshold on the cheaper side was measured`);
      if (cut < n) assert.ok(r.measured.has(key(cut)), `n=${n} cut=${cut}: the threshold card was measured`);
    }
  }
  assert.equal(maxMeasurements(100), 7 + 2 + 2);
  assert.equal(maxMeasurements(0), 0);
});

test('BS-C04 when measurement contradicts the ordering, measurement wins and the threshold moves accordingly (the heavy side measures as able to keep up)', async () => {
  // Local: i ≤ 7 can run, 8 cannot run, 9 actually can run (wrong order), cannot run from 10 onwards.
  // Binary search stops at 8; margin measures 9, the closest unmeasured on the heavy side: can run,
  // boundary moves to 10, and only stops after measuring 10 (cannot run)
  const local = (i) => (i <= 7 || i === 9 ? 5 : 60);
  const f = fixture(16, local);
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
  assert.equal(r.boundary, 10);
  assert.ok(r.heavy.has(key(8)), '8 measured as unable to keep up, still judged heavy');
  assert.ok(r.light.has(key(9)), '9 measured as able to keep up, judged light');
  for (let i = 10; i < 16; i++) assert.ok(r.heavy.has(key(i)), key(i));
  for (let i = 0; i < 8; i++) assert.ok(r.light.has(key(i)), key(i));
  assert.ok(r.measured.has(key(9)) && r.measured.has(key(10)));
  assert.ok(r.measurements <= maxMeasurements(16));
});

test('BS-C05 the cheaper side measures as unable to keep up: the threshold moves to it, and unmeasured cards costlier than it are all judged heavy', async () => {
  // Local: 3 cannot run (wrong order), cannot run from 5 onwards. Binary search stops at 5;
  // margin measures 3, the closest unmeasured on the light side: cannot run, boundary moves to 3,
  // then continues to measure 2 (can run) before stopping; heavy side then measures 7
  const local = (i) => (i === 3 || i >= 5 ? 40 : 4);
  const f = fixture(8, local);
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, margin: 1, extraMax: 2 });
  assert.equal(r.boundary, 3);
  assert.ok(r.heavy.has(key(3)));
  assert.ok(r.light.has(key(4)), '4 measured and able to keep up: judged light by measurement');
  assert.ok(r.light.has(key(0)) && r.light.has(key(1)) && r.light.has(key(2)));
  for (const i of [5, 6, 7]) assert.ok(r.heavy.has(key(i)));
  for (const [k, v] of r.measured) assert.equal(r.heavy.has(k), v.ms > B, k);
  assert.deepEqual(f.calls, [key(4), key(6), key(5), key(3), key(2), key(7)], 'measurement order: binary search 3 times, cheaper side 2 times, heavy side 1 time');
});

test('BS-C06 cards with no cost record are treated as heavy and not measured; with no records at all, nothing is measured and all are judged heavy', async () => {
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

test('BS-C07 local reuse: measured results are stored by "card identity + local environment fingerprint", the next open measures nothing and the judgment is the same', async () => {
  const store = createMemoryCostStore();
  const f = fixture(50, (i) => (i < 20 ? 10 : 30));
  const first = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, store, envFingerprint: 'fp0123456789abcd' });
  assert.ok(first.measurements > 0);
  assert.equal(store.size(), first.measurements, 'store one entry per measurement');
  const rec = await store.getCost(localCostKey(key(first.trace[0].index), 'fp0123456789abcd'));
  assert.equal(rec.envFingerprint, 'fp0123456789abcd');
  assert.ok(localCostKey('abc', 'fp') === 'abc|fp');
  const again = fixture(50, () => { throw new Error('Should not measure again'); });
  const second = await boundarySearch({ keys: again.keys, records: again.records, budgetMs: B, measure: again.measure, store, envFingerprint: 'fp0123456789abcd' });
  assert.equal(second.measurements, 0, 'second open does not measure');
  assert.deepEqual([...second.heavy].sort(), [...first.heavy].sort());
  // Environment changed (different fingerprint): keys do not match, re-measurement required
  const other = fixture(50, (i) => (i < 20 ? 10 : 30));
  const third = await boundarySearch({ keys: other.keys, records: other.records, budgetMs: B, measure: other.measure, store, envFingerprint: 'ffffffffffffffff' });
  assert.ok(third.measurements > 0);
});

test('BS-C08 a failed measurement counts as unable to keep up and is not stored; COST_SCALE multiplies the measurement', async () => {
  const store = createMemoryCostStore();
  const f = fixture(4, (i) => (i === 1 ? null : 10));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure, store, margin: 1, extraMax: 0 });
  if (r.measured.has(key(1))) {
    assert.ok(r.heavy.has(key(1)));
    assert.equal(await store.getCost(localCostKey(key(1), '')), undefined, 'failed ones are not stored');
  }
  const g = fixture(4, () => 15);
  const scaled = await boundarySearch({ keys: g.keys, records: g.records, budgetMs: B, measure: g.measure, scale: 2 });
  assert.equal(scaled.light.size, 0, '15 × 2 = 30 > 23.3, all judged heavy');
});

test('BS-C09 new cards arriving after the search are not measured: judged by which side of the threshold the representative time falls on, measured ones by measurement, ones with no record count as heavy', async () => {
  const f = fixture(10, (i) => (i < 4 ? 5 : 50));
  const r = await boundarySearch({ keys: f.keys, records: f.records, budgetMs: B, measure: f.measure });
  const records = [...f.records, { identityKey: 'cheapNew', stepMs: 1.5 }, { identityKey: 'dearNew', stepMs: 9 }];
  const c = classifyWithBoundary(r, [...f.keys, 'cheapNew', 'dearNew', 'noRecord'], records);
  assert.ok(c.light.has('cheapNew'));
  assert.ok(c.heavy.has('dearNew'));
  assert.ok(c.heavy.has('noRecord'));
  for (let i = 0; i < 10; i++) assert.equal(c.heavy.has(key(i)), r.heavy.has(key(i)), key(i));
});

test('BS-C10 a card that appears multiple times in a project is judged only once; when representative durations are equal, order by identityKey (stable result)', async () => {
  const records = [{ identityKey: 'b', stepMs: 5 }, { identityKey: 'a', stepMs: 5 }, { identityKey: 'c', stepMs: 5 }];
  const calls = [];
  const measure = async (k) => { calls.push(k); return { stepMs: k === 'a' ? 5 : 50 }; };
  const r = await boundarySearch({ keys: ['a', 'b', 'a', 'c', 'b'], records, budgetMs: B, measure });
  assert.deepEqual(r.order.map((o) => o.key), ['a', 'b', 'c']);
  assert.ok(r.light.has('a') && r.heavy.has('b') && r.heavy.has('c'));
  assert.equal(new Set(calls).size, calls.length, 'a card is measured at most once');
});

test('BS-C11 cards with no record are measured one by one (measureUnrecorded, always supplied for online pages): those that run fine are judged light, those that can\'t keep up or can\'t be measured are judged heavy, and local reuse still hits', async () => {
  const store = createMemoryCostStore();
  const f = fixture(6, (i) => i + 1);
  const local = { newLight: 5, newHeavy: 40, newFail: null };
  const measure = async (k) => (k in local ? (local[k] === null ? null : { stepMs: local[k], samples: 16 }) : f.measure(k));
  const calls = [];
  const spy = async (k) => { calls.push(k); return measure(k); };
  const keys = [...f.keys, 'newLight', 'newHeavy', 'newFail'];
  const r = await boundarySearch({ keys, records: f.records, budgetMs: B, measure: spy, store, envFingerprint: 'fp', measureUnrecorded: true });
  assert.ok(r.light.has('newLight'), 'local 5 ms: judged light');
  assert.ok(r.heavy.has('newHeavy'), 'local 40 ms: judged heavy');
  assert.ok(r.heavy.has('newFail'), 'can\'t be measured: treated as can\'t keep up');
  for (const k of ['newLight', 'newHeavy', 'newFail']) assert.ok(calls.includes(k), `${k} was measured`);
  assert.deepEqual(r.unrecorded, ['newFail', 'newHeavy', 'newLight']);
  // No records at all: actually measure every card one by one
  const none = await boundarySearch({ keys: ['x', 'y'], records: [], budgetMs: B, measure: async (k) => ({ stepMs: k === 'x' ? 1 : 99, samples: 16 }), measureUnrecorded: true });
  assert.equal(none.measurements, 2);
  assert.deepEqual([...none.light], ['x']);
  assert.deepEqual([...none.heavy], ['y']);
  // Opened for the second time: local reuse hits, no more measurements
  const again = [];
  const r2 = await boundarySearch({ keys, records: f.records, budgetMs: B, measure: async (k) => { again.push(k); return measure(k); }, store, envFingerprint: 'fp', measureUnrecorded: true });
  assert.ok(!again.includes('newLight') && !again.includes('newHeavy'), 'measured results were saved');
  assert.ok(again.includes('newFail'), 'unmeasurable results are not saved, measure again next time');
  assert.ok(r2.light.has('newLight'));
});
