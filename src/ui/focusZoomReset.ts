/**
 * Mobile browsers automatically zoom in the page when an input box is tapped (iOS Safari zooms in on an
 * input box whose font size is below 16px), but do not zoom back out after the input loses focus, so the
 * page stays zoomed in. Two lines of defense:
 *
 * 1. `index.css` raises the input font size to at least 16px on touch devices, so the browser does not
 *    trigger the focus zoom;
 * 2. This file is the fallback: when an input loses focus, focus did not land on another input, and the
 *    page is still zoomed in, it temporarily adds `maximum-scale=1` to the viewport to pull the zoom back
 *    to 100%, then restores it shortly afterwards (after the restore the user can still pinch-zoom the
 *    page as usual).
 *
 * The pure logic is in `planReset`, with unit test `focusZoomReset.test.mjs`.
 */

/** The page counts as "zoomed in" only above this scale (leaving a little floating-point margin) */
export const ZOOMED_SCALE = 1.01;
/** After losing focus, wait this long before judging: focus may be moving from one input to the next */
export const SETTLE_MS = 60;
/** After adding `maximum-scale=1`, hold for this long before restoring, to give the browser time to pull the zoom back */
export const RESTORE_MS = 400;

/** Elements that bring up the keyboard and may trigger the focus zoom */
export function isTextEntry(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const t = (el.type || "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"].includes(t);
}

/** The original viewport content plus `maximum-scale=1`; an existing maximum-scale is replaced */
export function clampedViewport(base: string): string {
  const parts = base.split(",").map((s) => s.trim()).filter((s) => s && !/^maximum-scale\s*=/i.test(s));
  parts.push("maximum-scale=1");
  return parts.join(", ");
}

/** Whether to pull the zoom back to 100% once the focus loss has settled */
export function planReset(scale: number | undefined, activeIsTextEntry: boolean): boolean {
  if (activeIsTextEntry) return false;
  return typeof scale === "number" && scale > ZOOMED_SCALE;
}

let installed = false;

/** Install once and that is enough (called by `main.tsx`); in an environment without visualViewport or a viewport meta, it does nothing */
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
