/**
 * 手机浏览器点输入框时会自动放大页面(iOS Safari 遇到字号小于 16px 的输入框就放大),输入完失焦后却不缩回,
 * 页面一直停在放大状态。两道防线:
 *
 * 1. `index.css` 在触屏设备上把输入框字号抬到不小于 16px,浏览器就不触发聚焦放大;
 * 2. 本文件兜底:输入框失焦、焦点没落到另一个输入框上,而页面仍是放大的,就临时给 viewport 加
 *    `maximum-scale=1` 把缩放拉回 100%,稍后恢复原样(恢复后用户照旧能双指放大页面)。
 *
 * 纯逻辑在 `planReset`,单测 `focusZoomReset.test.mjs`。
 */

/** 页面缩放高于这个值才算「放大着」(留一点浮点余量) */
export const ZOOMED_SCALE = 1.01;
/** 失焦后等这么久再判断:焦点可能正从一个输入框挪到下一个 */
export const SETTLE_MS = 60;
/** 加上 `maximum-scale=1` 之后保持这么久再恢复,给浏览器时间把缩放拉回来 */
export const RESTORE_MS = 400;

/** 会唤起键盘、可能触发聚焦放大的元素 */
export function isTextEntry(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const t = (el.type || "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"].includes(t);
}

/** 原 viewport 内容加上 `maximum-scale=1`;已有的 maximum-scale 换掉 */
export function clampedViewport(base: string): string {
  const parts = base.split(",").map((s) => s.trim()).filter((s) => s && !/^maximum-scale\s*=/i.test(s));
  parts.push("maximum-scale=1");
  return parts.join(", ");
}

/** 失焦稳定之后要不要把缩放拉回 100% */
export function planReset(scale: number | undefined, activeIsTextEntry: boolean): boolean {
  if (activeIsTextEntry) return false;
  return typeof scale === "number" && scale > ZOOMED_SCALE;
}

let installed = false;

/** 装一次即可(`main.tsx` 调);没有 visualViewport 或 viewport meta 的环境什么都不做 */
export function installFocusZoomReset(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  const vv = window.visualViewport;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!vv || !meta) return;
  const base = meta.getAttribute("content") ?? "width=device-width, initial-scale=1.0";
  let settle = 0;
  let restore = 0;
  document.addEventListener(
    "focusout",
    (e) => {
      if (!isTextEntry(e.target as HTMLElement | null)) return;
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (!planReset(vv.scale, isTextEntry(document.activeElement as HTMLElement | null))) return;
        clearTimeout(restore);
        meta.setAttribute("content", clampedViewport(base));
        restore = window.setTimeout(() => meta.setAttribute("content", base), RESTORE_MS);
      }, SETTLE_MS);
    },
    true,
  );
}
