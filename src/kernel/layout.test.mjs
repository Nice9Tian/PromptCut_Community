/**
 * kernel/layout.ts 的单测。跑:node --test src/kernel/layout.test.mjs
 *
 * 这是「Agent 说的位置」到「屏幕上的像素」之间唯一的一道换算。它算错不会报错,
 * 只会让卡片出现在别的地方,而且 world/local 两边一旦不自洽,Agent 会拿到
 * 两个互相矛盾的答案还不知道信哪个。所以钉死:
 *   - 没有 frame 时输出和以前逐字节一样(老项目的导出基线不能动);
 *   - 锚点语义:x,y 是锚点的位置,不是左上角;
 *   - world 和 local 在卡片级恒等,反解是 round-trip;
 *   - 校验的错误信息说人话,而且不能让坏值溜进 frame。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFrame, frameBox, worldOf, localFromWorld, framePatchFromArgs, frameCss,
  visualBox, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame,
  clampToStage, rectForSafeSide,
} from "./layout.ts";

const STAGE = { width: 1920, height: 1080 };

test("No frame: fills the stage, CSS is the same as before: inset:0, no transform", () => {
  assert.deepEqual(frameBox(undefined, STAGE), { left: 0, top: 0, width: 1920, height: 1080 });
  assert.deepEqual(frameCss(undefined, STAGE), { position: "absolute", inset: 0 });
});

test("No frame but a trajectory is bound: as before, with just an extra translate + willChange", () => {
  assert.deepEqual(frameCss(undefined, STAGE, { dx: 10, dy: -4 }), {
    position: "absolute",
    inset: 0,
    transform: "translate(10px, -4px)",
    willChange: "transform",
  });
});

test("Anchor semantics: x,y is the anchor position. A center anchor placed at 960,540 means centered", () => {
  const box = frameBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] }, STAGE);
  assert.deepEqual(box, { left: 760, top: 440, width: 400, height: 200 });
});

test("A bottom-right anchor snaps to the bottom-right corner of the stage", () => {
  const box = frameBox({ x: 1920, y: 1080, w: 300, h: 100, anchor: [1, 1] }, STAGE);
  assert.deepEqual(box, { left: 1620, top: 980, width: 300, height: 100 });
});

test("Omitting w/h means the stage size; omitting anchor means the top-left corner", () => {
  // 三维那三项的默认值也一起钉住:它们必须默认为 0,否则「没开三维的项目渲染不变」这条就破了
  assert.deepEqual(resolveFrame({ x: 100, y: 50 }, STAGE), {
    x: 100, y: 50, w: 1920, h: 1080, anchor: [0, 0], scale: 1, rotate: 0,
    rotateX: 0, rotateY: 0, translateZ: 0,
  });
  assert.deepEqual(frameBox({ x: 100, y: 50 }, STAGE), { left: 100, top: 50, width: 1920, height: 1080 });
});

test("CSS: transform-origin is at the anchor, identity scale/rotate are not written into transform", () => {
  const css = frameCss({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] }, STAGE);
  assert.equal(css.transformOrigin, "50% 50%");
  assert.equal(css.transform, undefined, "scale 1 / rotate 0 should not produce a transform property");
  assert.equal(css.left, 760);
  assert.equal(css.top, 440);
});

test("CSS: the trajectory translation comes first, then scale, then rotate", () => {
  const css = frameCss({ x: 0, y: 0, scale: 2, rotate: 15 }, STAGE, { dx: 10, dy: 20 });
  assert.equal(css.transform, "translate(10px, 20px) scale(2) rotate(15deg)");
  assert.equal(css.transformOrigin, "0% 0%");
  assert.equal(css.willChange, "transform");
});

test("world and local are identical at card level, box is consistent", () => {
  const frame = { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] };
  const w = worldOf(frame, STAGE);
  assert.equal(w.x, 960);
  assert.equal(w.y, 540);
  assert.deepEqual(w.anchor, [0.5, 0.5]);
  assert.deepEqual(w.box, frameBox(frame, STAGE));
});

test("world → local inverse solve is a round-trip", () => {
  const w = { x: 123, y: 456, anchor: [1, 0] };
  assert.deepEqual(localFromWorld(w, STAGE), w);
});

test("framePatchFromArgs: returns only the fields that were passed", () => {
  assert.deepEqual(framePatchFromArgs({ x: 5 }, STAGE), { x: 5 });
  assert.deepEqual(framePatchFromArgs({ anchor: [0.5, 1], scale: 0.5 }, STAGE), { anchor: [0.5, 1], scale: 0.5 });
  assert.deepEqual(framePatchFromArgs({ space: "world", x: 1, y: 2 }, STAGE), { x: 1, y: 2 });
});

test("framePatchFromArgs: bad values must not slip through, and error messages are in plain language", () => {
  assert.throws(() => framePatchFromArgs({}, STAGE), /at least/);
  assert.throws(() => framePatchFromArgs({ x: NaN }, STAGE), /x must be a finite number/);
  assert.throws(() => framePatchFromArgs({ x: "1" }, STAGE), /x must be a finite number/);
  assert.throws(() => framePatchFromArgs({ scale: 0 }, STAGE), /scale must be greater than 0/);
  assert.throws(() => framePatchFromArgs({ w: -1 }, STAGE), /w must be greater than 0/);
  assert.throws(() => framePatchFromArgs({ anchor: [0.5] }, STAGE), /anchor must be two numbers/);
  assert.throws(() => framePatchFromArgs({ anchor: "center" }, STAGE), /anchor must be two numbers/);
});

/* ---------- visualBox:判遮挡要看的那个框 ---------- */

test("visualBox: equals box when there is no scale and no rotation", () => {
  const f = { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] };
  assert.deepEqual(visualBox(f, STAGE), frameBox(f, STAGE));
});

test("visualBox: scales around the anchor, the anchor stays fixed, the size scales proportionally", () => {
  const vb = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], scale: 0.5 }, STAGE);
  assert.deepEqual(vb, { left: 860, top: 490, width: 200, height: 100 });
});

test("visualBox: after scaling with a right-side anchor, the right edge still sits on the anchor", () => {
  const vb = visualBox({ x: 1880, y: 540, w: 400, h: 200, anchor: [1, 0.5], scale: 0.5 }, STAGE);
  assert.equal(vb.left + vb.width, 1880);
  assert.equal(vb.width, 200);
});

test("visualBox: a 90° rotation swaps width and height (within floating-point error)", () => {
  const vb = visualBox({ x: 0, y: 0, w: 400, h: 200, rotate: 90 }, STAGE);
  assert.ok(Math.abs(vb.width - 200) < 1e-9 && Math.abs(vb.height - 400) < 1e-9);
});

/* ---------- set_rect ---------- */

test("rectToFrame fit (default): the canvas stays unchanged, is scaled to fit into the rectangle, and is centered", () => {
  const f = rectToFrame({ x1: 0, y1: 270, x2: 960, y2: 810 }, {}, undefined, STAGE);
  assert.deepEqual(f, { x: 480, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], scale: 0.5 });
  // 缩放后的可见框正好落在矩形里
  assert.deepEqual(visualBox(f, STAGE), { left: 0, top: 270, width: 960, height: 540 });
});

test("rectToFrame fit: when the aspect ratios differ, the smaller scale is used, so it does not overflow", () => {
  const f = rectToFrame({ x1: 0, y1: 0, x2: 960, y2: 1080 }, {}, undefined, STAGE);
  assert.equal(f.scale, 0.5);
  const vb = visualBox(f, STAGE);
  assert.ok(vb.left >= 0 && vb.left + vb.width <= 960 && vb.top >= 0 && vb.top + vb.height <= 1080);
});

test("rectToFrame canvas: the canvas is the rectangle, scale resets to 1", () => {
  const f = rectToFrame({ x1: 960, y1: 810, x2: 0, y2: 270 }, { mode: "canvas" }, { scale: 3, rotate: 5, x: 0, y: 0 }, STAGE);
  assert.deepEqual(f, { x: 480, y: 540, w: 960, h: 540, anchor: [0.5, 0.5], scale: 1, rotate: 5 });
});

test("rectToFrame: the order of the diagonal points does not matter; align decides which side of the rectangle it sits on", () => {
  const f = rectToFrame({ x1: 960, y1: 810, x2: 0, y2: 270 }, { align: [0, 1] }, undefined, STAGE);
  assert.equal(f.x, 0);
  assert.equal(f.y, 810);
  assert.deepEqual(f.anchor, [0, 1]);
});

test("rectToFrame: a bad rectangle and a bad mode are rejected outright", () => {
  assert.throws(() => rectToFrame({ x1: 10, y1: 10, x2: 10, y2: 500 }, {}, undefined, STAGE), /positive width and height/);
  assert.throws(() => rectToFrame({ x1: "a", y1: 0, x2: 1, y2: 1 }, {}, undefined, STAGE), /x1 must be a finite number/);
  assert.throws(() => rectToFrame({ x1: 0, y1: 0, x2: 1, y2: 1 }, { mode: "stretch" }, undefined, STAGE), /mode must be/);
});

/* ---------- align ---------- */

test("alignToFrame: bottom-right + margin, the anchor follows to the bottom-right", () => {
  const f = alignToFrame("right", "bottom", 40, { w: 400, h: 200, x: 0, y: 0 }, STAGE);
  assert.deepEqual(f, { w: 400, h: 200, x: 1880, y: 1040, anchor: [1, 1] });
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left + vb.width, 1880);
  assert.equal(vb.top + vb.height, 1040);
});

test("alignToFrame: with only h passed, the vertical direction stays put", () => {
  const prev = { x: 100, y: 333, w: 400, h: 200, anchor: [0.5, 0.25] };
  const f = alignToFrame("center", undefined, 0, prev, STAGE);
  assert.equal(f.x, 960);
  assert.equal(f.y, 333);
  assert.deepEqual(f.anchor, [0.5, 0.25]);
});

test("alignToFrame: when a scaled card is snapped to an edge, the visible frame is what counts", () => {
  const f = alignToFrame("left", "top", 20, { x: 0, y: 0, scale: 0.5 }, STAGE);
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left, 20);
  assert.equal(vb.top, 20);
  assert.equal(vb.width, 960);
});

test("alignToFrame: passing nothing / passing garbage is rejected", () => {
  assert.throws(() => alignToFrame(undefined, undefined, 0, undefined, STAGE), /at least/);
  assert.throws(() => alignToFrame("middle", undefined, 0, undefined, STAGE), /h must be/);
  assert.throws(() => alignToFrame("left", undefined, NaN, undefined, STAGE), /margin must be a finite number/);
});

test("alignIsInvisible: true only when it fills the stage and is not scaled down; scaled, or a smaller canvas, is false", () => {
  assert.equal(alignIsInvisible(undefined, STAGE), true);
  assert.equal(alignIsInvisible({ x: 0, y: 0, scale: 0.9 }, STAGE), false);
  assert.equal(alignIsInvisible({ x: 0, y: 0, w: 800, h: 400 }, STAGE), false);
});

/* ---------- nudge ---------- */

test("nudgeFrame: position adds pixels, scale multiplies, rotation adds degrees, and anything not passed stays put", () => {
  const prev = { x: 100, y: 200, anchor: [0.5, 0.5], scale: 2, rotate: 10 };
  assert.deepEqual(nudgeFrame({ dx: 50, dy: -20 }, prev, STAGE), { ...prev, x: 150, y: 180 });
  assert.deepEqual(nudgeFrame({ scaleBy: 0.5 }, prev, STAGE), { ...prev, scale: 1 });
  assert.deepEqual(nudgeFrame({ rotateBy: -10 }, prev, STAGE), { ...prev, rotate: 0 });
});

test("nudgeFrame: a card without a frame can also be nudged, starting from filling the whole screen", () => {
  assert.deepEqual(nudgeFrame({ dx: 30 }, undefined, STAGE), { x: 30, y: 0 });
});

/* ---------- clamp ---------- */

test("clampToStage: if it goes past the right/bottom edge it is moved back, with the visible frame snapped to the edge", () => {
  const f = clampToStage({ x: 1800, y: 1000, w: 400, h: 200, anchor: [0, 0] }, STAGE);
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left + vb.width, 1920);
  assert.equal(vb.top + vb.height, 1080);
});

test("clampToStage: if it goes past the left/top edge it is moved back the same way; if it is inside it stays put", () => {
  const f = clampToStage({ x: -50, y: -20, w: 400, h: 200 }, STAGE);
  assert.deepEqual([f.x, f.y], [0, 0]);
  const inside = { x: 100, y: 100, w: 400, h: 200 };
  assert.deepEqual(clampToStage(inside, STAGE), inside);
});

test("clampToStage: computed from the scaled visible frame, not from the canvas", () => {
  // 画布 1920 宽、缩到 0.5 后 960 宽,锚点在中心放到 x=1700 → 可见框右缘 2180,要挪回 260
  const f = clampToStage({ x: 1700, y: 540, anchor: [0.5, 0.5], scale: 0.5 }, STAGE);
  assert.equal(f.x, 1440);
  assert.equal(visualBox(f, STAGE).left + visualBox(f, STAGE).width, 1920);
});

test("clampToStage: a frame larger than the stage cannot be clamped back and is left as is", () => {
  const f = clampToStage({ x: -100, y: 0, w: 2500, h: 500 }, STAGE);
  assert.equal(f.x, -100);
});

/* ---------- 主体检测 → 矩形 ---------- */

test("rectForSafeSide: left/right is a half screen, top/bottom is a 1/3 band, with margins left", () => {
  assert.deepEqual(rectForSafeSide("left", STAGE, 40), { x1: 40, y1: 40, x2: 920, y2: 1040 });
  assert.deepEqual(rectForSafeSide("right", STAGE, 40), { x1: 1000, y1: 40, x2: 1880, y2: 1040 });
  assert.deepEqual(rectForSafeSide("top", STAGE, 40), { x1: 40, y1: 40, x2: 1880, y2: 320 });
  assert.deepEqual(rectForSafeSide("bottom", STAGE, 40), { x1: 40, y1: 760, x2: 1880, y2: 1040 });
  assert.throws(() => rectForSafeSide("middle", STAGE), /safeSide must be/);
});

test("The rectangle from rectForSafeSide fed to rectToFrame puts the visible frame on that side", () => {
  const f = rectToFrame(rectForSafeSide("left", STAGE, 40), {}, undefined, STAGE);
  const vb = visualBox(f, STAGE);
  assert.ok(vb.left >= 40 && vb.left + vb.width <= 920);
});

test("nudgeFrame: empty calls and non-positive multipliers are both rejected", () => {
  assert.throws(() => nudgeFrame({}, undefined, STAGE), /at least/);
  assert.throws(() => nudgeFrame({ scaleBy: 0 }, undefined, STAGE), /scaleBy is a multiplier/);
  assert.throws(() => nudgeFrame({ dx: "5" }, undefined, STAGE), /dx must be a finite number/);
});

/*
 * 三维。硬要求是**没用到三维的项目,输出一个字节都不变** ——
 * 老项目的导出有逐像素基线,哪怕多一个恒等变换都可能让合成器换一条光栅路径。
 */
test("3D: when none of the three fields is set, transform is exactly as before and preserve-3d is not added", () => {
  const before = frameCss({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], scale: 2, rotate: 15 }, STAGE);
  assert.equal(before.transform, "scale(2) rotate(15deg)");
  assert.equal(before.transformStyle, undefined, "A 3D rendering context should not be created when 3D is not used");
});

test("3D: translateZ / rotateX / rotateY are each written into transform", () => {
  const css = frameCss({ x: 0, y: 0, translateZ: 120, rotateX: 20, rotateY: -35 }, STAGE);
  assert.match(css.transform, /translateZ\(120px\)/);
  assert.match(css.transform, /rotateX\(20deg\)/);
  assert.match(css.transform, /rotateY\(-35deg\)/);
});

test("3D comes before scale/rotate: lay out within the plane first, then place the whole card into space", () => {
  const css = frameCss({ x: 0, y: 0, translateZ: 100, rotateY: 30, scale: 2, rotate: 10 }, STAGE);
  assert.equal(css.transform, "translateZ(100px) rotateY(30deg) scale(2) rotate(10deg)");
  // 反过来的话倾斜会被后面的缩放拉伸,用户调 scale 时会发现透视跟着变形
  assert.ok(css.transform.indexOf("rotateY") < css.transform.indexOf("scale"));
});

test("3D: preserve-3d is added only when used, because it only governs the inside of the card; when unused, nothing is written", () => {
  assert.equal(frameCss({ x: 0, y: 0, translateZ: 1 }, STAGE).transformStyle, "preserve-3d");
  assert.equal(frameCss({ x: 0, y: 0, rotateX: 1 }, STAGE).transformStyle, "preserve-3d");
  assert.equal(frameCss({ x: 0, y: 0, rotateY: 1 }, STAGE).transformStyle, "preserve-3d");
  assert.equal(frameCss({ x: 0, y: 0, scale: 3, rotate: 90 }, STAGE).transformStyle, undefined);
});

test("3D: the old path without a frame is completely untouched", () => {
  assert.deepEqual(frameCss(undefined, STAGE), { position: "absolute", inset: 0 });
});

/*
 * 三维下的 visualBox / clamp。
 *
 * 这里出错不会报任何错,只会让两个判断悄悄给出平面时代的答案:
 *   - clamp:true 以为卡片还在画面里,什么都不做,卡片其实已经飞出去了;
 *   - get_layout 返回的 visualBox 和屏幕上实际占的地方对不上,Agent 据此判遮挡会判错。
 */
test("3D: visualBox uses perspective projection, so pushing toward the viewer makes it bigger, and the farther from the picture center, the further out of bounds it is pushed", () => {
  const stage = { width: 1920, height: 1080 };
  const flat = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] }, stage, 40);
  assert.equal(Math.round(flat.width), 400, "There should be no change at z=0");

  // 相机距离 d = 1080 / (2·tan20°) ≈ 1483.6;推到 z=700,放大 d/(d−700) ≈ 1.893
  const near = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], translateZ: 700 }, stage, 40);
  assert.ok(Math.abs(near.width - 400 * 1.893) < 4, `Should scale up to ≈757, got ${near.width}`);

  const far = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], translateZ: -700 }, stage, 40);
  assert.ok(far.width < 400, `Pushing inward should shrink it, got ${far.width}`);
});

test("3D: clamp must really snap to the edge, and must not overshoot in either direction", () => {
  const stage = { width: 1920, height: 1080 };
  const edge = (f) => { const vb = visualBox(f, stage, 40); return vb.left + vb.width; };

  /*
   * 越界量是在**投影后**量的,x 存的是投影前的 —— 差一个 d/(d−z) 倍。
   * 不换算的话:z 为负挪不够(夹完还在画外),z 为正挪过头(被拽到大半屏之外)。
   * 这条测试当初只测了 z 为正、断言又只写了 right <= 1920.5,过冲照样通过,所以没抓到。
   */
  for (const z of [-800, -300, 0, 300, 700]) {
    const frame = { x: 2400, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], ...(z ? { translateZ: z } : null) };
    const c = clampToStage(frame, stage, 40);
    const right = edge(c);
    assert.ok(right <= 1920.5, `z=${z}: still out of frame after clamping, the right edge is at ${right}`);
    assert.ok(right >= 1919.5, `z=${z}: clamped too far, the right edge only reaches ${right}, it should touch 1920`);
    // 幂等:再夹一次不该再动
    const again = clampToStage(c, stage, 40);
    assert.ok(Math.abs(again.x - c.x) < 0.01, `z=${z}: clamping again moved it again, ${c.x} → ${again.x}`);
  }
});

test("3D: without fov, clamp is bit-for-bit identical to before (the old pure-2D path must not change)", () => {
  const stage = { width: 1920, height: 1080 };
  for (const frame of [
    { x: 2400, y: 540, w: 800, h: 450, anchor: [0.5, 0.5] },
    { x: -300, y: 900, w: 400, h: 200, anchor: [0.5, 0.5], scale: 1.4, rotate: 20 },
    { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] },
  ]) {
    const c = clampToStage(frame, stage);
    const vb = visualBox(c, stage);
    assert.ok(vb.left >= -0.5 && vb.left + vb.width <= stage.width + 0.5, `Not clamped back: ${JSON.stringify(vb)}`);
  }
});

test("3D: when clamp cannot pull it back (larger than the stage after projection), it is returned as is, not moved arbitrarily", () => {
  const stage = { width: 1920, height: 1080 };
  const d = 1080 / (2 * Math.tan((40 * Math.PI) / 360));
  const frame = { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], translateZ: d + 500 };
  assert.equal(clampToStage(frame, stage, 40).x, 960);
});
test("3D: without a camera, rotateY is just an affine squash, and visualBox must still be computed truthfully", () => {
  const stage = { width: 1920, height: 1080 };
  const vb = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], rotateY: 60 }, stage);
  // cos60° = 0.5,宽压成一半;没有透视所以高度不变
  assert.ok(Math.abs(vb.width - 200) < 0.5, `Should squash to 200, got ${vb.width}`);
  assert.ok(Math.abs(vb.height - 200) < 0.5, `Height should not change, got ${vb.height}`);
});

test("3D: when a card is pushed behind the camera, give a very large but finite frame, never NaN / Infinity", () => {
  const stage = { width: 1920, height: 1080 };
  const d = 1080 / (2 * Math.tan((40 * Math.PI) / 360));
  const vb = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], translateZ: d + 500 }, stage, 40);
  assert.ok(Number.isFinite(vb.width) && Number.isFinite(vb.left), `Must not produce NaN/Infinity: ${JSON.stringify(vb)}`);
  assert.ok(vb.width > stage.width, "For a card past the camera plane, the frame should be big enough that the problem is obvious at a glance");
  // 比舞台还大的框 clampToStage 本来就不夹,所以不会被拉出个荒唐的位置
  const clamped = clampToStage({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], translateZ: d + 500 }, stage, 40);
  assert.equal(clamped.x, 960);
});

test("3D: world should not gain rotateX / rotateY / translateZ (they are local quantities before projection)", () => {
  const w = worldOf({ x: 10, y: 20, w: 100, h: 50, rotateY: 30 }, { width: 1920, height: 1080 }, 40);
  assert.deepEqual(Object.keys(w).sort(), ["anchor", "box", "h", "rotate", "scale", "visualBox", "w", "x", "y"]);
});
