/**
 * 手机版完整时间轴的缩放(语义 `workflow/editing.md`「手机版界面」;演示稿第十轮)。
 * 每秒像素在 6～120 之间;「−」「＋」每次约 1.25 倍,以播放头为中心;双指捏合以两指中点为中心;进入时默认「适应宽度」。
 * 纯函数,单测 `zoom.test.mjs`。
 */

export const PX_MIN = 6;
export const PX_MAX = 120;
export const ZOOM_STEP = 1.25;
/** 时间轴内容左边留给轨道标签的宽度(px),第 0 秒画在这里 */
export const TL_PAD = 30;
/** 「适应宽度」右边留一点边 */
export const FIT_MARGIN = 12;
/** 刻度文字之间至少隔这么宽(px) */
const RULER_MIN_GAP = 44;
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export const clampPx = (v: number): number => Math.max(PX_MIN, Math.min(PX_MAX, v));

/** 把整段时长正好放进可见宽度 */
export function fitPx(viewWidth: number, total: number): number {
  return clampPx((viewWidth - TL_PAD - FIT_MARGIN) / Math.max(total, 0.1));
}

/** 刻度间隔随比例自适应:0.5 秒 … 5 分钟一格,文字不重叠 */
export function rulerStep(px: number): number {
  for (const t of RULER_STEPS) if (t * px >= RULER_MIN_GAP) return t;
  return 600;
}

/**
 * 以屏幕上可见区域里 `anchorX`(相对滚动容器左边)这个位置为中心缩放:缩放前后它对着的时间不变。
 * 回新的每秒像素和新的横向滚动位置。
 */
export function zoomAround(px: number, scrollLeft: number, anchorX: number, nextPx: number): { px: number; scrollLeft: number } {
  const np = clampPx(nextPx);
  const t = (scrollLeft + anchorX - TL_PAD) / px;
  return { px: np, scrollLeft: Math.max(0, t * np + TL_PAD - anchorX) };
}

/** 播放头在可见区域里的横坐标(以它为中心缩放用) */
export function playheadX(px: number, scrollLeft: number, t: number): number {
  return t * px + TL_PAD - scrollLeft;
}

export const timeToX = (px: number, t: number): number => t * px + TL_PAD;
export const xToTime = (px: number, x: number): number => (x - TL_PAD) / px;
