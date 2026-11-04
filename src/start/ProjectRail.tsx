/**
 * The row of recent project thumbnails.
 *
 * How many fit in a row is computed from the **viewport width**: measure the actual width of the strip
 * and divide by one tile's width plus the gap. It is recomputed whenever the window changes
 * (ResizeObserver), so there are never half tiles or a crowded mess. The first tile is always
 * "Create A New"; the remaining slots go to projects, and the overflow is paged with "<" and ">".
 * There is no horizontal scrollbar: mouse users cannot find it, and trackpads trigger it by accident.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { CreateTile, ProjectThumb } from "./ProjectThumb";
import type { VibeProject } from "./types";
import { tr } from "../i18n/index.ts";

/** Width and gap of one tile, aligned with the flex-basis of `.ps-tile` and the gap of `.ps-strip` in
 * `start.css` */
const TILE_W = 196;
const GAP = 12;

export function ProjectRail(props: {
  title: string;
  projects: VibeProject[];
  /** Used to flip back to the first page when the folder changes: when the value changes, start over */
  resetKey: string;
  onCreate: () => void;
  /** Grayed out when creating is unavailable (the guest has already created one); hover shows why */
  createDisabled?: string | null;
  onOpen: (id: string) => void;
  /**
   * What this row says while the list is still loading, cannot be loaded, or the user is not logged in
   * (no fake data, no blank screen).
   * If not given, nothing is written. "No projects at all" is visible to the user already, so no extra
   * sentence is needed (issue #10).
   */
  empty?: string;
}): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(5);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setSlots(Math.max(2, Math.floor((el.clientWidth + GAP) / (TILE_W + GAP))));
    measure();
    // Dragging the window and changing the sidebar width both require a recompute
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setPage(0); }, [props.resetKey]);

  const perPage = Math.max(1, slots - 1); // The first tile is given to Create A New
  const pages = Math.max(1, Math.ceil(props.projects.length / perPage));
  // After the window gets wider, each page fits more, so the old page index may be out of range;
  // clamp it back into range when rendering
  const at = Math.min(page, pages - 1);
  const shown = props.projects.slice(at * perPage, at * perPage + perPage);

  return (
    <section className="ps-rail" data-pc="start-rail">
      <div className="ps-rail-head">
        <h2 className="ps-rail-title">{props.title}</h2>
        <span className="ps-muted" data-pc="start-rail-count">{tr("{0} total", props.projects.length)}</span>
        <span className="ps-rail-spacer" />
        <span className="ps-page-at" data-pc="start-rail-page">{tr("Page {0} / {1}", at + 1, pages)}</span>
        <button
          type="button"
          className="ps-page-btn"
          data-pc="start-rail-prev"
          aria-label={tr("Previous page")}
          disabled={at <= 0}
          onClick={() => setPage(at - 1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="ps-page-btn"
          data-pc="start-rail-next"
          aria-label={tr("Next page")}
          disabled={at >= pages - 1}
          onClick={() => setPage(at + 1)}
        >
          ›
        </button>
      </div>
      <div className="ps-strip" ref={strip}>
        <CreateTile onCreate={props.onCreate} disabled={!!props.createDisabled} title={props.createDisabled ?? undefined} />
        {shown.map((p) => (
          <ProjectThumb key={p.id} project={p} onOpen={props.onOpen} />
        ))}
      </div>
      {/*
        When empty, only state **what the user doesn't already know** (list is still fetching, failed to
        fetch, not logged in); having none does not need an extra "There are no projects here yet. Click
        'Create A New' in the first tile to create one": the first tile is right in front of them, making
        that sentence redundant (issue #10: pointed out on the guest first screen).
      */}
      {props.projects.length === 0 && props.empty && (
        <p className="ps-empty" data-pc="start-rail-empty">{props.empty}</p>
      )}
    </section>
  );
}
