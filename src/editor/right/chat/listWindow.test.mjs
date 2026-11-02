/**
 * Pure functions for chat history list windowing: height accounting, visible area calculation,
 * render plan (placeholder height), stick-to-bottom determination.
 * Run: node --test src/editor/right/chat/listWindow.test.mjs
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

test("Prefix offsets: a gap between every two items, and the total height excludes the last gap", () => {
  const off = prefixOffsets([100, 50, 30], 12);
  assert.deepEqual(off, [0, 112, 174, 216]);
  assert.equal(contentHeight(off, 12), 204);
  assert.equal(contentHeight(prefixOffsets([], 12), 12), 0);
  // Negative heights other than NaN are treated as 0, and will not cause offset to regress
  assert.deepEqual(prefixOffsets([-5, 10], 0), [0, 0, 10]);
});

test("Visible range: items that intersect the interval; a boundary that falls inside a gap does not count", () => {
  const off = prefixOffsets([100, 100, 100, 100], 10); // Items: [0,100) [110,210) [220,320) [330,430)
  assert.deepEqual(rangeInView(off, 0, 100, 10), { first: 0, last: 1 });
  assert.deepEqual(rangeInView(off, 50, 150, 10), { first: 0, last: 2 });
  // Top edge is exactly in the gap: item 0 has completely scrolled out
  assert.deepEqual(rangeInView(off, 105, 215, 10), { first: 1, last: 2 });
  // The entire interval falls within the gap: empty interval
  const r = rangeInView(off, 101, 109, 10);
  assert.equal(r.first, r.last);
  // Past the end
  assert.deepEqual(rangeInView(off, 1000, 1200, 10), { first: 4, last: 4 });
});

test("Window: when pinned to the bottom, compute as scrolled to the bottom, ignoring the scrollTop passed in", () => {
  const heights = new Array(2000).fill(100);
  const off = prefixOffsets(heights, LIST_GAP);
  const r = windowRange(off, { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 });
  assert.equal(r.last, 2000);
  // Visible 600 + margin 300: at most about (600 + 300) / 112 + 1 items upward
  assert.ok(r.last - r.first <= 10, JSON.stringify(r));
  assert.ok(r.last - r.first >= 6, JSON.stringify(r));
});

test("Window: in the middle, extend a margin above and below; the item count is capped", () => {
  const heights = new Array(2000).fill(20);
  const off = prefixOffsets(heights, LIST_GAP);
  const mid = LIST_PAD + off[1000];
  const r = windowRange(off, { scrollTop: mid, clientHeight: 600, stick: false }, { overscan: 600, maxEntries: 44 });
  assert.ok(r.first < 1000 && r.last > 1000 + 600 / 32, JSON.stringify(r));
  // The visible area itself has about 19 items; adding margin would far exceed 44, capped
  assert.equal(r.last - r.first, 44);
  // Expand top and bottom margins alternately: roughly symmetric on both sides
  const up = 1000 - r.first;
  const visible = rangeInView(off, mid - LIST_PAD, mid - LIST_PAD + 600, LIST_GAP);
  const down = r.last - visible.last;
  assert.ok(Math.abs(up - down) <= 1, JSON.stringify({ up, down, r, visible }));
});

test("Window: when the viewport itself exceeds the limit, the viewport is not truncated", () => {
  const heights = new Array(500).fill(4);
  const off = prefixOffsets(heights, 0);
  const r = windowRange(off, { scrollTop: 0, clientHeight: 400, stick: false }, { overscan: 100, maxEntries: 10, gap: 0, pad: 0 });
  assert.equal(r.first, 0);
  assert.equal(r.last, 100);
});

test("Window: empty list, content shorter than the viewport", () => {
  assert.deepEqual(windowRange([0], { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 }), { first: 0, last: 0 });
  const off = prefixOffsets([50, 50, 50]);
  assert.deepEqual(windowRange(off, { scrollTop: 0, clientHeight: 600, stick: true }, { overscan: 300 }), { first: 0, last: 3 });
});

test("Render plan: placeholder height = the items it stands for + the gaps between them, and the overall total height matches full rendering", () => {
  const heights = [100, 40, 60, 80, 30, 70];
  const off = prefixOffsets(heights, 12);
  const segs = planSegments(off, 2, 4, [], 12);
  assert.deepEqual(segs, [
    { kind: "spacer", from: 0, to: 2, height: 100 + 12 + 40 },
    { kind: "item", index: 2 },
    { kind: "item", index: 3 },
    { kind: "spacer", from: 4, to: 6, height: 30 + 12 + 70 },
  ]);
  // flex gap is added between every two adjacent child elements: sum of child element heights +
  // (child count - 1) * gap should equal the total height of a full render
  const childHeights = segs.map((s) => (s.kind === "spacer" ? s.height : heights[s.index]));
  const total = childHeights.reduce((a, b) => a + b, 0) + (childHeights.length - 1) * 12;
  assert.equal(total, contentHeight(off, 12));
});

test("Render plan: force-rendered items (streaming ones, focused ones) sit between placeholders", () => {
  const heights = new Array(10).fill(10);
  const off = prefixOffsets(heights, 0);
  const segs = planSegments(off, 2, 4, [9, 0, 3], 0);
  assert.deepEqual(
    segs.map((s) => (s.kind === "item" ? s.index : `[${s.from},${s.to}):${s.height}`)),
    [0, "[1,2):10", 2, 3, "[4,9):50", 9],
  );
  // Out-of-bounds forced index is ignored
  assert.deepEqual(planSegments(off, 0, 0, [-1, 10], 0), [{ kind: "spacer", from: 0, to: 10, height: 100 }]);
  // All inside the window: no placeholder
  assert.ok(planSegments(off, 0, 10, [], 0).every((s) => s.kind === "item"));
});

test("Pinned-to-bottom check: within 40px of the bottom counts as at the bottom", () => {
  assert.equal(isAtBottom(1000, 400, 600), true);
  assert.equal(isAtBottom(1000, 360, 600), true);
  assert.equal(isAtBottom(1000, 359, 600), false);
  assert.equal(isAtBottom(500, 0, 600), true);
});

test("Recently touched items: deduplicated, the newest goes last, the oldest is dropped when over the limit", () => {
  let l = [];
  for (const k of ["a", "b", "c", "a", "d"]) l = touchRecent(l, k, 3);
  assert.deepEqual(l, ["c", "a", "d"]);
});

test("Height bookkeeping: measured values take priority; once the estimates of the same kind reach freezeAfter items they are fixed to the average and no longer change", () => {
  const book = new HeightBook({ user: 60, assistant: 200 }, 3);
  assert.equal(book.get("x", "user"), 60);
  assert.equal(book.set("a", "user", 100), true);
  assert.equal(book.set("a", "user", 100.3), false); // Within half a pixel does not count as a change
  assert.equal(book.set("b", "user", 300), true);
  assert.equal(book.get("a", "user"), 100);
  // Only measured 2 items: still use default value
  assert.equal(book.estimate("user"), 60);
  book.set("c", "user", 200);
  // Measured a full 3 items: set to average value 200
  assert.equal(book.estimate("user"), 200);
  assert.equal(book.get("x", "user"), 200);
  // Subsequent measurements or changing height of the same item no longer change the estimated value
  book.set("d", "user", 1000);
  book.set("a", "user", 10);
  assert.equal(book.estimate("user"), 200);
  // Other classes are not affected
  assert.equal(book.get("t", "assistant"), 200);
  assert.equal(book.get("t", "time"), 100);
  book.prune(new Set(["d"]));
  assert.equal(book.size, 1);
  assert.equal(book.measured("a"), undefined);
  assert.equal(book.measured("d"), 1000);
  // Invalid height is not recorded
  assert.equal(book.set("z", "user", NaN), false);
  assert.equal(book.set("z", "user", -1), false);
});

test("Windowing gate: up to 150 items are rendered in full (in-page find keeps working), windowing starts only above that", () => {
  assert.equal(WINDOW_MIN_ENTRIES, 150);
  assert.equal(shouldWindow(0), false);
  assert.equal(shouldWindow(40), false);
  assert.equal(shouldWindow(150), false);
  assert.equal(shouldWindow(151), true);
  assert.equal(shouldWindow(2000), true);
});
