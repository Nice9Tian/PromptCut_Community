import { useSyncExternalStore } from "react";
import { memberReadOnlyNow } from "./readOnlyCore";

/**
 * Drag-and-drop payload for left rail → timeline.
 *
 * HTML5 drag and drop cannot read the contents of dataTransfer during dragover (only types),
 * but the drop preview must know what is being dragged and how long it is. So when the drag
 * starts, a copy of the payload is stored here; the timeline reads it directly on dragover,
 * and it is cleared after dragend / drop.
 * dataTransfer is still written as usual (see the drag-and-drop contract in
 * docs/archive/EDITOR-DESIGN.md), so a drag coming in from another window can still be
 * identified by kind through types.
 */

export const MIME_CARD = "application/x-promptcut-card";
export const MIME_MEDIA = "application/x-promptcut-media";
export const MIME_TRANSITION = "application/x-promptcut-transition";
export const MIME_EMPHASIS = "application/x-promptcut-emphasis";
/** A cut dragged out of the "Cuts" group in the media library: dropped on a track it becomes a cut segment referencing it (kernel/cutSegments.ts) */
export const MIME_CUT = "application/x-promptcut-cut";

export type DragPayload =
  | { kind: "card"; cardId: string; name: string; duration: number; params?: Record<string, unknown> }
  | { kind: "media"; mediaId: string; name: string; duration: number }
  /** Cut: dropped on a track of the active cut, it places a cut segment referencing it; if dropped into itself or it would create a circular reference, it is rejected with a reason */
  | { kind: "cut"; cutId: string; name: string; duration: number }
  /** Transition: dragged onto the seam between two segments it is a crossfade, dragged onto the head / tail of a segment it is a fade-in / fade-out (see kernel/transitions.ts) */
  | { kind: "transition"; transition: "crossfade" | "fadeIn" | "fadeOut"; name: string; duration: number }
  /** Emphasis: whichever segment it is dragged onto gets a shadow / outline (see kernel/emphasis.ts) */
  | { kind: "emphasis"; emphasis: { kind: "shadow" | "outline"; color?: string; size?: number; opacity?: number; dx?: number; dy?: number }; name: string; duration: number };

let payload: DragPayload | null = null;
const subs = new Set<() => void>();

function emit() {
  for (const f of subs) f();
}

export function setDragPayload(p: DragPayload) {
  // Things dragged out of a read-only project (guest) cannot be dropped: no payload is recorded, so the timeline does not show a drop preview or the "new track" drop zone
  if (memberReadOnlyNow()) return;
  payload = p;
  emit();
  // dragend does not necessarily land on the source element (dragging out of the window or into
  // another app can lose it), so clear once more here as a fallback.
  // Note: use the bubble phase; the capture phase would clear the payload before the timeline's drop.
  window.addEventListener("dragend", clearDragPayload, { once: true });
  window.addEventListener("drop", clearDragPayload, { once: true });
}

export function clearDragPayload() {
  if (!payload) return;
  payload = null;
  emit();
}

export function getDragPayload(): DragPayload | null {
  return payload;
}

/** Whether dataTransfer.types contains a payload we recognize (the only thing to go by when dragged in from another window) */
export function hasDragType(types: readonly string[] | DOMStringList): boolean {
  const list = Array.from(types as ArrayLike<string>);
  return list.includes(MIME_CARD) || list.includes(MIME_MEDIA) || list.includes(MIME_TRANSITION) || list.includes(MIME_EMPHASIS) || list.includes(MIME_CUT);
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** Components read "what is being dragged right now" here (not dragging = null) */
export function useDragPayload(): DragPayload | null {
  return useSyncExternalStore(subscribe, () => payload, () => payload);
}
