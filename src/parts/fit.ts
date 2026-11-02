/**
 * Font size auto-fit: part size parameter set to 0 = calculate font size based on its box.
 *
 * Why not measure DOM: export requires frame-by-frame determinism, and measured sizes drift with
 * font loading and subpixels; character width estimation is used here (CJK full-width counts as
 * 1 font size width, others as 0.6), calculating the exact same font size from identical parameters
 * on any machine. Estimation is conservative (width uses only 92%, height only 78%), preferring
 * slightly smaller over overflowing the box.
 *
 * Usage: `const size = fitOr(params.size, { width, height, text })`; pass lines for multi-line
 * text or text delimited by \\n / |.
 */

export interface FitOpts {
  width: number;
  height: number;
  /** Text to place; pass lines for multi-line, or split text itself by splitter */
  text?: string;
  /** Line count (if omitted, line count split from text, minimum 1) */
  lines?: number;
  /** Separator to split text into lines (defaults to newline); list parts pass "|" */
  splitter?: string | RegExp;
  /** Line height multiplier, defaults to 1.25 */
  lineHeight?: number;
  /** Lower and upper bounds, defaults to 12 ~ 400 */
  min?: number;
  max?: number;
  /** Proportion reserved for padding / icons (0~1), defaults to width 0.92, height 0.78 */
  fillW?: number;
  fillH?: number;
}

/** Width of a line of text relative to 1 font size: full-width characters count as 1, others 0.6 */
export function textUnits(line: string): number {
  let u = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK unified ideographs / Kana / Hangul / full-width punctuation
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

/** Use size parameter if > 0, otherwise auto-fit to box */
export function fitOr(size: unknown, o: FitOpts): number {
  const s = Number(size);
  return s > 0 ? s : fitFontSize(o);
}
