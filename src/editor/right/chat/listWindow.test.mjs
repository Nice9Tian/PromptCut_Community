/**
 * 聊天记录列表窗口化的纯函数:高度记账、可见区计算、渲染计划(占位高度)、贴底判定。
 * 跑:node --test src/editor/right/chat/listWindow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  prefixOffsets,
  contentHeight,
  rangeInView,
  windowRange,
  planSegments,
  isAtBottom,
  touchRecent,
  HeightBook,
  shouldWindow,
  WINDOW_MIN_ENTRIES,
  LIST_GAP,
  LIST_PAD,
} from "./listWindow.ts";

test("前缀偏移:每条之间隔 gap,总高不含最后一个 gap", () => {
  const off = prefixOffsets([100, 50, 30], 12);
  assert.deepEqual(off, [0, 112, 174, 216]);
  assert.equal(contentHeight(off, 12), 204);
  assert.equal(contentHeight(prefixOffsets([], 12), 12), 0);
  // 负数、NaN 以外的负高度按 0 算,不会让偏移倒退
  assert.deepEqual(prefixOffsets([-5, 10], 0), [0, 0, 10]);
});

test("可见区:和区间有交集的条,边界落在 gap 里不算", () => {
  const off = prefixOffsets([100, 100, 100, 100], 10); // 条:[0,100) [110,210) [220,320) [330,430)
  assert.deepEqual(rangeInView(off, 0, 100, 10), { first: 0, last: 1 });
  assert.deepEqual(rangeInView(off, 50, 150, 10), { first: 0, last: 2 });
  // 顶边正好在 gap 里:第 0 条已经整个滚出去了
  assert.deepEqual(rangeInView(off, 105, 215, 10), { first: 1, last: 2 });
  // 整个区间落在 gap 里:空区间
  const r = rangeInView(off, 101, 109, 10);
  assert.equal(r.first, r.last);
  // 超出末尾
  assert.deepEqual(rangeInView(off, 1000, 1200, 10), { first: 4, last: 4 });
});

test("窗口:贴底时按滚到底算,不看传进来的 scrollTop", () => {
  const heights = new Array(2000).fill(100);
  const off = prefixOffsets(heights, LIST_GAP);
  const r = windowRange(off, { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 });
  assert.equal(r.last, 2000);
  // 可视 600 + 余量 300:最多往上 (600 + 300) / 112 + 1 条左右
  assert.ok(r.last - r.first <= 10, JSON.stringify(r));
  assert.ok(r.last - r.first >= 6, JSON.stringify(r));
});

test("窗口:中间位置,上下各扩余量;条数封顶", () => {
  const heights = new Array(2000).fill(20);
  const off = prefixOffsets(heights, LIST_GAP);
  const mid = LIST_PAD + off[1000];
  const r = windowRange(off, { scrollTop: mid, clientHeight: 600, stick: false }, { overscan: 600, maxEntries: 44 });
  assert.ok(r.first < 1000 && r.last > 1000 + 600 / 32, JSON.stringify(r));
  // 可视区本身约 19 条;加上余量会远超 44,被封顶
  assert.equal(r.last - r.first, 44);
  // 上下余量交替扩:两边大致对称
  const up = 1000 - r.first;
  const visible = rangeInView(off, mid - LIST_PAD, mid - LIST_PAD + 600, LIST_GAP);
  const down = r.last - visible.last;
  assert.ok(Math.abs(up - down) <= 1, JSON.stringify({ up, down, r, visible }));
});

test("窗口:可视区本身超过上限时不截可视区", () => {
  const heights = new Array(500).fill(4);
  const off = prefixOffsets(heights, 0);
  const r = windowRange(off, { scrollTop: 0, clientHeight: 400, stick: false }, { overscan: 100, maxEntries: 10, gap: 0, pad: 0 });
  assert.equal(r.first, 0);
  assert.equal(r.last, 100);
});

test("窗口:空列表、内容比可视区矮", () => {
  assert.deepEqual(windowRange([0], { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 }), { first: 0, last: 0 });
  const off = prefixOffsets([50, 50, 50]);
  assert.deepEqual(windowRange(off, { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 }), { first: 0, last: 3 });
});

test("渲染计划:占位高度 = 代表的几条 + 它们之间的 gap,整体总高与全渲染一致", () => {
  const heights = [100, 40, 60, 80, 30, 70];
  const off = prefixOffsets(heights, 12);
  const segs = planSegments(off, 2, 4, [], 12);
  assert.deepEqual(segs, [
    { kind: "spacer", from: 0, to: 2, height: 100 + 12 + 40 },
    { kind: "item", index: 2 },
    { kind: "item", index: 3 },
    { kind: "spacer", from: 4, to: 6, height: 30 + 12 + 70 },
  ]);
  // flex 的 gap 加在每两个相邻子元素之间:子元素高度之和 + (子元素数 - 1) * gap 应等于全渲染的总高
  const childHeights = segs.map((s) => (s.kind === "spacer" ? s.height : heights[s.index]));
  const total = childHeights.reduce((a, b) => a + b, 0) + (childHeights.length - 1) * 12;
  assert.equal(total, contentHeight(off, 12));
});

test("渲染计划:强制渲染的条(流式中的、有焦点的)夹在占位中间", () => {
  const heights = new Array(10).fill(10);
  const off = prefixOffsets(heights, 0);
  const segs = planSegments(off, 2, 4, [9, 0, 3], 0);
  assert.deepEqual(
    segs.map((s) => (s.kind === "item" ? s.index : `[${s.from},${s.to}):${s.height}`)),
    [0, "[1,2):10", 2, 3, "[4,9):50", 9],
  );
  // 越界的强制下标忽略
  assert.deepEqual(planSegments(off, 0, 0, [-1, 10], 0), [{ kind: "spacer", from: 0, to: 10, height: 100 }]);
  // 全在窗口里:没有占位
  assert.ok(planSegments(off, 0, 10, [], 0).every((s) => s.kind === "item"));
});

test("贴底判定:离底部不超过 40px 算在底部", () => {
  assert.equal(isAtBottom(1000, 400, 600), true);
  assert.equal(isAtBottom(1000, 360, 600), true);
  assert.equal(isAtBottom(1000, 359, 600), false);
  assert.equal(isAtBottom(500, 0, 600), true);
});

test("最近动过的几条:去重、新的放最后、超过上限丢最早的", () => {
  let l = [];
  for (const k of ["a", "b", "c", "a", "d"]) l = touchRecent(l, k, 3);
  assert.deepEqual(l, ["c", "a", "d"]);
});

test("高度记账:实测优先;估计值同类量满 freezeAfter 条时定成平均值,之后不再变", () => {
  const book = new HeightBook({ user: 60, assistant: 200 }, 3);
  assert.equal(book.get("x", "user"), 60);
  assert.equal(book.set("a", "user", 100), true);
  assert.equal(book.set("a", "user", 100.3), false); // 半像素以内不算变
  assert.equal(book.set("b", "user", 300), true);
  assert.equal(book.get("a", "user"), 100);
  // 只量了 2 条:还用缺省值
  assert.equal(book.estimate("user"), 60);
  book.set("c", "user", 200);
  // 量满 3 条:定成平均值 200
  assert.equal(book.estimate("user"), 200);
  assert.equal(book.get("x", "user"), 200);
  // 之后再量、同一条改高度,估计值都不再变
  book.set("d", "user", 1000);
  book.set("a", "user", 10);
  assert.equal(book.estimate("user"), 200);
  // 别的类不受影响
  assert.equal(book.get("t", "assistant"), 200);
  assert.equal(book.get("t", "time"), 100);
  book.prune(new Set(["d"]));
  assert.equal(book.size, 1);
  assert.equal(book.measured("a"), undefined);
  assert.equal(book.measured("d"), 1000);
  // 非法高度不记
  assert.equal(book.set("z", "user", NaN), false);
  assert.equal(book.set("z", "user", -1), false);
});

test("窗口化门槛:150 条以内全渲染(页内查找照旧可用),超过才窗口化", () => {
  assert.equal(WINDOW_MIN_ENTRIES, 150);
  assert.equal(shouldWindow(0), false);
  assert.equal(shouldWindow(40), false);
  assert.equal(shouldWindow(150), false);
  assert.equal(shouldWindow(151), true);
  assert.equal(shouldWindow(2000), true);
});
