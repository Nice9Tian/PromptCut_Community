/**
 * The edit tools at the left of the timeline toolbar: Split (Ctrl+B), Mirror, Rotate, Crop
 * (workflow/editing.md "User interactive correction").
 *
 * What each button acts on and why one is greyed out is `editToolStates` (`editToolStates.ts`); the edits
 * are store actions (`splitClips`, `setClipsFlipX`, `rotateClips`, `cropClip`), so several selected
 * clips change in one undo step and the Agent sees the same data (`update_clip` writes crop / mirror).
 * The toolbar is part of the timeline, so the tools are wherever the timeline is mounted: the editor
 * and the detail editing of Vibe mode.
 *
 * Disabled buttons use `aria-disabled` rather than `disabled`, so the tooltip saying why still shows
 * on hover.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { actions, getState, useStore } from "../../store/project";
import { useReadOnly } from "../readOnly";
import { blockedByReadOnly } from "../readOnlyCore";
import { splitKey } from "../undoKeys";
import { editToolStates, type EditToolState } from "./editToolStates";
import { CropDialog } from "./CropDialog";
import { IconCrop, IconMirror, IconRotate, IconSplit } from "../../ui/icons";
import { tr } from "../../i18n/index.ts";
import "./edit-tools.css";

/** Degrees per click of Rotate (clockwise) */
const ROTATE_STEP = 90;

/** Split the selected clips under the playhead: the button and Ctrl+B */
function splitSelection() {
  const s = getState();
  const targets = editToolStates(s.project, s.selection, s.t).split.targets;
  if (targets.length) actions.splitClips(targets, s.t);
}

export function EditTools() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const t = useStore((s) => s.t);
  const ro = useReadOnly();
  const tools = useMemo(() => editToolStates(project, selection, t), [project, selection, t]);
  const [cropping, setCropping] = useState<string | null>(null);

  // Ctrl/Cmd+B wherever focus is, except while typing (`splitKey`). The read-only guard (`readOnlyKeys.ts`)
  // swallows it first in a read-only project; checking again here covers pages that load without it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !splitKey(e)) return;
      e.preventDefault();
      if (!blockedByReadOnly()) splitSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tool = (key: string, label: string, icon: ReactNode, state: EditToolState, run: () => void, pressed?: boolean) => {
    const off = ro.locked || state.targets.length === 0;
    return (
      <button
        type="button"
        className={`pc-tl-iconbtn pc-tl-tool${pressed ? " is-on" : ""}`}
        data-pc={`timeline-tool-${key}`}
        aria-label={label}
        aria-disabled={off || undefined}
        aria-pressed={pressed}
        title={ro.locked ? ro.why : state.title}
        onClick={() => { if (!off && !blockedByReadOnly()) run(); }}
      >
        {icon}
      </button>
    );
  };

  return (
    <div className="pc-tl-tools" role="group" aria-label={tr("Edit tools")}>
      {tool("split", tr("Split"), <IconSplit />, tools.split, splitSelection)}
      {tool("mirror", tr("Mirror"), <IconMirror />, tools.mirror, () => actions.setClipsFlipX(tools.mirror.targets, !tools.mirror.on), tools.mirror.on)}
      {tool("rotate", tr("Rotate"), <IconRotate />, tools.rotate, () => actions.rotateClips(tools.rotate.targets, ROTATE_STEP))}
      {tool("crop", tr("Crop"), <IconCrop />, tools.crop, () => setCropping(tools.crop.targets[0]))}
      {cropping && <CropDialog clipId={cropping} onClose={() => setCropping(null)} />}
    </div>
  );
}
