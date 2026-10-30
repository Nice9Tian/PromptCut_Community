/**
 * 占位符的动画豁免(`pinAnimations.ts`)。跑:node --test src/render/pinAnimationsPlaceholder.test.mjs
 *
 * 占位组件的 CSS 动画(名字以 `pc-ph-` 开头,contract 的 `PLACEHOLDER_ANIMATION_PREFIX`)负责
 * 「来不及满 120 ms 才显示」和沙漏转动,它们按真实时间走;舞台的钉时间(整页 `sync`、子树 `syncIn`)
 * 要是把它们也钉住,暂停态虚拟时钟不动,占位符就永远停在不可见的第 0 毫秒。
 *
 * 对照:名字只是**像**(不以前缀开头)的卡片动画照样被钉 —— 豁免只认 `isPlaceholderAnimation`。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAnimationPinner } from "./pinAnimations.ts";
import { PLACEHOLDER_ANIMATION_PREFIX } from "./placeholder/contract.ts";

const wrap = { closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) };
function anim(props) {
  return {
    playState: "running",
    currentTime: null,
    effect: { target: { closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) }, getComputedTiming: () => ({ endTime: 10_000 }) },
    pause() { this.playState = "paused"; },
    finish() { this.playState = "finished"; },
    ...props,
  };
}

test("整页 sync 与子树 syncIn 都放过占位符自己的 CSS 动画", () => {
  const ph = anim({ animationName: `${PLACEHOLDER_ANIMATION_PREFIX}appear` });
  const phWaapi = anim({ id: `${PLACEHOLDER_ANIMATION_PREFIX}spin` });
  const p = createAnimationPinner({ getAnimations: () => [ph, phWaapi] });
  p.sync(500);
  p.syncIn({ getAnimations: () => [ph, phWaapi] }, 700);
  for (const a of [ph, phWaapi]) {
    assert.equal(a.playState, "running", "按真实时间走,不被暂停");
    assert.equal(a.currentTime, null, "不被拨时间");
  }
});

test("对照:名字不以前缀开头的卡片动画(哪怕含 ph)照样被钉", () => {
  const card = [anim({ animationName: "ph-appear" }), anim({ animationName: "card-pc-ph-x" }), anim({ id: "fade" }), anim({})];
  const p = createAnimationPinner({ getAnimations: () => card });
  p.sync(500);
  p.sync(700);
  for (const a of card) {
    assert.equal(a.playState, "paused");
    assert.equal(a.currentTime, 200);
  }
  const q = createAnimationPinner({ getAnimations: () => [] });
  const inner = anim({ animationName: "spin" });
  q.syncIn({ getAnimations: () => [inner] }, 100);
  assert.equal(inner.playState, "paused");
});
