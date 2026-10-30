import { test } from "node:test";
import assert from "node:assert";
import { unitsFor, columnsFor, colWidth, tileHeight, masonry } from "./layout.ts";

test("unitsFor", () => {
  assert.strictEqual(unitsFor(216), 3);
  assert.strictEqual(unitsFor(360), 5);
  assert.strictEqual(unitsFor(432), 6);
  assert.strictEqual(unitsFor(100), 3); // max(3)
});

test("columnsFor", () => {
  assert.strictEqual(columnsFor("small_cube", 3), 3);
  assert.strictEqual(columnsFor("small_cube", 6), 6);
  assert.strictEqual(columnsFor("middle_cube", 3), 1);
  assert.strictEqual(columnsFor("middle_cube", 5), 2);
  assert.strictEqual(columnsFor("big_16_9", 3), 1);
  assert.strictEqual(columnsFor("big_16_9", 6), 2);
  assert.strictEqual(columnsFor("big_strip", 3), 1);
  assert.strictEqual(columnsFor("big_strip", 6), 2);
});

test("colWidth", () => {
  assert.strictEqual(colWidth(216, 3), (216 - 2 * 8) / 3);
  assert.strictEqual(colWidth(360, 5), (360 - 4 * 8) / 5);
  assert.strictEqual(colWidth(100, 1), 100);
});

test("tileHeight", () => {
  // small_cube
  assert.strictEqual(tileHeight("small_cube", 2, 1, 100), 100);
  assert.strictEqual(tileHeight("small_cube", undefined, 1, 100), 100);
  
  // middle_cube
  assert.strictEqual(tileHeight("middle_cube", undefined, 1, 100), 100);
  assert.strictEqual(tileHeight("middle_cube", 0.5, 1, 100), 100 * 0.75); // clamp 0.75
  assert.strictEqual(tileHeight("middle_cube", 2, 1, 100), 100 * 1.5); // clamp 1.5

  // big_strip
  assert.strictEqual(tileHeight("big_strip", 2, 1, 100), 56);
  assert.strictEqual(tileHeight("big_strip", undefined, 1, 100), 56);
});

test("tileHeight big_16_9 limits", () => {
  assert.strictEqual(tileHeight("big_16_9", undefined, 1, 100), 100 * (9 / 16));

  // 单列:横竖混排,竖屏最高到 4:3,居中裁掉上下
  assert.strictEqual(tileHeight("big_16_9", 2, 1, 100), 100 * (4 / 3));
  assert.strictEqual(tileHeight("big_16_9", 1000, 1, 100), 100 * (4 / 3)); // clamped to 4/3
  assert.strictEqual(tileHeight("big_16_9", 0.1, 1, 100), 100 * (9 / 21)); // lower bound 9/21
  
  // 多列:瀑布流,不同高度混排 (max 16/9)
  assert.strictEqual(tileHeight("big_16_9", 2, 2, 100), 100 * (16 / 9));
  assert.strictEqual(tileHeight("big_16_9", 0.1, 2, 100), 100 * (9 / 21));
});

test("masonry", () => {
  const result = masonry([100, 200, 50, 100], 2);
  // col0: 100, gap, 50 => total 158
  // col1: 200, gap, 100 => total 308
  assert.deepStrictEqual(result.items, [
    { col: 0, y: 0 },
    { col: 1, y: 0 },
    { col: 0, y: 108 },
    { col: 0, y: 166 },
  ]);
  assert.strictEqual(result.totalHeight, 274 - 8);

  // Tie break test (4 same heights, 2 columns)
  const resultTie = masonry([100, 100, 100, 100], 2);
  // first item -> col0 (both 0, picks 0)
  // second item -> col1 (col0 is 108, col1 is 0, picks 1)
  // third item -> col0 (col0 is 108, col1 is 108, picks 0)
  // fourth item -> col1
  assert.deepStrictEqual(resultTie.items, [
    { col: 0, y: 0 },
    { col: 1, y: 0 },
    { col: 0, y: 108 },
    { col: 1, y: 108 }
  ]);

  // Identical inputs -> Identical outputs
  const resultTie2 = masonry([100, 100, 100, 100], 2);
  assert.deepStrictEqual(resultTie.items, resultTie2.items);
});
