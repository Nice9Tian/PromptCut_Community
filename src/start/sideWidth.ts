/**
 * 两条能拖宽窄的栏:左边的项目栏、聊天页右边的拓展栏。宽度记在本机,下次打开还是这个宽度
 * (用户 2026-10-23 定)。
 *
 * 为什么存 localStorage 而不是跟着账号走:这是「这台机器上这块屏幕看着顺手」的事,换一台电脑
 * 屏幕不一样,带过去反而不对。读写都包 try/catch —— 无痕窗口、禁了站点数据的浏览器会直接抛,
 * 抛了就当没存过、用默认宽度,不能让首屏白掉(和 `src/skins/useSkin.ts` 读 `pc.skin` 同一套写法)。
 */

export interface WidthSpec {
  /** 默认宽度 */
  def: number;
  /** 再窄里面的字就没意义了 */
  min: number;
  /** 再宽就把主区挤得放不下 */
  max: number;
  key: string;
}

/** 左边的项目栏。`def` 和原来写死在 CSS 里的 flex-basis 一样 */
export const SIDE_WIDTH: WidthSpec = { def: 248, min: 190, max: 420, key: "pc.start.sideWidth" };

/** 聊天页右边的拓展栏:再窄画面和改前改后两张图就看不清了 */
export const EXT_WIDTH: WidthSpec = { def: 320, min: 250, max: 520, key: "pc.start.extWidth" };

export function clampWidth(spec: WidthSpec, px: number): number {
  if (!Number.isFinite(px)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, Math.round(px)));
}

export function readWidth(spec: WidthSpec): number {
  try {
    const saved = localStorage.getItem(spec.key);
    if (saved === null) return spec.def;
    const n = Number(saved);
    // 存坏了(手改过、旧版本写的别的东西)就退回默认,不要把 NaN 写进样式
    return Number.isFinite(n) ? clampWidth(spec, n) : spec.def;
  } catch {
    return spec.def;
  }
}

export function writeWidth(spec: WidthSpec, px: number): void {
  try {
    localStorage.setItem(spec.key, String(clampWidth(spec, px)));
  } catch {
    // 存不了就只在这一次打开期间生效,不报错
  }
}

/** 侧栏收起来没有。和宽度一样记在本机:收起来的人下次打开还是收着的 */
const COLLAPSED_KEY = "pc.start.sideCollapsed";

export function readSideCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSideCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 同上
  }
}
