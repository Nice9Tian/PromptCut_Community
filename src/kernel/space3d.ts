/**
 * 三维空间的唯一换算口。CSS 那半边和 three.js 那半边都从这里取数,不许各算各的。
 *
 * # 为什么必须只有一处
 *
 * `layout.ts` 要算 CSS 的 `perspective` 和 `transform`,将来 B 层要算 three.js 的相机。
 * 两边算的是同一件事。分开写的话,只要有一处改了没同步,画面就**悄悄错位** ——
 * 不报错、不崩,只是"看着不太对",而这种问题最难查。所以数只在这里出,那两边都是调用方。
 *
 * # 尺度约定
 *
 * **1 世界单位 = 1 舞台像素**,屏幕平面是 `z = 0`。
 * 这条必须钉死:一旦世界单位和像素脱钩,开 3D 模式的瞬间整个画面会突然缩放,
 * 而用户只是想让一张卡歪一点。
 *
 * # d 不是自由参数
 *
 * 钉死尺度之后,相机距离和视场角就锁在一起:
 *
 *     d = H / (2 · tan(fov/2))
 *
 * 所以**只暴露 fov,d 由它推**,不要反过来让人填 d。理由有两条:
 *
 * 1. 竖屏项目 H 是 1920,同一个 d 的透视强度跟着变;fov 是"透视有多强"的直接表达,
 *    跨画幅稳定。
 * 2. d 的直觉会骗人。`d = 100` 看着像个合理的相机距离,实际对应 **fov 159°**,是鱼眼。
 *
 * # 坐标系
 *
 * 舞台是屏幕坐标(原点左上、y 向下),three.js 是右手系(原点居中、y 向上)。
 * 转换时 **y 要翻**,`z` 的正方向是**朝观众**(和 CSS 的 `translateZ(+)` 一致)。
 * 相机放在 `+z`:three.js 默认相机朝 −z 看,放 +d 才是自然朝向,也才和 CSS 对齐。
 * 写成 −d 的话要么相机背对屏幕、要么 z 的正负和 CSS 相反,两种都是"看着不对但说不清"的 bug。
 */

/** 透视强度的默认值。40° 稳重;50° 明显;30° 接近正交 */
export const DEFAULT_FOV_DEG = 40;

/** fov 的合理区间。太小没有透视感,太大变鱼眼(159° 那个数就是 d=100 换算出来的) */
export const MIN_FOV_DEG = 5;
export const MAX_FOV_DEG = 120;

export interface StageSize {
  width: number;
  height: number;
}

export interface Camera3D {
  /** 视场角(度),垂直方向 */
  fovDeg: number;
  /** 相机到 z=0 平面的距离,单位 = 舞台像素。同时就是 CSS 的 perspective 值 */
  distance: number;
  /** 宽高比,给 three.js 的 PerspectiveCamera 用 */
  aspect: number;
  /** 相机位置(世界坐标)。永远在 +z */
  position: [number, number, number];
  near: number;
  far: number;
}

export function clampFov(fovDeg: number | undefined): number {
  const v = Number(fovDeg);
  if (!Number.isFinite(v)) return DEFAULT_FOV_DEG;
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, v));
}

/**
 * 由 fov 和画幅推出相机。
 *
 * `distance` 同时是 CSS 的 `perspective` 值 —— CSS 的 `perspective: N px` 在数学上
 * 就是"观察者距 z=0 平面 N 像素",和这里的 d 是同一个量、同一个单位。
 * 所以 A 层(DOM + CSS 3D)和 B 层(three.js)天然对齐,不需要任何标定。
 * three.js 自己的 CSS3DRenderer 就是这么干的。
 */
export function cameraFor(stage: StageSize, fovDeg?: number): Camera3D {
  const fov = clampFov(fovDeg);
  const h = Math.max(1, stage.height);
  const distance = h / (2 * Math.tan((fov * Math.PI) / 360));
  return {
    fovDeg: fov,
    distance,
    aspect: Math.max(1e-6, stage.width / h),
    position: [0, 0, distance],
    // near 取 1 像素;far 给足,卡片往后退到相机距离的十倍开外已经小成一个点了
    near: 1,
    far: distance * 10,
  };
}

/** CSS 要的 perspective 值(像素)。就是相机距离,单列一个名字是为了让调用处读起来是那个意思 */
export function perspectivePx(stage: StageSize, fovDeg?: number): number {
  return cameraFor(stage, fovDeg).distance;
}

/** 反过来:给定相机距离,它等价于多大的 fov。给调试和文档用 */
export function fovForDistance(stage: StageSize, distance: number): number {
  const h = Math.max(1, stage.height);
  return (2 * Math.atan(h / (2 * Math.max(1e-6, distance))) * 180) / Math.PI;
}

export interface StagePoint {
  /** 舞台像素,原点左上,x 向右 */
  x: number;
  /** 舞台像素,原点左上,**y 向下** */
  y: number;
  /** 朝观众为正,单位仍是舞台像素。默认 0 = 屏幕平面 */
  z?: number;
}

export type WorldPoint = [number, number, number];

/**
 * 归一化 `-0`。
 *
 * y 轴要翻向,而 `-(540 - 540)` 得到的是 **`-0`** 而不是 `0`。数值上两者相等,
 * 但 `Object.is` 和 `assert.deepEqual` 区分它们,`JSON.stringify(-0)` 还会输出 `0` ——
 * 于是"内存里的对象"和"存盘再读回来的对象"会不相等,而值明明没变。
 * 加个 `+ 0` 就抹平了(`-0 + 0 === +0`)。看着像废话,删掉就会有人花半天查一个假的不一致。
 */
const nz = (v: number): number => v + 0;

/**
 * 舞台坐标 → 世界坐标。原点从左上挪到画面中心,y 翻向,z 原样(两边都是"朝观众为正")。
 */
export function stageToWorld(p: StagePoint, stage: StageSize): WorldPoint {
  return [
    nz(p.x - stage.width / 2),
    nz(-(p.y - stage.height / 2)),
    nz(p.z ?? 0),
  ];
}

/** 世界坐标 → 舞台坐标。和 stageToWorld 互为逆运算 */
export function worldToStage(w: WorldPoint, stage: StageSize): Required<StagePoint> {
  return {
    x: nz(w[0] + stage.width / 2),
    y: nz(-w[1] + stage.height / 2),
    z: nz(w[2]),
  };
}

/**
 * 一个点经过透视投影之后落在屏幕上的位置和缩放比。
 *
 * 给两个用处:实体模式要知道代理平面画多大,包围盒要知道投影后占多少地方。
 * 公式是针孔相机:离相机越近(z 越大)放得越大,`scale = d / (d − z)`。
 * `z ≥ d` 表示点跑到相机后面或正好在相机上 —— 那时投影没有意义,返回 null,
 * 调用方自己决定是隐藏还是夹住,别在这里替它做决定。
 */
export function projectStage(
  p: StagePoint,
  stage: StageSize,
  fovDeg?: number,
): { x: number; y: number; scale: number } | null {
  const { distance } = cameraFor(stage, fovDeg);
  const z = p.z ?? 0;
  const denom = distance - z;
  if (denom <= 1e-6) return null;
  const scale = distance / denom;
  const cx = stage.width / 2;
  const cy = stage.height / 2;
  return {
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
    scale,
  };
}
