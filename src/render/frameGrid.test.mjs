/**
 * Unit test for frame grid alignment. Run: node --test src/render/frameGrid.test.mjs
 *
 * If this function is wrong it will not throw, but leaves the playhead at a timestamp that does
 * not exist in the final video. Mount frames (the first frame not earlier than the in point)
 * are handled by mountFrameOf in frameWindow.mjs; unit tests are in frameWindow.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { atFrameGrid } from "./frameGrid.ts";

test("atFrameGrid: a time on the frame grid must not be rounded back to the previous frame", () => {
  // 29/30 * 30 is 28.999999999999996 in floating point; without tolerance it falls back to frame 28
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const f of [1, 7, 29, 60, 149]) {
      const sec = f / fps;
      assert.equal(atFrameGrid(sec, fps), sec, `fps=${fps}: frame ${f} was rounded back to the previous frame`);
    }
  }
});

test("atFrameGrid: a time in the middle of a frame belongs to the frame containing it", () => {
  assert.ok(Math.abs(atFrameGrid(1.02, 30) - 30 / 30) < 1e-12, "1.02 is still within frame 30");
  assert.ok(Math.abs(atFrameGrid(1.0666, 30) - 31 / 30) < 1e-12, "just short of frame 32, still counts as frame 31");
  assert.equal(atFrameGrid(0, 30), 0);
  assert.equal(atFrameGrid(-1, 30), 0, "negative values clamp to 0, do not push the playhead outside the timeline");
});

test("atFrameGrid is never later than the original value", () => {
  for (const sec of [0.001, 0.4999, 0.95, 1, 2.5, 3.9999]) {
    assert.ok(atFrameGrid(sec, 30) <= sec + 1e-9, `${sec} got larger after rounding down`);
  }
});
