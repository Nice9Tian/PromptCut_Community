/**
 * Unit test for "which moment to prerender". Run: node --test src/editor/preview/bakeTime.test.mjs
 *
 * Pins down that real bug: rendering midpoint -> when playhead is at 0.23s, 3D displays 1.0s frame
 * (mu-number-ticker, scrolls 1.6s, clip [0,2]: 0.23s should be 81%, midpoint is 100%).
 * This kind of error **throws no error**, manifesting only as "numbers in UI do not match numbers
 * in 3D", so tests must keep watch.
 *
 * Two other cases also throw no error when wrong:
 *   - Picking forward displays frames not yet reached ahead of time (more misleading than lagging);
 *   - Frontend snap grid not matching prerender scheduled grid manifests as "rendering on-demand
 *     despite having prerendered".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTLE_MS,
  motionOf,
  pickBakeT,
  sampleTimesFor,
  staleBy,
  texKeyOf,
} from "./bakeTime.ts";

const clip = (over = {}) => ({ id: "c1", cardId: "mu-number-ticker", start: 0, end: 2, params: {}, ...over });
/** The card reported by the user: scrolls for 1.6s, then stops */
const TICKER = { settleMs: 1600, after: "hold" };

test("That is the bug: 0.23 s must not pick the midpoint 1.0 s", () => {
  const c = clip();
  const got = pickBakeT(c, TICKER, 0.23);
  assert.notEqual(got, 1, "Picking the midpoint is the original bug");
  assert.ok(got <= 0.23 + 1e-9, `Must not pick ahead, got=${got}`);
  assert.ok(got > 0.23 - 0.25 - 1e-9, `Must be within one step of the playhead, got=${got}`);
});

test("Only pick backward: whatever moment is picked is never later than the playhead", () => {
  const c = clip({ end: 6 });
  for (let t = 0; t < 6; t += 0.07) {
    const got = pickBakeT(c, { settleMs: 900, after: "evolve" }, t);
    assert.ok(got <= t + 1e-9, `t=${t.toFixed(2)} picked ${got}, which is a future frame`);
  }
});

test("A hold card has only one moment after it settles: a 10 s static card should not produce 40 images", () => {
  const c = clip({ end: 10 });
  const a = pickBakeT(c, { settleMs: 800, after: "hold" }, 3);
  const b = pickBakeT(c, { settleMs: 800, after: "hold" }, 9.5);
  assert.equal(a, b, "After settling every frame is identical, so the same image should be reused");
  assert.equal(a, 0.8);
  assert.ok(sampleTimesFor(c, { settleMs: 800, after: "hold" }).length <= 5);
});

test("An evolve card must be sampled over its whole span, not just the entrance part", () => {
  const c = clip({ end: 8 });
  const hold = sampleTimesFor(c, { settleMs: 800, after: "hold" });
  const evolve = sampleTimesFor(c, { settleMs: 800, after: "evolve" });
  assert.ok(evolve.length > hold.length);
  assert.ok(evolve[evolve.length - 1] > 4, "A card that keeps changing must have sample points in the second half too");
});

test("The grid cell snapped to in the foreground must land on a grid cell scheduled by the prerender, otherwise the prerender schedule is wasted", () => {
  const c = clip({ end: 4 });
  const motion = { settleMs: 4000, after: "hold" }; // Entire clip in motion → no decimation
  const planned = new Set(sampleTimesFor(c, motion, { maxPerClip: 999 }).map((x) => x.toFixed(3)));
  for (let t = 0; t < 4; t += 0.05) {
    const got = pickBakeT(c, motion, t).toFixed(3);
    assert.ok(planned.has(got), `t=${t.toFixed(2)} wants ${got}, which is not in the prerender list`);
  }
});

/**
 * The test above uses default 0.25: and 0.25 is **exact in binary**, so it is always green and
 * cannot pin down the real risk. Step sizes for the frame-by-frame tier are 1/30, 1/24, 1/29.97,
 * none of which are exact.
 *
 * This test actually failed before: `sampleTimesFor` accumulated (`rel += step`), while `pickBakeT`
 * floored then multiplied; at 30fps, 39 of 60 sample points differed by 2.8e-17. The cache key is
 * formatted from this float, so **the display side could not find a single prerendered image, yet
 * threw no error**: it only manifested as "rendering on-demand despite having prerendered".
 * Therefore, what is tested here is **bitwise equality** (===), not equality after toFixed.
 */
test("Step sizes that are not exact in binary (the per-frame tier) must also line up: being off by 2.8e-17 means all the prerendering is wasted", () => {
  for (const [name, step] of [["1/30", 1 / 30], ["1/24", 1 / 24], ["1/29.97", 1 / 29.97], ["0.1", 0.1]]) {
    const c = clip({ end: 3 });
    const motion = { settleMs: 3000, after: "hold" };
    const planned = sampleTimesFor(c, motion, { stepSec: step, maxPerClip: 9999 });
    const set = new Set(planned);
    assert.ok(planned.length > 20, `${name}: too few sample points, this test did not exercise anything`);
    for (const want of planned) {
      // Stopped at this sample point, snapping back must yield the **exact same float**
      assert.ok(set.has(pickBakeT(c, motion, want, { stepSec: step })), `${name}: stopping at ${want} does not snap back to itself`);
    }
    // Also test positions between grid slots: the moment snapped back to must be in the list
    for (let t = 0; t < 3; t += 0.017) {
      assert.ok(set.has(pickBakeT(c, motion, t, { stepSec: step })), `${name}: the moment t=${t} snaps to is not in the prerender list`);
    }
  }
});

test("Thinning only reduces coverage; the first and last are always kept", () => {
  const c = clip({ end: 30 });
  const all = sampleTimesFor(c, { settleMs: 0, after: "evolve" }, { maxPerClip: 999 });
  const few = sampleTimesFor(c, { settleMs: 0, after: "evolve" }, { maxPerClip: 6 });
  assert.ok(few.length <= 6);
  assert.equal(few[0], all[0]);
  assert.equal(few[few.length - 1], all[all.length - 1]);
});

test("The cache key must include which moment it is: without it you get \"the picture does not update when the moment changes\"", () => {
  const c = clip();
  assert.notEqual(texKeyOf(c, 0.25), texKeyOf(c, 1));
  // Position and 3D transforms do not enter the key: frame is stripped during prerendering;
  // rotating the card does not change a single pixel of the texture
  assert.equal(texKeyOf({ ...c, frame: { w: 800, h: 400 } }, 0.25), texKeyOf({ ...c, frame: { w: 800, h: 400 } }, 0.25));
});

test("timing(params) is more accurate than lifecycle, and even when written badly it must not crash the view", () => {
  const def = {
    lifecycle: { settleMs: 800, after: "hold" },
    defaults: { rows: 3 },
    timing: (p) => ({ settleMs: 400 * p.rows, after: "hold" }),
  };
  assert.equal(motionOf(def, { rows: 5 }).settleMs, 2000, "Should be computed from the actual parameters of this card");
  const broken = { lifecycle: { settleMs: 800, after: "hold" }, timing: () => { throw new Error("The card author wrote it wrong"); } };
  assert.deepEqual(motionOf(broken, {}), { settleMs: 800, after: "hold" }, "When the timing function throws, fall back to lifecycle");
  assert.deepEqual(motionOf(undefined, {}), {}, "Must not throw even when the card definition cannot be obtained");
});

test("Cards without lifecycle are handled with conservative values: better to sample too much than to show an old frame", () => {
  const c = clip({ end: 10 });
  const got = sampleTimesFor(c, {});
  assert.ok(got.length > 1, "Must not degrade into rendering just one");
  assert.equal(got[got.length - 1], DEFAULT_SETTLE_MS / 1000);
});

test("Edge cases: zero-length clip, playhead outside the segment, t not a number: must neither throw nor return NaN", () => {
  for (const [c, t] of [
    [clip({ start: 3, end: 3 }), 3],
    [clip({ start: 5, end: 7 }), 0],      // Playhead before the clip (prerendering will query clips not yet played)
    [clip({ start: 5, end: 7 }), 99],     // After the clip
    [clip(), Number.NaN],
  ]) {
    const got = pickBakeT(c, TICKER, t);
    assert.ok(Number.isFinite(got), `Returned ${got}`);
    assert.ok(got >= c.start && got <= c.end, `${got} falls outside clip [${c.start},${c.end}]`);
  }
});

test("staleBy reports \"how far the displayed moment is from the playhead\", and the UI relies on it to decide whether to say anything", () => {
  assert.equal(staleBy(0.25, 0.25), 0);
  assert.ok(Math.abs(staleBy(0.75, 1) - 0.25) < 1e-9);
});
