/**
 * `server/qr.mjs` 的类型（页面一侧直接 import 它画二维码：协作设置里的邀请二维码、「在手机上打开」）。
 * 实现是零依赖的纯 JS，这里只声明用得到的那两个出口。
 */

export type QrEcLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** 纠错等级，缺省 `M` */
  ec?: QrEcLevel;
  /** 静区模块数，缺省 4 */
  quiet?: number;
  /** 一个模块画多少像素，缺省 6 */
  scale?: number;
  /** 深色，缺省 `#000` */
  dark?: string;
  /** 浅色，缺省 `#fff` */
  light?: string;
}

/** 编成布尔矩阵（`true` = 深色模块） */
export function encodeQr(text: string, opts?: { ec?: QrEcLevel; mask?: number | null }): boolean[][];

/** 直接出一段 SVG 字符串 */
export function qrSvg(text: string, opts?: QrOptions): string;
