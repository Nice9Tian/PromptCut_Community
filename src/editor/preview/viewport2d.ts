/**
 * 2D 预览的「看画布的方式」:缩放多少、平移到哪。**纯计算,不碰 DOM。**
 *
 * # 为什么要单独一个文件
 *
 * 缩放和平移的算错了不会报错,只会「点不准」:鼠标点在卡片上,选中的却是旁边那张。
 * 而这套换算又必须和 Preview.tsx 里已有的那几处坐标换算共用同一个 scale ——
 * 混在组件里改,很容易改出一个「看起来对、点起来偏」的版本。所以摘出来,能单测。
 *
 * # 画布是怎么摆的
 *
 * `.pc-pv-stage` 是 `display:grid; place-items:center`,所以画面**默认就在正中**;
 * 平移量 (tx, ty) 是**相对这个居中位置的偏移**,直接写成 CSS transform。
 * 这样有两个好处:
 *   - 不平移时 tx = ty = 0,和以前的行为逐像素一致(以前根本没有平移);
 *   - 换了窗口大小,画面自己还在中间,不用重新算平移。
 *
 * 缩放不写在 transform 里,而是把画框的 width/height 直接乘上 scale ——
 * 这是原来就有的做法,`.pc-pv-frame` 的边框和四角标记才不会跟着一起被缩粗缩细。
 */

export interface View2D {
  scale: number;
  /** 相对「居中」的偏移(屏幕像素) */
  tx: number;
  ty: number;
  /**
   * true = 跟着窗口自动适应(改窗口大小会重新算 scale,平移保持 0)。
   * 用户一旦自己缩放或平移就变 false —— 否则下一次窗口变化会把他刚调好的视角抹掉。
   */
  auto: boolean;
}

export interface Size { width: number; height: number }

/** 缩放上下限。下限要足够小,长画幅在小窗口里也得能整个看见 */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;
/** 画面再怎么拖,至少要留这么多像素在视野里 —— 否则一拖没影就找不回来了 */
const MIN_VISIBLE_PX = 48;
/** 适应窗口时画面四周留的空 */
const FIT_PAD_PX = 16;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 正好装进窗口的缩放比 */
export function fitScale(project: Size, box: Size, pad = FIT_PAD_PX): number {
  const w = Math.max(1, box.width - pad);
  const h = Math.max(1, box.height - pad);
  return clampScale(Math.min(w / Math.max(1, project.width), h / Math.max(1, project.height)));
}

export const fitView = (project: Size, box: Size, pad = FIT_PAD_PX): View2D => ({ scale: fitScale(project, box, pad), tx: 0, ty: 0, auto: true });

/**
 * 画框左上角在窗口里的位置(相对 stage 左上角)。
 * 居中摆放 + 偏移,所以是 `(窗口 - 画框) / 2 + 偏移`。
 */
export function frameOrigin(view: View2D, project: Size, box: Size) {
  return {
    x: (box.width - project.width * view.scale) / 2 + view.tx,
    y: (box.height - project.height * view.scale) / 2 + view.ty,
  };
}

/** 窗口里的一点(相对 stage 左上角)落在画面的哪个像素上 */
export function toStagePoint(view: View2D, project: Size, box: Size, pt: { x: number; y: number }) {
  const o = frameOrigin(view, project, box);
  return { x: (pt.x - o.x) / view.scale, y: (pt.y - o.y) / view.scale };
}

/**
 * 拖到哪儿算到头。
 *
 * 规则是「至少留 MIN_VISIBLE_PX 在视野里」,而不是「不许拖出窗口」——
 * 放大到比窗口大的时候本来就该能把边角拖进来看,不能一上来就把人卡死在中间。
 */
export function clampPan(view: View2D, project: Size, box: Size): View2D {
  const fw = project.width * view.scale;
  const fh = project.height * view.scale;
  const maxTx = Math.max(0, (box.width + fw) / 2 - MIN_VISIBLE_PX);
  const maxTy = Math.max(0, (box.height + fh) / 2 - MIN_VISIBLE_PX);
  return {
    ...view,
    tx: Math.min(maxTx, Math.max(-maxTx, view.tx)),
    ty: Math.min(maxTy, Math.max(-maxTy, view.ty)),
  };
}

/**
 * 以光标为锚点缩放:光标底下压着画面的哪个像素,缩放之后**还是那个像素**。
 *
 * 这是缩放手感的全部 —— 锚在中心的话,想看右下角就得「放大一点、拖一点、再放大一点」,
 * 而锚在光标上就是「指哪放哪」。
 */
export function zoomAt(
  view: View2D,
  project: Size,
  box: Size,
  cursor: { x: number; y: number },
  nextScale: number,
): View2D {
  const scale = clampScale(nextScale);
  if (scale === view.scale) return view;
  // 缩放前光标压着的那个画面像素
  const p = toStagePoint(view, project, box, cursor);
  // 缩放后要让它仍然落在光标下:反推出画框左上角该在哪,再换算回偏移量
  const originX = cursor.x - p.x * scale;
  const originY = cursor.y - p.y * scale;
  return clampPan(
    {
      scale,
      tx: originX - (box.width - project.width * scale) / 2,
      ty: originY - (box.height - project.height * scale) / 2,
      auto: false,
    },
    project,
    box,
  );
}

/**
 * 滚轮的一格转成缩放倍率。
 *
 * 用**指数**而不是加减一个固定值:放大和缩小才对称(滚上去再滚回来能回到原处),
 * 而且在任何倍率下手感一致 —— 线性加减在小倍率时一格就翻几倍,大倍率时又几乎不动。
 *
 * deltaMode 要看:鼠标滚轮给的是像素(0),但有些浏览器 / 设备按行(1)给,
 * 一行当 16 像素算,否则同样滚一格,不同设备快慢差十几倍。
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // 每 120 像素(一格标准滚轮)缩放 1.2 倍;夹一下防止某些触控板一次甩出上千
  const steps = Math.max(-4, Math.min(4, -px / 120));
  return Math.pow(1.2, steps);
}

/** 拖动画布 */
export function panBy(view: View2D, project: Size, box: Size, dx: number, dy: number): View2D {
  return clampPan({ ...view, tx: view.tx + dx, ty: view.ty + dy, auto: false }, project, box);
}
