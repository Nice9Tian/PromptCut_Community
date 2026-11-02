/**
 * 总时长跟内容走(durationSync.ts):对时长排在渲染之前,一次编辑只渲一遍。
 * 跑:node --test src/editor/timeline/durationSync.test.mjs
 *
 * 来历:tiers-probe T4(docs/archive/agent-reports/AGENT-perf-t4.md)。以前是时间轴渲染完在 effect 里 `syncDuration`,
 * 挪最后一段 → 整个编辑器渲一遍 → effect 改时长 → 同一个任务里再渲一遍。
 * 这里用一个「后订阅、收到通知就排一个微任务去读 state」的监听模拟 React 的 useSyncExternalStore
 * (React 也是在监听里排微任务刷新渲染),看它刷新时读到的是不是已经对好的时长。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import(srcUrl("store/core.ts"));
const { actions, getState, subscribe } = await import(srcUrl("store/project.ts"));
const D = await import(srcUrl("editor/timeline/durationSync.ts"));

const clip = (id, start, end) => ({ id, cardId: "", start, end, params: {} });
function load(clips) {
  actions.newProject("Duration");
  const p = getState().project;
  core.setProject({ ...p, tracks: [{ ...p.tracks[0], clips }], duration: Math.max(...clips.map((c) => c.end)) }, { undoable: false });
  core.set({ durationManual: null });
}

/** 模拟 React:第一次收到通知时排一个微任务「渲染」,渲染时记下这一刻的项目时长 */
function fakeRenderer() {
  const renders = [];
  let pending = false;
  const off = subscribe(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      renders.push(getState().project.duration);
    });
  });
  return { renders, off };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("Move the last clip: the duration is already correct at render time, so it renders only once", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const stop = D.mountDurationSync();
  const r = fakeRenderer();
  actions.moveClip("b", { start: 3, end: 5 });
  assert.equal(getState().project.duration, 4, "Do not change it on the spot inside a listener (it is on someone else's call stack, e.g. a docsync callback)");
  await settle();
  assert.equal(getState().project.duration, 5);
  assert.deepEqual(r.renders, [5], "One edit, one render, and the render reads the new duration");
  r.off();
  stop();
});

test("Control (how it was before the fix): without the sync point attached, the render reads the old duration; a post-render effect has to change it again and render once more", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const r = fakeRenderer();
  actions.moveClip("b", { start: 3, end: 5 });
  await settle();
  assert.deepEqual(r.renders, [4]);
  assert.equal(getState().project.duration, 4);
  r.off();
});

test("Manual truncation works as before: longer content does not exceed the manual value; when content shrinks back, the duration shrinks with it", async () => {
  load([clip("a", 0, 2), clip("b", 2, 6)]);
  core.set({ durationManual: 5 });
  const stop = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 5, "Corrected once on attach");
  actions.moveClip("b", { start: 3, end: 7 });
  await settle();
  assert.equal(getState().project.duration, 5);
  actions.moveClip("b", { start: 2, end: 3 });
  await settle();
  assert.equal(getState().project.duration, 3);
  stop();
});

test("Duration sync does not enter the undo stack: one undo step returns to before the move (clips and duration go back together)", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const stop = D.mountDurationSync();
  const depth = core.history.length;
  actions.moveClip("b", { start: 3, end: 5 });
  await settle();
  assert.equal(core.history.length, depth + 1);
  actions.undo();
  await settle();
  assert.equal(getState().project.tracks[0].clips.find((c) => c.id === "b").end, 4);
  assert.equal(getState().project.duration, 4);
  stop();
});

test("The duration is not touched while the timeline is not mounted (no mount), nor after it is unmounted", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const stop = D.mountDurationSync();
  stop();
  stop();
  actions.moveClip("b", { start: 3, end: 5 });
  await settle();
  assert.equal(getState().project.duration, 4);
});

test("Real React: a component with useDurationFollowsContent attached renders only once when the last clip is moved, and what it renders is already the new duration", async () => {
  const { React, mount, flush } = await import("../../testing/fakeReactRoot.mjs");
  const { useStore } = await import(srcUrl("store/project.ts"));
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const seen = [];
  function Timeline() {
    D.useDurationFollowsContent();
    const tracks = useStore((s) => s.project.tracks);
    const duration = useStore((s) => s.project.duration);
    seen.push([tracks.at(0)?.clips.at(-1)?.end, duration]);
    return null;
  }
  const root = mount(React.createElement(Timeline));
  await flush();
  seen.length = 0;
  actions.moveClip("b", { start: 3, end: 5 });
  await flush();
  assert.deepEqual(seen, [[5, 5]], "One render: clips and duration are both new at the same time");
  root.unmount();
  await flush();
});

test("Control (the post-render effect in the timeline before the fix): the same move renders twice, and the first render has the old duration", async () => {
  const { React, mount, flush } = await import("../../testing/fakeReactRoot.mjs");
  const { useStore } = await import(srcUrl("store/project.ts"));
  const { contentEndOf, effectiveDuration } = await import(srcUrl("kernel/duration.ts"));
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const seen = [];
  function OldTimeline() {
    const tracks = useStore((s) => s.project.tracks);
    const duration = useStore((s) => s.project.duration);
    const manual = useStore((s) => s.durationManual);
    React.useEffect(() => {
      const target = effectiveDuration(contentEndOf(tracks), duration, manual);
      if (Math.abs(target - duration) > 1e-6) actions.syncDuration(target);
    }, [tracks, duration, manual]);
    seen.push([tracks.at(0)?.clips.at(-1)?.end, duration]);
    return null;
  }
  const root = mount(React.createElement(OldTimeline));
  await flush();
  seen.length = 0;
  actions.moveClip("b", { start: 3, end: 5 });
  await flush();
  assert.deepEqual(seen, [[5, 4], [5, 5]]);
  root.unmount();
  await flush();
});
