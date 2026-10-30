// 带 .ts 后缀:这个文件要能被 node --test 直接跑,而 node 解析不了省略后缀的相对导入(place3d.ts 同理)
import { cameraFor, DEFAULT_FOV_DEG, stageToWorld, type StageSize, type WorldPoint } from "../../kernel/space3d.ts";

/**
 * 「2D 视角框」:一个**从相机张开到画幅的四角锥**,把 2D 页看到的那块空间画进三维里。
 *
 * # 它回答的问题
 *
 * 3D 页是绕着看这些卡在空间里怎么摆,但绕了两下之后很容易迷失:哪个方向才是"正面"?
 * 成片里到底能看见哪一块?光有一个画幅矩形是不够的 —— 矩形只说了"画幅在这个平面上",
 * 没说**是从哪儿看过去的**。而"这张卡到底在不在画面里",恰恰要靠视线方向才判断得了。
 *
 * 所以画的是一个锥:**尖在相机,底在画幅**。八条线 —— 底面四条边 + 四条棱。
 *
 * # 相机的位置永远算得出来,不存在"没有相机"的情况
 *
 * 曾经这里分过两种情况:项目没设 `camera3dFov` 就当成正交,不画锥,改成从四角朝观众
 * 拉四条平行线。那是错的,而且和这个文件旁边的代码自相矛盾 ——
 * `Scene3DView` 自己的初始机位用的就是 `cameraFor(stage, project.camera3dFov ?? DEFAULT_FOV_DEG)`,
 * 也就是说**没设 fov 时整个项目本来就按 40° 那台相机来看**。既然那台相机一直都在,
 * 这里就该照着它画锥,而不是另立一套规矩画四条戳出去的平行线。
 *
 * # 尺度和正负号照抄 space3d
 *
 * 1 世界单位 = 1 舞台像素,屏幕平面是 z=0,相机在 +z,y 要翻向。
 * 这些**一个都不能在这里重新推**:`stageToWorld` 和 `cameraFor` 已经和 CSS 那半边
 * 逐值对过账了(见 space3d.ts 的说明),这里只调用。自己再算一遍就是给"两边悄悄错位"开口子。
 */

export interface Frustum2D {
  /** 画幅四角的世界坐标。顺序按舞台坐标:左上 → 右上 → 右下 → 左下 */
  corners: WorldPoint[];
  /** 锥尖 —— 2D 那台相机的位置。永远有值 */
  apex: WorldPoint;
  /**
   * 线段端点,**每 6 个数一条线**(x1,y1,z1, x2,y2,z2)。
   * 这个排布是直接喂 THREE.LineSegments 的 BufferAttribute 用的,不用再转一道。
   * 共八条:底面四条边 + 四条棱。
   */
  positions: number[];
}

/**
 * @param stage   画幅
 * @param fovDeg  透视相机的视场角。没设(undefined / null / 非数)就用 DEFAULT_FOV_DEG,
 *                和 Scene3DView 挑初始机位的口径完全一致
 */
export function frustum2d(stage: StageSize, fovDeg?: number | null): Frustum2D {
  const w = Math.max(1, stage.width);
  const h = Math.max(1, stage.height);
  const size = { width: w, height: h };

  // 舞台四角(原点左上、y 向下),转成世界坐标由 stageToWorld 管
  const corners: WorldPoint[] = [
    stageToWorld({ x: 0, y: 0 }, size),
    stageToWorld({ x: w, y: 0 }, size),
    stageToWorld({ x: w, y: h }, size),
    stageToWorld({ x: 0, y: h }, size),
  ];

  /*
   * 显式挑 fov,不直接把 fovDeg 丢给 cameraFor:`clampFov(null)` 会把 null 当成 0,
   * 再夹到下限 5° —— 那是个极窄的长焦,相机会被推到十几倍画幅远的地方,锥细得像根针。
   * 而 null 的本意是"没设",应该走默认的 40°。
   */
  const fov = typeof fovDeg === "number" && Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : DEFAULT_FOV_DEG;
  const apex = cameraFor(size, fov).position;

  const positions: number[] = [];
  const seg = (a: WorldPoint, b: WorldPoint) => { positions.push(a[0], a[1], a[2], b[0], b[1], b[2]); };

  // 底面:画幅那一圈,四条边首尾相接
  for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4]);
  // 四条棱:相机 → 画幅四角
  for (const c of corners) seg(apex, c);

  return { corners, apex, positions };
}
