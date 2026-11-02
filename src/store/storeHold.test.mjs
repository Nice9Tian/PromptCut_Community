/**
 * StoreHold(store/core.ts):停靠栏里看不见的分区页不跟 store 的更新,露出来时按当时的 store 重读。
 * 跑:node --test src/store/storeHold.test.mjs
 *
 * 来历:tiers-probe T4(docs/archive/agent-reports/AGENT-perf-t4.md)—— 以前每次编辑都把看不见的特效库、
 * 节点图整棵重渲,挤在编辑那个同步任务里。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { React, mount, flush } = await import("../testing/fakeReactRoot.mjs");
const { actions, useStore, StoreHold } = await import(srcUrl("store/project.ts"));
const h = React.createElement;

function harness() {
  const log = { live: [], held: [] };
  function Probe({ name }) {
    log[name].push(useStore((s) => s.project.name));
    return null;
  }
  const App = ({ hidden }) => h(React.Fragment, null, h(Probe, { name: "live" }), h(StoreHold, { value: hidden }, h(Probe, { name: "held" })));
  return { log, App };
}

test("Invisible (StoreHold true) subtree: does not re-render when the store changes and keeps the last value; when revealed, it rereads from the store as of that moment", async () => {
  actions.newProject("A");
  const { log, App } = harness();
  const root = mount(h(App, { hidden: false }));
  await flush();
  assert.deepEqual(log.held, ["A"]);

  root.render(h(App, { hidden: true }));
  await flush();
  const heldBefore = log.held.length;
  actions.setProjectMeta({ name: "B" });
  await flush();
  actions.setProjectMeta({ name: "C" });
  await flush();
  assert.equal(log.live.at(-1), "C", "Visible ones keep following as usual");
  assert.equal(log.held.length, heldBefore, "The invisible one never re-rendered");
  assert.equal(log.held.at(-1), "A");

  root.render(h(App, { hidden: false }));
  await flush();
  assert.equal(log.held.at(-1), "C", "When revealed, it holds the value from that moment");
  actions.setProjectMeta({ name: "D" });
  await flush();
  assert.equal(log.held.at(-1), "D", "After being revealed, it keeps following as usual");
  assert.deepEqual(root.errors, []);
  root.unmount();
});

test("Invisible as soon as it is mounted: the first read gets the current value as usual, and it does not follow afterwards", async () => {
  actions.newProject("起点");
  const { log, App } = harness();
  const root = mount(h(App, { hidden: true }));
  await flush();
  assert.deepEqual(log.held, ["起点"]);
  actions.setProjectMeta({ name: "改过" });
  await flush();
  assert.deepEqual(log.held, ["起点"]);
  assert.equal(log.live.at(-1), "改过");
  root.render(h(App, { hidden: false }));
  await flush();
  assert.equal(log.held.at(-1), "改过");
  root.unmount();
});

test("Where StoreHold is not wrapped (default false) behavior is unchanged: re-renders once on every change", async () => {
  actions.newProject("x0");
  const seen = [];
  function Plain() {
    seen.push(useStore((s) => s.project.name));
    return null;
  }
  const root = mount(h(Plain));
  await flush();
  for (const n of ["x1", "x2", "x3"]) {
    actions.setProjectMeta({ name: n });
    await flush();
  }
  assert.deepEqual(seen, ["x0", "x1", "x2", "x3"]);
  root.unmount();
});
