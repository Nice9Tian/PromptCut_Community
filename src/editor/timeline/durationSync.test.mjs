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
  actions.newProject("时长");
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

test("挪最后一段:渲染时时长已经对好,只渲一遍", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const stop = D.mountDurationSync();
  const r = fakeRenderer();
  actions.moveClip("b", { start: 3, end: 5 });
  assert.equal(getState().project.duration, 4, "监听里不当场改(在别人的调用栈里,比如 docsync 的回调)");
  await settle();
  assert.equal(getState().project.duration, 5);
  assert.deepEqual(r.renders, [5], "一次编辑一次渲染,渲染时读到的就是新时长");
  r.off();
  stop();
});

test("对照(修之前的样子):不挂同步点时,渲染读到的是旧时长 —— 要靠渲染后的 effect 再改一次、再渲一遍", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const r = fakeRenderer();
  actions.moveClip("b", { start: 3, end: 5 });
  await settle();
  assert.deepEqual(r.renders, [4]);
  assert.equal(getState().project.duration, 4);
  r.off();
});

test("手动截断照旧:内容变长也不超过手动值;缩回去跟着缩", async () => {
  load([clip("a", 0, 2), clip("b", 2, 6)]);
  core.set({ durationManual: 5 });
  const stop = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 5, "挂上时补对一次");
  actions.moveClip("b", { start: 3, end: 7 });
  await settle();
  assert.equal(getState().project.duration, 5);
  actions.moveClip("b", { start: 2, end: 3 });
  await settle();
  assert.equal(getState().project.duration, 3);
  stop();
});

test("时长同步不进撤销栈:撤销一步回到挪之前(片段和时长一起回去)", async () => {
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

test("时间轴没挂着(没 mount)就不动时长;卸下之后也不动", async () => {
  load([clip("a", 0, 2), clip("b", 2, 4)]);
  const stop = D.mountDurationSync();
  stop();
  stop();
  actions.moveClip("b", { start: 3, end: 5 });
  await settle();
  assert.equal(getState().project.duration, 4);
});

test("真的 React:挂着 useDurationFollowsContent 的组件,挪最后一段只渲一遍,渲出来就是新时长", async () => {
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
  assert.deepEqual(seen, [[5, 5]], "一次渲染,片段和时长同时是新的");
  root.unmount();
  await flush();
});

test("对照(修之前时间轴里那个渲染后的 effect):同一次挪动渲两遍,第一遍时长是旧的", async () => {
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
