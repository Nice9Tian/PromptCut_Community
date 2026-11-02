import { findClip, type Track } from "../../kernel/project";
import {
  CAPTION_CARD_ID,
  CAPTION_TRACK_NAME,
  captionsFromTranscript,
  captionsOf,
  editCaption as editCaptionLine,
  formatCaptions,
  insertCaption,
  isCaptionClip,
  removeCaption as removeCaptionLine,
} from "../../kernel/captions";

import { state } from "../core";
import { clips as clipActions } from "./clips";
import { tracks as trackActions } from "./tracks";

export const captions = {
  /**
   * Dedicated captions track: use if present, create one if not.
   *
   * Placed at the **very top** (tracks[0]): tracks higher up on the timeline render on upper
   * layers, and captions should naturally sit above video: previously appended to the end using
   * addTrack, which after normalizing the stacking order meant stuffing captions under all video.
   */
  ensureCaptionTrack(): Track {
    const found = state.project.tracks.find((t) => t.name === CAPTION_TRACK_NAME);
    if (found) return found;
    return trackActions.addTrack(CAPTION_TRACK_NAME, { index: 0 });
  },
  /**
   * One-click populate asset transcript into a captions track: captions track → one caption-track
   * card → populate into lines.
   *
   * Previously only AI using auto_workflow / fill_captions could lay captions; manual transcription
   * in the UI had no next step. Time range is calculated based on where this asset actually spans on
   * the timeline (respects mediaOffset, matching even if the asset was moved or head-trimmed). If a
   * captions card already covers the same time range, populate into that card instead of creating
   * another one.
   */
  buildCaptions(mediaId: string): { ok: true; clipId: string; count: number } | { ok: false; reason: string } {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return { ok: false, reason: "Media not found" };
    const segments = media.transcript?.segments ?? [];
    if (segments.length === 0) return { ok: false, reason: "This media has no transcript yet" };

    const clips = p.tracks.flatMap((t) => t.clips);
    const plan = captionsFromTranscript(clips, mediaId, segments);
    if (plan.lines.length === 0) return { ok: false, reason: "This media is not on the timeline yet; drag it onto the timeline first, then lay out the captions" };

    const track = captions.ensureCaptionTrack();
    // Reuse an existing captions card for the same time period (re-laying after re-transcribing is
    // common, and should not continuously accumulate cards)
    const exist = track.clips.find((c) => isCaptionClip(c) && Math.max(c.start, plan.from) < Math.min(c.end, plan.to));
    if (exist) {
      const re = captionsFromTranscript(clips, mediaId, segments, { from: exist.start, to: exist.end });
      if (re.lines.length === 0) return { ok: false, reason: "The transcript does not fall within the time range of that captions card" };
      clipActions.setClipParams(exist.id, { lines: formatCaptions(re.lines) });
      return { ok: true, clipId: exist.id, count: re.lines.length };
    }
    const clip = clipActions.addCardClip(CAPTION_CARD_ID, plan.from, {
      duration: plan.to - plan.from,
      trackId: track.id,
      params: { lines: formatCaptions(plan.lines), showEn: "false" },
    });
    if (!clip) return { ok: false, reason: "Failed to create the captions card" };
    return { ok: true, clipId: clip.id, count: plan.lines.length };
  },
  /**
   * Modify a caption in a caption card (reposition, trim edges, edit text).
   *
   * Captions are stored in the card's lines parameter (`start|end|zh|en`, one per line), so all three
   * actions are "parse → compute in kernel/captions → write back to the same string". Time is clamped
   * between left and right neighbors, so dragging will not create a caption that overlaps another.
   * Returns its position after the change, -1 = not modified.
   */
  editCaption(clipId: string, index: number, patch: { start?: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const lines = captionsOf(hit.clip);
    const res = editCaptionLine(lines, index, patch, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    clipActions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
  /** Delete a caption */
  removeCaption(clipId: string, index: number): boolean {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return false;
    const lines = captionsOf(hit.clip);
    if (index < 0 || index >= lines.length) return false;
    clipActions.setClipParams(clipId, { lines: formatCaptions(removeCaptionLine(lines, index)) });
    return true;
  },
  /** Insert a caption into a captions card (start is in seconds relative to card start); returns -1 if it cannot fit */
  addCaption(clipId: string, at: { start: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const res = insertCaption(captionsOf(hit.clip), at, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    clipActions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
};
