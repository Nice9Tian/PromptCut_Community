import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ToolCallInfo } from "../../../ai/types";
import { reportTitle, type ProgressReport } from "../../../ai/progressReport";
import type { InboundAgentMessage } from "../../../ai/types";
import { findTabByConversation } from "../../../ai/agentTabs";
import { Gif, loadVisualRecord, peekVisualRecord, visualIdOf, type VisualRecord } from "../ToolVisual";
import { usePrerenderBase, withBase } from "../../../render/prerender";
import { KIND_LABEL, bareToolName, toolKind } from "./iconRuns";
import "./agent.css";
import { AgentUndoButton } from "../../sync/AgentUndoButton";
import { tr } from "../../../i18n/index.ts";

/**
 * Operation detail preview control: **all** the detail of one Agent bubble is shown here, and a bubble holds only one.
 *
 * Above the bubble is a row of icons (received Agent messages, individual operations, stages / the
 * summary of this round). Clicking an icon does not expand any list; it only makes this control jump
 * to that item. The control lays every item out in order as pages:
 *   - Received Agent message: shows only the message content;
 *   - Operation with visuals: one page per image viewed, one page per modification that has
 *     before/after animations, one page for parameter-only differences;
 *     the first line of the operation (category, tool name, duration) is overlaid above the visual,
 *     and the note from the result is overlaid below it (semi-transparent darkened background);
 *   - Operation without visuals (find / read, UI operation, chat, failure...): one operation card.
 *     Find shows parameters and result content, chat shows only content, failure shows only the error;
 *   - Summary: one page, green ✓ / yellow ! / red !, followed by done / to-do / issues.
 *
 * Track latest: by default it stays on the latest item. A message that is still running pages
 * forward one page at a time (it turns only once the next page has rendered, and at least
 * AUTO_STEP_MS apart); a message that has finished stays on the last page. If the user clicks an
 * icon that is not the latest, or pages backward, it stops following and "Track latest" appears at
 * the top; clicking the latest icon, paging back to the last page, or clicking that button resumes following.
 *
 * It can only turn to a **rendered page**: an image is ready once loaded (or definitely unretrievable),
 * and a modification page is ready once its animations are out (or definitely failed); text pages
 * are ready by nature. Turning toward a page that is not ready does not switch; it first starts
 * rendering it (only one page is prerendered at a time), then switches automatically once ready.
 */

/** Turn the page after dragging this far */
const SWIPE_PX = 40;
/** A fast enough flick also turns the page (pixels / millisecond), even if SWIPE_PX was not reached */
const FLING_SPEED = 0.5;
/** Only moving this far after press counts as a drag; anything shorter counts as a click */
const DRAG_SLOP = 6;
/** Horizontal wheel delta must accumulate to this much before turning one page */
const WHEEL_PX = 60;
/** Wheel events within this long after a page turn are ignored: a trackpad sends a string of inertia
 * events after release, and without this guard one flick turns several pages */
const WHEEL_LOCK_MS = 350;
/** The page-turn zones are this wide on each side of the frame */
const EDGE = 0.22;
/** Minimum interval between two switches when a running message auto-pages forward */
const AUTO_STEP_MS = 1500;
/**
 * Maximum number of dots shown: only these few around the current page are shown, instead of laying
 * out dots for dozens of pages.
 * When there are more pages outside the window, the outermost dot of the window shrinks to hint that
 * you can still turn that way; the other pages stay cached, and drag, wheel and arrow keys all reach them.
 */
const MAX_DOTS = 5;

/** In an old message the tool result holds only a file path: only a recognizable image produces a page (same check as in operation details) */
const IMG_RE = /\.(png|jpe?g)$/i;

type DiffRow = NonNullable<VisualRecord["diff"]>[number];

/** Summary color: ok = green ✓, warn = issues reported (yellow !), err = this round ended with an error (red !) */
export type SummaryTone = "ok" | "warn" | "err";
export const SUMMARY_TONE_TEXT: Record<SummaryTone, string> = { ok: tr("No issues"), warn: tr("Issues to review"), err: tr("Error occurred") };

/** One item the control displays, matching one icon on the bubble (same key) */
export type DetailItem =
  | { type: "inbound"; key: string; messages: InboundAgentMessage[] }
  | { type: "run"; key: string; tools: ToolCallInfo[] }
  | { type: "report"; key: string; report: ProgressReport; tone: SummaryTone };

interface PageBase {
  /** Unique within this message, used as the React key */
  id: string;
  /** Which item this page belongs to (the icon's full key) */
  itemKey: string;
  /** Name of the tool that produced this page; the caption line derives the action category from it */
  tool: string;
  /** Visual page: index, within its item, of the operation that produced it; the first line and note overlaid on the visual are looked up by it */
  call?: number;
}

/** One page of the control */
export type DetailPage =
  /** One image viewed. viaPrerender = an image from the visual record, whose address hangs on the prerender process, so its origin must be prepended */
  | (PageBase & { kind: "image"; src: string; viaPrerender: boolean; label?: string })
  /** Before/after animations (adding a card has only "after", deleting a card has only "before") + parameter differences */
  | (PageBase & { kind: "change"; before?: string; after?: string; beforeLabel: string; afterLabel: string; diff: DiffRow[] })
  /** Parameter differences only, no animation */
  | (PageBase & { kind: "diff"; diff: DiffRow[] })
  /** One operation without visuals: an operation card (content is fetched from items at render time) */
  | (PageBase & { kind: "ops" })
  /** Summary */
  | (PageBase & { kind: "summary" })
  /** Received Agent message */
  | (PageBase & { kind: "inbound" });

const isVisualPage = (p: DetailPage) => p.kind === "image" || p.kind === "change" || p.kind === "diff";

/** Turn a file path in an old message into an address the page can open (same construction as in ToolDetail) */
function legacyUrl(f: string): string {
  return f.startsWith("http") || f.startsWith("data:") ? f : `/@fs/${f.replace(/\\/g, "/").replace(/^\/?/, "")}`;
}

/** Split one visual record into pages: one page per image; one "Modification" page if there are before/after animations; one "Diff" page if there are only parameter differences */
function recordPages(out: DetailPage[], rec: VisualRecord, idBase: string, itemKey: string, tool: string, call: number) {
  rec.images?.forEach((im, i) => {
    out.push({ kind: "image", id: `${idBase}:i${i}`, itemKey, tool, call, src: im.url, viaPrerender: true, label: im.label });
  });
  if (rec.before || rec.after) {
    out.push({
      kind: "change",
      id: `${idBase}:c`,
      itemKey,
      tool,
      call,
      before: rec.before?.gif,
      after: rec.after?.gif,
      // Labels match ToolVisual: only "after" is a newly added card (or the whole motion graphics of get_gif), only "before" is a deleted card
      beforeLabel: rec.after ? tr("Before") : tr("Deleted card"),
      afterLabel: rec.before ? tr("After") : rec.tool === "get_gif" ? tr("Full animation") : tr("New card"),
      diff: rec.diff ?? [],
    });
  } else if (rec.diff?.length) {
    out.push({ kind: "diff", id: `${idBase}:d`, itemKey, tool, call, diff: rec.diff });
  }
}

/**
 * Collect pages in item order. If an operation item produces visuals (has a visual record, or an
 * image file in an old message), it yields visual pages; records not yet fetched are skipped and
 * appear on the next render after they arrive; a record whose fetch failed does not count as having visuals.
 * An operation item with no visuals at all yields one operation card (only if at least one
 * operation produced a result).
 */
function pagesOf(items: DetailItem[], failed: ReadonlySet<string>): DetailPage[] {
  const out: DetailPage[] = [];
  for (const item of items) {
    if (item.type === "inbound") {
      out.push({ kind: "inbound", id: `${item.key}:inbound`, itemKey: item.key, tool: "" });
      continue;
    }
    if (item.type === "report") {
      out.push({ kind: "summary", id: `${item.key}:summary`, itemKey: item.key, tool: "" });
      continue;
    }
    const done = item.tools.filter((t) => t.ok !== undefined);
    if (!done.length) continue;
    const hasVisual = done.some((t) => {
      const vid = visualIdOf(t.summary);
      return (vid && !failed.has(vid)) || (t.files || []).some((f) => IMG_RE.test(f));
    });
    if (!hasVisual) {
      out.push({ kind: "ops", id: `${item.key}:ops`, itemKey: item.key, tool: item.tools[0].name });
      continue;
    }
    item.tools.forEach((tool, ti) => {
      if (tool.ok === undefined) return;
      const idBase = `${item.key}:${ti}`;
      const vid = visualIdOf(tool.summary);
      if (vid) {
        const rec = peekVisualRecord(vid);
        if (rec) recordPages(out, rec, `${idBase}:${vid}`, item.key, tool.name, ti);
        return;
      }
      (tool.files || []).forEach((f, fi) => {
        if (!IMG_RE.test(f)) return;
        const label = f.split(/[\\/]/).pop();
        out.push({ kind: "image", id: `${idBase}:f${fi}`, itemKey: item.key, tool: tool.name, call: ti, src: legacyUrl(f), viaPrerender: false, label });
      });
    });
  }
  return out;
}

/**
 * Collect pages from a list of items. Visual records go through ToolVisual's module-level cache, and
 * the same id is fetched only once; every time one is fetched (or fails) we recompute, so pages
 * appear progressively as records arrive.
 */
export function useDetailPages(items: DetailItem[]): DetailPage[] {
  const [loadedCount, bump] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(false);
  /** Ids this component has already requested: failed fetches are not retried over and over here */
  const tried = useRef(new Set<string>());
  /** Ids whose fetch failed: these operations yield an operation card as "no visuals" */
  const failed = useRef(new Set<string>());

  const idSet = new Set<string>();
  const keyBits: string[] = [];
  for (const item of items) {
    if (item.type !== "run") {
      keyBits.push(`${item.key}|${item.type}`);
      continue;
    }
    for (const t of item.tools) {
      const done = t.ok !== undefined;
      const id = done ? visualIdOf(t.summary) : null;
      if (id) idSet.add(id);
      keyBits.push(`${item.key}|${done ? 1 : 0}|${id ?? ""}|${done ? (t.files || []).join(",") : ""}`);
    }
  }
  const ids = [...idSet];
  const idsKey = ids.join(",");
  const itemsKey = keyBits.join(";");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    for (const id of ids) {
      if (peekVisualRecord(id) || tried.current.has(id)) continue;
      tried.current.add(id);
      loadVisualRecord(id).then(
        () => { if (mounted.current) bump(); },
        () => {
          failed.current.add(id);
          if (mounted.current) bump();
        },
      );
    }
    // ids is fully determined by idsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // items is a new array on every render; memoize by a content-based key so the pages reference the control gets stays stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pagesOf(items, failed.current), [itemsKey, loadedCount]);
}

/** Duration: milliseconds under one second, one decimal under ten seconds, whole seconds beyond that */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

// The title is written in one place only, in src/ai/progressReport.ts

/** The phrase on the left of the caption line */
function pageCaption(p: DetailPage, item: DetailItem | undefined): string {
  if (p.kind === "inbound") return tr("Chat · received {0} messages", item?.type === "inbound" ? item.messages.length : 0);
  // Whether a summary is good or bad is conveyed only by the color and glyph of green ✓ / yellow ! / red !; text such as "has issues, check" is no longer written
  if (p.kind === "summary") return item?.type === "report" ? reportTitle(item.report) : tr("Summary");
  if (p.kind === "ops") {
    const tools = item?.type === "run" ? item.tools : [];
    const names = [...new Set(tools.map((t) => bareToolName(t.name)))].join(tr(", ")) || bareToolName(p.tool);
    const label = tools.some((t) => t.ok === false) ? tr("Failed") : KIND_LABEL[toolKind(p.tool)];
    return `${label} · ${names}${tools.length > 1 ? ` ×${tools.length}` : ""}`;
  }
  const kind = KIND_LABEL[toolKind(p.tool)];
  const what =
    p.kind === "image"
      ? p.label || p.tool
      : p.kind === "change"
        ? p.before && p.after
          ? `${p.beforeLabel} → ${p.afterLabel}`
          : p.after
            ? p.afterLabel
            : p.beforeLabel
        : tr("{0} parameters changed", p.diff.length);
  return `${kind} · ${what}`;
}

/** Icon on "Track latest": a double arrow pointing to the end */
function IconFollowLatest(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4l4 4-4 4M8.5 4l4 4-4 4" />
    </svg>
  );
}

export function OpDetailPreview(props: {
  pages: DetailPage[];
  /** The item a page belongs to: operation cards, summaries and received messages fetch their content by it */
  items: DetailItem[];
  /** Click an icon to jump to a page: seq increases by one on every click, jumping to the first page of the key's item; clicking the latest item tracks latest */
  jump?: { key: string; seq: number } | null;
  /** The current page changed (auto-tracking or turned by the user): report the key of this page's item, byUser = turned / clicked by the user */
  onPage?: (itemKey: string, byUser: boolean) => void;
  /** The message is still running: when tracking latest, page forward one page at a time */
  live?: boolean;
}): JSX.Element | null {
  const { pages, items, jump, onPage, live } = props;
  const n = pages.length;
  // Both the current page and the "page to go to" are recorded by page id: visual records are fetched asynchronously, and a new page may be inserted before the current one; recording by index would silently swap the page being viewed.
  // By default stay on the latest item: a running message pages forward from the start, a finished one stays on the last page (when there are no pages yet, wait for pages to appear and then apply this rule)
  const [curId, setCurId] = useState<string | null>(() => (pages.length ? (live ? pages[0].id : pages[pages.length - 1].id) : null));
  /** Offset (px) that follows the pointer during a drag */
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** The arrow shows only on the side whose page-turn zone the mouse is over */
  const [hover, setHover] = useState<"prev" | "next" | null>(null);
  /** Rendered pages (image / animation loaded, or definitely failed) */
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  /** Page the user wants to go to but that is not rendered yet (by page id): switch to it once rendered */
  const [wantedId, setWantedId] = useState<string | null>(null);
  /** Track latest */
  const [follow, setFollow] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; t: number; moved: boolean } | null>(null);
  /**
   * Pages that have been turned to. Animations in "Modification" pages are mounted only in these pages
   * (and the one being prerendered): the server takes seconds to tens of seconds to render one
   * animation on demand, and triggering all animations as soon as a message opens would overwhelm the
   * prerender process.
   */
  const seen = useRef(new Set<string>());
  /** Time of the last page switch: auto-paging uses it to enforce the minimum interval */
  const lastSwitchAt = useRef(0);
  /** Whether the next page change is made by the user (reported to onPage) */
  const byUserRef = useRef(false);
  const base = usePrerenderBase();
  /** Index of the current page at the last render: when the current page is gone (e.g. a visual record fetch failed and was replaced by an operation card), stay near the original position */
  const lastIndex = useRef(0);
  const found = curId ? pages.findIndex((p) => p.id === curId) : -1;
  const cur = found >= 0 ? found : n === 0 ? 0 : curId === null ? (live ? 0 : n - 1) : Math.min(lastIndex.current, n - 1);
  lastIndex.current = cur;
  const itemByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items]);

  const isReady = (i: number): boolean => {
    const p = pages[i];
    return !!p && (!isVisualPage(p) || p.kind === "diff" || ready.has(p.id));
  };
  const markReady = useCallback((id: string) => {
    setReady((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const show = (i: number) => {
    lastSwitchAt.current = performance.now();
    setCurId(pages[i].id);
  };

  const go = (i: number, byUser: boolean) => {
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, i));
    if (byUser) {
      setFollow(next >= n - 1);
      byUserRef.current = true;
    }
    if (next === cur) {
      setWantedId(null);
      return;
    }
    if (isReady(next)) {
      setWantedId(null);
      show(next);
    } else {
      // Not rendered yet: do not switch, first start rendering it, and the effect below switches once it is ready
      setWantedId(pages[next].id);
    }
  };
  // The native wheel listener is attached only once, and gets the latest page index and page-turn function through a ref
  const goRef = useRef(go);
  goRef.current = go;
  const curRef = useRef(cur);
  curRef.current = cur;

  const followLatest = () => {
    byUserRef.current = true;
    setFollow(true);
    go(n - 1, false);
  };

  const wantedIdx = wantedId ? pages.findIndex((p) => p.id === wantedId) : -1;
  const wantedPage = wantedIdx >= 0 ? wantedIdx : null;
  // Which page to switch to next: the one the user clicked takes priority; when tracking latest, a running message pages forward one page, and a finished one goes straight to the last page
  const target = wantedPage ?? (follow && cur < n - 1 ? (live ? cur + 1 : n - 1) : null);
  // The page to go to is not ready, so mount it first and start rendering (only this one page is prerendered at a time)
  const preloadId = target !== null && target !== cur && !isReady(target) ? pages[target].id : null;

  // The first page's first display also counts as a switch: the second page will not flash past right after the first
  const curReady = n > 0 && isReady(cur);
  const shownOnce = useRef(false);
  useEffect(() => {
    if (curReady && !shownOnce.current) {
      shownOnce.current = true;
      lastSwitchAt.current = performance.now();
    }
  }, [curReady]);

  // Switch only once the target page has rendered: pages the user clicked and finished messages switch immediately; for a running message's auto-paging, if less than AUTO_STEP_MS has passed since the last switch, wait until it has.
  // No auto-paging during a drag
  useEffect(() => {
    if (target === null || target === cur || dragging || !isReady(target)) return;
    const auto = wantedPage === null;
    const wait = auto && live ? Math.max(0, lastSwitchAt.current + AUTO_STEP_MS - performance.now()) : 0;
    const timer = window.setTimeout(() => {
      show(target);
      if (!auto) setWantedId(null);
    }, wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, cur, dragging, ready, wantedPage, live]);

  // When the current page changes, report it to the bubble: it uses this to outline / glow the matching icon
  const pageId = n > 0 ? pages[cur].id : null;
  useEffect(() => {
    if (!pageId) return;
    onPage?.(pages[cur].itemKey, byUserRef.current);
    byUserRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // Click coming from the icon side: if it is the latest item, track latest; otherwise jump to its first page (if not rendered yet, wait until it is, then jump)
  useEffect(() => {
    if (!jump || !n) return;
    byUserRef.current = true;
    if (jump.key === pages[n - 1].itemKey) {
      setFollow(true);
      go(n - 1, false);
      return;
    }
    const i = pages.findIndex((p) => p.itemKey === jump.key);
    if (i >= 0) go(i, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq]);

  // Trackpad / mouse horizontal scroll (or Shift + wheel) turns pages.
  // React's onWheel is a passive listener and cannot stop the browser's own horizontal gestures (back / forward), so attach a native non-passive listener
  const hasPages = n > 0;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    let acc = 0;
    let lockUntil = 0;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return; // Vertical scrolling belongs to the message list (or the operation card's own scroll)
      e.preventDefault();
      const now = performance.now();
      if (now < lockUntil) {
        // Inertia is still scrolling: extend the lock a little, and accept the next one only after this string of events stops
        lockUntil = Math.max(lockUntil, now + 120);
        acc = 0;
        return;
      }
      acc += dx * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      if (Math.abs(acc) >= WHEEL_PX) {
        goRef.current(curRef.current + (acc > 0 ? 1 : -1), true);
        acc = 0;
        lockUntil = now + WHEEL_LOCK_MS;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasPages]);

  /** Which side's page-turn zone the pointer is in; a side at the end does not count */
  const sideOf = (clientX: number): "prev" | "next" | null => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = (clientX - r.left) / Math.max(1, r.width);
    if (f < EDGE && cur > 0) return "prev";
    if (f > 1 - EDGE && cur < n - 1) return "next";
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !n) return;
    // Things that handle clicks / text selection themselves, such as the animation's "Retry" and text in the operation card, are not treated as a drag or page turn
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, summary, pre, .ai-odp-text")) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) {
      if (e.pointerType === "mouse" && !e.buttons) setHover(sideOf(e.clientX));
      return;
    }
    const dx = e.clientX - g.x;
    if (!g.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      // A vertical drag is most likely an attempt to scroll the message list (touch screen), so leave it to the browser
      if (Math.abs(e.clientY - g.y) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      g.moved = true;
      setDragging(true);
      setHover(null);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* The pointer is already released, so it does not matter if capture fails */
      }
    }
    // At both ends there is nothing to drag to, and a neighbor page that is not rendered yet cannot be dragged to either: give only a third of the displacement, so it feels like "reached the end"
    const blocked = dx > 0 ? cur === 0 || !isReady(cur - 1) : cur === n - 1 || !isReady(cur + 1);
    setDrag(blocked ? dx / 3 : dx);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    const dx = e.clientX - g.x;
    if (g.moved) {
      const speed = Math.abs(dx) / Math.max(1, performance.now() - g.t);
      setDragging(false);
      setDrag(0);
      if (!cancelled && (Math.abs(dx) > SWIPE_PX || (Math.abs(dx) > DRAG_SLOP * 2 && speed > FLING_SPEED))) {
        go(cur + (dx < 0 ? 1 : -1), true);
      }
      return;
    }
    if (cancelled) return;
    // No drag = a click: the left and right sides are page-turn zones, the middle does nothing
    const side = sideOf(e.clientX);
    if (side === "prev") go(cur - 1, true);
    else if (side === "next") go(cur + 1, true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // The editor also handles arrow keys globally (moving the playhead); when the frame has focus they belong to the control
    e.preventDefault();
    e.stopPropagation();
    go(cur + (e.key === "ArrowRight" ? 1 : -1), true);
  };

  if (!n) return null;
  const page = pages[cur];
  seen.current.add(page.id);
  const loading = (id: string) => seen.current.has(id) || id === preloadId;
  const toolsOf = (key: string) => {
    const it = itemByKey.get(key);
    return it?.type === "run" ? it.tools : [];
  };
  const caption = pageCaption(page, itemByKey.get(page.itemKey));
  // Dot window: keep the current page centered where possible, and shift inward when it hits an edge
  const dotStart = Math.max(0, Math.min(cur - Math.floor(MAX_DOTS / 2), n - MAX_DOTS));
  const dotEnd = Math.min(n, dotStart + MAX_DOTS);

  const body = (p: DetailPage): ReactNode => {
    const it = itemByKey.get(p.itemKey);
    if (p.kind === "ops") return <OpCards tools={toolsOf(p.itemKey)} />;
    if (p.kind === "summary") return it?.type === "report" ? <SummaryCard report={it.report} tone={it.tone} /> : null;
    if (p.kind === "inbound") return it?.type === "inbound" ? <InboundCards messages={it.messages} /> : null;
    // Visual page: overlay the operation's first line above the visual and the note from the result below it (only if present); neither layer takes mouse events, so drag-to-turn works as before
    const call = it?.type === "run" && p.call !== undefined ? it.tools[p.call] : undefined;
    const note = call ? noteOf(call) : "";
    return (
      <>
        {/* D5: same-origin fallback has been removed; without the prerender origin there is no address to build */}
        {base === null ? <div className="ai-visual-note">{tr("The prerender process is not ready yet, can't retrieve the visual")}</div> : <PageBody p={p} base={base} loadGif={loading(p.id)} onReady={markReady} />}
        {call ? (
          <div className="ai-odp-over-head" data-pc="odp-over-head">
            <OpHead t={call} />
          </div>
        ) : null}
        {/* The step that changed the project can also be "Undo this step" on the visual page: the old
   "Agent operation log" at the bottom of the AI panel had it on every row; after that block was
   replaced by "Agent operations", undo lives only in this control (2026-10-20) */}
        {call && call.ok === true && (p.kind === "change" || p.kind === "diff") ? (
          <div className="ai-odp-over-undo" data-pc="odp-over-undo">
            <AgentUndoButton callId={call.callId} />
          </div>
        ) : null}
        {note ? (
          <div className="ai-odp-over-note" data-pc="odp-over-note">
            {note}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="ai-carousel ai-odp" data-pc="op-detail-preview">
      <div className="ai-odp-head">
        <span className="ai-carousel-label" title={caption}>{caption}</span>
        {!follow ? (
          <button type="button" className="ai-odp-follow" data-pc="odp-follow" onClick={followLatest}>
            <IconFollowLatest />
            {tr("Click to follow latest")}
          </button>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className={`ai-carousel-frame${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-roledescription={tr("Operation detail preview")}
        aria-label={tr("Operation detail preview, page {0} of {1}", cur + 1, n)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="ai-carousel-track" style={{ transform: `translateX(calc(${-cur * 100}% + ${drag}px))` }}>
          {pages.map((p, i) => (
            <div key={p.id} className={`ai-carousel-page is-${p.kind}`} aria-hidden={i !== cur} data-ready={isReady(i) ? "" : undefined}>
              {/* Only mount the current page, left and right neighbors (neighbors are visible when dragging, and
                  images pre-load along the way), and the page currently being prerendered; unmount when paged far
                  away, so images and GIFs in the whole message don't stay mounted. Record visited pages in seen, so
                  GIFs load directly upon returning (browser cache) */}
              {Math.abs(i - cur) <= 1 || p.id === preloadId ? body(p) : null}
            </div>
          ))}
        </div>
        {/* The current page isn't rendered yet: cover it with a notice so no half-drawn image shows */}
        {!curReady ? <div className="ai-carousel-wait" role="status">{tr("Rendering frame…")}</div> : null}
        {cur > 0 ? <span className={`ai-carousel-arrow is-prev${hover === "prev" ? " is-on" : ""}`} aria-hidden>‹</span> : null}
        {cur < n - 1 ? <span className={`ai-carousel-arrow is-next${hover === "next" ? " is-on" : ""}`} aria-hidden>›</span> : null}
      </div>
      {n > 1 ? (
        <div className="ai-odp-foot">
          <div className="ai-carousel-dots" data-pc="ai-carousel-dots">
            {pages.slice(dotStart, dotEnd).map((p, k) => {
              const i = dotStart + k;
              const pending = i !== cur && !isReady(i);
              // There are more pages beyond the window: shrink the outermost dots
              const edge = (k === 0 && dotStart > 0) || (i === dotEnd - 1 && dotEnd < n);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`ai-carousel-dot${i === cur ? " is-on" : ""}${pending ? " is-pending" : ""}${wantedPage === i ? " is-wanted" : ""}${edge ? " is-edge" : ""}`}
                  aria-label={pending ? tr("Page {0} (still rendering, will switch automatically when ready)", i + 1) : tr("Page {0}", i + 1)}
                  aria-current={i === cur ? "true" : undefined}
                  title={pending ? tr("Still rendering, will switch automatically when ready") : undefined}
                  onClick={() => go(i, true)}
                />
              );
            })}
          </div>
          <span className="ai-carousel-count">
            {wantedPage !== null ? tr("Rendering… ") : ""}
            {cur + 1} / {n}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ── Text pages: operation card, summary, received messages ───────────────────────── */

/** If the result summary is JSON, parse it into an object; otherwise treat it as plain text */
function parseResult(summary?: string): unknown {
  if (!summary) return null;
  try {
    return JSON.parse(summary);
  } catch {
    return summary;
  }
}

/** These fields are for the UI / the model to recognize, not content meant for humans to read */
const HIDDEN_KEYS = new Set(["ok", "visualId"]);

/** Squash one value into a single line of text */
function short(v: unknown, max = 80): string {
  let s: string;
  if (v === null || v === undefined) s = "—";
  else if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else if (Array.isArray(v)) s = tr("{0} items", v.length);
  else {
    s = Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !HIDDEN_KEYS.has(k))
      .map(([k, x]) => `${k}: ${x !== null && typeof x === "object" ? (Array.isArray(x) ? tr("{0} items", x.length) : "{…}") : String(x)}`)
      .join(",");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function ShortList({ list, max }: { list: unknown[]; max: number }): JSX.Element {
  return (
    <ul className="ai-opcard-list">
      {list.slice(0, max).map((x, i) => (
        <li key={i}>{short(x)}</li>
      ))}
      {list.length > max ? <li className="more">{tr("{0} more items", list.length - max)}</li> : null}
    </ul>
  );
}

/**
 * Result content: objects get one line per field, arrays give the count and the first few items,
 * text is shown as is
 */
function ResultFields({ value }: { value: unknown }): JSX.Element | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "object") return <div className="ai-opcard-text">{short(value, 600)}</div>;
  if (Array.isArray(value)) return value.length ? <ShortList list={value} max={8} /> : <div className="ai-opcard-text is-faint">{tr("No results")}</div>;
  const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => !HIDDEN_KEYS.has(k));
  if (!entries.length) return <div className="ai-opcard-text is-faint">{tr("Done")}</div>;
  return (
    <dl className="ai-opcard-fields">
      {entries.slice(0, 12).map(([k, v]) => (
        <div key={k} className="row">
          <dt>{k}</dt>
          <dd>
            {Array.isArray(v) ? (
              <>
                {tr("{0} items", v.length)}
                {v.length ? <ShortList list={v} max={5} /> : null}
              </>
            ) : (
              short(v, 160)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Squash the params into one line: params · a: 1 · b: x */
function paramsLine(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return tr("Parameters · ") + entries.map(([k, v]) => `${k}: ${short(v, 40)}`).join(" · ");
}

/** Replace a chat ID with its tab name; if not found, give a short ID */
function agentName(conversationId: unknown): string {
  const id = String(conversationId ?? "");
  // i18n-allow: older records name an unknown writer in Chinese
  if (!id || id === "unknown" || id === "未知") return tr("Unknown Agent");
  return findTabByConversation(id)?.title ?? `Agent ${id.slice(0, 8)}`;
}

function errorText(t: ToolCallInfo, res: unknown): string {
  if (res && typeof res === "object" && typeof (res as { error?: unknown }).error === "string") return (res as { error: string }).error;
  return typeof res === "string" && res ? res : t.summary || tr("Failed, no reason returned");
}

/** Chat operations (between multiple Agents): show the content only */
function agentContent(t: ToolCallInfo, res: unknown): ReactNode {
  const name = bareToolName(t.name);
  const input = (t.input && typeof t.input === "object" ? t.input : {}) as Record<string, unknown>;
  if (name === "send_message") {
    const to = String(input.to ?? "");
    return (
      <>
        <div className="ai-opcard-to">{tr("Sent to {0}", to === "all" ? tr("All Agents") : agentName(to))}</div>
        <div className="ai-opcard-text">{String(input.text ?? "")}</div>
      </>
    );
  }
  if (name === "declare_scope") {
    return (
      <div className="ai-opcard-text">
        {tr("Declared scope: {0}{1}", String(input.scope ?? ""), input.note ? `\n${String(input.note)}` : "")}
      </div>
    );
  }
  const r = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  if (name === "check_messages") {
    const msgs = Array.isArray(r.messages) ? (r.messages as { from?: unknown; text?: unknown }[]) : [];
    return msgs.length ? (
      msgs.map((m, i) => (
        <div key={i} className="ai-opcard-msg">
          <div className="ai-opcard-to">{tr("From {0}", agentName(m.from))}</div>
          <div className="ai-opcard-text">{String(m.text ?? "")}</div>
        </div>
      ))
    ) : (
      <div className="ai-opcard-text is-faint">{tr("No new messages")}</div>
    );
  }
  if (name === "list_agents") {
    const agents = Array.isArray(r.agents) ? (r.agents as { title?: unknown; scope?: unknown; you?: unknown; busy?: unknown }[]) : [];
    return agents.length ? (
      <ul className="ai-opcard-list">
        {agents.map((a, i) => (
          <li key={i}>
            {String(a.title ?? "")}
            {a.scope ? ` · ${String(a.scope)}` : ""}
            {a.you ? tr("(you)") : ""}
            {a.busy ? tr(" · running") : ""}
          </li>
        ))}
      </ul>
    ) : (
      <div className="ai-opcard-text is-faint">{tr("No other Agents")}</div>
    );
  }
  return <ResultFields value={res} />;
}

/**
 * First line of an operation: category chip + category (write "Failed" on failure) + tool name +
 * duration. Used by the operation card; the visual page also overlays it above the picture
 */
function OpHead({ t }: { t: ToolCallInfo }): JSX.Element {
  const kind = toolKind(t.name);
  return (
    <div className="ai-opcard-head">
      <span className={`ai-op ai-op--${kind}${t.ok === false ? " is-err" : ""} ai-opcard-chip`} aria-hidden />
      <span className="ai-opcard-kind">{t.ok === false ? tr("Failed") : KIND_LABEL[kind]}</span>
      <span className="ai-opcard-name">{bareToolName(t.name)}</span>
      {typeof t.durationMs === "number" ? <span className="ai-opcard-dur">{fmtDuration(t.durationMs)}</span> : null}
    </div>
  );
}

/** The human-readable sentence in the result (the note field); if there is none, don't overlay it */
function noteOf(t: ToolCallInfo): string {
  if (t.ok !== true) return "";
  const res = parseResult(t.summary);
  const note = res && typeof res === "object" ? (res as { note?: unknown }).note : undefined;
  return typeof note === "string" ? note.trim() : "";
}

/** The card for one operation: first line (OpHead), content below */
function OpCard({ t }: { t: ToolCallInfo }): JSX.Element {
  const kind = toolKind(t.name);
  const res = t.ok === undefined ? null : parseResult(t.summary);
  let content: ReactNode;
  if (t.ok === undefined) content = <div className="ai-opcard-text is-faint">{tr("In progress…")}</div>;
  else if (t.ok === false) content = <div className="ai-opcard-error">{errorText(t, res)}</div>;
  else if (kind === "agent") content = agentContent(t, res);
  else {
    const params = paramsLine(t.input);
    content = (
      <>
        {params ? <div className="ai-opcard-params">{params}</div> : null}
        <ResultFields value={res} />
      </>
    );
  }
  return (
    <div className={`ai-opcard${t.ok === false ? " is-err" : ""}`} data-pc="op-card">
      <OpHead t={t} />
      {content}
      {t.ok === true ? <AgentUndoButton callId={t.callId} /> : null}
    </div>
  );
}

function OpCards({ tools }: { tools: ToolCallInfo[] }): JSX.Element {
  if (!tools.length) return <div className="ai-carousel-note">{tr("No operation records")}</div>;
  return (
    <div className="ai-odp-text">
      {tools.map((t, i) => (
        <OpCard key={i} t={t} />
      ))}
    </div>
  );
}

const REPORT_GROUPS = [
  { field: "done", label: tr("Completed"), mark: "✓", cls: "is-done" },
  { field: "todo", label: tr("To do"), mark: "○", cls: "is-todo" },
  { field: "problems", label: tr("Problems"), mark: "!", cls: "is-problem" },
] as const;

/**
 * Summary page: the first line is a chip (green ✓ / yellow ! / red !) + title (good or bad is shown
 * only by color and glyph, no text), below it three groups of items (empty groups are hidden)
 */
function SummaryCard({ report, tone }: { report: ProgressReport; tone: SummaryTone }): JSX.Element {
  const groups = REPORT_GROUPS.filter((g) => report[g.field].length > 0);
  return (
    <div className={`ai-odp-text ai-odp-summary tone-${tone}`} data-pc="op-summary">
      <div className="ai-opcard-head">
        <span className={`ai-op ai-op--summary tone-${tone} ai-opcard-chip`} role="img" aria-label={SUMMARY_TONE_TEXT[tone]} />
        <span className="ai-opcard-kind">{reportTitle(report)}</span>
      </div>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.field} className={`ai-report-group ${g.cls}`}>
            <div className="ai-report-label">
              <span className="ai-report-mark" aria-hidden>{g.mark}</span>
              {g.label}
            </div>
            <ul className="ai-report-list">
              {report[g.field].map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="ai-report-empty">{tr("(nothing to report)")}</div>
      )}
    </div>
  );
}

/** A received Agent message: show the content only */
function InboundCards({ messages }: { messages: InboundAgentMessage[] }): JSX.Element {
  return (
    <div className="ai-odp-text">
      {messages.map((m, i) => (
        <div key={i} className="ai-opcard" data-pc="op-inbound">
          <div className="ai-opcard-head">
            <span className="ai-op ai-op--agent ai-opcard-chip" aria-hidden />
            <span className="ai-opcard-kind">{tr("Message received")}</span>
            <span className="ai-opcard-name is-plain">{tr("From {0}", agentName(m.from))}</span>
          </div>
          <div className="ai-opcard-text">{m.text}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Visual page ────────────────────────────────────────────────────────────── */

function PageBody({ p, base, loadGif, onReady }: { p: DetailPage; base: string; loadGif: boolean; onReady: (id: string) => void }): JSX.Element | null {
  if (p.kind === "image") {
    return <PageImage key={p.src} src={p.viaPrerender ? withBase(base, p.src) : p.src} label={p.label} onSettled={() => onReady(p.id)} />;
  }
  if (p.kind === "diff") {
    return (
      <div className="ai-carousel-diff">
        <DiffList diff={p.diff} />
      </div>
    );
  }
  if (p.kind === "change") return <ChangeBody p={p} base={base} loadGif={loadGif} onReady={onReady} />;
  return null;
}

/** Edit page: it counts as rendered once both the before and after animated images are out (or have definitely failed) */
function ChangeBody({ p, base, loadGif, onReady }: { p: Extract<DetailPage, { kind: "change" }>; base: string; loadGif: boolean; onReady: (id: string) => void }): JSX.Element {
  const settled = useRef(new Set<"before" | "after">());
  const need = (p.before ? 1 : 0) + (p.after ? 1 : 0);
  const settle = (which: "before" | "after") => {
    settled.current.add(which);
    if (settled.current.size >= need) onReady(p.id);
  };
  return (
    <div className="ai-carousel-change">
      <div className="ai-visual-gifs">
        {p.before ? (loadGif ? <Gif src={withBase(base, p.before)} label={p.beforeLabel} onSettled={() => settle("before")} /> : <GifSlot label={p.beforeLabel} />) : null}
        {p.before && p.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
        {p.after ? (loadGif ? <Gif src={withBase(base, p.after)} label={p.afterLabel} onSettled={() => settle("after")} /> : <GifSlot label={p.afterLabel} />) : null}
      </div>
      {p.diff.length ? <DiffList diff={p.diff} /> : null}
    </div>
  );
}

/**
 * An image that was viewed; if it can't be fetched, write one sentence instead of leaving a blank.
 * Shown at its original size (shrink only, never enlarge), centered in the frame
 */
function PageImage({ src, label, onSettled }: { src: string; label?: string; onSettled: () => void }): JSX.Element {
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // An image from the cache may already be decoded before onLoad is attached, so report once more
  useEffect(() => {
    const el = ref.current;
    if (el?.complete && el.naturalWidth > 0) onSettled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (bad) return <div className="ai-carousel-note">{tr("This image could not be retrieved")}</div>;
  return (
    <img
      ref={ref}
      className="ai-carousel-img"
      src={src}
      alt={label || tr("Video")}
      draggable={false}
      onLoad={onSettled}
      onError={() => {
        setBad(true);
        onSettled();
      }}
    />
  );
}

/** An "Edit" page not yet flipped to: reserve the animated image's spot first, swap in the real one once flipped to */
function GifSlot({ label }: { label: string }): JSX.Element {
  return (
    <figure className="ai-visual-gif">
      <div className="box" />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function DiffList({ diff }: { diff: DiffRow[] }): JSX.Element {
  return (
    <ul className="ai-visual-diff">
      {diff.map((d) => (
        <li key={d.key}>
          <span className="k">{d.key}</span>
          <span className="from">{d.from}</span>
          <span className="arrow" aria-hidden>→</span>
          <span className="to">{d.to}</span>
        </li>
      ))}
    </ul>
  );
}
