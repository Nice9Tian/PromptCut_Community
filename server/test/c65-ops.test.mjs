/**
 * C6.5 操作格式与差异算法（设计稿 `docs/plan/c65-design.md` 第 2 节；验收 V1、V8 的差异计算部分）。
 * 跑：node --test server/test/c65-ops.test.mjs
 *
 * 只照设计稿写，不看实现。被测模块由 `c65-kit.mjs` 动态载入（假设 A1、A2），缺失时每条用例各自失败。
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
    { id: 't1', name: '序列 1', clips: [{ id: 'c1', v: 1 }, { id: 'c2', v: 2 }, { id: 'c3', v: 3, frame: { x: 0 } }, { id: 'c4', v: 4 }] },
    { id: 't2', name: '序列 2', clips: [] },
  ],
});
const ids = (arr) => arr.map((x) => x.id);

// ------------------------------------------------------------------ 四种操作

test('C65-V1-01 set：按 @id 寻址设值；路径缺的父级对象一起建', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 120 },
    { op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 7 }, // c2 没有 frame：连同 frame 一起建
    { op: 'set', path: '/tracks/@t2/name', value: '新名字' },
    { op: 'set', path: '/meta2/deep/k', value: [1, 2] }, // 顶层缺两级
  ]);
  const t1 = out.tracks.find((t) => t.id === 't1');
  assert.equal(t1.clips.find((c) => c.id === 'c3').frame.x, 120);
  assert.deepEqual(t1.clips.find((c) => c.id === 'c2').frame, { x: 7 });
  assert.equal(out.tracks[1].name, '新名字');
  assert.deepEqual(out.meta2, { deep: { k: [1, 2] } });
  assert.deepEqual(ids(t1.clips), ['c1', 'c2', 'c3', 'c4'], '顺序不变');
});

test('C65-V1-02 remove：删带 id 的数组元素、删对象的键', async () => {
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

test('C65-V1-03 insert：往带 id 的数组按下标插', async () => {
  const { applyClone } = await loadJsonOps();
  const out = applyClone(doc0(), [
    { op: 'insert', path: '/tracks/@t1/clips', index: 2, value: { id: 'c10', v: 10 } },
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c11', v: 11 } },
    { op: 'insert', path: '/tracks', index: 0, value: { id: 't0', name: '最上', clips: [] } },
  ]);
  assert.deepEqual(ids(out.tracks), ['t0', 't1', 't2']);
  assert.deepEqual(ids(out.tracks[1].clips), ['c1', 'c2', 'c10', 'c3', 'c4']);
  assert.deepEqual(out.tracks[1].clips[2], { id: 'c10', v: 10 });
  assert.deepEqual(ids(out.tracks[2].clips), ['c11']);
});

test('C65-V1-04 move：同一数组里挪位置（index 是挪完后的位置）', async () => {
  const { applyClone } = await loadJsonOps();
  const a = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t1/clips/@c3', index: 0 }]);
  assert.deepEqual(ids(a.tracks[0].clips), ['c3', 'c1', 'c2', 'c4']);
  const b = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 3 }]);
  assert.deepEqual(ids(b.tracks[0].clips), ['c2', 'c3', 'c4', 'c1'], '挪到最后');
  const c = applyClone(doc0(), [{ op: 'move', path: '/tracks/@t2', index: 0 }]);
  assert.deepEqual(ids(c.tracks), ['t2', 't1']);
  assert.deepEqual(c.tracks[1].clips.map((x) => x.v), [1, 2, 3, 4], '挪的是整个对象，内容不变');
});

test('C65-V1-05 别人在同一数组里插删之后，按 @id 的操作仍打中正确的对象', async () => {
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
  assert.equal(clips.find((c) => c.id === 'c3').v, 333, 'c3 被改，而不是现在排第 3 的那个');
  assert.deepEqual(clips.find((c) => c.id === 'c2').frame, { x: 5 });
  assert.equal(clips.find((c) => c.id === 'cx').v, -1, '别人插的不被误伤');
  assert.equal(clips.find((c) => c.id === 'cy').v, -2);
});

test('C65-V1-06 整批原子：中途一条失败，整批不生效（原对象不被改），原因是 bad-path', async () => {
  const { apply } = await loadJsonOps();
  const doc = doc0();
  const before = structuredClone(doc);
  const r = apply(doc, [
    { op: 'set', path: '/tracks/@t1/clips/@c1/v', value: 100 },
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'cz' } },
    { op: 'remove', path: '/tracks/@nope/clips/@c1' }, // 父级不存在
    { op: 'set', path: '/name', value: '不该生效' },
  ]);
  assert.equal(r.ok, false, '整批应被拒绝');
  assert.equal(r.reason, 'bad-path');
  assert.deepEqual(doc, before, '失败时传入的文档一处都没变（包括失败前已应用的几条）');
});

test('C65-V1-07 根替换：{ op: set, path: "" } 换掉整个文档', async () => {
  const { applyClone } = await loadJsonOps();
  const next = fixedProject({ clips: 2 });
  const out = applyClone(doc0(), [{ op: 'set', path: '', value: next }]);
  assert.deepEqual(out, next);
  const out2 = applyClone(doc0(), [
    { op: 'set', path: '', value: next },
    { op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 1 },
  ]);
  assert.equal(clipOf(out2, 'c2').frame.x, 1, '根替换之后同一批里的操作作用在新文档上');
});

test('C65-V1-08 bad-path：路径指向不存在的父级且不是 set', async () => {
  const { apply } = await loadJsonOps();
  const cases = [
    [{ op: 'remove', path: '/tracks/@t9/clips/@c1' }, '父级序列 @t9 不存在'],
    [{ op: 'remove', path: '/nope/deep' }, '父级对象不存在'],
    [{ op: 'insert', path: '/tracks/@t9/clips', index: 0, value: { id: 'q' } }, '要插入的数组的父级不存在'],
    [{ op: 'insert', path: '/nope/list', index: 0, value: { id: 'q' } }, '要插入的数组不存在'],
    [{ op: 'move', path: '/tracks/@t9/clips/@c1', index: 0 }, 'move 的父级不存在'],
    [{ op: 'move', path: '/tracks/@t1/clips/@c1/frame/x', index: 0 }, 'move 的父级（c1.frame）不存在'],
  ];
  for (const [op, why] of cases) {
    const doc = doc0();
    const before = structuredClone(doc);
    const r = apply(doc, [op]);
    assert.equal(r.ok, false, `${why}：应被拒绝 ${JSON.stringify(op)}`);
    assert.equal(r.reason, 'bad-path', `${why}：原因应为 bad-path，实际 ${r.reason}`);
    assert.deepEqual(doc, before, `${why}：文档不变`);
  }
});

test('C65-V1-09 没有 id 的数组整体当一个值，用 set 整个替换', async () => {
  const { applyClone } = await loadJsonOps();
  const doc = doc0();
  doc.tracks[0].clips[0].keyframes = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  const out = applyClone(doc, [{ op: 'set', path: '/tracks/@t1/clips/@c1/keyframes', value: [{ t: 2, v: 9 }] }]);
  assert.deepEqual(out.tracks[0].clips[0].keyframes, [{ t: 2, v: 9 }]);
});

test('C65-V1-10 路径是 JSON 指针：键里的 / 与 ~ 按 ~1、~0 转义', async () => {
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

/** 固定种子；设计稿 V1 要求 1000 个随机项目 */
const SEED = 0xc65;
const N_PROPERTY = 1000;

test(`C65-V1-20 diffProject 性质测试：${N_PROPERTY} 个随机项目，ops 把 prev 变成 next、inverse 把 next 变回 prev（固定种子）`, async () => {
  const diffProject = await loadDiffProject();
  const { applyClone } = await loadJsonOps();
  const r = rng(SEED);
  let prev = makeProject(r);
  let nonEmpty = 0;
  for (let i = 0; i < N_PROPERTY; i++) {
    // 一半从新项目起，一半在上一个 next 上接着改（链式，覆盖「连续编辑」）
    if (i % 2 === 0) prev = makeProject(r);
    const next = mutateProject(r, prev);
    const prevCopy = structuredClone(prev);
    const nextCopy = structuredClone(next);
    const { ops, inverse } = diffProject(prev, next);
    assert.deepEqual(prev, prevCopy, `#${i} diffProject 不改 prev`);
    assert.deepEqual(next, nextCopy, `#${i} diffProject 不改 next`);
    assert.ok(Array.isArray(ops) && Array.isArray(inverse), `#${i} 返回 { ops, inverse } 两个数组`);
    if (ops.length) nonEmpty += 1;
    const fwd = applyClone(prev, ops, `#${i} 应用 ops `);
    assert.deepEqual(fwd, next, `#${i} ops 应用到 prev 应等于 next`);
    const back = applyClone(next, inverse, `#${i} 应用 inverse `);
    assert.deepEqual(back, prev, `#${i} inverse 应用到 next 应等于 prev`);
    prev = next;
  }
  assert.ok(nonEmpty > N_PROPERTY * 0.9, `绝大多数随机改动产生非空 ops：${nonEmpty}/${N_PROPERTY}`);
});

test('C65-V1-21 diffProject 确定性：同样的输入同样的输出；相同项目差异为空', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 1);
  for (let i = 0; i < 50; i++) {
    const prev = makeProject(r);
    const next = mutateProject(r, prev);
    assert.deepEqual(diffProject(prev, next), diffProject(structuredClone(prev), structuredClone(next)), `#${i} 同输入同输出`);
    const same = diffProject(prev, structuredClone(prev));
    assert.deepEqual(same.ops, [], `#${i} 内容相同时 ops 为空`);
    assert.deepEqual(same.inverse, [], `#${i} 内容相同时 inverse 为空`);
  }
});

test('C65-V1-22 diffProject 对带 id 的数组按 @id 寻址，不用下标；只用四种操作', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 2);
  const ID_ARRAYS = new Set(['tracks', 'clips', 'media', 'filters', 'cuts']);
  for (let i = 0; i < 200; i++) {
    const prev = makeProject(r);
    const next = mutateProject(r, prev);
    const { ops, inverse } = diffProject(prev, next);
    for (const o of [...ops, ...inverse]) {
      assert.ok(['set', 'remove', 'insert', 'move'].includes(o.op), `只有四种操作：${JSON.stringify(o)}`);
      const segs = splitPath(o.path);
      for (let k = 0; k + 1 < segs.length; k++) {
        if (ID_ARRAYS.has(segs[k]) && /^\d+$/.test(segs[k + 1])) {
          // 例外：数组被换成了没有 id 的值时整体 set，不会出现 /clips/3 这种路径
          assert.fail(`带 id 的数组不按下标寻址：${o.path}`);
        }
      }
      if (o.op === 'insert' || o.op === 'move') assert.ok(Number.isInteger(o.index) && o.index >= 0, `insert / move 带非负整数 index：${JSON.stringify(o)}`);
    }
  }
});

test('C65-V1-23 片段在序列内挪位置 → 只有 move，而不是删了再插（或整数组 set）', async () => {
  const diffProject = await loadDiffProject();
  const prev = fixedProject({ clips: 4 });
  const next = structuredClone(prev);
  const [c] = next.tracks[0].clips.splice(3, 1);
  next.tracks[0].clips.unshift(c);
  const { ops, inverse } = diffProject(prev, next);
  assert.ok(ops.length >= 1, '有操作');
  for (const o of [...ops, ...inverse]) {
    assert.equal(o.op, 'move', `挪位置只用 move：${JSON.stringify(o)}`);
    assert.match(o.path, /^\/tracks\/@t1\/clips\/@c\d$/);
  }
  // 设计稿没要求最少条数；一条就够时，报告里记一笔而不是判失败
  if (ops.length !== 1) console.log(`[C65-V1-23] 挪一个片段产生了 ${ops.length} 条 move`);
});

test('C65-V1-24 改一个片段的一个数 → 一条按 @id 寻址的 set', async () => {
  const diffProject = await loadDiffProject();
  const prev = fixedProject({ clips: 4 });
  const next = structuredClone(prev);
  next.tracks[0].clips[2].frame.x = 999;
  const { ops, inverse } = diffProject(prev, next);
  assert.deepEqual(ops, [{ op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 999 }]);
  assert.deepEqual(inverse, [{ op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 30 }]);
});

// ------------------------------------------------------------------ V8 差异计算

/**
 * 分批量中位数：每批 runs 次，最多 8 批、批间隔 100 ms（摊开在约 1 s 里），任一批中位数 ≤ limitMs 即停。
 * 机器忙（几份 npm test 并行）时某一批可能整体被拖慢；判据（某批中位数 ≤ 5 ms）不变，第一批就是原来那一批，
 * 代码真退化时每一批都超，照样拦得住。做法同 src/kernel/diffProject.test.mjs 的 timeIt。
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

test('C65-V8-01 单次提交的差异计算 ≤ 5 ms（1000 个片段的项目，改一个片段）', async () => {
  const diffProject = await loadDiffProject();
  const r = rng(SEED + 8);
  const prev = makeProject(r, { tracks: 10, clipsPerTrack: 100 });
  const total = prev.tracks.reduce((n, t) => n + t.clips.length, 0);
  assert.equal(total, 1000);
  // 编辑器里 setProject 的 next 与 prev 共享没改的部分（结构共享）；这里照样造
  const next = { ...prev, tracks: prev.tracks.map((t, i) => (i === 5 ? { ...t, clips: t.clips.map((c, j) => (j === 50 ? { ...c, start: c.start + 1 } : c)) } : t)) };
  for (let i = 0; i < 20; i++) diffProject(prev, next); // 预热
  const a = await bestBatchMedian(() => diffProject(prev, next), 50, 5);
  assert.ok(a.best.median <= 5, `量了 ${a.n} 批，最好的一批中位数 ${a.best.median.toFixed(2)} ms 应 ≤ 5 ms（该批全部：${a.best.all.map((x) => x.toFixed(2)).join(', ')}）`);

  // 没有结构共享（整份深拷贝后改一处）也要在上限内：页面的某些 action 会整份重建
  const deep = structuredClone(prev);
  deep.tracks[5].clips[50] = makeClip(r, deep.tracks[5].clips[50].id);
  const b = await bestBatchMedian(() => diffProject(prev, deep), 20, 5);
  assert.ok(b.best.median <= 5, `无结构共享时量了 ${b.n} 批，最好的一批中位数 ${b.best.median.toFixed(2)} ms 应 ≤ 5 ms`);
});
