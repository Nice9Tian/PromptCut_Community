/**
 * StoreHold(store/core.ts): hidden section tabs in the dock do not follow store updates, and
 * re-read from the current store when revealed. Run: node --test src/store/storeHold.test.mjs
 *
 * Origin: tiers-probe T4 (docs/archive/agent-reports/AGENT-perf-t4.md): previously every edit
 * re-rendered the entire tree of the hidden effects library and node graph, crammed into that
 * synchronous edit task.
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
  actions.newProject("Starting point");
  const { log, App } = harness();
  const root = mount(h(App, { hidden: true }));
  await flush();
  assert.deepEqual(log.held, ["Starting point"]);
  actions.setProjectMeta({ name: "Changed" });
  await flush();
  assert.deepEqual(log.held, ["Starting point"]);
  assert.equal(log.live.at(-1), "Changed");
  root.render(h(App, { hidden: false }));
  await flush();
  assert.equal(log.held.at(-1), "Changed");
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
