/**
 * 剪辑标签栏的状态规则(cutTabsState.ts)。跑:npm test -- src/editor/timeline/cutTabsState.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeTab, reconcileTabs, openTabs, openTab, setTabs, resetCutTabsMemory } from "./cutTabsState.ts";

test("激活的那条一定在标签里;不存在的剪辑拿掉;一个都没有时是激活的那条", () => {
  assert.deepEqual(reconcileTabs(null, ["a", "b"], "a"), ["a"]);
  assert.deepEqual(reconcileTabs(["b"], ["a", "b"], "a"), ["b", "a"], "Agent 切到 a:补上 a 的标签");
  assert.deepEqual(reconcileTabs(["x", "b", "b"], ["a", "b"], "b"), ["b"], "删掉的 x 拿掉、重复的只留一个");
  assert.deepEqual(reconcileTabs([], [], undefined), []);
});

test("关标签:最后一个不能关;关激活的那条切到右邻,没有右邻切左邻;关别的不切换", () => {
  assert.equal(closeTab(["a"], "a", "a"), null);
  assert.deepEqual(closeTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], switchTo: "c" });
  assert.deepEqual(closeTab(["a", "b", "c"], "c", "c"), { tabs: ["a", "b"], switchTo: "b" });
  assert.deepEqual(closeTab(["a", "b"], "a", "b"), { tabs: ["b"], switchTo: null });
});

test("按项目存:打开的标签保留到用户关掉为止(失焦、点别处都不动它)", () => {
  resetCutTabsMemory();
  openTab("p1", ["a", "b", "c"], "a", "c");
  assert.deepEqual(openTabs("p1", ["a", "b", "c"], "a"), ["a", "c"]);
  assert.deepEqual(openTabs("p2", ["a", "b"], "b"), ["b"], "别的项目互不影响");
  setTabs("p1", ["c"]);
  assert.deepEqual(openTabs("p1", ["a", "b", "c"], "c"), ["c"]);
});
