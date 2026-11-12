import { findClip } from "../../kernel/project";
import { normalizeEmphasis, type ClipEmphasis } from "../../kernel/emphasis";
import { mergeFrameExpr, type FrameExprKey, type FrameExprMap } from "../../kernel/frameExpr.mjs";
import type { ClipFrame, ClipMotion, PartInstance } from "../../kernel/types";

import { state, setProject, updateTrack } from "../core";
import { tr } from "../../i18n/index.ts";

export const properties = {
  /**
   * Changes card type (preserving time interval). When keepParams is true, retains matching
   * parameters that the new card also has.
   */
  /**
   * Part instance tree for composite cards: replaces the entire tree. Tree additions, deletions,
   * edits, and moves are computed in kernel/parts.ts (pure function, validated); this only handles
   * storage. Empty array = clear field.
   */
  setClipParts(clipId: string, parts: PartInstance[]) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!parts.length) {
          const { parts: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, parts };
      }),
    })));
    return true;
  },
  /**
   * Adds / removes emphasis (shadow, stroke) for a clip. Passing null removes it.
   * Parameters are completed and clamped in kernel/emphasis.ts; unrecognized kind is treated as unset.
   */
  setClipEmphasis(clipId: string, emphasis: Partial<ClipEmphasis> | null): { ok: boolean; emphasis: ClipEmphasis | null; error?: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, emphasis: null, error: tr("Clip {0} not found", clipId) };
    const next = emphasis ? normalizeEmphasis(emphasis) : null;
    if (emphasis && !next) return { ok: false, emphasis: null, error: tr("Emphasis can only be shadow or outline") };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!next) {
          // Delete the key when removing instead of leaving undefined: saving to .proc would add an unused line
          const { emphasis: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, emphasis: next };
      }),
    })));
    return { ok: true, emphasis: next };
  },

  /**
   * Binds / unbinds a motion track. Passing undefined unbinds it.
   *
   * Kept separate from updateClip rather than merged into its patch: motion is a chunk
   * of frame-by-frame data, not a scalar you can glance at like fade-in or fade-out;
   * mixing them in the same patch makes "tweaking opacity on a whim" look identical
   * to "replacing the entire trajectory".
   */
  setClipMotion(clipId: string, motion: ClipMotion | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!motion) {
          const { motion: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, motion };
      }),
    })));
    return true;
  },
  /**
   * Sets / clears card bounding box (position, size, anchor, scale, rotation). Passing undefined
   * clears it, restoring full-screen fill. The incoming frame is **complete local coordinates**,
   * without merging: merging (modifying only passed fields) and world→local conversion are already
   * done by the caller (framePatchFromArgs in kernel/layout.ts); this only handles storage.
   * A standalone action like motion, not merged into updateClip's patch.
   */
  setClipFrame(clipId: string, frame: ClipFrame | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!frame) {
          const { frame: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, frame };
      }),
    })));
    return true;
  },
  /**
   * Sets / merges / clears per-property keyframe expressions (`t`, `d`, `p`) on a clip's bounding box.
   * Validates expressions synchronously via `mergeFrameExpr` (throws `FilterExprError` on syntax or domain errors).
   * Passing `null` clears all expressions on the clip; passing `{ x: null }` clears only `x`.
   */
  setClipFrameExpr(
    clipId: string,
    patch: Record<string, string | null | undefined> | null | undefined,
    clearKeys: readonly FrameExprKey[] = [],
  ): FrameExprMap | undefined {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) throw new Error(tr("Clip {0} not found", clipId));
    const next = mergeFrameExpr(hit.clip.frameExpr, patch, clearKeys);
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!next) {
          const { frameExpr: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, frameExpr: next };
      }),
    })));
    return next;
  },
};
