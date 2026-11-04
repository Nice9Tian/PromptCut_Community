/**
 * Global entry point for "go to the captions tab and transcribe this media".
 *
 * The captions tab in the left rail belongs to LeftPanel, but the left rail is not the only one that
 * wants to open it: right-clicking a video / audio clip on the timeline must also jump straight
 * there to transcribe. The two sides are separated by several component layers and do not share UI
 * state in the store, so a window event bridges them: anyone can fire it, and LeftPanel listens on
 * mount and switches to the captions tab.
 */
const EVENT = "pc-open-captions";

export function requestCaptions(mediaId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { mediaId } }));
}

export function onCaptionsRequest(fn: (mediaId: string) => void): () => void {
  const handler = (e: Event) => {
    const id = (e as CustomEvent<{ mediaId?: string }>).detail?.mediaId;
    if (typeof id === "string" && id) fn(id);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
