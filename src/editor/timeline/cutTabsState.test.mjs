/**
 * State rules for the cut tab bar (cutTabsState.ts). Run: npm test -- src/editor/timeline/cutTabsState.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeTab, reconcileTabs, openTabs, openTab, setTabs, resetCutTabsMemory } from "./cutTabsState.ts";

test("The active one is always among the tabs; cuts that do not exist are removed; when there are none, the result is the active one", () => {
  assert.deepEqual(reconcileTabs(null, ["a", "b"], "a"), ["a"]);
  assert.deepEqual(reconcileTabs(["b"], ["a", "b"], "a"), ["b", "a"], "Agent switches to a: add a's tab");
  assert.deepEqual(reconcileTabs(["x", "b", "b"], ["a", "b"], "b"), ["b"], "Deleted x is removed, duplicates keep only one");
  assert.deepEqual(reconcileTabs([], [], undefined), []);
});

test("Closing tabs: the last one cannot be closed; closing the active one switches to the right neighbor, or the left neighbor if there is none; closing another one does not switch", () => {
  assert.equal(closeTab(["a"], "a", "a"), null);
  assert.deepEqual(closeTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], switchTo: "c" });
  assert.deepEqual(closeTab(["a", "b", "c"], "c", "c"), { tabs: ["a", "b"], switchTo: "b" });
  assert.deepEqual(closeTab(["a", "b"], "a", "b"), { tabs: ["b"], switchTo: null });
});

test("Stored per project: open tabs stay until the user closes them (losing focus or clicking elsewhere does not touch them)", () => {
  resetCutTabsMemory();
  openTab("p1", ["a", "b", "c"], "a", "c");
  assert.deepEqual(openTabs("p1", ["a", "b", "c"], "a"), ["a", "c"]);
  assert.deepEqual(openTabs("p2", ["a", "b"], "b"), ["b"], "Other projects do not affect each other");
  setTabs("p1", ["c"]);
  assert.deepEqual(openTabs("p1", ["a", "b", "c"], "c"), ["c"]);
});
