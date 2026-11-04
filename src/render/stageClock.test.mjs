/**
 * Unit tests for stage clock frame advancement. Run: npm test -- src/render/stageClock.test.mjs
 *
 * Lock down "compute the time of each step directly from frame number without frame-by-frame
 * accumulation" (render refactor "Frame-push consistency", root cause in
 * `docs/reports/AGENT-rr-a1-verify.md` "Reason 2"):
 *   - Advance from start to frame N, the timestamp at each step is bit-for-bit identical to
 *     caller-calculated `frame / fps * 1000` (frame 60 at 30 fps is 2000, not 1999.9999999999982);
 *   - Advance frame-by-frame continuously, running exactly one tick per frame (with accumulation,
 *     over 100 frames out of 600 required an extra catch-up tick);
 *   - When start and end points are not on the frame grid, the first step reaches the next frame
 *     grid line, and the last step reaches the endpoint itself;
 *   - Synchronous `advanceTo` and yielding `advanceToAsync` traverse the exact same sequence
 *     of timestamps.
 *
 * No browser: `window`, `performance`, and `Element` use minimal mocks, installing only the
 * essentials touched by the clock.
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// Things taken over during clock installation: mock everything and leave real ones for the test framework itself
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

/** Caller formula for computing frame time (used by `bakeFrame`, tick loop, and export page) */
const frameMs = (n, fps) => (n / fps) * 1000;
/** Reset clock to 0 (rewinding is a jump) and clear the tick emitted by this reset */
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
  // Endpoint just short of the next frame grid line: do not step an extra grid line for it
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
  // Start set to 4000 (exactly frame 120), followed by frames 121-300
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
  // At the start of each frame, finalization for all preceding frames is already complete
  assert.deepEqual(seenAtNextFrame, [0, 1, 2, 3]);
});
