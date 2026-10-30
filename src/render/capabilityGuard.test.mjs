/**
 * A0.2 运行期兜底的单测。跑:node --test src/render/capabilityGuard.test.mjs
 *
 * 这条规则错了不会报错,只会让一张毛玻璃卡的死素材被当成「独立卡」上云共享 ——
 * 换个下层就糊着别人的画面。所以三件事各钉一条:量得到、只对 independent 生效、
 * 降级之后 cardCapabilities 真的改口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { usesBackdropFilter, needsGuard, guardCompositing, resetGuardScans } = await import("./capabilityGuard.ts");
const { cardCapabilities, degradedCards, resetDegradedCards } = await import("../kernel/frameMode.mjs");

/** 最小的假 DOM:只需要 querySelector / querySelectorAll 和一张 style 表 */
function fakeStage(clips) {
  const byClip = new Map();
  for (const [clipId, styles] of Object.entries(clips)) {
    const nodes = styles.map((style) => ({ style }));
    const root = { style: nodes[0]?.style ?? {}, querySelectorAll: () => nodes.slice(1) };
    byClip.set(clipId, root);
  }
  return {
    querySelector: (sel) => byClip.get((sel.match(/\[data-pc-clip="(.*)"\]/) || [])[1]) ?? null,
  };
}
const readStyle = (el) => el.style ?? {};

test("usesBackdropFilter: none / 空串 不算,任何真值都算", () => {
  const el = (v) => ({ style: { backdropFilter: v }, querySelectorAll: () => [] });
  assert.equal(usesBackdropFilter(el("none"), readStyle), false);
  assert.equal(usesBackdropFilter(el(""), readStyle), false);
  assert.equal(usesBackdropFilter(el("blur(24px)"), readStyle), true);
  assert.equal(usesBackdropFilter(null, readStyle), false);
  // -webkit- 前缀那一支单独走
  const webkit = { style: { webkitBackdropFilter: "blur(24px)" }, querySelectorAll: () => [] };
  assert.equal(usesBackdropFilter(webkit, readStyle), true);
  // 子孙节点也要扫到:玻璃板是卡片内部的 div,不是外层那一格
  const nested = { style: {}, querySelectorAll: () => [{ style: { backdropFilter: "blur(8px)" } }] };
  assert.equal(usesBackdropFilter(nested, readStyle), true);
});

test("needsGuard: 只有审阅表说 independent 的卡要查", () => {
  assert.equal(needsGuard("punch-pill"), true);
  assert.equal(needsGuard("particles-snow"), true, "通配命中的粒子卡也算 independent");
  assert.equal(needsGuard("blur-text"), false, "本来就是 belowDependent,不用查");
  assert.equal(needsGuard("没这张卡"), false, "unknown 已经是最保守档");
  assert.equal(needsGuard(undefined), false);
});

test("guardCompositing: 说独立、实际有毛玻璃 → 报警 + 降级 + cardCapabilities 改口", (t) => {
  resetDegradedCards(); resetGuardScans();
  t.after(() => { resetDegradedCards(); resetGuardScans(); });
  const before = cardCapabilities({ id: "punch-pill", frameMode: "stateful" });
  assert.equal(before.compositing, "independent");
  assert.equal(before.independentCache, true);

  const warnings = [];
  const stage = fakeStage({ c1: [{}, { backdropFilter: "blur(24px)" }] });
  const hit = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: (m) => warnings.push(m) });

  assert.deepEqual(hit, ["punch-pill"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /punch-pill/);
  const after = cardCapabilities({ id: "punch-pill", frameMode: "stateful" });
  assert.equal(after.compositing, "belowDependent");
  assert.equal(after.independentCache, false);
  assert.equal(degradedCards().get("punch-pill"), "backdrop-filter");

  // 同一张卡不重复报警
  const again = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: (m) => warnings.push(m) });
  assert.deepEqual(again, []);
  assert.equal(warnings.length, 1);
});

test("guardCompositing: 干净的独立卡不动它", (t) => {
  resetDegradedCards(); resetGuardScans();
  t.after(() => { resetDegradedCards(); resetGuardScans(); });
  const stage = fakeStage({ c1: [{}, { backdropFilter: "none" }] });
  const hit = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: () => {} });
  assert.deepEqual(hit, []);
  assert.equal(cardCapabilities({ id: "punch-pill" }).compositing, "independent");
});
