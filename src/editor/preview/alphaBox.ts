/**
 * 从一张预渲染出来的贴图里量「这张卡真正画了东西的那一块」—— alpha 的包围盒。
 *
 * # 为什么 3D 这边要自己量
 *
 * 2D 的排版**不用**内容框:一张卡按它的 `frame` 摆,没写 `frame.w/h` 的就铺满舞台。
 * 项目里那个 `measureContentBox`(render/contentBox.ts)是量 DOM 的,给实体模式
 * 画色块用 —— 而 3D 视图手上没有卡片的 DOM,只有预渲染出来的 PNG。
 *
 * 好在预渲染的排版尺寸修对之后(见 bakeTarget 的 renderBox),PNG 的画布和卡片的框是
 * **1:1** 的。所以在这张图上量出来的包围盒,归一化之后就是「四个角在卡片框里的相对位置」,
 * 可以直接拿去从那块屏幕平面里裁一小块出来。
 *
 * # 和 measureContentBox 的一处**故意不同**
 *
 * 那边会把「占了这张卡九成以上」的元素当背景跳过 —— 因为实体模式要回答的是
 * 「这块压上去是不是太重了」,满屏的底不算内容。这边不跳过:3D 要回答的是
 * 「这块板子该多大」,而铺满屏的底**就该**是一块铺满屏的板子。同一个词、两笔账。
 */

/** 归一化到 0..1 的框,原点在左上(和图片坐标一致) */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 扫 RGBA 像素,求 alpha 超过阈值的包围盒,归一化返回。全透明返回 null。
 *
 * **框会向外扩一个像素**。调用方多半是把大图缩到几百像素再扫(全尺寸扫一遍几百万像素
 * 太慢),缩过之后边缘那一行可能落在采样格之间;不外扩就会把内容切掉一点点,
 * 而板子切掉内容是看得见的错。外扩最多让板子大一圈,那是看不出来的。
 */
export function alphaBox(
  data: ArrayLike<number>,
  width: number,
  height: number,
  opts: { threshold?: number } = {},
): NormBox | null {
  const th = opts.threshold ?? 0;
  if (width <= 0 || height <= 0) return null;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= th) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  // 向外扩一个像素(见上面说明),再夹回图内
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1); y1 = Math.min(height - 1, y1 + 1);
  return {
    x: x0 / width,
    y: y0 / height,
    w: (x1 - x0 + 1) / width,
    h: (y1 - y0 + 1) / height,
  };
}

/**
 * 这个框值不值得拿去裁板子。
 *
 * 几乎铺满整张图的(比如满屏渐变底)就别裁了:裁出来和整块一样大,白白多一次几何重建,
 * 而且浮点上还可能差半个像素。留一点余量再判断。
 */
export function worthCropping(box: NormBox | null, minSaving = 0.04): boolean {
  if (!box) return false;
  return box.w < 1 - minSaving || box.h < 1 - minSaving;
}

/** 复用一张离屏画布:每张贴图都新建一个的话,一条片子几百张就是几百次分配 */
let probe: HTMLCanvasElement | null = null;

/**
 * 把一张已经加载好的图缩进 `maxEdge` 以内画到离屏画布上,量它的内容框。
 *
 * 缩了再扫是为了快:全尺寸 1024×576 是五十多万像素,而缩到 256 之后只剩三万多,
 * 一次一两毫秒。精度损失由 `alphaBox` 的「向外扩一格」兜住 —— 板子大一圈看不出来,
 * 切掉内容才看得出来。
 *
 * 取不到像素就返回 null(调用方按「不裁」处理):画布被跨源图污染过、
 * 或者浏览器不给 2d 上下文的时候会这样,那时候宁可用整块板子,也不能瞎裁。
 */
export function measureImageBox(
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  maxEdge = 256,
): NormBox | null {
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return null;
  const scale = Math.min(1, maxEdge / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  try {
    probe ??= document.createElement("canvas");
    if (probe.width !== w || probe.height !== h) { probe.width = w; probe.height = h; }
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return alphaBox(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}
