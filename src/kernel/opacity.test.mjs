/**
 * 卡片 clip 的不透明度 / 淡入淡出。跑:node --test src/kernel/opacity.test.mjs
 *
 * 以前这三个字段只有视频层吃,卡片上设了等于没设 —— 系统提示词让模型「遮到人就降不透明度」,
 * 它照做了、看一眼画面、什么都没变。现在 flattenOverlay 把字段带进时间轴、Stage 按 cardOpacityAt 应用。
 * 钉死:
 *   - 没设过的卡片 hasOpacityControls 为假,Stage 一个字都不碰(老项目导出基线不能动);
 *   - 提前挂载期(t < start)不能把进场第一帧吞成 0;
 *   - flattenOverlay 真的把三个字段带过来了。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { opacityAt, cardOpacityAt, hasOpacityControls, flattenOverlay } from "./project.ts";

const clip = (extra = {}) => ({ id: "c", cardId: "x", start: 2, end: 5, params: {}, ...extra });

test("hasOpacityControls:没设过为假,设了任意一个为真;fade 0 不算设过", () => {
  assert.equal(hasOpacityControls(clip()), false);
  assert.equal(hasOpacityControls(clip({ fadeIn: 0, fadeOut: 0 })), false);
  assert.equal(hasOpacityControls(clip({ opacity: 1 })), true);
  assert.equal(hasOpacityControls(clip({ fadeIn: 0.5 })), true);
});

test("opacityAt:区间内按淡入淡出算,区间外为 0", () => {
  const c = clip({ opacity: 0.8, fadeIn: 1, fadeOut: 1 });
  assert.equal(opacityAt(c, 1.9), 0);
  assert.equal(opacityAt(c, 2), 0);
  assert.ok(Math.abs(opacityAt(c, 2.5) - 0.4) < 1e-9);
  assert.ok(Math.abs(opacityAt(c, 3.5) - 0.8) < 1e-9);
  assert.ok(Math.abs(opacityAt(c, 4.5) - 0.4) < 1e-9);
  assert.equal(opacityAt(c, 5), 0);
});

test("cardOpacityAt:提前挂载期按 start 那一刻算 —— 没淡入就是 opacity 本身,不是 0", () => {
  assert.equal(cardOpacityAt(clip({ opacity: 0.6 }), 1.96), 0.6);
  assert.equal(cardOpacityAt(clip({ opacity: 0.6 }), 3), 0.6);
});

test("cardOpacityAt:有淡入时提前挂载期是 0(淡入本来就从 0 起)", () => {
  assert.equal(cardOpacityAt(clip({ fadeIn: 0.5 }), 1.96), 0);
  assert.ok(Math.abs(cardOpacityAt(clip({ fadeIn: 0.5 }), 2.25) - 0.5) < 1e-9);
});

test("cardOpacityAt:end 之后按最后一刻算,不会因为 t>=end 突然变 0", () => {
  assert.equal(cardOpacityAt(clip({ opacity: 0.7 }), 5.01), 0.7);
});

test("flattenOverlay 把 opacity / fadeIn / fadeOut 带进时间轴;没设的键不出现", () => {
  const p = {
    version: 1, name: "p", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "t", media: [],
    tracks: [{ id: "t1", name: "s", clips: [
      clip({ id: "a", opacity: 0.5, fadeIn: 0.3 }),
      clip({ id: "b" }),
    ] }],
  };
  const tl = flattenOverlay(p);
  const a = tl.clips.find((c) => c.id === "a");
  const b = tl.clips.find((c) => c.id === "b");
  assert.equal(a.opacity, 0.5);
  assert.equal(a.fadeIn, 0.3);
  assert.equal("fadeOut" in a, false);
  assert.equal("opacity" in b, false);
  assert.equal("fadeIn" in b, false);
});
