/**
 * C6.5 operation formats and diff algorithm (design doc `docs/plan/c65-design.md` Section 2; diff
 * calculation part of acceptance check V1 and V8).
 * Run: node --test server/test/c65-ops.test.mjs
 *
 * Written only against the design doc without looking at the implementation. The module under test
 * is dynamically loaded by `c65-kit.mjs` (assumptions A1, A2); each test case fails individually
 * when missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadJsonOps, loadDiffProject, rng, makeProject, mutateProject, fixedProject, clipOf, splitPath, makeClip,
} from './c65-kit.mjs';

const doc0 = () => ({
  name: 'p',
  fps: 30,
  style: { 'a/b': 1 },
  tracks: [
    { id: 't1', name: 'Track 1', clips: [{ id: 'c1', v: 1 }, { id: 'c2', v: 2 }, { id: 'c3', v: 3, frame: { x: 0 } }, { id: 'c4', v: 4 }] },
    { id: 't2', name: 'Track 2', clips: [] },
  ],
});
const ids = (arr) => arr.map((x) => x.id);

// ------------------------------------------------------------------ Four operations

test('C65-V1-01 set: set a value addressed by @id; missing parent objects on the path are created together', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 120 },
    { op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 7 }, // c2 has no frame: create together with frame
    { op: 'set', path: '/tracks/@t2/name', value: 'New name' },
    { op: 'set', path: '/meta2/deep/k', value: [1, 2] }, // Missing two levels at the top level
  ]);
  const t1 = out.tracks.find((t) => t.id === 't1');
  assert.equal(t1.clips.find((c) => c.id === 'c3').frame.x, 120);
  assert.deepEqual(t1.clips.find((c) => c.id === 'c2').frame, { x: 7 });
  assert.equal(out.tracks[1].name, 'New name');
  assert.deepEqual(out.meta2, { deep: { k: [1, 2] } });
  assert.deepEqual(ids(t1.clips), ['c1', 'c2', 'c3', 'c4'], 'order unchanged');
});

test('C65-V1-02 remove: delete an array element that has an id, delete an object key', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'remove', path: '/tracks/@t1/clips/@c3/frame' },
    { op: 'remove', path: '/fps' },
  ]);
  assert.deepEqual(ids(out.tracks[0].clips), ['c1', 'c3', 'c4']);
  assert.equal('frame' in out.tracks[0].clips[1], false);
  assert.equal('fps' in out, false);
});

test('C65-V1-03 insert: insert into an array that has ids, by index', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'insert', path: '/tracks/@t1/clips', index: 2, value: { id: 'c10', v: 10 } },
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c11', v: 11 } },
    { op: 'insert', path: '/tracks', index: 0, value: { id: 't0', name: 'Topmost', clips: [] } },
  ]);
  assert.deepEqual(ids(out.tracks), ['t0', 't1', 't2']);
  assert.deepEqual(ids(out.tracks[1].clips), ['c1', 'c2', 'c10', 'c3', 'c4']);
  assert.deepEqual(out.tracks[1].clips[2], { id: 'c10', v: 10 });
  assert.deepEqual(ids(out.tracks[2].clips), ['c11']);
});

test('C65-V1-04 move: reposition within the same array (index is the position after the move)', async () => {
  const { applyClone } = await loadJsonOps();
  const a = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t1/clips/@c3', index: 0 }]);
  assert.deepEqual(ids(a.tracks[0].clips), ['c3', 'c1', 'c2', 'c4']);
  const b = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 3 }]);
  assert.deepEqual(ids(b.tracks[0].clips), ['c2', 'c3', 'c4', 'c1'], 'moved to the end');
  const c = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t2', index: 0 }]);
  assert.deepEqual(ids(c.tracks), ['t2', 't1']);
  assert.deepEqual(c.tracks[1].clips.map((x) => x.v), [1, 2, 3, 4], 'the whole object is moved, content unchanged');
});

test('C65-V1-05 after someone else inserts or deletes in the same array, an operation addressed by @id still hits the right object', async () => {
  const { applyClone } = await loadJsonOps();
  const mine = [
    { op: 'set', path: '/tracks/@t1/clips/@c3/v', value: 333 },
    { op: 'remove', path: '/tracks/@t1/clips/@c4' },
    { op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 5 },
  ];
  const theirs = [
    { op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'cx', v: -1 } },
    { op: 'remove', path: '/tracks/@t1/clips/@c1' },
    { op: 'insert', path: '/tracks/@t1/clips', index: 3, value: { id: 'cy', v: -2 } },
    { op: 'move', path: '/tracks/@t1/clips/@c3', index: 0 },
  ];
  const afterTheirs = applyClone(doc0(), theirs);
  assert.deepEqual(ids(afterTheirs.tracks[0].clips), ['c3', 'cx', 'c2', 'cy', 'c4']);
  const out = applyClone(afterTheirs, mine);
  const clips = out.tracks[0].clips;
  assert.deepEqual(ids(clips), ['c3', 'cx', 'c2', 'cy']);
  assert.equal(clips.find((c) => c.id === 'c3').v, 333, 'c3 is the one changed, not whichever is third now');
  assert.deepEqual(clips.find((c) => c.id === 'c2').frame, { x: 5 });
  assert.equal(clips.find((c) => c.id === 'cx').v, -1, 'what someone else inserted is not hit by mistake');
  assert.equal(clips.find((c) => c.id === 'cy').v, -2);
});

test('C65-V1-06 whole-batch atomicity: if one fails midway, the whole batch has no effect (the original object is not modified), and the reason is bad-path', async () => {
  const { apply } = await loadJsonOps();
  const doc = doc0();
  const before = structuredClone(doc);
  const r = apply(doc, [
    { op: 'set', path: '/tracks/@t1/clips/@c1/v', value: 100 },
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'cz' } },
    { op: 'remove', path: '/tracks/@nope/clips/@c1' }, // Parent does not exist
    { op: 'set', path: '/name', value: 'should not take effect' },
  ]);
  assert.equal(r.ok, false, 'the whole batch should be rejected');
  assert.equal(r.reason, 'bad-path');
  assert.deepEqual(doc, before, 'on failure the document passed in is not changed anywhere (including the ones applied before the failure)');
});

test('C65-V1-07 root replacement: { op: set, path: "" } replaces the whole document', async () => {
  const { applyClone } = await loadJsonOps();
  const next = fixedProject({ clips: 2 });
  const out = applyClone(doc0(), [{ op: 'set', path: '', value: next }]);
  assert.deepEqual(out, next);
  const out2 = applyClone(doc0(), [
    { op: 'set', path: '', value: next },
    { op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 1 },
  ]);
  assert.equal(clipOf(out2, 'c2').frame.x, 1, 'after a root replacement, the operations in the same batch act on the new document');
});

test('C65-V1-08 bad-path: the path points to a parent that does not exist and the op is not set', async () => {
  const { apply } = await loadJsonOps();
  const cases = [
    [{ op: 'remove', path: '/tracks/@t9/clips/@c1' }, 'parent track @t9 does not exist'],
    [{ op: 'remove', path: '/nope/deep' }, 'parent object does not exist'],
    [{ op: 'insert', path: '/tracks/@t9/clips', index: 0, value: { id: 'q' } }, 'the parent of the array to insert into does not exist'],
    [{ op: 'insert', path: '/nope/list', index: 0, value: { id: 'q' } }, 'the array to insert into does not exist'],
    [{ op: 'move', path: '/tracks/@t9/clips/@c1', index: 0 }, 'the parent of move does not exist'],
    [{ op: 'move', path: '/tracks/@t1/clips/@c1/frame/x', index: 0 }, 'the parent of move (c1.frame) does not exist'],
  ];
  for (const [op, why] of cases) {
    const doc = doc0();
    const before = structuredClone(doc);
    const r = apply(doc, [op]);
    assert.equal(r.ok, false, `${why}: should be rejected ${JSON.stringify(op)}`);
    assert.equal(r.reason, 'bad-path', `${why}: reason should be bad-path, actual ${r.reason}`);
    assert.deepEqual(doc, before, `${why}: document unchanged`);
  }
});

test('C65-V1-09 an array without ids is treated as a single value and replaced whole with set', async () => {
  const { applyClone } = await loadJsonOps();
  const doc = doc0();
  doc.tracks[0].clips[0].keyframes = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  const out = applyClone(doc, [{ op: 'set', path: '/tracks/@t1/clips/@c1/keyframes', value: [{ t: 2, v: 9 }] }]);
  assert.deepEqual(out.tracks[0].clips[0].keyframes, [{ t: 2, v: 9 }]);
});

test('C65-V1-10 the path is a JSON pointer: / and ~ in keys are escaped as ~1 and ~0', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'set', path: '/style/a~1b', value: 2 },
    { op: 'set', path: '/style/x~0y', value: 'z' },
  ]);
  assert.deepEqual(out.style, { 'a/b': 2, 'x~y': 'z' });
  const out2 = applyClone(out, [{ op: 'remove', path: '/style/a~1b' }]);
  assert.deepEqual(out2.style, { 'x~y': 'z' });
});

// ------------------------------------------------------------------ diffProject

/** Fixed seed; design doc V1 requires 1000 random projects */
const SEED = 0xc65;
const N_PROPERTY = 1000;

test(`C65-V1-20 diffProject property test: ${N_PROPERTY} random projects, ops turn prev into next and inverse turns next back into prev (fixed seed)`, async () => {
  const diffProject = await loadDiffProject();
  const { applyClone } = await loadJsonOps();
  const r = rng(SEED);
  let prev = makeProject(r);
  let nonEmpty = 0;
  for (let i = 0; i < N_PROPERTY; i++) {
    // Half start from a new project, half continue editing on the previous next (chained, covering
    // "continuous editing")
    if (i % 2 === 0) prev = makeProject(r);
    const next = mutateProject(r, prev);
    const prevCopy = structuredClone(prev);
    const nextCopy = structuredClone(next);
    const { ops, inverse } = diffProject(prev, next);
    assert.deepEqual(prev, prevCopy, `#${i} diffProject does not modify prev`);
    assert.deepEqual(next, nextCopy, `#${i} diffProject does not modify next`);
    assert.ok(Array.isArray(ops) && Array.isArray(inverse), `#${i} returns the two arrays { ops, inverse }`);
    if (ops.length) nonEmpty += 1;
    const fwd = applyClone(prev, ops, `#${i} applying ops `);
    assert.deepEqual(fwd, next, `#${i} applying ops to prev should equal next`);
    const back = applyClone(next, inverse, `#${i} applying inverse `);
    assert.deepEqual(back, prev, `#${i} applying inverse to next should equal prev`);
    prev = next;
  }
  assert.ok(nonEmpty > N_PROPERTY * 0.9, `the vast majority of random changes produce non-empty ops: ${nonEmpty}/${N_PROPERTY}`);
});

test('C65-V1-21 diffProject determinism: the same input gives the same output; identical projects give an empty diff', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 1);
  for (let i = 0; i < 50; i++) {
    const prev = makeProject(r);
    const next = mutateProject(r, prev);
    assert.deepEqual(diffProject(prev, next), diffProject(structuredClone(prev), structuredClone(next)), `#${i} same input, same output`);
    const same = diffProject(prev, structuredClone(prev));
    assert.deepEqual(same.ops, [], `#${i} ops are empty when the content is identical`);
    assert.deepEqual(same.inverse, [], `#${i} inverse is empty when the content is identical`);
  }
});

test('C65-V1-22 diffProject addresses arrays with ids by @id, not by index; it uses only four operations', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 2);
  const ID_ARRAYS = new Set(['tracks', 'clips', 'media', 'filters', 'cuts']);
  for (let i = 0; i < 200; i++) {
    const prev = makeProject(r);
    const next = mutateProject(r, prev);
    const { ops, inverse } = diffProject(prev, next);
    for (const o of [...ops, ...inverse]) {
      assert.ok(['set', 'remove', 'insert', 'move'].includes(o.op), `only four operations: ${JSON.stringify(o)}`);
      const segs = splitPath(o.path);
      for (let k = 0; k + 1 < segs.length; k++) {
        if (ID_ARRAYS.has(segs[k]) && /^\d+$/.test(segs[k + 1])) {
          // Exception: when an array is replaced with values without id, set as a whole; paths like
          // /clips/3 will not appear
          assert.fail(`arrays with ids are not addressed by index: ${o.path}`);
        }
      }
      if (o.op === 'insert' || o.op === 'move') assert.ok(Number.isInteger(o.index) && o.index >= 0, `insert / move carry a non-negative integer index: ${JSON.stringify(o)}`);
    }
  }
});

test('C65-V1-23 moving a clip within a track → only move, not delete then insert (or a whole-array set)', async () => {
  const diffProject = await loadDiffProject();
  const prev = fixedProject({ clips: 4 });
  const next = structuredClone(prev);
  const [c] = next.tracks[0].clips.splice(3, 1);
  next.tracks[0].clips.unshift(c);
  const { ops, inverse } = diffProject(prev, next);
  assert.ok(ops.length >= 1, 'has operations');
  for (const o of [...ops, ...inverse]) {
    assert.equal(o.op, 'move', `repositioning uses only move: ${JSON.stringify(o)}`);
    assert.match(o.path, /^\/tracks\/@t1\/clips\/@c\d$/);
  }
  // Design doc does not require a minimum count; when one is enough, note in report rather than fail
  if (ops.length !== 1) console.log(`[C65-V1-23] moving one clip produced ${ops.length} move ops`);
});

test('C65-V1-24 changing one number of one clip → a single set addressed by @id', async () => {
  const diffProject = await loadDiffProject();
  const prev = fixedProject({ clips: 4 });
  const next = structuredClone(prev);
  next.tracks[0].clips[2].frame.x = 999;
  const { ops, inverse } = diffProject(prev, next);
  assert.deepEqual(ops, [{ op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 999 }]);
  assert.deepEqual(inverse, [{ op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 30 }]);
});

// ------------------------------------------------------------------ V8 diff calculation

/**
 * Batched medians: runs times per batch, at most 8 batches, 100 ms batch interval (spread over
 * about 1 s); stops as soon as any batch median is ≤ limitMs.
 * When the machine is busy (several npm test runs in parallel), a batch may be slowed down as a
 * whole; the criterion (any batch median ≤ 5 ms) remains unchanged, the first batch is the
 * original batch, and if code truly regresses, every batch exceeds it and is still caught.
 * Same approach as timeIt in src/kernel/diffProject.test.mjs.
 */
async function bestBatchMedian(fn, runs, limitMs) {
  const batches = [];
  for (let b = 0; b < 8 && !(batches.length && Math.min(...batches.map((x) => x.median)) <= limitMs); b++) {
    if (b > 0) await new Promise((r) => setTimeout(r, 100));
    const xs = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      xs.push(performance.now() - t0);
    }
    xs.sort((a, c) => a - c);
    batches.push({ median: xs[Math.floor(xs.length / 2)], all: xs });
  }
  return { best: batches.reduce((a, c) => (c.median < a.median ? c : a)), n: batches.length };
}

test('C65-V8-01 diff computation for a single commit ≤ 5 ms (a project of 1000 clips, one clip changed)', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 8);
  const prev = makeProject(r, { tracks: 10, clipsPerTrack: 100 });
  const total = prev.tracks.reduce((n, t) => n + t.clips.length, 0);
  assert.equal(total, 1000);
  // In the editor, setProject's next and prev share untouched parts (structural sharing);
  // constructed the same way here
  const next = { ...prev, tracks: prev.tracks.map((t, i) => (i === 5 ? { ...t, clips: t.clips.map((c, j) => (j === 50 ? { ...c, start: c.start + 1 } : c)) } : t)) };
  for (let i = 0; i < 20; i++) diffProject(prev, next); // Warm-up
  const a = await bestBatchMedian(() => diffProject(prev, next), 50, 5);
  assert.ok(a.best.median <= 5, `measured ${a.n} batches, the best batch's median ${a.best.median.toFixed(2)} ms should be ≤ 5 ms (all of that batch: ${a.best.all.map((x) => x.toFixed(2)).join(', ')})`);

  // Must stay within limit even without structural sharing (deep clone whole object then edit one
  // place): certain page actions rebuild the whole document
  const deep = structuredClone(prev);
  deep.tracks[5].clips[50] = makeClip(r, deep.tracks[5].clips[50].id);
  const b = await bestBatchMedian(() => diffProject(prev, deep), 20, 5);
  assert.ok(b.best.median <= 5, `without structural sharing, measured ${b.n} batches, the best batch's median ${b.best.median.toFixed(2)} ms should be ≤ 5 ms`);
});
