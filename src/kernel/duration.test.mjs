/**
 * 总时长规则的单测。跑:node --test src/kernel/duration.test.mjs
 *
 * 钉的是 product/project-model.md「总时长」那一条:缺省等于内容末尾、跟着内容走;
 * 可以手动截短,不能拉长到内容末尾之后;空项目保留原值。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { contentEndOf, effectiveDuration, manualDurationFor } from "./duration.ts";

const clip = (id, start, end) => ({ id, cardId: "x", start, end, params: {} });

test("内容末尾跨轨道取最大值,没有片段是 0", () => {
  assert.equal(contentEndOf([]), 0);
  assert.equal(contentEndOf([{ id: "t", name: "t", clips: [] }]), 0);
  assert.equal(contentEndOf([
    { id: "a", name: "a", clips: [clip("c1", 0, 5)] },
    { id: "b", name: "b", clips: [clip("c2", 3, 18.5), clip("c3", 1, 2)] },
  ]), 18.5);
});

test("没截断时总时长就是内容末尾:加内容撑长,删内容缩短", () => {
  assert.equal(effectiveDuration(12, 30, null), 12, "删剩 12 秒,时长缩回 12,不留片尾黑");
  assert.equal(effectiveDuration(42.5, 30, null), 42.5, "内容铺到 42.5,时长跟着撑长,不切掉");
});

test("截断后总时长停在手动值,但不超过内容末尾", () => {
  assert.equal(effectiveDuration(40, 40, 25), 25);
  assert.equal(effectiveDuration(20, 25, 25), 20, "内容删到比截断点还短,就跟内容");
});

test("空项目保留原值,不塌成 0", () => {
  assert.equal(effectiveDuration(0, 30, null), 30);
  assert.equal(effectiveDuration(0, 30, 10), 30);
});

test("比内容末尾短才记成截断;等于或更长就回到跟内容走", () => {
  assert.equal(manualDurationFor(25, 40), 25);
  assert.equal(manualDurationFor(40, 40), null, "等于内容末尾不算截断");
  assert.equal(manualDurationFor(90, 40), null, "拉不长,也不留下会挡住以后新内容的上限");
  assert.equal(manualDurationFor(60, 0), null, "空项目设时长不算截断,之后加内容照常跟着走");
});

test("设了拉长的值,之后再加内容仍然跟着走", () => {
  const manual = manualDurationFor(90, 40);
  assert.equal(effectiveDuration(40, 40, manual), 40);
  assert.equal(effectiveDuration(120, 40, manual), 120, "没有被 90 挡住");
});
