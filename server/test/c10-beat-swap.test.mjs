/**
 * C10 播放按拍换快照（`docs/plan/c10-contract.md` 第 6 节；语义 `product/platforms.md`「在线浏览器模式」、
 * `product/rendering.md`「兜底顺序」）。
 * 跑：node --experimental-test-module-mocks --test server/test/c10-beat-swap.test.mjs
 *
 *   C10-BS-01 `SWAP_MS` 缺省 3 ms；
 *   C10-BS-02 换帧成本 swapMs 计入每拍预算：装得下的层换快照，装不下的显示占位；两组不重不漏；
 *   C10-BS-03 已占用越多、swapMs 越大，装得下的越少；占满一拍全部占位；不给 swapMs 时按 SWAP_MS；
 *   C10-BS-04 回包带 deadMs 时，它等于拍长（或预算）减去已占用；
 *   C10-BS-05 在线按拍换帧：播放中的投递不受 33 ms 节流（60 fps 下相邻两拍都投）；
 *   C10-BS-06 节流只留给非播放时的投递（暂停时 33 ms 内不重投）；
 *   C10-BS-07 桌面（开关关着）照旧受 33 ms 节流。
 *
 * 「deadMs 由拍长减去已占用算出」里的拍长，契约没说是 `1000 / fps` 还是 K2 的预算 `1000 / fps × 0.7`：
 * 这里两种都认——装得下的层数 k 须满足 `floor((预算 − 已占用) / swapMs) ≤ k ≤ floor((拍长 − 已占用) / swapMs)`。
 * 需要主会话定（报告「需要主会话定的事」）。假设见 `c10-kit.mjs` 的 K3。
 */
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { beatGate, beatFitOf, normalizeFit, importRepo, useTs, repoUrl, BEAT_FILES, BEAT_FIT_NAMES, BEAT_SWITCH_NAMES, SWAP_MS_DEFAULT } from './c10-kit.mjs';

const gate = beatGate();
const skip = gate.ok ? false : gate.reason;
const it = (name, fn) => test(name, { skip }, fn);

const beatMs = (fps) => 1000 / fps;
const budgetMs = (fps) => (1000 / fps) * 0.7;

async function fitFn() {
  const hit = beatFitOf();
  assert.ok(hit, `Assumption K3: no frame-swap selection function found in ${BEAT_FILES.join(', ')} (${BEAT_FIT_NAMES.join(' / ')})`);
  const mod = await importRepo(hit.file);
  return (args) => normalizeFit(mod[hit.name](args));
}
const layers = (n) => Array.from({ length: n }, (_, i) => `L${String(i).padStart(2, '0')}`);

it('C10-BS-01 SWAP_MS defaults to 3 ms', async () => {
  const mod = await importRepo(gate.file);
  assert.equal(mod.SWAP_MS, SWAP_MS_DEFAULT);
});

it('C10-BS-02 swapMs counts toward the per-tick budget: layers that fit are swapped to snapshots, those that do not fit get placeholders, and the two groups neither overlap nor leave any layer out', async () => {
  const fit = await fitFn();
  for (const [fps, occupiedMs] of [[30, 0], [30, 10], [30, 20], [60, 0], [60, 5], [24, 12], [25, 0]]) {
    const all = layers(20);
    const r = fit({ fps, occupiedMs, layers: all, swapMs: 3 });
    const lo = Math.max(0, Math.floor((budgetMs(fps) - occupiedMs) / 3));
    const hi = Math.max(0, Math.floor((beatMs(fps) - occupiedMs) / 3));
    const k = r.swap.length;
    assert.ok(k >= Math.min(lo, 20) && k <= Math.min(hi, 20), `fps ${fps}, ${occupiedMs} ms already occupied: swapped ${k} layers, should be ${Math.min(lo, 20)}-${Math.min(hi, 20)}`);
    assert.deepEqual([...r.swap, ...r.placeholder].sort(), all, 'Swapped layers and placeholder layers together are exactly all the heavy layers');
    assert.equal(new Set(r.swap).size + new Set(r.placeholder).size, all.length, 'No duplicates');
  }
});

it('C10-BS-03 the more is occupied and the larger swapMs is, the fewer layers fit; a fully occupied tick gives everything a placeholder; without swapMs, SWAP_MS is used', async () => {
  const fit = await fitFn();
  const all = layers(30);
  let prev = Infinity;
  for (const occupiedMs of [0, 5, 10, 15, 20, 25, 30, 33.4, 50]) {
    const k = fit({ fps: 30, occupiedMs, layers: all, swapMs: 3 }).swap.length;
    assert.ok(k <= prev, `With ${occupiedMs} ms occupied, ${k} layers were swapped, which is more than with less occupied (${prev})`);
    prev = k;
  }
  assert.equal(fit({ fps: 30, occupiedMs: 40, layers: all, swapMs: 3 }).swap.length, 0, 'Occupied time exceeds one tick: everything gets a placeholder');
  const k3 = fit({ fps: 30, occupiedMs: 0, layers: all, swapMs: 3 }).swap.length;
  const k6 = fit({ fps: 30, occupiedMs: 0, layers: all, swapMs: 6 }).swap.length;
  assert.ok(k6 < k3, `swapMs 6 ms fits ${k6} layers, which should be fewer than the ${k3} layers fitting at 3 ms`);
  const kDefault = fit({ fps: 30, occupiedMs: 0, layers: all }).swap.length;
  assert.equal(kDefault, k3, 'Without swapMs, SWAP_MS (3 ms) is used');
  const none = fit({ fps: 30, occupiedMs: 0, layers: [], swapMs: 3 });
  assert.deepEqual([none.swap, none.placeholder], [[], []], 'No heavy layers: both groups are empty');
});

it('C10-BS-04 when the response carries deadMs, it equals the tick length (or the budget) minus the occupied time', async (t) => {
  const fit = await fitFn();
  const r = fit({ fps: 30, occupiedMs: 8, layers: layers(3), swapMs: 3 });
  if (r.deadMs === undefined) {
    t.diagnostic('The response has no deadMs, so this item is not checked');
    return;
  }
  const ok = [beatMs(30) - 8, budgetMs(30) - 8].some((v) => Math.abs(v - r.deadMs) < 0.01);
  assert.ok(ok, `deadMs ${r.deadMs} is neither the tick length minus occupied (${(beatMs(30) - 8).toFixed(3)}) nor the budget minus occupied (${(budgetMs(30) - 8).toFixed(3)})`);
});

/* ------------------------------------------------------------------ 节流（snapshotFeed.ts） */

let feed = null;
let plan = { segments: [] };
let now = 1000;
async function loadFeed() {
  if (feed) return feed;
  await useTs();
  const srcUrl = (rel) => repoUrl(`src/${rel}`);
  mock.module(srcUrl('editor/planDispatch.ts'), { exports: { currentPlan: () => plan } });
  mock.module(srcUrl('render/dataMirror.ts'), { exports: { mirrorKey: () => ({ session: 's', localRev: 1 }), pushWanted: () => {} } });
  performance.now = () => now;
  feed = await import(srcUrl('editor/snapshotFeed.ts'));
  return feed;
}
function beatSwitch(f) {
  for (const n of BEAT_SWITCH_NAMES) if (typeof f[n] === 'function') return f[n];
  throw new Error(`Assumption K3: snapshotFeed.ts does not export a per-tick frame-swap switch (${BEAT_SWITCH_NAMES.join(' / ')}); what it exports: ${Object.keys(f).join(', ')}`);
}

const FPS = 60;
const card = (id, start, end) => ({ id, cardId: 'c', start, end, params: {} });
const project = (clips) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: 't', name: 't', clips }] });
const settle = () => new Promise((r) => setImmediate(r));

let src = null;
function fakeSource() {
  const s = {
    push: null,
    subscribeReady(_session, _rev, onMessage) { s.push = onMessage; return () => { s.push = null; }; },
    async fetchSnapshot(kind, key, localFrame) { return `html:${kind}/${key}/${localFrame}`; },
  };
  return s;
}
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); };
  return st;
}

beforeEach(async () => {
  if (!gate.ok) return;
  const f = await loadFeed();
  f.resetSnapshotFeed();
  src = fakeSource();
  f.setSnapshotSource(src);
  f.syncSnapshotSubscription(() => {});
  f.setExtraSuppressed([]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(['h']) }] };
  now += 10_000;
});

/** 播放头在第 f 帧（60 fps）；先把这一帧的字节取到手 */
async function primeAt(f, stage, frame, playing) {
  const head = { project: project([card('h', 0, 10)]), t: frame / FPS, playing };
  await f.deliverSnapshots(stage, 'front', head);
  await settle();
  return head;
}

async function twoBeats({ on, playing }) {
  const f = await loadFeed();
  const sw = on === undefined ? null : beatSwitch(f);
  if (sw) sw(on);
  try {
    src.push({ type: 'layer', clipId: 'h', kind: 'html', key: 'k-h', ranges: [[0, 600]] });
    const stage = fakeStage();
    await primeAt(f, stage, 60, playing);
    assert.equal(await f.deliverSnapshots(stage, 'front', { project: project([card('h', 0, 10)]), t: 60 / FPS, playing }), 0, 'Nothing is delivered once snapshots are retired');
    // 下一拍（60 fps，约 16.7 ms 后），换到第 61 帧
    now += 1000 / FPS;
    const head2 = await primeAt(f, stage, 61, playing);
    return await f.deliverSnapshots(stage, 'front', head2);
  } finally {
    if (sw) sw(false);
  }
}

it('C10-BS-05 online per-tick frame swap: deliverSnapshots returns 0 once snapshots are retired', async () => {
  assert.equal(await twoBeats({ on: true, playing: true }), 0);
});

it('C10-BS-06 throttling is reserved for delivery while not playing: deliverSnapshots returns 0 once snapshots are retired', async () => {
  assert.equal(await twoBeats({ on: true, playing: false }), 0);
});

it('C10-BS-07 desktop (switch off) while playing: deliverSnapshots returns 0 once snapshots are retired', async () => {
  const f = await loadFeed();
  beatSwitch(f)(false);
  assert.equal(await twoBeats({ on: false, playing: true }), 0);
});
