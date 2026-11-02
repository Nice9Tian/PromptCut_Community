/**
 * 舞台时钟推帧的单测。跑:npm test -- src/render/stageClock.test.mjs
 *
 * 钉死「每一步的时刻用帧号直接算,不逐帧累加」(渲染重构「推帧一致性」,根因见 `docs/reports/AGENT-rr-a1-verify.md`「原因二」):
 *   - 从头推到第 N 帧,每一步的时刻和调用方直接算的 `帧号 / fps * 1000` 逐位相同(30 帧/秒的第 60 帧是 2000,不是 1999.9999999999982);
 *   - 一帧一帧接着推,每帧正好跑一拍(累加时 600 帧里有一百多帧要补一拍);
 *   - 起点、终点不在帧格上时,第一步走到下一个帧格,最后一步走到终点本身;
 *   - 同步的 `advanceTo` 和让出的 `advanceToAsync` 走的是同一串时刻。
 *
 * 没有浏览器:`window`、`performance`、`Element` 用最小假件,只装时钟要碰的那几样。
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// 时钟安装时要接管的东西:都给假的,真的那份留给测试框架自己用
const realSetTimeout = globalThis.setTimeout;
globalThis.window = {
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: (...a) => realSetTimeout(...a),
  setInterval: (...a) => globalThis.setInterval(...a),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  clearInterval: (id) => globalThis.clearInterval(id),
};
Object.defineProperty(globalThis, "performance", { value: { now: () => 0 }, configurable: true, writable: true });
globalThis.Element = class Element { animate() { return { pause() {}, currentTime: 0 }; } };

const { installStageClock, frameGrid } = await import("./stageClock.ts");
const clock = installStageClock();

/** 调用方算一帧时刻的式子(`bakeFrame`、节拍循环、导出页都是它) */
const frameMs = (n, fps) => (n / fps) * 1000;
/** 把时钟拨回 0(倒退是跳转),并清掉这一下带出来的那一拍 */
const rewind = () => { clock.advanceTo(0); };

test("accumulation does drift (this test checks the premise): adding 1000/30 frame by frame, frame 60 is not 2000", () => {
  let ms = 0;
  for (let k = 0; k < 60; k++) ms += 1000 / 30;
  assert.notEqual(ms, 2000);
  assert.equal(frameMs(60, 30), 2000);
});

for (const fps of [24, 25, 30, 60]) {
  test(`${fps} fps: advancing from the start for 20 seconds, the time at every step equals frame number / fps * 1000`, () => {
    rewind();
    const got = [];
    clock.advanceTo(frameMs(20 * fps, fps), { step: 1000 / fps, maxCatchUp: Infinity, onFrame: (ms) => got.push(ms) });
    assert.equal(got.length, 20 * fps);
    for (let k = 1; k <= 20 * fps; k++) assert.equal(got[k - 1], frameMs(k, fps), `Frame ${k}`);
    assert.equal(clock.now(), frameMs(20 * fps, fps));
  });

  test(`${fps} fps: advancing frame by frame continuously, each frame is exactly one tick and lands on the same time`, () => {
    rewind();
    for (let n = 1; n <= 20 * fps; n++) {
      const got = [];
      clock.advanceTo(frameMs(n, fps), { step: 1000 / fps, onFrame: (ms) => got.push(ms) });
      assert.deepEqual(got, [frameMs(n, fps)], `Frame ${n}`);
    }
  });
}

test("sampling every few frames (continued advance): no intermediate frame is skipped, times match advancing from the start", () => {
  rewind();
  const fps = 30;
  const got = [];
  for (const n of [15, 30, 45, 60, 150]) clock.advanceTo(frameMs(n, fps), { step: 1000 / fps, maxCatchUp: Infinity, onFrame: (ms) => got.push(ms) });
  assert.equal(got.length, 150);
  got.forEach((ms, i) => assert.equal(ms, frameMs(i + 1, fps)));
});

test("start off the frame grid: first step goes to the next grid point; end off the frame grid: last step goes to the end itself", () => {
  rewind();
  const step = 1000 / 30;
  clock.set(10);
  const got = [];
  clock.advanceTo(100, { step, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [frameMs(1, 30), frameMs(2, 30), 100]);
  // 终点差一点到下一个帧格:不为它多走一格
  const more = [];
  clock.advanceTo(140, { step, onFrame: (ms) => more.push(ms) });
  assert.deepEqual(more, [frameMs(4, 30), 140]);
});

test("start off by only a floating-point remainder (old accumulated value): counted on that frame, no extra tick", () => {
  rewind();
  clock.set(1999.9999999999982);
  const got = [];
  clock.advanceTo(frameMs(61, 30), { step: 1000 / 30, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [frameMs(61, 30)]);
});

test("target off the frame grid by only a floating-point remainder: go straight to the target itself, one tick", () => {
  rewind();
  const got = [];
  clock.advanceTo(33.33333333333334, { step: 1000 / 30, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [33.33333333333334]);
});

test("after the catch-up limit trims the start, the remaining steps still land on the frame grid", () => {
  rewind();
  const got = [];
  clock.advanceTo(10_000, { step: 1000 / 30, maxCatchUp: 6000, onFrame: (ms) => got.push(ms) });
  // 起点被拨到 4000(正好是第 120 帧),之后是第 121～300 帧
  assert.equal(got.length, 180);
  assert.equal(got[0], frameMs(121, 30));
  assert.equal(got.at(-1), 10_000);
});

test("step with unrecognized frame rate: advance by frame number * step, still without accumulating; if fps is given, follow fps", () => {
  rewind();
  const got = [];
  clock.advanceTo(35, { step: 7, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [7, 14, 21, 28, 35]);
  rewind();
  const fps = 29.97;
  const exact = [];
  clock.advanceTo(frameMs(90, fps), { step: 1000 / fps, fps, maxCatchUp: Infinity, onFrame: (ms) => exact.push(ms) });
  assert.equal(exact.length, 90);
  exact.forEach((ms, i) => assert.equal(ms, frameMs(i + 1, fps)));
});

test("frameGrid: not used when the given frame rate does not match the step", () => {
  const grid = frameGrid(1000 / 30, 25);
  assert.equal(grid.at(60), 2000, "30 fps recognized from the step");
  assert.equal(frameGrid(40, 30).at(3), 120, "25 fps recognized from the step");
  assert.equal(grid.after(0), 1);
  assert.equal(grid.after(frameMs(60, 30)), 61);
  assert.equal(grid.reaches(60, 2000), true);
  assert.equal(grid.reaches(59, 2000), false);
});

test("advanceToAsync: walks the same sequence of times; within one frame: tick the clock, then commit, then run callbacks, then finish up", async () => {
  rewind();
  const fps = 30;
  const got = [];
  const order = [];
  let rafSeen = null;
  window.requestAnimationFrame((ts) => { rafSeen = ts; });
  await clock.advanceToAsync(frameMs(90, fps), {
    step: 1000 / fps,
    maxCatchUp: Infinity,
    onFrame: (ms) => { got.push(ms); if (got.length === 1) order.push(["onFrame", clock.now(), rafSeen]); },
    afterFrame: (ms) => { if (ms === got[0]) order.push(["afterFrame", clock.now(), rafSeen]); },
  });
  assert.equal(got.length, 90);
  got.forEach((ms, i) => assert.equal(ms, frameMs(i + 1, fps)));
  assert.deepEqual(order, [["onFrame", frameMs(1, fps), null], ["afterFrame", frameMs(1, fps), frameMs(1, fps)]]);
});

test("advanceToAsync: the Promise returned by the wrap-up must be awaited; abort takes effect between frames and stops on a whole frame", async () => {
  rewind();
  const fps = 30;
  let settled = 0;
  const seenAtNextFrame = [];
  await clock.advanceToAsync(frameMs(10, fps), {
    step: 1000 / fps,
    abort: () => clock.now() >= frameMs(4, fps),
    onFrame: () => { seenAtNextFrame.push(settled); },
    afterFrame: () => new Promise((resolve) => realSetTimeout(() => { settled++; resolve(); }, 1)),
  });
  assert.equal(clock.now(), frameMs(4, fps));
  // 每一帧开始时,前面各帧的收尾都已经做完
  assert.deepEqual(seenAtNextFrame, [0, 1, 2, 3]);
});
