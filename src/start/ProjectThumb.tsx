/**
 * One cell in the row of thumbnails: a project, or the first cell, "Create A New".
 *
 * The thumbnail frame is fixed at 16:9, and the project's own aspect ratio is fitted into the frame,
 * centered: this keeps the row at an even height while still showing at a glance which one is
 * vertical and which one is square.
 *
 * Picture: the first frame recorded when this browser opened the project (`thumbCache.ts`); if it was
 * never opened or the frame cannot be fetched, a color block hashed from the id (`hue.ts`), so there
 * is no blank and no broken image. The aspect ratio and duration are likewise known only after the
 * project was opened, and are not shown when unknown.
 */
import type { JSX } from "react";
import { hueOf } from "./hue";
import { humanDuration, humanWhen } from "./format";
import type { Ratio, VibeProject } from "./types";
import { tr } from "../i18n/index.ts";

const RATIO: Record<Ratio, string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };
const ROLE: Record<VibeProject["role"], string> = { owned: tr("Created by me"), joined: tr("Joined by me"), guest: tr("Guest project") };

export function ProjectThumb({ project, onOpen }: { project: VibeProject; onOpen: (id: string) => void }): JSX.Element {
  const hue = hueOf(project.id);
  const ratio = project.ratio ?? "16:9";
  const dur = humanDuration(project.duration);
  const when = humanWhen(project.seenAt);
  const meta = when ? tr("{0} · Last opened {1}", ROLE[project.role], when) : ROLE[project.role];
  return (
    <button
      type="button"
      className="ps-tile"
      data-pc="start-project-tile"
      data-project={project.id}
      data-thumb={project.thumb ? "real" : "color"}
      title={tr("{0} ({1})", project.name, meta)}
      onClick={() => onOpen(project.id)}
    >
      <span className="ps-frame">
        <span
          className="ps-shot"
          style={{
            aspectRatio: RATIO[ratio],
            background: `linear-gradient(145deg, hsl(${hue} 52% 44%), hsl(${(hue + 38) % 360} 48% 26%))`,
          }}
        >
          {project.thumb ? <img className="ps-shot-img" src={project.thumb} alt="" draggable={false} /> : project.ratio ?? ""}
        </span>
        {dur && <span className="ps-badge">{dur}</span>}
      </span>
      <span className="ps-tile-name">{project.name}</span>
      <span className="ps-tile-meta">{meta}</span>
    </button>
  );
}

/**
 * This is always the first cell (it stays on every page you flip to), and clicking it takes the same
 * path as "New project" in the sidebar.
 *
 * The "Create A New" line in the cell already says what this cell is for, so a second line "Blank
 * canvas" is not repeated below it (issue #10: on the guest first screen that sentence was redundant).
 * The project name line is kept so that the names in the row line up.
 */
export function CreateTile({ onCreate, disabled, title }: { onCreate: () => void; disabled?: boolean; title?: string }): JSX.Element {
  return (
    <button type="button" className="ps-tile ps-tile-new" data-pc="start-create-tile" aria-label={tr("New project")} disabled={disabled} title={title} onClick={onCreate}>
      <span className="ps-frame">
        <span className="ps-tile-new-plus" aria-hidden="true">+</span>
        <span className="ps-tile-new-text">Create A New</span>
      </span>
      <span className="ps-tile-name">{tr("New project")}</span>
    </button>
  );
}
