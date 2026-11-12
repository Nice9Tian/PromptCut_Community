import { useEffect, useRef, useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { listCuts } from "../../kernel/cuts";
import type { CutKind } from "../../kernel/camera.mjs";
import { closeTab, openTab, openTabs, saveTabs, setTabs, useCutTabsVersion } from "./cutTabsState";
import { memberReadOnlyNow } from "../readOnlyCore";
import { useReadOnly } from "../readOnly";
import "./cut-tabs.css";
import { tr } from "../../i18n/index.ts";
import { shownName } from "../../i18n/names.ts";

const ONLINE = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/** Film strip: one frame inside a rounded square, with three perforations on each side */
export function IconFilm({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.6" />
      <path d="M5 2v12M11 2v12" />
      <path d="M2 5h3M2 8h3M2 11h3M11 5h3M11 8h3M11 11h3" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * Open and activate a cut above the timeline (a single click on a cut in the media library and a double
 * click on a cut segment on the timeline both go through here).
 * The tab stays until the user clicks its "×".
 */
export function openCutInTimeline(cutId: string): void {
  // Which cut is active (`activeCutId`) is a project field: switching is a write. In a read-only project (guest) we do not switch, to avoid a pointless rejection by the server
  if (memberReadOnlyNow()) return;
  const p = getState().project;
  const ids = (p.cuts ?? []).map((c) => c.id);
  if (!ids.includes(cutId)) return;
  if (p.id) openTab(p.id, ids, p.activeCutId, cutId);
  if (p.activeCutId !== cutId) actions.switchCut(cutId);
}

/**
 * The cut tab bar above the timeline (`workflow/editing.md` "Cut tabs", user decision, 2026-10-20).
 *
 * One tab per opened cut: a click switches the active cut, a double click renames, "×" only closes the
 * tab and does not delete the cut, and the last tab cannot be closed ("×" is not drawn, and hovering
 * explains why). The "+" at the end creates a new cut and opens it. Tabs do not disappear because of
 * lost focus, a click elsewhere, or a panel switch.
 * Deleting a cut is done in the "Cuts" group of the media library.
 *
 * Which cuts are open is local UI state (`cutTabsState.ts`) and does not go into the project document.
 * The cut group at the end of the old vertical left rail (CutsRailGroup) was removed per Argon's review
 * comments: the only entry points for cuts are the media library cut group and here.
 */
export function CutTabBar() {
  const project = useStore((s) => s.project);
  useCutTabsVersion();
  const cuts = listCuts(project);
  const ids = cuts.map((c) => c.id);
  const active = project.activeCutId;
  const projectId = project.id ?? "";
  const tabs = openTabs(projectId, ids, active);
  const [editing, setEditing] = useState<string | null>(null);
  const [prerendering, setPrerendering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ro = useReadOnly();

  // Write the result back to local storage after aligning with the project (add the active one, drop the deleted ones)
  const key = tabs.join("|");
  useEffect(() => {
    if (projectId) saveTabs(projectId, tabs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);

  const byId = new Map(cuts.map((c) => [c.id, c]));
  const activeEntry = active ? byId.get(active) : undefined;
  const activeKind: CutKind = activeEntry?.kind === "3d" ? "3d" : "2d";

  const close = (id: string) => {
    // Read-only: closing the active tab would also switch to the adjacent cut (a write), so it is not offered; closing other tabs only collapses them in the UI, so that works as usual
    if (ro.locked && id === active) return;
    const r = closeTab(tabs, id, active);
    if (!r) return;
    setTabs(projectId, r.tabs);
    if (r.switchTo) actions.switchCut(r.switchTo);
  };

  const handlePrerenderTo2D = async () => {
    if (ro.locked || ONLINE || prerendering || !active) return;
    setPrerendering(true);
    setNotice(null);
    try {
      const res = await actions.prerenderCutTo2D(active, { switchTo: false });
      openCutInTimeline(res.cut.id);
    } catch (e: any) {
      setNotice(e?.message || String(e));
    } finally {
      setPrerendering(false);
    }
  };

  return (
    <div className="pc-tl-cuts" data-pc="cut-tabs" role="tablist" aria-label={tr("Open cuts")}>
      {tabs.map((id) => {
        const c = byId.get(id);
        if (!c) return null;
        return (
          <Tab key={id} id={id} name={c.name} kind={c.kind === "3d" ? "3d" : "2d"} active={c.active} canClose={tabs.length > 1} locked={ro.locked} why={ro.why}
            editing={editing === id} onEdit={() => setEditing(id)} onDone={() => setEditing(null)}
            onClose={() => close(id)} />
        );
      })}
      <button type="button" className="pc-tl-cut-add" data-pc="cut-add" title={ro.title(tr("Create a cut and open it"))} aria-label={tr("New cut")} disabled={ro.locked}
        onClick={() => {
          const cut = actions.addCut(undefined, { switchTo: false });
          openCutInTimeline(cut.id);
        }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <button type="button" className="pc-tl-cut-add-kind" data-pc="cut-add-3d" title={ro.title(tr("Create a 3D cut and open it"))} aria-label={tr("New 3D cut")} disabled={ro.locked}
        onClick={() => {
          const cut = actions.addCut(undefined, { switchTo: false, kind: "3d" });
          openCutInTimeline(cut.id);
        }}>
        +3D
      </button>

      <div className="pc-tl-cut-actions">
        {notice && (
          <span className="pc-tl-cut-notice" title={notice} onClick={() => setNotice(null)}>
            {notice}
          </span>
        )}
        {active && activeKind === "2d" && (
          <button
            type="button"
            className="pc-tl-cut-mode-btn"
            data-pc="cut-switch-3d"
            disabled={ro.locked}
            title={ro.title(tr("Losslessly switch this 2D cut into a 3D cut (depth-sorted boards and 3D camera lane)"))}
            onClick={() => actions.setCutKind(active, "3d")}
          >
            {tr("Switch to 3D cut")}
          </button>
        )}
        {active && activeKind === "3d" && (
          <button
            type="button"
            className="pc-tl-cut-mode-btn is-3d"
            data-pc="prerender-cut-2d"
            disabled={ro.locked || ONLINE || prerendering}
            title={
              ro.locked
                ? ro.why
                : ONLINE
                  ? tr("Pre-rendering a 3D cut to a 2D cut requires the desktop rendering service")
                  : tr("Render this 3D cut into an MP4 video asset and create a new 2D cut with it, keeping the 3D cut untouched")
            }
            onClick={handlePrerenderTo2D}
          >
            {prerendering ? tr("Pre-rendering...") : tr("Pre-render to 2D cut")}
          </button>
        )}
      </div>
    </div>
  );
}

function Tab({ id, name, kind, active, canClose, locked, why, editing, onEdit, onDone, onClose }: {
  id: string; name: string; kind: CutKind; active: boolean; canClose: boolean;
  /** Read-only project: neither switching (changing the active cut) nor renaming is offered; why is the grayed-out explanation */
  locked: boolean; why: string;
  editing: boolean; onEdit: () => void; onDone: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, name]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) actions.renameCut(id, next);
    onDone();
  };
  return (
    <div className={`pc-tl-cut${active ? " is-on" : ""}`} data-pc-cut-tab={id}>
      <div
        role="tab"
        tabIndex={0}
        aria-selected={active}
        className="pc-tl-cut-main"
        title={editing ? undefined : locked ? `${shownName(name)}\n${why}` : tr("{0}\nClick to switch, double-click to rename", shownName(name))}
        aria-disabled={locked && !active ? true : undefined}
        onClick={() => { if (!locked && !editing && !active) actions.switchCut(id); }}
        onDoubleClick={() => { if (!locked) onEdit(); }}
        onKeyDown={(e) => {
          if (!locked && !editing && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (!active) actions.switchCut(id); }
        }}
      >
        <span className="pc-tl-cut-glyph"><IconFilm /></span>
        {editing ? (
          <input ref={inputRef} className="pc-tl-cut-input" value={draft} aria-label={tr("Cut name")}
            onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); else if (e.key === "Escape") onDone(); }}
            onClick={(e) => e.stopPropagation()} />
        ) : (
          <span className="pc-tl-cut-name">{shownName(name)}</span>
        )}
        <span className={`pc-tl-cut-kind is-${kind}`} data-pc-cut-kind={kind}>{kind.toUpperCase()}</span>
      </div>
      {canClose ? (
        <button type="button" className="pc-tl-cut-x" data-pc="cut-tab-close" title={locked && active ? why : tr("Close this tab (the cut is not deleted)")} aria-label={tr("Close tab for {0}", name)}
          disabled={locked && active}
          onClick={(e) => { e.stopPropagation(); onClose(); }}>
          ×
        </button>
      ) : (
        <span className="pc-tl-cut-x is-off" title={tr("The last tab cannot be closed")} aria-hidden="true" />
      )}
    </div>
  );
}
