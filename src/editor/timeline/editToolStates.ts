/**
 * What the timeline's edit tools (Split, Mirror, Rotate, Crop; `EditTools.tsx`) would act on right
 * now, and what each button's tooltip says: a pure function of the project, the selection and the
 * playhead, unit-tested (`editToolStates.test.mjs`).
 *
 * The rules themselves are the store's (`splitBlock` / `rotateBlock` in kernel/clipEditRules.ts,
 * `pictureEditBlock` in kernel/mediaPicture.mjs), so a button is enabled exactly when its action would
 * change something. Every tool works on the selection: Split, Mirror and Rotate on every selected clip
 * they apply to (several at once are one undo step), Crop on a single selected clip, because the crop is
 * drawn on that clip's own picture. The read-only state of the project is the toolbar's business
 * (`readOnly.ts`), not this file's.
 */
import { findClip, type Project, type Track, type TrackClip } from "../../kernel/project";
import { rotateBlock, splitBlock, type RotateBlock, type SplitBlock } from "../../kernel/clipEditRules";
import { pictureEditBlock, type PictureEditBlock } from "../../kernel/mediaPicture.mjs";
import { tr } from "../../i18n/index.ts";

export interface EditToolState {
  /** Clip ids the tool acts on; empty = the button is disabled */
  targets: string[];
  /** Tooltip: what the button does, or why it is disabled */
  title: string;
}

export interface EditToolStates {
  split: EditToolState;
  /** `on`: every target is mirrored already, so a click turns the mirror off (shown pressed) */
  mirror: EditToolState & { on: boolean };
  rotate: EditToolState;
  crop: EditToolState;
}

/** Shown next to the Split button and in its tooltip; the key itself is `splitKey` in `undoKeys.ts` */
export const SPLIT_SHORTCUT = "Ctrl+B";

interface Selected { clip: TrackClip; track: Track }

const SPLIT_WHY: Record<Exclude<SplitBlock, "missing">, () => string> = {
  outside: () => tr("Move the playhead inside the selected clip to split it"),
  transition: () => tr("A transition locks this clip's timing: delete the transition to split it"),
  locked: () => tr("This track is locked"),
};

const PICTURE_WHY: Record<PictureEditBlock | "locked", () => string> = {
  "not-media": () => tr("Only video and image clips can be cropped or mirrored"),
  "effect-card": () => tr("A media effect card draws this clip's picture, so it can't be cropped or mirrored"),
  locked: () => tr("This track is locked"),
};

const ROTATE_WHY: Record<RotateBlock, () => string> = {
  "no-picture": () => tr("Audio clips have no picture to rotate"),
  expression: () => tr("Frame expressions drive this clip's box: change its rotation there (Edit panel)"),
  locked: () => tr("This track is locked"),
};

/** Why crop / mirror do not apply to a selected clip, or null when they do */
function pictureWhy(project: Project, s: Selected): PictureEditBlock | "locked" | null {
  return pictureEditBlock(project, s.clip) ?? (s.track.locked ? "locked" : null);
}

export function editToolStates(project: Project, selection: readonly string[], t: number): EditToolStates {
  const selected: Selected[] = [];
  for (const id of new Set(selection)) {
    const hit = findClip(project, id);
    if (hit) selected.push(hit);
  }
  const none = selected.length === 0;

  // Split: every selected clip the playhead is inside
  const splittable = selected.filter((s) => !splitBlock(project, s.clip.id, t));
  const firstSplitWhy = selected.map((s) => splitBlock(project, s.clip.id, t)).find((b): b is Exclude<SplitBlock, "missing"> => !!b && b !== "missing");
  const split: EditToolState = {
    targets: splittable.map((s) => s.clip.id),
    title: splittable.length > 1
      ? tr("Split {0} clips at the playhead ({1})", splittable.length, SPLIT_SHORTCUT)
      : splittable.length === 1
        ? tr("Split at the playhead ({0})", SPLIT_SHORTCUT)
        : none ? tr("Split ({0}): select a clip under the playhead first", SPLIT_SHORTCUT) : SPLIT_WHY[firstSplitWhy ?? "outside"](),
  };

  // Mirror: every selected video / image clip; pressed when all of them are mirrored already
  const pictured = selected.filter((s) => !pictureWhy(project, s));
  const on = pictured.length > 0 && pictured.every((s) => !!s.clip.flipX);
  const firstPictureWhy = selected.map((s) => pictureWhy(project, s)).find(Boolean) ?? "not-media";
  const mirror = {
    targets: pictured.map((s) => s.clip.id),
    on,
    title: pictured.length
      ? on ? tr("Mirror is on: click to turn it off") : tr("Mirror the picture left to right")
      : none ? tr("Mirror: select a video or image clip first") : PICTURE_WHY[firstPictureWhy](),
  };

  // Rotate: every selected clip with a picture, 90° clockwise about its own center
  const turnable = selected.filter((s) => !rotateBlock(project, s.clip, s.track));
  const firstRotateWhy = selected.map((s) => rotateBlock(project, s.clip, s.track)).find((b): b is RotateBlock => !!b);
  const rotate: EditToolState = {
    targets: turnable.map((s) => s.clip.id),
    title: turnable.length
      ? tr("Rotate 90° clockwise")
      : none ? tr("Rotate: select a clip first") : ROTATE_WHY[firstRotateWhy ?? "no-picture"](),
  };

  // Crop: one selected video / image clip
  const only = selected.length === 1 ? selected[0] : null;
  const onlyWhy = only ? pictureWhy(project, only) : null;
  const crop: EditToolState = {
    targets: only && !onlyWhy ? [only.clip.id] : [],
    title: only
      ? onlyWhy ? PICTURE_WHY[onlyWhy]() : tr("Crop the picture")
      : none ? tr("Crop: select a video or image clip first") : tr("Select a single clip to crop"),
  };

  return { split, mirror, rotate, crop };
}
