import { findClip, type Project, type TrackClip } from "../../kernel/project";
import type { ClipFrame } from "../../kernel/types";
import { recenterFrame } from "../../kernel/layout";
import { hasFrameExpr } from "../../kernel/frameExpr.mjs";
import { boxForCrop, mediaAspect, normalizeCrop, pictureEditBlock, type ClipCrop, type PictureEditBlock } from "../../kernel/mediaPicture.mjs";

import { state, setProject, updateTrack } from "../core";
import { tr } from "../../i18n/index.ts";

/** Why crop / mirror was refused, in words for the person or Agent who asked */
function blockText(block: PictureEditBlock): string {
  return block === "effect-card"
    ? tr("A media effect card draws this clip's picture, so it can't be cropped or mirrored")
    : tr("Only video and image clips can be cropped or mirrored");
}

const sameCrop = (a: ClipCrop | null | undefined, b: ClipCrop | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** One clip replaced on its track (the project object is new; see "do not edit store objects in place") */
function replaceClip(p: Project, trackId: string, clipId: string, fn: (c: TrackClip) => TrackClip): Project {
  return updateTrack(p, trackId, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }));
}

/**
 * Crop and mirror of a video / image clip's picture (the timeline toolbar's Crop and Mirror;
 * `update_clip`'s `crop` / `flipX` for the Agent). Data and rendering: kernel/mediaPicture.mjs.
 */
export const picture = {
  /**
   * Mirror (`on`) or un-mirror the picture of these clips, as one undo step. Clips it does not apply to
   * (`pictureEditBlock`), clips on locked tracks and clips already in that state are left alone.
   * Returns the ids that changed.
   */
  setClipsFlipX(clipIds: string[], on: boolean): string[] {
    let next = state.project;
    const changed: string[] = [];
    for (const id of new Set(clipIds)) {
      const hit = findClip(next, id);
      if (!hit || hit.track.locked || pictureEditBlock(next, hit.clip) || !!hit.clip.flipX === on) continue;
      next = replaceClip(next, hit.track.id, id, (c) => {
        // Not mirrored = no key (not `false`): saved projects stay byte-identical to before the feature
        const { flipX: _drop, ...rest } = c;
        return on ? { ...rest, flipX: true } : rest;
      });
      changed.push(id);
    }
    if (changed.length) setProject(next);
    return changed;
  },

  /**
   * Crop a clip's picture to `crop` (fractions of the source picture; null = the whole picture),
   * as one undo step.
   *
   * The box changes with it so that the cropped part shows whole at its own aspect ratio, centered
   * where the clip was (`boxForCrop`): cropping a full-screen 16:9 video to 1:1 gives a centered
   * square, and choosing the whole picture again gives the full screen back. This needs the picture's
   * aspect ratio: `sourceAspect` (the crop dialog reads it off the media element), else the size the
   * asset recorded. Without either, or when the box is driven by frame expressions (they would override
   * the new size), only the crop is stored and the cropped part covers the box as it is.
   *
   * Asking for the crop the clip already has changes nothing (in particular the box does not move).
   */
  cropClip(clipId: string, crop: unknown, opts: { sourceAspect?: number | null } = {}):
    { ok: true; crop: ClipCrop | null; frame?: ClipFrame } | { ok: false; error: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: tr("Clip {0} not found", clipId) };
    const block = pictureEditBlock(p, hit.clip);
    if (block) return { ok: false, error: blockText(block) };
    if (hit.track.locked) return { ok: false, error: tr("This track is locked") };
    const norm = normalizeCrop(crop);
    if (!norm.ok) return { ok: false, error: norm.error };
    if (sameCrop(norm.crop, hit.clip.crop)) return { ok: true, crop: norm.crop };

    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    const aspect = opts.sourceAspect && opts.sourceAspect > 0 ? opts.sourceAspect : mediaAspect(media);
    let frame: ClipFrame | undefined;
    if (aspect && !hasFrameExpr(hit.clip.frameExpr)) {
      const stage = { width: p.width, height: p.height };
      const base = recenterFrame(hit.clip.frame, stage);
      const box = boxForCrop({ box: { w: base.w!, h: base.h! }, prevCrop: hit.clip.crop ?? null, nextCrop: norm.crop, sourceAspect: aspect, stage });
      frame = { ...base, w: box.w, h: box.h };
    }
    setProject(replaceClip(p, hit.track.id, clipId, (c) => {
      const { crop: _drop, ...rest } = c;
      return { ...rest, ...(norm.crop ? { crop: norm.crop } : null), ...(frame ? { frame } : null) };
    }));
    return { ok: true, crop: norm.crop, ...(frame ? { frame } : null) };
  },
};
