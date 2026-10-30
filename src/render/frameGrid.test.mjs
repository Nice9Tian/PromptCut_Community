/**
 * 帧格对齐的单测。跑:node --test src/render/frameGrid.test.mjs
 *
 * 这个函数错了不会报错,只会让播放头停在成片里不存在的时刻上。
 * 挂载帧(第一个不早于入点的帧)由 frameWindow.mjs 的 mountFrameOf 负责,单测在 frameWindow.test.mjs。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { atFrameGrid } from "./frameGrid.ts";

test("atFrameGrid:帧格上的时刻不许被判回上一帧", () => {
  // 29/30 * 30 在浮点里是 28.999999999999996,不留容差就退回第 28 帧
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const f of [1, 7, 29, 60, 149]) {
      const sec = f / fps;
      assert.equal(atFrameGrid(sec, fps), sec, `fps=${fps} 第 ${f} 帧被判回上一帧了`);
    }
  }
});

test("atFrameGrid:帧中间的时刻归它所在的那一帧", () => {
  assert.ok(Math.abs(atFrameGrid(1.02, 30) - 30 / 30) < 1e-12, "1.02 还在第 30 帧里");
  assert.ok(Math.abs(atFrameGrid(1.0666, 30) - 31 / 30) < 1e-12, "差一点点到第 32 帧,仍算第 31 帧");
  assert.equal(atFrameGrid(0, 30), 0);
  assert.equal(atFrameGrid(-1, 30), 0, "负数夹到 0,别把播放头推到时间轴外面");
});

test("atFrameGrid 永不晚于原值", () => {
  for (const sec of [0.001, 0.4999, 0.95, 1, 2.5, 3.9999]) {
    assert.ok(atFrameGrid(sec, 30) <= sec + 1e-9, `${sec} 往下取整反而变大了`);
  }
});
