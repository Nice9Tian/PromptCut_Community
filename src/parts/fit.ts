/**
 * 字号自适应:部件的 size 参数填 0 = 按自己的框算字号。
 *
 * 为什么不量 DOM:导出要逐帧确定,量出来的尺寸会随字体加载、子像素而漂;这里用字符宽度估算
 * (中日韩全角按 1 个字号宽,其余按 0.6),同一份参数在任何机器上算出同一个字号。
 * 估算偏保守(宽度只用 92%、高度只用 78%),宁可小一点也别溢出框。
 *
 * 用法:`const size = fitOr(params.size, { width, height, text })`;多行文本传 lines 或用 \\n / | 分隔的 text。
 */

export interface FitOpts {
  width: number;
  height: number;
  /** 要放的文字;多行用 lines 给,或者文本本身按 splitter 拆 */
  text?: string;
  /** 行数(不给就按 text 拆出来的行数,最少 1) */
  lines?: number;
  /** 把 text 拆成行的分隔符(默认换行);列表类部件传 "|" */
  splitter?: string | RegExp;
  /** 行高倍数,默认 1.25 */
  lineHeight?: number;
  /** 上下限,默认 12 ~ 400 */
  min?: number;
  max?: number;
  /** 预留给内边距 / 图标的比例(0~1),默认宽 0.92、高 0.78 */
  fillW?: number;
  fillH?: number;
}

/** 一行文字按 1 个字号算有多宽:全角字符算 1,其余 0.6 */
export function textUnits(line: string): number {
  let u = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意 / 假名 / 谚文 / 全角标点
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x20000 && code <= 0x3fffd);
    u += wide ? 1 : ch === " " ? 0.3 : 0.6;
  }
  return Math.max(u, 0.6);
}

export function fitFontSize(o: FitOpts): number {
  const lines = (o.text ?? "").split(o.splitter ?? /\r?\n/).filter((l) => l.length > 0);
  const n = Math.max(1, o.lines ?? lines.length);
  const widest = lines.length ? Math.max(...lines.map(textUnits)) : 6;
  const lh = o.lineHeight ?? 1.25;
  const byW = (o.width * (o.fillW ?? 0.92)) / widest;
  const byH = (o.height * (o.fillH ?? 0.78)) / (n * lh);
  const size = Math.min(byW, byH);
  const min = o.min ?? 12;
  const max = o.max ?? 400;
  return Math.round(Math.max(min, Math.min(max, size)));
}

/** size 参数 > 0 就用它,否则按框自适应 */
export function fitOr(size: unknown, o: FitOpts): number {
  const s = Number(size);
  return s > 0 ? s : fitFontSize(o);
}
