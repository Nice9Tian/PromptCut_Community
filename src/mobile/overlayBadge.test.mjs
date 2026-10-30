/**
 * 手机版片段上的叠加卡角标(`overlayBadge.ts`,语义 `workflow/editing.md`「手机版界面」)。
 *
 * 要守住的是最后那一档:名字都挤没了的时候角标不吃点击 —— 它几乎就是整个片段,
 * 用户多半是想选中这一段,手指一歪却进了叠加卡。那一档的入口是子导航里的「叠加层」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OVM_TAP_PX, OVM_WIDE_PX, planOverlayBadge } from "./overlayBadge.ts";

test("没挂东西就不画角标", () => {
  assert.equal(planOverlayBadge(200, 0), null);
  assert.equal(planOverlayBadge(20, 0), null);
});

test("够宽写「叠加 N」", () => {
  assert.deepEqual(planOverlayBadge(OVM_WIDE_PX, 2), { text: "叠加 2", tappable: true });
});

test("窄一些只写数字,还点得动", () => {
  assert.deepEqual(planOverlayBadge(OVM_WIDE_PX - 1, 3), { text: "3", tappable: true });
  assert.deepEqual(planOverlayBadge(OVM_TAP_PX, 3), { text: "3", tappable: true });
});

test("最窄那一档不吃点击,整块热区归片段", () => {
  assert.deepEqual(planOverlayBadge(OVM_TAP_PX - 1, 1), { text: "1", tappable: false });
  // 线上片段最窄 18px(FullTimeline 的 Math.max(..., 18)),那一档一定落在这里
  assert.equal(planOverlayBadge(18, 1).tappable, false);
});

test("两位数也写得下", () => {
  assert.equal(planOverlayBadge(300, 12).text, "叠加 12");
  assert.equal(planOverlayBadge(80, 12).text, "12");
});
