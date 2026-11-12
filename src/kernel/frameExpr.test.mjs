import test from "node:test";
import assert from "node:assert/strict";

import {
  FRAME_EXPR_KEYS,
  validateFrameExpr,
  normalizeFrameExprMap,
  mergeFrameExpr,
  hasFrameExpr,
  has3DFrameExpr,
  hasAnimatedFrameSize,
  stripOuterFrameExpr,
  resolveClipFrameAt,
} from "./frameExpr.mjs";
import { frameIdentity } from "../../server/frame-identity.mjs";
import { assertNo3dOnMedia } from "./envelope.ts";

test("resolveClipFrameAt evaluates deterministic t/d/p expressions and clamps out-of-range localT", () => {
  const staticFrame = { x: 100, y: 50, w: 640, h: 360, scale: 1, rotate: 0, translateZ: -200 };
  const frameExpr = {
    x: "100 + 400 * p",
    y: "50 + 10 * t",
    scale: "1 + 0.5 * p",
    rotateY: "-30 + 60 * p",
    translateZ: "-200 - 300 * (t / d)",
  };

  const atStart = resolveClipFrameAt(staticFrame, frameExpr, 0, 4);
  assert.equal(atStart.x, 100);
  assert.equal(atStart.y, 50);
  assert.equal(atStart.w, 640);
  assert.equal(atStart.h, 360);
  assert.equal(atStart.scale, 1);
  assert.equal(atStart.rotate, 0);
  assert.equal(atStart.rotateY, -30);
  assert.equal(atStart.translateZ, -200);

  const atMid = resolveClipFrameAt(staticFrame, frameExpr, 2, 4);
  assert.equal(atMid.x, 300);
  assert.equal(atMid.y, 70);
  assert.equal(atMid.scale, 1.25);
  assert.equal(atMid.rotateY, 0);
  assert.equal(atMid.translateZ, -350);

  const atEnd = resolveClipFrameAt(staticFrame, frameExpr, 4, 4);
  assert.equal(atEnd.x, 500);
  assert.equal(atEnd.y, 90);
  assert.equal(atEnd.scale, 1.5);
  assert.equal(atEnd.rotateY, 30);
  assert.equal(atEnd.translateZ, -500);

  // Out-of-bounds localT clamps deterministically to [0, d]
  assert.deepEqual(resolveClipFrameAt(staticFrame, frameExpr, -5, 4), atStart);
  assert.deepEqual(resolveClipFrameAt(staticFrame, frameExpr, 99, 4), atEnd);
});

test("resolveClipFrameAt returns exact reference when frameExpr is absent or empty", () => {
  const frame = { x: 12, y: 34 };
  assert.equal(resolveClipFrameAt(frame, undefined, 1.2, 5), frame);
  assert.equal(resolveClipFrameAt(frame, {}, 1.2, 5), frame);
  assert.equal(resolveClipFrameAt(undefined, undefined, 1.2, 5), undefined);
});

test("validateFrameExpr and normalizeFrameExprMap reject invalid syntax, unknown vars, unknown keys, and non-positive sizes", () => {
  assert.equal(FRAME_EXPR_KEYS.length, 9);
  assert.equal(validateFrameExpr(" 1920 * p ", "x"), "1920 * p");

  assert.throws(() => validateFrameExpr("100 +", "x"), /invalid expression/i);
  assert.throws(() => validateFrameExpr("unknownVar * 2", "x"), /invalid expression/i);
  assert.throws(() => validateFrameExpr("p * 10", "opacity"), /does not recognize "opacity"/i);
  assert.throws(() => validateFrameExpr("0", "w"), /greater than 0/i);
  assert.throws(() => validateFrameExpr("-100", "h"), /greater than 0/i);
  assert.throws(() => validateFrameExpr("1 - 2 * p", "scale"), /greater than 0/i);
  assert.throws(() => validateFrameExpr("1 / 0", "x"), /evaluated to Infinity/i);

  assert.equal(normalizeFrameExprMap(null), undefined);
  assert.equal(normalizeFrameExprMap({ x: "", y: null }), undefined);
  assert.deepEqual(normalizeFrameExprMap({ x: " 100 * p ", rotate: "45 * p" }), {
    x: "100 * p",
    rotate: "45 * p",
  });
});

test("mergeFrameExpr clears keys overridden by numeric values or explicit null", () => {
  const initial = { x: "100 * p", y: "200 * p", translateZ: "-400 * p" };
  const afterNumericX = mergeFrameExpr(initial, undefined, ["x"]);
  assert.deepEqual(afterNumericX, { y: "200 * p", translateZ: "-400 * p" });

  const afterPatch = mergeFrameExpr(afterNumericX, { y: null, rotateX: "15 * sin(p * 3.14159)" }, []);
  assert.deepEqual(afterPatch, {
    translateZ: "-400 * p",
    rotateX: "15 * sin(p * 3.14159)",
  });
  assert.equal(mergeFrameExpr(afterPatch, null), undefined);
});

test("has3DFrameExpr, hasAnimatedFrameSize, and stripOuterFrameExpr classify inner vs outer expressions", () => {
  const outerOnly = { x: "100 * p", translateZ: "-500 * p" };
  assert.equal(hasFrameExpr(outerOnly), true);
  assert.equal(has3DFrameExpr(outerOnly), true);
  assert.equal(hasAnimatedFrameSize(outerOnly), false);
  assert.equal(stripOuterFrameExpr(outerOnly), undefined);

  const withSize = { x: "100 * p", w: "640 + 200 * p" };
  assert.equal(has3DFrameExpr(withSize), false);
  assert.equal(hasAnimatedFrameSize(withSize), true);
  assert.deepEqual(stripOuterFrameExpr(withSize), { w: "640 + 200 * p" });
});

test("frameIdentity includes frameExpr in cache/invalidation keys", () => {
  const baseProj = {
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 4,
    themeId: "editorial-dark",
    media: [],
    tracks: [
      {
        id: "t1",
        name: "Track 1",
        clips: [{ id: "c1", cardId: "title-card", start: 0, end: 4, params: { title: "A" }, frame: { x: 0, y: 0 } }],
      },
    ],
    cuts: [{ id: "cut-1", name: "Cut 1" }],
    activeCutId: "cut-1",
  };

  const withExpr = {
    ...baseProj,
    tracks: [
      {
        ...baseProj.tracks[0],
        clips: [{ ...baseProj.tracks[0].clips[0], frameExpr: { x: "600 * p" } }],
      },
    ],
  };

  assert.notEqual(frameIdentity(baseProj), frameIdentity(withExpr));
});

test("assertNo3dOnMedia allows 3D frameExpr on media clips inside a 3D cut and rejects it in a 2D cut", () => {
  const mediaClip = { id: "m1", mediaId: "asset-1", cardId: "", start: 0, end: 4, params: {} };
  assert.throws(
    () => assertNo3dOnMedia(mediaClip, undefined, { cutKind: "2d", frameExpr: { translateZ: "-400 * p" } }),
    /only works on cards/i,
  );

  assert.doesNotThrow(() =>
    assertNo3dOnMedia(mediaClip, undefined, { cutKind: "3d", frameExpr: { translateZ: "-400 * p", x: "120 * p" } }),
  );
});
