/**
 * 时间轴吸附的单测。跑:node --test src/editor/timeline/snapTime.test.mjs
 *
 * 只钉一条,但这条是三个视图对齐的地基:**吸附的结果必须落在帧格上**。
 * 落不上会怎样:成片是逐帧渲的,一条 4.041s 开始的片段其实从第 122 帧(4.0667s)开始;
 * 而三维视图的预渲染时刻是按**片段起点**排格子的,导出渲的是**全局帧格** —— 两套格子对不齐。
 * 实测起点 4.041 时,播放头第 121 / 122 / 123 帧拿到的预渲染帧是 121 / 121 / 122,
 * 三维比二维整整慢一帧,而且不报错。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { snapTime } from "./utils.ts";

const proj = (fps = 30) => ({
  width: 1920, height: 1080, fps, duration: 20, themeId: "midnight",
  tracks: [{ id: "t1", kind: "card", name: "A", clips: [{ id: "c1", cardId: "x", start: 2, end: 6, params: {} }] }],
  media: [],
});
const onGrid = (v, fps) => Math.abs(v * fps - Math.round(v * fps)) < 1e-9;

test("Snap results always land on the frame grid, including when alt is held to bypass snapping", () => {
  for (const fps of [24, 25, 30, 60]) {
    const p = proj(fps);
    for (const raw of [0, 0.0071, 1.4999, 4.041, 4.017, 9.99991, 12.5, 17.3333]) {
      for (const alt of [false, true]) {
        const v = snapTime(raw, alt, p, 3, undefined, 100);
        assert.ok(onGrid(v, fps), `fps=${fps} raw=${raw} alt=${alt} snapped to ${v}, not on the frame grid`);
        assert.ok(v >= 0, `fps=${fps} raw=${raw} snapped to negative number ${v}`);
      }
    }
  }
});

test("Still snaps to a nearby snap point; quantization must not swallow the snapping itself", () => {
  const p = proj(30);
  // 片段边缘在 2 和 6,整秒也是吸附点;10px 阈值 / 100pxPerSec = 0.1s
  assert.equal(snapTime(2.05, false, p, -1, undefined, 100), 2, "Should snap to clip start 2");
  assert.equal(snapTime(5.95, false, p, -1, undefined, 100), 6, "Should snap to clip end 6");
  assert.equal(snapTime(3.02, false, p, -1, undefined, 100), 3, "Should snap to whole second 3");
});

test("Far from a snap point, quantize the raw value; it does not get pulled away", () => {
  const p = proj(30);
  // 4.5 离 4、5、片段边缘都超过 0.1s
  assert.ok(Math.abs(snapTime(4.51, false, p, -1, undefined, 100) - 4.5) < 1e-9, "4.51 should land on frame 135 = 4.5");
  assert.ok(Math.abs(snapTime(4.56, false, p, -1, undefined, 100) - 4.5333333333333) < 1e-9, "4.56 lands on frame 136");
});

test("When fps is missing, treat it as 30; division must not produce NaN", () => {
  const p = { ...proj(30), fps: undefined };
  const v = snapTime(4.041, true, p, -1, undefined, 100);
  assert.ok(Number.isFinite(v) && onGrid(v, 30), `Got ${v}`);
});
