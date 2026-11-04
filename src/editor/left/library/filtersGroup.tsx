import { useState } from "react";
import { actions, getState, useStore } from "../../../store/project";
import { findClip } from "../../../kernel/project";
import { cssFilter, describeFilter, isAnimated, resolveOps, type FilterDef } from "../../../kernel/filters.mjs";
import { createFilterTools, usesOf } from "../../right/filterTools";
import { ThumbTile } from "./ThumbTile";
import { useReadOnly } from "../../readOnly";
import type { GroupData, GroupItem } from "./groups";
import { tr } from "../../../i18n/index.ts";

/** The same validation as the Agent's apply_filter / remove_filter (locked track, card clip, confirm when deleting while still attached) */
const tools = createFilterTools({ getState, actions });

/** Height-to-width ratio of the filter swatch card: a sample patch on top, the name, description and two buttons below */
const TILE_ASPECT = 0.75;

/** A colored sample patch with the filter applied (how the clip looks at 1 second), so warm vs cool, black-and-white, and blurriness are visible at a glance */
function Swatch({ def, className }: { def: FilterDef; className?: string }) {
  const css = cssFilter(resolveOps(def, undefined, 1, 2), 0.25);
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        background: "linear-gradient(135deg, #e8553a 0%, #f2c14e 35%, #3fa9f5 70%, #2d6a4f 100%)",
        filter: css || undefined,
      }}
    />
  );
}

/**
 * Effects → filter group: the project's filter library.
 * Most filters are created by the Agent with create_filter; here people can see them, attach them
 * to the selected video / image clip for reuse, and delete them.
 */
export function useFiltersGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // This project grants only read-only access (guest): attaching / detaching filters and deleting filters are all writes
  const ro = useReadOnly();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [armed, setArmed] = useState<string | null>(null);
  const filters = project.filters ?? [];
  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  const hits = q
    ? filters.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q) ||
          describeFilter(f).toLowerCase().includes(q),
      )
    : filters;

  const items: GroupItem[] = hits.map((f) => {
    const uses = usesOf(project, f.id);
    const on = !!selClip && selClip.filter?.id === f.id;
    return {
      id: f.id,
      aspect: TILE_ASPECT,
      node: (
        <div data-pc-filter={f.id} className={`pc-lib-fxcard${on ? " is-on" : ""}`}>
          <Swatch def={f} className="pc-lib-fxcard-swatch" />
          <div className="pc-lib-fxcard-body">
            <div className="pc-lib-fxcard-name" title={f.description ?? f.name}>
              <span className="pc-lib-ellipsis">{f.name}</span>
              {isAnimated(f) && <span className="pc-lib-tag">{tr("Changes over time")}</span>}
            </div>
            <div className="pc-lib-fxcard-sub" title={describeFilter(f)}>
              {describeFilter(f)}
              {uses.length ? tr(" · used in {0} segments", uses.length) : ""}
            </div>
            <div className="pc-lib-fxcard-actions">
              <button
                type="button"
                className="pc-left-btn"
                disabled={!selClip || ro.locked}
                title={ro.locked ? ro.why : selClip ? (on ? tr("Detach from the selected clip") : tr("Attach to the selected clip (one per segment, replaces the existing one)")) : tr("First select a video or image clip on the timeline")}
                onClick={() =>
                  selClip &&
                  (on
                    ? run(() => tools.applyFilter({ clipId: selClip.id, filterId: "" }), tr("Detached \"{0}\" from the selected clip", f.name))
                    : run(() => tools.applyFilter({ clipId: selClip.id, filterId: f.id }), tr("Attached \"{0}\" to the selected clip", f.name)))
                }
              >
                {on ? tr("Detach") : tr("Attach to selection")}
              </button>
              <button
                type="button"
                className={`pc-left-btn${armed === f.id ? " is-danger" : ""}`}
                disabled={ro.locked}
                title={ro.title(uses.length ? tr("Used in {0} segments, deleting it detaches it from all of them", uses.length) : tr("Delete from the filter library"))}
                onClick={() => {
                  if (uses.length && armed !== f.id) {
                    setArmed(f.id);
                    flash(tr("\"{0}\" is used in {1} segments; click \"Confirm delete\" again to detach it from those segments as well", f.name, uses.length));
                    return;
                  }
                  setArmed(null);
                  run(() => tools.removeFilter({ filterId: f.id, force: uses.length > 0, reason: "User deleted it in the media library" }), tr("Deleted \"{0}\"", f.name));
                }}
              >
                {armed === f.id ? tr("Confirm delete") : tr("Delete")}
              </button>
            </div>
          </div>
        </div>
      ),
    };
  });

  const thumbs: GroupItem[] = hits.slice(0, 2).map((f) => ({
    id: f.id,
    node: <ThumbTile title={f.name} preview={<Swatch def={f} className="pc-lib-fill" />} />,
  }));

  return {
    items,
    thumbs,
    emptyHint: tr("Ask the AI assistant to create a filter"),
    emptyDetail:
      filters.length === 0 ? (
        <div className="pc-left-note">
          {tr("No filters yet.")}
          <br />
          {tr("Ask the Agent to create one (e.g. \"give the night shots a cool tone\"). It will appear here and can then be attached to any video / image clip for reuse.")}
        </div>
      ) : (
        <div className="pc-left-note">{tr("No matching filters found.")}</div>
      ),
  };
}
