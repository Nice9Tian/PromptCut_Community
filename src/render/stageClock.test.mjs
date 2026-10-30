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

test("累加确实有误差(这条测的是前提):逐帧加 1000/30,第 60 帧不是 2000", () => {
  let ms = 0;
  for (let k = 0; k < 60; k++) ms += 1000 / 30;
  assert.notEqual(ms, 2000);
  assert.equal(frameMs(60, 30), 2000);
});

for (const fps of [24, 25, 30, 60]) {
  test(`${fps} 帧/秒:从头推 20 秒,每一步的时刻都等于 帧号 / fps * 1000`, () => {
    rewind();
    const got = [];
    clock.advanceTo(frameMs(20 * fps, fps), { step: 1000 / fps, maxCatchUp: Infinity, onFrame: (ms) => got.push(ms) });
    assert.equal(got.length, 20 * fps);
    for (let k = 1; k <= 20 * fps; k++) assert.equal(got[k - 1], frameMs(k, fps), `第 ${k} 帧`);
    assert.equal(clock.now(), frameMs(20 * fps, fps));
  });

  test(`${fps} 帧/秒:一帧一帧接着推,每帧正好一拍,落在同一个时刻上`, () => {
    rewind();
    for (let n = 1; n <= 20 * fps; n++) {
      const got = [];
      clock.advanceTo(frameMs(n, fps), { step: 1000 / fps, onFrame: (ms) => got.push(ms) });
      assert.deepEqual(got, [frameMs(n, fps)], `第 ${n} 帧`);
    }
  });
}

test("隔几帧取一张(接着推):中间的帧一帧不落,时刻和从头推的一样", () => {
  rewind();
  const fps = 30;
  const got = [];
  for (const n of [15, 30, 45, 60, 150]) clock.advanceTo(frameMs(n, fps), { step: 1000 / fps, maxCatchUp: Infinity, onFrame: (ms) => got.push(ms) });
  assert.equal(got.length, 150);
  got.forEach((ms, i) => assert.equal(ms, frameMs(i + 1, fps)));
});

test("起点不在帧格上:第一步走到下一个帧格;终点不在帧格上:最后一步走到终点本身", () => {
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

test("起点只差浮点尾数(旧的累加值):算在那一帧上,不多跑一拍", () => {
  rewind();
  clock.set(1999.9999999999982);
  const got = [];
  clock.advanceTo(frameMs(61, 30), { step: 1000 / 30, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [frameMs(61, 30)]);
});

test("目标只比帧格差浮点尾数:直接走到目标本身,一拍", () => {
  rewind();
  const got = [];
  clock.advanceTo(33.33333333333334, { step: 1000 / 30, onFrame: (ms) => got.push(ms) });
  assert.deepEqual(got, [33.33333333333334]);
});

test("补跑上限削掉起点以后,剩下的步子仍然落在帧格上", () => {
  rewind();
  const got = [];
  clock.advanceTo(10_000, { step: 1000 / 30, maxCatchUp: 6000, onFrame: (ms) => got.push(ms) });
  // 起点被拨到 4000(正好是第 120 帧),之后是第 121～300 帧
  assert.equal(got.length, 180);
  assert.equal(got[0], frameMs(121, 30));
  assert.equal(got.at(-1), 10_000);
});

test("认不出帧率的步长:按 帧号 * 步长 走,同样不累加;给了 fps 就照 fps", () => {
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

test("frameGrid:给的帧率和步长对不上时不用它", () => {
  const grid = frameGrid(1000 / 30, 25);
  assert.equal(grid.at(60), 2000, "按步长认出来的 30 帧/秒");
  assert.equal(frameGrid(40, 30).at(3), 120, "按步长认出来的 25 帧/秒");
  assert.equal(grid.after(0), 1);
  assert.equal(grid.after(frameMs(60, 30)), 61);
  assert.equal(grid.reaches(60, 2000), true);
  assert.equal(grid.reaches(59, 2000), false);
});

test("advanceToAsync:走的是同一串时刻;一帧里先拨时钟、再提交、再跑回调、再收尾", async () => {
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

test("advanceToAsync:收尾回的 Promise 要等;abort 在帧与帧之间生效,停在整帧上", async () => {
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
