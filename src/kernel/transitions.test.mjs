// node --test src/kernel/transitions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  transitionsOfClip, groupOf, timingLock, checkCrossfade, checkFade, planTransitionDrop, fadeOwner, clampDur,
} = await import("./transitions.ts");

/** 一条序列、几段首尾相接的素材 */
function proj(clips, transitions = []) {
  return {
    version: 1, name: "t", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight",
    media: [{ id: "m1", kind: "video", name: "片段甲.mp4", url: "" }],
    tracks: [{ id: "tr1", name: "序列1", clips }],
    transitions,
  };
}
const clip = (id, start, end, extra = {}) => ({ id, cardId: "", start, end, params: {}, mediaId: "m1", ...extra });

test("groupOf:交叉溶解把 A—B—C 串成一组,淡入只锁自己", () => {
  const p = proj(
    [clip("a", 0, 3), clip("b", 3, 6), clip("c", 6, 9), clip("d", 9, 12)],
    [
      { id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 },
      { id: "t2", kind: "crossfade", aId: "b", bId: "c", dur: 0.5 },
      { id: "t3", kind: "fadeIn", aId: "d", dur: 0.5 },
    ],
  );
  const g = groupOf(p, "c");
  assert.deepEqual(g.members.sort(), ["a", "b", "c"]);
  assert.equal(g.transitions.length, 2);
  const solo = groupOf(p, "d");
  assert.deepEqual(solo.members, ["d"]);
  assert.equal(solo.transitions.length, 1);
});

test("timingLock:被锁的片段给出能直接照做的说明,没转场的返回 null", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(timingLock(p, "a")?.transitions.length, 1);
  assert.match(timingLock(p, "a").message, /remove_transition/);
  assert.match(timingLock(p, "a").message, /t1/);
  assert.equal(timingLock(proj([clip("a", 0, 3)]), "a"), null);
});

test("checkCrossfade:参数写反自己排序;不相接、太长、已有转场都拒绝并说清楚", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  const ok = checkCrossfade(p, "b", "a", 0.5); // 故意写反
  assert.equal(ok.ok, true);
  assert.equal(ok.a.id, "a");
  assert.equal(ok.b.id, "b");

  const far = proj([clip("a", 0, 3), clip("b", 5, 8)]);
  assert.match(checkCrossfade(far, "a", "b", 0.5).error, /空着 2.0 秒/);

  assert.match(checkCrossfade(p, "a", "b", 5).error, /比其中一段还长/);
  assert.match(checkCrossfade(p, "a", "a", 0.5).error, /两段不同/);
  assert.match(checkCrossfade(p, "a", "zz", 0.5).error, /找不到片段 zz/);

  const dup = proj([clip("a", 0, 3), clip("b", 3, 6), clip("c", 6, 9)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.match(checkCrossfade(dup, "b", "c", 0.5).error, /已经有交叉溶解/);
});

test("checkFade:重复加、比片段还长、那一端被交叉溶解占着都拒绝", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  assert.equal(checkFade(p, "a", "fadeIn", 0.5).ok, true);
  assert.match(checkFade(p, "a", "fadeIn", 9).error, /比这段本身还长/);

  const withFade = proj([clip("a", 0, 3)], [{ id: "t1", kind: "fadeIn", aId: "a", dur: 0.5 }]);
  assert.match(checkFade(withFade, "a", "fadeIn", 0.5).error, /已经有淡入/);
  // 同一段的淡出没被占,还能加
  assert.equal(checkFade(withFade, "a", "fadeOut", 0.5).ok, true);

  const xf = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.match(checkFade(xf, "b", "fadeIn", 0.5).error, /被交叉溶解占着/);
  // 交叉溶解占的是 b 的开头,b 的结尾还能淡出
  assert.equal(checkFade(xf, "b", "fadeOut", 0.5).ok, true);
});

test("fadeOwner:交叉溶解占着前一段的尾、后一段的头", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(fadeOwner(p, "a", "fadeOut")?.id, "t1");
  assert.equal(fadeOwner(p, "a", "fadeIn"), null);
  assert.equal(fadeOwner(p, "b", "fadeIn")?.id, "t1");
  assert.equal(fadeOwner(p, "b", "fadeOut"), null);
});

test("planTransitionDrop:接缝上是交叉溶解,两端是淡入淡出,中间什么都不加", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  assert.deepEqual(planTransitionDrop(p, "tr1", 3.05), { kind: "crossfade", aId: "a", bId: "b" });
  assert.deepEqual(planTransitionDrop(p, "tr1", 0.1), { kind: "fadeIn", aId: "a" });
  assert.deepEqual(planTransitionDrop(p, "tr1", 5.9), { kind: "fadeOut", aId: "b" });
  assert.equal(planTransitionDrop(p, "tr1", 1.5), null);
  assert.equal(planTransitionDrop(p, "没这条", 1), null);

  // 中间空着的两段:接缝不算接缝,落在 a 尾部就是淡出
  const far = proj([clip("a", 0, 3), clip("b", 5, 8)]);
  assert.deepEqual(planTransitionDrop(far, "tr1", 3.0), { kind: "fadeOut", aId: "a" });
});

test("clampDur:超范围夹住,不是数就用兜底值", () => {
  assert.equal(clampDur(0.5), 0.5);
  assert.equal(clampDur(0), 0.1);
  assert.equal(clampDur(99), 10);
  assert.equal(clampDur("x", 0.7), 0.7);
});

test("transitionsOfClip:两头都算,没有 transitions 字段也不炸", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(transitionsOfClip(p, "b").length, 1);
  const bare = { ...proj([clip("a", 0, 3)]) };
  delete bare.transitions;
  assert.deepEqual(transitionsOfClip(bare, "a"), []);
});
