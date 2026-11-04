/**
 * Closing and numbering of Agent tabs in the AI panel (user decision, 2026-10-20; from 2026-10-22
 * onwards the last tab can also be closed, displaying the start page when there are no sessions, see
 * docs/semantics/workflow/editing.md "Agent tabs in the AI panel").
 * Run: node --test src/ai/agentTabsClose.test.mjs
 * Test cases AT-C1~AT-C6: start page placeholder page when there are no sessions, first session
 * created only upon clicking send, the last tab can also be closed (returns to start page),
 * activation after closing current tab, new tab picks the lowest unused number, restore from
 * persistence after refresh. Per-project test cases are in agentTabsProjects.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

let n = 0;
/** Each test case reloads a fresh module copy, equivalent to page refresh; prep populates localStorage first; then opens project p1 (manifests split by project) */
async function fresh(prep, project = "p1") {
  store.clear();
  prep?.();
  const t = await import(`./agentTabs.ts?case=${++n}`);
  t.setAgentProject(project);
  return t;
}
/** Click send on start page: placeholder page becomes the first session */
function send(t) {
  return t.commitDraft(t.getActiveTabId());
}

test("AT-C1 No sessions in the project yet: there is only one start page placeholder tab (draft), no tab that can be closed, \"+\" returns to it; only sending turns it into Agent 1", async () => {
  const t = await fresh();
  const [d] = t.getTabs();
  assert.equal(t.getTabs().length, 1);
  assert.equal(d.draft, true);
  assert.equal(d.title, "Agent 1");
  assert.equal(t.getActiveTabId(), d.id);
  assert.equal(t.hasRealTabs(), false);
  assert.equal(t.canCloseTab(d.id), false);
  t.closeTab(d.id);
  assert.equal(t.isDraftTab(d.id), true, "The placeholder tab cannot be closed");
  assert.equal(t.addTab().id, d.id, "With no sessions, \"+\" does not create a real tab and returns to the start page");
  assert.equal(t.hasRealTabs(), false);
  // Does not enter storage before clicking send
  assert.equal(store.has("pc.agentTabs:p1"), false);
  // Click send: the same id becomes a real page
  const real = send(t);
  assert.equal(real.id, d.id, "The placeholder tab becomes a real tab and its id does not change (neither the rail item nor the page node needs replacing)");
  assert.equal(real.draft, undefined);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1"]);
  assert.equal(t.hasRealTabs(), true);
  assert.equal(JSON.parse(store.get("pc.agentTabs:p1")).tabs.length, 1);
});

test("AT-C2 The last session can also be closed: after closing all of them it returns to the start page (a new placeholder tab id) and records \"user manually closed all\"", async () => {
  const t = await fresh();
  const first = send(t);
  assert.equal(t.canCloseTab(first.id), true, "The last one can also be closed");
  assert.equal(t.isCleared(), false);
  t.closeTab(first.id);
  assert.equal(t.hasRealTabs(), false);
  const [d] = t.getTabs();
  assert.equal(d.draft, true);
  assert.notEqual(d.id, first.id, "After closing all, the start page gets a new id and does not reuse keys left by old sessions");
  assert.equal(t.getActiveTabId(), d.id);
  assert.equal(t.isCleared(), true);
  const saved = JSON.parse(store.get("pc.agentTabs:p1"));
  assert.deepEqual([saved.tabs.length, saved.cleared], [0, true]);
});

test("AT-C3 Every tab can be closed (including Agent 1); closing the current tab switches to the tab on its left, or to the one on its right if it is leftmost; closing a non-current tab leaves the current tab unchanged", async () => {
  const t = await fresh();
  const first = send(t); // Agent 1
  const a = t.addTab(); // Agent 2, activated
  const b = t.addTab(); // Agent 3, activated
  t.activateTab(first.id);
  assert.equal(t.canCloseTab(first.id), true);
  t.closeTab(first.id);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 2", "Agent 3"]);
  assert.equal(t.getActiveTabId(), a.id);
  t.activateTab(b.id);
  t.closeTab(b.id);
  assert.equal(t.getActiveTabId(), a.id);
  const c = t.addTab();
  t.activateTab(c.id);
  t.closeTab(a.id);
  assert.equal(t.getActiveTabId(), c.id);
});

test("AT-C4 A new tab takes the smallest free number: after closing number 2, a new tab gets number 2; after closing number 1, a new tab gets number 1", async () => {
  const t = await fresh();
  const first = send(t);
  const a = t.addTab();
  t.addTab();
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1", "Agent 2", "Agent 3"]);
  t.closeTab(a.id);
  assert.equal(t.addTab().title, "Agent 2");
  t.closeTab(first.id);
  assert.equal(t.addTab().title, "Agent 1");
});

test("AT-C5 After a refresh: the list, numbers and active tab are restored as they were; a project where everything was closed still shows the start page after a refresh and still remembers that everything was closed", async () => {
  const t = await fresh();
  const first = send(t);
  const a = t.addTab();
  t.closeTab(first.id);
  assert.equal(t.getActiveTabId(), a.id);
  const saved = new Map(store);
  const t2 = await fresh(() => saved.forEach((v, k) => store.set(k, v)));
  assert.deepEqual(t2.getTabs().map((x) => [x.id, x.title]), [[a.id, "Agent 2"]]);
  assert.equal(t2.getActiveTabId(), a.id);
  assert.equal(t2.addTab().title, "Agent 1");
  // Close all again, refresh
  for (const x of [...t2.getTabs()]) t2.closeTab(x.id);
  const saved2 = new Map(store);
  const t3 = await fresh(() => saved2.forEach((v, k) => store.set(k, v)));
  assert.equal(t3.hasRealTabs(), false);
  assert.equal(t3.getTabs()[0].draft, true);
  assert.equal(t3.isCleared(), true);
});

test("AT-C6 If the saved active tab no longer exists, fall back to the first tab; a corrupted saved manifest is treated as never saved", async () => {
  const t = await fresh(() => {
    store.set("pc.agentTabs:p1", JSON.stringify({ v: 2, tabs: [{ id: "p1_x1", title: "Agent 1" }, { id: "p1_x2", title: "Agent 3" }], active: "gone", cleared: false }));
  });
  assert.equal(t.getActiveTabId(), "p1_x1");
  assert.equal(t.addTab().title, "Agent 2");
  const bad = await fresh(() => store.set("pc.agentTabs:p1", "{not json"));
  assert.equal(bad.hasRealTabs(), false);
  assert.equal(bad.getTabs()[0].draft, true);
});
