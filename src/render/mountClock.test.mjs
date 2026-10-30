import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { mountClockMsAt, forgetUnmounted } = await import("./mountClock.ts");
const { createTypingSchedule, typingTextAt } = await import("../kernel/typingEvents.ts");
const { mountFrameOf } = await import("./frameWindow.mjs");

const FPS = 30;
const TEXT = "这是一段打字机测试文字";
/** 旧打字卡(main 上的 vendor/typing-animation.tsx)在导出页里显示的字:页面时钟被钉成「帧秒 * 1000」,从挂载那一帧起计时 */
const legacyText = (text, duration, frame, mountFrame) => text.substring(0, Math.floor(((frame / FPS) * 1000 - (mountFrame / FPS) * 1000) / duration));

test("挂载钟:演示项目的 mu-4(6～8 秒、默认参数)在平铺时间轴导出里逐帧等于旧实现,含第 197 帧的浮点边界", () => {
  const clip = { id: "mu-4", start: 6, end: 8 };
  const mountFrame = mountFrameOf(clip, FPS);
  assert.equal(mountFrame, 179, "舞台提前 CARD_MOUNT_LEAD 挂载:30 fps 下早一帧");
  const schedule = createTypingSchedule({ text: TEXT, duration: 120 });
  const mounted = new Map();
  const shown = [];
  for (let frame = mountFrame; frame < 240; frame++) {
    const ms = mountClockMsAt(mounted, "mu-4:1", clip.start, frame / FPS);
    assert.notEqual(ms, undefined);
    const text = typingTextAt(schedule, ms, 0);
    assert.equal(text, legacyText(TEXT, 120, frame, mountFrame), `第 ${frame} 帧`);
    shown[frame] = text.length;
  }
  // 基线摸底时与 main 不同的那 10 帧,每一帧都比「按片段起点计时」多一个字
  const nominal = (frame) => typingTextAt(schedule, (frame / FPS - clip.start) * 1000).length;
  const ahead = [];
  for (let frame = 180; frame < 240; frame++) if (shown[frame] !== nominal(frame)) ahead.push(frame);
  assert.deepEqual(ahead, [183, 187, 190, 194, 201, 205, 208, 212, 215, 219]);
  // 197 帧:197/30*1000 − 179/30*1000 = 599.9999999999991,旧实现少一个字;加了容差就会多出来
  assert.equal(shown[197], 4);
  assert.equal(typingTextAt(schedule, mountClockMsAt(mounted, "mu-4:1", clip.start, 197 / FPS)).length, 5);
});

test("挂载钟:中文、整帧边界(每字 100 ms)、非整帧起点都逐帧等于旧实现", () => {
  for (const [text, duration, start] of [[TEXT, 120, 2], ["Boundary at exact frames", 100, 1.7], ["这是一段打字机测试文字，含标点。", 120, 3.2], ["Hello, PromptCut typing!", 120, 0.42], ["Slow typing", 200, 10.05]]) {
    const clip = { id: "c", start, end: start + 4 };
    const mountFrame = mountFrameOf(clip, FPS);
    const schedule = createTypingSchedule({ text, duration });
    const mounted = new Map();
    for (let frame = mountFrame; frame / FPS < clip.end; frame++) {
      const ms = mountClockMsAt(mounted, "c:1", clip.start, frame / FPS);
      assert.notEqual(ms, undefined, `${text} @ ${start}s:提前挂载的卡整段都有挂载钟`);
      assert.equal(typingTextAt(schedule, ms, 0), legacyText(text, duration, frame, mountFrame), `${text} @ ${start}s 第 ${frame} 帧`);
    }
  }
});

test("挂载钟:在起点或之后才挂上的不给钟(按 t 接着打);卸载后再挂重新起算", () => {
  const mounted = new Map();
  assert.equal(mountClockMsAt(mounted, "a:1", 0, 0), undefined, "起点为 0 的片段没有提前量");
  assert.equal(mountClockMsAt(mounted, "a:1", 0, 1), undefined);
  assert.equal(mountClockMsAt(mounted, "b:1", 6, 6.5), undefined, "从片段中间开始导");
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 179 / 30), 0);
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 180 / 30), (180 / 30) * 1000 - (179 / 30) * 1000);
  // 换代数(重挂载)是另一把钟
  assert.equal(mountClockMsAt(mounted, "c:2", 6, 6.2), undefined);
  forgetUnmounted(mounted, new Set(["c:2"]));
  assert.deepEqual([...mounted.keys()], ["c:2"]);
  // c:1 卸载后同一个 key 再进来:从这一次挂载的时刻重新起算
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 5.98), 0);
});

test("舞台:mountClock 打开才把挂载钟传给卡;不开(预览、Project 导出)一律不传", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const registry = await server.ssrLoadModule("/src/kernel/registry.ts");
    const { Stage } = await server.ssrLoadModule("/src/render/Stage.tsx");
    const seen = [];
    const Component = (props) => { seen.push(props); return null; };
    registry.resetCards();
    registry.registerCards([{ id: "mu-typing", name: "typing", defaults: {}, controls: [], frameMode: "stateful", Component }]);
    const timeline = { width: 640, height: 360, fps: 30, duration: 8, clips: [{ id: "mu-4", cardId: "mu-typing", start: 6, end: 8, params: {} }] };
    const render = (t, extra) => { seen.length = 0; renderToStaticMarkup(React.createElement(Stage, { timeline, t, playToken: 1, ...extra })); return seen[0]; };
    // 提前挂载的那一帧(179):打开时钟从 0 起;t 仍是夹到 0 的局部时间
    assert.equal(render(179 / 30, { mountClock: true }).mountClockMs, 0);
    assert.equal(render(179 / 30, { mountClock: true }).t, 0);
    assert.equal(render(179 / 30, {}).mountClockMs, undefined);
    // 在起点之后才第一次渲染(一次性渲染 = 这一刻才挂上):不给钟
    assert.equal(render(6.5, { mountClock: true }).mountClockMs, undefined);
    assert.equal(render(6.5, {}).mountClockMs, undefined);
  } finally { await server.close(); }
});
