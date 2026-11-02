// node --test src/kernel/transitions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  transitionsOfClip, groupOf, timingLock, checkCrossfade, checkFade, planTransitionDrop, fadeOwner, clampDur,
} = await import("./transitions.ts");

/** One track, several end-to-end assets */
function proj(clips, transitions = []) {
  return {
    version: 1, name: "t", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight",
    media: [{ id: "m1", kind: "video", name: "Clip A.mp4", url: "" }],
    tracks: [{ id: "tr1", name: "Track 1", clips }],
    transitions,
  };
}
const clip = (id, start, end, extra = {}) => ({ id, cardId: "", start, end, params: {}, mediaId: "m1", ...extra });

test("groupOf: a crossfade chains A-B-C into one group, a fade-in locks only itself", () => {
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

test("timingLock: a locked clip gets instructions that can be followed directly, and one without a transition returns null", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(timingLock(p, "a")?.transitions.length, 1);
  assert.match(timingLock(p, "a").message, /remove_transition/);
  assert.match(timingLock(p, "a").message, /t1/);
  assert.equal(timingLock(proj([clip("a", 0, 3)]), "a"), null);
});

test("checkCrossfade: reversed arguments are sorted automatically; non-adjacent, too long, or already having a transition are all rejected with a clear explanation", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  const ok = checkCrossfade(p, "b", "a", 0.5); // Intentionally inverted
  assert.equal(ok.ok, true);
  assert.equal(ok.a.id, "a");
  assert.equal(ok.b.id, "b");

  const far = proj([clip("a", 0, 3), clip("b", 5, 8)]);
  assert.match(checkCrossfade(far, "a", "b", 0.5).error, /There is a 2\.0s gap/);

  assert.match(checkCrossfade(p, "a", "b", 5).error, /longer than one of the clips/);
  assert.match(checkCrossfade(p, "a", "a", 0.5).error, /two different clips/);
  assert.match(checkCrossfade(p, "a", "zz", 0.5).error, /Clip zz not found/);

  const dup = proj([clip("a", 0, 3), clip("b", 3, 6), clip("c", 6, 9)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.match(checkCrossfade(dup, "b", "c", 0.5).error, /already has a crossfade/);
});

test("checkFade: adding twice, longer than the clip, and an end occupied by a crossfade are all rejected", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  assert.equal(checkFade(p, "a", "fadeIn", 0.5).ok, true);
  assert.match(checkFade(p, "a", "fadeIn", 9).error, /longer than the clip itself/);

  const withFade = proj([clip("a", 0, 3)], [{ id: "t1", kind: "fadeIn", aId: "a", dur: 0.5 }]);
  assert.match(checkFade(withFade, "a", "fadeIn", 0.5).error, /already has a fade in/);
  // Fade-out of the same clip is not occupied, can still be added
  assert.equal(checkFade(withFade, "a", "fadeOut", 0.5).ok, true);

  const xf = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.match(checkFade(xf, "b", "fadeIn", 0.5).error, /already taken by a crossfade/);
  // Crossfade occupies the start of b, the end of b can still fade out
  assert.equal(checkFade(xf, "b", "fadeOut", 0.5).ok, true);
});

test("fadeOwner: a crossfade occupies the tail of the previous clip and the head of the next clip", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(fadeOwner(p, "a", "fadeOut")?.id, "t1");
  assert.equal(fadeOwner(p, "a", "fadeIn"), null);
  assert.equal(fadeOwner(p, "b", "fadeIn")?.id, "t1");
  assert.equal(fadeOwner(p, "b", "fadeOut"), null);
});

test("planTransitionDrop: a crossfade on the seam, fade-in and fade-out at the two ends, nothing added in the middle", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)]);
  assert.deepEqual(planTransitionDrop(p, "tr1", 3.05), { kind: "crossfade", aId: "a", bId: "b" });
  assert.deepEqual(planTransitionDrop(p, "tr1", 0.1), { kind: "fadeIn", aId: "a" });
  assert.deepEqual(planTransitionDrop(p, "tr1", 5.9), { kind: "fadeOut", aId: "b" });
  assert.equal(planTransitionDrop(p, "tr1", 1.5), null);
  assert.equal(planTransitionDrop(p, "No such entry", 1), null);

  // Two clips with a gap in between: the seam is not counted as a seam, falling at the tail of a is
  // simply a fade-out
  const far = proj([clip("a", 0, 3), clip("b", 5, 8)]);
  assert.deepEqual(planTransitionDrop(far, "tr1", 3.0), { kind: "fadeOut", aId: "a" });
});

test("clampDur: clamp when out of range, use the fallback value when not a number", () => {
  assert.equal(clampDur(0.5), 0.5);
  assert.equal(clampDur(0), 0.1);
  assert.equal(clampDur(99), 10);
  assert.equal(clampDur("x", 0.7), 0.7);
});

test("transitionsOfClip: both ends count, and a missing transitions field does not blow up", () => {
  const p = proj([clip("a", 0, 3), clip("b", 3, 6)], [{ id: "t1", kind: "crossfade", aId: "a", bId: "b", dur: 0.5 }]);
  assert.equal(transitionsOfClip(p, "b").length, 1);
  const bare = { ...proj([clip("a", 0, 3)]) };
  delete bare.transitions;
  assert.deepEqual(transitionsOfClip(bare, "a"), []);
});
