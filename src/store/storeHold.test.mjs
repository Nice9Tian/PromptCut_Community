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

test("看不见(StoreHold true)的子树:store 变了不重渲、一直是上一次的值;露出来那一次按当时的 store 重读", async () => {
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
  assert.equal(log.live.at(-1), "C", "看得见的照常跟");
  assert.equal(log.held.length, heldBefore, "看不见的一次都没重渲");
  assert.equal(log.held.at(-1), "A");

  root.render(h(App, { hidden: false }));
  await flush();
  assert.equal(log.held.at(-1), "C", "露出来就是当时的值");
  actions.setProjectMeta({ name: "D" });
  await flush();
  assert.equal(log.held.at(-1), "D", "露出来之后照常跟");
  assert.deepEqual(root.errors, []);
  root.unmount();
});

test("一挂上就是看不见的:第一次照常读当时的值,之后不跟", async () => {
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

test("没包 StoreHold 的地方(缺省 false)行为不变:每次变动都重渲一次", async () => {
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
