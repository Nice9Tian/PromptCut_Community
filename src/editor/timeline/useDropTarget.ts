import { actions, getState } from "../../store/project";
import { DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR } from "../../kernel/project";
import { timeOfX } from "./utils";
import { useTimelineContext } from "./TimelineContext";
import { clipAt, planDrop, planTransition, type DropPlan, type DropTarget } from "./dropPlan";
import { clearDragPayload, getDragPayload, MIME_CARD, MIME_CUT, MIME_MEDIA, type DragPayload } from "../dnd";
import { memberReadOnlyNow } from "../readOnlyCore";
import { tr } from "../../i18n/index.ts";

/** Fallback when the drag did not pass through this window's dragstart (dragged in from another window): only the kind is known, and the duration uses the default */
function fallbackPayload(types: readonly string[]): DragPayload | null {
  const list = Array.from(types);
  if (list.includes(MIME_CARD)) return { kind: "card", cardId: "", name: tr("Cards"), duration: DEFAULT_CARD_DUR };
  if (list.includes(MIME_MEDIA)) return { kind: "media", mediaId: "", name: tr("media"), duration: DEFAULT_MEDIA_DUR };
  return null;
}

function samePlan(a: DropPlan | null, b: DropPlan | null) {
  if (!a || !b) return a === b;
  return (
    a.trackId === b.trackId &&
    a.newTrackIndex === b.newTrackIndex &&
    a.status === b.status &&
    a.hint === b.hint &&
    Math.abs(a.start - b.start) < 1e-6 &&
    Math.abs(a.end - b.end) < 1e-6
  );
}

/**
 * A drop target that "can accept a card / media dragged from the left rail" (a track, or the position of a new track).
 * On dragover it writes the drop preview into the context (track rows / drop zones draw the preview from it),
 * and on drop it drops according to the preview.
 * The returned plan is non-empty only while the preview points at this target.
 */
export function useDropTarget(target: DropTarget) {
  const { pxPerSec, dropPlan, setDropPlan } = useTimelineContext();

  const compute = (e: React.DragEvent, payload: DragPayload): DropPlan => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = timeOfX(e.clientX - rect.left, pxPerSec);
    const st = getState();
    return planDrop(st.project, payload, target, sec, { altKey: e.altKey, pxPerSec, t: st.t });
  };

  const onDragOver = (e: React.DragEvent) => {
    const payload = getDragPayload() ?? fallbackPayload(e.dataTransfer.types);
    if (!payload) return; // Not something dragged from the left rail (e.g. track reordering), leave it to others to handle
    // Read-only project (guest): do not accept. Without preventDefault the browser treats it as "cannot drop" and the cursor shows forbidden
    if (memberReadOnlyNow()) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const plan = compute(e, payload);
    e.dataTransfer.dropEffect = plan.status === "forbidden" ? "none" : "copy";
    setDropPlan((prev) => (samePlan(prev, plan) ? prev : plan));
  };

  const onDragLeave = (e: React.DragEvent) => {
    // Moving onto its own child element does not count as leaving
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropPlan(null);
  };

  const onDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    const payload = getDragPayload() ?? fallbackPayload(dt.types);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    if (memberReadOnlyNow()) {
      setDropPlan(null);
      clearDragPayload();
      return;
    }
    const plan = compute(e, payload);
    setDropPlan(null);
    clearDragPayload();
    if (plan.status === "forbidden") return;

    // Emphasis: add a shadow / outline to the segment right under the drop point
    if (payload.kind === "emphasis") {
      if (!plan.trackId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sec = timeOfX(e.clientX - rect.left, pxPerSec);
      const hit = clipAt(getState().project, plan.trackId, sec);
      if (hit) actions.setClipEmphasis(hit.id, payload.emphasis);
      return;
    }

    // Transition: instead of placing a new clip, bind the one / two existing segments at the drop point
    if (payload.kind === "transition") {
      if (!plan.trackId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sec = timeOfX(e.clientX - rect.left, pxPerSec);
      const r = planTransition(getState().project, payload.transition, plan.trackId, sec, payload.duration);
      if (!r.plan) return;
      actions.addTransition({ kind: r.plan.kind, clipId: r.plan.aId, otherClipId: r.plan.bId, dur: r.plan.dur });
      return;
    }

    // Cut: place a cut segment that references it in the active cut (circular references are already blocked in planDrop, with the reason stated)
    if (payload.kind === "cut") {
      const cutId = dt.getData(MIME_CUT) || payload.cutId;
      let seg = null;
      try {
        seg = actions.addCutSegment(cutId, plan.start, plan.trackId ? { trackId: plan.trackId } : { newTrackIndex: plan.newTrackIndex ?? undefined });
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
        return;
      }
      const st = getState();
      if (!st.playing && (st.t < seg.start || st.t >= seg.end)) actions.seek(seg.start);
      return;
    }

    // The id from dataTransfer takes precedence (it is the original in the drag-and-drop contract), and the copy in the module is only a fallback
    const cardId = dt.getData(MIME_CARD) || (payload.kind === "card" ? payload.cardId : "");
    const mediaId = dt.getData(MIME_MEDIA) || (payload.kind === "media" ? payload.mediaId : "");

    // A card dragged out of a media cell carries filled-in parameters and duration (AssetCell in the left rail); a plain card cell has neither, so it takes the defaults
    const cardOpts = payload.kind === "card" ? { params: payload.params, duration: payload.params ? payload.duration : undefined } : {};
    let clip = null;
    if (plan.trackId) {
      clip =
        payload.kind === "card"
          ? actions.addCardClip(cardId, plan.start, { trackId: plan.trackId, ...cardOpts })
          : actions.addMediaClip(mediaId, plan.start, { trackId: plan.trackId });
    } else {
      clip = actions.addClipOnNewTrack({
        index: plan.newTrackIndex ?? undefined,
        cardId: payload.kind === "card" ? cardId : undefined,
        mediaId: payload.kind === "media" ? mediaId : undefined,
        start: plan.start,
      });
      // The new-track path does not take parameters; add them after the drop
      if (clip && payload.kind === "card" && payload.params) {
        actions.setClipParams(clip.id, payload.params);
        if (cardOpts.duration) actions.moveClip(clip.id, { end: clip.start + cardOpts.duration });
      }
    }
    if (!clip) return;

    // After the drop, move the playhead into the new clip so the middle picture shows it right away (without interrupting playback)
    const st = getState();
    if (!st.playing && (st.t < clip.start || st.t >= clip.end)) actions.seek(clip.start);
  };

  const isMine =
    dropPlan != null &&
    ("trackId" in target
      ? dropPlan.trackId === target.trackId
      : dropPlan.trackId === null && dropPlan.newTrackIndex === target.newTrackIndex);

  return { onDragOver, onDragLeave, onDrop, plan: isMine ? dropPlan : null };
}
