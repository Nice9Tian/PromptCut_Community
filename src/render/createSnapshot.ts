/**
 * **Generate a snapshot** of the stage at this moment: a self-contained HTML document (HTML sample
 * cache, see scripts/replay-frames.mjs).
 *
 * Originally written in `PAGE_PRELUDE` of `scripts/export-frames.mjs` (engine is now
 * `server/bakery/chrome.mjs`) and injected via `evaluateOnNewDocument`; now it is part of the page
 * bundle, shared between the export page (`ExportView`) and stage page (`StageView`), where both
 * pages have `[data-pc-scene]` as their scene root, so call sites no longer hardcode
 * `#root.firstElementChild`.
 *
 * # Five steps (task brief 3.8)
 *
 *   `cloneScene`      clone DOM
 *   `inlineDOMStyles` read computed styles and write into `style` using differential criteria
 *                     (`snapshot/inlineStyles.ts`)
 *   `rasterizeCanvas` read pixels, compress into images, and write entity boxes (`snapshot/rasterizeCanvas.ts`)
 *   `stripMedia`      retain only placeholder attributes on the media layer
 *   `serializeScene`  insert empty comments between adjacent text nodes, `outerHTML`,
 *                     rename whole-scene ids (`snapshot/renameSceneIds.ts`), extract wrapper
 *                     layer `innerHTML` per control
 *
 * The two middle steps reside in separate files and **do not import each other**: when canvas is
 * replaced with `<img>`, a separate style string must be calculated according to the IMG baseline,
 * and that bridging is written here (`inlineDOMStyles` yields `styleAs`, passed to `rasterizeCanvas`).
 *
 * # Four issues encountered in practice
 *
 *   - Styles are inlined and hardcoded with animation:none / transition:none: after injection,
 *     there must not be any running clocks;
 *   - Whole-scene HTML ids are renamed uniformly, simultaneously updating url(#…) / href="#…":
 *     SVG gradients reference by id, so if the replay page can still resolve other elements with
 *     the same name, entire fill areas will be broken (verified in growth-curve);
 *   - canvas is replaced with an image of the same size: cloned canvases are empty, causing
 *     particles and 3D scenes to disappear entirely;
 *   - An empty comment is inserted between adjacent text nodes (`keepTextBoundaries`): HTML
 *     serialization followed by parsing would merge them into one. React renders `{n}%` as two
 *     text nodes and two text spans, "75" and "%", each drawing shadow before text, with the
 *     blurred `text-shadow` of "%" overlapping "5"; merged into a single run, the shadow falls
 *     entirely underneath the text (mu-circular-progress differed by thousands of channels per
 *     frame, see `replay-mismatch-report.md` §13). Empty comments produce no layout objects and
 *     only preserve the boundary.
 *
 * Media (video / img) only strips `src`, leaving `data-pc-media-*` as is: during replay,
 * `__pcPrepareFrameMedia` restores the media for that frame and seeks into position according to
 * `data-pc-media-src` / `data-pc-media-time`. The criterion is `dataset.pcMediaSrc`, so `<img>`
 * elements with their own `src` inside cards remain unaffected and intact.
 *
 * Control snapshots only record the **wrapper layer's innerHTML** (the card component's own
 * subtree), excluding the wrapper layer itself (position / opacity / filter / zIndex / isolation:
 * regenerated as usual by Stage using the current clip upon remounting), excluding
 * `[data-pc-proxy-plane]` siblings, and excluding the media layer (`[data-pc-media]`).
 * **ids are kept as is**: the same snapshot will be mounted onto multiple clips, so renaming is
 * performed on the consumer side (see `snapshotRename.ts`).
 *
 * # Three timing values (task brief 3.8)
 *
 * `timing` splits snapshot generation into three separate reported stages: `inlineMs` (style
 * inlining), `rasterMs` (canvas rasterization), and `serializeMs` (serialization). They **do not
 * enter classification as heavy** (classification as heavy only looks at live render `stepMs`),
 * and are only used to schedule throughput for probes and prerender, making "which category of
 * card exceeds budget" visible at a glance: high `inlineMs` = DOM too complex, high `rasterMs` =
 * canvas too large.
 *
 * The task brief only calls out three functions to be timed, whereas `cloneScene` / `stripMedia`
 * among the five steps also take time, and `inlineMs + rasterMs + serializeMs` must cover the entire
 * pass (the throughput estimation in 3.8 sums four numbers). The attribution here: **`cloneScene`
 * is merged into `inlineMs`** (which also grows linearly with element count, sharing the same cause
 * as "DOM too complex"), and **`stripMedia` is merged into `serializeMs`** (it only scans the media
 * layer, negligible in magnitude).
 *
 * Timing uses `window.__pcRealNow` (attached by `stageClock` on the stage page): the export page
 * overrides `performance.now` with virtual time (`kernel/exportClock.ts`), which would measure 0
 * if used directly. The export page does not mount `__pcRealNow` and falls back to `Date.now()`:
 * that side does not report these three numbers, so precision does not matter.
 */

import { inlineDOMStyles, HTML_NS } from "./snapshot/inlineStyles";
import { rasterizeCanvas } from "./snapshot/rasterizeCanvas";
import { renameSceneIds } from "./snapshot/renameSceneIds.ts";
import { PLACEHOLDER_SELECTOR } from "./placeholderHost.ts";

export interface ControlSnapshot {
  /** data-pc-clip */
  id: string;
  /** data-pc-local-frame */
  frame: number;
  /** Wrapper layer innerHTML, ids as is */
  html: string;
}

/** Three durations of snapshot generation (milliseconds). None enter classification as heavy, see file header. */
export interface SnapshotTiming {
  /** Clone DOM + style inlining */
  inlineMs: number;
  /** Canvas rasterization (0 for cards without canvas) */
  rasterMs: number;
  /** Media layer placeholders + serialization + id renaming + slicing subtrees per control */
  serializeMs: number;
}

export interface SceneSnapshot {
  html: string;
  /** Number of canvases whose pixels could not be read and can only be left blank */
  lossy: number;
  controls: ControlSnapshot[];
  timing: SnapshotTiming;
}

const nowMs = (): number => (window.__pcRealNow ?? Date.now)();

/**
 * Step one: clone DOM. Returns two one-to-one corresponding arrays of live and cloned elements.
 *
 * **The placeholder plane is excluded from snapshots** (product/rendering.md "Fallback order":
 * never present in scenes seen by export, prerender, or Agent). It is only mounted on the preview
 * stage, but `__pcCreateSnapshot` on the stage page also runs through here: the entire tree is
 * pruned in the clone, and corresponding items in both arrays are removed together (maintaining
 * one-to-one correspondence), hiding it from style inlining, rasterization, and serialization.
 */
const PRUNE_SELECTOR = `${PLACEHOLDER_SELECTOR}, [data-pc-3d-offscreen]`;

function cloneScene(root: Element): { clone: Element; orig: Element[]; copy: Element[] } {
  const orig = [root, ...root.querySelectorAll("*")];
  const clone = root.cloneNode(true) as Element;
  const copy = [clone, ...clone.querySelectorAll("*")];
  if (!root.querySelector(PRUNE_SELECTOR)) return { clone, orig, copy };
  const keepOrig: Element[] = [];
  const keepCopy: Element[] = [];
  for (let i = 0; i < orig.length; i++) {
    const pruned = orig[i].closest(PRUNE_SELECTOR);
    if (!pruned || !root.contains(pruned) || pruned === root) {
      keepOrig.push(orig[i]);
      keepCopy.push(copy[i]);
      continue;
    }
    if (pruned === orig[i]) copy[i].remove();
  }
  return { clone, orig: keepOrig, copy: keepCopy };
}

let embedCanvas: HTMLCanvasElement | null = null;
function embedMediaIntoClone(orig: Element[], copy: Element[], styleAsImg: (el: Element) => string): void {
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i] as HTMLElement;
    if (from.tagName !== "IMG" && from.tagName !== "VIDEO") continue;
    const to = copy[i] as HTMLElement;
    if (from.tagName === "IMG") {
      const img = from as HTMLImageElement;
      const curSrc = img.getAttribute("src") || "";
      if (curSrc.startsWith("data:") && !from.dataset?.pcMediaSrc) continue;
      if (!img.complete || !(img.naturalWidth > 0 && img.naturalHeight > 0)) continue;
      const c = embedCanvas ?? (embedCanvas = document.createElement("canvas"));
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.clearRect(0, 0, c.width, c.height);
      try {
        ctx.drawImage(img, 0, 0);
        to.setAttribute("src", c.toDataURL("image/png"));
        to.style.visibility = "visible";
      } catch {
        // Leave original element untouched if cross-origin tainted
      }
      continue;
    }
    const vid = from as HTMLVideoElement;
    if (!(vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0)) continue;
    const c = embedCanvas ?? (embedCanvas = document.createElement("canvas"));
    c.width = vid.videoWidth;
    c.height = vid.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) continue;
    ctx.clearRect(0, 0, c.width, c.height);
    try {
      ctx.drawImage(vid, 0, 0);
      const repl = document.createElement("img");
      repl.setAttribute("src", c.toDataURL("image/png"));
      repl.setAttribute("style", styleAsImg(from));
      repl.style.visibility = "visible";
      to.replaceWith(repl);
    } catch {
      // Leave original element untouched if tainted
    }
  }
}

/**
 * Step four: retain only placeholder attributes on the media layer.
 *
 * Only src is stripped: snapshots do not carry external media themselves (HTML replay must not
 * fetch videos because of this), but data-pc-media-src / data-pc-media-hidden / data-pc-media-time
 * must be preserved: during replay, __pcPrepareFrameMedia relies on them to restore that frame's
 * media and seek into position.
 */
function stripMedia(orig: Element[], copy: Element[]): void {
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i] as HTMLElement;
    if (!from.dataset?.pcMediaSrc) continue;
    const to = copy[i] as HTMLElement;
    to.removeAttribute("src");
    if (from.tagName === "VIDEO") to.setAttribute("preload", "none");
    to.style.visibility = "hidden";
  }
}

/** HTML elements whose content is parsed as raw text: inserting comments inside turns them into literal text during replay */
const RAW_TEXT_TAGS = new Set(["STYLE", "SCRIPT", "TEXTAREA", "TITLE", "XMP", "IFRAME", "NOEMBED", "NOFRAMES", "NOSCRIPT", "PLAINTEXT"]);

/**
 * Insert an empty comment between adjacent text nodes, which remain two text nodes after
 * serialization and parsing (see file header "Four issues encountered in practice").
 * Modified on the clone, leaving the live DOM untouched; `orig` / `copy` only count elements,
 * so comments do not affect their correspondence.
 */
function keepTextBoundaries(clone: Element): void {
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const split: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (node.previousSibling?.nodeType !== Node.TEXT_NODE) continue;
    if (parent && parent.namespaceURI === HTML_NS && RAW_TEXT_TAGS.has(parent.tagName)) continue;
    split.push(node as Text);
  }
  for (const text of split) text.before(document.createComment(""));
}

/**
 * Step five: `outerHTML` + whole-scene id renaming + extracting wrapper layer `innerHTML` per control.
 * `flatControls`: cards inside cut segments (wrapper layers with `data-pc-flat-clip` in nested
 * scenes) also count as one control each, with id taken from `data-pc-flat-clip` (the flattened
 * virtual clip id).
 * Only needed when browser nodes produce streams for cards inside cut segments (`bakeFrame`
 * in `StageView.tsx`, [ruling] R02); omitted by default, giving other callers no extra controls.
 */
function serializeScene(root: Element, clone: Element, flatControls = false): { html: string; controls: ControlSnapshot[] } {
  keepTextBoundaries(clone);
  // Order matters (the outcome of chained renaming depends on it): deduplicate in document order,
  // with the root element's id placed last. For renaming, see `snapshot/renameSceneIds.ts`.
  const ids = new Set(
    [...root.querySelectorAll("[id]")].map((e) => e.id).concat(root.id ? [root.id] : []),
  );
  const html = renameSceneIds(clone.outerHTML, ids);
  // `:not([data-pc-media])` excludes the media layer of FrameScene: it also carries data-pc-clip
  // + data-pc-local-frame.
  const selector = flatControls
    ? "[data-pc-clip][data-pc-local-frame]:not([data-pc-media]), [data-pc-flat-clip][data-pc-local-frame]"
    : "[data-pc-clip][data-pc-local-frame]:not([data-pc-media])";
  const controls = [...clone.querySelectorAll(selector)].map((el) => {
    const inner = el.cloneNode(true) as Element;
    inner.querySelectorAll("[data-pc-proxy-plane]").forEach((plane) => plane.remove());
    return {
      id: el.getAttribute("data-pc-clip") || el.getAttribute("data-pc-flat-clip") || "",
      frame: Number(el.getAttribute("data-pc-local-frame")),
      html: inner.innerHTML,
    };
  });
  return { html, controls };
}

export function createSnapshot(root: Element | null, opts?: { flatControls?: boolean; embedMedia?: boolean }): SceneSnapshot {
  if (!root) return { html: "", lossy: 0, controls: [], timing: { inlineMs: 0, rasterMs: 0, serializeMs: 0 } };

  const t0 = nowMs();
  const { clone, orig, copy } = cloneScene(root);
  // "IMG": the branch replacing canvas with <img> must calculate separately against the IMG baseline
  // (see rasterizeCanvas.ts).
  // Baselines are prewarmed here, so rasterizeCanvas does not attach probes on first query and count
  // that time into rasterMs.
  // When cards in cut segments are also extracted as controls (`flatControls`), direct children of
  // their wrapper layers likewise inline inherited properties without exception (`isFlatClipWrapper`
  // in `inlineStyles.ts`).
  const styles = inlineDOMStyles(root, orig, copy, ["IMG"], { flatWrappers: opts?.flatControls === true });
  const t1 = nowMs();

  const { lossy } = rasterizeCanvas(orig, copy, (el) => styles.styleAs(el, "IMG", HTML_NS));
  const t2 = nowMs();

  if (opts?.embedMedia) {
    embedMediaIntoClone(orig, copy, (el) => styles.styleAs(el, "IMG", HTML_NS));
  } else {
    stripMedia(orig, copy);
  }
  const { html, controls } = serializeScene(root, clone, opts?.flatControls === true);
  const t3 = nowMs();

  return { html, lossy, controls, timing: { inlineMs: t1 - t0, rasterMs: t2 - t1, serializeMs: t3 - t2 } };
}
