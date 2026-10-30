// node --test src/kernel/space3d.test.mjs —— 三维换算的唯一口子
import test from "node:test";
import assert from "node:assert/strict";

import {
  cameraFor, perspectivePx, fovForDistance, clampFov,
  stageToWorld, worldToStage, projectStage,
  DEFAULT_FOV_DEG,
} from "./space3d.ts";
import { frameCss } from "./layout.ts";

const HD = { width: 1920, height: 1080 };
const VERT = { width: 1080, height: 1920 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("d 由 fov 推:1 世界单位 = 1 舞台像素这条钉死之后,两者就锁在一起", () => {
  // d = H / (2·tan(fov/2))
  near(cameraFor(HD, 50).distance, 1080 / (2 * Math.tan((50 * Math.PI) / 360)), 1e-9);
  assert.equal(Math.round(cameraFor(HD, 50).distance), 1158);
  assert.equal(Math.round(cameraFor(HD, 40).distance), 1484);
  assert.equal(Math.round(cameraFor(HD, 30).distance), 2015);
});

test("d=100 对应鱼眼 —— 这个数看着合理,实际不能用,所以只暴露 fov", () => {
  assert.equal(Math.round(fovForDistance(HD, 100)), 159);
});

test("d 和 fov 互为逆运算", () => {
  for (const fov of [10, 25, 40, 55, 90]) {
    near(fovForDistance(HD, cameraFor(HD, fov).distance), fov, 1e-9);
  }
});

test("竖屏换个画幅,同一个 fov 的 d 跟着变 —— 这正是不让人直接填 d 的理由", () => {
  assert.notEqual(cameraFor(HD, 40).distance, cameraFor(VERT, 40).distance);
  assert.equal(Math.round(cameraFor(VERT, 40).distance), 2638);
});

test("perspectivePx 就是相机距离:CSS 和 three.js 拿的是同一个数", () => {
  assert.equal(perspectivePx(HD, 40), cameraFor(HD, 40).distance);
});

test("相机在 +z,朝原点看", () => {
  const c = cameraFor(HD, 40);
  assert.deepEqual(c.position, [0, 0, c.distance]);
  assert.ok(c.position[2] > 0, "写成 -d 的话要么相机背对屏幕、要么 z 的正负和 CSS 相反");
});

test("fov 缺省和越界都夹回来", () => {
  assert.equal(clampFov(undefined), DEFAULT_FOV_DEG);
  assert.equal(clampFov(NaN), DEFAULT_FOV_DEG);
  assert.equal(clampFov("abc"), DEFAULT_FOV_DEG);
  assert.equal(clampFov(0), 5);
  assert.equal(clampFov(999), 120);
});

test("舞台 → 世界:原点挪到中心,y 翻向", () => {
  assert.deepEqual(stageToWorld({ x: 960, y: 540 }, HD), [0, 0, 0], "画面正中是世界原点");
  assert.deepEqual(stageToWorld({ x: 0, y: 0 }, HD), [-960, 540, 0], "左上角:x 负、y **正**");
  assert.deepEqual(stageToWorld({ x: 1920, y: 1080 }, HD), [960, -540, 0], "右下角:y 负");
});

test("z 原样透传,朝观众为正(和 CSS 的 translateZ 一致)", () => {
  assert.deepEqual(stageToWorld({ x: 960, y: 540, z: 200 }, HD), [0, 0, 200]);
});

test("舞台 ↔ 世界 往返不丢精度", () => {
  for (const p of [
    { x: 0, y: 0, z: 0 },
    { x: 1920, y: 1080, z: -300 },
    { x: 123.5, y: 456.25, z: 78.125 },
    { x: 960, y: 540, z: 0 },
  ]) {
    assert.deepEqual(worldToStage(stageToWorld(p, HD), HD), p);
  }
});

test("投影:z=0 的点不动、缩放为 1 —— 开 3D 模式不该让画面突然变样", () => {
  const r = projectStage({ x: 300, y: 200, z: 0 }, HD, 40);
  assert.deepEqual(r, { x: 300, y: 200, scale: 1 });
});

test("投影:朝观众推变大,往里推变小,并且以画面中心为基准", () => {
  const nearer = projectStage({ x: 300, y: 200, z: 400 }, HD, 40);
  const farther = projectStage({ x: 300, y: 200, z: -400 }, HD, 40);
  assert.ok(nearer.scale > 1, `近的该放大,实际 ${nearer.scale}`);
  assert.ok(farther.scale < 1, `远的该缩小,实际 ${farther.scale}`);
  // 中心点无论 z 多少都不动
  assert.deepEqual(projectStage({ x: 960, y: 540, z: 500 }, HD, 40), { x: 960, y: 540, scale: projectStage({ x: 960, y: 540, z: 500 }, HD, 40).scale });
});

test("投影:点跑到相机上或相机后面时返回 null,不替调用方决定怎么办", () => {
  const d = cameraFor(HD, 40).distance;
  assert.equal(projectStage({ x: 0, y: 0, z: d }, HD, 40), null);
  assert.equal(projectStage({ x: 0, y: 0, z: d + 1 }, HD, 40), null);
  assert.ok(projectStage({ x: 0, y: 0, z: d - 1 }, HD, 40));
});

/*
 * 下面这一组数是**从真 Chrome 里量回来的**,不是照公式再算一遍。
 *
 * 这条链有三段:layout.ts 拼 transform 字符串 → 浏览器按 perspective 做透视 →
 * space3d.ts 的 projectStage 预测它落在哪。中间任何一段改了,画面不会报错,
 * 只会"看着不太对"。所以拿浏览器当基准钉死一次。
 *
 * 量法(scripts 下跑过一次性探针,puppeteer + getBoundingClientRect):
 *   舞台 800×450、fov 40(perspective 618.18px)、卡片 200×120 锚点居中放在 (400,225)、rotateY 35°。
 *   量卡片左右两条边的中心 x 和高度,和 projectStage 的预测逐位对齐,四项差都是 0.0000px。
 */
test("和真浏览器对账:frameCss 拼出来的 transform,落点就是 projectStage 预测的那个", () => {
  const STAGE = { width: 800, height: 450 };
  const FOV = 40, W = 200, H = 120, CX = 400, CY = 225, THETA = 35;

  // 第一段:layout.ts 真的把三维那几项拼进去了,而且 perspective 值对得上
  const css = frameCss({ x: CX, y: CY, w: W, h: H, anchor: [0.5, 0.5], rotateY: THETA }, STAGE);
  assert.equal(css.transform, "rotateY(35deg)");
  assert.equal(css.transformStyle, "preserve-3d");
  near(perspectivePx(STAGE, FOV), 618.18242, 1e-4);

  /*
   * 第三段:rotateY(θ) 把局部 x = ∓W/2 的两条边送到 world (∓W/2·cosθ, 0, ±W/2·sinθ) ——
   * θ 为正时**左边朝观众来**(z 为正)、右边往里去。这个正负实测过,别照直觉改。
   */
  const rad = (THETA * Math.PI) / 180;
  const edge = (sign) => projectStage(
    { x: CX + sign * (W / 2) * Math.cos(rad), y: CY, z: -sign * (W / 2) * Math.sin(rad) },
    STAGE, FOV,
  );
  const L = edge(-1), R = edge(+1);

  // 浏览器量回来的四个数
  near(L.x, 309.70702, 1e-4);
  near(H * L.scale, 132.27285, 1e-4);
  near(R.x, 474.96008, 1e-4);
  near(H * R.scale, 109.81124, 1e-4);

  // 近的那条边必须更高 —— 这就是"有没有透视"的判据
  assert.ok(L.scale > 1 && R.scale < 1, `左近右远才对,实得 ${L.scale} / ${R.scale}`);
});
