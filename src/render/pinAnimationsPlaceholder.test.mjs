/**
 * Animation exemption for placeholders (`pinAnimations.ts`).
 * Run: node --test src/render/pinAnimationsPlaceholder.test.mjs
 *
 * CSS animations of placeholder components (names starting with `pc-ph-`, contract's
 * `PLACEHOLDER_ANIMATION_PREFIX`) handle "display only after 120 ms delay" and hourglass rotation,
 * which run in real time; if stage time pinning (full-page `sync`, subtree `syncIn`) also pins them,
 * the virtual clock does not advance in paused state, and placeholders stay at invisible 0 ms forever.
 *
 * Contrast: card animations whose names merely **look similar** (not starting with the prefix)
 * are still pinned: exemption only recognizes `isPlaceholderAnimation`.
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

test("both whole-page sync and subtree syncIn leave the placeholder's own CSS animations alone", () => {
  const ph = anim({ animationName: `${PLACEHOLDER_ANIMATION_PREFIX}appear` });
  const phWaapi = anim({ id: `${PLACEHOLDER_ANIMATION_PREFIX}spin` });
  const p = createAnimationPinner({ getAnimations: () => [ph, phWaapi] });
  p.sync(500);
  p.syncIn({ getAnimations: () => [ph, phWaapi] }, 700);
  for (const a of [ph, phWaapi]) {
    assert.equal(a.playState, "running", "runs on real time, not paused");
    assert.equal(a.currentTime, null, "time is not seeked");
  }
});

test("control: card animations whose name does not start with the prefix (even if it contains ph) are still pinned", () => {
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
