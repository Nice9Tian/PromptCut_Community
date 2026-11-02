/**
 * 帧格对齐的单测。跑:node --test src/render/frameGrid.test.mjs
 *
 * 这个函数错了不会报错,只会让播放头停在成片里不存在的时刻上。
 * 挂载帧(第一个不早于入点的帧)由 frameWindow.mjs 的 mountFrameOf 负责,单测在 frameWindow.test.mjs。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { atFrameGrid } from "./frameGrid.ts";

test("atFrameGrid: a time on the frame grid must not be rounded back to the previous frame", () => {
  // 29/30 * 30 在浮点里是 28.999999999999996,不留容差就退回第 28 帧
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
