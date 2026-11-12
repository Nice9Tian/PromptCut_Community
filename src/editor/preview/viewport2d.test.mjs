/**
 * Unit tests for 2D preview zoom and pan. Run: node --test src/editor/preview/viewport2d.test.mjs
 *
 * The most critical item here is the **cursor anchor**: after zooming, the pixel under the cursor
 * must remain the same video pixel. Getting it wrong throws no error, but clicks become inaccurate:
 * clicking on a card selects the adjacent one, and this deviation cannot be seen in screenshots,
 * only felt by hand. So each case is pinned down.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  fitScale, fitView, frameOrigin, toStagePoint, clampPan, zoomAt, panBy,
  wheelZoomFactor, clampScale, MIN_SCALE, MAX_SCALE,
  MIN_FRAMED_ZOOM, MAX_FRAMED_ZOOM, framedFitScale, framedFitView,
  clampFramedZoom, clampFramedScale, clampFramedPan, framedZoomAt, framedPanBy,
  resizeFramedView, isFramedFitted, framedZoomRatio, framedZoomPercent,
} from "./viewport2d.ts";

const PROJECT = { width: 1920, height: 1080 };
const BOX = { width: 800, height: 600 };

test("Fit to window: the long side touches first, leaving a little margin all around", () => {
  // A 16:9 aspect ratio video placed into 800x600 hits width first: (800-16)/1920
  assert.equal(fitScale(PROJECT, BOX), (800 - 16) / 1920);
  // Hits height first in a narrow window
  assert.equal(fitScale(PROJECT, { width: 4000, height: 300 }), (300 - 16) / 1080);
  const v = fitView(PROJECT, BOX);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 0);
  assert.equal(v.auto, true, "After fit to window, the view must follow the window");
});

test("With no panning the picture is exactly centered, pixel-identical to before the panning feature existed", () => {
  const v = { scale: 0.25, tx: 0, ty: 0, auto: true };
  const o = frameOrigin(v, PROJECT, BOX);
  assert.equal(o.x, (800 - 1920 * 0.25) / 2);
  assert.equal(o.y, (600 - 1080 * 0.25) / 2);
  // The frame center is the window center
  assert.equal(o.x + (1920 * 0.25) / 2, 400);
  assert.equal(o.y + (1080 * 0.25) / 2, 300);
});

test("Window coordinates and picture coordinates convert back and forth", () => {
  const v = { scale: 0.3, tx: 37, ty: -19, auto: false };
  for (const pt of [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: 799, y: 42 }]) {
    const p = toStagePoint(v, PROJECT, BOX, pt);
    const o = frameOrigin(v, PROJECT, BOX);
    // Calculating backwards must return to the origin
    assert.ok(Math.abs(o.x + p.x * v.scale - pt.x) < 1e-9);
    assert.ok(Math.abs(o.y + p.y * v.scale - pt.y) < 1e-9);
  }
});

test("Cursor anchor: after zooming, the picture pixel under the cursor is still the same one", () => {
  const start = fitView(PROJECT, BOX);
  for (const cursor of [{ x: 400, y: 300 }, { x: 60, y: 80 }, { x: 780, y: 560 }]) {
    const before = toStagePoint(start, PROJECT, BOX, cursor);
    for (const f of [1.2, 2, 0.5, 1 / 1.2]) {
      const after = zoomAt(start, PROJECT, BOX, cursor, start.scale * f);
      const p = toStagePoint(after, PROJECT, BOX, cursor);
      assert.ok(
        Math.abs(p.x - before.x) < 0.01 && Math.abs(p.y - before.y) < 0.01,
        `Cursor ${JSON.stringify(cursor)} drifted after zooming by ${f}x: ${JSON.stringify(before)} → ${JSON.stringify(p)}`,
      );
    }
  }
});

test("Zooming in repeatedly and then zooming back out returns to the original view", () => {
  const cursor = { x: 250, y: 180 };
  const start = fitView(PROJECT, BOX);
  let v = start;
  for (let i = 0; i < 5; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale * 1.2);
  for (let i = 0; i < 5; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale / 1.2);
  assert.ok(Math.abs(v.scale - start.scale) < 1e-9, `Scale did not return: ${v.scale} vs ${start.scale}`);
  assert.ok(Math.abs(v.tx) < 0.01 && Math.abs(v.ty) < 0.01, `Offset did not return: ${v.tx}, ${v.ty}`);
});

test("Zoom has lower and upper limits, and hitting a limit does not shift the picture", () => {
  const cursor = { x: 100, y: 100 };
  let v = fitView(PROJECT, BOX);
  for (let i = 0; i < 60; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale * 1.2);
  assert.equal(v.scale, MAX_SCALE);
  for (let i = 0; i < 200; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale / 1.2);
  assert.equal(v.scale, MIN_SCALE);
  assert.equal(clampScale(1e9), MAX_SCALE);
  assert.equal(clampScale(0), MIN_SCALE);
});

test("Scrolling again at the limit leaves the view completely still (it must not drift silently)", () => {
  const cursor = { x: 700, y: 500 };
  let v = zoomAt(fitView(PROJECT, BOX), PROJECT, BOX, cursor, MAX_SCALE);
  const again = zoomAt(v, PROJECT, BOX, cursor, MAX_SCALE * 2);
  assert.deepEqual(again, v, "After hitting the upper limit, zooming in further must not change the offset either");
});

test("When scrolling changes nothing, it must not also turn off \"auto fit\" as a side effect", () => {
  /*
   * Window is so small that fit scale itself hits the lower limit: scrolling down further changes
   * nothing: it should not exit auto-fit because of this. "I scrolled, nothing changed on screen,
   * but resizing the window no longer auto-adapts" is the hardest kind of feel/UX bug to debug.
   */
  const tiny = { width: 30, height: 30 };
  const fit = fitView(PROJECT, tiny);
  assert.equal(fit.scale, MIN_SCALE, "This window is so small that the fit scale is already at the lower limit");
  const after = zoomAt(fit, PROJECT, tiny, { x: 15, y: 15 }, fit.scale / 1.2);
  assert.equal(after.auto, true, "No change must not exit auto fit");
  assert.deepEqual(after, fit);
});

test("Dragging: at least one piece stays in view, it cannot be dragged out", () => {
  const v = { scale: 0.4, tx: 0, ty: 0, auto: false };
  const far = panBy(v, PROJECT, BOX, 100000, 100000);
  const fw = 1920 * 0.4;
  // Left edge of the video should not cross 48px inward past the right edge of the window
  const o = frameOrigin(far, PROJECT, BOX);
  assert.ok(o.x <= BOX.width - 48 + 1e-6, `Dragged too far, left edge is at ${o.x}`);
  assert.ok(o.x + fw >= 48 - 1e-6);
  // Same for the opposite direction
  const back = panBy(v, PROJECT, BOX, -100000, -100000);
  const o2 = frameOrigin(back, PROJECT, BOX);
  assert.ok(o2.x + fw >= 48 - 1e-6, `Dragged too far in the opposite direction, right edge is at ${o2.x + fw}`);
});

test("Dragging accumulates, and small drags are not disturbed by the limit", () => {
  let v = { scale: 0.4, tx: 0, ty: 0, auto: true };
  v = panBy(v, PROJECT, BOX, 10, -5);
  assert.deepEqual([v.tx, v.ty], [10, -5]);
  v = panBy(v, PROJECT, BOX, 3, 2);
  assert.deepEqual([v.tx, v.ty], [13, -3]);
  assert.equal(v.auto, false, "After a manual drag it must no longer auto fit: otherwise any window resize would undo the drag");
});

test("Zooming and dragging both turn off \"auto fit\"", () => {
  const fit = fitView(PROJECT, BOX);
  assert.equal(fit.auto, true);
  assert.equal(zoomAt(fit, PROJECT, BOX, { x: 1, y: 1 }, 0.5).auto, false);
  assert.equal(panBy(fit, PROJECT, BOX, 1, 0).auto, false);
});

test("Wheel: up zooms in, down zooms out, and one up plus one down returns to 1", () => {
  assert.ok(wheelZoomFactor(-120) > 1, "Scrolling up should zoom in");
  assert.ok(wheelZoomFactor(120) < 1, "Scrolling down should zoom out");
  assert.ok(Math.abs(wheelZoomFactor(-120) * wheelZoomFactor(120) - 1) < 1e-12, "One up and one down must cancel out exactly");
  assert.ok(Math.abs(wheelZoomFactor(-120) - 1.2) < 1e-12);
  assert.equal(wheelZoomFactor(0), 1);
});

test("Wheel: devices that report in lines must be converted to pixels, otherwise the speed differs by a factor of ten or more", () => {
  // deltaMode 1 = by line, 16 pixels per line
  assert.ok(Math.abs(wheelZoomFactor(-7.5, 1) - wheelZoomFactor(-120, 0)) < 1e-12);
  // Even if the trackpad flings a huge value at once, it must not zoom all the way in one step
  assert.ok(wheelZoomFactor(-100000) <= Math.pow(1.2, 4) + 1e-12);
  assert.ok(wheelZoomFactor(100000) >= Math.pow(1.2, -4) - 1e-12);
});

test("The picture can be dragged even when it is smaller than the window, but not out of sight", () => {
  const v = { scale: 0.1, tx: 0, ty: 0, auto: false };  // 192x108, far smaller than 800x600
  const moved = panBy(v, PROJECT, BOX, 1000, 0);
  const o = frameOrigin(moved, PROJECT, BOX);
  assert.ok(o.x < BOX.width, "It must still be visible");
  assert.ok(o.x + 1920 * 0.1 >= 48 - 1e-6);
});

test("clampPan changes neither the zoom nor auto", () => {
  const v = { scale: 0.4, tx: 99999, ty: 0, auto: true };
  const c = clampPan(v, PROJECT, BOX);
  assert.equal(c.scale, 0.4);
  assert.equal(c.auto, true);
  assert.ok(c.tx < 99999);
});

/* ── Framed preview (Vibe mode Detail editing, issue #15) ─────────────────── */

const STAGE_BOX = { width: 640, height: 360 }; // 16:9 stage matching 1920×1080

function fittedBounds(project, box) {
  const fit = framedFitScale(project, box);
  const fw = project.width * fit;
  const fh = project.height * fit;
  return {
    left: (box.width - fw) / 2,
    top: (box.height - fh) / 2,
    right: (box.width + fw) / 2,
    bottom: (box.height + fh) / 2,
  };
}

function assertCoversFrame(view, project, box, msg = "") {
  const fb = fittedBounds(project, box);
  const o = frameOrigin(view, project, box);
  const right = o.x + project.width * view.scale;
  const bottom = o.y + project.height * view.scale;
  const eps = 1e-6;
  assert.ok(o.x <= fb.left + eps, `${msg} left edge pulled inside frame: ${o.x} > ${fb.left}`);
  assert.ok(right >= fb.right - eps, `${msg} right edge pulled inside frame: ${right} < ${fb.right}`);
  assert.ok(o.y <= fb.top + eps, `${msg} top edge pulled inside frame: ${o.y} > ${fb.top}`);
  assert.ok(bottom >= fb.bottom - eps, `${msg} bottom edge pulled inside frame: ${bottom} < ${fb.bottom}`);
}

test("Framed fit: starts at 100% with zero margin and exact four-edge alignment", () => {
  const v = framedFitView(PROJECT, STAGE_BOX);
  assert.equal(v.scale, 640 / 1920);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 0);
  assert.equal(v.auto, true);
  assert.equal(isFramedFitted(v, PROJECT, STAGE_BOX), true);
  assert.equal(framedZoomRatio(v, PROJECT, STAGE_BOX), 1);
  assert.equal(framedZoomPercent(v, PROJECT, STAGE_BOX), 100);
  const o = frameOrigin(v, PROJECT, STAGE_BOX);
  assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.y) < 1e-9);
  assert.ok(Math.abs(PROJECT.width * v.scale - STAGE_BOX.width) < 1e-9);
  assert.ok(Math.abs(PROJECT.height * v.scale - STAGE_BOX.height) < 1e-9);
});

test("Framed zoom-out floor: cannot zoom below 100%, and scrolling out at 100% keeps auto-fit intact", () => {
  const start = framedFitView(PROJECT, STAGE_BOX);
  for (const cursor of [{ x: 0, y: 0 }, { x: 320, y: 180 }, { x: 640, y: 360 }]) {
    const after = framedZoomAt(start, PROJECT, STAGE_BOX, cursor, start.scale * 0.5);
    assert.equal(after, start, "Zooming out while already fitted must be a no-op");
    assert.equal(after.auto, true);
    assert.equal(framedZoomPercent(after, PROJECT, STAGE_BOX), 100);
  }
  assert.equal(clampFramedZoom(0.1), MIN_FRAMED_ZOOM);
  assert.equal(clampFramedScale(0.001, PROJECT, STAGE_BOX), start.scale);
});

test("Framed cursor anchor: zooming in at any point inside the frame keeps the pixel under the cursor pinned", () => {
  const start = framedFitView(PROJECT, STAGE_BOX);
  const cursors = [
    { x: 320, y: 180 },
    { x: 0, y: 0 },
    { x: 640, y: 360 },
    { x: 48, y: 310 },
    { x: 590, y: 24 },
  ];
  for (const cursor of cursors) {
    const before = toStagePoint(start, PROJECT, STAGE_BOX, cursor);
    for (const factor of [1.2, 1.8, 3.5, 8]) {
      const zoomed = framedZoomAt(start, PROJECT, STAGE_BOX, cursor, start.scale * factor);
      const after = toStagePoint(zoomed, PROJECT, STAGE_BOX, cursor);
      assert.ok(
        Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01,
        `Cursor ${JSON.stringify(cursor)} drifted at ${factor}x: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
      assertCoversFrame(zoomed, PROJECT, STAGE_BOX, `zoom ${factor}x at ${JSON.stringify(cursor)}`);
    }
  }
});

test("Framed four-edge clamp: aggressive panning in all directions never pulls any video edge inside the frame", () => {
  const start = framedFitView(PROJECT, STAGE_BOX);
  // Panning at 100% is a no-op and preserves auto-fit
  const noMove = framedPanBy(start, PROJECT, STAGE_BOX, 500, -500);
  assert.equal(noMove, start);
  assert.equal(noMove.auto, true);

  // Zoom to 220% and fling in all 8 directions
  const zoomed = framedZoomAt(start, PROJECT, STAGE_BOX, { x: 320, y: 180 }, start.scale * 2.2);
  assert.equal(framedZoomPercent(zoomed, PROJECT, STAGE_BOX), 220);
  assert.equal(isFramedFitted(zoomed, PROJECT, STAGE_BOX), false);

  const deltas = [
    [100000, 0], [-100000, 0], [0, 100000], [0, -100000],
    [100000, 100000], [-100000, 100000], [100000, -100000], [-100000, -100000],
  ];
  for (const [dx, dy] of deltas) {
    const panned = framedPanBy(zoomed, PROJECT, STAGE_BOX, dx, dy);
    assertCoversFrame(panned, PROJECT, STAGE_BOX, `pan(${dx}, ${dy})`);
  }

  // Verify the exact left/right/top/bottom extremes can still be reached cleanly
  const farRight = framedPanBy(zoomed, PROJECT, STAGE_BOX, -100000, 0);
  const oRight = frameOrigin(farRight, PROJECT, STAGE_BOX);
  assert.ok(Math.abs(oRight.x + PROJECT.width * farRight.scale - STAGE_BOX.width) < 1e-6);

  const farLeft = framedPanBy(zoomed, PROJECT, STAGE_BOX, 100000, 0);
  const oLeft = frameOrigin(farLeft, PROJECT, STAGE_BOX);
  assert.ok(Math.abs(oLeft.x) < 1e-6);
});

test("Framed asymmetric zoom-in then zoom-out elsewhere never strands video outside the frame", () => {
  let v = framedFitView(PROJECT, STAGE_BOX);
  // Zoom in 6 notches at top-left corner
  for (let i = 0; i < 6; i++) {
    v = framedZoomAt(v, PROJECT, STAGE_BOX, { x: 12, y: 12 }, v.scale * 1.2);
    assertCoversFrame(v, PROJECT, STAGE_BOX, `in step ${i}`);
  }
  // Pan hard toward top-left, then zoom all the way back out at bottom-right corner
  v = framedPanBy(v, PROJECT, STAGE_BOX, 5000, 5000);
  assertCoversFrame(v, PROJECT, STAGE_BOX, "after hard pan");
  for (let i = 0; i < 10; i++) {
    v = framedZoomAt(v, PROJECT, STAGE_BOX, { x: 635, y: 355 }, v.scale / 1.2);
    assertCoversFrame(v, PROJECT, STAGE_BOX, `out step ${i}`);
  }
  assert.equal(framedZoomPercent(v, PROJECT, STAGE_BOX), 100);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 0);
  assert.equal(v.auto, true);
  assert.equal(isFramedFitted(v, PROJECT, STAGE_BOX), true);
});

test("Framed upper limit: caps at 800% without drifting when scrolling further", () => {
  const cursor = { x: 520, y: 290 };
  let v = framedFitView(PROJECT, STAGE_BOX);
  for (let i = 0; i < 40; i++) {
    v = framedZoomAt(v, PROJECT, STAGE_BOX, cursor, v.scale * 1.2);
  }
  assert.equal(framedZoomRatio(v, PROJECT, STAGE_BOX), MAX_FRAMED_ZOOM);
  assert.equal(framedZoomPercent(v, PROJECT, STAGE_BOX), 800);
  const again = framedZoomAt(v, PROJECT, STAGE_BOX, { x: 40, y: 40 }, v.scale * 2);
  assert.equal(again, v, "Scrolling past max zoom must not shift the pan offset");
});

test("Framed container resize: preserves relative zoom % and four-edge bounds across stage resizes", () => {
  const start = framedFitView(PROJECT, STAGE_BOX);
  // Auto-fitted view adapts directly to a larger or smaller stage
  const biggerBox = { width: 960, height: 540 };
  const autoResized = resizeFramedView(start, PROJECT, { project: PROJECT, box: STAGE_BOX }, biggerBox);
  assert.equal(autoResized.auto, true);
  assert.equal(framedZoomPercent(autoResized, PROJECT, biggerBox), 100);
  assertCoversFrame(autoResized, PROJECT, biggerBox, "auto resize");

  // Manually zoomed 250% view panned to bottom-right keeps 250% and stays inside frame on both shrink & grow
  let manual = framedZoomAt(start, PROJECT, STAGE_BOX, { x: 600, y: 340 }, start.scale * 2.5);
  manual = framedPanBy(manual, PROJECT, STAGE_BOX, -9000, -9000);
  assert.equal(framedZoomPercent(manual, PROJECT, STAGE_BOX), 250);

  const smallerBox = { width: 400, height: 225 };
  const shrunk = resizeFramedView(manual, PROJECT, { project: PROJECT, box: STAGE_BOX }, smallerBox);
  assert.equal(shrunk.auto, false);
  assert.equal(framedZoomPercent(shrunk, PROJECT, smallerBox), 250);
  assertCoversFrame(shrunk, PROJECT, smallerBox, "shrunk manual");

  const grown = resizeFramedView(shrunk, PROJECT, { project: PROJECT, box: smallerBox }, { width: 1280, height: 720 });
  assert.equal(grown.auto, false);
  assert.equal(framedZoomPercent(grown, PROJECT, { width: 1280, height: 720 }), 250);
  assertCoversFrame(grown, PROJECT, { width: 1280, height: 720 }, "grown manual");

  // Also works for portrait projects (e.g. 1080×1920) inside any box
  const portrait = { width: 1080, height: 1920 };
  const pBox = { width: 270, height: 480 };
  let pv = framedZoomAt(framedFitView(portrait, pBox), portrait, pBox, { x: 250, y: 450 }, (270 / 1080) * 1.75);
  pv = clampFramedPan({ ...pv, tx: -9999, ty: 9999 }, portrait, pBox);
  assertCoversFrame(pv, portrait, pBox, "portrait");
});
