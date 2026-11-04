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
/**
 * Text displayed in the export page by legacy typing card (vendor/typing-animation.tsx on main):
 * page clock is pinned to "frame seconds * 1000", timing from the mount frame
 */
const legacyText = (text, duration, frame, mountFrame) => text.substring(0, Math.floor(((frame / FPS) * 1000 - (mountFrame / FPS) * 1000) / duration));

test("mount clock: mu-4 of the demo project (6-8 s, default params) matches the old implementation frame by frame in the flattened timeline export, including the floating-point boundary at frame 197", () => {
  const clip = { id: "mu-4", start: 6, end: 8 };
  const mountFrame = mountFrameOf(clip, FPS);
  assert.equal(mountFrame, 179, "stage mounts CARD_MOUNT_LEAD early: one frame earlier at 30 fps");
  const schedule = createTypingSchedule({ text: TEXT, duration: 120 });
  const mounted = new Map();
  const shown = [];
  for (let frame = mountFrame; frame < 240; frame++) {
    const ms = mountClockMsAt(mounted, "mu-4:1", clip.start, frame / FPS);
    assert.notEqual(ms, undefined);
    const text = typingTextAt(schedule, ms, 0);
    assert.equal(text, legacyText(TEXT, 120, frame, mountFrame), `Frame ${frame}`);
    shown[frame] = text.length;
  }
  // The 10 frames differing from main during baseline testing each have one more character than
  // "timed from clip start"
  const nominal = (frame) => typingTextAt(schedule, (frame / FPS - clip.start) * 1000).length;
  const ahead = [];
  for (let frame = 180; frame < 240; frame++) if (shown[frame] !== nominal(frame)) ahead.push(frame);
  assert.deepEqual(ahead, [183, 187, 190, 194, 201, 205, 208, 212, 215, 219]);
  // Frame 197: 197/30*1000 − 179/30*1000 = 599.9999999999991, old implementation had one less
  // character; adding tolerance produces the extra character
  assert.equal(shown[197], 4);
  assert.equal(typingTextAt(schedule, mountClockMsAt(mounted, "mu-4:1", clip.start, 197 / FPS)).length, 5);
});

test("mount clock: Chinese text, whole-frame boundaries (100 ms per character) and non-whole-frame starts all match the old implementation frame by frame", () => {
  for (const [text, duration, start] of [[TEXT, 120, 2], ["Boundary at exact frames", 100, 1.7], ["这是一段打字机测试文字，含标点。", 120, 3.2], ["Hello, PromptCut typing!", 120, 0.42], ["Slow typing", 200, 10.05]]) {
    const clip = { id: "c", start, end: start + 4 };
    const mountFrame = mountFrameOf(clip, FPS);
    const schedule = createTypingSchedule({ text, duration });
    const mounted = new Map();
    for (let frame = mountFrame; frame / FPS < clip.end; frame++) {
      const ms = mountClockMsAt(mounted, "c:1", clip.start, frame / FPS);
      assert.notEqual(ms, undefined, `${text} @ ${start}s: a card mounted early has a mount clock for its whole span`);
      assert.equal(typingTextAt(schedule, ms, 0), legacyText(text, duration, frame, mountFrame), `${text} @ ${start}s frame ${frame}`);
    }
  }
});

test("mount clock: a card mounted at or after its start gets no clock (continues typing by t); remounting after unmount restarts the count", () => {
  const mounted = new Map();
  assert.equal(mountClockMsAt(mounted, "a:1", 0, 0), undefined, "a clip starting at 0 has no lead time");
  assert.equal(mountClockMsAt(mounted, "a:1", 0, 1), undefined);
  assert.equal(mountClockMsAt(mounted, "b:1", 6, 6.5), undefined, "export starting from the middle of a clip");
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 179 / 30), 0);
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 180 / 30), (180 / 30) * 1000 - (179 / 30) * 1000);
  // Changing generation (remounting) uses a different clock
  assert.equal(mountClockMsAt(mounted, "c:2", 6, 6.2), undefined);
  forgetUnmounted(mounted, new Set(["c:2"]));
  assert.deepEqual([...mounted.keys()], ["c:2"]);
  // Same key re-entering after c:1 unmounts: recalculates starting from this mount time
  assert.equal(mountClockMsAt(mounted, "c:1", 6, 5.98), 0);
});

test("stage: the mount clock is passed to the card only when mountClock is on; when off (preview, Project export) it is never passed", async () => {
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
    // Pre-mounted frame (179): clock starts from 0; t is still local time clamped to 0
    assert.equal(render(179 / 30, { mountClock: true }).mountClockMs, 0);
    assert.equal(render(179 / 30, { mountClock: true }).t, 0);
    assert.equal(render(179 / 30, {}).mountClockMs, undefined);
    // First render occurring after the start point (one-off render = mounted only now): no clock provided
    assert.equal(render(6.5, { mountClock: true }).mountClockMs, undefined);
    assert.equal(render(6.5, {}).mountClockMs, undefined);
  } finally { await server.close(); }
});
