import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./cards";
import { TopBar } from "./editor/TopBar";
import { Preview } from "./editor/Preview";
import { ProbeGate } from "./editor/ProbeGate";
import { LeftPanel } from "./editor/left";
import { RightPanel } from "./editor/right";
import { TimelineView } from "./editor/timeline";
import { ResizeHandle } from "./editor/ResizeHandle";
import { actions, getState } from "./store/project";
import { magicuiDemoClips, nativeDemoClips } from "./cards/demoClips";
import { cardsVersion, onCardsUpdated } from "./kernel/registry";
import { useSkin } from "./skins/useSkin";
import { useRailCollapsed, isRailCollapsed, subscribeRails, RAIL_W } from "./editor/sideRails";
import { RailBar } from "./editor/dock/RailBar";
import "./editor/shell.css";
import { StatusBar } from "./editor/StatusBar";
import { DependencyPrompt } from "./editor/DependencyPrompt";
import { motion } from "motion/react";
import { MediaMigrationDialog } from "./editor/MediaMigrationDialog";
import { MissingMaterialsDialog } from "./editor/MissingMaterialsDialog";
import { CloudGoneDialog } from "./editor/sync/CloudGoneDialog";
import { SyncOverlays } from "./editor/sync/SyncOverlays";
import { isJoinPage, resumeShared, startSync } from "./editor/sync/syncManager";
import { undoRedoKey } from "./editor/undoKeys";
import { tr } from "./i18n/index.ts";

/** Drag handle width (px), matches w-2 in ResizeHandle */
const HANDLE_W = 8;
const DEFAULT_DRAWER_W = 240;
const DEFAULT_PANEL_W = 360;
const DEFAULT_FOOTER_H = 272;
const MIN_DRAWER_W = 200;
const MIN_PANEL_W = 280;
const MIN_PREVIEW_W = 320;
const MIN_FOOTER_H = 120;
/** Duration of the column-width transition when collapsing / expanding the side panels, matches .pc-editor-grid[data-pc-rail-anim] in shell.css */
const RAIL_ANIM_MS = 220;

/**
 * Panel sizes: update state while dragging, write localStorage only on release (one drag must not
 * write hundreds of entries).
 */
function usePanelSize(key: string, initial: number, min: number) {
  const [value, setValue] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (Number.isFinite(v) && v >= min) return v;
    } catch {}
    return initial;
  });
  const latest = useRef(value);
  latest.current = value;
  const api = useMemo(
    () => ({
      set: setValue,
      commit() {
        try {
          localStorage.setItem(key, String(Math.round(latest.current)));
        } catch {}
      },
      reset() {
        setValue(initial);
        try {
          localStorage.setItem(key, String(initial));
        } catch {}
      },
    }),
    [key, initial],
  );
  return { value, ...api };
}

/**
 * Editor layout: left rail / preview / right rail / bottom timeline (the chat-style layout has been
 * removed, TODO "working mode").
 * The left and right rails and the timeline can all be resized by dragging (double-click to reset).
 * On first open, 10 demo cards are laid onto the first motion graphics track, for easy testing.
 * Theme variables are attached only to the preview stage (Preview.tsx); the editor's own UI does
 * not read --pc-*.
 */
export default function Editor() {
  useSkin(); // mount data-skin
  /*
   * The card code changed (hot updates for new / modified cards are caught in `cards/index.ts` and no
   * longer bubble up to this component, C6.6 integration 3b):
   * subscribe to the registry's version number and re-render once, so the card library list and other
   * UI that reads the registry update too. Re-render only, never re-run any effect.
   */
  useSyncExternalStore(onCardsUpdated, cardsVersion, cardsVersion);
  const leftCollapsed = useRailCollapsed("left");
  const rightCollapsed = useRailCollapsed("right");
  const gridRef = useRef<HTMLDivElement>(null);
  /** Total width that can be divided in this row (falls back to the window width if unavailable) */
  const room = () => gridRef.current?.clientWidth ?? window.innerWidth;

  const drawerW = usePanelSize("pc.left.drawerW", DEFAULT_DRAWER_W, MIN_DRAWER_W);
  const panelW = usePanelSize("pc.right.panelW", DEFAULT_PANEL_W, MIN_PANEL_W);
  const footer = usePanelSize("pc.timeline.h", DEFAULT_FOOTER_H, MIN_FOOTER_H);

  // Widths are recorded per side, not per item: the left side uses drawerW, the right side uses panelW, whether that side currently holds a section or an Agent
  const leftCol = RAIL_W + (leftCollapsed ? 0 : drawerW.value);
  const rightCol = RAIL_W + (rightCollapsed ? 0 : panelW.value);

  // Shrink the panels when the available width gets smaller (window narrowed, or the last saved width
  // no longer fits), to keep MIN_PREVIEW_W for the preview.
  // Only the left drawer width drawerW and the right panel width panelW are shrunk: the rail width is
  // fixed, and panels are never collapsed automatically on the user's behalf;
  // a side that is already collapsed takes no width, does not count toward the total, and does not
  // take part in shrinking; the visible ones shrink proportionally.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const clamp = () => {
      const leftOpen = !leftCollapsed;
      const rightOpen = !rightCollapsed;
      const room = el.clientWidth - MIN_PREVIEW_W - 2 * (HANDLE_W + RAIL_W);
      const total = (leftOpen ? drawerW.value : 0) + (rightOpen ? panelW.value : 0);
      if (room <= 0 || total <= room) return;
      const scale = room / total;
      if (leftOpen) drawerW.set(Math.max(MIN_DRAWER_W, Math.floor(drawerW.value * scale)));
      if (rightOpen) panelW.set(Math.max(MIN_PANEL_W, Math.floor(panelW.value * scale)));
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    // Keep both paths: window resizing goes through the resize event, the layout itself getting wider or narrower goes through ResizeObserver
    window.addEventListener("resize", clamp);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [drawerW.value, panelW.value, drawerW.set, panelW.set, leftCollapsed, rightCollapsed]);

  // When collapsing / expanding the side panels, attach data-pc-rail-anim to the grid for a short
  // while: column widths and drawer / panel cards go through a transition (shell.css, left.css,
  // chat.css).
  // It must be attached synchronously at the moment sideRails notifies, not wait for Editor's own
  // effect: other layout effects in the same commit would read the layout first (for example, pinning
  // the message area to the bottom reads scrollHeight), the new column widths would already have been
  // computed, and the transition could not start.
  // Write the DOM attribute directly, rather than re-rendering the whole editor twice for an
  // animation switch.
  useEffect(() => {
    let last = `${isRailCollapsed("left")}|${isRailCollapsed("right")}`;
    let timer = 0;
    const off = subscribeRails(() => {
      const now = `${isRailCollapsed("left")}|${isRailCollapsed("right")}`;
      const el = gridRef.current;
      if (now === last || !el) return;
      last = now;
      el.dataset.pcRailAnim = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        delete el.dataset.pcRailAnim;
      }, RAIL_ANIM_MS + 100);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    // C6.5: the page connects to the local document service over WebSocket and attaches the store
    // (src/editor/sync/syncManager.ts); not connected for headless instances, read-only viewing, or when it cannot connect
    // If this tab had a shared project open before the refresh (a page that goes straight into the editor with `?editor`): after connecting to the local machine, go back to that shared project
    void startSync().then(() => resumeShared());
    const p = getState().project;
    // Automation pages (?headless=1, pages opened by probes and tests) get no demo cards: what is
    // tested is the content they put in themselves.
    // Pages that join an existing local project with ?join= get none either: the content is whatever
    // the document service says, and adding them would mean adding 10 cards to someone else's project
    const headless = new URLSearchParams(location.search).has("headless");
    if (!headless && !isJoinPage() && p.tracks.every((t) => t.clips.length === 0)) {
      for (const c of [...magicuiDemoClips, ...nativeDemoClips]) {
        actions.addCardClip(c.cardId, c.start, { duration: c.end - c.start, params: c.params });
      }
      actions.select([]);
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        actions.togglePlay();
      } else if (undoRedoKey(e)) {
        // Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo (src/editor/undoKeys.ts)
        e.preventDefault();
        undoRedoKey(e) === "redo" ? actions.redo() : actions.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        for (const id of getState().selection) actions.removeClip(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // All pages (sections, scripts, each AiPanel) render inside RightPanel (dock/DockPages); the left
  // rail is only a rail + host.
  // RightPanel always stays in the same slot: if it moved, React would unmount and rebuild it together
  // with the AiPanel, and a running chat would be cut off on the spot.
  return (
    <div data-pc="editor" className="h-full min-h-0 flex flex-col" style={{ backgroundColor: "var(--ui-bg)", color: "var(--ui-fg)" }}>
      <MediaMigrationDialog />
      <MissingMaterialsDialog />
      <CloudGoneDialog />
      <SyncOverlays />
      <TopBar />
      <DependencyPrompt />
      <div className="flex-1 min-h-0 flex flex-col" style={{ padding: "var(--ui-gap)" }}>
        <div
          ref={gridRef}
          className="flex-1 min-h-0 grid pc-editor-grid"
          style={
            {
              gridTemplateColumns: [`${leftCol}px`, `${HANDLE_W}px`, "minmax(0, 1fr)", `${HANDLE_W}px`, `${rightCol}px`].join(" "),
              // The drawer / AI panel cards are fixed to these two widths (left.css / chat.css): during the
              // collapse / expand transition the column width changes while the card width does not,
              // so the column clips part of the card instead of squeezing it narrower frame by frame: neither the
              // waterfall layout nor the message area has to reflow every frame
              "--pc-left-drawer-w": `${drawerW.value}px`,
              "--pc-right-panel-w": `${panelW.value}px`,
            } as React.CSSProperties
          }
        >
          <motion.aside
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 overflow-hidden bg-transparent"
          >
            <LeftPanel />
          </motion.aside>
          <ResizeHandle
            axis="x"
            value={drawerW.value}
            min={MIN_DRAWER_W}
            max={() => room() - RAIL_W - (rightCol + HANDLE_W) - MIN_PREVIEW_W - HANDLE_W}
            onChange={drawerW.set}
            onCommit={drawerW.commit}
            onReset={drawerW.reset}
            title={tr("Drag to resize the left rail, double-click to reset")}
            disabled={leftCollapsed}
          />
          <motion.main
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 min-w-0 pc-card-surface flex flex-col"
          >
            <Preview />
            {/*
              K1 loading overlay (ProbeGate). Rendered at the same layer as <Preview />, itself position: fixed
              covering the entire editor UI: **without spinning up another iframe**, the two stage iframes are
              mounted by Preview as usual (E1), with the probe running on the background one. Under legacy, or
              when cost records are all hits, it returns null and does not appear for a single frame.
            */}
            <ProbeGate />
          </motion.main>
          {/*
            Right rail handle: yieldable space = total width − right rail − preview minimum width − this
            handle − entire left column (leftCol, including left rail) − the left handle.
            This handle only modifies panelW; right rail width RAIL_W does not change with it.
          */}
          <ResizeHandle
            axis="x"
            value={panelW.value}
            min={MIN_PANEL_W}
            max={() => room() - RAIL_W - (leftCol + HANDLE_W) - MIN_PREVIEW_W - HANDLE_W}
            invert
            onChange={panelW.set}
            onCommit={panelW.commit}
            onReset={panelW.reset}
            title={tr("Drag to resize the right rail, double-click to reset")}
            disabled={rightCollapsed}
          />
          <motion.aside
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 overflow-hidden bg-transparent"
          >
            <RightPanel />
          </motion.aside>
        </div>
        {
          /*
           * The timeline card keeps clear of the rails on both sides: its left edge aligns with the media
           * library drawer card, its right edge aligns with the AI panel card, and the rail column runs all
           * the way to the bottom.
           * When one side is collapsed, the drawer / panel is gone, and the edge of the card above is the
           * other side of the 8px gap behind the rail; yield one more HANDLE_W to line up with the preview card.
           * The drag handle and the card are wrapped together, so the hover line of the vertical drag handle
           * is indented too.
           */
          <div
            className="pc-editor-bottom shrink-0 flex flex-col relative"
            style={{ marginLeft: RAIL_W + (leftCollapsed ? HANDLE_W : 0), marginRight: RAIL_W + (rightCollapsed ? HANDLE_W : 0) }}
          >
            {/*
              The section of the rails on both sides next to the timeline (cut group and items arranged behind
              it): attached to the rail column outside the timeline card, top edge = card top edge (yielding to
              the handle above with height HANDLE_W). Horizontal position uses right/left: 100% and yields the
              extra HANDLE_W from when collapsed, perfectly aligning back into the rail column above.
            */}
            <div className="pc-rail-tail-slot is-left" style={{ top: HANDLE_W, right: `calc(100% + ${leftCollapsed ? HANDLE_W : 0}px)`, width: RAIL_W }}>
              <RailBar side="left" part="tail" />
            </div>
            <div className="pc-rail-tail-slot is-right" style={{ top: HANDLE_W, left: `calc(100% + ${rightCollapsed ? HANDLE_W : 0}px)`, width: RAIL_W }}>
              <RailBar side="right" part="tail" />
            </div>
            <ResizeHandle
              axis="y"
              value={footer.value}
              min={MIN_FOOTER_H}
              max={() => window.innerHeight * 0.7}
              invert
              onChange={footer.set}
              onCommit={footer.commit}
              onReset={footer.reset}
              title={tr("Drag to resize the timeline height, double-click to reset")}
            />
            <motion.footer
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
              className="pc-card-surface shrink-0 flex flex-col" style={{ height: footer.value }}
            >
              <TimelineView />
            </motion.footer>
          </div>
        }
      </div>
      <StatusBar />
    </div>
  );
}
