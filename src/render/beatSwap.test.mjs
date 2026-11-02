/**
 * L4 的按拍换快照预算(C10 契约第 6 节、第 18 节第 1 条):deadMs = max(0, budgetOf(fps) − 已占用),
 * 装得下 floor(deadMs / swapMs) 层,按调用方给的层序取,装不下的占位;SWAP_MS 缺省 3。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBeatSwaps, SWAP_MS } from "./beatSwap.mjs";
import { budgetOf, planPipelines } from "./pipelinePlan.mjs";

test("C10-BS-01 SWAP_MS defaults to 3 ms; budget and dispatch use the same B", () => {
  assert.equal(SWAP_MS, 3);
  const r = fitBeatSwaps({ fps: 30, occupiedMs: 0, layers: ["a"] });
  assert.equal(r.deadMs, budgetOf(30));
});

test("C10-BS-02 number of layers that fit = floor(deadMs / swapMs), taken in layer order, the rest get placeholders", () => {
  // 30 fps:B = 23.333…;已占用 11.333… → deadMs 12 → 4 层
  const r = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["top", "b", "c", "d", "e", "f"] });
  assert.equal(r.fit, 4);
  assert.deepEqual(r.swap, ["top", "b", "c", "d"]);
  assert.deepEqual(r.placeholder, ["e", "f"]);
  // 同一输入结果稳定
  assert.deepEqual(fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["top", "b", "c", "d", "e", "f"] }), r);
});

test("C10-BS-03 already used exceeds budget: deadMs = 0, all get placeholders; swapMs can be swapped", () => {
  const r = fitBeatSwaps({ fps: 60, occupiedMs: 100, layers: ["a", "b"] });
  assert.equal(r.deadMs, 0);
  assert.deepEqual(r.swap, []);
  assert.deepEqual(r.placeholder, ["a", "b"]);
  const s = fitBeatSwaps({ fps: 30, occupiedMs: 0, layers: ["a", "b", "c"], swapMs: 10 });
  assert.equal(s.fit, 2);
  assert.deepEqual(s.swap, ["a", "b"]);
});

test("C10-BS-04 at dispatch deadMs is replaced with swapMs: the more heavy cards, the more the light pipeline yields (same budget as the trade-off during playback)", () => {
  const project = { tracks: [{ id: "t", clips: [
    { id: "L1", cardId: "x", start: 0, end: 2 }, { id: "L2", cardId: "x", start: 0, end: 2 },
    { id: "H1", cardId: "y", start: 0, end: 2 }, { id: "H2", cardId: "y", start: 0, end: 2 },
  ] }] };
  const costs = [{ identityKey: "kl", stepMs: 9, kind: "random" }, { identityKey: "kh", stepMs: 99, capped: true, kind: "random" }];
  const identityKeys = { L1: "kl", L2: "kl", H1: "kh", H2: "kh" };
  const desk = planPipelines(project, costs, 30, { identityKeys });
  const online = planPipelines(project, costs, 30, { identityKeys, deadMs: SWAP_MS });
  assert.equal(desk.segments[0].light.size, 2, "Desktop DEAD_MS 0.3: both light cards fit (9+9+2×0.3 ≤ 23.3)");
  assert.equal(online.segments[0].light.size, 1, "Online swapMs 3: 9+9+2×3 > 23.3, one card is squeezed out");
});

/* ---------------------------------------------------------------- 按卡种的换帧成本(swap-tuning 任务 A) */

import { SWAP_MS_BY_KIND, swapCostOf, swapKindOf } from "./beatSwap.mjs";

test("ST-A-01 packing by accumulated per-layer cost: add each layer's own cost from top to bottom, every layer from the one that exceeds deadMs gets a placeholder", () => {
  const cost = { top: 2, lot: 20, can: 6, d1: 2, d2: 2 };
  // 30 fps:B = 23.333…;已占用 3.333… → deadMs 20
  const occupiedMs = budgetOf(30) - 20;
  const r = fitBeatSwaps({ fps: 30, occupiedMs, layers: ["top", "can", "d1", "d2", "lot"], costOf: (id) => cost[id] });
  assert.deepEqual(r.swap, ["top", "can", "d1", "d2"]);   // 2 + 6 + 2 + 2 = 12 ≤ 20;再加 20 超了
  assert.deepEqual(r.placeholder, ["lot"]);
  assert.equal(r.fit, 4);
  assert.equal(r.usedMs, 12);
  // 贵的层在上面:它装进去了,下面的就装不下
  const s = fitBeatSwaps({ fps: 30, occupiedMs, layers: ["lot", "top", "can"], costOf: (id) => cost[id] });
  assert.deepEqual(s.swap, ["lot"]);
  assert.deepEqual(s.placeholder, ["top", "can"]);
  // 同一输入结果稳定;层去重
  assert.deepEqual(fitBeatSwaps({ fps: 30, occupiedMs, layers: ["top", "can", "top", "d1", "d2", "lot"], costOf: (id) => cost[id] }), r);
});

test("ST-A-02 default fallback: if a layer cannot give a positive number (missing, 0, negative, NaN, throws) use swapMs, and if swapMs is also missing use SWAP_MS", () => {
  const bad = { a: undefined, b: 0, c: -1, d: NaN, e: "x" };
  const costOf = (id) => { if (id === "f") throw new Error("boom"); return bad[id]; };
  const layers = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // deadMs = B = 23.333…;每层按 SWAP_MS 3 → 7 层
  const r = fitBeatSwaps({ fps: 30, layers, costOf });
  assert.equal(r.fit, Math.floor(budgetOf(30) / SWAP_MS));
  assert.equal(r.fit, 7);
  // 给了 swapMs 就按 swapMs 兜底
  const s = fitBeatSwaps({ fps: 30, layers, costOf, swapMs: 10 });
  assert.equal(s.fit, 2);
  // 卡种认不出来 / 表里没有:按 SWAP_MS
  assert.equal(swapCostOf(null), SWAP_MS);
  assert.equal(swapCostOf(undefined), SWAP_MS);
  assert.equal(swapCostOf("nope"), SWAP_MS);
  assert.equal(swapCostOf("dom", { dom: 0 }), SWAP_MS, "A 0 in the table also falls back");
  assert.equal(swapCostOf("dom", undefined, 7), SWAP_MS_BY_KIND.dom);
  assert.equal(swapCostOf(null, undefined, 7), 7);
});

test("ST-A-03 legacy call compatibility: when only swapMs is given, results match floor(deadMs / swapMs) one by one (including exact division)", () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const swapMs of [0.3, 1, 2.5, 3, 3.5, 4, 7, 10]) {
      for (const occupiedMs of [0, 1, 3.333, 5.5, 10, 12, budgetOf(fps) - 12, budgetOf(fps) - 17.5, budgetOf(fps)]) {
        const layers = Array.from({ length: 40 }, (_, i) => `L${i}`);
        const r = fitBeatSwaps({ fps, occupiedMs, layers, swapMs });
        const want = Math.max(0, Math.floor(r.deadMs / swapMs + 1e-9));
        assert.equal(r.fit, Math.min(want, layers.length), `fps ${fps}, swapMs ${swapMs}, occupied ${occupiedMs}`);
        assert.deepEqual(r.swap, layers.slice(0, r.fit));
      }
    }
  }
  // costOf 回的和 swapMs 一样时,结果与旧调用相同
  const old = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["a", "b", "c", "d", "e"], swapMs: 3 });
  const per = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["a", "b", "c", "d", "e"], costOf: () => 3 });
  assert.deepEqual({ ...per, usedMs: undefined }, { ...old, usedMs: undefined });
});

test("ST-A-04 boundary: with budget 0 (used ≥ B) all layers get placeholders however cheap; when deadMs exactly equals one layer's cost, that layer fits", () => {
  const r = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30), layers: ["a", "b"], costOf: () => 0.01 });
  assert.equal(r.deadMs, 0);
  assert.deepEqual(r.swap, []);
  assert.deepEqual(r.placeholder, ["a", "b"]);
  const over = fitBeatSwaps({ fps: 60, occupiedMs: 1000, layers: ["a"], costOf: () => 1 });
  assert.equal(over.deadMs, 0);
  assert.equal(over.fit, 0);
  const exact = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 6, layers: ["can", "d"], costOf: (id) => (id === "can" ? 6 : 2) });
  assert.deepEqual(exact.swap, ["can"]);
  assert.deepEqual(exact.placeholder, ["d"]);
  // 没有层
  assert.deepEqual(fitBeatSwaps({ fps: 30, layers: [], costOf: () => 1 }), { swap: [], placeholder: [], deadMs: budgetOf(30), fit: 0, usedMs: 0 });
});

test("ST-A-05 only one layer fits; when the top layer alone does not fit, no layer is swapped (cheaper ones below do not skip past it)", () => {
  const cost = { big: 20, small: 2, mid: 6 };
  const one = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 7, layers: ["mid", "small", "big"], costOf: (id) => cost[id] });
  assert.deepEqual(one.swap, ["mid"]);
  assert.deepEqual(one.placeholder, ["small", "big"]);
  const none = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 7, layers: ["big", "small"], costOf: (id) => cost[id] });
  assert.deepEqual(none.swap, []);
  assert.deepEqual(none.placeholder, ["big", "small"]);
});

test("ST-A-06 card kinds: Lottie, canvas (particles, canvas contract, canvasHeavy), the rest DOM; cards not defined on the page and media effect cards are not recognized", () => {
  assert.equal(swapKindOf({ cardId: "lottie-adrock", known: true }), "lottie");
  assert.equal(swapKindOf({ cardId: "lottie", known: true }), "lottie");
  assert.equal(swapKindOf({ cardId: "particles-basic", known: true }), "canvas");
  assert.equal(swapKindOf({ cardId: "scene-3d", known: true, canvas: true }), "canvas");
  assert.equal(swapKindOf({ cardId: "x", known: true, canvasHeavy: true }), "canvas");
  assert.equal(swapKindOf({ cardId: "chapter-bar", known: true, source: "native" }), "dom");
  assert.equal(swapKindOf({ cardId: "mu-animated-shiny-text", known: true, source: "user" }), "dom", "User card declared as DOM");
  assert.equal(swapKindOf({ cardId: "u-canvas", known: true, source: "user", canvasHeavy: true }), "canvas");
  assert.equal(swapKindOf({ cardId: "synced-user-card", known: false, source: "user" }), null, "Code is not on this page: not recognized, falls back");
  assert.equal(swapKindOf({ cardId: null }), null, "Media effect card (only nodeId)");
  assert.equal(swapKindOf(undefined), null);
  // 表:三种都有正数;缺省 SWAP_MS 仍是 3(C10-BS-01)
  for (const k of ["dom", "lottie", "canvas"]) assert.ok(SWAP_MS_BY_KIND[k] > 0, k);
  assert.ok(SWAP_MS_BY_KIND.canvas > SWAP_MS_BY_KIND.dom && SWAP_MS_BY_KIND.lottie > SWAP_MS_BY_KIND.dom);
  assert.equal(SWAP_MS, 3);
  assert.ok(Object.isFrozen(SWAP_MS_BY_KIND));
});

test("ST-A-07 dispatch takes each clip's own fixed cost: a function with the same numbers as each card gives the same result; expensive heavy layers squeeze out more light cards", () => {
  const project = { tracks: [{ id: "t", clips: [
    { id: "L1", cardId: "x", start: 0, end: 2 }, { id: "L2", cardId: "x", start: 0, end: 2 },
    { id: "H1", cardId: "y", start: 0, end: 2 }, { id: "H2", cardId: "y", start: 0, end: 2 },
  ] }] };
  const costs = [{ identityKey: "kl", stepMs: 7, kind: "random" }, { identityKey: "kh", stepMs: 99, capped: true, kind: "random" }];
  const identityKeys = { L1: "kl", L2: "kl", H1: "kh", H2: "kh" };
  const byNumber = planPipelines(project, costs, 30, { identityKeys, deadMs: SWAP_MS });
  const byFn = planPipelines(project, costs, 30, { identityKeys, deadMs: () => SWAP_MS });
  assert.deepEqual([...byFn.segments[0].light], [...byNumber.segments[0].light]);
  // 7 + 7 + 2 × 2(两张 DOM 重层) = 18 ≤ 23.3:两张轻卡都装得下
  const cheap = planPipelines(project, costs, 30, { identityKeys, deadMs: () => 2 });
  assert.equal(cheap.segments[0].light.size, 2);
  // 两张 Lottie 重层各 20:7 + 40 > 23.3,一张轻卡都装不下
  const dear = planPipelines(project, costs, 30, { identityKeys, deadMs: (id) => (id.startsWith("H") ? 20 : 2) });
  assert.equal(dear.segments[0].light.size, 0);
  // 候选(轻卡)被挤出时,它自己的固定成本按它的卡种算:挤出 L2 后剩 H1 + H2 + L2 三张重层
  const mixed = planPipelines(project, costs, 30, { identityKeys, deadMs: (id) => ({ H1: 3, H2: 3, L1: 2, L2: 9 })[id] });
  // L1(7) + H1 3 + H2 3 + L2 9 = 22 ≤ 23.3 → L1 进;L1 + L2 (14) + 6 = 20 ≤ 23.3 → L2 也进
  assert.equal(mixed.segments[0].light.size, 2);
  // 函数回的不是非负数:按 DEAD_MS
  const junk = planPipelines(project, costs, 30, { identityKeys, deadMs: () => NaN });
  const desk = planPipelines(project, costs, 30, { identityKeys });
  assert.deepEqual([...junk.segments[0].light], [...desk.segments[0].light]);
});
