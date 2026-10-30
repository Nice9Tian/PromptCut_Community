/**
 * 场景图的坐标换算:局部框 ⇄ 画面绝对位置,以及 Stage 要的 CSS。
 *
 * 原则只有一条:**只存局部坐标(ClipFrame),世界坐标永远由这里推导,不落盘。**
 * Agent 设世界坐标时,这里反解成局部存下来;设局部时,世界自动跟着变。
 * 两个都存的话早晚漂掉,谁都说不清哪个是真的。
 *
 * 卡片级的父坐标系就是舞台(原点左上角),所以现在 world == local,反解是恒等;
 * 函数签名都按「父框 → 子框」写,将来部件级(卡片内部的 title / rows …)接进来时
 * 只是多递归一层,接口不用动。
 *
 * ⚠ 一个必须写进工具说明的坑:设世界坐标 ≠ 钉在屏幕上。反解出来存的是局部,
 * 之后父节点一动,子节点跟着走(标题理应跟着卡片走)。要"不管父节点怎么动都钉在
 * 屏幕这儿",是另一个意图(pin / 摘出组),不是这条路。
 */
import type { CSSProperties } from "react";
import type { ClipFrame } from "./types";
import { cameraFor, projectStage } from "./space3d.ts";
import { resolveFrameSize } from "./frameSize.mjs";

export interface Size {
  width: number;
  height: number;
}

/** 父坐标系里的矩形(缩放旋转之前) */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ClipFrame 补全默认值之后的形状 */
export interface FrameResolved {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: [number, number];
  scale: number;
  rotate: number;
  /** 绕水平轴(度)。0 = 不翻 */
  rotateX: number;
  /** 绕垂直轴(度)。0 = 不翻 */
  rotateY: number;
  /** 深度平移(舞台像素),朝观众为正。0 = 在屏幕平面上 */
  translateZ: number;
}

/** 补全默认值:没有 frame = 铺满父坐标系 */
export function resolveFrame(frame: ClipFrame | undefined, parent: Size): FrameResolved {
  // w/h 走 src/kernel/frameSize.mjs:服务端的共享快照键要算出一模一样的框宽高。
  const size = resolveFrameSize(frame, parent);
  return {
    x: frame?.x ?? 0,
    y: frame?.y ?? 0,
    w: size.w,
    h: size.h,
    anchor: frame?.anchor ?? [0, 0],
    scale: frame?.scale ?? 1,
    rotate: frame?.rotate ?? 0,
    rotateX: frame?.rotateX ?? 0,
    rotateY: frame?.rotateY ?? 0,
    translateZ: frame?.translateZ ?? 0,
  };
}

/**
 * 这个 frame 有没有用到三维。
 *
 * frameCss(要不要写 preserve-3d)和 visualBox(要不要走投影)都问它 ——
 * 两处各写一遍 `rotateX || rotateY || translateZ` 的话,以后加第四个三维字段
 * 一定会漏掉其中一处,而漏掉不报错,只是某一边悄悄按二维算。
 */
export function frameIs3D(frame: ClipFrame | undefined | FrameResolved): boolean {
  return !!(frame?.rotateX || frame?.rotateY || frame?.translateZ);
}

/** 框在父坐标系里的矩形:锚点在 (x,y),左上角 = (x,y) 减去锚点在框内的偏移 */
export function frameBox(frame: ClipFrame | undefined, parent: Size): Box {
  const f = resolveFrame(frame, parent);
  return { left: f.x - f.anchor[0] * f.w, top: f.y - f.anchor[1] * f.h, width: f.w, height: f.h };
}

/** 一个节点在世界坐标系里的描述(get_layout 返回的 world 部分) */
export interface WorldPlacement {
  /** 锚点的世界坐标 */
  x: number;
  y: number;
  anchor: [number, number];
  w: number;
  h: number;
  scale: number;
  rotate: number;
  /** 世界坐标系里的矩形(缩放旋转之前,即画布) */
  box: Box;
  /** 缩放旋转**之后**的外接矩形。判断遮挡、贴边、会不会出画,看这个,不是 box */
  visualBox: Box;
}

/**
 * 变换之后在画面上占的外接矩形(AABB)。
 *
 * 四个角走**和 frameCss 完全一样的一串变换**,最后按透视投影落到屏幕上。
 * CSS 的 transform 列表是右边的先作用,`frameCss` 写的是
 * `translateZ rotateX rotateY scale rotate`,所以顺序是:
 * 先平面旋转 → 缩放 → 绕 y 翻 → 绕 x 翻 → 沿 z 平移 → 投影。
 *
 * `fovDeg` 就是项目的 `camera3dFov`:
 *   - 不传(项目没开三维)= 没有透视,三维那几项只造成仿射压缩(rotateY 把宽压成 cos θ 倍),
 *     这也正是画面上真实发生的事 —— 所以照样要算,不能当它们不存在;
 *   - 传了就按针孔相机投影,和 CSS 的 perspective 是同一个公式(见 space3d.ts)。
 *
 * **越过相机平面的降级**:卡片被推到相机上或相机后面(translateZ ≥ 相机距离)时,投影没有意义。
 * 这里把角点的 z 夹在相机前面一点点,于是得到一个**很大但有限**的框 ——
 * 大于舞台的框 clampToStage 本来就不夹(见那里的注释),get_layout 上也一眼看得出"这卡飞了"。
 * 不返回 Infinity 是因为那会顺着算进 NaN,而 NaN 会安静地毁掉后面每一个判断。
 */
export function visualBox(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): Box {
  const f = resolveFrame(frame, parent);
  const b = frameBox(frame, parent);
  const rad = (f.rotate * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = (f.rotateX * Math.PI) / 180;
  const ry = (f.rotateY * Math.PI) / 180;
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const is3D = frameIs3D(f);
  // 相机只在项目开了三维时才存在;没开就是平行投影
  const distance = fovDeg ? cameraFor(parent, fovDeg).distance : Infinity;
  const zCap = Number.isFinite(distance) ? distance * 0.98 : Infinity;

  const corners: [number, number][] = [
    [b.left, b.top], [b.left + b.width, b.top], [b.left, b.top + b.height], [b.left + b.width, b.top + b.height],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cxi, cyi] of corners) {
    // 绕锚点:先平面旋转,再缩放(均匀缩放和旋转可交换,顺序无所谓)
    const dx0 = (cxi - f.x) * f.scale;
    const dy0 = (cyi - f.y) * f.scale;
    let x = dx0 * cos - dy0 * sin;
    let y = dx0 * sin + dy0 * cos;
    let z = 0;
    if (is3D) {
      // rotateY:x' = x·cosθ + z·sinθ,z' = −x·sinθ + z·cosθ
      const nx = x * cosY + z * sinY;
      z = -x * sinY + z * cosY;
      x = nx;
      // rotateX:y' = y·cosθ − z·sinθ,z' = y·sinθ + z·cosθ
      const ny = y * cosX - z * sinX;
      z = y * sinX + z * cosX;
      y = ny;
      z += f.translateZ;
    }
    const sx = f.x + x;
    const sy = f.y + y;
    let px = sx, py = sy;
    if (fovDeg && is3D) {
      const p = projectStage({ x: sx, y: sy, z: Math.min(z, zCap) }, parent, fovDeg);
      // zCap 保证了 p 不会是 null;真为 null 时退回未投影的点,总比 NaN 强
      if (p) { px = p.x; py = p.y; }
    }
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 局部框 → 世界描述。卡片级:父 = 舞台,原点重合,所以就是把 frame 补全再算两个矩形。
 * 部件级接进来时这里改成:parentWorld 的 box.left/top 加上局部 x,y,scale 相乘。
 *
 * 字段**逐个列出来**而不是 `...f`:resolveFrame 现在还带着 rotateX / rotateY / translateZ,
 * 展开进去的话每个 clip(包括从没碰过三维的老项目)的 world 里都会多出三个 0,
 * 而 world 的语义是「投影之后在画面上的样子」,那三个是投影**之前**的局部量 ——
 * Agent 看见它们会以为 world 也能写三维。它们在 frame.local 里,该在那儿看。
 */
export function worldOf(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): WorldPlacement {
  const f = resolveFrame(frame, parent);
  return {
    x: f.x, y: f.y, anchor: f.anchor, w: f.w, h: f.h, scale: f.scale, rotate: f.rotate,
    box: frameBox(frame, parent),
    visualBox: visualBox(frame, parent, fovDeg),
  };
}

/**
 * 世界坐标 → 局部坐标(只换算传了的字段)。卡片级恒等;签名留着是为了部件级。
 * 传进来的 x,y 是「锚点的世界坐标」,和存下来的语义一致,所以不需要知道尺寸。
 */
export function localFromWorld(world: Partial<ClipFrame>, _parent: Size): Partial<ClipFrame> {
  return { ...world };
}

/** set_position 的入参 */
export interface PositionArgs {
  space?: "world" | "local";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  anchor?: [number, number];
  scale?: number;
  rotate?: number;
  /** 绕水平轴翻转(度),正值 = 顶边往里倒。要项目开了 camera3dFov 才看得出透视 */
  rotateX?: number;
  /** 绕垂直轴翻转(度),正值 = 右边往里转。同上 */
  rotateY?: number;
  /** 深度平移(舞台像素),正值朝观众 */
  translateZ?: number;
}

/**
 * 把 set_position 的入参变成要合并进 frame 的补丁:校验数值、按 space 换算。
 * 只返回传了的字段 —— 调用方 { ...prev, ...patch } 合并,没传的保留。
 * 校验不过就 throw,错误信息给 Agent 看,所以说人话。
 */
export function framePatchFromArgs(args: PositionArgs, parent: Size): Partial<ClipFrame> {
  const out: Partial<ClipFrame> = {};
  const num = (k: keyof PositionArgs, v: unknown, check?: (n: number) => string | null) => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
    const bad = check?.(v);
    if (bad) throw new Error(bad);
    (out as Record<string, unknown>)[k] = v;
  };
  num("x", args.x);
  num("y", args.y);
  num("w", args.w, (n) => (n > 0 ? null : `w 必须大于 0,收到 ${n}`));
  num("h", args.h, (n) => (n > 0 ? null : `h 必须大于 0,收到 ${n}`));
  num("scale", args.scale, (n) => (n > 0 ? null : `scale 必须大于 0,收到 ${n};要隐藏卡片用 remove_clip 或 opacity,不要缩到 0`));
  num("rotate", args.rotate);
  // 三维。角度不设上下限(转 720° 是合法的动画意图),translateZ 也不限 ——
  // 推到相机后面会被 projectStage 判成不可见,那是渲染层的事,不该在参数校验里替它决定
  num("rotateX", args.rotateX);
  num("rotateY", args.rotateY);
  num("translateZ", args.translateZ);
  if (args.anchor !== undefined) {
    const a = args.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error(`anchor 必须是两个数字 [ax, ay],例如 [0.5, 0.5] 表示中心,收到 ${JSON.stringify(a)}`);
    }
    out.anchor = [a[0], a[1]];
  }
  if (Object.keys(out).length === 0) {
    throw new Error("set_position 至少要传 x / y / w / h / anchor / scale / rotate / rotateX / rotateY / translateZ 中的一项,或 clear:true");
  }
  return args.space === "world" ? localFromWorld(out, parent) : out;
}

/**
 * Stage 要的样式。
 *
 * 没有 frame 时**原样**输出以前那套(inset:0 + 可选的轨迹平移),一个字节都不变 ——
 * 老项目的导出结果有逐像素基线在,这里不冒险。有 frame 时才走 left/top/width/height
 * 那条路,transform 按「轨迹平移 → 缩放 → 旋转」的顺序合成,绕锚点。
 * 恒等的 scale / rotate 不写进 transform:即使是 scale(1),transform 属性的存在
 * 本身也可能让合成器换一条光栅路径。
 */
export function frameCss(frame: ClipFrame | undefined, parent: Size, translate?: { dx: number; dy: number }): CSSProperties {
  const parts: string[] = [];
  if (translate) parts.push(`translate(${translate.dx}px, ${translate.dy}px)`);
  if (!frame) {
    return {
      position: "absolute",
      inset: 0,
      ...(parts.length ? { transform: parts.join(" "), willChange: "transform" } : null),
    };
  }
  const f = resolveFrame(frame, parent);
  const box = frameBox(frame, parent);
  /*
   * 三维那几项排在 scale / rotate **前面**(CSS 里靠左 = 后作用 = 更外层),
   * 对应的心智模型是「先在平面里排好版,再把整张卡摆进空间」——
   * 反过来的话,倾斜会被后面的缩放拉伸,用户调 scale 时会发现透视跟着变形。
   *
   * 三项全为 0 时一个字符都不往 transform 里加:老项目的导出有逐像素基线,
   * 哪怕多一个恒等变换都可能让合成器换一条光栅路径。
   */
  if (f.translateZ !== 0) parts.push(`translateZ(${f.translateZ}px)`);
  if (f.rotateX !== 0) parts.push(`rotateX(${f.rotateX}deg)`);
  if (f.rotateY !== 0) parts.push(`rotateY(${f.rotateY}deg)`);
  if (f.scale !== 1) parts.push(`scale(${f.scale})`);
  if (f.rotate !== 0) parts.push(`rotate(${f.rotate}deg)`);
  return {
    position: "absolute",
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    transformOrigin: `${f.anchor[0] * 100}% ${f.anchor[1] * 100}%`,
    ...(parts.length ? { transform: parts.join(" ") } : null),
    ...(translate ? { willChange: "transform" } : null),
    /*
     * 只有真的用到三维才写 preserve-3d,没用三维的卡走的还是和以前一模一样的那条路。
     *
     * 它管的是**这张卡内部的子元素**能不能有自己的空间关系,不管这张卡自己怎么被投影 ——
     * 卡片自身的透视由父层的 perspective 决定(见 render/Stage.tsx)。
     *
     * 顺带记一条实测,因为它反直觉:`opacity` / `filter` / `overflow:hidden` 确实会把
     * 这个元素的 transform-style **打回 flat**,但那只影响它的子树,
     * **卡片自己的投影一点不变**。同一张 rotateY(40°) 的卡,三个属性各加一遍:
     *   基线 / +opacity:0.5 / +filter:drop-shadow / +overflow:hidden
     *   外框都是 154.88×133.93,左右两边高都是 133.93 / 108.69 —— 四组逐位相同。
     * Stage 会在卡片外层写 opacity(淡入淡出)和 filter(强调),所以这条必须钉住:
     * 那两个属性**不会**让摆进空间的卡突然摊平。
     */
    ...(frameIs3D(f) ? { transformStyle: "preserve-3d" as const } : null),
  };
}

/* ------------------------------------------------------------------------------------------
 * 下面是 Agent 的另外几种说法 —— 矩形、对齐、微调。它们都只是把话换算成同一个 ClipFrame,
 * 存的东西没有第二种。
 * ---------------------------------------------------------------------------------------- */

/** 两个对角点,顺序随意 */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function normRect(r: Rect): Box {
  for (const k of ["x1", "y1", "x2", "y2"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(r[k])}`);
  }
  const box = { left: Math.min(r.x1, r.x2), top: Math.min(r.y1, r.y2), width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1) };
  if (!(box.width > 0 && box.height > 0)) throw new Error(`矩形必须有正的宽高,收到 x1=${r.x1} y1=${r.y1} x2=${r.x2} y2=${r.y2}`);
  return box;
}

function checkAlign(a: unknown, name: string): [number, number] {
  if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${name} 必须是两个数字 [ax, ay],例如 [0.5, 0.5] 表示中心,收到 ${JSON.stringify(a)}`);
  }
  return [a[0], a[1]];
}

/**
 * 把卡片放进一个矩形。
 *   fit(默认):画布尺寸不动,整体缩放到刚好装进矩形(保持比例),按 align 对齐在矩形里。
 *     大多数卡按 1920×1080 设计,"放进左半屏"该做的就是这个 —— 缩放后内容一定在矩形内。
 *   canvas:画布就是这个矩形(w/h = 矩形尺寸,scale 归 1)。内容按卡片自己的规则在新画布里
 *     布局,可能溢出(rank-bars 自带 min-w 1000px,放进 960 宽的画布就会露出去)。
 * 两种都不碰 rotate;fit 的"装进去"不考虑旋转后的外接框。
 */
export function rectToFrame(
  rect: Rect,
  opts: { mode?: "fit" | "canvas"; align?: [number, number] },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  const r = normRect(rect);
  const align = opts.align === undefined ? ([0.5, 0.5] as [number, number]) : checkAlign(opts.align, "align");
  const mode = opts.mode ?? "fit";
  if (mode !== "fit" && mode !== "canvas") throw new Error(`mode 只能是 fit 或 canvas,收到 ${JSON.stringify(mode)}`);
  const x = r.left + align[0] * r.width;
  const y = r.top + align[1] * r.height;
  if (mode === "canvas") {
    return { ...prev, x, y, w: r.width, h: r.height, anchor: align, scale: 1 };
  }
  const p = resolveFrame(prev, parent);
  const scale = Math.min(r.width / p.w, r.height / p.h);
  return { ...prev, x, y, w: p.w, h: p.h, anchor: align, scale };
}

export type AlignH = "left" | "center" | "right";
export type AlignV = "top" | "center" | "bottom";

/**
 * 对齐到父坐标系的边或中心,带边距。锚点跟着对齐方式走(靠右就把锚点放到右边),
 * 缩放绕锚点,所以缩放后的可见框也贴在同一条边上。旋转会让角伸出去,不管。
 * 只传 h 或只传 v 时另一个方向保持不动。
 */
export function alignToFrame(
  h: AlignH | undefined,
  v: AlignV | undefined,
  margin: number,
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  if (h === undefined && v === undefined) throw new Error("align 至少要传 h(left/center/right)或 v(top/center/bottom)中的一个");
  if (h !== undefined && !["left", "center", "right"].includes(h)) throw new Error(`h 只能是 left / center / right,收到 ${JSON.stringify(h)}`);
  if (v !== undefined && !["top", "center", "bottom"].includes(v)) throw new Error(`v 只能是 top / center / bottom,收到 ${JSON.stringify(v)}`);
  if (typeof margin !== "number" || !Number.isFinite(margin)) throw new Error(`margin 必须是有限数字,收到 ${JSON.stringify(margin)}`);
  const p = resolveFrame(prev, parent);
  const ax = h === "left" ? 0 : h === "right" ? 1 : h === "center" ? 0.5 : p.anchor[0];
  const ay = v === "top" ? 0 : v === "bottom" ? 1 : v === "center" ? 0.5 : p.anchor[1];
  const x = h === "left" ? margin : h === "right" ? parent.width - margin : h === "center" ? parent.width / 2 : p.x;
  const y = v === "top" ? margin : v === "bottom" ? parent.height - margin : v === "center" ? parent.height / 2 : p.y;
  return { ...prev, x, y, anchor: [ax, ay] };
}

/**
 * 铺满舞台、又没缩小的卡片,对齐是看不出效果的:画布本来就和舞台一样大,贴哪条边都一样。
 * 给 align 的返回加一句提醒用。
 */
export function alignIsInvisible(frame: ClipFrame | undefined, parent: Size): boolean {
  const f = resolveFrame(frame, parent);
  return f.w >= parent.width && f.h >= parent.height && f.scale >= 1;
}

/**
 * 把框夹回父坐标系里:可见框(缩放旋转后)超出哪条边就往回挪多少。
 * 比父坐标系还大的框夹不回来,原样返回 —— 那是 scale 的事,不是位置的事。
 * 给 nudge / set_position 的 clamp 用:「再往右 300」不该把卡推出屏幕。
 *
 * # 三维下要换算,而且要迭代
 *
 * 越界量是在**投影后**的画面上量的,而 `x/y` 存的是**投影前**的局部坐标,
 * 两者差一个 `d/(d−z)` 倍。直接把画面上的越界量加到 x 上,结果是:
 *   - z 为负(往里推,倍率 < 1):挪得不够,夹完还在画外。实测 translateZ:-800 的卡
 *     连夹三次,右边仍在 2002.5 → 1948.9 → 1930.1,永远贴不到 1920;
 *   - z 为正(朝观众,倍率 > 1):挪过头。实测 translateZ:700 的卡夹完右边落在 849.6,
 *     离该贴的 1920 差了大半屏 —— 卡片没出画,但被拽到了一个谁也没要求的位置。
 *
 * 所以先除以锚点处的投影倍率再挪。旋转过的卡四个角倍率各不相同,一次除不干净,
 * 再迭代几轮收到不动点为止 —— 收敛得很快,纯 translateZ 一轮就够。
 */
const CLAMP_PASSES = 6;

export function clampToStage(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): ClipFrame {
  const f0 = resolveFrame(frame, parent);
  let cur: ClipFrame = { ...frame, x: f0.x, y: f0.y };
  let moved = false;

  for (let pass = 0; pass < CLAMP_PASSES; pass++) {
    const f = resolveFrame(cur, parent);
    const vb = visualBox(cur, parent, fovDeg);
    let dx = 0;
    let dy = 0;
    if (vb.width <= parent.width) {
      if (vb.left < 0) dx = -vb.left;
      else if (vb.left + vb.width > parent.width) dx = parent.width - (vb.left + vb.width);
    }
    if (vb.height <= parent.height) {
      if (vb.top < 0) dy = -vb.top;
      else if (vb.top + vb.height > parent.height) dy = parent.height - (vb.top + vb.height);
    }
    if (dx === 0 && dy === 0) break;
    // 锚点处的投影倍率:锚点就是变换原点,旋转不动它,所以它的深度就是 translateZ
    const k = fovDeg && frameIs3D(f)
      ? projectStage({ x: f.x, y: f.y, z: f.translateZ }, parent, fovDeg)?.scale || 1
      : 1;
    cur = { ...cur, x: f.x + dx / k, y: f.y + dy / k };
    moved = true;
    // 二维时一轮就是精确解,不必再走一遍(也保证结果和以前逐位相同)
    if (k === 1) break;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) break;
  }

  if (!moved) return { ...frame, x: f0.x, y: f0.y };
  const f = resolveFrame(cur, parent);
  return { ...frame, x: f.x, y: f.y };
}

export type SafeSide = "left" | "right" | "top" | "bottom";

/**
 * 主体检测说「这一侧是空的」→ 一个能直接喂给 set_rect 的矩形。
 * left/right 是半屏,top/bottom 是 1/3 带(和主体检测算 occupancy 用的分区一致),四周留 margin。
 */
export function rectForSafeSide(side: SafeSide, parent: Size, margin = 40): Rect {
  const W = parent.width, H = parent.height;
  switch (side) {
    case "left": return { x1: margin, y1: margin, x2: W / 2 - margin, y2: H - margin };
    case "right": return { x1: W / 2 + margin, y1: margin, x2: W - margin, y2: H - margin };
    case "top": return { x1: margin, y1: margin, x2: W - margin, y2: H / 3 - margin };
    case "bottom": return { x1: margin, y1: (H * 2) / 3 + margin, x2: W - margin, y2: H - margin };
    default: throw new Error(`safeSide 只能是 left / right / top / bottom,收到 ${JSON.stringify(side)}`);
  }
}

/** 在现有基础上加减:位置加像素,缩放乘倍数,旋转加角度 */
export function nudgeFrame(
  d: { dx?: number; dy?: number; scaleBy?: number; rotateBy?: number },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  for (const k of ["dx", "dy", "scaleBy", "rotateBy"] as const) {
    const v = d[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
  }
  if (d.scaleBy !== undefined && !(d.scaleBy > 0)) throw new Error(`scaleBy 是倍数,必须大于 0(0.5 = 缩到一半,2 = 放大一倍),收到 ${d.scaleBy}`);
  if (d.dx === undefined && d.dy === undefined && d.scaleBy === undefined && d.rotateBy === undefined) {
    throw new Error("nudge 至少要传 dx / dy / scaleBy / rotateBy 中的一项");
  }
  const p = resolveFrame(prev, parent);
  return {
    ...prev,
    x: p.x + (d.dx ?? 0),
    y: p.y + (d.dy ?? 0),
    ...(d.scaleBy !== undefined ? { scale: p.scale * d.scaleBy } : null),
    ...(d.rotateBy !== undefined ? { rotate: p.rotate + d.rotateBy } : null),
  };
}
