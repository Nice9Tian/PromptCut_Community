/**
 * 2D 预览缩放平移的单测。跑:node --test src/editor/preview/viewport2d.test.mjs
 *
 * 这里最要紧的一条是**光标锚点**:缩放之后光标底下还得是同一个画面像素。
 * 错了不会报错,只会「点不准」——点在卡片上选中的是旁边那张,而这种偏差
 * 在截图里看不出来,只有手上才觉得别扭。所以逐条钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  fitScale, fitView, frameOrigin, toStagePoint, clampPan, zoomAt, panBy,
  wheelZoomFactor, clampScale, MIN_SCALE, MAX_SCALE,
} from "./viewport2d.ts";

const PROJECT = { width: 1920, height: 1080 };
const BOX = { width: 800, height: 600 };

test("适应窗口:长边先顶到,四周留一点空", () => {
  // 宽高比 16:9 的画面放进 800x600,先顶到宽:(800-16)/1920
  assert.equal(fitScale(PROJECT, BOX), (800 - 16) / 1920);
  // 窄窗口里先顶到高
  assert.equal(fitScale(PROJECT, { width: 4000, height: 300 }), (300 - 16) / 1080);
  const v = fitView(PROJECT, BOX);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 0);
  assert.equal(v.auto, true, "适应窗口之后要跟着窗口走");
});

test("不平移时画面正好在正中 —— 和以前没有平移功能时逐像素一致", () => {
  const v = { scale: 0.25, tx: 0, ty: 0, auto: true };
  const o = frameOrigin(v, PROJECT, BOX);
  assert.equal(o.x, (800 - 1920 * 0.25) / 2);
  assert.equal(o.y, (600 - 1080 * 0.25) / 2);
  // 画框中心就是窗口中心
  assert.equal(o.x + (1920 * 0.25) / 2, 400);
  assert.equal(o.y + (1080 * 0.25) / 2, 300);
});

test("窗口坐标 ↔ 画面坐标能来回换算", () => {
  const v = { scale: 0.3, tx: 37, ty: -19, auto: false };
  for (const pt of [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: 799, y: 42 }]) {
    const p = toStagePoint(v, PROJECT, BOX, pt);
    const o = frameOrigin(v, PROJECT, BOX);
    // 反着算回去要回到原点
    assert.ok(Math.abs(o.x + p.x * v.scale - pt.x) < 1e-9);
    assert.ok(Math.abs(o.y + p.y * v.scale - pt.y) < 1e-9);
  }
});

test("光标锚点:缩放之后光标底下还是同一个画面像素", () => {
  const start = fitView(PROJECT, BOX);
  for (const cursor of [{ x: 400, y: 300 }, { x: 60, y: 80 }, { x: 780, y: 560 }]) {
    const before = toStagePoint(start, PROJECT, BOX, cursor);
    for (const f of [1.2, 2, 0.5, 1 / 1.2]) {
      const after = zoomAt(start, PROJECT, BOX, cursor, start.scale * f);
      const p = toStagePoint(after, PROJECT, BOX, cursor);
      assert.ok(
        Math.abs(p.x - before.x) < 0.01 && Math.abs(p.y - before.y) < 0.01,
        `光标 ${JSON.stringify(cursor)} 缩放 ${f} 倍后跑了:${JSON.stringify(before)} → ${JSON.stringify(p)}`,
      );
    }
  }
});

test("连着缩放再缩回去,能回到原来的视角", () => {
  const cursor = { x: 250, y: 180 };
  const start = fitView(PROJECT, BOX);
  let v = start;
  for (let i = 0; i < 5; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale * 1.2);
  for (let i = 0; i < 5; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale / 1.2);
  assert.ok(Math.abs(v.scale - start.scale) < 1e-9, `倍率没回来:${v.scale} vs ${start.scale}`);
  assert.ok(Math.abs(v.tx) < 0.01 && Math.abs(v.ty) < 0.01, `偏移没回来:${v.tx}, ${v.ty}`);
});

test("缩放有上下限,而且到了限位不会把画面挪走", () => {
  const cursor = { x: 100, y: 100 };
  let v = fitView(PROJECT, BOX);
  for (let i = 0; i < 60; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale * 1.2);
  assert.equal(v.scale, MAX_SCALE);
  for (let i = 0; i < 200; i++) v = zoomAt(v, PROJECT, BOX, cursor, v.scale / 1.2);
  assert.equal(v.scale, MIN_SCALE);
  assert.equal(clampScale(1e9), MAX_SCALE);
  assert.equal(clampScale(0), MIN_SCALE);
});

test("已经到限位了再滚,视角一动不动(不该悄悄漂移)", () => {
  const cursor = { x: 700, y: 500 };
  let v = zoomAt(fitView(PROJECT, BOX), PROJECT, BOX, cursor, MAX_SCALE);
  const again = zoomAt(v, PROJECT, BOX, cursor, MAX_SCALE * 2);
  assert.deepEqual(again, v, "顶到上限之后继续放大,偏移量也不能变");
});

test("滚了但什么都没变的时候,不该把「自动适应」也顺手关掉", () => {
  /*
   * 窗口小到适应比例本身就顶在下限:这时候再往下滚,什么都没发生 ——
   * 那就不该因此退出自动适应。「我滚了一下,结果画面没变,但窗口一改大小
   * 画面也不自己适应了」是最难查的那种手感 bug。
   */
  const tiny = { width: 30, height: 30 };
  const fit = fitView(PROJECT, tiny);
  assert.equal(fit.scale, MIN_SCALE, "这个窗口小到适应比例已经顶在下限");
  const after = zoomAt(fit, PROJECT, tiny, { x: 15, y: 15 }, fit.scale / 1.2);
  assert.equal(after.auto, true, "没变化就不该退出自动适应");
  assert.deepEqual(after, fit);
});

test("拖动:至少留一块在视野里,拖不出去", () => {
  const v = { scale: 0.4, tx: 0, ty: 0, auto: false };
  const far = panBy(v, PROJECT, BOX, 100000, 100000);
  const fw = 1920 * 0.4;
  // 画面左边缘不该越过窗口右边缘再往里 48px
  const o = frameOrigin(far, PROJECT, BOX);
  assert.ok(o.x <= BOX.width - 48 + 1e-6, `拖过头了,左边缘在 ${o.x}`);
  assert.ok(o.x + fw >= 48 - 1e-6);
  // 反方向同理
  const back = panBy(v, PROJECT, BOX, -100000, -100000);
  const o2 = frameOrigin(back, PROJECT, BOX);
  assert.ok(o2.x + fw >= 48 - 1e-6, `反向拖过头了,右边缘在 ${o2.x + fw}`);
});

test("拖动是累加的,而且小幅拖动不受限位干扰", () => {
  let v = { scale: 0.4, tx: 0, ty: 0, auto: true };
  v = panBy(v, PROJECT, BOX, 10, -5);
  assert.deepEqual([v.tx, v.ty], [10, -5]);
  v = panBy(v, PROJECT, BOX, 3, 2);
  assert.deepEqual([v.tx, v.ty], [13, -3]);
  assert.equal(v.auto, false, "手动拖过就不该再自动适应了 —— 否则一改窗口大小就白拖了");
});

test("缩放和拖动都会关掉「自动适应」", () => {
  const fit = fitView(PROJECT, BOX);
  assert.equal(fit.auto, true);
  assert.equal(zoomAt(fit, PROJECT, BOX, { x: 1, y: 1 }, 0.5).auto, false);
  assert.equal(panBy(fit, PROJECT, BOX, 1, 0).auto, false);
});

test("滚轮:往上放大、往下缩小,而且一上一下能回到 1", () => {
  assert.ok(wheelZoomFactor(-120) > 1, "往上滚该放大");
  assert.ok(wheelZoomFactor(120) < 1, "往下滚该缩小");
  assert.ok(Math.abs(wheelZoomFactor(-120) * wheelZoomFactor(120) - 1) < 1e-12, "一上一下要正好抵消");
  assert.ok(Math.abs(wheelZoomFactor(-120) - 1.2) < 1e-12);
  assert.equal(wheelZoomFactor(0), 1);
});

test("滚轮:按行给的设备要换算成像素,否则快慢差十几倍", () => {
  // deltaMode 1 = 按行,一行算 16 像素
  assert.ok(Math.abs(wheelZoomFactor(-7.5, 1) - wheelZoomFactor(-120, 0)) < 1e-12);
  // 触控板一次甩出很大的值也不能一步缩到底
  assert.ok(wheelZoomFactor(-100000) <= Math.pow(1.2, 4) + 1e-12);
  assert.ok(wheelZoomFactor(100000) >= Math.pow(1.2, -4) - 1e-12);
});

test("画面比窗口小的时候也能拖 —— 但拖不到看不见", () => {
  const v = { scale: 0.1, tx: 0, ty: 0, auto: false };  // 192x108,远小于 800x600
  const moved = panBy(v, PROJECT, BOX, 1000, 0);
  const o = frameOrigin(moved, PROJECT, BOX);
  assert.ok(o.x < BOX.width, "还得看得见");
  assert.ok(o.x + 1920 * 0.1 >= 48 - 1e-6);
});

test("clampPan 不改缩放,也不改 auto", () => {
  const v = { scale: 0.4, tx: 99999, ty: 0, auto: true };
  const c = clampPan(v, PROJECT, BOX);
  assert.equal(c.scale, 0.4);
  assert.equal(c.auto, true);
  assert.ok(c.tx < 99999);
});
